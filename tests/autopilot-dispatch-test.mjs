import assert from 'node:assert/strict';
import { createAutopilotService } from '../client-runtime/application/autopilot-service.mjs';

// Mission 类别的分派契约。重点不是各服务自己做什么，而是「谁能落到通用决策表」——
// 这个边界此前完全没有断言，于是 strict Mission 在候选生成后无人应用，一路卡到轮次预算。
const calls = [];
const reset = () => { calls.length = 0; };
const called = (name) => calls.filter((item) => item.name === name);
const names = () => calls.map((item) => item.name);
// 记录调用再委托，保证「没被调用」的断言与「被调用了」的断言都建立在真实观测上。
const spy = (name, impl) => async (input) => { calls.push({ name, input }); return impl(input); };

const build = ({ strictService, fixedService } = {}) => createAutopilotService({
  contextService: { prepare: (state) => ({ enabled: true, mission: state.__mission, candidate: state.__candidate || null }) },
  // strict 服务默认返回 null：这正是本缺陷里「它这一轮无事可做」的那一刻。
  strictSourceService: { advance: spy('strictSource', strictService || (() => null)) },
  fixedProfileService: { advance: spy('fixedProfile', fixedService || ((input) => ({ state: input.state, action: 'fixed_own' }))) },
  candidateBaselineService: { advance: spy('candidateBaseline', (input) => ({ state: input.state, action: 'baseline_advance' })) },
  candidateActionService: {
    applyCandidate: spy('applyCandidate', async (input) => input.state),
    resumeCandidate: spy('resumeCandidate', async (input) => input.state),
  },
  validationService: { startCandidateTest: spy('startCandidateTest', async (input) => input.state) },
  iteration: { startBaseline: spy('startBaseline', (input) => input.state), startMainRound: spy('startMainRound', (input) => input.state) },
  isFixedOperatorMission: (mission) => mission?.kind === 'fixed',
  isStrictZeroSourceMission: (mission) => mission?.kind === 'strict',
  runtimeMode: () => 'production',
});

const candidateWithDigest = { id: 'candidate-01', patchDigest: 'sha256:f8d6' };

const stateFor = ({ kind, baselineStatus, stage, agentStatus = 'awaiting_action', runId = 'run-1', actionType = 'candidate.plan', candidate = candidateWithDigest, patchApplied = false }) => ({
  __mission: { id: `M-${kind}`, kind, goal: 'g' },
  __candidate: candidate,
  stage,
  patchApplied,
  baseline: { status: baselineStatus },
  agent: { status: agentStatus, runId, currentAction: { type: actionType } },
  candidateEvaluations: candidate ? [candidate] : [],
});

// 1. strict + baseline 完成 + 候选已生成 → 必须落到通用表并被真正应用。
reset();
const service = build();
const applied = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'candidate' }));
assert.equal(applied.action, 'candidate_applied', 'strict mission 生成候选后必须被应用');
assert.deepEqual(called('applyCandidate').map((item) => item.input.candidateId), ['candidate-01']);
assert.deepEqual(called('candidateBaseline'), [], 'baseline 已完成时不得走 candidateBaselineService');

// 2. 反向断言：strict + baseline 未完成 → 通用表一律不得介入，即使 strict 服务返回 null。
//    这里的 state 让通用表「所有条件都成立」，仍然必须停住。
reset();
const blocked = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'running', stage: 'candidate' }));
assert.equal(blocked.action, 'none', 'baseline 未完成时 strict Mission 只能停住');
assert.deepEqual(names(), ['strictSource'], 'baseline 未完成时 strict Mission 不得落入通用决策表');
assert.deepEqual(called('candidateBaseline'), [], 'strict Mission 的基线只能由严格来源门禁推进，不得注入通用基线');

// 3. strict 服务自己有事可做时，其结果原样返回，通用表不被咨询。
reset();
const strictOwn = build({ strictService: ({ state }) => ({ state: { ...state, fromStrict: true }, action: 'wait_research' }) });
const waiting = await strictOwn.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'candidate' }));
assert.equal(waiting.action, 'wait_research');
assert.equal(waiting.state.fromStrict, true);
assert.deepEqual(called('applyCandidate'), [], 'strict 服务仍在推进时不得抢跑应用候选');

// 4. strict + 已应用补丁 + test.plan → 验证阶段同样可达（此前与第 1 条一起不可达）。
reset();
const validated = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'validation', actionType: 'test.plan', patchApplied: true }));
assert.equal(validated.action, 'candidate_test_started');
assert.equal(called('startCandidateTest').length, 1);

// 5. 复现 2026-09-20 那次失败运行的原始状态：Agent 正常终结写 completed、候选已验证、
//    挂起动作是 client-controlled 的 candidate.plan。只认 awaiting_action 就会永远停在 none。
reset();
const settled = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'candidate', agentStatus: 'completed' }));
assert.equal(settled.action, 'candidate_applied', '候选就绪且动作已挂起时，Agent 终结为 completed 也必须被应用');
assert.deepEqual(called('applyCandidate').map((item) => item.input.candidateId), ['candidate-01']);

// 6. 反向断言：completed 但候选没有 digest → 不得反复重开主轮（原行为就是不推进）。
reset();
const void_ = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'candidate', agentStatus: 'completed', candidate: { id: 'candidate-01' } }));
assert.equal(void_.action, 'none');
assert.deepEqual(called('resumeCandidate'), [], 'completed 状态下无 digest 不得触发 resume，否则每个 tick 都会重开主轮');

// 7. awaiting_action 且无 digest 时的 resume 行为保持不变。
reset();
const resumed = await service.advance(stateFor({ kind: 'strict', baselineStatus: 'complete', stage: 'candidate', candidate: { id: 'candidate-01' } }));
assert.equal(resumed.action, 'candidate_resumed');
assert.equal(called('resumeCandidate').length, 1);

// 8. 非 strict 的通用 Mission 行为不变。
reset();
const generic = await service.advance(stateFor({ kind: 'generic', baselineStatus: 'complete', stage: 'candidate' }));
assert.equal(generic.action, 'candidate_applied');

// 9. 本轮不动固定 Profile 分支：仍然独占分派，不落回通用表。
reset();
const fixedApplied = await build().advance(stateFor({ kind: 'fixed', baselineStatus: 'complete', stage: 'candidate' }));
assert.equal(fixedApplied.action, 'fixed_own');
assert.deepEqual(names(), ['fixedProfile'], '固定 Profile 分支本轮不参与统一，行为保持原样');

console.log('[autopilot-dispatch] mission class dispatch contract passed');

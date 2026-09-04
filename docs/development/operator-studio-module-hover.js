(function () {
  'use strict';

  const modules = {
    tui: {
      responsibility: '呈现运行状态并采集 Operator 意图；只消费 ViewModel，不承载工作流规则。',
      input: '键盘操作、HTTP API DTO、SSE 状态快照。',
      output: '命令请求、导航意图和界面渲染。',
      constraint: '不得直接修改持久化状态，也不得复制 Gate、Profile 或硬件规则。'
    },
    gui: {
      responsibility: '规划中的图形交互端；与 TUI 平级，共用后端 API、SSE、DTO 和权限语义。',
      input: '用户操作、HTTP API DTO、SSE 状态快照。',
      output: '命令请求、查询请求和图形界面 ViewModel。',
      constraint: '不得建立 GUI 专属 Workflow，不得绕过 HTTP 直接修改运行状态。'
    },
    http: {
      responsibility: '把 JSON、SSE 和静态资源请求映射到公开应用用例。',
      input: 'HTTP 请求、路径参数、查询参数和请求体。',
      output: '稳定的 API DTO、SSE 事件和 HTTP 错误响应。',
      constraint: '保持薄适配器；不得实现 workflow 或直接读写 State Store。'
    },
    usecases: {
      responsibility: '组织 Projects、Missions、Decisions 等传输无关的应用用例。',
      input: '已验证的 command DTO、当前 snapshot 和注入的端口。',
      output: '用例结果、持久化投影和下游服务调用。',
      constraint: '通过公开契约调用服务；不得依赖 TUI 或具体 HTTP 实现。'
    },
    rounds: {
      responsibility: '统一编排 Research、Preflight、Baseline 和主轮次准备。',
      input: 'Mission snapshot、固定 Profile、workspace、经验查询与 agent 端口。',
      output: 'Research/Baseline 结果、冻结的 Experience Context、候选生成请求和轮次状态。',
      constraint: 'Baseline 完成后才允许 Candidate 验证；输入输出必须满足模块契约。'
    },
    autopilot: {
      responsibility: '编排 Candidate、Validation 和 Advance，并集中做自动推进决策。',
      input: '候选结果、correctness/benchmark evidence、重试预算和当前轮次。',
      output: 'retry、advance、needs_human、KEEP 或 DISCARD 决策。',
      constraint: '只能存在一套决策边界；不得绕过 Gate 或弱化固定预算。'
    },
    domain: {
      responsibility: '提供 Iteration、Workflow、Gate 和固定 Profile 的纯领域规则。',
      input: '领域值、候选身份、证据、Profile 与历史最佳结果。',
      output: '纯判断结果、状态转移和不变量错误。',
      constraint: '不得导入 TUI、HTTP、Agent、C550 或文件系统实现。'
    },
    state: {
      responsibility: '统一运行态加载、版本控制、互斥更新和原子持久化。',
      input: '状态变更函数、期望版本和当前持久化 snapshot。',
      output: '已提交 snapshot、递增版本和持久化结果。',
      constraint: '所有投影必须在锁内完成；Operator 终态必须原子写入。'
    },
    workspace: {
      responsibility: '隔离 Mission Workspace，管理 Git diff、checkpoint 和 adoption。',
      input: 'active Mission 标识、候选修改、checkpoint/adopt 指令。',
      output: 'candidate digest、diff、恢复点和采纳结果。',
      constraint: 'Agent 写入仅限 active Mission；证据必须匹配实际应用的 candidate。'
    },
    agent: {
      responsibility: '适配 Claude Code、Codex、OpenCode 等候选生成运行时。',
      input: '任务提示、冻结的 Experience Context、workspace、工具策略、超时与取消信号。',
      output: '候选文件变更、执行摘要和标准化前的运行错误。',
      constraint: '不得写出 Mission Workspace，也不得直接推进业务状态。'
    },
    queue: {
      responsibility: '串行调度 Operator correctness 与 benchmark 测试。',
      input: '测试规格、固定 Profile、candidate digest 和 runner 请求。',
      output: '排队状态、运行状态和原子终态测试结果。',
      constraint: '测试必须串行；同一任务只能产生一个持久化终态。'
    },
    executor: {
      responsibility: '规划中的通用任务执行工具；统一查询后端、匹配能力、准备执行包、提交、等待和取消。',
      input: '参数化测试任务、Candidate/Package 摘要、固定 Profile、后端选择条件和超时预算。',
      output: '统一任务终态、日志、工件、环境指纹、证据以及标准执行错误。',
      constraint: '不得决定 Mission 推进、Gate 或 Candidate 采纳；本地与远端必须使用相同生命周期。'
    },
    backends: {
      responsibility: '实现统一执行契约的后端集合，包括本地 C500、远端 C500 和未来其他硬件。',
      input: '内容寻址执行包、操作类型、Profile 引用、环境约束和幂等任务 ID。',
      output: '后端状态、执行进度、原始结果、工件和真实环境身份。',
      constraint: '后端不得改变测试矩阵；仿真证据不得标记或转换为 live-hardware evidence。'
    },
    experience: {
      responsibility: '保存可跨 Mission 查询的正式正向经验、负向经验、适用范围和不可变版本。',
      input: '经验治理服务发布或合并的来源完整资产。',
      output: '正式经验版本、适用范围、来源引用和历史版本。',
      constraint: '不接收原始草稿；所有新增或修订资产必须先通过统一治理。'
    },
    knowledgeQuery: {
      responsibility: '在明确时点查询正式经验和当前 Mission 历史，筛选后冻结本轮 Experience Context。',
      input: 'Mission/Profile、Baseline、领域失败、历史结果，以及正式经验库中的版本化资产。',
      output: '候选经验集合、查询降级状态和不可变的本轮 Experience Context。',
      constraint: '不得调用 Agent 完成检索或筛选；查询失败可降级，不能阻塞 Candidate 生成。'
    },
    draftBuilder: {
      responsibility: '依据系统事实生成结构化正向或负向经验草稿，不负责发布。',
      input: 'Mission 快照、Candidate/Patch、真机执行证据和可复用的领域结论。',
      output: '带完整 provenance 的经验草稿，或因不具备经验价值而不生成。',
      constraint: '基础设施错误和仿真证据不得生成经验草稿；Agent 解释不能替代测试事实。'
    },
    governance: {
      responsibility: '校验草稿发布资格、来源完整性、可复现性，执行查重、合并、版本化和分流。',
      input: '结构化经验草稿、正向采纳落地结果或负向失败复现结果。',
      output: '发布、合并、待补充或归档决定；只有合格资产写入正式经验库。',
      constraint: '不得把所有草稿自动发布；正向经验必须已采纳落地，负向经验必须可复现。'
    },
    errors: {
      responsibility: '跨层统一 normalize、错误分类、retryable 和 stopPolicy。',
      input: '应用编排、Agent/Workspace、测试执行、经验治理和状态持久化产生的异常，以及阶段上下文与重试预算。',
      output: '供状态投影使用的 stopPolicy，以及经 HTTP 返回 TUI/GUI 的标准错误码、错误信封和恢复建议。',
      constraint: '适配层只映射错误；恢复语义必须由统一错误契约决定；Correctness、Benchmark 和 Gate 丢弃属于领域结果。'
    }
  };

  const regions = {
    '0': {
      includes: '终端界面（TUI）、图形界面（GUI）、统一后端接口。',
      input: 'Operator 操作、HTTP 请求和 SSE 连接。',
      output: '公开 command/query DTO 与只读 ViewModel。',
      constraint: '只负责交互与协议适配，不实现 Workflow，也不直接修改持久化状态。'
    },
    '1': {
      includes: '业务用例编排、轮次与基线编排、经验查询与上下文组装、自动推进决策。',
      input: '已验证命令、Mission snapshot、固定 Profile、测试终态和注入端口。',
      output: '冻结的 Experience Context、候选生成请求、测试动作和轮次推进决定。',
      constraint: '集中组织流程，但不复制领域规则，也不绑定具体 Agent、硬件或持久化实现。'
    },
    '2': {
      includes: '候选生成 Agent、Mission 工作区。',
      input: '任务提示、冻结经验上下文、工具策略和 active Mission Workspace。',
      output: '有界 Candidate、Diff、digest 和 checkpoint。',
      constraint: 'Agent 只能写 active Mission Workspace，不能推进业务状态或直接访问经验库。'
    },
    '3': {
      includes: '算子测试队列、通用任务执行工具、执行后端池。',
      input: '参数化测试任务、执行包、固定 Profile、后端约束和超时预算。',
      output: '唯一任务终态、日志、环境指纹、工件和真实执行证据。',
      constraint: '测试保持串行；本地与远端使用同一生命周期；执行层不做 Gate 或采纳决定。'
    },
    '4': {
      includes: '领域规则与 Gate，以及固定 Profile 的唯一语义来源。',
      input: 'Candidate 身份、correctness/benchmark evidence、历史最佳值和固定测试矩阵。',
      output: '纯判断、KEEP/DISCARD、状态转移或不变量错误。',
      constraint: '不得依赖 TUI、HTTP、Agent、C550 或文件系统实现，不得弱化固定测试语义。'
    },
    '5': {
      includes: '经验草稿生成器、经验治理与发布、正式经验库。',
      input: '可复用领域结论、Mission/Candidate 来源、真机证据和采纳或复现结果。',
      output: '带 provenance 的草稿、治理分流决定和可查询的正式经验版本。',
      constraint: '基础设施错误和仿真证据不生成草稿；未经治理或来源不完整的资产不得入库。'
    },
    '6': {
      includes: '运行状态仓库、统一错误契约。',
      input: '版本化状态变更，以及来自应用、候选、执行、经验和持久化模块的异常。',
      output: '原子 snapshot、标准错误信封、stopPolicy，以及通过 HTTP 返回客户端的恢复建议。',
      constraint: '所有状态投影必须在仓库锁内完成；业务失败不是系统异常；错误恢复语义不得散落到适配器。'
    }
  };

  const contractExtras = {
    tui: ['src/App.jsx', '入口：React 页面与状态面板；通过 fetch/EventSource 调用 API。', '读取：项目、Mission、runtime snapshot、SSE 事件。', '写入：仅发送 command，不直接写文件或 state。', '失败：显示 API 错误并保留当前 ViewModel。'],
    gui: ['docs/development/ARCHITECTURE.md（规划模块，尚未实现）', '入口：未来 GUI 应只调用与 TUI 相同的 Production API。', '读取：公开 DTO、SSE 和界面本地状态。', '写入：仅发送 command/query；不写 Runtime 文件。', '失败：按统一错误信封展示，不创建 GUI 私有错误语义。'],
    http: ['client-runtime/server/README.md', '入口：server/*-routes.mjs，由 local-server.mjs 注入应用服务。', '读取：request、URL、JSON body、SSE 客户端。', '写入：HTTP response；不写 State Store。', '失败：稳定 HTTP 状态码与 __bridge 错误信封。'],
    usecases: ['client-runtime/application/README.md', '入口：create*Service() 工厂与 transport-neutral command/query。', '读取：DTO、snapshot、注入的 domain/port。', '写入：通过 State Repository、Workspace、Queue 端口产生副作用。', '失败：保留稳定 application error code。'],
    rounds: ['client-runtime/application/main-round-orchestration-service.mjs', '入口：main-round / baseline orchestration service。', '读取：Mission、Profile、研究源、Agent boundary。', '写入：round 状态、checkpoint、baseline/candidate 任务。', '失败：进入 recovery service 或统一错误契约。'],
    autopilot: ['client-runtime/application/autopilot-service.mjs', '入口：createAutopilotService().advance(state)。', '读取：stage、candidate、evidence、retry budget。', '写入：candidate action、validation task、iteration advance。', '失败：retry、continue、needs_human 或终止。'],
    domain: ['client-runtime/workflow-kernel.mjs + fixed-operator-profiles.mjs', '入口：纯函数 normalize/assert/derive 与 Profile 查询。', '读取：值对象、状态、证据和固定矩阵。', '写入：无；返回判断结果或不可变错误。', '失败：抛出 invariant/validation，不执行副作用。'],
    state: ['client-runtime/state-repository.mjs', '入口：read / update / runExclusive / persist。', '读取：持久化 snapshot、expectedVersion。', '写入：版本化 snapshot，锁内原子提交。', '失败：STATE_VERSION_CONFLICT 可重试。'],
    workspace: ['client-runtime/workspace-manager.mjs', '入口：ensure / inspect / captureDiff / adoptPatch / revertAdoption。', '读取：repository、Mission、candidate 文件和 Git HEAD。', '写入：active Mission 工作区、checkpoint、Git commit。', '失败：边界、路径、Git 一致性错误。'],
    agent: ['client-runtime/agent-runtime/README.md', '入口：provider-neutral engine.invoke(operation)。', '读取：能力 registry、prompt、workspace、取消信号。', '写入：Agent 进程产生的 workspace diff 和事件。', '失败：由 provider classifier 转为标准运行错误。'],
    queue: ['client-runtime/operator-test-queue.mjs', '入口：enqueue / poll / cancel / list。', '读取：task payload、candidate digest、固定测试规格。', '写入：JSONL 队列、锁文件、原子终态。', '失败：队列忙、超时、取消或任务失败。'],
    executor: ['client-runtime/README.md#TODO：通用测试执行工具（目标契约，待实现）', '入口：计划提供 queryBackends / preparePackage / execute / cancel。', '读取：ExecutionRequest、后端能力和执行包 manifest。', '写入：仅执行任务与工件；Queue 仍负责串行状态持久化。', '失败：归一化为 EXECUTOR_* 错误并交给 workflow-error。'],
    backends: ['client-runtime/local-c500-service-client.mjs + tools/local-c500-runner.py（当前本地实现）', '入口：统一 adapter 的 health / submit / poll / cancel。', '读取：ExecutionPackage 与后端本地运行环境。', '写入：隔离任务目录、结果和诊断工件。', '失败：能力不匹配、依赖缺失、硬件不可用或任务失败。'],
    experience: ['client-runtime/application/knowledge-service.md（当前本地状态，未来组织级仓储）', '入口：目标 Experience Repository query / publishVersion。', '读取：正式正负向资产、适用范围、版本和来源。', '写入：仅治理服务提交的不可变版本。', '失败：仓储不可用时查询降级；发布失败保留治理结果。'],
    knowledgeQuery: ['client-runtime/iteration-loop.mjs#knowledgeFromState（当前逻辑，待抽取）', '入口：目标 queryExperienceContext(criteria)。', '读取：正式经验、Mission 历史失败、Baseline 和 Profile。', '写入：只冻结本轮 Experience Context，不改正式经验。', '失败：返回 degraded 空上下文和标准错误。'],
    draftBuilder: ['client-runtime/state-store.mjs#ensureEvidenceKnowledgeDraft（当前实现，待抽取）', '入口：目标 buildExperienceDraft(facts)。', '读取：Mission、Candidate、Execution、领域结论 provenance。', '写入：结构化 knowledgeDraft；不写正式经验库。', '失败：非领域错误或非真机证据返回 not_eligible。'],
    governance: ['client-runtime/state-store.mjs#runKnowledgeMaintenance（当前实现，待抽取）', '入口：目标 governExperienceDraft(draft, disposition)。', '读取：草稿、采纳 Commit、失败复现、既有正式版本。', '写入：发布/合并版本，或待补充/归档决定。', '失败：来源或资格不足时禁止发布并保留原因。'],
    errors: ['client-runtime/workflow-error.mjs', '入口：normalizeWorkflowError / serializeWorkflowError。', '读取：error、phase、source、retryable、details。', '写入：标准错误信封和 stopPolicy 投影。', '失败：未知错误归类为 internal → needs_human。']
  };
  Object.entries(contractExtras).forEach(([id, extra]) => {
    if (modules[id]) Object.assign(modules[id], { docs: extra[0], entry: extra[1], reads: extra[2], writes: extra[3], failure: extra[4] });
  });

  const assignmentExtras = {
    tui: ['界面状态、交互反馈、SSE 刷新与可用性。', 'TUI 不直接写状态；生产 TUI 契约测试通过。'],
    gui: ['搭建 GUI 壳层、共享 API client、ViewModel 和 SSE 状态同步。', 'GUI 与 TUI 对相同 DTO/错误产生一致语义，不新增后端 Workflow。'],
    http: ['DTO、HTTP 状态码、SSE 和薄路由适配。', '路由不含 workflow 规则；server route 与 smoke 测试通过。'],
    usecases: ['拆分应用用例并稳定公开 command/query 契约。', '调用只依赖注入端口；application 模块测试通过。'],
    rounds: ['Research、Baseline、Preflight 和主轮次编排。', '成功与失败路径均有测试；不得复制固定 Profile。'],
    autopilot: ['候选选择、验证启动、重试和轮次推进。', '所有状态组合有确定动作；预算与 Gate 不被绕过。'],
    domain: ['Workflow、Gate 和固定 Profile 的纯规则。', '无适配器依赖；不变量与极端条件测试通过。'],
    state: ['并发更新、版本冲突、原子持久化和恢复。', '所有写入经过仓库锁；冲突和损坏恢复测试通过。'],
    workspace: ['隔离、Diff、checkpoint、adoption 与回滚。', 'Agent 无法越界写入；摘要与实际候选一致。'],
    agent: ['Provider 能力、统一调用、超时取消和结果归一化。', '新增 Provider 不修改 workflow；runtime 契约测试通过。'],
    queue: ['串行任务生命周期、取消竞争和终态持久化。', '同一任务只有一个终态；queue resilience 测试通过。'],
    executor: ['定义 Schema、后端发现、执行包、幂等提交、等待与取消。', '本地远端契约测试一致；Queue 只依赖通用 executor port。'],
    backends: ['改造本地 C500 adapter，并实现远端 adapter 与能力检查。', '同一请求在各后端产生一致状态、错误和 evidence 结构。'],
    experience: ['组织级仓储适配器、不可变版本、适用范围和引用策略。', '只接受治理服务写入；正式资产来源可追溯且可按版本查询。'],
    knowledgeQuery: ['实现三个查询时点、筛选排序、缓存和冻结上下文。', 'Agent 不直连经验库；查询超时可降级且输出可观测。'],
    draftBuilder: ['抽取正负向草稿生成器并补齐 provenance 与资格预检。', '领域结论产生正确草稿；基础设施错误和仿真证据不生成草稿。'],
    governance: ['实现采纳/复现校验、查重、合并、版本化和分流。', '只有合格草稿入库；其他草稿明确待补充或归档。'],
    errors: ['错误分类、retryable、stopPolicy 和恢复建议。', '外部错误均标准化；未知错误安全进入人工处理。']
  };
  Object.entries(assignmentExtras).forEach(([id, extra]) => {
    if (modules[id]) Object.assign(modules[id], { assignment: extra[0], acceptance: extra[1] });
  });

  const container = document.querySelector('.diagram-container');
  const svg = container && container.querySelector(':scope > svg');
  if (!container || !svg) return;

  const style = document.createElement('style');
  style.textContent = `
    .module-contract-tooltip {
      position: fixed; z-index: 1000; width: min(360px, calc(100vw - 24px));
      padding: 14px 16px; border: 1px solid var(--toolbar-border); border-radius: 8px;
      background: var(--toolbar-menu-bg); color: var(--text); box-shadow: 0 14px 36px rgba(15,23,42,.22);
      font: 13px/1.55 system-ui, sans-serif; pointer-events: none; opacity: 0;
      transform: translateY(4px); transition: opacity .12s ease, transform .12s ease;
    }
    .module-contract-tooltip[data-open="true"] { opacity: 1; transform: translateY(0); }
    .module-contract-tooltip h2 { margin: 0 0 8px; font-size: 15px; letter-spacing: 0; }
    .module-contract-tooltip dl { display: grid; grid-template-columns: 52px 1fr; gap: 6px 10px; margin: 0; }
    .module-contract-tooltip dt { color: var(--text-faint); font-weight: 700; }
    .module-contract-tooltip dd { margin: 0; color: var(--text-muted); }
    .module-contract-tooltip .constraint { color: var(--security-stroke); }
    .module-contract-tooltip .source { margin-top: 10px; color: var(--text-faint); font-size: 11px; }
    [data-node-id][data-module-contract], [data-module-region] { cursor: help; }
  `;
  document.head.appendChild(style);

  const tooltip = document.createElement('aside');
  tooltip.className = 'module-contract-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  document.body.appendChild(tooltip);

  function render(node) {
    const id = node.getAttribute('data-node-id');
    const details = modules[id];
    if (!details) return false;
    const title = node.getAttribute('data-node-label') || id;
    tooltip.innerHTML = `<h2>${title}</h2><dl>` +
      `<dt>职责</dt><dd>${details.responsibility}</dd>` +
      `<dt>输入</dt><dd>${details.input}</dd>` +
      `<dt>输出</dt><dd>${details.output}</dd>` +
      `<dt>读取</dt><dd>${details.reads}</dd>` +
      `<dt>写入</dt><dd>${details.writes}</dd>` +
      `<dt>失败</dt><dd>${details.failure}</dd>` +
      `<dt>约束</dt><dd class="constraint">${details.constraint}</dd>` +
      `<dt>可领任务</dt><dd>${details.assignment}</dd>` +
      `<dt>验收</dt><dd>${details.acceptance}</dd></dl>` +
      `<div class="source">入口：${details.entry}<br>继续阅读：${details.docs}</div>`;
    return true;
  }

  function renderRegion(region) {
    const id = region.getAttribute('data-composition-frame-id');
    const details = regions[id];
    if (!details) return false;
    const title = region.getAttribute('data-composition-frame-label') || `模块区域 ${id}`;
    tooltip.innerHTML = `<h2>${title}</h2><dl>` +
      `<dt>包含</dt><dd>${details.includes}</dd>` +
      `<dt>输入</dt><dd>${details.input}</dd>` +
      `<dt>输出</dt><dd>${details.output}</dd>` +
      `<dt>边界</dt><dd class="constraint">${details.constraint}</dd></dl>` +
      `<div class="source">区域表示团队职责与依赖边界；区域内节点 hover 提供具体模块契约。</div>`;
    return true;
  }

  function place(clientX, clientY) {
    const gap = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = clientX + gap;
    let top = clientY + gap;
    if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - gap;
    if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - gap;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${Math.max(8, top)}px`;
  }

  function open(target, x, y) {
    const rendered = target.hasAttribute('data-module-region') ? renderRegion(target) : render(target);
    if (!rendered) return;
    tooltip.setAttribute('data-open', 'true');
    tooltip.setAttribute('aria-hidden', 'false');
    place(x, y);
  }

  function close() {
    tooltip.removeAttribute('data-open');
    tooltip.setAttribute('aria-hidden', 'true');
  }

  svg.querySelectorAll('[data-node-id]').forEach(function (node) {
    if (!modules[node.getAttribute('data-node-id')]) return;
    node.setAttribute('data-module-contract', '');
    node.setAttribute('aria-describedby', 'module-contract-tooltip');
  });
  svg.querySelectorAll('[data-graph-role="structural-frame"], [data-graph-role="structural-frame-label"]').forEach(function (region) {
    if (!regions[region.getAttribute('data-composition-frame-id')]) return;
    region.setAttribute('data-module-region', '');
  });
  tooltip.id = 'module-contract-tooltip';

  svg.addEventListener('pointerover', function (event) {
    const target = event.target.closest('[data-module-contract], [data-module-region]');
    if (target) open(target, event.clientX, event.clientY);
  });
  svg.addEventListener('pointermove', function (event) {
    if (tooltip.hasAttribute('data-open')) place(event.clientX, event.clientY);
  });
  svg.addEventListener('pointerout', function (event) {
    const target = event.target.closest('[data-module-contract], [data-module-region]');
    if (target && (!event.relatedTarget || !target.contains(event.relatedTarget))) close();
  });
  svg.addEventListener('focusin', function (event) {
    const target = event.target.closest('[data-module-contract], [data-module-region]');
    if (!target) return;
    const rect = target.getBoundingClientRect();
    open(target, rect.right, rect.top);
  });
  svg.addEventListener('focusout', close);
})();

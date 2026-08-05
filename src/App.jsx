import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowRight,
  Beaker,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  Filter,
  FolderGit2,
  Gauge,
  GitBranch,
  Grid2X2,
  History,
  Layers3,
  Lightbulb,
  LockKeyhole,
  LogOut,
  Menu,
  MoreHorizontal,
  Pause,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  TestTube2,
  TriangleAlert,
  UploadCloud,
  Users,
  X,
} from 'lucide-react';

const stageOrder = {
  diagnosis: 0,
  candidate: 1,
  validation: 2,
  evidence: 3,
  curation: 4,
  published: 5,
};

const defaultKnowledgeDrafts = [
  { id: 'exp.async-plan-cache', code: 'EXP-01', category: '通用优化经验', title: '短序列下的 Async plan descriptor cache', conclusion: '当设备 Kernel 已低于 50μs 时，缓存 plan descriptor 并将 host mirror 移出热路径，可以稳定降低固定开销。', scope: 'C500 / CUDA · paged_attention · batch 1–8 · seq_len ≤ 1024', constraints: '保留 host mirror fallback；必须通过 24 / 24 Correctness Gate。', hardware: ['C500', 'CUDA'], evidence: '2 个 Level 3 Run' },
  { id: 'exp.c500-plan-cache-boundary', code: 'EXP-02', category: '沐曦 C500 专项准则', title: '沐曦 C500 plan cache 与 host mirror 边界准则', conclusion: '在 MXMACA 1.4+ 环境中，descriptor cache 应按 Shape signature 分桶，host mirror 仅在缓存未就绪时回退同步路径。', scope: 'MetaX C500 · MXMACA 1.4+ · paged_attention · small batch', constraints: '缓存容量受控；环境指纹变化后必须失效；保留同步回退。', hardware: ['C500'], evidence: 'C500 41.8μs · Level 3' },
  { id: 'exp.cross-platform-adoption-gate', code: 'EXP-03', category: '跨平台验证准则', title: 'C500 / CUDA 跨平台候选采用门禁', conclusion: '跨平台候选只有在 Correctness、目标平台性能和固定环境证据同时通过后，才能替换 current best。', scope: 'C500 / CUDA · operator candidate adoption · Full Benchmark', constraints: 'Probe 结果不得用于最终采用；每个平台必须绑定 Environment Snapshot。', hardware: ['C500', 'CUDA'], evidence: '24 / 24 · 2 个固定环境' },
];

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `服务请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function copyText(value) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back to a temporary textarea when clipboard permission is unavailable.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function downloadText(filename, content, type = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const stages = [
  { id: 'diagnosis', number: '01', label: '诊断', caption: '定位瓶颈' },
  { id: 'candidate', number: '02', label: '候选', caption: '审查补丁' },
  { id: 'validation', number: '03', label: '验证', caption: '异构测试' },
  { id: 'evidence', number: '04', label: '证据', caption: '形成结论' },
  { id: 'curation', number: '05', label: '沉淀', caption: '发布经验' },
];

const stageMeta = {
  diagnosis: { badge: 'DIAGNOSIS', status: '分析中', action: '查看候选方案' },
  candidate: { badge: 'CANDIDATE READY', status: '待审批', action: '批准并应用补丁' },
  validation: { badge: 'VALIDATING', status: '验证中', action: '完成 Full Benchmark' },
  evidence: { badge: 'EVIDENCE READY', status: '待决策', action: '进入效果决策' },
  curation: { badge: 'CURATION', status: '待发布', action: '打开知识草稿' },
  published: { badge: 'MISSION COMPLETE', status: '已完成', action: '查看已发布经验' },
};

const globalNavItems = [
  { id: 'missions', label: '优化任务', icon: GitBranch },
  { id: 'knowledge', label: '知识资产', icon: BookOpen },
  { id: 'resources', label: '算力资源', icon: Cpu, modal: 'environments' },
  { id: 'audit', label: '审计中心', icon: ShieldCheck, modal: 'events' },
];

const missionFlow = [
  { id: 'overview', number: '01', label: '任务总览', caption: '目标与瓶颈', view: 'mission', stage: 'diagnosis', icon: Gauge },
  { id: 'iterations', number: '02', label: '候选迭代', caption: '4 次尝试', view: 'iterations', stage: 'candidate', icon: History },
  { id: 'code', number: '03', label: '代码优化', caption: '补丁审查', view: 'code', stage: 'candidate', icon: Code2 },
  { id: 'experiments', number: '04', label: '异构验证', caption: '24 / 24', view: 'experiments', stage: 'validation', icon: TestTube2 },
  { id: 'decision', number: '05', label: '效果决策', caption: 'Level 3 证据', view: 'decision', stage: 'evidence', icon: ShieldCheck },
  { id: 'curation', number: '06', label: '知识沉淀', caption: '3 条资产', view: 'curation', stage: 'curation', icon: BookOpen },
];

const tasks = [
  {
    id: 'tsk.c500-prod-01.01JH7R',
    platform: 'C500',
    environment: 'C500 Production 01',
    runner: 'runner.mxmaca@1.4.0',
    baseline: 53.8,
    result: 41.8,
    improvement: '−22.3%',
    tone: 'green',
  },
  {
    id: 'tsk.cuda-a100-02.01JH7R',
    platform: 'CUDA',
    environment: 'CUDA A100 Reference',
    runner: 'runner.cuda@3.2.1',
    baseline: 44.4,
    result: 36.1,
    improvement: '−18.7%',
    tone: 'blue',
  },
];

const operatorIterations = [
  { id: 'baseline', label: 'Baseline', version: 'v0', date: '08-03 09:12', status: '基线', tone: 'neutral', title: '原始同步执行路径', hypothesis: '记录未经优化的 plan 构建、workspace 分配、host mirror 与 Kernel 完整开销。', change: '仅建立固定环境基线，不修改代码。', files: '0 files', c500: 53.8, cuda: 44.4, delta: '—', correctness: '24 / 24', evidence: 'Environment Snapshot · Level 3', decision: '作为比较基线', decisionReason: '固定 MXMACA、CUDA、编译器和测试 Shape，后续所有候选均与该版本比较。', knowledge: 'Profile timeline v1.8.0' },
  { id: 'candidate-01', label: 'Candidate 01', version: 'cnd.01', date: '08-03 09:36', status: '已淘汰', tone: 'muted', title: 'Workspace pool reuse', hypothesis: '重复分配 Workspace 可能是小 Batch 延迟的主要来源。', change: '引入按 Shape 分桶的 Workspace pool，并保留同步 plan 构建。', files: '2 files · +24 −11', c500: 49.6, cuda: 41.9, delta: '−7.8%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '收益有限，未采用', decisionReason: '两个平台均有改善，但未达到 45μs 目标；Profile 显示 plan 与 host mirror 仍主导热路径。', knowledge: 'Workspace Allocation Tracker v1.2.0' },
  { id: 'candidate-02', label: 'Candidate 02', version: 'cnd.02', date: '08-03 10:42', status: '当前采用', tone: 'adopted', title: 'Async plan descriptor cache', hypothesis: '缓存 plan descriptor，并将 host mirror 同步移出热路径。', change: '新增 plan cache 与异步 mirror fallback，保持 API 和回退路径不变。', files: '2 files · +37 −18', c500: 41.8, cuda: 36.1, delta: '−22.3%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '已采用为 current best', decisionReason: 'C500 与 CUDA 均通过完整正确性和性能门禁，且 C500 延迟低于 45μs 目标。', knowledge: '3 assets referenced · fixed versions' },
  { id: 'candidate-03', label: 'Candidate 03', version: 'cnd.03', date: '08-03 11:18', status: '已淘汰', tone: 'rejected', title: 'Fuse mirror preparation', hypothesis: '将 mirror preparation 与 Kernel 前处理融合可能继续压缩固定开销。', change: '合并两个 host/device 边界，并调整事件同步粒度。', files: '3 files · +61 −35', c500: 43.2, cuda: 39.8, delta: '−19.7%', correctness: '24 / 24', evidence: '2 Full Benchmark Runs · Level 3', decision: '跨平台回归，未采用', decisionReason: '相对 Candidate 02，C500 回退 3.3%，CUDA 回退 10.2%，不满足 current best 更新条件。', knowledge: '异步流水线 Stall 归因规则 v1.4' },
  { id: 'candidate-04', label: 'Candidate 04', version: 'cnd.04', date: '08-03 13:05', status: '验证中', tone: 'running', title: 'Adaptive tile selection', hypothesis: '根据 Batch 与序列长度动态选择 tile，可改善长尾 Shape 的设备利用率。', change: '新增轻量 Shape classifier 和三组预验证 tile 配置。', files: '3 files · +82 −16', c500: 40.9, cuda: null, delta: '−24.0%*', correctness: '20 / 24', evidence: 'Probe Run · Level 1', decision: '等待 Correctness Gate', decisionReason: 'C500 Probe 已获得更低延迟，但 4 个边界 Shape 尚未通过，不能替换 current best。', knowledge: '真实 Shape 分布分析 v2.1.0' },
];

function Mark({ tone = 'green', pulse = false }) {
  return <span className={`signal-mark ${tone} ${pulse ? 'pulse' : ''}`} />;
}

function RailButton({ icon: Icon, label, active, onClick }) {
  return (
    <button className={`rail-button ${active ? 'active' : ''}`} onClick={onClick} title={label} aria-label={label}>
      <Icon size={19} strokeWidth={1.7} />
      <span>{label}</span>
    </button>
  );
}

function MissionFlowBar({ view, stage, onSelect }) {
  const activeId = view === 'mission' ? 'overview' : view;
  const lifecycleIndex = {
    diagnosis: 0,
    candidate: 2,
    validation: 3,
    evidence: 4,
    curation: 5,
    published: 6,
  }[stage];

  return (
    <section className="mission-context-bar" aria-label="当前优化任务">
      <div className="mission-context-summary">
        <div className="mission-context-title">
          <span className="live-mission-mark"><CircleDot size={13} /> LIVE MISSION</span>
          <strong>MLA Paged KV Cache</strong>
          <small>MIS_01JH7R</small>
        </div>
        <div className="mission-context-facts">
          <span><i className="fact-platform">C5</i>C500 + CUDA</span>
          <span><small>当前最佳</small><strong>41.8 μs</strong></span>
          <span className="mission-gain"><small>累计提升</small><strong>−22.3%</strong></span>
          <span className={`mission-stage-state ${stage}`}><Mark pulse={stage !== 'published'} />{stageMeta[stage].status}</span>
        </div>
      </div>
      <nav className="mission-flow" aria-label="任务阶段">
        {missionFlow.map((item, index) => {
          const Icon = item.icon;
          const active = item.id === activeId;
          const complete = index < lifecycleIndex;
          const current = index === lifecycleIndex;
          return (
            <button key={item.id} className={`${active ? 'active' : ''} ${complete ? 'complete' : ''} ${current ? 'current' : ''}`} onClick={() => onSelect(item)} aria-current={active ? 'step' : undefined}>
              <span className="mission-flow-index">{complete ? <Check size={13} /> : item.number}</span>
              <span className="mission-flow-icon"><Icon size={16} /></span>
              <span className="mission-flow-copy"><strong>{item.label}</strong><small>{item.caption}</small></span>
              {current && <i className="current-stage-pin" />}
            </button>
          );
        })}
      </nav>
    </section>
  );
}

function AppShell({ view, stage, missionContext, workspace, unreadCount, mobileNavOpen, missionPaused, backendStatus, backendError, onToggleMobileNav, onGlobalNavigate, onMissionStep, onOpenModal, children }) {
  const currentStep = missionFlow.find((item) => item.id === (view === 'mission' ? 'overview' : view));
  const selectGlobal = (item) => {
    if (item.modal) onOpenModal(item.modal);
    else onGlobalNavigate(item.id);
    onToggleMobileNav(false);
  };
  return (
    <div className="studio-shell">
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="关闭导航" onClick={() => onToggleMobileNav(false)} />}
      <aside className={`rail ${mobileNavOpen ? 'open' : ''}`}>
        <div className="oa-brand">
          <div className="studio-mark">OS</div>
          <div><strong>Operator Studio</strong><span>异构算子优化平台</span></div>
        </div>
        <button className="workspace-switch" aria-label="切换工作区" onClick={() => onOpenModal('workspace')}>
          <span>{workspace.slice(0, 1)}</span><div><strong>{workspace}</strong><small>研发组织</small></div><ChevronDown size={14} />
        </button>
        <div className="nav-group-title">产品域</div>
        <nav aria-label="全局导航">
          {globalNavItems.map((item) => (
            <RailButton key={item.id} {...item} active={(item.id === 'missions' && missionContext) || (item.id === 'knowledge' && !missionContext && view === 'knowledge')} onClick={() => selectGlobal(item)} />
          ))}
        </nav>
        <div className="nav-group-title project-title">组织管理</div>
        <div className="project-nav">
          <button onClick={() => onOpenModal('repository')}><FolderGit2 size={17} /> 仓库管理</button>
          <button onClick={() => onOpenModal('settings')}><Settings2 size={17} /> 项目设置</button>
        </div>
        <div className="rail-bottom">
          <button className="user-card" onClick={() => onOpenModal('user')}><span className="profile-button">YL</span><div><strong>Yilin Lu</strong><small>算子工程师</small></div><MoreHorizontal size={16} /></button>
        </div>
      </aside>

      <div className="studio-main">
        <header className="app-header">
          <div className="header-context">
            <button className="mobile-menu" aria-label="打开导航" onClick={() => onToggleMobileNav(true)}><Menu size={18} /></button>
            <span>{missionContext ? '优化任务' : '知识资产'}</span><ChevronRight size={13} /><span>{missionContext ? 'MLA Paged KV Cache' : '组织知识库'}</span>{missionContext && <><ChevronRight size={13} /><strong>{currentStep?.label}</strong></>}
          </div>
          <div className="header-actions">
            <button className="header-search" aria-label="搜索" onClick={() => onOpenModal('search')}><Search size={16} /><span>搜索任务、资产或成员</span><kbd>⌘K</kbd></button>
            <div className={`cloud-state ${backendStatus}`}><Mark tone={backendStatus === 'offline' ? 'ochre' : 'green'} pulse={backendStatus === 'connecting'} />{backendStatus === 'online' ? 'Service synced' : backendStatus === 'offline' ? 'Service offline' : 'Connecting'}</div>
            <button className="header-icon" aria-label="通知" onClick={() => onOpenModal('notifications')}><Bell size={17} />{unreadCount > 0 && <i>{unreadCount}</i>}</button>
          </div>
        </header>
        {missionContext && <MissionFlowBar view={view} stage={stage} onSelect={onMissionStep} />}
        {backendStatus === 'offline' && <div className="service-offline-banner"><TriangleAlert size={14} /><span>业务服务不可用，修改操作不会提交。{backendError ? ` ${backendError}` : ''}</span></div>}
        {missionPaused && <div className="mission-paused-banner"><Pause size={14} />任务已暂停，浏览与导出仍可使用，新的审批和测试操作已锁定。</div>}
        {children}
      </div>
    </div>
  );
}

function MissionHeader({ stage, onAdvance, onOpenModal, disabled }) {
  const meta = stageMeta[stage];
  return (
    <section className="mission-header">
      <div className="page-title-row">
        <div>
          <div className="mission-overline">优化任务 / MIS_01JH7R</div>
          <div className="title-with-status"><h1>任务指挥台</h1><span className={`oa-status ${stage}`}>{meta.status}</span></div>
          <p>MLA Paged KV Cache · C500 / CUDA A100 · latency p50</p>
        </div>
        <div className="mission-command">
          <button onClick={onAdvance} disabled={disabled}>{meta.action}<ArrowRight size={16} /></button>
          <button className="more-action" aria-label="更多操作" onClick={() => onOpenModal('missionActions')}><MoreHorizontal size={17} /></button>
        </div>
      </div>
    </section>
  );
}

function ShowcaseBoard({ onOpenModal }) {
  return (
    <section className="showcase-board" aria-label="任务成果概览">
      <div className="showcase-board-top">
        <div className="showcase-object">
          <div className="showcase-eyebrow"><CircleDot size={14} /> LIVE MISSION · MLA Paged KV Cache</div>
          <h2>MLA Paged KV Cache<br />算子优化任务</h2>
          <p>任务目标：保持 C500 与 CUDA 结果一致，将小 batch 推理延迟从 53.8μs 压至 45μs 以内。</p>
          <div className="mission-tags"><span>C500</span><span>CUDA A100</span><span>small batch</span></div>
        </div>
        <div className="showcase-outcome">
          <div className="showcase-outcome-head"><span>本次任务结果</span><button onClick={() => onOpenModal('events')}><History size={14} /> 审计记录</button></div>
          <div className="showcase-kpis"><div><span>优化前</span><strong>53.8 <em>μs</em></strong></div><ArrowRight size={18} /><div className="result"><span>当前最佳</span><strong>41.8 <em>μs</em></strong></div><div className="gain"><strong>−22.3%</strong><span>latency p50</span></div></div>
          <div className="showcase-proof"><span><CheckCircle2 size={14} /> 24 / 24 正确性通过</span><span><ShieldCheck size={14} /> Level 3 证据</span><span><BookOpen size={14} /> 3 条知识引用</span></div>
        </div>
      </div>
    </section>
  );
}

function PlatformMark({ platform }) {
  const iconMap = {
    all: Grid2X2,
    cross: GitBranch,
  };
  const Icon = iconMap[platform];
  if (Icon) return <span className={`platform-mark ${platform}`} aria-hidden="true"><Icon size={18} /><small>{platform === 'all' ? 'CORPUS' : 'PORTABLE'}</small></span>;
  const officialLogos = {
    c500: '/logos/metax.svg',
    nvidia: '/logos/nvidia-white.svg',
    amd: '/logos/amd.svg',
  };
  return <span className={`platform-mark official ${platform}`} aria-hidden="true"><img src={officialLogos[platform]} alt="" /></span>;
}

const missionKnowledge = [
  {
    kind: 'Experience',
    version: 'validated',
    title: '短序列下优先量化固定开销',
    shortTitle: '短序列固定开销',
    tone: 'ochre',
    icon: Lightbulb,
    reason: '当设备 Kernel 已低于 50μs 时，plan、workspace、host mirror 与同步成本可能成为主要瓶颈。',
    scope: 'C500 / CUDA · paged_attention · seq_len ≤ 1024',
    evidence: '2 个历史 Run · Level 3',
    source: 'exp.short-seq.fixed-overhead@1.2',
  },
  {
    kind: 'Skill',
    version: 'v2.3.1',
    title: '性能瓶颈分段分析',
    shortTitle: '瓶颈分段分析',
    tone: 'blue',
    icon: Layers3,
    reason: '按 host/device 边界拆分时间线，确保固定开销与 Kernel 执行时间可以被分别归因。',
    scope: '代码只读 · 可创建 Test Task · 受控 Worker',
    evidence: '本次诊断 Action · 已审计',
    source: 'skill.performance-segmentation@2.3.1',
  },
  {
    kind: 'Tool',
    version: 'v1.8.0',
    title: 'Profile timeline',
    shortTitle: 'Profile timeline',
    tone: 'green',
    icon: TerminalSquare,
    reason: '采集 plan 构建、workspace 分配、host mirror 与 Kernel 执行的统一时间线工件。',
    scope: 'C500 Production 01 / CUDA A100 Reference',
    evidence: 'artifact.timeline.01JH7R · digest fixed',
    source: 'tool.profile-timeline@1.8.0',
  },
];

const knowledgeCatalog = [
  { id: 'exp.fixed-overhead', kind: 'Experience', version: 'v1.2', title: '短序列下优先量化固定开销', description: '设备 Kernel 低于 50μs 时，优先分离 plan、workspace、host mirror 与同步开销。', tags: ['C500', 'paged_attention', 'seq_len ≤ 1024', '2 Run citations'], tone: 'ochre', icon: Lightbulb, referenced: true, scope: 'C500 / CUDA · paged_attention · seq_len ≤ 1024', permissions: 'organization:read', evidence: '2 Run citations · Level 3', updated: '2026-08-03' },
  { id: 'exp.c500-compiler-flags', kind: 'Experience', version: 'v1.7', title: '沐曦 C500 MXMACA 编译参数准则', description: '按算子类型约束 fast-math、寄存器上限和内联策略，避免局部收益引发跨 shape 回退。', tags: ['MetaX C500', 'MXMACA', 'compiler flags', '9 Run citations'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · MXMACA 1.4+', permissions: 'organization:read', evidence: '9 Run citations · Level 3', updated: '2026-08-02' },
  { id: 'exp.c500-launch-baseline', kind: 'Experience', version: 'v1.5', title: '沐曦 C500 小 Batch 启动开销基线', description: '建立 Kernel launch、plan 构建与同步开销基线，低于阈值时禁止仅针对 Kernel 做局部优化。', tags: ['MetaX C500', 'small batch', 'launch overhead', 'P50/P95'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · batch 1–8 · seq_len ≤ 2048', permissions: 'organization:read', evidence: '26 baseline Runs · Level 3', updated: '2026-07-30' },
  { id: 'exp.c500-cache-layout', kind: 'Experience', version: 'v2.1', title: '沐曦 C500 片上缓存与数据布局准则', description: '依据访问合并、向量宽度和片上容量选择 KV、GEMM 与归约算子的数据布局。', tags: ['MetaX C500', 'cache', 'vector width', 'layout'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · attention / GEMM / reduction', permissions: 'organization:read', evidence: '12 Mission citations · Level 3', updated: '2026-07-25' },
  { id: 'exp.c500-stream-sync', kind: 'Experience', version: 'v1.3', title: '沐曦 C500 多流同步与 Event 使用边界', description: '明确 stream 间依赖、Event 粒度与 host 等待的适用条件，避免隐式同步进入热路径。', tags: ['MetaX C500', 'stream', 'event', 'async'], tone: 'ochre', icon: Lightbulb, scope: '沐曦 MetaX C500 · asynchronous execution', permissions: 'organization:read', evidence: '7 concurrency cases · Level 2', updated: '2026-07-21' },
  { id: 'exp.wavefront-occupancy', kind: 'Experience', version: 'v2.0', title: 'ROCm Wavefront 占用率判断基线', description: '结合 VGPR、LDS 与 active waves 判断低占用是否真实限制吞吐。', tags: ['MI300', 'ROCm', 'occupancy', '8 Run citations'], tone: 'ochre', icon: Lightbulb, scope: 'ROCm MI250 / MI300 · GEMM / attention', permissions: 'organization:read', evidence: '8 Run citations · Level 3', updated: '2026-07-29' },
  { id: 'exp.bank-conflict', kind: 'Experience', version: 'v1.6', title: '共享内存 Bank Conflict 定位模式', description: '通过访问步长、数据布局和冲突计数器识别共享内存序列化。', tags: ['CUDA', 'shared memory', 'layout', '5 missions'], tone: 'ochre', icon: Lightbulb, scope: 'CUDA SM80+ · GEMM / reduction', permissions: 'organization:read', evidence: '5 Mission citations · Level 3', updated: '2026-07-24' },
  { id: 'exp.pipeline-stall', kind: 'Experience', version: 'v1.4', title: '异步流水线 Stall 归因规则', description: '区分数据依赖、barrier、访存等待和 pipeline stage 配置导致的停顿。', tags: ['async copy', 'pipeline', 'CUDA', 'C500'], tone: 'ochre', icon: Lightbulb, scope: 'CUDA / C500 · multi-stage pipeline', permissions: 'organization:read', evidence: '6 Run citations · Level 2', updated: '2026-07-18' },
  { id: 'exp.search-pruning', kind: 'Experience', version: 'v2.4', title: 'GEMM 调优搜索空间裁剪策略', description: '依据 shape、数据类型和硬件约束提前排除低收益或不可执行组合。', tags: ['GEMM', 'autotune', 'BF16', '47% less trials'], tone: 'ochre', icon: Lightbulb, scope: 'C500 / CUDA / ROCm · M/N/K distributions', permissions: 'organization:read', evidence: '19 tuning sessions · Level 3', updated: '2026-07-11' },
  { id: 'exp.precision-drift', kind: 'Experience', version: 'v1.1', title: '混合精度误差漂移排查清单', description: '按累加精度、归约顺序、输入分布与边界值逐层定位跨平台误差。', tags: ['FP16', 'BF16', 'correctness', 'cross-platform'], tone: 'ochre', icon: Lightbulb, scope: 'FP16 / BF16 · inference kernels', permissions: 'organization:read', evidence: '11 regression cases · Level 3', updated: '2026-06-30' },
  { id: 'skill.segmentation', kind: 'Skill', version: 'v2.3.1', title: '性能瓶颈分段分析', description: '建立 host/device 边界的可归因时间线，并保存完整环境指纹。', tags: ['repository:read', 'test_task:create', 'timeline'], tone: 'blue', icon: Layers3, referenced: true, scope: 'C500 / CUDA / ROCm · performance diagnosis', permissions: 'repository:read · test_task:create', evidence: '14 Missions · verified workflow', updated: '2026-08-01' },
  { id: 'skill.correctness-matrix', kind: 'Skill', version: 'v1.9.0', title: '跨平台正确性矩阵生成', description: '从算子签名与 shape 分布生成边界、随机和历史回归用例矩阵。', tags: ['correctness', 'case generation', '3 platforms'], tone: 'blue', icon: Layers3, scope: 'C500 / CUDA / ROCm · operator test plans', permissions: 'repository:read · test_task:create', evidence: '624 generated cases · 99.4% pass', updated: '2026-07-28' },
  { id: 'skill.fusion-feasibility', kind: 'Skill', version: 'v1.5.2', title: 'Kernel Fusion 可行性评估', description: '评估访存节省、寄存器压力、调度边界与回退成本，输出融合候选。', tags: ['fusion', 'memory traffic', 'risk assessment'], tone: 'blue', icon: Layers3, scope: 'Elementwise / normalization / attention epilogue', permissions: 'repository:read · candidate:create', evidence: '9 adopted candidates · reviewed', updated: '2026-07-22' },
  { id: 'skill.regression-bisect', kind: 'Skill', version: 'v1.3.0', title: '性能回归边界搜索', description: '在固定环境中二分定位回归提交，并关联 Patch、Run 与环境变化。', tags: ['git bisect', 'regression', 'environment fixed'], tone: 'blue', icon: Layers3, scope: 'Git repositories · benchmark history', permissions: 'repository:read · test_task:create', evidence: '7 regressions localized · audited', updated: '2026-07-15' },
  { id: 'skill.shape-analysis', kind: 'Skill', version: 'v2.1.0', title: '真实 Shape 分布分析', description: '从脱敏请求样本建立 shape 热区与长尾分布，为调优优先级提供依据。', tags: ['shape corpus', 'P50 / P95', 'privacy safe'], tone: 'blue', icon: Layers3, scope: 'Inference request traces · anonymized', permissions: 'dataset:read · report:create', evidence: '4 production datasets · approved', updated: '2026-07-06' },
  { id: 'tool.profile-timeline', kind: 'Tool', version: 'v1.8.0', title: 'Profile timeline', description: '在受控 Worker 内采集包含 plan、host mirror 和 Kernel 的统一时间线。', tags: ['profile.timeline', 'C500 / CUDA', 'artifact'], tone: 'green', icon: TerminalSquare, referenced: true, scope: 'C500 / CUDA · controlled workers', permissions: 'worker:execute · artifact:write', evidence: '326 artifacts · signed digest', updated: '2026-08-02' },
  { id: 'tool.env-diff', kind: 'Tool', version: 'v2.2.0', title: 'Environment Snapshot Diff', description: '比较驱动、Runtime、编译器、固件与关键环境变量，识别不可比 Run。', tags: ['environment', 'reproducibility', 'diff'], tone: 'green', icon: TerminalSquare, scope: 'C500 / CUDA / ROCm worker snapshots', permissions: 'environment:read · report:create', evidence: '91 snapshot comparisons · verified', updated: '2026-07-31' },
  { id: 'tool.noise-analyzer', kind: 'Tool', version: 'v1.7.3', title: 'Benchmark Noise Analyzer', description: '检测预热不足、频率波动、资源争用和异常离群点，并给出重跑建议。', tags: ['benchmark', 'variance', 'outlier'], tone: 'green', icon: TerminalSquare, scope: 'Latency / throughput benchmarks · all workers', permissions: 'run:read · test_task:create', evidence: '1,284 Runs analyzed · calibrated', updated: '2026-07-26' },
  { id: 'tool.isa-hotspot', kind: 'Tool', version: 'v1.4.1', title: 'ISA Hotspot Inspector', description: '关联源码、编译产物与指令热点，定位访存、分支和流水线问题。', tags: ['SASS', 'ISA', 'source mapping'], tone: 'green', icon: TerminalSquare, scope: 'CUDA SASS / C500 ISA · debug builds', permissions: 'artifact:read · repository:read', evidence: '43 hotspot reports · signed', updated: '2026-07-19' },
  { id: 'tool.workspace-tracker', kind: 'Tool', version: 'v1.2.0', title: 'Workspace Allocation Tracker', description: '记录 Workspace 生命周期、复用率和峰值占用，识别热路径重复分配。', tags: ['workspace', 'allocation', 'lifetime'], tone: 'green', icon: TerminalSquare, scope: 'C500 / CUDA runtime allocations', permissions: 'worker:execute · artifact:write', evidence: '18 Missions · verified', updated: '2026-07-08' },
];

const knowledgeHardwareMap = {
  'exp.fixed-overhead': ['c500', 'nvidia'],
  'exp.c500-compiler-flags': ['c500'],
  'exp.c500-launch-baseline': ['c500'],
  'exp.c500-cache-layout': ['c500'],
  'exp.c500-stream-sync': ['c500'],
  'exp.wavefront-occupancy': ['amd'],
  'exp.bank-conflict': ['nvidia'],
  'exp.pipeline-stall': ['c500', 'nvidia'],
  'exp.search-pruning': ['c500', 'nvidia', 'amd'],
  'exp.precision-drift': ['c500', 'nvidia', 'amd'],
  'skill.segmentation': ['c500', 'nvidia', 'amd'],
  'skill.correctness-matrix': ['c500', 'nvidia', 'amd'],
  'skill.fusion-feasibility': ['c500', 'nvidia'],
  'skill.regression-bisect': ['c500', 'nvidia', 'amd'],
  'skill.shape-analysis': ['c500', 'nvidia', 'amd'],
  'tool.profile-timeline': ['c500', 'nvidia'],
  'tool.env-diff': ['c500', 'nvidia', 'amd'],
  'tool.noise-analyzer': ['c500', 'nvidia', 'amd'],
  'tool.isa-hotspot': ['c500', 'nvidia'],
  'tool.workspace-tracker': ['c500', 'nvidia'],
};

const hardwareLabels = {
  c500: '沐曦 MetaX C500',
  nvidia: 'NVIDIA CUDA',
  amd: 'AMD ROCm / MI300',
};

function ReferenceRow({ icon: Icon, type, title, meta, tone, onClick }) {
  return (
    <button className="reference-row" onClick={onClick}>
      <span className={`reference-icon ${tone}`}><Icon size={16} /></span>
      <span><small>{type}</small><strong>{title}</strong></span>
      <em>{meta} <ChevronRight size={13} /></em>
    </button>
  );
}

function MissionView({ stage, setView, onAdvance, onOpenModal, paused }) {
  const active = stageOrder[stage];
  return (
    <main className="page mission-page">
      <MissionHeader stage={stage} onAdvance={onAdvance} onOpenModal={onOpenModal} disabled={paused} />
      <ShowcaseBoard onOpenModal={onOpenModal} />

      <section className="overview-layout">
        <article className="judgement-block reveal one">
          <div className="section-index">01 / 当前判断</div>
          <h2>瓶颈不在 Kernel，<br />而在热路径的固定开销。</h2>
          <p>设备 Kernel 已低于 50μs。重复创建 plan descriptor、workspace 分配与 host mirror 同步，正在主导短序列延迟。</p>
          <div className="judgement-quote">
            <span>Agent recommendation</span>
            <strong>缓存 plan descriptor，并将 host mirror 移出热路径。</strong>
          </div>
          <button className="text-link" onClick={() => onOpenModal('knowledgeEvidence')}>查看知识依据 <ArrowRight size={15} /></button>
        </article>

        <aside className="references-block reveal two">
          <div className="references-heading"><div><span className="section-index">02 / 知识依据</span><strong>3 条已引用</strong></div><button onClick={() => onOpenModal('knowledgeEvidence')}>查看详情 <ArrowRight size={13} /></button></div>
          {missionKnowledge.map((item) => <ReferenceRow key={item.source} icon={item.icon} type={item.kind.toUpperCase()} title={item.shortTitle} meta={item.version} tone={item.tone} onClick={() => onOpenModal('asset', { kind: item.kind, title: item.title, version: item.version })} />)}
          <div className="reference-note"><ShieldCheck size={15} /> 3 条引用均绑定可访问证据与固定版本。</div>
        </aside>
      </section>

      <section className="candidate-section reveal three">
        <div className="section-heading-large">
          <div><span>03 / 当前候选</span><h2>Candidate 02 · Async plan cache</h2></div>
          <button className="secondary-action" onClick={() => setView('code')}>审阅代码变更 <ArrowRight size={15} /></button>
        </div>
        <div className="comparison-table">
          <div className="comparison-head"><span>方案</span><span>热路径组成</span><span>延迟</span><span>状态</span></div>
          <div className="comparison-row muted"><strong>Current best</strong><div className="path-bar baseline"><i>plan</i><i>alloc</i><i>mirror</i><i>kernel</i></div><b>53.8 μs</b><span>基线</span></div>
          <div className="comparison-row proposed"><strong>Candidate 02</strong><div className="path-bar candidate"><i>cache hit</i><i>async mirror</i><i>kernel</i></div><b>41.8 μs</b><span>−22.3%</span></div>
        </div>
      </section>

      <section className="bottom-overview">
        <div className="run-summary">
          <div className="section-index">04 / 验证状态</div>
          <div className="run-line"><span className="platform-sign green">C5</span><div><strong>C500 Production 01</strong><small>Correctness 12/12 · Full Benchmark</small></div><em>{active >= 3 ? '41.8 μs' : active >= 2 ? 'Running' : 'Queued'}</em></div>
          <div className="run-line"><span className="platform-sign blue">CU</span><div><strong>CUDA A100 Reference</strong><small>Correctness 12/12 · Full Benchmark</small></div><em>{active >= 3 ? '36.1 μs' : active >= 2 ? 'Running' : 'Queued'}</em></div>
          <button className="text-link" onClick={() => setView('experiments')}>打开测试矩阵 <ArrowRight size={15} /></button>
        </div>
        <div className="decision-block">
          <TriangleAlert size={19} />
          <div><span>DECISION GATE</span><strong>{stage === 'evidence' ? '证据已满足采用条件' : stageOrder[stage] > 3 ? '候选已通过采用审批' : 'Full Benchmark 完成前不可更新 current best'}</strong><p>Probe 仅用于筛选方向；最终采用必须引用完整 Run 与 Environment Snapshot。</p></div>
        </div>
      </section>
    </main>
  );
}

function IterationTrendChart() {
  const width = 760;
  const height = 224;
  const padding = { left: 52, right: 24, top: 24, bottom: 42 };
  const minValue = 38;
  const maxValue = 56;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const points = operatorIterations.map((item, index) => ({
    ...item,
    x: padding.left + (innerWidth / (operatorIterations.length - 1)) * index,
    y: padding.top + ((maxValue - item.c500) / (maxValue - minValue)) * innerHeight,
  }));
  const targetY = padding.top + ((maxValue - 45) / (maxValue - minValue)) * innerHeight;
  return (
    <svg className="iteration-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="C500 延迟随候选迭代变化趋势">
      {[55, 50, 45, 40].map((tick) => {
        const y = padding.top + ((maxValue - tick) / (maxValue - minValue)) * innerHeight;
        return <g key={tick}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" /><text x={padding.left - 12} y={y + 4} textAnchor="end" className="chart-axis-label">{tick}μs</text></g>;
      })}
      <line x1={padding.left} x2={width - padding.right} y1={targetY} y2={targetY} className="chart-target-line" />
      <text x={width - padding.right} y={targetY - 7} textAnchor="end" className="chart-target-label">TARGET 45μs</text>
      <polyline points={points.map((point) => `${point.x},${point.y}`).join(' ')} className="chart-trend-line" />
      {points.map((point, index) => <g key={point.id} className={`chart-point ${point.tone}`}><circle cx={point.x} cy={point.y} r={index === 2 ? 7 : 5} /><text x={point.x} y={point.y - 12} textAnchor="middle" className="chart-value">{point.c500}{point.id === 'candidate-04' ? '*' : ''}</text><text x={point.x} y={height - 17} textAnchor="middle" className="chart-candidate-label">{point.label.replace('Candidate ', 'C')}</text></g>)}
    </svg>
  );
}

function IterationsView({ setView, onOpenModal }) {
  const adopted = operatorIterations.find((item) => item.tone === 'adopted');
  const running = operatorIterations.find((item) => item.tone === 'running');
  return (
    <main className="page detail-page iterations-page">
      <section className="detail-heading">
        <div><span className="detail-overline">OPERATOR ITERATIONS / MLA PAGED KV CACHE</span><h1>算子迭代详情</h1><p>追踪每次优化假设、代码变更、跨硬件结果和最终采用决策。</p></div>
        <div className="detail-actions"><button className="primary-action" onClick={() => onOpenModal('iterationDetail', { iteration: running })}><Activity size={14} /> 查看进行中迭代</button></div>
      </section>

      <section className="iteration-summary-band">
        <div className="iteration-summary-lead"><span>OPERATOR</span><strong>MLA Paged KV Cache</strong><small>kernel.paged_attention · current best cnd.02</small></div>
        <div><span>候选迭代</span><strong>4</strong><small>1 adopted · 2 rejected · 1 running</small></div>
        <div><span>当前最佳</span><strong className="metric-good">41.8 <em>μs</em></strong><small>Candidate 02 · C500</small></div>
        <div><span>累计提升</span><strong className="metric-good">22.3%</strong><small>53.8 → 41.8μs</small></div>
        <div><span>当前进度</span><strong>20 / 24</strong><small>Candidate 04 correctness</small></div>
      </section>

      <section className="iteration-analysis-grid">
        <article className="iteration-trend-panel">
          <div className="iteration-panel-head"><div><span>PERFORMANCE TREND</span><strong>C500 延迟演进</strong></div><div className="chart-legend"><span><i className="adopted" />已采用</span><span><i className="running" />验证中</span></div></div>
          <IterationTrendChart />
          <div className="trend-footnote"><ShieldCheck size={14} /><span>趋势仅使用固定 Environment Snapshot 下的可比 Run；Candidate 04 为 Probe 临时结果。</span></div>
        </article>

        <aside className="iteration-best-panel">
          <div className="best-panel-label"><CheckCircle2 size={15} /> CURRENT BEST</div>
          <span className="iteration-status adopted">{adopted.status}</span>
          <h2>{adopted.label} · {adopted.title}</h2>
          <p>{adopted.hypothesis}</p>
          <div className="best-platform-results"><div><span>C500</span><strong>{adopted.c500}μs</strong><small>−22.3%</small></div><div><span>CUDA A100</span><strong>{adopted.cuda}μs</strong><small>−18.7%</small></div></div>
          <div className="best-proof"><span><CheckCircle2 size={14} /> Correctness {adopted.correctness}</span><span><ShieldCheck size={14} /> {adopted.evidence}</span></div>
          <button onClick={() => onOpenModal('iterationDetail', { iteration: adopted })}>查看采用证据 <ArrowRight size={14} /></button>
        </aside>
      </section>

      <section className="iteration-ledger">
        <div className="iteration-ledger-title"><div><span>ITERATION LEDGER</span><strong>完整迭代台账</strong></div><small>点击任一版本查看代码、验证与决策详情</small></div>
        <div className="iteration-ledger-head"><span>版本</span><span>优化方向</span><span>C500</span><span>CUDA</span><span>相对基线</span><span>正确性</span><span>决策</span><span /></div>
        {operatorIterations.map((item) => <button key={item.id} className={`iteration-ledger-row ${item.tone}`} onClick={() => onOpenModal('iterationDetail', { iteration: item })}><div><span className="iteration-version">{item.version}</span><small>{item.date}</small></div><div><strong>{item.title}</strong><small>{item.files}</small></div><b>{item.c500}μs</b><b>{item.cuda ? `${item.cuda}μs` : 'Running'}</b><em>{item.delta}</em><span>{item.correctness}</span><span className={`iteration-status ${item.tone}`}>{item.status}</span><ChevronRight size={15} /></button>)}
      </section>
    </main>
  );
}

function CodeView({ patchApplied, workspaceFiles: remoteWorkspaceFiles, onApplyPatch, onOpenModal, paused }) {
  const applied = patchApplied;
  const [diffMode, setDiffMode] = useState('unified');
  const [activeFileId, setActiveFileId] = useState('paged_attention.cu');
  const [expandedFolders, setExpandedFolders] = useState({ kernels: true, tests: false, benchmarks: false });
  const fallbackFiles = {
    'paged_attention.cu': {
      path: 'kernels/paged_attention.cu', status: 'M',
      lines: [
        ['context', '188', 'auto plan = build_attention_plan(args);'],
        ['remove', '189', 'auto workspace = allocate_workspace(plan.size());'],
        ['remove', '190', 'mirror_to_host(plan, host_plan);'],
        ['add', '189', 'auto& plan = plan_cache.get_or_build(args.signature());'],
        ['add', '190', 'if (LIKELY(plan.host_mirror_ready())) {'],
        ['add', '191', '  launch_paged_kernel(plan.device_view(), kv_cache);'],
        ['add', '192', '} else {'],
        ['add', '193', '  plan_cache.enqueue_host_mirror(plan);'],
        ['add', '194', '}'],
        ['context', '195', 'return plan;'],
      ],
      rationale: '缓存 descriptor 避免热路径重复分配；同步回退只保留在 host mirror 尚未就绪的边界场景。',
    },
    'plan_cache.hpp': {
      path: 'kernels/plan_cache.hpp', status: 'A',
      lines: [
        ['context', '1', '#pragma once'],
        ['add', '2', 'class PlanCache {'],
        ['add', '3', ' public:'],
        ['add', '4', '  Plan& get_or_build(Signature signature);'],
        ['add', '5', '  void enqueue_host_mirror(const Plan& plan);'],
        ['add', '6', '};'],
      ],
      rationale: '新增轻量 descriptor cache，将 plan 生命周期与请求 signature 绑定，避免重复构建。',
    },
    'paged_attention_cases.yaml': {
      path: 'tests/paged_attention_cases.yaml', status: 'T',
      lines: [
        ['context', '1', 'suite: paged_attention'],
        ['context', '2', 'platforms: [C500, CUDA]'],
        ['add', '3', 'correctness_cases: 24'],
        ['add', '4', 'shape: [1, 4, 128, 1024]'],
        ['add', '5', 'assert: max_abs_error <= 1e-3'],
      ],
      rationale: 'Correctness Gate 固定 24 个边界与回归用例，先通过正确性再进入性能阶段。',
    },
    'mla_paged_attention.yaml': {
      path: 'benchmarks/mla_paged_attention.yaml', status: 'B',
      lines: [
        ['context', '1', 'benchmark: mla_paged_attention'],
        ['context', '2', 'warmup: 50'],
        ['add', '3', 'repeats: 200'],
        ['add', '4', 'metric: latency_p50'],
        ['add', '5', 'environment_snapshot: fixed'],
      ],
      rationale: 'Benchmark 固定预热、重复次数与 Environment Snapshot，保证跨硬件结果可比。',
    },
  };
  const files = remoteWorkspaceFiles?.length ? Object.fromEntries(remoteWorkspaceFiles.map((file) => [file.id, file])) : fallbackFiles;
  const activeFile = files[activeFileId] || files['paged_attention.cu'] || Object.values(files)[0];
  const toggleFolder = (folder) => setExpandedFolders((current) => ({ ...current, [folder]: !current[folder] }));
  const fileButton = (id, label, Icon = FileCode2) => <button className={`file-item ${activeFileId === id ? 'selected' : ''}`} onClick={() => setActiveFileId(id)}><Icon size={15} /> {label}<em>{files[id]?.status}</em></button>;
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">CODE REVIEW / CANDIDATE 02</span><h1>Async plan descriptor cache</h1><p>补丁范围明确、可回退，且不会覆盖本地未提交修改。</p></div>
        <div className="detail-actions"><button className={`primary-action ${applied ? 'done' : ''}`} disabled={paused || applied} onClick={onApplyPatch}>{applied ? <><Check size={15} /> 已应用</> : <><ShieldCheck size={15} /> 批准并应用</>}</button></div>
      </section>

      <section className="code-workspace">
        <aside className="file-browser">
          <div className="workspace-caption"><span>REPOSITORY</span><strong>mla-kernels</strong></div>
          <button className="file-item folder" onClick={() => toggleFolder('kernels')}>{expandedFolders.kernels ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> kernels</button>
          {expandedFolders.kernels && <>{fileButton('paged_attention.cu', 'paged_attention.cu')}{fileButton('plan_cache.hpp', 'plan_cache.hpp')}</>}
          <button className="file-item folder" onClick={() => toggleFolder('tests')}>{expandedFolders.tests ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> tests</button>
          {expandedFolders.tests && fileButton('paged_attention_cases.yaml', 'paged_attention_cases.yaml')}
          <button className="file-item folder" onClick={() => toggleFolder('benchmarks')}>{expandedFolders.benchmarks ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<FolderGit2 size={15} /> benchmarks</button>
          {expandedFolders.benchmarks && fileButton('mla_paged_attention.yaml', 'mla_paged_attention.yaml')}
          <div className="bridge-state"><Mark pulse /><span>Local Bridge</span><small>authorized</small></div>
        </aside>

        <article className="diff-editor">
          <div className="editor-bar"><span><FileCode2 size={15} /> {activeFile.path}</span><div><button className={diffMode === 'unified' ? 'active' : ''} onClick={() => setDiffMode('unified')}>Unified</button><button className={diffMode === 'split' ? 'active' : ''} onClick={() => setDiffMode('split')}>Split</button><button className="editor-more" aria-label="编辑器更多操作" onClick={() => onOpenModal('editorActions')}><MoreHorizontal size={17} /></button></div></div>
          <div className={`code-lines ${diffMode}`} aria-label="Code diff">
            {activeFile.lines.map(([type, line, code]) => <div className={type} key={`${line}-${code}`}><i>{line}</i><code>{code}</code></div>)}
          </div>
          <div className="editor-rationale"><Lightbulb size={16} /><div><span>AGENT RATIONALE</span><p>{activeFile.rationale}</p></div></div>
        </article>

        <aside className="review-summary">
          <div className="summary-group"><span>CHANGE BOUNDARY</span><dl><div><dt>Files</dt><dd>2</dd></div><div><dt>Commands</dt><dd>none</dd></div><div><dt>Risk</dt><dd className="risk">medium</dd></div></dl></div>
          <div className="summary-group"><span>PRE-APPLY CHECKS</span><ul><li><CheckCircle2 size={15} /> API compatibility verified</li><li><CheckCircle2 size={15} /> Local work protected</li><li><CheckCircle2 size={15} /> Patch digest recorded</li></ul></div>
          <div className="summary-note"><LockKeyhole size={15} /> 该操作需要用户审批并写入审计链。</div>
        </aside>
      </section>
    </main>
  );
}

function ExperimentsView({ benchmarkStatus, benchmarkProgress, benchmarkLogs, testMatrix, onRunBenchmark, onOpenModal, paused }) {
  const complete = benchmarkStatus === 'complete';
  const running = benchmarkStatus === 'running';
  const selectedEnvironments = testMatrix?.environments || ['C500', 'CUDA'];
  const visibleTasks = tasks.filter((task) => selectedEnvironments.includes(task.platform));
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">TEST PLAN / TPL_01JH7R</span><h1>跨环境验证</h1><p>同一候选被精确路由到两个固定环境，Correctness Gate 先于性能结论。</p></div>
        <div className="detail-actions"><button className="ghost-action" disabled={paused || running} onClick={() => onOpenModal('matrix')}><SlidersHorizontal size={14} /> 编辑测试矩阵</button><button className={`primary-action ${complete ? 'done' : ''}`} disabled={paused || running || complete} onClick={onRunBenchmark}>{complete ? <><Check size={15} /> Benchmark 已完成</> : running ? <><Activity size={15} /> 运行中 {benchmarkProgress}%</> : <><Beaker size={14} /> 运行测试矩阵</>}</button></div>
      </section>

      <section className="experiment-hero">
        <div><span>TEST MATRIX</span><strong>{visibleTasks.length}</strong><small>environments</small></div>
        <div><span>CORRECTNESS</span><strong>{visibleTasks.length * 12}/{visibleTasks.length * 12}</strong><small>cases passed</small></div>
        <div><span>ACTIVE RUNS</span><strong>{complete ? '0' : running ? `${Math.max(1, Math.ceil((100 - benchmarkProgress) / 50))}` : '0'}</strong><small>{complete ? 'all completed' : running ? 'leased workers' : 'ready to run'}</small></div>
        <div><span>BEST RESULT</span><strong>{complete ? '41.8' : running ? `${benchmarkProgress}%` : '—'}</strong><small>{running ? 'benchmark progress' : 'μs on C500'}</small></div>
      </section>

      <section className="matrix-table">
        <div className="matrix-table-head"><span>Environment</span><span>Correctness</span><span>Probe</span><span>Full Benchmark</span><span>Result</span></div>
        {visibleTasks.map((task) => (
          <div className="matrix-table-row" key={task.id}>
            <div className="environment-name"><span className={`platform-sign ${task.tone}`}>{task.platform === 'C500' ? 'C5' : 'CU'}</span><span><strong>{task.environment}</strong><small>{task.id}</small></span></div>
            <div className="cell-pass"><CheckCircle2 size={16} /> 12 / 12</div>
            <div className="cell-pass"><CheckCircle2 size={16} /> {task.result} μs</div>
            <div className={complete ? 'cell-pass' : running ? 'cell-running' : 'cell-pending'}>{complete ? <CheckCircle2 size={16} /> : running ? <Activity size={16} /> : <CircleDot size={16} />} {complete ? 'Completed' : running ? `${benchmarkProgress}%` : 'Ready'}</div>
            <div className="result-cell"><strong>{complete ? task.improvement : '—'}</strong><small>{complete ? `${task.result} μs` : running ? 'collecting' : 'waiting'}</small></div>
          </div>
        ))}
      </section>

      <section className="run-console" aria-label="Benchmark 执行日志">
        <div className="run-console-head"><div><span>RUN STREAM</span><strong>{running ? '正在收集执行日志' : complete ? '执行日志已归档' : '等待提交测试任务'}</strong></div><small>{benchmarkLogs.length ? `${benchmarkLogs.length} 条事件 · ${benchmarkStatus === 'complete' ? 'artifact persisted' : 'live polling'}` : '提交后显示真实任务状态'}</small></div>
        <div className="run-console-body">{benchmarkLogs.length ? benchmarkLogs.map((log) => <div key={log.sequence}><i>{String(log.sequence).padStart(2, '0')}</i><span className={log.progress === 100 ? 'done' : ''}>{log.message}</span><em>{log.progress}%</em></div>) : <div className="run-console-empty"><TerminalSquare size={15} />尚未提交 Run，测试日志会在服务端任务启动后出现。</div>}</div>
      </section>

      <section className="evidence-band">
        <ShieldCheck size={23} />
        <div><span>EVIDENCE POLICY</span><strong>{complete ? 'Full Benchmark 已形成 Level 3 证据' : 'Correctness 通过，正在建立 Level 3 证据'}</strong><p>每个 Run 固定绑定 Environment Snapshot 与 Runner Adapter 版本，结果可审计、可复现。</p></div>
        <button className="text-link" onClick={() => onOpenModal('knowledgeEvidence')}>查看证据引用 <ArrowRight size={15} /></button>
      </section>
    </main>
  );
}

function DecisionView({ stage, onAdopt, onReject, onOpenModal, paused }) {
  const candidates = operatorIterations.filter((item) => ['candidate-02', 'candidate-03', 'candidate-04'].includes(item.id));
  const [selectedId, setSelectedId] = useState('candidate-02');
  const [decisionNote, setDecisionNote] = useState('满足 C500 与 CUDA 的性能目标，保留 host mirror fallback。');
  const selected = candidates.find((item) => item.id === selectedId) || candidates[0];
  const ready = stageOrder[stage] >= stageOrder.evidence;
  const gates = [
    { label: '正确性门禁', detail: selected.correctness, passed: selected.correctness === '24 / 24' },
    { label: 'C500 性能目标', detail: `${selected.c500}μs / target 45μs`, passed: selected.c500 <= 45 },
    { label: 'CUDA 性能目标', detail: selected.cuda ? `${selected.cuda}μs / baseline 44.4μs` : '尚未完成', passed: Boolean(selected.cuda && selected.cuda < 44.4) },
    { label: '证据等级', detail: selected.evidence, passed: selected.evidence.includes('Level 3') },
  ];
  return (
    <main className="page detail-page decision-page">
      <section className="detail-heading">
        <div><span className="detail-overline">DECISION GATE / MIS_01JH7R</span><h1>效果决策</h1><p>对候选结果、证据门禁和回退风险进行一次可审计的采用判断。</p></div>
        <div className="detail-actions"><button className="ghost-action" onClick={() => onOpenModal('events')}><History size={14} /> 查看审计链</button></div>
      </section>
      <section className="decision-hero">
        <div><span>SELECTED CANDIDATE</span><strong>{selected.label}</strong><small>{selected.title}</small></div>
        <div><span>BASELINE</span><strong>53.8 <em>μs</em></strong><small>C500 p50</small></div>
        <div><span>PROPOSED</span><strong className="metric-good">{selected.c500} <em>μs</em></strong><small>{selected.delta} vs baseline</small></div>
        <div className="decision-hero-result"><span>DECISION</span><strong>{ready ? '待审批' : '等待验证'}</strong><small>Level 3 evidence gate</small></div>
      </section>
      <section className="decision-workspace">
        <aside className="decision-candidates">
          <div className="decision-panel-heading"><span>CANDIDATE SET</span><strong>候选比较</strong></div>
          {candidates.map((candidate) => <button key={candidate.id} className={selected.id === candidate.id ? 'selected' : ''} onClick={() => setSelectedId(candidate.id)}><span className={`decision-candidate-status ${candidate.tone}`} /><span><strong>{candidate.label}</strong><small>{candidate.title}</small></span><em>{candidate.c500}μs</em></button>)}
          <div className="decision-candidate-note"><ShieldCheck size={15} /><span>只允许完整证据的候选进入采用审批。</span></div>
        </aside>
        <section className="decision-gates">
          <div className="decision-panel-heading"><span>EVIDENCE GATES</span><strong>采用条件</strong><button onClick={() => onOpenModal('knowledgeEvidence')}>查看证据 <ArrowRight size={13} /></button></div>
          <div className="decision-gate-list">{gates.map((gate) => <div key={gate.label} className={gate.passed ? 'passed' : 'blocked'}><span>{gate.passed ? <CheckCircle2 size={17} /> : <TriangleAlert size={17} />}</span><div><strong>{gate.label}</strong><small>{gate.detail}</small></div><em>{gate.passed ? 'PASS' : 'BLOCKED'}</em></div>)}</div>
          <div className="decision-evidence-note"><FileText size={16} /><div><span>DECISION REPORT</span><strong>{selected.evidence}</strong><p>环境快照、Run 结果和 Patch digest 已固定，可回溯到原始工件。</p></div></div>
        </section>
        <aside className="decision-risk-panel">
          <div className="decision-panel-heading"><span>REVIEW NOTE</span><strong>审批意见</strong></div>
          <textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} disabled={!ready || paused} aria-label="审批意见" />
          <div className="decision-risk-list"><span><ShieldCheck size={14} /> API compatibility verified</span><span><GitBranch size={14} /> Rollback target: cnd.01</span><span><LockKeyhole size={14} /> 写入审计链</span></div>
          <div className="decision-actions"><button className="ghost-action" disabled={!ready || paused} onClick={() => onReject(selected, decisionNote)}><X size={14} /> 退回验证</button><button className="primary-action" disabled={!ready || paused || !gates.every((gate) => gate.passed)} onClick={() => onAdopt(selected, decisionNote)}><Check size={14} /> 采用候选</button></div>
        </aside>
      </section>
    </main>
  );
}

function CurationView({ stage, drafts = defaultKnowledgeDrafts, publishedAssets, onUpdateDraft, onPublish, onPublishAll, onViewLibrary, onOpenModal, paused }) {
  const [activeDraftId, setActiveDraftId] = useState('exp.async-plan-cache');
  const publishedIds = new Set((publishedAssets || []).map((asset) => asset.id));
  const activeDraft = drafts.find((draft) => draft.id === activeDraftId) || drafts[0];
  const published = publishedIds.has(activeDraft.id);
  const publishedCount = publishedIds.size;
  const updateDraft = (field, value) => onUpdateDraft(activeDraft.id, { [field]: value });
  const toggleHardware = (value) => updateDraft('hardware', activeDraft.hardware.includes(value) ? activeDraft.hardware.filter((item) => item !== value) : [...activeDraft.hardware, value]);
  const isReady = (draft) => Boolean(draft.title.trim() && draft.conclusion.trim() && draft.hardware.length > 0);
  const canPublish = !published && stage === 'curation' && !paused && isReady(activeDraft);
  const canPublishAll = stage === 'curation' && !paused && publishedCount < drafts.length && drafts.every(isReady);
  return (
    <main className="page detail-page curation-page">
      <section className="detail-heading">
        <div><span className="detail-overline">EXPERIENCE CURATOR / MIS_01JH7R</span><h1>知识沉淀</h1><p>从一次优化任务中拆解多条可复用经验，分别维护适用范围、硬件边界和证据链。</p></div>
        <div className="detail-actions"><button className="ghost-action" onClick={() => onOpenModal('knowledgeEvidence')}><ShieldCheck size={14} /> 查看来源证据</button><button className="ghost-action" onClick={onViewLibrary}><BookOpen size={14} /> 查看知识库</button></div>
      </section>
      <section className="curation-status-band"><div className="curation-status-lead"><span>MISSION KNOWLEDGE SET</span><strong>{drafts.length} 条经验资产</strong><small>通用经验 · C500 专项 · 跨平台门禁</small></div><div><span>来源候选</span><strong>Candidate 02</strong><small>Level 3 evidence</small></div><div><span>发布进度</span><strong>{publishedCount} / {drafts.length}</strong><small>{publishedCount === drafts.length ? '全部已发布' : `${drafts.length - publishedCount} 条待发布`}</small></div><div><span>当前适配平台</span><strong>{activeDraft.hardware.length}</strong><small>{activeDraft.hardware.join(' · ')}</small></div></section>
      <section className="curation-workspace">
        <aside className="curation-source-panel">
          <div className="curation-panel-heading"><span>KNOWLEDGE SET</span><strong>沉淀资产</strong><em>{publishedCount}/{drafts.length}</em></div>
          <nav className="curation-draft-list" aria-label="待沉淀经验资产">
            {drafts.map((draft) => <button key={draft.id} className={activeDraft.id === draft.id ? 'selected' : ''} onClick={() => setActiveDraftId(draft.id)}><span className={`curation-draft-icon ${publishedIds.has(draft.id) ? 'published' : ''}`}>{publishedIds.has(draft.id) ? <Check size={14} /> : <Lightbulb size={14} />}</span><span><small>{draft.code} · {draft.category}</small><strong>{draft.title}</strong><em>{draft.hardware.join(' / ')}</em></span><ChevronRight size={14} /></button>)}
          </nav>
          <div className="curation-lineage-summary"><ShieldCheck size={15} /><div><strong>共享来源证据</strong><small>Decision Report · 2 Full Benchmark Runs</small></div></div>
          <button className="text-link" onClick={() => onOpenModal('events')}>查看完整证据链 <ArrowRight size={14} /></button>
        </aside>
        <section className="curation-editor-panel">
          <div className="curation-panel-heading"><span>STRUCTURED EXPERIENCE / {activeDraft.code}</span><strong>{activeDraft.category}</strong><em>{published ? '已发布 · 只读' : '草稿自动保存'}</em></div>
          <label><span>经验标题</span><input value={activeDraft.title} disabled={published} onChange={(event) => updateDraft('title', event.target.value)} /></label>
          <label><span>核心结论</span><textarea value={activeDraft.conclusion} disabled={published} onChange={(event) => updateDraft('conclusion', event.target.value)} /></label>
          <label><span>适用范围</span><input value={activeDraft.scope} disabled={published} onChange={(event) => updateDraft('scope', event.target.value)} /></label>
          <label><span>约束与回退</span><textarea value={activeDraft.constraints} disabled={published} onChange={(event) => updateDraft('constraints', event.target.value)} /></label>
          <div className="curation-hardware"><span>适配硬件</span><div>{['C500', 'CUDA', 'ROCm MI300'].map((item) => <label key={item}><input type="checkbox" checked={activeDraft.hardware.includes(item)} disabled={published} onChange={() => toggleHardware(item)} />{item}</label>)}</div></div>
        </section>
        <aside className="curation-publish-panel">
          <div className="curation-panel-heading"><span>PUBLISH CHECKS</span><strong>发布检查</strong></div>
          <div className="curation-active-asset"><span>{activeDraft.code}</span><strong>{activeDraft.category}</strong><small>{activeDraft.evidence}</small></div>
          <div className="curation-check-item"><CheckCircle2 size={16} /><div><strong>证据完整</strong><small>{activeDraft.evidence}</small></div></div>
          <div className={`curation-check-item ${activeDraft.title.trim() && activeDraft.conclusion.trim() ? '' : 'blocked'}`}>{activeDraft.title.trim() && activeDraft.conclusion.trim() ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}<div><strong>内容完整</strong><small>标题、结论和适用范围已填写</small></div></div>
          <div className={`curation-check-item ${activeDraft.hardware.length ? '' : 'blocked'}`}>{activeDraft.hardware.length ? <CheckCircle2 size={16} /> : <TriangleAlert size={16} />}<div><strong>平台范围</strong><small>{activeDraft.hardware.length ? `${activeDraft.hardware.length} 个平台` : '至少选择一个平台'}</small></div></div>
          <div className="curation-publish-note"><LockKeyhole size={14} /><span>发布后将生成固定版本，后续只能通过新版本修订。</span></div>
          <button className="primary-action curation-publish-action" disabled={!canPublish} onClick={() => onPublish(activeDraft)}>{published ? <><Check size={15} /> 当前经验已发布</> : <><UploadCloud size={15} /> 发布当前经验</>}</button>
          <button className="ghost-action curation-publish-all" disabled={!canPublishAll} onClick={() => onPublishAll(drafts)}><Layers3 size={15} /> 发布全部就绪经验</button>
        </aside>
      </section>
    </main>
  );
}

function KnowledgeView({ catalog = knowledgeCatalog, setView, onOpenModal, missionContext }) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [hardwareFilter, setHardwareFilter] = useState('all');
  const [filterOpen, setFilterOpen] = useState(true);
  const [coverageOpen, setCoverageOpen] = useState(true);
  const normalizedQuery = query.trim().toLowerCase();
  const getHardwareKeys = (asset) => asset.hardwareKeys || knowledgeHardwareMap[asset.id] || [];
  const visibleAssets = catalog.filter((asset) => {
    const matchesType = typeFilter === 'all' || asset.kind.toLowerCase() === typeFilter;
    const hardwareKeys = getHardwareKeys(asset);
    const matchesHardware = hardwareFilter === 'all' || (hardwareFilter === 'cross' ? hardwareKeys.length > 1 : hardwareKeys.includes(hardwareFilter));
    const hardwareText = hardwareKeys.map((key) => hardwareLabels[key]).join(' ');
    const searchText = `${asset.title} ${asset.description} ${asset.tags.join(' ')} ${asset.scope} ${asset.kind} ${hardwareText}`.toLowerCase();
    return matchesType && matchesHardware && (!normalizedQuery || searchText.includes(normalizedQuery));
  });
  const typeOptions = [
    ['all', '全部', catalog.length],
    ['experience', 'Experience', catalog.filter((asset) => asset.kind === 'Experience').length],
    ['skill', 'Skill', catalog.filter((asset) => asset.kind === 'Skill').length],
    ['tool', 'Tool', catalog.filter((asset) => asset.kind === 'Tool').length],
  ];
  const hardwareOptions = [
    { value: 'all', vendor: 'HARDWARE SCOPE', label: '全部硬件', note: '完整组织目录', count: catalog.length },
    { value: 'c500', vendor: 'METAX', label: '沐曦 C500', note: 'MXMACA 1.4+ · Guide v3.2', count: catalog.filter((asset) => getHardwareKeys(asset).includes('c500')).length },
    { value: 'nvidia', vendor: 'NVIDIA', label: 'CUDA GPU', note: 'SM80 / SM90 · Guide v4.1', count: catalog.filter((asset) => getHardwareKeys(asset).includes('nvidia')).length },
    { value: 'amd', vendor: 'AMD', label: 'MI300 / ROCm', note: 'CDNA2 / CDNA3 · Guide v2.6', count: catalog.filter((asset) => getHardwareKeys(asset).includes('amd')).length },
    { value: 'cross', vendor: 'PORTABLE', label: '跨平台准则', note: 'Correctness / reproducibility', count: catalog.filter((asset) => getHardwareKeys(asset).length > 1).length },
  ];
  const capabilityCoverage = [
    { capability: '性能诊断', note: 'Timeline / Roofline', c500: ['18', 'verified'], nvidia: ['15', 'verified'], amd: ['9', 'verified'] },
    { capability: '候选生成', note: 'Kernel / Runtime', c500: ['12', 'verified'], nvidia: ['11', 'verified'], amd: ['5', 'partial'] },
    { capability: '正确性验证', note: 'Golden / Tolerance', c500: ['24/24', 'verified'], nvidia: ['24/24', 'verified'], amd: ['18/24', 'partial'] },
    { capability: '知识沉淀', note: 'Evidence linked', c500: ['L3', 'verified'], nvidia: ['L3', 'verified'], amd: ['L2', 'partial'] },
  ];
  const activeHardwareLabel = hardwareOptions.find((option) => option.value === hardwareFilter)?.label;
  return (
    <main className="page detail-page">
      <section className="detail-heading">
        <div><span className="detail-overline">KNOWLEDGE / ORGANIZATION SCOPE</span><h1>组织知识资产</h1><p>沉淀经过验证的经验、可执行 Skill 和受控 Tool，并绑定固定版本与证据链。</p></div>
        {missionContext && <div className="detail-actions"><button className="ghost-action" onClick={() => setView('mission')}>返回任务总览</button></div>}
      </section>

      <section className="knowledge-scale-band">
        <div className="knowledge-scale-lead"><span>ORGANIZATION CORPUS</span><strong>68</strong><small>跨项目可复用资产</small></div>
        <div><span>已验证</span><strong>52</strong><small>76% validation coverage</small></div>
        <div><span>证据引用</span><strong>326</strong><small>Run / Mission citations</small></div>
        <div><span>平台覆盖</span><strong>11</strong><small>C500 · CUDA · ROCm 等</small></div>
        <div><span>近 30 天新增</span><strong>+14</strong><small>6 位维护者贡献</small></div>
      </section>

      <section className="hardware-guide-band">
        <div className="hardware-guide-heading">
          <div><span>HARDWARE PLAYBOOKS</span><strong>硬件经验准则</strong></div>
          <div className="hardware-guide-meta"><small>按架构、Runtime 与编译栈限制知识适用边界</small><button onClick={() => setCoverageOpen((value) => !value)}>{coverageOpen ? '收起覆盖矩阵' : '查看覆盖矩阵'}<ChevronDown size={13} className={coverageOpen ? 'open' : ''} /></button></div>
        </div>
        <div className="hardware-guide-options">{hardwareOptions.map((option) => <button key={option.value} className={`${hardwareFilter === option.value ? 'active' : ''} ${option.value === 'c500' ? 'featured' : ''}`} onClick={() => setHardwareFilter(option.value)}><PlatformMark platform={option.value} /><span className="hardware-option-copy"><span>{option.vendor}</span><strong>{option.label}</strong><small>{option.note}</small></span><em>{option.count}<small> assets</small></em></button>)}</div>
        {coverageOpen && <div className="hardware-coverage" aria-label="硬件能力覆盖矩阵">
          <div className="hardware-coverage-head"><span>能力覆盖</span><span><PlatformMark platform="c500" />沐曦 C500</span><span><PlatformMark platform="nvidia" />CUDA GPU</span><span><PlatformMark platform="amd" />MI300 / ROCm</span></div>
          {capabilityCoverage.map((row) => <div className="hardware-coverage-row" key={row.capability}><span><strong>{row.capability}</strong><small>{row.note}</small></span>{['c500', 'nvidia', 'amd'].map((key) => <span key={key} className={row[key][1]}>{row[key][1] === 'verified' ? <CheckCircle2 size={14} /> : <CircleDot size={14} />}<strong>{row[key][0]}</strong><small>{row[key][1] === 'verified' ? '已验证' : '部分覆盖'}</small></span>)}</div>)}
          <div className="hardware-coverage-foot"><ShieldCheck size={14} /><span>统计基于固定版本资产及其有效证据引用，不以目录条目数量替代能力成熟度。</span></div>
        </div>}
      </section>

      <section className="knowledge-search"><Search size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="知识检索" placeholder="输入算子、平台、瓶颈或资产名称" /><kbd>⌘ Enter</kbd><button aria-label="筛选" className={filterOpen ? 'active' : ''} onClick={() => setFilterOpen((value) => !value)}><Filter size={17} /></button></section>
      {filterOpen && <div className="knowledge-filter-bar"><span>资产类型</span>{typeOptions.map(([value, label, count]) => <button key={value} className={typeFilter === value ? 'active' : ''} onClick={() => setTypeFilter(value)}>{label}<em>{count}</em></button>)}<div className="filter-assurance"><ShieldCheck size={13} /> 固定版本优先</div></div>}

      <section className="knowledge-layout library-only">
        <div className="knowledge-list">
          <div className="list-caption"><span>{visibleAssets.length} 个样例资产 · {activeHardwareLabel}</span><em>Hardware-aware rerank</em></div>
          {visibleAssets.map((asset) => {
            const AssetIcon = asset.icon;
            const assetHardware = getHardwareKeys(asset);
            const hardwareMeta = assetHardware.map((key) => ({ c500: 'C500', nvidia: 'CUDA', amd: 'ROCm' }[key])).join(' / ');
            return <article className={`knowledge-row ${asset.referenced ? 'featured' : ''}`} key={asset.id}>
              <span className={`knowledge-type ${asset.tone}`}><AssetIcon size={18} /></span>
              <div><div className="asset-meta">{asset.kind.toUpperCase()} · {asset.version} · {hardwareMeta} · VALIDATED</div><h2>{asset.title}</h2><p>{asset.description}</p><div className="asset-tags">{asset.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></div>
              <button className={asset.referenced ? 'asset-status' : 'asset-open'} aria-label={`打开 ${asset.kind}：${asset.title}`} onClick={() => onOpenModal('asset', { ...asset, hardwareLabel: assetHardware.map((key) => hardwareLabels[key]).join(' · ') })}>{asset.referenced ? <><Check size={14} /> 当前任务引用</> : <ArrowRight size={16} />}</button>
            </article>;
          })}
          {visibleAssets.length === 0 && <div className="knowledge-empty"><Search size={25} /><strong>未找到匹配资产</strong><span>尝试缩短关键词或切换资产类型。</span><button onClick={() => { setQuery(''); setTypeFilter('all'); setHardwareFilter('all'); }}>清除筛选</button></div>}
        </div>

      </section>
    </main>
  );
}

function Dialog({ title, eyebrow, children, onClose, width = '520px' }) {
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ '--dialog-width': width }} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-header"><div><span>{eyebrow || 'OPERATOR STUDIO'}</span><h2>{title}</h2></div><button aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
        <div className="dialog-body">{children}</div>
      </section>
    </div>
  );
}

function SearchDialog({ onClose, onNavigate }) {
  const [query, setQuery] = useState('');
  const results = [
    { view: 'mission', icon: Grid2X2, title: '优化任务详情', meta: 'Mission · MIS_01JH7R' },
    { view: 'iterations', icon: History, title: 'MLA Paged KV Cache 迭代详情', meta: '4 candidates · current best cnd.02' },
    { view: 'code', icon: Code2, title: 'Async plan descriptor cache', meta: 'Code · Candidate 02' },
    { view: 'experiments', icon: TestTube2, title: '跨环境验证', meta: 'Test plan · TPL_01JH7R' },
    { view: 'knowledge', icon: BookOpen, title: '短序列下优先量化固定开销', meta: 'Experience · validated' },
  ];
  const visible = results.filter((result) => !query.trim() || `${result.title} ${result.meta}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Dialog title="全局搜索" eyebrow="WORKSPACE SEARCH" onClose={onClose} width="600px">
      <div className="dialog-search"><Search size={17} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、代码、实验或知识资产" /><kbd>ESC</kbd></div>
      <div className="dialog-results">{visible.map(({ view, icon: Icon, title, meta }) => <button key={title} className="dialog-result" onClick={() => onNavigate(view)}><span><Icon size={17} /></span><div><strong>{title}</strong><small>{meta}</small></div><ArrowRight size={15} /></button>)}{visible.length === 0 && <div className="dialog-empty">没有匹配的工作区内容</div>}</div>
      <div className="dialog-footnote"><Search size={13} /> 支持 Mission ID、候选名称、环境名称和 Experience 关键词。</div>
    </Dialog>
  );
}

function MatrixEditor({ onClose, initialValue, onSave }) {
  const [environments, setEnvironments] = useState(initialValue?.environments || ['C500', 'CUDA']);
  const [stages, setStages] = useState(initialValue?.stages || ['Correctness', 'Probe', 'Full Benchmark']);
  const toggle = (list, value, setter) => setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  return (
    <Dialog title="编辑测试矩阵" eyebrow="TEST PLAN · TPL_01JH7R" onClose={onClose} width="560px">
      <div className="editor-section"><span className="dialog-label">执行环境</span><div className="check-grid">{['C500', 'CUDA', 'ROCm MI300'].map((item) => <label key={item} className={`check-item ${item === 'ROCm MI300' ? 'disabled' : ''}`}><input type="checkbox" checked={environments.includes(item)} disabled={item === 'ROCm MI300'} onChange={() => toggle(environments, item, setEnvironments)} /><span>{item}</span><small>{item === 'ROCm MI300' ? 'offline' : 'online'}</small></label>)}</div></div>
      <div className="editor-section"><span className="dialog-label">验证阶段</span><div className="check-grid">{['Correctness', 'Probe', 'Full Benchmark'].map((item) => <label key={item} className="check-item"><input type="checkbox" checked={stages.includes(item)} onChange={() => toggle(stages, item, setStages)} /><span>{item}</span></label>)}</div></div>
      <div className="matrix-summary"><span>将创建 {environments.length * stages.length} 个 Test Task</span><small>Correctness Gate 会阻止未通过候选进入性能阶段。</small></div>
      <div className="dialog-actions"><button className="ghost-action" onClick={onClose}>取消</button><button className="primary-action" disabled={!environments.length || !stages.length} onClick={() => { onSave({ environments, stages }); onClose(); }}>保存矩阵</button></div>
    </Dialog>
  );
}

function KnowledgeEvidenceDrawer({ onClose, onNavigate, notify }) {
  const [selected, setSelected] = useState(missionKnowledge[0]);
  const Icon = selected.icon;
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="knowledge-drawer" role="dialog" aria-modal="true" aria-label="知识依据" onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header">
          <div><span>MISSION CONTEXT · MIS_01JH7R</span><h2>知识依据</h2></div>
          <button aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </header>
        <div className="drawer-body">
          <section className="evidence-summary">
            <div className="evidence-summary-title"><div><span className="drawer-overline">本次判断由以下资产支持</span><strong>缓存 plan descriptor，并将 host mirror 移出热路径</strong></div><span className="verified-badge"><CheckCircle2 size={14} /> 已验证</span></div>
            <p>系统只展示和当前 Mission、候选补丁及运行环境直接相关的知识，长文档与原始日志保留在知识库中。</p>
            <div className="evidence-stat-grid"><div><strong>3</strong><span>引用资产</span></div><div><strong>2</strong><span>关联 Run</span></div><div><strong>100%</strong><span>固定版本</span></div></div>
          </section>

          <div className="knowledge-drawer-layout">
            <nav className="drawer-asset-list" aria-label="关联知识资产">
              <span className="drawer-section-label">关联资产</span>
              {missionKnowledge.map((item) => {
                const AssetIcon = item.icon;
                return <button key={item.source} className={selected.source === item.source ? 'selected' : ''} onClick={() => setSelected(item)}><span className={`drawer-asset-icon ${item.tone}`}><AssetIcon size={15} /></span><span><strong>{item.shortTitle}</strong><small>{item.kind} · {item.version}</small></span><ChevronRight size={14} /></button>;
              })}
            </nav>
            <section className="drawer-asset-detail">
              <div className="drawer-detail-type"><span className={`drawer-asset-icon ${selected.tone}`}><Icon size={16} /></span><span>{selected.kind.toUpperCase()} · {selected.version}</span></div>
              <h3>{selected.title}</h3>
              <p>{selected.reason}</p>
              <dl><div><dt>适用范围</dt><dd>{selected.scope}</dd></div><div><dt>证据状态</dt><dd>{selected.evidence}</dd></div><div><dt>来源标识</dt><dd>{selected.source}</dd></div></dl>
              <div className="drawer-detail-note"><ShieldCheck size={14} /><span>此资产已通过组织验证，仅允许授权 Mission 引用。</span></div>
            </section>
          </div>
        </div>
        <footer className="drawer-footer"><button className="ghost-action" onClick={() => { copyText(selected.source).then(() => notify('知识引用标识已复制。')); }}>复制引用</button><button className="primary-action" onClick={() => { onNavigate(); onClose(); }}>进入知识库 <ArrowRight size={14} /></button></footer>
      </aside>
    </div>
  );
}

function IterationDetailDrawer({ iteration, onClose, onNavigate, notify }) {
  const baseline = operatorIterations[0];
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <aside className="iteration-detail-drawer" role="dialog" aria-modal="true" aria-label={`${iteration.label} 迭代详情`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header"><div><span>OPERATOR ITERATION · {iteration.version}</span><h2>{iteration.label}</h2></div><button aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
        <div className="iteration-drawer-body">
          <section className="iteration-drawer-summary">
            <div><span className={`iteration-status ${iteration.tone}`}>{iteration.status}</span><h3>{iteration.title}</h3><p>{iteration.hypothesis}</p></div>
            <div className="iteration-drawer-delta"><span>相对基线</span><strong>{iteration.delta}</strong><small>{iteration.c500}μs on C500</small></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><Gauge size={16} /><strong>跨硬件结果</strong></div>
            <div className="iteration-result-grid"><div><span>C500</span><small>{baseline.c500}μs baseline</small><strong>{iteration.c500}μs</strong></div><div><span>CUDA A100</span><small>{baseline.cuda}μs baseline</small><strong>{iteration.cuda ? `${iteration.cuda}μs` : 'Running'}</strong></div><div><span>Correctness</span><small>required 24 / 24</small><strong>{iteration.correctness}</strong></div></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><Code2 size={16} /><strong>优化假设与变更</strong></div>
            <div className="iteration-change-box"><p>{iteration.change}</p><span><GitBranch size={13} /> {iteration.files}</span></div>
          </section>

          <section className="iteration-detail-section">
            <div className="iteration-detail-heading"><ShieldCheck size={16} /><strong>证据与决策</strong></div>
            <div className={`iteration-decision-box ${iteration.tone}`}><div><span>DECISION</span><strong>{iteration.decision}</strong></div><p>{iteration.decisionReason}</p><small>{iteration.evidence}</small></div>
          </section>

          <section className="iteration-linked-knowledge"><BookOpen size={16} /><div><span>关联知识资产</span><strong>{iteration.knowledge}</strong></div><ChevronRight size={15} /></section>
        </div>
        <footer className="drawer-footer"><button className="ghost-action" onClick={() => { copyText(`${iteration.label}: ${iteration.hypothesis}\n${iteration.decision}`); notify(`${iteration.label} 摘要已复制。`); }}>复制摘要</button><button className="ghost-action" onClick={() => { onNavigate('experiments'); onClose(); }}>查看验证</button><button className="primary-action" onClick={() => { onNavigate('code'); onClose(); }}>查看代码 <ArrowRight size={14} /></button></footer>
      </aside>
    </div>
  );
}

function ModalLayer({ modal, closeModal, setView, notify, testMatrix, onSaveMatrix, unreadCount, onMarkNotifications, workspace, onWorkspaceChange, missionPaused, onTogglePause, auditEvents }) {
  if (!modal) return null;
  if (modal.type === 'search') return <SearchDialog onClose={closeModal} onNavigate={(view) => { setView(view); closeModal(); }} />;
  if (modal.type === 'matrix') return <MatrixEditor onClose={closeModal} initialValue={testMatrix} onSave={(value) => { onSaveMatrix(value); notify(`测试矩阵已更新：${value.environments.length} 个环境，${value.stages.length} 个阶段。`); }} />;
  if (modal.type === 'knowledgeEvidence') return <KnowledgeEvidenceDrawer onClose={closeModal} onNavigate={() => setView('knowledge')} notify={notify} />;
  if (modal.type === 'iterationDetail') return <IterationDetailDrawer iteration={modal.iteration} onClose={closeModal} onNavigate={setView} notify={notify} />;
  if (modal.type === 'notifications') return <Dialog title="通知中心" eyebrow="NOTIFICATIONS" onClose={closeModal} width="460px"><div className="notification-list"><div className={unreadCount > 0 ? 'unread' : ''}><span className="notification-dot blue" /><p><strong>Candidate 02 等待你的审批</strong><small>Mission MIS_01JH7R · 3 分钟前</small></p><em>{unreadCount > 0 ? '待处理' : '已读'}</em></div><div><span className="notification-dot green" /><p><strong>C500 Worker 已完成 Correctness</strong><small>Test task tsk.c500-prod-01 · 18 分钟前</small></p><em>已读</em></div><div><span className="notification-dot gray" /><p><strong>Profile timeline Tool 发布新版本</strong><small>v1.8.0 · 昨天</small></p><em>已读</em></div></div><div className="dialog-actions"><button className="ghost-action" disabled={!unreadCount} onClick={() => { onMarkNotifications(); notify('通知已全部标记为已读。'); }}>全部标记已读</button><button className="primary-action" onClick={closeModal}>完成</button></div></Dialog>;
  if (modal.type === 'workspace') return <Dialog title="切换工作区" eyebrow="ORGANIZATION" onClose={closeModal} width="420px"><div className="workspace-list"><button className={workspace === 'Matrix Lab' ? 'selected' : ''} onClick={() => { onWorkspaceChange('Matrix Lab'); closeModal(); }}><span>M</span><div><strong>Matrix Lab</strong><small>研发组织 · {workspace === 'Matrix Lab' ? '当前工作区' : '切换至此工作区'}</small></div>{workspace === 'Matrix Lab' ? <Check size={16} /> : <ArrowRight size={15} />}</button><button className={workspace === 'Tensor Lab' ? 'selected' : ''} onClick={() => { onWorkspaceChange('Tensor Lab'); closeModal(); }}><span>T</span><div><strong>Tensor Lab</strong><small>模型推理实验组 · {workspace === 'Tensor Lab' ? '当前工作区' : '可切换'}</small></div>{workspace === 'Tensor Lab' ? <Check size={16} /> : <ExternalLink size={15} />}</button><button onClick={() => notify('加入其他工作区需要组织管理员邀请。')}><span>+</span><div><strong>加入其他工作区</strong><small>需要组织管理员邀请</small></div><ArrowRight size={15} /></button></div></Dialog>;
  if (modal.type === 'user') return <Dialog title="个人中心" eyebrow="ACCOUNT" onClose={closeModal} width="420px"><div className="profile-detail"><span className="profile-large">YL</span><div><strong>Yilin Lu</strong><span>算子工程师 · Matrix Lab</span><small>yilin.lu@matrix-lab.example</small></div></div><div className="profile-menu"><button onClick={() => { notify('个人偏好已打开。'); closeModal(); }}><Settings2 size={16} /> 个人偏好 <ChevronRight size={15} /></button><button onClick={() => { notify('已复制当前用户 ID。'); closeModal(); }}><Copy size={16} /> 复制用户 ID <ChevronRight size={15} /></button><button className="danger" onClick={() => { notify('退出登录需通过组织身份中心完成。'); closeModal(); }}><LogOut size={16} /> 退出登录 <ChevronRight size={15} /></button></div></Dialog>;
  if (modal.type === 'missionActions') return <Dialog title="任务操作" eyebrow="MISSION MIS_01JH7R" onClose={closeModal} width="430px"><div className="action-list"><button onClick={() => { copyText('MIS_01JH7R').then(() => notify('Mission ID 已复制。')); closeModal(); }}><Copy size={16} /><div><strong>复制 Mission ID</strong><small>用于问题反馈或工程协作</small></div><ChevronRight size={15} /></button><button onClick={() => { downloadText('MIS_01JH7R-summary.txt', 'Mission MIS_01JH7R\nCandidate 02 · 41.8μs · Level 3\nC500 + CUDA · 24/24 correctness'); notify('任务摘要已下载。'); closeModal(); }}><Download size={16} /><div><strong>导出任务摘要</strong><small>包含候选、运行和证据结论</small></div><ChevronRight size={15} /></button><button onClick={() => { onTogglePause(); notify(missionPaused ? 'Mission 已恢复，可继续提交操作。' : 'Mission 已暂停，新的 Agent Action 与测试提交已停止。'); closeModal(); }}><Pause size={16} /><div><strong>{missionPaused ? '恢复 Mission' : '暂停 Mission'}</strong><small>切换新的 Agent Action 与测试提交</small></div><ChevronRight size={15} /></button></div></Dialog>;
  if (modal.type === 'events') return <Dialog title="事件记录" eyebrow="AUDIT TRAIL · MIS_01JH7R" onClose={closeModal} width="640px"><div className="event-log">{(auditEvents?.length ? auditEvents : [{ time: '10:42:23', title: 'Policy Engine 等待代码审批', detail: 'approval.apl_01JH7R · patch apply', tone: 'warning', icon: ShieldCheck }, { time: '10:42:19', title: 'Candidate Agent 生成 Candidate 02', detail: '2 files · +37 −18 · digest recorded', tone: 'blue', icon: Code2 }, { time: '10:42:11', title: 'Research Agent 引用固定开销 Experience', detail: 'exp.short-seq.fixed-overhead@1.2 · validated', tone: 'green', icon: Search }]).map((event) => { const iconMap = { Activity, ShieldCheck, Code2, Search, CheckCircle2, TestTube2, TriangleAlert, BookOpen }; const EventIcon = typeof event.icon === 'string' ? (iconMap[event.icon] || Activity) : (event.icon || Activity); return <div key={`${event.time}-${event.title}`}><time>{event.time}</time><span className={`event-symbol ${event.tone || 'blue'}`}><EventIcon size={14} /></span><p><strong>{event.title}</strong><small>{event.detail}</small></p></div>; })}</div></Dialog>;
  if (modal.type === 'stageDetail') return <Dialog title={`${modal.stage.label}阶段`} eyebrow={`STAGE ${modal.stage.number} · ${modal.state}`} onClose={closeModal} width="430px"><div className="stage-detail"><div className="stage-detail-icon"><CheckCircle2 size={22} /></div><h3>{modal.stage.caption}</h3><p>{modal.state === '已完成' ? '该阶段已满足进入下一阶段的条件，相关事件和产物已写入 Mission 审计链。' : modal.state === '进行中' ? 'Agent 正在执行当前阶段动作，完成后会产生新的可审查产物。' : '该阶段尚未开始，前置证据完成后才会自动解锁。'}</p><div className="stage-detail-meta"><span>状态</span><strong>{modal.state}</strong><span>输出</span><strong>{modal.stage.id === 'validation' ? 'Test Plan / Run' : modal.stage.id === 'evidence' ? 'Decision Report' : 'Agent Action'}</strong></div></div></Dialog>;
  if (modal.type === 'editorActions') return <Dialog title="编辑器操作" eyebrow="CODE REVIEW" onClose={closeModal} width="390px"><div className="action-list"><button onClick={() => { copyText('diff --git a/kernels/paged_attention.cu b/kernels/paged_attention.cu\n+auto& plan = plan_cache.get_or_build(args.signature());').then(() => notify('Patch 内容已复制。')); closeModal(); }}><Copy size={16} /><div><strong>复制 Patch</strong><small>复制当前候选的 unified diff</small></div><ChevronRight size={15} /></button><button onClick={() => { downloadText('candidate-02.diff', 'diff --git a/kernels/paged_attention.cu b/kernels/paged_attention.cu\n+auto& plan = plan_cache.get_or_build(args.signature());'); notify('Diff 摘要已下载。'); closeModal(); }}><Download size={16} /><div><strong>下载 Diff 摘要</strong><small>用于离线审查和工程对接</small></div><ChevronRight size={15} /></button><button onClick={() => { setView('experiments'); closeModal(); }}><FileText size={16} /><div><strong>查看关联测试</strong><small>tests/paged_attention_cases.yaml</small></div><ChevronRight size={15} /></button></div></Dialog>;
  if (modal.type === 'asset') return <Dialog title={modal.title} eyebrow={`${modal.kind} · ${modal.version}`} onClose={closeModal} width="680px"><div className="asset-detail"><div className="asset-detail-head"><CheckCircle2 size={18} /><span>已通过组织验证 · 固定版本</span></div><p>{modal.description || '该资产已绑定适用范围与证据引用，可由授权 Mission 检索和复用。'}</p><div className="asset-evidence"><div className="asset-evidence-title"><span>EVIDENCE LINEAGE</span><strong>资产证据链</strong><em>可审计 · 可复现</em></div><div className="asset-evidence-flow"><div><i>01</i><span><small>ENVIRONMENT</small><strong>C500 Production 01</strong><em>snapshot · sha256:8f3a</em></span></div><ArrowRight size={15} /><div><i>02</i><span><small>TEST RUN</small><strong>run_01JH8T</strong><em>24 / 24 correctness</em></span></div><ArrowRight size={15} /><div><i>03</i><span><small>DECISION</small><strong>Candidate 02</strong><em>adopted · Level 3</em></span></div><ArrowRight size={15} /><div><i>04</i><span><small>KNOWLEDGE</small><strong>{modal.kind}</strong><em>{modal.version} · fixed</em></span></div></div></div><dl><div><dt>适配硬件</dt><dd>{modal.hardwareLabel || '沐曦 MetaX C500 · NVIDIA CUDA · AMD ROCm'}</dd></div><div><dt>适用范围</dt><dd>{modal.scope || 'C500 · CUDA · ROCm'}</dd></div><div><dt>执行权限</dt><dd>{modal.permissions || 'organization:read'}</dd></div><div><dt>验证记录</dt><dd>{modal.evidence || '2 Run citations · Level 3'}</dd></div><div><dt>最近更新</dt><dd>{modal.updated || '2026-08-03'}</dd></div></dl><div className="asset-detail-actions"><button className="ghost-action" onClick={() => { copyText(modal.id || modal.title).then(() => notify('资产标识已复制。')); }}>复制资产 ID</button><button className="primary-action" onClick={closeModal}>完成</button></div></div></Dialog>;
  if (['repository', 'environments', 'settings'].includes(modal.type)) {
    const content = {
      repository: { title: '仓库管理', eyebrow: 'PROJECT SETTINGS', icon: FolderGit2, heading: 'mla-kernels', text: '当前已连接本地 Git 仓库，分支与未提交修改会在候选应用前受到保护。', rows: [['分支', 'feat/async-plan-cache'], ['最近同步', '2 分钟前'], ['工作区状态', 'clean']] },
      environments: { title: '执行环境', eyebrow: 'EXECUTION CLOUD', icon: Cpu, heading: '2 个 Worker 在线', text: '调度器会按环境指纹路由 Test Task，历史 Run 不会被环境升级覆盖。', rows: [['C500 Production 01', 'online · mxmaca 1.4.0'], ['CUDA A100 Reference', 'online · cuda 3.2.1'], ['ROCm MI300', 'offline · adapter not registered']] },
      settings: { title: '项目设置', eyebrow: 'PROJECT POLICY', icon: Settings2, heading: 'Matrix Lab / mla-kernels', text: '这里的设置影响审批策略、资源配额和可见性边界。', rows: [['Adoption policy', 'human approval'], ['Full Benchmark', 'requires approval'], ['Visibility', 'organization']] },
    }[modal.type];
    const Icon = content.icon;
    return <Dialog title={content.title} eyebrow={content.eyebrow} onClose={closeModal} width="500px"><div className="info-dialog"><div className="info-dialog-icon"><Icon size={21} /></div><h3>{content.heading}</h3><p>{content.text}</p><dl>{content.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><button className="primary-action" onClick={() => { notify(`${content.title}已刷新。`); closeModal(); }}>刷新状态</button></div></Dialog>;
  }
  return null;
}

function Toast({ children }) {
  return <div className="toast"><CheckCircle2 size={16} /> {children}</div>;
}

export default function App() {
  const [view, setView] = useState('mission');
  const [stage, setStage] = useState('candidate');
  const [missionContext, setMissionContext] = useState(true);
  const [toast, setToast] = useState('');
  const [modal, setModal] = useState(null);
  const [workspace, setWorkspace] = useState('Matrix Lab');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(2);
  const [missionPaused, setMissionPaused] = useState(false);
  const [patchApplied, setPatchApplied] = useState(false);
  const [benchmarkStatus, setBenchmarkStatus] = useState('idle');
  const [benchmarkProgress, setBenchmarkProgress] = useState(0);
  const [benchmarkLogs, setBenchmarkLogs] = useState([]);
  const [testMatrix, setTestMatrix] = useState({ environments: ['C500', 'CUDA'], stages: ['Correctness', 'Probe', 'Full Benchmark'] });
  const [knowledgeDraftsState, setKnowledgeDraftsState] = useState(defaultKnowledgeDrafts);
  const [publishedAssets, setPublishedAssets] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [workspaceFilesState, setWorkspaceFilesState] = useState([]);
  const [backendStatus, setBackendStatus] = useState('connecting');
  const [backendError, setBackendError] = useState('');
  const draftSaveTimers = useRef({});
  const knowledgeDraftsRef = useRef(defaultKnowledgeDrafts);

  const openModal = (type, data = {}) => setModal({ type, ...data });
  const closeModal = () => setModal(null);
  const notify = (message) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  };
  const applyBackendState = (state) => {
    if (!state) return;
    if (state.stage) setStage(state.stage);
    if (typeof state.patchApplied === 'boolean') setPatchApplied(state.patchApplied);
    if (state.benchmark) {
      setBenchmarkStatus(state.benchmark.status);
      setBenchmarkProgress(state.benchmark.progress || 0);
      setBenchmarkLogs(state.benchmark.logs || []);
    }
    if (state.testMatrix) setTestMatrix(state.testMatrix);
    if (Array.isArray(state.knowledgeDrafts)) {
      setKnowledgeDraftsState(state.knowledgeDrafts);
      knowledgeDraftsRef.current = state.knowledgeDrafts;
    }
    if (Array.isArray(state.publishedAssets)) setPublishedAssets(state.publishedAssets.map((asset) => ({ ...asset, icon: typeof asset.icon === 'string' ? Lightbulb : (asset.icon || Lightbulb) })));
    if (state.workspace) setWorkspace(state.workspace);
    if (typeof state.unreadCount === 'number') setUnreadCount(state.unreadCount);
    if (typeof state.missionPaused === 'boolean') setMissionPaused(state.missionPaused);
    if (Array.isArray(state.auditEvents)) setAuditEvents(state.auditEvents);
  };

  const requestBackend = async (path, options = {}, silent = false) => {
    try {
      const result = await apiRequest(path, options);
      setBackendStatus('online');
      setBackendError('');
      if (result.state) applyBackendState(result.state);
      return result;
    } catch (error) {
      if (error.status) {
        setBackendStatus('online');
        setBackendError('');
      } else {
        setBackendStatus('offline');
        setBackendError(error.message);
      }
      if (!silent) notify(error.message);
      return null;
    }
  };

  const navigateMission = (nextView) => { setMissionContext(true); setView(nextView); };
  const navigateAny = (nextView) => { setMissionContext(nextView !== 'knowledge'); setView(nextView); };
  const openMissionStep = (item) => { setMissionContext(true); setView(item.view); notify(`已进入任务阶段：${item.label}`); };
  const navigateGlobal = (target) => {
    if (target === 'knowledge') { setMissionContext(false); setView('knowledge'); return; }
    setMissionContext(true); setView('mission');
  };
  const handleMissionAction = () => {
    if (stage === 'diagnosis') navigateMission('iterations');
    else if (stage === 'candidate') navigateMission('code');
    else if (stage === 'validation') navigateMission('experiments');
    else if (stage === 'evidence') navigateMission('decision');
    else navigateMission('curation');
  };
  const applyPatch = async () => {
    if (missionPaused || patchApplied) return;
    const result = await requestBackend('/api/actions/apply-patch', { method: 'POST', body: JSON.stringify({ candidate: 'candidate-02' }) });
    if (!result) return;
    if (result.workspace?.files) setWorkspaceFilesState(result.workspace.files);
    navigateMission('experiments');
    notify('补丁已写入隔离工作区，异构测试矩阵已准备运行。');
  };
  const runBenchmark = async () => {
    if (missionPaused || benchmarkStatus === 'running' || benchmarkStatus === 'complete') return;
    const result = await requestBackend('/api/actions/start-benchmark', { method: 'POST', body: JSON.stringify({ matrix: testMatrix }) });
    if (!result) return;
    navigateMission('experiments');
    notify('测试矩阵已提交，正在收集跨环境结果。');
  };
  const adoptCandidate = async (candidate, note) => {
    if (missionPaused) return;
    const result = await requestBackend('/api/actions/adopt', { method: 'POST', body: JSON.stringify({ candidate: candidate.id, note }) });
    if (!result) return;
    navigateMission('curation');
    notify('候选已采用，已生成知识沉淀草稿。');
  };
  const rejectCandidate = async (candidate) => {
    if (missionPaused) return;
    const result = await requestBackend('/api/actions/reject', { method: 'POST', body: JSON.stringify({ candidate: candidate.id }) });
    if (!result) return;
    navigateMission('experiments');
    notify('候选已退回验证阶段。');
  };
  const updateKnowledgeDraft = (draftId, patch) => {
    const current = knowledgeDraftsRef.current.find((draft) => draft.id === draftId);
    if (!current) return;
    const updated = { ...current, ...patch };
    const nextDrafts = knowledgeDraftsRef.current.map((draft) => draft.id === draftId ? updated : draft);
    knowledgeDraftsRef.current = nextDrafts;
    setKnowledgeDraftsState(nextDrafts);
    window.clearTimeout(draftSaveTimers.current[draftId]);
    draftSaveTimers.current[draftId] = window.setTimeout(() => {
      requestBackend(`/api/knowledge/drafts/${encodeURIComponent(draftId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
    }, 450);
  };
  const publishKnowledge = async (draft) => {
    const result = await requestBackend('/api/knowledge/publish', { method: 'POST', body: JSON.stringify(draft) });
    if (result) notify(`“${draft.title}”已发布到组织知识库。`);
  };
  const publishAllKnowledge = async (drafts) => {
    const result = await requestBackend('/api/knowledge/publish-all', { method: 'POST', body: JSON.stringify({ drafts }) });
    if (result) notify(`${drafts.length} 条经验已全部发布到组织知识库。`);
  };
  const updateMatrix = (value) => { setTestMatrix(value); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ testMatrix: value }) }); };
  const togglePause = () => { const next = !missionPaused; setMissionPaused(next); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ missionPaused: next }) }); };
  const markNotificationsRead = () => { setUnreadCount(0); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ unreadCount: 0 }) }); };
  const changeWorkspace = (value) => { setWorkspace(value); requestBackend('/api/state', { method: 'PATCH', body: JSON.stringify({ workspace: value }) }); notify(`已切换到 ${value}。`); };

  useEffect(() => {
    let mounted = true;
    const sync = async () => {
      try {
        const stateResult = await apiRequest('/api/state');
        const workspaceResult = await apiRequest('/api/workspace');
        if (!mounted) return;
        setBackendStatus('online'); setBackendError('');
        applyBackendState(stateResult.state);
        setWorkspaceFilesState(workspaceResult.files || []);
      } catch (error) {
        if (mounted) { setBackendStatus('offline'); setBackendError(error.message); }
      }
    };
    sync();
    return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (benchmarkStatus !== 'running') return undefined;
    const timer = window.setInterval(() => requestBackend('/api/state', {}, true), 420);
    return () => window.clearInterval(timer);
  }, [benchmarkStatus]);
  useEffect(() => {
    if (benchmarkStatus === 'complete' && stage === 'evidence' && view === 'experiments') {
      navigateMission('decision');
      notify('Full Benchmark 完成，已生成 Level 3 证据。');
    }
  }, [benchmarkStatus, stage, view]);
  useEffect(() => () => Object.values(draftSaveTimers.current).forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    const handleKeyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openModal('search'); }
      if (event.key === 'Escape') closeModal();
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  const publishedKnowledgeIds = new Set(publishedAssets.map((asset) => asset.id));
  const effectiveCatalog = [...publishedAssets, ...knowledgeCatalog.filter((asset) => !publishedKnowledgeIds.has(asset.id))];
  let content;
  if (view === 'iterations') content = <IterationsView setView={navigateMission} onOpenModal={openModal} />;
  else if (view === 'code') content = <CodeView patchApplied={patchApplied} workspaceFiles={workspaceFilesState} onApplyPatch={applyPatch} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'experiments') content = <ExperimentsView benchmarkStatus={benchmarkStatus} benchmarkProgress={benchmarkProgress} benchmarkLogs={benchmarkLogs} testMatrix={testMatrix} onRunBenchmark={runBenchmark} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'decision') content = <DecisionView stage={stage} onAdopt={adoptCandidate} onReject={rejectCandidate} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'curation') content = <CurationView stage={stage} drafts={knowledgeDraftsState} publishedAssets={publishedAssets} onUpdateDraft={updateKnowledgeDraft} onPublish={publishKnowledge} onPublishAll={publishAllKnowledge} onViewLibrary={() => navigateGlobal('knowledge')} onOpenModal={openModal} paused={missionPaused} />;
  else if (view === 'knowledge') content = <KnowledgeView catalog={effectiveCatalog} setView={navigateMission} onOpenModal={openModal} missionContext={missionContext} />;
  else content = <MissionView stage={stage} onAdvance={handleMissionAction} setView={navigateMission} onOpenModal={openModal} paused={missionPaused} />;

  return (
    <>
      <AppShell view={view} stage={stage} missionContext={missionContext} workspace={workspace} unreadCount={unreadCount} mobileNavOpen={mobileNavOpen} missionPaused={missionPaused} backendStatus={backendStatus} backendError={backendError} onToggleMobileNav={setMobileNavOpen} onGlobalNavigate={navigateGlobal} onMissionStep={openMissionStep} onOpenModal={openModal}>
        {content}
      </AppShell>
      <ModalLayer modal={modal} closeModal={closeModal} setView={navigateAny} notify={notify} testMatrix={testMatrix} onSaveMatrix={updateMatrix} unreadCount={unreadCount} onMarkNotifications={markNotificationsRead} workspace={workspace} onWorkspaceChange={changeWorkspace} missionPaused={missionPaused} onTogglePause={togglePause} auditEvents={auditEvents} />
      {toast && <Toast>{toast}</Toast>}
    </>
  );
}

/**
 * monitor 工具的模型可见面（计划 Task 6）：把 Monitor 链接到 DSH 的 tools 服务上。
 *
 * 三条宿主侧硬契约（本机真机实测）：
 * 1. `output.render` 必须返回**内容块数组** `[{type:'text',text}]` —— 宿主拿到 render 结果后直接
 *    做 `content.some(block => block.type === 'image')`，返回字符串会让整次工具调用崩。
 * 2. `parameters` 用 DSH **紧凑方言**（ParameterSchemaSpec）：`required: true` 是逐属性注解、
 *    object 节点必须显式写 `additionalProperties`；由 `defineTool` 归一成原生 JSON Schema
 *    （**不要手写原生 JSON Schema**）。
 * 3. render 必须是**全函数**：宿主把 render 的异常包成 ToolOutputError，于是一次**成功**的调用
 *    会变成工具失败 ⇒ 本文件的 render 一律退化成占位符，绝不抛。
 *
 * 冻结边界（Lead 裁定）：
 * - 输入一律走 `validateMonitorArgs(args, { config })` 归一；**钳制不在本模块做**（在 validate.js）。
 * - `clampNotes` **只透传**：本模块一行 notes 文案都不新增（由工具层拼）。
 * - `file`/`glob` 采样**必须**用注入的 `deps.read`（decision 用的同一个 reader）⇒ 本文件不再实现
 *    任何文件/glob 读取语义；缺 `deps.read` 时给出可行动报错，不静默退化。
 * - `decide` / `clock` / `sleep` / `notifier` 全部注入；测试一律注入假时钟（零真实墙钟）。
 * - 工具名取 `config.monitorToolName`，缺省 `monitor`；自递归防护由上游委托链负责，不在这里。
 *
 * @module dsh-decision-tools/monitor-tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import { createSources, runMonitor, startBackgroundMonitor, tailOf, probeProperty } from './monitor.js';
import { validateMonitorArgs, DecisionValidationError } from './validate.js';
import { DecisionSourceError } from './source.js';

/** 模型看到的工具名（可被 config.monitorToolName 覆盖）。 */
export const MONITOR_TOOL_DEFAULT_NAME = 'monitor';

const NL = String.fromCharCode(10);

/**
 * 常驻工具描述（注入预算 ≤1900 B，由 test/monitor-tool.test.mjs 守卫）。
 * 常驻成本要精打细算：机制细节住在 spec 与 skill 里，这里只留「是什么 / 怎么用 / 硬边界」。
 */
export const TOOL_DESCRIPTION = [
  'Wait for a condition to become true by repeatedly sampling a source and asking the local decision model.',
  'A probing wait primitive, not a scheduler: it samples on an interval, asks the model "has the event happened',
  'yet" against your rubric, counts every probe that comes back a hit, and returns once that count reaches',
  'countThreshold (or the deadline expires). Timestamps are recorded only — they never decide anything.',
  '',
  'Usage',
  '- source selects what to sample: {kind:"job"} tails a background job (omit id to watch the newest job of this',
  '  session); {kind:"file",path} and {kind:"glob",pattern} read workspace-relative text through the same reader',
  '  as decision; {kind:"command",argv} and {kind:"events",types} work when the deployment injects them.',
  '- Counting is level-based: every probe that answers a hit increments the counter. There is no debounce and no',
  '  cooldown window, so countThreshold:3 means roughly "hit on three probes".',
  '- rubric is the one shared criterion — write it once. hitThreshold (default 0.5) is the per-probe probability',
  '  that counts as a hit.',
  '- intervalMs is raised to the deployment floor; timeoutMs is the self-managed deadline (the host does not',
  '  preempt a blocking call), and a cancelled call returns early with the count accumulated so far.',
  '- background:true registers a host job and returns immediately with jobId; read it later with job_output.',
  '  notify:"inbox" also sends a notice when the threshold is reached (coalesced and rate-limited by the plugin).',
  '',
  'Hard boundaries',
  '- These are PROBABILITIES, not proof. Never let a hit be the only basis for a pass/allow decision.',
  '- On a hit the plugin NOTIFIES only: it never kills, retries, dispatches or cancels anything — that stays',
  '  your call.',
  '- The counter lives in memory only: it starts at 0 on every call and is lost when the host restarts.',
].join(NL);

/**
 * 参数契约（紧凑方言）。与 `MONITOR_LIMITS.allowedKeys` 一一对应：校验层拒绝的键这里不该出现，
 * 反之亦然（两端漂移由 test/monitor-tool.test.mjs 的键集守卫盯住）。
 */
export const PARAMETERS = {
  rubric: {
    type: 'string',
    required: true,
    description: 'The ONE shared criterion: what counts as "the target event has happened".',
  },
  source: {
    type: 'object',
    additionalProperties: false,
    required: true,
    description: 'What to sample on every probe.',
    properties: {
      kind: { type: 'string', required: true, enum: ['job', 'file', 'glob', 'command', 'events'], description: 'Source kind.' },
      id: { type: 'string', description: 'job: watch this job id (default: the newest job of this session).' },
      select: { type: 'string', enum: ['newest', 'oldest'], description: 'job: which job when id is omitted.' },
      jobKind: { type: 'string', description: 'job: only consider jobs of this kind.' },
      path: { type: 'string', description: 'file: workspace-relative path.' },
      startLine: { type: 'number', description: 'file: 1-based first line.' },
      endLine: { type: 'number', description: 'file: 1-based last line.' },
      pattern: { type: 'string', description: 'glob: workspace-relative pattern.' },
      limit: { type: 'number', description: 'glob: max files to read.' },
      argv: { type: 'array', items: { type: 'string' }, description: 'command: argv (needs deployment support).' },
      types: { type: 'array', items: { type: 'string' }, description: 'events: event names (needs deployment support).' },
    },
  },
  type: {
    type: 'string',
    enum: ['noul', 'choice', 'score'],
    description: 'Answer type the per-probe judgement uses (default noul).',
  },
  criteria: {
    description: 'choice: option to description. score: 2-10 levels, lowest to highest.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  hitThreshold: { type: 'number', description: 'Per-probe P(true) that counts as a hit (default 0.5).' },
  tailBytes: { type: 'number', description: 'Bytes read per probe (default 4096, hard cap 65536).' },
  mode: {
    type: 'string',
    enum: ['once', 'continuous'],
    description: 'once: return when the threshold is reached (default). continuous: keep watching until the deadline.',
  },
  intervalMs: { type: 'number', description: 'Probe interval (default 5000); raised to the deployment minimum.' },
  timeoutMs: { type: 'number', description: 'Self-managed deadline (default 120000); never smaller than intervalMs.' },
  background: { type: 'boolean', description: 'Register a host job and return jobId immediately.' },
  countThreshold: { type: 'number', description: 'How many hits must accumulate (default 1).' },
  notify: { type: 'string', enum: ['none', 'inbox'], description: 'inbox: send a notice when the threshold is reached.' },
  coalesce: { type: 'boolean', description: 'Merge same-kind notices (default true).' },
  maxNotificationsPerMinute: { type: 'number', description: 'Notice rate limit per minute (default 6).' },
};

/**
 * 返回值 schema（同样走紧凑方言）。`required: true` 只标**两个分支都必然返回**的键：
 * 后台分支没有 hit/count（那些要等作业跑完，从 job_output 取）。
 *
 * ⚠️ **本 schema 与 `execute` 的返回键必须逐键一致**，因为宿主 `createSuccessResult` 会对每个成功返回值跑
 * `validateJsonSchemaValue(tool.output.schema, value, "value")`，有 violation 就抛 ToolOutputError ——
 * 顶层是 `additionalProperties: false`，所以**少声明一个 execute 真会返回的键 = 每次成功都被当失败**。
 * 守卫：test/monitor-tool.test.mjs 用宿主自己的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue`
 * 跑「execute 产出值 vs 本 schema」，前台与后台两种形状都验。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    background: { type: 'boolean', required: true, description: 'true: a job was registered; read it with job_output.' },
    mode: { type: 'string', required: true, description: 'once | continuous.' },
    source: { type: 'json', required: true, description: 'The normalized sampling source.' },
    clampNotes: { type: 'array', items: { type: 'string' }, required: true, description: 'Clamp notices from the validator; the tool layer owns the final notes.' },
    notes: { type: 'array', items: { type: 'string' }, required: true, description: 'Model-facing notes (clamp notices unless the deployment composes them).' },
    jobId: { type: 'json', description: 'background only: the registered job id.' },
    hit: { type: 'boolean', description: 'Foreground: did the count reach the threshold.' },
    count: { type: 'number', description: 'Foreground: accumulated hits (level counting).' },
    countThreshold: { type: 'number' },
    at: { type: 'json', description: 'Epoch ms of the returned probe; recorded only.' },
    atIso: { type: 'json' },
    firstAt: { type: 'json' },
    lastAt: { type: 'json' },
    elapsedMs: { type: 'number' },
    samples: { type: 'number', description: 'Probes performed.' },
    hitSamples: { type: 'number', description: 'Probes that counted as a hit.' },
    level: { type: 'boolean', description: 'Verdict of the last probe.' },
    evidence: { type: 'json', description: 'Bounded tail of the sample that produced the hit.' },
    probability: { type: 'json', description: 'P(true) of the last probe — the value compared against hitThreshold.' },
    confidence: { type: 'json' },
    intervalMs: { type: 'number', description: 'Effective probe interval.' },
    timeoutMs: { type: 'number', description: 'Effective deadline.' },
    aborted: { type: 'boolean' },
    timedOut: { type: 'boolean' },
    errors: { type: 'number', description: 'Failed samples/judgements (they never abort the monitor).' },
    cost: { type: 'object', additionalProperties: true },
    coverage: { type: 'object', additionalProperties: true },
  },
};

/** 有限数原样成串；否则退化占位（render 里绝不出现 undefined / NaN）。 */
function formatNumber(value) {
  return Number.isFinite(value) ? String(value) : '—';
}

/** 只接受非空字符串，其余退化占位。 */
function formatText(value) {
  return typeof value === 'string' && value !== '' ? value : '—';
}

/** 会话 cwd：与 decision 同源（宿主自己的 fs 工具用 exec.agent.session.header.cwd）。 */
function sessionCwd(exec) {
  const header = exec && exec.agent && exec.agent.session && exec.agent.session.header;
  return header === undefined ? undefined : header.cwd;
}

/** 本会话 id（job 采样源枚举必须带它）：deps.sessionId → agent.id → session.id → header.sessionId。 */
function resolveSessionId(ctx, exec, deps) {
  if (typeof deps.sessionId === 'string' && deps.sessionId !== '') return deps.sessionId;
  const agent = exec && exec.agent;
  if (agent && typeof agent.id === 'string' && agent.id !== '') return agent.id;
  const session = agent && agent.session;
  if (session && typeof session.id === 'string' && session.id !== '') return session.id;
  const header = session && session.header;
  if (header && typeof header.sessionId === 'string' && header.sessionId !== '') return header.sessionId;
  return undefined;
}

/** 把 monitor 的 source 折成 source.js 认识的描述符（只挑白名单键，避免 unknown key 报错）。 */
function toDescriptor(source) {
  if (source.kind === 'file') {
    return {
      kind: 'file',
      path: source.path,
      ...(source.startLine === undefined ? {} : { startLine: source.startLine }),
      ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
    };
  }
  return {
    kind: 'glob',
    pattern: source.pattern,
    ...(source.limit === undefined ? {} : { limit: source.limit }),
  };
}

/**
 * 造采样源：**job / command / events 复用 lib/monitor.js 的采样器**，
 * 而 **file / glob 一律走注入的 `deps.read`**（decision 用的同一个 reader）。
 *
 * 这样本文件**没有任何文件/glob 读取实现**：注入的 reader 负责描述符校验、工作区根围栏与
 * 单文件/glob 两种越限语义；这里只做尾部窗口与形状归一。
 */
/**
 * 预检里哪些失败算「**永远好不了**」⇒ 当场抛；其余留给探测循环重试。
 *
 * - `invalid_request`：描述符形状不合法（`..` 段 / 绝对路径 / 未知键 / 行范围倒挂）——不会随时间变好；
 * - `source_outside_root`：解析后落在工作区根之外——同样不会变好。
 *
 * 其余 kind（`source_missing` / `source_too_large` / 普通 I/O 错）都可能是瞬态：**等文件出现**
 * 正是 P1 的用例（对作业源同理，作业也可能稍后才出现），所以它们必须继续由探测循环重试。
 */
function isFatalSourceError(error) {
  const kind = error && error.kind;
  return kind === 'invalid_request' || kind === 'source_outside_root';
}

export function createMonitorSources(ctx, options = {}) {
  const deps = options.deps === undefined ? {} : options.deps;
  const core = createSources(ctx, {
    sessionId: options.sessionId,
    cwd: options.cwd,
    runCommand: deps.runCommand,
    eventLog: deps.eventLog,
  });
  return {
    async read(source, readOptions = {}) {
      const spec = source === null || typeof source !== 'object' ? {} : source;
      if (spec.kind !== 'file' && spec.kind !== 'glob') return core.read(source, readOptions);
      if (typeof deps.read !== 'function') {
        throw new DecisionSourceError(
          'file/glob 采样源需要注入 deps.read（decision 用的同一个 reader）——本工具不实现第二份'
          + '读取语义。可行动项：在 lib/tool.js 的 apply 里把 createSourceReader(ctx) 的 read 作为'
          + ' deps.read 传给 registerMonitorTool；或改用 source.kind="job"。',
          { kind: 'invalid_request' },
        );
      }
      const descriptor = toDescriptor(spec);
      const out = await deps.read(descriptor, { signal: readOptions.signal, cwd: options.cwd });
      const fullText = String(out && out.state !== undefined ? out.state : '');
      const windowText = tailOf(fullText, readOptions.tailBytes);
      const fullBytes = Buffer.byteLength(fullText, 'utf8');
      const windowBytes = Buffer.byteLength(windowText, 'utf8');
      const meta = out && out.source !== undefined ? out.source : {};
      const totalBytes = Number.isFinite(meta.bytes) ? meta.bytes : fullBytes;
      return {
        kind: spec.kind,
        text: windowText,
        bytes: windowBytes,
        totalBytes,
        truncated: meta.truncated === true || windowBytes < totalBytes,
        files: meta.files,
        descriptor,
        source: meta,
      };
    },
  };
}

/**
 * `output.render` 的实现：**全函数**（绝不抛），返回内容块数组 `[{type:'text',text}]`。
 * 内容块契约是宿主硬要求（它直接对数组做 `some(block => block.type === 'image')`）。
 */
export function renderMonitor(_args, value) {
  try {
    const v = value === null || typeof value !== 'object' ? {} : value;
    const lines = [];
    if (v.background === true) {
      lines.push('monitor: background job registered — jobId ' + formatText(v.jobId) + ' (mode ' + formatText(v.mode) + ')');
      lines.push('Read it later with job_output; a notice is delivered when the threshold is reached.');
    } else {
      const hit = v.hit === true;
      lines.push('monitor ' + (hit ? 'HIT' : 'no hit') + ': ' + formatNumber(v.count) + '/' + formatNumber(v.countThreshold)
        + ' hits · probes ' + formatNumber(v.samples) + ' · hit probes ' + formatNumber(v.hitSamples)
        + ' · elapsed ' + formatNumber(v.elapsedMs) + 'ms');
      lines.push('last probe P(true) = ' + formatNumber(v.probability) + ' · confidence ' + formatNumber(v.confidence)
        + ' · level ' + formatText(v.level === true ? 'true' : (v.level === false ? 'false' : v.level)));
      lines.push('at ' + formatText(v.atIso) + ' (epoch ' + formatNumber(v.at) + 'ms) — recorded only, never a decision input');
      lines.push('first probe ' + formatNumber(v.firstAt) + 'ms · last probe ' + formatNumber(v.lastAt)
        + 'ms · interval ' + formatNumber(v.intervalMs) + 'ms · deadline ' + formatNumber(v.timeoutMs) + 'ms');
      if (v.aborted === true) lines.push('cancelled by the caller before the threshold was reached');
      if (v.timedOut === true) lines.push('deadline reached before the threshold was reached');
      if (Number.isFinite(v.errors) && v.errors > 0) lines.push('failed probes: ' + formatNumber(v.errors) + ' (they never abort the monitor)');
      const evidence = typeof v.evidence === 'string' && v.evidence !== '' ? v.evidence : '(none — no hit yet)';
      lines.push('evidence (bounded tail of the hitting sample):' + NL + evidence);
      if (hit) lines.push('Nothing was acted on: this call only reports. Kill / retry / dispatch stay your call.');
    }
    const notes = Array.isArray(v.notes) ? v.notes : [];
    const seen = new Set();
    for (const note of notes) {
      if (typeof note === 'string' && note !== '' && !seen.has(note)) {
        seen.add(note);
        lines.push(note);
      }
    }
    // clampNotes 是**只透传**的数据；若工具层没把它们并进 notes，这里补印一遍（不重复、不新增文案）。
    const clamps = Array.isArray(v.clampNotes) ? v.clampNotes : [];
    for (const note of clamps) {
      if (typeof note === 'string' && note !== '' && !seen.has(note)) {
        seen.add(note);
        lines.push(note);
      }
    }
    return [{ type: 'text', text: lines.join(NL) }];
  } catch (error) {
    // render 抛错会被宿主包成 ToolOutputError，把一次**成功**的调用变成失败 ⇒ 一律退化。
    return [{ type: 'text', text: 'monitor: (render degraded — the canonical value is in the tool result)' }];
  }
}

/**
 * 把 monitor 注册成模型可见工具。
 *
 * @param {any} ctx 宿主上下文（需要 tools.register；job 采样源另需 jobs/sessions）
 * @param {object} [options]
 * @param {object} [options.config] 插件配置（读 `monitorToolName` 与各 monitor 默认值）
 * @param {() => object} [options.resolveConfig] 动态配置读取（给了就优先于 config）
 * @param {object} [options.deps] 注入面：`decide`（必填）、`read`（file/glob 必填）、`notifier`/`deliver`、
 *   `clock`、`sleep`、`composeNotes`、`onProgress`、`onHit`、`register`（false = 只造不注册）、
 *   `sessionId`、`owner`、`agent`、`runCommand`、`eventLog`、`maxProbes`
 * @returns {{ name: string, definition: object, hostDefinition: object, registered: boolean }}
 *   `definition` 是**紧凑方言**的原始定义（自测预算与结构用）；`hostDefinition` 是 `defineTool` 归一后
 *   **可直接交给 `ctx.tools.register`** 的对象；`registered` 表示本次调用是否真的注册了。
 */
export function registerMonitorTool(ctx, options = {}) {
  const config = options.config === undefined ? {} : options.config;
  const deps = options.deps === undefined ? {} : options.deps;
  const readConfig = () => {
    if (typeof options.resolveConfig !== 'function') return config;
    const resolved = options.resolveConfig();
    return resolved === undefined || resolved === null ? config : resolved;
  };
  const cfg = readConfig();
  const name = typeof cfg.monitorToolName === 'string' && cfg.monitorToolName.trim() !== ''
    ? cfg.monitorToolName
    : MONITOR_TOOL_DEFAULT_NAME;

  const definition = {
    name,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderMonitor },
    /**
     * 前台：跑探测循环并返回计数结果；后台：注册宿主作业并立刻返回 jobId。
     * 参数一律经 `validateMonitorArgs` 归一（钳制不在这里做）。
     */
    async execute(args, exec) {
      const normalized = validateMonitorArgs(args, { config: readConfig() });
      const clampNotes = Array.isArray(normalized.clampNotes) ? normalized.clampNotes.slice() : [];
      // notes：**只透传**。工具层给了 composeNotes 就用它的结果，否则原样等于 clampNotes
      // —— 本文件一行 notes 文案都不新增。
      const composed = typeof deps.composeNotes === 'function'
        ? await deps.composeNotes({ args, normalized, clampNotes })
        : clampNotes;
      const notes = Array.isArray(composed) ? composed : clampNotes;
      const base = { mode: normalized.mode, source: normalized.source, clampNotes, notes };

      const userDecide = deps.decide;
      if (typeof userDecide !== 'function') {
        throw new TypeError('monitor 需要注入 deps.decide（(text, meta) => ({ probability })）——判据引擎不在本模块里。');
      }
      // rubric / type / criteria / hitThreshold 是**每次调用**从 args 来的，而 decide 是注册时注入的
      // ⇒ 必须把本次生效的判据随 meta 一起交给它（monitor.js 的 meta 只有 index/at/source/sample）。
      // 只用 (text) 的包装（如判据已预绑定）照常工作：多出来的第二个实参会被忽略。
      // 注意：validateMonitorArgs 只**归一/钳制**，不回抄 rubric/type/criteria（那三键原样留在 args 里，
      // 由 decision 内核自己校验）⇒ 判据三键从 args 取，钳制过的那几个从 normalized 取。
      const raw = args === null || typeof args !== 'object' ? {} : args;
      const decide = (text, meta) => userDecide(text, {
        ...meta,
        rubric: raw.rubric,
        type: raw.type,
        criteria: raw.criteria,
        hitThreshold: normalized.hitThreshold,
        args: raw,
        normalized,
        signal: exec === undefined ? undefined : exec.signal,
      });
      // **配置错误与描述符错误必须当场失败**：探测循环刻意容忍「这次读不到」的瞬态失败
      // （P1 的用例就是「等到文件里出现某行」），但「根本没注入服务」与「描述符永远不合法」
      // 一旦被循环吞掉，就会变成等到 deadline 后一句 no hit —— 那等于把配置错误伪装成
      // 「事件没发生」（verifier 的 P1 探针：坏 path 跑满默认 120 s）。
      const sourceKind = normalized.source && normalized.source.kind;
      if ((sourceKind === 'file' || sourceKind === 'glob') && typeof deps.read !== 'function') {
        throw new DecisionSourceError(
          'source.kind=' + String(sourceKind) + ' 需要注入 deps.read（decision 用的同一个 reader）：'
          + '本工具不实现第二份文件/glob 读取语义。可行动项：在 lib/tool.js 的 apply 里把'
          + ' createSourceReader(ctx) 的 read 作为 deps.read 传给 registerMonitorTool；或改用 source.kind="job"。',
          { kind: 'invalid_request' },
        );
      }
      if (sourceKind === 'command' && typeof deps.runCommand !== 'function') {
        throw new DecisionSourceError(
          'source.kind=command 需要在装配层注入 deps.runCommand(source, { tailBytes, signal })：本工具不自行 spawn 子进程。',
          { kind: 'invalid_request' },
        );
      }
      // monitorEventLog 不是已注册服务 ⇒ 读它同样 probe-safe（Cordis 代理读未 inject 的键会抛）。
      const jobsForEvents = probeProperty(ctx, 'jobs');
      const canProjectJobs = jobsForEvents !== undefined && jobsForEvents !== null
        && typeof jobsForEvents.list === 'function'
        && typeof resolveSessionId(ctx, exec, deps) === 'string';
      if (sourceKind === 'events' && deps.eventLog === undefined && probeProperty(ctx, 'monitorEventLog') === undefined && !canProjectJobs) {
        throw new DecisionSourceError(
          'source.kind=events 需要数据源：deps.eventLog、ctx.monitorEventLog，或可用的 ctx.jobs.list(sessionId)。',
          { kind: 'invalid_request' },
        );
      }
      const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
      const sleep = typeof deps.sleep === 'function'
        ? deps.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const signal = exec === undefined ? undefined : exec.signal;
      const sessionId = resolveSessionId(ctx, exec, deps);

      // task-34：`sessionId` 与**本次调用的 agent** 都只有在**执行期**才知道，而 lib/monitor.js 的
      // `resolveAgent` 只认 `deps.agent` / `deps.sessionId` ⇒ 两者必须随每次调用注入下去。否则：
      // ① 拿不到真实 agent ⇒ 算不出 idle（后台命中通知永远不会唤醒，只会静默 inject）；
      // ② 装配层的 deliver 用同一个 sessionId 解析目标会话 ⇒ 少了它就送不到触发它的那个会话。
      // 优先级：显式注入的 `deps.agent`（测试/特殊装配）> 本次 `exec.agent`。
      const callAgent = deps.agent === undefined ? (exec === undefined ? undefined : exec.agent) : deps.agent;
      const monitorDeps = { ...deps, sessionId, agent: callAgent };
      // task-34（续）：`deliver` 是装配期**静态**注入的闭包，而投递目标（agent）只有**执行期**才知道，
      // 且 notify.js 的契约只给 `(mode, payload)`（payload 里也没有 sessionId）⇒ 装配层无从反查。
      // 由这里把两者**作为第三个实参**一起交出去（多一个实参不破坏两参契约）：
      // 装配层用 `info.agent` 直接投递，或退回 `info.sessionId` 经 ctx.agents.get() 反查；取不到就静默返回。
      monitorDeps.deliver = typeof deps.deliver === 'function'
        ? (mode, payload) => deps.deliver(mode, payload, { agent: callAgent, sessionId })
        : deps.deliver;
      // task-34（续）：`runCommand` 与 deliver 同形 —— 它也是装配期注入的，而委托执行上游工具需要**调用者上下文**。
      // 真机三态实测（Lead）：委托 exec 只给 `{agent}` ⇒ git_bash 与 pwsh **一起** 8/8 errors；什么都不给 ⇒
      // git_bash 命中、pwsh 仍 8/8 errors。原因是管道转发的是 `agent: caller.agent` **与** `parent: caller.token`
      // （lib/pipe.js:314-315）—— **缺 token 时宿主直接拒收**。所以「半个上下文」比「没有上下文」更糟：
      // 必须把**整份 exec** 交出去，由装配层决定怎么用（它只在 info.exec 存在时整份透传、只覆盖 signal）。
      monitorDeps.runCommand = typeof deps.runCommand === 'function'
        ? (commandSource, commandOptions) => deps.runCommand(commandSource, commandOptions, { agent: callAgent, sessionId, exec })
        : deps.runCommand;

      // 采样源必须在**包装之后**建：command 源的 runner 是从这里注入的 deps 里取的（`deps.runCommand`），
      // 建早了就等于把未包装的原函数交给采样器，agent 照样到不了装配层。
      const sources = createMonitorSources(ctx, { deps: monitorDeps, cwd: sessionCwd(exec), sessionId });

      // **描述符级预检**（file/glob）：用**同一个注入的 reader** 试读一次，让「形状/越界」这类
      // 永远好不了的错误直接外抛。走 reader 而不是自己校验描述符，有两个不可替代的好处：
      // ① 报错文案由 reader 改写（`material.*` → `source.*`），模型照文案改参会改对地方；
      // ② 不产生第二份描述符校验实现。
      // 代价是每次调用多读一次源（一次，不是每轮探测一次），换取配置错误当场暴露。
      // command **不做预检** —— 试读会真的执行一次命令（有副作用）。
      if (sourceKind === 'file' || sourceKind === 'glob') {
        try {
          await sources.read(normalized.source, { tailBytes: normalized.tailBytes, signal });
        } catch (error) {
          if (isFatalSourceError(error)) throw error;
        }
      }

      if (normalized.background === true) {
        const started = startBackgroundMonitor(ctx, normalized, {
          decide,
          sources,
          clock,
          sleep,
          notify: deps.notifier,
          deliver: monitorDeps.deliver,
          agent: monitorDeps.agent,
          sessionId: monitorDeps.sessionId,
          owner: deps.owner === undefined ? sessionId : deps.owner,
          coalesceWindowMs: normalized.coalesceWindowMs,
          maxPerMinute: normalized.maxNotificationsPerMinute,
          onProgress: deps.onProgress,
          onHit: deps.onHit,
        });
        return { ...base, background: true, jobId: started.jobId };
      }

      const result = await runMonitor({
        sources,
        decide,
        clock,
        sleep,
        signal,
        args: { ...normalized, onProgress: deps.onProgress, maxProbes: deps.maxProbes },
      });
      return {
        ...base,
        background: false,
        hit: result.hit,
        count: result.count,
        countThreshold: result.countThreshold,
        at: result.at,
        atIso: result.atIso,
        firstAt: result.firstAt,
        lastAt: result.lastAt,
        elapsedMs: result.elapsedMs,
        samples: result.samples,
        hitSamples: result.hitSamples,
        level: result.level,
        probability: result.probability,
        confidence: result.confidence,
        evidence: result.evidence,
        intervalMs: result.intervalMs,
        timeoutMs: result.timeoutMs,
        aborted: result.aborted,
        timedOut: result.timedOut,
        errors: result.errors,
        // cost：只用**注入时钟**测得的探测次数与时长，不声称任何 token 数（判定在 deps.decide 里）。
        cost: {
          probes: result.samples,
          elapsedMs: result.elapsedMs,
          intervalMs: result.intervalMs,
          timeoutMs: result.timeoutMs,
        },
        coverage: {
          probes: result.samples,
          hits: result.count,
          errors: result.errors,
          aborted: result.aborted,
          timedOut: result.timedOut,
        },
      };
    },
  };

  const hostDefinition = defineTool(definition);
  let registered = false;
  if (deps.register !== false) {
    const registrar = typeof deps.register === 'function'
      ? deps.register
      : (() => {
        const tools = probeProperty(ctx, 'tools');
        return tools && typeof probeProperty(tools, 'register') === 'function'
          ? (built) => tools.register(built)
          : null;
      })();
    if (registrar !== null) {
      registrar(hostDefinition);
      registered = true;
    }
  }
  return { name: definition.name, definition, hostDefinition, registered };
}


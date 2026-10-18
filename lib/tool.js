/**
 * decision 工具的装配：把纯逻辑模块接到 DSH 的 tools 服务上。
 * 本文件是唯一接触 `ctx` 的地方。
 * @module dsh-decision-tools/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { PARAMETERS, TOOL_DESCRIPTION } from './parameters.js';
import { assertModeExclusive, resolveDepth, resolveMaterial, validateQuestions, assertBatchCriteria, analyzeBody, DecisionValidationError, LIMITS, MONITOR_LIMITS, validateUpstream } from './validate.js';
import { renderAnswers } from './render.js';
import { callSystemOne, classifyOverflow } from './client.js';
import { DecisionSourceError, sliceByLines, validateSourceDescriptor, splitGlobPattern, matchGlobSegment } from './source.js';
import {
  DEFAULT_LADDER, ESCALATION_MARGIN, createSingleFlight, describeExhausted, describeUnknownCapacity,
  selectByCapacity, selectEscalation,
} from './escalate.js';
import { bytesPerToken, softBytesFor } from './density.js';
import { toWireRequest } from './wire.js';
import { runScan } from './scan.js';
import { planAction } from './plan.js';
import { DEFAULT_SPILL_MAX_BYTES, runUpstream, spillWrite } from './pipe.js';
import { registerMonitorTool } from './monitor-tool.js';
import { createEventLog, attachJobEvents } from './event-log.js';

import os from 'node:os';
import path from 'node:path';

/**
 * 插件身份名。
 * 注意：这**不是**模型看到的工具名 —— 工具名取自配置 `toolName`（默认 `decision`）。
 */
export const name = 'decision-tools';

/** 配套技能名。与 lib/skill.js 的 SKILL_NAME 必须一致（有跨文件守卫用例）。 */
export const COMPANION_SKILL = 'decision-usage';

/** 需要 tools + fs + skills：注册工具、读引用式材料、取随包技能（技能拿不到就拒绝服务）。
 * 使用指引全部在工具 description 与随包 skill 里，**不注册 prompt 段**（ADR-5）。 */
// `jobs` 与 `agents` 是**可选但在本宿主必需**的服务：monitor 的后台注册用 `ctx.jobs`、inbox 通知用 `ctx.agents`。
// Cordis 语义（cordis/lib/index.js）：只有 `prop in fiber.inject` 才会从 `fiber.store` 解析服务实现，
// 否则该属性会走 reflect 的 accessor 分支并抛 `cannot get property "jobs" without inject` ——
// 真机实测：未声明时 monitor 的 background 路径直接失败（前台路径不受影响，因为它不用这两个服务）。
export const inject = ['tools', 'fs', 'skills', 'jobs', 'agents'];

export const Config = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  defaultModel: z.string().default('tev1:0.8b'),
  // 下界在**加载期**把关：0/负数会让 AbortSignal.timeout 抛 RangeError（调用期才炸），
  // 而这属于配置错误，越早报越省事。（NaN 会被 schemastery 折成 null，.min() 拦不住 ——
  // 那一层由 callSystemOne 的 bad_config 兜底。）
  timeoutMs: z.number().default(120000).min(1),
  toolName: z.string().default('decision'),
  // 可以是 "5m" 这类时长串或秒数；未设则不下发该字段，用服务端默认。
  keepAlive: z.union([z.string(), z.number()]).required(false),
  // 体积告警阈值（字节）。**刻意不设默认值** —— 未设时回落到 LIMITS.softBodyBytes，
  // 让那个常量的实测依据保持单一来源（不得把 4096 复制到这里）。
  // 下界 0 合法（= 每次调用都告警）；负数在加载期拒绝。
  softBodyBytes: z.number().min(0).required(false),
  // 体积告警开关。**刻意不设默认值** —— 未设或 true 都表示启用，只有显式 false 才关闭；
  // 关闭时返回里**连 body_warning 这个键都不出现**（不写 false、不写空串）。
  bodyWarning: z.boolean().required(false),
  // 置信度告警阈值（策略，见规格 §4.11）。**刻意不设默认值** —— 未设时回落到
  // `LIMITS.minConfidence`，让那个常量的实测依据保持单一来源（不得把 0.25 复制到这里）。
  // 下界 0 合法且**语义是"关闭"**（注意与 softBodyBytes: 0 相反 —— 那里是"每次都告警"）；
  // 负数在加载期拒绝。
  minConfidence: z.number().min(0).required(false),
  // `choice` 的选项数上限。**刻意不设默认值** —— 未设时回落到
  // `LIMITS.maxChoiceOptions`（255），让那个常量的实测依据保持单一来源。
  // 存在的理由：OpenAPI 明说 "The option limit depends on the model"，即它是
  // **依模型而变**的服务端约束，插件无从在本地推导；换了上限不同的模型时在此覆盖。
  // （`score` 的上限是规格写死的 10，不提供覆盖点。）
  maxChoiceOptions: z.number().min(2).required(false),
  // ---- v2（ADR-8 / ADR-9）----
  // 与既有阈值同一取向：**数值只有一处来源**（LIMITS / DEFAULT_LADDER），这里仅提供覆盖点，
  // 故一律 `required(false)`，由 apply() 解析生效值。
  escalationEnabled: z.boolean().default(true),
  // 阶梯：{ model, numCtx }[]。未设则用 DEFAULT_LADDER（**刻意不含 clef:latest**）。
  ladder: z.array(z.object({ model: z.string(), numCtx: z.number().min(1) })).required(false),
  escalationMaxAttempts: z.number().min(1).default(3),
  scanFirstChunkBytes: z.number().min(1).required(false),
  scanMaxChunks: z.number().min(1).required(false),
  scanMaxTotalBytes: z.number().min(1).required(false),
  scanDeadlineMs: z.number().min(1).required(false),
  // 'none' | 'any'；非法值一律折成 'none'（聚合是**暂定**产物，宁可缺席）。
  scanAggregate: z.string().required(false),
  // ---- Monitor 与上游委托管道（2026-10-17；规格 docs/superpowers/specs/2026-10-17-monitor-and-pipe-design.md）----
  // 与既有阈值同一取向：**数值只有一处来源**（MONITOR_LIMITS / DEFAULT_SPILL_MAX_BYTES），
  // 这里只提供覆盖点，故一律 required(false)，由 apply() 解析生效值（不把 1000 / 5000 / 16 MiB 复制进来）。
  // 探测间隔的**下限**：工具面 intervalMs 由模型给，生效值被抬到这里之上 —— 用户可以设下限，模型不能绕。
  minProbeIntervalMs: z.number().min(1).required(false),
  // 同类通知的合并窗口。理由是一条实测：inbox **没有任何背压**（连投 12 条逐条入队、下个边界一次全领），
  // 故合并与限频必须由生产者自己做（宿主只在 dsh-tool-jobs 里对作业通知做唤醒预算）。
  notifyCoalesceWindowMs: z.number().min(0).required(false),
  maxNotificationsPerMinute: z.number().min(1).required(false),
  // 上游委托转储的总量上限（字节）。转储目录由插件在系统临时区自建（宿主的 spill 没有 session 级清理），
  // 故上限与清扫由我们自管。
  spillDirCap: z.number().min(1).required(false),
});

/**
 * 解析生效的体积告警阈值（字节）。默认值的**唯一来源是 `LIMITS.softBodyBytes`** ——
 * 这里不复制那个数字，改常量即改默认。
 *
 * **钳制**：配置值高于硬上限 `LIMITS.maxBodyBytes` 时**静默**取上限（请求照常成功，
 * 不报错、不改拒绝行为）。它把生效值界定在插件**确知**的字节上限内 —— 插件无从得知模型
 * 真实的 `num_ctx`（它也不是架构声明的 context length：`tev1:0.8b` 声明 262144，
 * 而 `num_ctx` 2026-10-15 实测为 8192，此前是 2050 —— 该值会被模型重拉改掉）。
 *
 * **诚实边界（钳制目前是行为惰性的）**：被接受的 body 恒 `≤ LIMITS.maxBodyBytes`
 * （编排层的 `guardBody` 在**严格大于**上限时抛错），而告警条件是**严格大于**阈值 ——
 * 两条严格不等式首尾相接，于是任何 `≥ 上限` 的阈值（钳到 65536 的，和没钳的 `1e9`）
 * 在 `execute` 层行为**完全相同**：永不告警。所以真正防止 `16384` 那类「阈值落在
 * 拒绝区、告警永不可达」的 bug 的是**校准过的默认值** `LIMITS.softBodyBytes`（4096 B 的
 * 固定字节数，按 3.33 B/token 折合约 1230 token），不是这道钳制 —— 钳制是**刻意的意图声明**：
 * 一旦将来拒绝点挪动（例如不再由本地 64 KiB 守卫、而由更宽的边界决定），生效值仍已被夹在
 * 力所能及的*上限*内。另：把阈值设到模型**真实**容量之上，告警仍会**静默失效**，插件内部
 * 无法检测（没有读取服务端 `num_ctx` 的通路，且该值会随模型重拉而变）—— 权威守卫始终是
 * **服务端的 token 检查**：超限回 HTTP 400，映射为 `kind: 'context_overflow'`（输入不被截断）。
 *
 * @param {number|undefined} configured 配置里的 `softBodyBytes`；undefined 表示未设
 * @returns {number} 生效阈值（恒 ≤ `LIMITS.maxBodyBytes`）
 */
export function resolveSoftBodyBytes(configured) {
  // 非有限值（含 schemastery 把 NaN 静默折成的 null）与负值一律回落默认：否则
  // Math.min(null, 65536) = 0 会让**每次**调用都告警（实测）。
  const requested = Number.isFinite(configured) && configured >= 0
    ? configured
    : LIMITS.softBodyBytes;
  return Math.min(requested, LIMITS.maxBodyBytes);
}

/**
 * 解析生效的置信度门限。默认值的**唯一来源是 `LIMITS.minConfidence`** ——
 * 这里不复制那个数字，改常量即改默认。
 *
 * **`0` = 关闭**（与 `softBodyBytes: 0` 的方向**相反**：那里是「每次都告警」，
 * 这里是「从不告警」）。判定由 `collectLowConfidence` 短路实现：门限 `<= 0` 时
 * 连「confidence 缺失」那条保守分支也不会触发。
 *
 * **钳制**：配置值 > 1 时**静默**取 1。`confidence` 的定义域是 `[0,1]`，更高的阈值
 * 不表达更强的意图、只表达「全部告警」，故折到定义域上界即可（与 `softBodyBytes`
 * 折到 `maxBodyBytes` 同一取向：把生效值界定在插件确知的范围内）。
 *
 * @param {number|undefined} configured 配置里的 `minConfidence`；undefined 表示未设
 * @returns {number} 生效门限（恒在 `[0,1]`）
 */
export function resolveMinConfidence(configured) {
  // 非有限值（含 schemastery 把 NaN 静默折成的 null）与负值一律回落默认：
  // 与 resolveSoftBodyBytes 同因 —— 否则 NaN 会一路传到比较里，让门限恒不成立。
  const requested = Number.isFinite(configured) && configured >= 0
    ? configured
    : LIMITS.minConfidence;
  return Math.min(requested, 1);
}

/**
 * 挑出 confidence 低于门限（**或缺失**）的答案。纯函数，只读 `answers`，绝不修改它。
 *
 * **只加旗，不清障**（需求 N3.10 / M4）：调用方拿到的是「哪些题不可信」，
 * `answers` 本身原样返回 —— 本插件从不因为置信度低而删除、改写或拒绝一个答案。
 *
 * **缺失 confidence 按低处理**：`choice`/`score` 本应带 confidence，但它来自服务端回包、
 * `client.js` 不做逐题形状校验（规格 §4.8），所以「读不到」是可达状态。此时计入告警是
 * **保守方向**，与 `render.js` 的全函数化同一取向：宁可多打一行，不可静默把一个
 * 未知置信度的标签当成可信结论。
 *
 * **`noul` 不判**：它没有 confidence 字段（输出本身就是概率），把它的概率高低当置信度
 * 是另一种语义，不在本门限职责内 ⇒ 显式跳过。因此本函数也不会把 `noul` 计入告警。
 *
 * @param {unknown} answers 服务端 `answers`（题名 → 答案对象）
 * @param {number} threshold 生效门限；`<= 0` 表示关闭
 * @returns {{ name: string, confidence: number|null }[]} 缺失时 `confidence` 为 `null`
 */
export function collectLowConfidence(answers, threshold) {
  if (!Number.isFinite(threshold) || threshold <= 0) return [];
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) return [];

  const flagged = [];
  for (const [name, answer] of Object.entries(answers)) {
    if (answer?.type === 'noul') continue;
    const confidence = answer?.confidence;
    // `>= threshold` 才放行：非有限值（含 undefined/null/NaN）走不到这里 ⇒ 计入告警。
    if (Number.isFinite(confidence) && confidence >= threshold) continue;
    flagged.push({ name, confidence: Number.isFinite(confidence) ? confidence : null });
  }
  return flagged;
}

/**
 * 返回值 schema。宿主会用它对**每一个成功返回值**做强校验，
 * 因此这里的字段必须与 `execute` 的返回严格对应；
 * 用 `additionalProperties: true` 容忍 Ollama 新增字段。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /** 每个请求项一条，**与请求一一对应**（未答的项以 value=null 占位，绝不错位）。 */
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          type: { type: 'string' },
          // noul ⇒ 布尔；choice/score ⇒ 所选标签（score 是档位标签，不是 0..N-1 的数字）；
          // 服务端没答 ⇒ null。判断「有没有答」不能看这个值（false 是合法答案）。
          value: { type: 'json' },
          // noul ⇒ { true, false }；choice ⇒ 选项名 → 概率；score ⇒ 档位下标 → 概率。
          probabilities: { type: 'object', additionalProperties: true },
          confidence: { type: 'number' },
        },
      },
    },
    /** 对内部路径的如实报告（分批 / 截断 / 失败 / 取消）——不是调用方旋钮的回执。 */
    coverage: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        requested: { type: 'number' },
        answered: { type: 'number' },
        batches: { type: 'number' },
        truncated: { type: 'boolean' },
        truncatedBy: { type: 'json' },
        failed: { type: 'number' },
        aborted: { type: 'boolean' },
      },
    },
    /** { source: 'inline' | 'file' | 'glob', bytes, descriptor? }。 */
    material: { type: 'object', additionalProperties: true, required: true },
    /**
     * `{ model, inputTokens, bodyBytes, wallMs, escalated, attempts[] }`。
     * `inputTokens` / `bodyBytes` 是**本次调用实际发出的全部请求**之和（含分批与 deep 内部分块）；
     * `attempts` 只记**选档 / 升档**尝试（`{model, failureKind}`，成功项 `failureKind: null`）——
     * 同档内的分批 / 分块不逐条记，否则它就成了请求日志。
     */
    cost: { type: 'object', additionalProperties: true, required: true },
    /** 体积归因 / 低置信点名 / 分批与扫描提示：由工具层拼好，渲染层原样打印。 */
    notes: { type: 'array', required: true, items: { type: 'string' } },
  },
};

/**
 * 造引用式材料的读取器（ADR-7）。**这是唯一读盘的地方**，三道闸对每个文件都生效：
 * ① `validateSourceDescriptor` 拒绝对路径与 `..`（纯字符串）；
 * ② `ctx.fs.contains` 要求目标 canonical 落在**工作区根**之内 —— `resolve` 会 realpath 最深已
 *    存在的祖先，所以指向根外的符号链接在这一步就被拦下；
 * ③ `readBytes(target, signal, maxBytes)` 超限**抛 `FS_TOO_LARGE` 而不截断**。
 *
 * `file` 与 `glob` 的**越限语义刻意不同**（规格 §3.1）：单文件超限**报错**（内容不完整比失败更糟），
 * glob 总量超限**截断并报告**（扫描场景要的是「拿到多少算多少」）。
 *
 * glob 走真实的 `FsDirEntry` 形状（`{ name, type, target }`，见 `@deepseek-ai/dsh-fs` 的 types）：
 * `listDir` 只给一层，`**` 由本函数递归下降实现，带深度与条目数两道上限防止符号链接环/巨树。
 *
 * @param {any} ctx 宿主上下文（只需 `fs`）
 * @returns {(descriptor: unknown, options?: { signal?: AbortSignal }) => Promise<{ state: string, source: object }>}
 */
/**
 * 本会话的工作区 cwd。**权威来源是宿主自己的 fs 工具**：`@deepseek-ai/dsh-tool-fs` 的
 * `session-cwd.js` 就用 `exec.agent?.session.header.cwd`，理由是后端不给 cwd 时会回落到
 * **进程启动目录**（实测是用户主目录 `C:\Users\Dinos`），于是每个相对路径都解析到工作区之外。
 *
 * 这是 T2 的答案（真机证据：2026-10-13 运行态复验里 `material:{file:{path:'README.md'}}` 报
 * 「文件不存在」、`glob 'assets/**'` 下的 .md 报 `cannot list "C:\Users\Dinos\assets"`）。
 *
 * @param {any} exec 工具执行上下文
 * @returns {string|undefined} 会话 cwd；非 agent 调用时 `undefined`（由后端自决）
 */
function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd;
}

function createSourceReader(ctx) {
  /** 单份材料/单次 glob 总量的字节上限。 */
  const cap = LIMITS.maxSourceBytes;
  /** 递归下降的深度上限（防符号链接环）。 */
  const maxDepth = 8;
  /** 一次 glob 最多遍历多少条目（防巨树；触顶按截断处理）。 */
  const maxEntries = 2000;

  return async function readSource(descriptor, options = {}) {
    const normalized = validateSourceDescriptor(descriptor);
    const anchored = options.cwd === undefined ? {} : { cwd: options.cwd };
    const rootTarget = await ctx.fs.resolve('.', anchored);

    /**
     * 把读取失败翻译成**可行动的 kind**。旧实现一律说「太大」，会把「不存在」「不是常规
     * 文件」「权限」都误导成超限（r2 审查 P2）。
     */
    const toReadError = (path, error) => {
      const message = String(error?.message ?? error);
      if (/not found|ENOENT|NOT_FOUND|no such file/i.test(message)) {
        return new DecisionSourceError(`material 指向的文件不存在：${path}`, { kind: 'source_missing' });
      }
      if (/too large|TOO_LARGE/i.test(message)) {
        return new DecisionSourceError(
          `material.file 读取失败（单份上限 ${cap} 字节，超限不截断）：${path} —— ${message}；`
          + '建议改用 material.glob 分批读取，或缩小行范围。',
          { kind: 'source_too_large' },
        );
      }
      return new DecisionSourceError(
        `material.file 读不动（不是可读的常规文件？）：${path} —— ${message}`,
        { kind: 'invalid_request' },
      );
    };

    /** 读一个已确认在根内的文件（整份或行范围）。 */
    const readInside = async (path, target, extraction) => {
      let bytes;
      try {
        bytes = await ctx.fs.readBytes(target, options.signal, cap);
      } catch (error) {
        throw toReadError(path, error);
      }
      const full = Buffer.from(bytes).toString('utf8');
      const sliced = sliceByLines(full, extraction.startLine, extraction.endLine);
      return { text: sliced.text, lines: sliced.lines, startLine: sliced.startLine, endLine: sliced.endLine };
    };

    // ---- kind: file ----
    if (normalized.kind === 'file') {
      const target = await ctx.fs.resolve(normalized.path, { ...anchored, signal: options.signal });
      if (!ctx.fs.contains(rootTarget, target)) {
        throw new DecisionSourceError(
          `material.file.path 解析后落在工作区根之外，已拒绝：${normalized.path}`,
          { kind: 'source_outside_root' },
        );
      }
      const read = await readInside(normalized.path, target, normalized);
      return {
        state: read.text,
        source: {
          kind: 'file',
          path: normalized.path,
          bytes: Buffer.byteLength(read.text, 'utf8'),
          startLine: read.startLine,
          endLine: read.endLine,
          lines: read.lines,
        },
      };
    }

    // ---- kind: glob ----
    const { base, segments } = splitGlobPattern(normalized.pattern);
    const limit = normalized.limit ?? Number.POSITIVE_INFINITY;
    // 整条模式没有通配符 ⇒ 纯字面路径，直接按 file 读，不做无意义的目录遍历。
    if (segments.length === 0) {
      const target = await ctx.fs.resolve(base, { ...anchored, signal: options.signal });
      if (!ctx.fs.contains(rootTarget, target)) {
        throw new DecisionSourceError(`material.glob.pattern 解析后落在工作区根之外，已拒绝：${base}`,
          { kind: 'source_outside_root' });
      }
      const read = await readInside(base, target, normalized);
      return {
        state: read.text,
        source: { kind: 'glob', pattern: normalized.pattern, files: [base], bytes: Buffer.byteLength(read.text, 'utf8'), truncated: false, remaining: 0 },
      };
    }

    const startTarget = await ctx.fs.resolve(base === '' ? '.' : base, { ...anchored, signal: options.signal });
    if (!ctx.fs.contains(rootTarget, startTarget)) {
      throw new DecisionSourceError(`material.glob.pattern 的起始目录落在工作区根之外，已拒绝：${base}`,
        { kind: 'source_outside_root' });
    }
    const collected = [];
    /** 已收文件的路径集合：`**` 的「吃零层」与「吃一层」两支会走到同一个文件，必须去重。 */
    const seen = new Set();
    /** **state 的最终字节数**（含 `===== path =====` 表头与块间分隔符）—— 与 cap 同一口径。 */
    let bytes = 0;
    let remaining = 0;
    let visited = 0;
    let truncated = false;

    /** 表头 + 分隔符的字节成本（必须与最后 join 出来的串逐字一致）。 */
    const overhead = (path) => Buffer.byteLength(`===== ${path} =====\n`, 'utf8') + (collected.length === 0 ? 0 : 2);

    const take = async (path, entry) => {
      if (truncated || seen.has(path)) return;
      if (!ctx.fs.contains(rootTarget, entry.target)) return; // 根外命中项静默跳过
      if (seen.size >= limit) { truncated = true; remaining += 1; return; }
      const cost = overhead(path);
      const budget = cap - bytes - cost;
      if (budget <= 0) { truncated = true; remaining += 1; return; }
      let raw;
      try {
        raw = await ctx.fs.readBytes(entry.target, options.signal, budget);
      } catch (error) {
        const message = String(error?.message ?? error);
        // **glob 总量不足就截断，不报错**（规格 §3.1：单文件超限报错、glob 总量超限截断）。
        if (/too large|TOO_LARGE/i.test(message)) { truncated = true; remaining += 1; return; }
        throw toReadError(path, error);
      }
      const text = Buffer.from(raw).toString('utf8');
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (bytes + cost + textBytes > cap) { truncated = true; remaining += 1; return; }
      bytes += cost + textBytes;
      seen.add(path);
      collected.push({ path, text });
    };

    const walk = async (target, rest, prefix, depth) => {
      if (truncated) return;
      if (depth > maxDepth) { truncated = true; return; }
      // 段已耗尽：只可能来自「尾段命中目录」的情形，这里不该再匹配（防 undefined 进 matcher）。
      if (rest.length === 0) return;
      let entries;
      try {
        entries = await ctx.fs.listDir(target, options.signal);
      } catch (error) {
        throw toReadError(prefix === '' ? (base === '' ? '.' : base) : prefix, error);
      }
      for (const entry of entries) {
        if (truncated) return;
        visited += 1;
        if (visited > maxEntries) { truncated = true; return; }
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (rest[0] === '**') {
          if (rest.length === 1) {
            if (entry.type === 'file') await take(path, entry);
            else if (entry.type === 'directory') await walk(entry.target, rest, path, depth + 1);
            continue;
          }
          // `**` **吃零层**：`**` 与 `rest[1]` 两段都在这一步消耗（旧实现只消耗一段，
          // 于是 `a/**/b/file.md` 漏掉 `a/b/file.md`、只找到 `a/b/b/file.md`——r2 P0）。
          if (matchGlobSegment(rest[1], entry.name)) {
            const rest2 = rest.slice(2);
            if (entry.type === 'file') {
              if (rest2.length === 0) await take(path, entry);
            } else if (entry.type === 'directory') {
              await walk(entry.target, rest2, path, depth + 1);
            }
          }
          // `**` **吃一层**：子目录保持同一模式继续下降。
          if (entry.type === 'directory') await walk(entry.target, rest, path, depth + 1);
          continue;
        }
        if (entry.type === 'file') {
          if (rest.length === 1 && matchGlobSegment(rest[0], entry.name)) await take(path, entry);
          continue;
        }
        if (entry.type === 'directory' && rest.length > 1 && matchGlobSegment(rest[0], entry.name)) {
          await walk(entry.target, rest.slice(1), path, depth + 1);
        }
        // 尾段命中目录却不剩段可用：**不再下降**（旧实现把空模式传进 matcher ⇒ TypeError）。
      }
    };

    await walk(startTarget, segments, base, 0);
    const state = collected.map((file) => `===== ${file.path} =====\n${file.text}`).join('\n\n');
    return {
      state,
      source: {
        kind: 'glob',
        pattern: normalized.pattern,
        files: collected.map((file) => file.path),
        bytes: Buffer.byteLength(state, 'utf8'),
        truncated,
        remaining,
      },
    };
  };
}

/**
 * `depth` 三档的语义（ADR-14 的表）。**分块扫描在 v3 是内部行为**：只有 `deep` 允许。
 *
 * - `quick`：只用默认档，不升档、不分批、不扫描；超预算就地报错（绝不悄悄分批）。
 * - `normal`（缺省）：容量分派的最小够用档 + 溢出升档 + 按 body 预算分批；不主动扫描。
 * - `deep`：从**更大档**起步、升档上限更高、允许内部分块扫描。
 */
const DEPTH_POLICY = Object.freeze({
  quick: Object.freeze({ fixedDefault: true, escalate: false, batch: false, scan: false, largerStart: false, extraEscalationAttempts: 0 }),
  normal: Object.freeze({ fixedDefault: false, escalate: true, batch: true, scan: false, largerStart: false, extraEscalationAttempts: 0 }),
  deep: Object.freeze({ fixedDefault: false, escalate: true, batch: true, scan: true, largerStart: true, extraEscalationAttempts: 2 }),
});

/** 非数组的普通对象判据（本模块零依赖，自带一份）。 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * score/choice 的「所选标签」：取概率最大的那个键；给了 criteria（score 的档位，由低到高）时
 * 把 0..N-1 的下标翻成标签。概率加权均值 `Σ i·pᵢ` 由 `probabilities` 可复算（上游另有一个
 * `score` 数值字段，ADR-13 的 `value` 取标签，故不暴露它）。
 *
 * @returns {string|null} 选中标签；概率全缺失时为 null
 */
function bestLabel(probabilities, criteria) {
  if (!isPlainRecord(probabilities)) return null;
  let bestKey = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const [key, value] of Object.entries(probabilities)) {
    if (Number.isFinite(value) && value > bestValue) { bestValue = value; bestKey = key; }
  }
  if (bestKey === null) return null;
  const index = Number.parseInt(bestKey, 10);
  if (Array.isArray(criteria) && Number.isInteger(index) && index >= 0 && index < criteria.length) return criteria[index];
  return bestKey;
}

/**
 * 把服务端的一道题答案折成 ADR-13 的 `results[]` 项。
 *
 * `answered` 与结果**分开返回**：`value === null` 既可能是「服务端没答」也可能是合法答案
 * （`noul` 的 false 不是 null），所以不能用值本身判断有没有答。
 *
 * @param {{ id: string, type: string, criteria?: unknown, answer: unknown }} input
 * @returns {{ id: string, type: string, answered: boolean, result: { id: string, type: string, value: unknown, probabilities?: object, confidence?: number } }}
 */
function buildResult({ id, type, criteria, answer }) {
  const base = { id, type };
  if (!isPlainRecord(answer)) return { id, type, answered: false, result: { ...base, value: null } };
  if (type === 'noul') {
    if (!Number.isFinite(answer.noul)) return { id, type, answered: false, result: { ...base, value: null } };
    return {
      id,
      type,
      answered: true,
      result: { ...base, value: answer.noul >= 0.5, probabilities: { true: answer.noul, false: 1 - answer.noul } },
    };
  }
  const probabilities = isPlainRecord(answer.probabilities) ? answer.probabilities : undefined;
  const value = type === 'score'
    ? bestLabel(probabilities, criteria)
    : (typeof answer.choice === 'string' && answer.choice !== '' ? answer.choice : bestLabel(probabilities, criteria));
  const result = { ...base, value: value ?? null };
  if (probabilities !== undefined) result.probabilities = probabilities;
  if (Number.isFinite(answer.confidence)) result.confidence = answer.confidence;
  return { id, type, answered: value !== null && value !== undefined, result };
}

/**
 * 本次失败是不是「容量/溢出类」—— 只有这一类失败换更大的档才有意义（r7 P0）。
 *
 * 两条通道：`client.js` 已经给出稳定判据 `kind === 'context_overflow'`（A/B 两个分支都
 * 映射成它）；若某个非 400 的分支把溢出文本夹在别的错误里，再用 `classifyOverflow` 认一次。
 * 非容量类的失败（超时/连不上/500/模型未下载）**一律不得换档** —— 换档救不了它们，
 * 只会用一个更大的档重试成功来掩盖真实错误。
 *
 * @param {unknown} error 一次请求的失败
 * @returns {boolean}
 */
/**
 * 每轮扫描可用的墙钟预算（**纯函数**，无时钟、无 I/O ⇒ 可确定性断言）。
 *
 * 语义：整个 deep 批次**共用一份**总预算 —— 第 1 轮拿**全额** `totalMs`，此后各轮只拿**剩余**
 * （`deadlineAt - nowMs`）；剩余 ≤ 0 返回 `null`，调用方**不得再开新一轮**。旧实现每轮各自以配置值
 * 重取 `runScan` 的 t0 ⇒ 每轮重新计时，总墙钟上限约 3×（1 + `scanMaxAdaptRounds`）。
 *
 * @param {{ totalMs: number, deadlineAt: number, nowMs: number, round: number }} input
 * @returns {number|null} 本轮可用毫秒数；`null` = 预算已耗尽
 */
export function scanRoundBudget({ totalMs, deadlineAt, nowMs, round }) {
  if (round <= 0) return totalMs;
  const remaining = deadlineAt - nowMs;
  return remaining > 0 ? remaining : null;
}

function isCapacityError(error) {
  if (error?.kind === 'context_overflow') return true;
  return classifyOverflow(String(error?.message ?? '')) !== null;
}

export function apply(ctx, config = {}, internals = {}) {
  /**
   * 扫描预算的时间源：生产 = `Date.now`；测试可注入**确定性时钟**（`apply(ctx, cfg, { now })`）。
   * 存在的理由：本项目的判据不许拿**真实墙钟**当断言依据（负载下必抖），于是轮级预算与 `runScan`
   * 的单块预算共用这一个时间源，测试里用「每发一次请求就推进 N 毫秒」的假时钟把时序变成可复算的。
   */
  const now = typeof internals?.now === 'function' ? internals.now : Date.now;

  /** 首次交付标志与 skill 正文：两者都活在插件实例里（每进程一份）。 */
  let skillDelivered = false;
  let companionBody;
  const {
    baseUrl, defaultModel, timeoutMs, toolName, keepAlive, softBodyBytes, bodyWarning, minConfidence,
    maxChoiceOptions,
    escalationEnabled, ladder, escalationMaxAttempts, scanFirstChunkBytes, scanMaxChunks,
    scanMaxTotalBytes, scanDeadlineMs, scanAggregate,
  } = config;

  // 配置是静态的，阈值在注册时解析一次（含钳制），execute 里只做比较。
  // 上游委托的转储目录与总量上限（规格 §5）。**转储目录由插件自建**（宿主的 spill 没有 session 级清理），
  // 故上限与清扫由我们自管；`internals.spillDir` 是测试注入点（与 `internals.now` 同风格）。
  const effectiveSpillMaxBytes = Number.isFinite(config.spillDirCap) && config.spillDirCap >= 1
    ? Math.floor(config.spillDirCap)
    : DEFAULT_SPILL_MAX_BYTES;
  const spillDir = typeof internals?.spillDir === 'string' && internals.spillDir !== ''
    ? internals.spillDir
    : path.join(os.tmpdir(), `dsh-decision-pipe-${process.pid}`);

  const effectiveSoftBodyBytes = resolveSoftBodyBytes(softBodyBytes);
  const effectiveMinConfidence = resolveMinConfidence(minConfidence);
  // 与另两个阈值同因：NaN/null/负数一律回落到常量（`.min(2)` 拦不住 NaN）。
  const effectiveMaxChoiceOptions = Number.isFinite(maxChoiceOptions) && maxChoiceOptions >= LIMITS.minOptions
    ? Math.floor(maxChoiceOptions)
    : LIMITS.maxChoiceOptions;
  const effectiveLadder = Array.isArray(ladder) && ladder.length > 0 ? ladder : DEFAULT_LADDER;
  const numCtxOf = (model) => effectiveLadder.find((entry) => entry.model === model)?.numCtx;
  const positive = (value, fallback) => (Number.isFinite(value) && value >= 1 ? value : fallback);
  const effectiveScan = {
    firstChunkBytes: positive(scanFirstChunkBytes, LIMITS.softBodyBytes),
    maxChunks: positive(scanMaxChunks, LIMITS.scanMaxChunks),
    maxTotalBytes: positive(scanMaxTotalBytes, LIMITS.scanMaxTotalBytes),
    deadlineMs: positive(scanDeadlineMs, LIMITS.scanDeadlineMs),
    aggregate: scanAggregate === 'any' ? 'any' : 'none',
  };
  /**
   * 进程级粘滞状态（防抖动，ADR-8）。状态由本模块持有，策略在 lib/escalate.js。
   *
   * ⚠️ **可达性（复审 P2-3；行为按 Lead 裁定保持不变）**：粘滞的唯一读点是 `selectByCapacity`
   * 的 `stickyModel`，而它只在 `rows.length === 0` 时才被采用；`rows` 是 `effectiveLadder` 过滤掉
   * 非法条目后的结果。本文件的 `effectiveLadder` 保证「空 / 缺省 ⇒ 回落 DEFAULT_LADDER（4 条合法）」
   * ⇒ **正常配置下粘滞只写不读**；只有 `Config.ladder` 非空但条目全非法（如 `{model}` 缺 `numCtx`）
   * 时才可能走到 `sticky-fallback`。R1（显式 model 与成功升档都写粘滞）是用户裁定，不因不可达而改语义。
   */
  const sticky = { state: null };
  const singleFlight = createSingleFlight();
  const readSource = createSourceReader(ctx);

  /**
   * monitor 的采样读取器：**复用 decision 的同一个 reader**（消除第二份同语义实现），
   * 只把报错文案里的 `material.*` 改写成 `source.*` —— monitor 调用方给的是 `source`，
   * 照 `material.file.path` 去改参会改错地方（monitor-dev 复审点出的可用性缺陷；签名为透传，
   * 故与 reader 自身的参数形状解耦）。
   */
  const readForMonitor = async (...args) => {
    try {
      return await readSource(...args);
    } catch (error) {
      if (error instanceof Error && typeof error.message === 'string' && error.message.includes('material')) {
        error.message = error.message.split('material').join('source');
      }
      throw error;
    }
  };

  /**
   * monitor 的判据适配器：把「一次采样文本 + **本次调用**的判据」变成一次 System One 请求。
   * rubric/type/criteria 每次调用都可能不同，故由 runMonitor 通过 meta 带进来（monitor-dev 的 540c3d1）——
   * 注册时注入的闭包拿不到它们，只能从 meta 取。
   */
  const decideForMonitor = async (text, meta = {}) => {
    // **空材料 ⇒ P(true)=0，且不调模型**：对任何判据，「什么都没读到」都不可能成立。
    // 这条规则同时修掉一个真机缺陷：`events` 源在缓冲里没有匹配类型时返回空文本，
    // 旧实现把它送去请求模型 ⇒ 拿不到概率 ⇒ 每次探测都计一次 error（表现为 errors=N、看起来像坏源）。
    if (typeof text !== 'string' || text.trim() === '') return { probability: 0 };
    const question = {
      name: 'hit',
      type: typeof meta.type === 'string' && meta.type !== '' ? meta.type : 'noul',
      instructions: typeof meta.rubric === 'string' && meta.rubric !== '' ? meta.rubric : 'Does the material satisfy the criterion?',
      ...(meta.criteria === undefined ? {} : { criteria: meta.criteria }),
    };
    const body = toWireRequest({ material: text, questions: [question], model: defaultModel, keepAlive });
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > LIMITS.maxBodyBytes) {
      throw new DecisionSourceError('monitor 的判据请求体超过 64 KiB（通常是采样窗口过大）。可行动项：调小 tailBytes。', { kind: 'monitor_body_too_large' });
    }
    const answered = await callSystemOne({ baseUrl, body, timeoutMs, signal: meta.signal });
    const bag = answered?.answers;
    const entry = Array.isArray(bag) ? bag[0] : (bag && typeof bag === 'object' ? (bag.hit ?? Object.values(bag)[0]) : undefined);
    if (entry === undefined || !Number.isFinite(entry?.noul)) {
      throw new DecisionSourceError('monitor 的判据没有拿到概率（服务端未回答该题）。可行动项：用 noul 题，并确认 rubric 非空。', { kind: 'monitor_decide_failed' });
    }
    return { probability: entry.noul };
  };


  ctx.tools.register(defineTool({
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => {
      // 宿主没有「强制注入 skill 正文」的机制（dsh-skill 只有 register/registerProvider/list/get），
      // 所以「用本工具即拿到配套指引」由我们自己构造性保证：**首次使用**时把 skill 正文随结果交付，
      // 之后只留一行提示。这样常驻 description 才能安全地瘦身（长文按需到达，而不是每轮付费）。
      const deliver = !skillDelivered && companionBody !== undefined;
      skillDelivered = true;
      return renderAnswers(args, value, deliver ? companionBody : undefined);
    },
    },
    async execute(args, exec) {
      // 「用该工具必须拿到配套 skill」是硬要求：拿不到就拒绝服务（这属于部署配置错误，早暴露）。
      const companion = ctx.skills === undefined ? undefined : await ctx.skills.get(COMPANION_SKILL).catch(() => undefined);
      if (companion === undefined || typeof companion.content !== 'string' || companion.content.trim() === '') {
        throw new DecisionSourceError(
          `本工具需要配套技能 ${COMPANION_SKILL}：概率语义、confidence 阈值与扫描边界都在那里。`
          + '可行动项：在 composition 里同时启用本包的 skill 行（cordis.patch.yml 默认两行都启用）。',
          { kind: 'skill_missing' },
        );
      }
      companionBody = companion.content;
      const signal = exec?.signal;
      const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined;

      // ---- 领域接口（ADR-11/12/14）：模式互斥 → material 归一 → depth ----
      const mode = assertModeExclusive(args);
      const depth = resolveDepth(args.depth);
      const policy = DEPTH_POLICY[depth];
      // material 的第三种引用形态：**委托执行上游工具并判它的原始输出**（规格 §5）。
      // 与 file/glob 同属「引用式材料」—— 工具输出同样不进模型上下文；原始输出无条件转储，
      // 路径由返回值的 material.spillPath 回传（不吞掉）。
      const toolMaterial = typeof args.material === 'object' && args.material !== null && !Array.isArray(args.material)
        ? args.material.tool
        : undefined;
      const material = toolMaterial === undefined
        ? await resolveMaterial(args.material, { read: readSource, signal, cwd: sessionCwd(exec) })
        : await resolveUpstreamMaterial(ctx, exec, toolMaterial, {
          timeoutMs,
          spillDir,
          spillMaxBytes: effectiveSpillMaxBytes,
          selfToolNames: [toolName, monitorToolName],
        });
      // 空材料守卫（**只针对引用式材料**）：glob 未命中、或被总量上限截断到一个文件都没收。
      // 内联材料是字符串，非空由 normalizeMaterial 把关。
      if (material.source !== undefined && material.text.trim() === '') {
        throw new DecisionSourceError(
          'material 没有读到任何内容（模式未命中，或已被总量上限截断）。'
          + '可行动项：放宽 pattern、改用 file + 行范围，或调大 limit。',
          { kind: 'source_empty' },
        );
      }
      const materialText = material.text;
      const units = mode === 'items' ? args.items : args.questions;
      const rubric = typeof args.rubric === 'string' && args.rubric !== '' ? args.rubric : undefined;
      const batchType = mode === 'items' ? args.type : undefined;
      const batchCriteria = mode === 'items' ? args.criteria : undefined;
      if (mode === 'items') {
        assertBatchCriteria({ type: batchType, criteria: batchCriteria, maxChoiceOptions: effectiveMaxChoiceOptions });
      } else {
        validateQuestions(units, { maxChoiceOptions: effectiveMaxChoiceOptions });
      }

      // ---- 选档（ADR-8 / ADR-16 + depth）----
      // 依据是**本次材料的估算需求**：容量足够的最小档。粘滞只在容量规则给不出答案时兜底
      // （阶梯为空或容量未知）——它不再无条件决定每次调用的模型。r5 实测该策略在 24 次混合
      // 调用序列上稳定省 3.1–4.0 s（小材料打大档是默认档的 7–9 倍慢：865 ms vs 97 ms）。
      // 容量阈值按「窗口 × 余量 × 语言密度」算（ADR-16 / D7）：默认档窗口未知（阶梯里没有
      // defaultModel）时 softBytesFor 返回 undefined ⇒ 回落到 LIMITS.softBodyBytes 这个兜底常量。
      // depth 只改三件事：quick 固定默认档、deep 从更大档起步（并允许内部分块）、
      // 以及升档 / 分批 / 分块是否允许（ADR-14 的表）。
      const density = bytesPerToken(materialText);
      const stateBytes = Buffer.byteLength(materialText, 'utf8');
      const softBytes = softBytesFor({
        numCtx: numCtxOf(defaultModel), text: materialText, margin: ESCALATION_MARGIN,
      }) ?? LIMITS.softBodyBytes;
      let actingModel;
      let pickReason;
      if (explicitModel !== undefined) {
        actingModel = explicitModel;
        pickReason = 'explicit';
      } else if (policy.fixedDefault) {
        actingModel = defaultModel;
        pickReason = 'depth-quick';
      } else {
        // deep：候选先剔掉「不比默认档大」的条目；剔空则回落完整阶梯（宁可从小档起步，
        // 也不要在阶梯只有一档时无档可选）。
        const candidates = policy.largerStart
          ? effectiveLadder.filter((entry) => Number.isFinite(entry?.numCtx) && entry.numCtx > (numCtxOf(defaultModel) ?? 0))
          : effectiveLadder;
        const picked = selectByCapacity({
          defaultModel,
          ladder: candidates.length > 0 ? candidates : effectiveLadder,
          stateBytes,
          softBytes,
          bytesPerToken: density,
          stickyModel: sticky.state?.model,
        });
        actingModel = picked.model;
        pickReason = picked.reason;
      }
      // R1（用户裁定）：显式选择要记住（供兜底与回显），但**不**强制后续小材料也用它——
      // 那正是 A 方案要消灭的浪费。
      sticky.state = { model: actingModel, reason: pickReason };

      // ---- 预算与分批（D6：批大小是实现细节，只改请求次数、不改返回结构）----
      const bodyOf = (model, slice, keyOffset, materialOverride) => toWireRequest({
        material: materialOverride === undefined ? materialText : materialOverride,
        rubric,
        items: mode === 'items' ? slice : undefined,
        type: batchType,
        criteria: batchCriteria,
        questions: mode === 'questions' ? slice : undefined,
        model,
        keepAlive,
        keyOffset,
      });
      const bodyBytesOf = (model, slice, keyOffset = 0) => Buffer.byteLength(JSON.stringify(bodyOf(model, slice, keyOffset)), 'utf8');
      /** 批预算：窗口 × 余量 × 密度算出的**请求体**字节上限（密度按材料 + 判据 + 本批文本估）。 */
      const budgetOf = (model, slice) => {
        const text = `${materialText}\n${rubric ?? ''}\n${JSON.stringify(mode === 'items' ? { type: batchType, criteria: batchCriteria, items: slice } : slice)}`;
        return softBytesFor({ numCtx: numCtxOf(model), text, margin: ESCALATION_MARGIN }) ?? LIMITS.softBodyBytes;
      };
      /** 64 KiB 硬上限守卫（body 由本层组装，故守卫也归本层；v2 时期它曾住在校验层）。 */
      const guardBody = (body) => {
        const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
        if (bytes > LIMITS.maxBodyBytes) {
          throw new DecisionValidationError(
            `请求体 ${bytes} 字节，超过服务端上限 ${LIMITS.maxBodyBytes} 字节（64 KiB）；`
            + '可行动项：缩小 material，或减少本次项数/问题数（depth: normal 会自动分批，但单个单元不可再分）。',
            { kind: 'invalid_request' },
          );
        }
        return body;
      };

      // quick：既不分批也不升档，超预算**就地报错**（绝不悄悄分批）——ADR-14。
      if (policy.fixedDefault && bodyBytesOf(actingModel, units) > budgetOf(actingModel, units)) {
        throw new DecisionValidationError(
          `depth: quick 既不分批也不升档，但本次请求体约 ${bodyBytesOf(actingModel, units)} B，`
          + `超过 ${actingModel} 的可用预算 ${budgetOf(actingModel, units)} B。可行动项：`
          + '① 改 depth: normal（允许按预算分批与溢出升档）；② 缩小 material 或减少项数；'
          + '③ 给该模型调大 num_ctx（部署侧）。',
          { kind: 'quick_over_budget' },
        );
      }

      /** 按预算把 units 切成批（贪心）。单个 unit 就超预算时仍单独成一批（unit 不可再分）。 */
      const planBatches = (slice) => {
        if (!policy.batch) return [{ slice, keyOffset: 0 }];
        const out = [];
        let current = [];
        let offset = 0;
        for (const unit of slice) {
          const next = [...current, unit];
          if (current.length > 0 && bodyBytesOf(actingModel, next, offset) > budgetOf(actingModel, next)) {
            out.push({ slice: current, keyOffset: offset });
            offset += current.length;
            current = [unit];
          } else {
            current = next;
          }
        }
        if (current.length > 0) out.push({ slice: current, keyOffset: offset });
        return out.length === 0 ? [{ slice: [], keyOffset: 0 }] : out;
      };
      const batches = planBatches(units);
      const effectiveEscalationMaxAttempts = escalationMaxAttempts + (policy.extraEscalationAttempts ?? 0);
      const startedAt = Date.now();
      /**
       * 实际尝试过的**档**（成功项的 failureKind 为 null）——cost.attempts 与升档终态共用。
       * **按档记录**（契约：docs §3.2 与本文件 cost 的 JSDoc）：同一档内的分批只留 1 条 ——
       * 逐批 push 会把 attempts 变成请求日志，渲染层 `formatAttempts` 还会把 N 批读成「换了 N 次档」。
       * 该档内出现过失败就记成失败（失败优先）：「这一档最终没扛住」才是它该报的结论。
       */
      const attempts = [];
      const attemptByModel = new Map();
      const recordAttempt = (model, failureKind) => {
        const existing = attemptByModel.get(model);
        if (existing !== undefined) {
          if (failureKind !== null) existing.failureKind = failureKind;
          return;
        }
        const entry = { model, failureKind };
        attemptByModel.set(model, entry);
        attempts.push(entry);
      };
      let escalated = false;
      let finalModel = actingModel;
      let inputTokens = 0;
      let bodyBytesForCost = 0;
      /** 服务端逐题答案，按 **id** 合并（batch 模式是全局序号，mixed 模式是题名）。 */
      const answersById = new Map();
      let scanned = false;
      let scanFacts = { chunks: 0, failed: 0, truncated: false, truncatedBy: null, aborted: false };

      /**
       * 发一批，必要时按阶梯升档。返回 `{ ok: true, result, model }` 或 `{ ok: false, error }`
       * （**不在这里抛**：要不要转内部分块由调用方按 planAction 决定）。
       *
       * 保留两条 P0 语义：只有容量类失败才换档；**只有确认可用才写粘滞**。
       */
      const sendBatch = async (slice, keyOffset, materialOverride) => {
        const call = (model) => {
          const body = guardBody(bodyOf(model, slice, keyOffset, materialOverride));
          bodyBytesForCost += Buffer.byteLength(JSON.stringify(body), 'utf8');
          return callSystemOne({ baseUrl, body, timeoutMs, signal });
        };
        let cursor = actingModel;
        let failure;
        let result;
        try {
          result = await call(cursor);
        } catch (error) {
          failure = error;
        }
        if (failure === undefined) {
          recordAttempt(cursor, null);
          return { ok: true, result, model: cursor };
        }
        recordAttempt(cursor, failure.kind ?? 'unknown');

        // 只有容量/溢出类失败才换档：超时、连不上、500、模型未下载都不是换档能解决的（r7 P0）。
        const escalateAllowed = escalationEnabled && policy.escalate && explicitModel === undefined;
        if (!escalateAllowed || !isCapacityError(failure)) return { ok: false, error: failure };

        for (let attemptNo = 0; attemptNo < effectiveEscalationMaxAttempts; attemptNo += 1) {
          // **当前档容量按阶梯查，查不到就是「未知」**：这里绝不能拿 `LIMITS.softBodyBytes`
          // （字节常量）去冒充 token 窗口 —— 那会让「升档」升到**更小**的档（方向错误）。
          const decision = selectEscalation({
            ladder: effectiveLadder,
            from: cursor,
            failure,
            currentNumCtx: numCtxOf(cursor),
          });
          if (!decision.ok) {
            // 容量未知 ⇒ 原样上抛那条溢出，但把「为什么没升档 + 怎么修」补进 hint：否则调用方
            // 只看到一条溢出报错，会读成「工具没试过更大的档」。
            if (decision.reason === 'current-capacity-unknown') {
              return { ok: false, error: describeUnknownCapacity({ model: cursor, failure }) };
            }
            break;
          }
          const target = decision.entry.model;
          const outcome = await singleFlight.run(async () => {
            try {
              return { ok: true, value: await call(target) };
            } catch (error) {
              return { ok: false, error };
            }
          });
          if (outcome.ok) {
            // **只有确认可用才粘滞、才改最终模型**（r1 审查 P0：旧实现在此之前就写粘滞，
            // 一次提升失败会永久钉住全进程）。
            recordAttempt(target, null);
            escalated = true;
            finalModel = target;
            sticky.state = { model: target, reason: 'escalated' };
            return { ok: true, result: outcome.value, model: target };
          }
          recordAttempt(target, outcome.error?.kind ?? 'unknown');
          if (!isCapacityError(outcome.error)) return { ok: false, error: outcome.error };
          cursor = target;
          failure = outcome.error;
        }
        // 升档耗尽：换过档（≥2 次失败尝试）且最后一次仍是容量类失败 ⇒ 统一终态（r7 P0）。
        const tried = attempts.filter((item) => item.failureKind !== null);
        return {
          ok: false,
          error: tried.length >= 2 && isCapacityError(failure)
            ? describeExhausted({ attempts: tried, lastError: failure })
            : failure,
        };
      };

      /** 自动提升耗尽后，depth 允许时转**内部分块扫描**（ADR-14：只有 deep 会走到这里）。 */
      // 轮级预算由模块级纯函数 `scanRoundBudget` 决定（无 I/O、无时钟依赖 ⇒ 可确定性断言）。
      const scanBatch = async (slice, keyOffset) => {
        let budget = effectiveScan.firstChunkBytes;
        let output;
        // **整个 deep 批次共用一份墙钟预算**：自适应重切不得每轮重新计时（旧实现每轮各取一次 t0
        // ⇒ 总墙钟上限约 3×）。轮级预算交给纯函数裁决，耗尽即停、保留上一轮结果。
        const deadlineAt = now() + effectiveScan.deadlineMs;
        for (let round = 0; ; round += 1) {
          const budgetMs = scanRoundBudget({ totalMs: effectiveScan.deadlineMs, deadlineAt, nowMs: now(), round });
          if (budgetMs === null) break;
          output = await runScan({
            text: materialText,
            budgetBytes: budget,
            maxChunks: effectiveScan.maxChunks,
            maxTotalBytes: effectiveScan.maxTotalBytes,
            deadlineMs: budgetMs,
            // 同一个时间源交给 runScan：单块墙钟与轮级预算同源，测试不需要任何真实计时。
            now,
            concurrency: 1,
            aggregate: effectiveScan.aggregate,
            signal,
            callModel: async ({ text }) => {
              const body = guardBody(bodyOf(actingModel, slice, keyOffset, text));
              // **分块流量必须进 cost**（复审 P1）：旧实现只取 `.answers`，于是 notes 说「已分块 N 块」
              // 而 cost 说 0 token —— 同一份返回自相矛盾。`attempts` 仍只记**选档/升档**尝试：
              // 分块是同档内的实现细节，逐块记会把 attempts 变成请求日志。
              bodyBytesForCost += Buffer.byteLength(JSON.stringify(body), 'utf8');
              const answered = await callSystemOne({ baseUrl, body, timeoutMs, signal });
              if (Number.isFinite(answered.usage?.input_tokens)) inputTokens += answered.usage.input_tokens;
              return answered.answers;
            },
          });
          const overflow = output.failed.find((item) => item.kind === 'context_overflow');
          if (overflow === undefined || round >= LIMITS.scanMaxAdaptRounds) break;
          // 自适应：能读到服务端的数字就用**本文档自己的** B/token 一步重切；读不到（B 分支）则折半收缩。
          const ratio = Number.isFinite(overflow.actual) && overflow.actual > 0
            ? overflow.bytes / overflow.actual
            : undefined;
          const next = ratio === undefined || !Number.isFinite(overflow.limit)
            ? Math.max(1, Math.floor(budget / 2))
            : Math.max(1, Math.floor(overflow.limit * ESCALATION_MARGIN * ratio));
          if (next >= budget) break;
          budget = next;
        }
        scanned = true;
        scanFacts = {
          chunks: scanFacts.chunks + output.chunks.length,
          failed: scanFacts.failed + output.failed.length,
          truncated: scanFacts.truncated || output.truncated === true,
          truncatedBy: output.truncatedBy ?? scanFacts.truncatedBy,
          aborted: scanFacts.aborted || output.aborted === true,
        };
        // 跨块合并：**逐块取值只是定位线索**（未校准），故取「最强」的那一块的答案。
        const strength = (answer) => {
          if (!isPlainRecord(answer)) return Number.NEGATIVE_INFINITY;
          if (Number.isFinite(answer.noul)) return answer.noul;
          if (Number.isFinite(answer.confidence)) return answer.confidence;
          if (isPlainRecord(answer.probabilities)) {
            const values = Object.values(answer.probabilities).filter(Number.isFinite);
            return values.length === 0 ? Number.NEGATIVE_INFINITY : Math.max(...values);
          }
          return Number.NEGATIVE_INFINITY;
        };
        for (const chunk of output.chunks) {
          for (const [id, answer] of Object.entries(chunk.answers ?? {})) {
            if (strength(answer) > strength(answersById.get(id))) answersById.set(id, answer);
          }
        }
      };

      // ---- 逐批发请求，合并答案（调用方只看到 N 条结果，分批是实现细节）----
      for (const batch of batches) {
        const outcome = await sendBatch(batch.slice, batch.keyOffset);
        if (outcome.ok) {
          if (Number.isFinite(outcome.result.usage?.input_tokens)) inputTokens += outcome.result.usage.input_tokens;
          for (const [id, answer] of Object.entries(outcome.result.answers ?? {})) answersById.set(id, answer);
          continue;
        }
        // 升档已穷尽：按 depth 决定能否转内部分块（请求语义为 inline，故非 deep 一律判 fail）。
        const decision = planAction({
          requested: policy.scan ? 'auto' : 'inline',
          hasSource: material.source !== undefined,
          failure: outcome.error,
          escalationEnabled: false,
          escalation: undefined,
          scanAvailable: policy.scan,
        });
        if (decision.action !== 'scan') throw outcome.error;
        await scanBatch(batch.slice, batch.keyOffset);
      }

      // ---- 输出契约（ADR-13）：results / coverage / material / cost / notes ----
      const results = units.map((unit, index) => {
        const id = mode === 'items' ? String(index + 1) : unit.name;
        return buildResult({
          id,
          type: mode === 'items' ? batchType : unit.type,
          criteria: mode === 'items' ? batchCriteria : unit.criteria,
          answer: answersById.get(id),
        });
      });
      const answered = results.filter((entry) => entry.answered).length;
      const notAnswered = results.filter((entry) => !entry.answered).map((entry) => entry.id);
      const bodyBytes = bodyBytesForCost;
      /** material 自身的截断（glob 总量超 `maxSourceBytes`）—— 与扫描截断是两回事，两者都要进 coverage。 */
      const materialTruncated = material.source?.truncated === true;

      const notes = [];
      // 选档结论**必须是首行**（契约：`docs/architecture-current.md` §1.3 第 4 步 / §3.2 / §6 #8）。
      // 其余提示（体积归因 / 低置信点名 / 分批 / 分块 / 未答）一律排在它之后 —— 旧实现把它 push
      // 在所有提示之后，任何一条告警都会把首行挤掉（task-12 复审 P1）。
      notes.push(escalated
        ? `模型选择：从 ${actingModel} 起步，容量溢出后升档到 ${finalModel}。`
        : `模型选择：${finalModel}（${pickReason}）。`);
      // 体积归因（M2）：body 大不一定是材料大。问题文本占多数时，「改材料」是误导
      // —— 调用方往往已经用了引用式材料，该瘦的是**重复文本**（真机样例：材料 6922B、
      // 请求体 26056B，其中 73% 是 35 遍同样的判据）。v3 让共享判据只写一次，这句提示仍保留。
      const synthesized = mode === 'items'
        ? units.map((item, index) => ({ name: String(index + 1), type: batchType, instructions: item, criteria: batchCriteria }))
        : units;
      const bodyFacts = analyzeBody(materialText, synthesized);
      if (bodyWarning !== false && bodyBytes > effectiveSoftBodyBytes) {
        notes.push(bodyFacts.questionShare > 0.5
          ? `请求体 ${bodyBytes} 字节，已超过建议的 ${effectiveSoftBodyBytes} 字节，但其中 `
            + `${Math.round(bodyFacts.questionShare * 100)}% 是问题文本（材料只有 ${bodyFacts.stateBytes}B）。`
            + '该瘦的是问题文本：能共享的判据只写一次（放进 rubric），instructions 只留该题差异。'
          : `请求体 ${bodyBytes} 字节，已超过建议的 ${effectiveSoftBodyBytes} 字节：`
            + '可考虑改用引用式 material（file / glob），或缩小材料。');
      }
      // **这条提示与体积阈值无关**（Lead 裁定 2026-10-16）：它讲的是**文本形状**（重复 / 问题占多数），
      // 任何体积下都有用 —— 不要给它补 `bodyBytes > effectiveSoftBodyBytes` 的闸门（那会把一个常开
      // 的合规提示变成只在超限时才出现的提示）。守卫见 test/tool.test.mjs 的「常开」用例。
      if (bodyWarning !== false && bodyFacts.hint !== null) notes.push(bodyFacts.hint);
      if (batches.length > 1) {
        notes.push(`本次按预算分了 ${batches.length} 批（实现细节）：results 已按序合并，调用方看到的仍是 ${units.length} 条结果。`);
      }
      if (scanned) {
        notes.push(`材料装不下，已按 depth: deep 内部分块扫描（${scanFacts.chunks} 块，失败 ${scanFacts.failed}）：`
          + '逐块取值只是定位线索，不是文档级结论。');
      }
      const lowConfidence = collectLowConfidence(
        Object.fromEntries(results.map((entry) => [entry.id, entry.result])),
        effectiveMinConfidence,
      );
      if (lowConfidence.length > 0) {
        notes.push(`confidence 告警：以下 ${lowConfidence.length} 题的 confidence 低于 ${effectiveMinConfidence}`
          + '（或缺失），不得当作判定结果 —— 请读 probabilities，并交回你自己的推理：'
          + lowConfidence.map((item) => `${item.name}(${item.confidence === null ? '—' : item.confidence.toFixed(3)})`).join(', ')
          + '。');
      }
      if (notAnswered.length > 0) {
        notes.push(`服务端没有为这些 id 返回答案：${notAnswered.join(', ')}（results 里以 value=null 占位）。`);
      }

      return {
        results: results.map((entry) => entry.result),
        coverage: {
          requested: units.length,
          answered,
          batches: batches.length,
          // 契约（ADR-12 / §1.3 步骤 3 / §1.4）：截断的材料不得当完整材料用 —— 程序化调用方读的就是
          // 这两个字段，不能只把截断留在 material.descriptor 里。`truncatedBy` 的 material 取值由 Lead 裁定。
          truncated: materialTruncated || scanFacts.truncated,
          truncatedBy: materialTruncated ? 'material' : scanFacts.truncatedBy,
          failed: units.length - answered,
          aborted: scanFacts.aborted,
        },
        material: material.source === undefined
          ? { source: 'inline', bytes: Buffer.byteLength(materialText, 'utf8') }
          : material.source === 'tool'
            // 上游委托（规格 §5）：原始输出**无条件**转储，路径在这里回传 —— 「不吞掉」的落点。
            ? {
              source: 'tool',
              upstreamTool: material.upstreamTool,
              bytes: material.bytes,
              fullBytes: material.fullBytes,
              truncated: material.truncated,
              spillPath: material.spillPath,
              ...(material.exitCode === undefined ? {} : { exitCode: material.exitCode }),
            }
            : { source: material.source.kind, bytes: Buffer.byteLength(materialText, 'utf8'), descriptor: material.source },
        cost: {
          model: finalModel,
          inputTokens,
          bodyBytes,
          wallMs: Date.now() - startedAt,
          escalated,
          attempts,
        },
        notes,
      };
    },
  }));

  /**
   * Monitor 工具（独立文件 lib/monitor-tool.js，写域分离）。**必须在 decision 之后注册**：
   * 测试与调用方普遍按「第一个注册的工具即 decision」取用，注册顺序是既有事实的一部分。
   * **同一个 reader 注入进来**是刻意的：消除 monitor 侧「第二份文件/glob 读取实现」的漂移风险。
   * 工具名与自递归名单必须同源 —— 改名时两处一起改，否则禁自递归的闸会漏掉新名字。
   */
  const monitorToolName = typeof config.monitorToolName === 'string' && config.monitorToolName !== ''
    ? config.monitorToolName
    : 'monitor';
  /**
   * Monitor 的 inbox 投递（真机 P3 的第二半）：把通知送进**触发它的那个会话**。
   * 官方范式（dsh-tool-jobs）：目标空闲 ⇒ `followup`（唤醒，下一轮）；目标忙 ⇒ `inject`（静默，下一步）。
   * 两点刻意设计：① `info` 由工具层**每轮**传下来（agent 属于会话，不是全局状态）；
   * ② **通知是旁路**：取不到 agent、投递抛错，都只静默返回 —— 绝不影响监控本体，更绝不 cancel 任何东西。
   */
  /**
   * monitor 的 `command` 采样源（真机契约）：装配层负责 spawn，模块自己不 spawn。
   * **复用已有的委托管道**（runUpstream → ctx.tools.execute），而不是再写一份子进程实现 ——
   * 于是它自动继承管道的全部既有语义：agent/parent 转发、超时与 abort、截断标记、错误归一。
   * 参数约定：`argv[0]` 选解释器（pwsh | git_bash/bash/sh），其余按空格拼成该工具的命令文本。
   * 不认识的解释器**明确报错并列出支持的取值**，而不是猜一个去执行。
   */
  const runMonitorCommand = async (source, options = {}, info = {}) => {
    const argv = Array.isArray(source?.argv) ? source.argv.filter((a) => typeof a === 'string' && a !== '') : [];
    if (argv.length === 0) {
      throw new DecisionSourceError('command 源需要非空字符串数组 source.argv（argv[0] 为解释器）。', { kind: 'invalid_request' });
    }
    const [exe, ...rest] = argv;
    const base = String(exe).replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    const tool = (base === 'pwsh' || base === 'powershell') ? 'pwsh'
      : (base === 'bash' || base === 'sh' || base === 'git_bash' || base === 'zsh') ? 'git_bash'
        : undefined;
    if (tool === undefined) {
      throw new DecisionSourceError(`command 源不认识的解释器 "${exe}"。可行动项：用 pwsh / git_bash（或 bash、sh）作为 argv[0]。`, { kind: 'invalid_request' });
    }
    if (rest.length === 0) {
      throw new DecisionSourceError('command 源只有解释器没有命令。可行动项：在 argv 里补上要执行的命令。', { kind: 'invalid_request' });
    }
    // **剥掉前导标志簇**：`bash -lc "echo X"` 与 `pwsh -Command "Write-Output X"` 里的 `-lc`/`-Command`
    // 是**解释器自己的**开关，不是要执行的命令文本（宿主工具只收命令文本）。真机实测踩到过这一点：
    // 不剥的话 git_bash 会去执行 `-lc echo X`，输出变成「命令找不到」，而工具调用本身不报错、只给 P≈0.02 的低概率。
    // 判据：`-` 或 `--` 开头、随后只由字母与连字符组成（`-c` / `-lc` / `-Command` / `-NoProfile` /
    // `-ExecutionPolicy` 都是解释器开关）。**别把长度限死**（我第一版写成 {1,4} 个字母，
    // `-lc` 剥掉了而 `-Command`（7 个字母）没剥 ⇒ pwsh 实际执行「-Command Write-Output MARKER-X」，
    // 输出里没有目标串、errors 仍是 0、界面上只看到 p≈0.13 的低概率 —— 与 `-lc` 那个坑同源同理）。
    const flagLike = (s) => /^--?[A-Za-z][A-Za-z-]*$/.test(s);
    const cmdParts = [...rest];
    while (cmdParts.length > 1 && flagLike(cmdParts[0])) cmdParts.shift();
    if (cmdParts.length === 0) {
      throw new DecisionSourceError('command 源只有解释器与标志、没有命令文本。可行动项：在 argv 末尾补上要执行的命令。', { kind: 'invalid_request' });
    }
    const command = cmdParts.join(' ');
    const upstream = validateUpstream({ tool, arguments: { command, description: 'monitor command sample' } });
    // 委托的 exec 必须**整份**来自真实调用上下文：管道转发的是 `agent: caller.agent` 与 `parent: caller.token`
    // （lib/pipe.js:314-315）。真机实测把两者拆开都会坏 —— 只给 `agent` 不给 `token`，git_bash（原本靠全局解析能跑）
    // 与 pwsh **一起** 8/8 报错；不给 `agent`，git_bash 能跑而 pwsh 解析不到工具。
    // ⇒ 装配层需要的不是「agent」，而是**那次调用的 exec**：等工具层把 `exec` 传下来（见 task-34 续），
    //   在那之前这里只保留 signal，维持已实测通过的那条状态，绝不半途拼一个残缺 exec。
    const caller = info.exec !== undefined && info.exec !== null ? { ...info.exec, signal: options.signal } : { signal: options.signal };
    const result = await runUpstream(ctx, caller, upstream, { timeoutMs });
    if (result.isError === true) {
      const code = result.error?.code ?? 'tool_failed';
      throw new DecisionSourceError(`command 源执行失败（${code}：${result.error?.message ?? '无详情'}）。可行动项：核对 argv 与解释器可用性。`, { kind: `command_${code}` });
    }
    const text = typeof result.raw === 'string' ? result.raw : '';
    return {
      text,
      totalBytes: Number.isFinite(result.bytes) ? result.bytes : Buffer.byteLength(text, 'utf8'),
      truncated: result.truncated === true,
      exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
    };
  };

  const deliverMonitorNotice = (mode, payload, info = {}) => {
    try {
      const message = payload && payload.message;
      if (message === undefined || message === null) return;
      let target = info.agent;
      if (target === undefined || target === null) {
        const sid = typeof info.sessionId === 'string' && info.sessionId !== ''
          ? info.sessionId
          : (typeof internals?.sessionId === 'string' ? internals.sessionId : undefined);
        const agents = ctx.agents;
        target = sid === undefined || typeof agents?.get !== 'function' ? undefined : agents.get(sid);
      }
      if (target === undefined || target === null) return;
      if (mode === 'followup' && typeof target.followup === 'function') target.followup(message);
      else if (typeof target.inject === 'function') target.inject(message);
    } catch {
      // 通知失败不能影响监控本体（jobs/agents 都是旁路，不是判据）。
    }
  };

  // `monitor` 的 `events` 源：**优先用事件环形缓冲**（`ctx.jobs.events.subscribe` 两参服务），
  // 读不到缓冲时 monitor.js 会退到 `ctx.jobs.list(sessionId)` 的当前状态投影。
  // 真机教训（2026-10-18）：服务层 subscribe 是 `(filter, listener)` 两参，照底层三参调用会「注册成功但收不到事件」。
  /**
   * `monitor` 的 `events` 源数据源之一：把宿主 `ctx.jobs` 的事件流收进定长环形缓冲（有历史，不是快照）。
   * 三条边界写在 event-log.js：只读不写、环形有界、故障隔离。jobs 服务缺失时返回 null，
   * 读取器会自动退到 `ctx.jobs.list(sessionId)` 的当前状态投影。
   */
  const eventLog = createEventLog({});
  const disposeJobEvents = attachJobEvents(ctx, eventLog, {
    filter: { owners: 'scope' },
    warn: (message) => { try { ctx.logger?.warn?.(message); } catch { /* 日志不可用也不能影响主流程 */ } },
  });
  if (typeof disposeJobEvents === 'function') {
    try { ctx.effect(() => disposeJobEvents); } catch { /* 没有 effect 能力时，订阅随插件卸载自然失效 */ }
  }
  registerMonitorTool(ctx, {
    config: { monitorToolName },
    deps: {
      read: readForMonitor,
      decide: decideForMonitor,
      deliver: deliverMonitorNotice,
      runCommand: runMonitorCommand,
      eventLog,
      spillDir,
      selfToolNames: [toolName, monitorToolName],
    },
  });
}
/**
 * 上游委托材料（规格 §5）：在**插件内**执行上游工具、取原始输出、**无条件**转储到自建目录，
 * 再把转储文本当作材料。**全程没有会话模型参与。**
 *
 * 三条实测约束写死在这里（都有真跑依据）：
 * - 必须带 `agent`：插件 apply 拿到的是无作用域全局视图，不带 agent 时作用域外的工具名报 `unknown tool`；
 * - 必须带 `parent`：不带时模型面 `content` 会被 spill-policy 截断（200KB 实测 49931B vs 带 parent 199994B）；
 * - 转储**无条件**：输出再小也写，返回值带 `spillPath`/`bytes`，调用方随时可取全文。
 *
 * @param {object} ctx 插件 ctx（用它的 tools 服务）
 * @param {object} exec 工具执行的 exec（提供 agent / token / rootCallId / signal）
 * @param {{ name: string, arguments?: object }} toolSpec 形状由 validateUpstream 把关（含禁自递归）
 * @param {{ timeoutMs?: number, spillDir: string, spillMaxBytes?: number }} options
 * @returns {Promise<{ source: 'tool', text: string, upstreamTool: string, spillPath: string, bytes: number, fullBytes: number, truncated: boolean, exitCode?: number }>}
 * @throws {DecisionSourceError} 宿主无 tools 服务、或上游返回 isError
 */
export async function resolveUpstreamMaterial(ctx, exec, toolSpec, options = {}) {
  const { timeoutMs, spillDir, spillMaxBytes = DEFAULT_SPILL_MAX_BYTES } = options;
  // **两种形状必须在这里对齐**：模型面 `material.tool` 是 `{ name, arguments }`（见 parameters.js），
  // 而 `validateUpstream` 归一后的契约是 `{ tool, arguments }`。两者不一致时工具会在调用期才炸 ——
  // 这处映射由 test/upstream.test.mjs 的守卫钉住。
  const spec = typeof toolSpec === 'object' && toolSpec !== null ? toolSpec : {};
  const selfToolNames = options.selfToolNames ?? undefined;
  const upstream = validateUpstream({ tool: spec.name ?? spec.tool, arguments: spec.arguments }, selfToolNames === undefined ? {} : { selfToolNames });
  if (ctx?.tools?.execute === undefined) {
    throw new DecisionSourceError(
      '当前宿主没有可用的 tools 服务，无法执行 material.tool。可行动项：改用内联材料，或用 file/glob 引用。',
      { kind: 'tool_service_missing' },
    );
  }
  const result = await runUpstream(ctx, exec, upstream, { timeoutMs });
  if (result.isError === true) {
    const code = result.error?.code ?? 'tool_failed';
    throw new DecisionSourceError(
      `上游工具 ${upstream.tool} 执行失败（${code}：${result.error?.message ?? '无详情'}）。`
      + '可行动项：核对工具名与参数（不存在与被禁用由宿主统一报 UNKNOWN_TOOL），或改用内联/file 材料。',
      { kind: `upstream_${code}` },
    );
  }
  const raw = typeof result.raw === 'string' ? result.raw : '';
  const spill = spillWrite(raw, { dir: spillDir, maxBytes: spillMaxBytes });
  return {
    source: 'tool',
    text: raw,
    upstreamTool: upstream.tool,
    spillPath: spill.path,
    bytes: spill.bytes,
    fullBytes: Number.isFinite(spill.fullBytes) ? spill.fullBytes : spill.bytes,
    truncated: spill.truncated === true,
    ...(Number.isFinite(result.exitCode) ? { exitCode: result.exitCode } : {}),
  };
}
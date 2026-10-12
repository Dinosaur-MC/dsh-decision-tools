/**
 * decision 工具的装配：把纯逻辑模块接到 DSH 的 tools 服务上。
 * 本文件是唯一接触 `ctx` 的地方。
 * @module dsh-decision-tools/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { PARAMETERS, TOOL_DESCRIPTION } from './parameters.js';
import { prepareRequest, assertStateExclusive, resolveStrategy, DecisionValidationError, LIMITS } from './validate.js';
import { renderAnswers } from './render.js';
import { callSystemOne } from './client.js';
import { DecisionSourceError, sliceByLines, validateSourceDescriptor, splitGlobPattern, matchGlobSegment } from './source.js';
import { DEFAULT_LADDER, ESCALATION_MARGIN, createSingleFlight, describeExhausted, resolveSticky, selectEscalation } from './escalate.js';
import { runScan } from './scan.js';
import { planAction } from './plan.js';

/**
 * 插件身份名。
 * 注意：这**不是**模型看到的工具名 —— 工具名取自配置 `toolName`（默认 `decision`）。
 */
export const name = 'decision-tools';

/** 只需要 tools：使用指引全部在工具 description 里，不注册 prompt 段（ADR-5）。 */
export const inject = ['tools', 'fs'];

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
});

/**
 * 解析生效的体积告警阈值（字节）。默认值的**唯一来源是 `LIMITS.softBodyBytes`** ——
 * 这里不复制那个数字，改常量即改默认。
 *
 * **钳制**：配置值高于硬上限 `LIMITS.maxBodyBytes` 时**静默**取上限（请求照常成功，
 * 不报错、不改拒绝行为）。它把生效值界定在插件**确知**的字节上限内 —— 插件无从得知模型
 * 真实的 `num_ctx`（它也不是架构声明的 context length：`tev1:0.8b` 声明 262144，
 * 实际 `num_ctx = 2050`）。
 *
 * **诚实边界（钳制目前是行为惰性的）**：被接受的 body 恒 `≤ LIMITS.maxBodyBytes`
 * （`prepareRequest` 在**严格大于**上限时抛错），而告警条件是**严格大于**阈值 ——
 * 两条严格不等式首尾相接，于是任何 `≥ 上限` 的阈值（钳到 65536 的，和没钳的 `1e9`）
 * 在 `execute` 层行为**完全相同**：永不告警。所以真正防止 `16384` 那类「阈值落在
 * 拒绝区、告警永不可达」的 bug 的是**校准过的默认值** `LIMITS.softBodyBytes`（4096 ≈ 1230
 * token ≈ 2050 上限的 60%），不是这道钳制 —— 钳制是**刻意的意图声明**：一旦将来拒绝点
 * 挪动（例如不再由本地 64 KiB 守卫、而由更宽的边界决定），生效值仍已被夹在力所能及的
 * 上限内。另：把阈值设到模型**真实**容量之上，告警仍会**静默失效**，插件内部无法检测
 * （没有读取服务端 `num_ctx` 的通路）—— 权威守卫始终是**服务端的 token 检查**：
 * 超限回 HTTP 400，映射为 `kind: 'context_overflow'`（输入不被截断）。
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
    model: { type: 'string', required: true },
    // v2：扫描模式下顶层 `answers` **缺席**，逐块答案落在 chunks[].answers。
    // 故此处只**放宽**（去掉 required），additionalProperties 与其余 required 不动。
    answers: { type: 'object', additionalProperties: true },
    usage: { type: 'object', additionalProperties: true },
    // 体积可归因（需求 M2，见 Task 7 与规格 §4.8）。这三个字段**由本插件自己产出**，
    // 不是 Ollama 的回包字段，故必须显式声明 —— schema 是 additionalProperties:false。
    state_bytes: { type: 'number' },
    body_bytes: { type: 'number' },
    body_warning: { type: 'string' },
    // 置信度告警（delta，见规格 §4.11）。同样是**本插件自己产出**的字段，必须显式声明。
    confidence_warning: { type: 'string' },
    // ---- v2 新增（全部可选；凡 undefined 的键必须整个缺席）----
    /** 引用式材料的来源与规模（file 才有，glob 未接线）。 */
    source: { type: 'object', additionalProperties: true },
    /** 本次是否由自动提升换了模型。 */
    escalated: { type: 'object', additionalProperties: true },
    /** 插件实际决定的策略（strategy / model / reason）——「自动」只有可审计才敢用。 */
    plan: { type: 'object', additionalProperties: true },
    /** 扫描模式的逐块答案（此时顶层无 `answers`）。 */
    chunks: { type: 'array', items: { type: 'json' } },
    /** 扫描的元信息：failed / truncated / truncatedBy / aborted / remaining / aggregate。 */
    scan: { type: 'object', additionalProperties: true },
  },
};

/**
 * 造引用式材料的读取器（ADR-7）。**这是唯一读盘的地方**，三道闸：
 * ① `validateSourceDescriptor` 拒绝对路径与 `..`（纯字符串）；
 * ② `ctx.fs.contains` 要求目标 canonical 落在**工作区根**之内 —— `resolve` 会 realpath
 *    最深已存在的祖先，所以指向根外的符号链接在这一步就被拦下（因此不再单独 `lstat`，
 *    那需要假设 `FsPathInfo` 的形状）；
 * ③ `readBytes(target, signal, maxBytes)` 超限**抛 `FS_TOO_LARGE` 而不截断**。
 *
 * @param {any} ctx 宿主上下文（只需 `fs`）
 * @returns {(descriptor: unknown, options?: { signal?: AbortSignal }) => Promise<{ state: string, source: object }>}
 */
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
 * 这是 T2 的答案（真机证据：2026-10-13 运行态复验里 `stateSource{path:'README.md'}` 报
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
        return new DecisionSourceError(`stateSource 指向的文件不存在：${path}`, { kind: 'source_missing' });
      }
      if (/too large|TOO_LARGE/i.test(message)) {
        return new DecisionSourceError(
          `stateSource 读取失败（单份上限 ${cap} 字节，超限不截断）：${path} —— ${message}；`
          + '建议改用 glob 分批读取，或缩小行范围。',
          { kind: 'source_too_large' },
        );
      }
      return new DecisionSourceError(
        `stateSource 读不动（不是可读的常规文件？）：${path} —— ${message}`,
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
          `stateSource.path 解析后落在工作区根之外，已拒绝：${normalized.path}`,
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
        throw new DecisionSourceError(`stateSource.pattern 解析后落在工作区根之外，已拒绝：${base}`,
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
      throw new DecisionSourceError(`stateSource.pattern 的起始目录落在工作区根之外，已拒绝：${base}`,
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
export function apply(ctx, config = {}) {
  const {
    baseUrl, defaultModel, timeoutMs, toolName, keepAlive, softBodyBytes, bodyWarning, minConfidence,
    escalationEnabled, ladder, escalationMaxAttempts, scanFirstChunkBytes, scanMaxChunks,
    scanMaxTotalBytes, scanDeadlineMs, scanAggregate,
  } = config;

  // 配置是静态的，阈值在注册时解析一次（含钳制），execute 里只做比较。
  const effectiveSoftBodyBytes = resolveSoftBodyBytes(softBodyBytes);
  const effectiveMinConfidence = resolveMinConfidence(minConfidence);
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
  /** 进程级粘滞状态（防抖动，ADR-8）。状态由本模块持有，策略在 lib/escalate.js。 */
  const sticky = { state: null };
  const singleFlight = createSingleFlight();
  const readSource = createSourceReader(ctx);

  ctx.tools.register(defineTool({
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderAnswers,
    },
    async execute(args, exec) {
      const signal = exec?.signal;
      const requested = resolveStrategy(args.strategy);
      const explicitModel = typeof args.model === 'string' && args.model !== '' ? args.model : undefined;

      // ---- 材料来源（ADR-7）：内联或引用式，恰有其一 ----
      assertStateExclusive({ state: args.state, stateSource: args.stateSource });
      const material = args.stateSource === undefined || args.stateSource === null
        ? { state: args.state, source: undefined }
        : await readSource(args.stateSource, { signal, cwd: sessionCwd(exec) });

      // 空材料守卫：glob 未命中、或被总量上限截断到一个文件都没收，state 会是空串。
      // 不拦的话会在 prepareRequest 抛「state 不能是空字符串」——与真因无关的误导（r2 相邻发现）。
      if (typeof material.state !== 'string' || material.state.trim() === '') {
        throw new DecisionSourceError(
          'stateSource 没有读到任何材料（模式未命中，或已被总量上限截断）。'
          + '可行动项：放宽 pattern、改用 file + 行范围，或调大 limit。',
          { kind: 'source_empty' },
        );
      }

      // ---- 模型选择（ADR-8）：显式指定即关闭自动提升；否则沿用粘滞状态 ----
      const chosen = resolveSticky(sticky.state, { explicitModel, defaultModel });
      sticky.state = chosen.next;
      let actingModel = chosen.switchTo;
      let escalated = chosen.escalated === undefined
        ? undefined
        : { from: explicitModel ?? defaultModel, ...chosen.escalated };

      const request = (model, state) => callSystemOne({
        baseUrl,
        body: prepareRequest({ state, questions: args.questions, model, defaultModel, keepAlive }),
        timeoutMs,
        signal,
      });

      // `strategy: 'scan'` 明确要求**跳过单发**（规格 §4 决策表），所以这里连第一次请求都不发。
      const requestedScan = requested === 'scan';
      let result;
      let failure;
      if (!requestedScan) {
        try {
          result = await request(actingModel, material.state);
        } catch (error) {
          failure = error;
        }
      }

      // ---- 自动提升：只在未显式指定 model 时发生，且单飞（并发不拆台） ----
      if (failure !== undefined && failure.kind === 'context_overflow' && explicitModel === undefined && escalationEnabled) {
        for (let attempt = 0; attempt < escalationMaxAttempts; attempt += 1) {
          const decision = selectEscalation({
            ladder: effectiveLadder,
            from: actingModel,
            failure,
            currentNumCtx: numCtxOf(actingModel) ?? LIMITS.softBodyBytes,
          });
          if (!decision.ok) break;
          const target = decision.entry.model;
          const outcome = await singleFlight.run(async () => {
            try {
              return { ok: true, value: await request(target, material.state) };
            } catch (error) {
              return { ok: false, error };
            }
          });
          const from = actingModel;
          actingModel = target;
          sticky.state = { model: target, reason: 'escalated' };
          if (outcome.ok) {
            result = outcome.value;
            escalated = { from, to: target, sticky: true };
            failure = undefined;
            break;
          }
          failure = outcome.error;
        }
      }

      // ---- 决定下一步：直发已完成 / 提升已完成 / 扫描 / 失败 ----
      const canEscalate = escalationEnabled && explicitModel === undefined;
      const action = planAction({
        requested,
        hasSource: material.source !== undefined,
        failure,
        escalationEnabled: canEscalate,
        escalation: failure === undefined || !canEscalate
          ? undefined
          : selectEscalation({
            ladder: effectiveLadder,
            from: actingModel,
            failure,
            currentNumCtx: numCtxOf(actingModel) ?? LIMITS.softBodyBytes,
          }),
        scanAvailable: true,
      });
      if (action.action === 'fail' && failure !== undefined) throw failure;

      const value = { model: actingModel };
      if (material.source !== undefined) value.source = material.source;
      if (escalated !== undefined) value.escalated = escalated;
      value.plan = { strategy: requested, action: action.action, model: actingModel, reason: action.reason };

      // 分派依据是**计划里的动作**，而不是「有没有失败」：`strategy:'scan'` 时 `failure` 仍为
      // undefined（我们压根没发单次请求），按 failure 分派会让 scan 悄悄退化成直发。
      if (action.action !== 'scan') {
        if (failure !== undefined) throw failure;
        value.answers = result.answers;
        if (result.usage !== undefined) value.usage = result.usage;
        const stateText = typeof material.state === 'string' ? material.state : JSON.stringify(material.state);
        value.state_bytes = Buffer.byteLength(stateText, 'utf8');
        value.body_bytes = Buffer.byteLength(JSON.stringify(prepareRequest({
          state: material.state, questions: args.questions, model: actingModel, defaultModel, keepAlive,
        })), 'utf8');
        if (bodyWarning !== false && value.body_bytes > effectiveSoftBodyBytes) {
          value.body_warning = `请求体 ${value.body_bytes} 字节，已超过建议的 ${effectiveSoftBodyBytes} 字节：`
            + '可考虑改用 stateSource / strategy: scan，或缩小 state。';
        }
        const lowConfidence = collectLowConfidence(value.answers, effectiveMinConfidence);
        if (lowConfidence.length > 0) {
          value.confidence_warning = `confidence 告警：以下 ${lowConfidence.length} 题的 confidence 低于 ${effectiveMinConfidence}`
            + '（或缺失），不得当作判定结果 —— 请读 probabilities，并交回你自己的推理：'
            + lowConfidence.map((item) => `${item.name}(${item.confidence === null ? '—' : item.confidence.toFixed(3)})`).join(', ')
            + '。';
        }
        return value;
      }

      // ---- 扫描（ADR-9）：自适应定块 + 失败隔离 + 三重预算 ----
      let budget = effectiveScan.firstChunkBytes;
      let scanOutput;
      for (let round = 0; ; round += 1) {
        scanOutput = await runScan({
          text: material.state,
          budgetBytes: budget,
          maxChunks: effectiveScan.maxChunks,
          maxTotalBytes: effectiveScan.maxTotalBytes,
          deadlineMs: effectiveScan.deadlineMs,
          concurrency: 1,
          aggregate: effectiveScan.aggregate,
          signal,
          callModel: async ({ text }) => (await request(actingModel, text)).answers,
        });
        const overflow = scanOutput.failed.find((item) => item.kind === 'context_overflow');
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
      value.chunks = scanOutput.chunks;
      value.scan = {
        failed: scanOutput.failed,
        truncated: scanOutput.truncated,
        truncatedBy: scanOutput.truncatedBy,
        aborted: scanOutput.aborted,
        remaining: scanOutput.remaining,
        bytesPerChunk: budget,
        ...(scanOutput.aggregate === undefined ? {} : { aggregate: scanOutput.aggregate }),
      };
      return value;
    },
  }));
}
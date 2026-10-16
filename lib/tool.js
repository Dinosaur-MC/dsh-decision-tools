/**
 * decision 工具的装配：把纯逻辑模块接到 DSH 的 tools 服务上。
 * 本文件是唯一接触 `ctx` 的地方。
 * @module dsh-decision-tools/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { PARAMETERS, TOOL_DESCRIPTION } from './parameters.js';
import { assertModeExclusive, resolveDepth, resolveMaterial, validateQuestions, assertBatchCriteria, analyzeBody, DecisionValidationError, LIMITS } from './validate.js';
import { renderAnswers } from './render.js';
import { callSystemOne, classifyOverflow } from './client.js';
import { DecisionSourceError, sliceByLines, validateSourceDescriptor, splitGlobPattern, matchGlobSegment } from './source.js';
import { DEFAULT_LADDER, ESCALATION_MARGIN, createSingleFlight, describeExhausted, selectByCapacity, selectEscalation } from './escalate.js';
import { bytesPerToken, softBytesFor } from './density.js';
import { toWireRequest } from './wire.js';
import { runScan } from './scan.js';
import { planAction } from './plan.js';

/**
 * 插件身份名。
 * 注意：这**不是**模型看到的工具名 —— 工具名取自配置 `toolName`（默认 `decision`）。
 */
export const name = 'decision-tools';

/** 配套技能名。与 lib/skill.js 的 SKILL_NAME 必须一致（有跨文件守卫用例）。 */
export const COMPANION_SKILL = 'decision-usage';

/** 只需要 tools：使用指引全部在工具 description 里，不注册 prompt 段（ADR-5）。 */
export const inject = ['tools', 'fs', 'skills'];

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
    /** { model, inputTokens, bodyBytes, wallMs, escalated, attempts[] }。 */
    cost: { type: 'object', additionalProperties: true, required: true },
    /** 体积归因 / 低置信点名 / 分批与扫描提示：由工具层拼好，渲染层原样打印。 */
    notes: { type: 'array', required: true, items: { type: 'string' } },
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
function isCapacityError(error) {
  if (error?.kind === 'context_overflow') return true;
  return classifyOverflow(String(error?.message ?? '')) !== null;
}

export function apply(ctx, config = {}) {
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
      const material = await resolveMaterial(args.material, {
        read: readSource, signal, cwd: sessionCwd(exec),
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
      /** 实际尝试过的档（成功项的 failureKind 为 null）——cost.attempts 与升档终态共用。 */
      const attempts = [];
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
          attempts.push({ model: cursor, failureKind: null });
          return { ok: true, result, model: cursor };
        }
        attempts.push({ model: cursor, failureKind: failure.kind ?? 'unknown' });

        // 只有容量/溢出类失败才换档：超时、连不上、500、模型未下载都不是换档能解决的（r7 P0）。
        const escalateAllowed = escalationEnabled && policy.escalate && explicitModel === undefined;
        if (!escalateAllowed || !isCapacityError(failure)) return { ok: false, error: failure };

        for (let attemptNo = 0; attemptNo < effectiveEscalationMaxAttempts; attemptNo += 1) {
          const decision = selectEscalation({
            ladder: effectiveLadder,
            from: cursor,
            failure,
            currentNumCtx: numCtxOf(cursor) ?? LIMITS.softBodyBytes,
          });
          if (!decision.ok) break;
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
            attempts.push({ model: target, failureKind: null });
            escalated = true;
            finalModel = target;
            sticky.state = { model: target, reason: 'escalated' };
            return { ok: true, result: outcome.value, model: target };
          }
          attempts.push({ model: target, failureKind: outcome.error?.kind ?? 'unknown' });
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
      const scanBatch = async (slice, keyOffset) => {
        let budget = effectiveScan.firstChunkBytes;
        let output;
        for (let round = 0; ; round += 1) {
          output = await runScan({
            text: materialText,
            budgetBytes: budget,
            maxChunks: effectiveScan.maxChunks,
            maxTotalBytes: effectiveScan.maxTotalBytes,
            deadlineMs: effectiveScan.deadlineMs,
            concurrency: 1,
            aggregate: effectiveScan.aggregate,
            signal,
            callModel: async ({ text }) => (await callSystemOne({
              baseUrl,
              body: guardBody(bodyOf(actingModel, slice, keyOffset, text)),
              timeoutMs,
              signal,
            })).answers,
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

      const notes = [];
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
      // 选档原因（Task 7 / r3 P2 的可观测性）：v3 硬切了 `plan`，故把「为什么选这个模型」
      // 留在 notes 里 —— `cost.attempts` 只回答「试过哪些」，回答不了「为什么」。
      notes.push(escalated
        ? `模型选择：从 ${actingModel} 起步，容量溢出后升档到 ${finalModel}。`
        : `模型选择：${finalModel}（${pickReason}）。`);
      if (notAnswered.length > 0) {
        notes.push(`服务端没有为这些 id 返回答案：${notAnswered.join(', ')}（results 里以 value=null 占位）。`);
      }

      return {
        results: results.map((entry) => entry.result),
        coverage: {
          requested: units.length,
          answered,
          batches: batches.length,
          truncated: scanFacts.truncated,
          truncatedBy: scanFacts.truncatedBy,
          failed: units.length - answered,
          aborted: scanFacts.aborted,
        },
        material: material.source === undefined
          ? { source: 'inline', bytes: Buffer.byteLength(materialText, 'utf8') }
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
}
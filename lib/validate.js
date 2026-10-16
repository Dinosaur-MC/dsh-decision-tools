/**
 * 本地前置校验与请求体组装。
 *
 * 存在的理由：DSH 的紧凑 schema DSL 只有 type/enum/const，表达不了
 * 「1–64 题」「2–26 个选项」「问题名唯一」「请求体 ≤ 64 KiB」这些限制；
 * 而服务端的原始报错（例如 `question "urgent": type must be choice, noul, or score`）
 * 虽然准确，却不含合法值清单，模型容易重犯。这里把它们变成本地可行动的报错。
 *
 * 纯函数，无 DSH 依赖，便于独立测试与复用。
 * @module dsh-decision-tools/validate
 */
import { WIRE_TYPES } from './wire.js';

export const LIMITS = {
  maxQuestions: 64,
  /**
   * 批量模式的上限（= `maxQuestions`）。两项共用同一个上限是有意的：两种模式最终都编码成
   * 一次请求里的同样多个问题，服务端与计费的约束同源（D6：批大小是实现细节，上限不是）。
   */
  maxItems: 64,
  minOptions: 2,
  /**
   * `choice` 的选项数上限。**与 `score` 的上限不同** —— 两者在服务端是各自独立的约束：
   *
   * - `choice`：OpenAPI `SystemOneChoiceQuestion.criteria` 写 `minProperties: 2` /
   *   **`maxProperties: 255`**，且注明 **"The option limit depends on the model"**。
   *   本机实测（2026-10-15，Ollama 0.40.4）：255 项 → 200；256 项 → 400
   *   `too many options (256), this model supports at most 255`（`tev1:0.8b` 与
   *   `nimble-v3:latest` 同值）。255 是**当前所有 decision 模型的实测共同上限**；
   *   规格明说它依模型而异，故留 `Config.maxChoiceOptions` 覆盖点。
   * - `score`：见 `maxScoreLevels`，**10**。
   *
   * ⚠️ 2026-10-15 之前本常量是**单个** `maxOptions: 26`，被 `choice` 与 `score` 共用，
   * 且两个方向都错：对 `score` 太宽（11–26 档本地放行、到服务端才 400），
   * 对 `choice` 太严（27–255 个合法选项被本地**误拒**）。现已拆开。
   */
  maxChoiceOptions: 255,
  /**
   * `score` 的档位数上限。OpenAPI `SystemOneScoreQuestion.criteria` 写
   * `minItems: 2` / **`maxItems: 10`**；本机实测（2026-10-15）11 档即 400
   * `score criteria must be an array of 2–10 levels`。与 `choice` 的 255 无关。
   */
  maxScoreLevels: 10,
  maxBodyBytes: 65536,
  /**
   * 单份引用式材料的读取上限（字节）。**这是 anti-OOM 的读盘守卫，不是模型容量**：
   * 超过它的文件不能靠 `stateSource` 一次读入（`readBytes` 抛 `FS_TOO_LARGE`，不截断），
   * 应改用行范围或 glob。分块扫描发生在读取**之后**，故与它无关。
   */
  // 材料上限必须**小于请求体上限**（65536 字节），否则读进来的 state 会在编排层的
  // body 守卫（`lib/tool.js` 的 `guardBody`）被直接拒掉（实测：一个 100 KB 文件 →
  // 「请求体 100115 字节，超过服务端上限 65536」）。留 ~4 KiB 给 questions 与包装。
  // **它不是模型容量**：模型侧的 num_ctx 由自动提升与分块扫描处理，与本上限无关。
  maxSourceBytes: 61440,
  /** 扫描的块数上限（超出即返回部分结果并置 `truncated`）。 */
  scanMaxChunks: 32,
  /** 扫描的累计字节上限（4 MiB）。 */
  scanMaxTotalBytes: 4194304,
  /** 扫描的墙钟预算（毫秒），**独立于**单次请求的 `timeoutMs`。 */
  scanDeadlineMs: 180000,
  /** 自适应定块的重切轮数上限（据 400 反推比值后重切，最多这么多轮）。 */
  scanMaxAdaptRounds: 2,
  /**
   * 体积告警的**策略**阈值（字节），**不是**硬限、也**不是**实测退化点：超过它只让
   * 工具层产出一行提示、让模型有机会自行拆批，**不改变任何拒绝行为**（拒绝只由
   * maxBodyBytes 与服务端的 token 检查决定）。
   *
   * 取值依据是本机实测的「真实散文 → token」口径（`.temp/ctx-calib/calib.mjs`，
   * 语料 = 本仓 README + 规格，自然技术英文、非重复填充；当时模型 tev1:0.8b 的
   * num_ctx = 2050）：
   *
   *   body 字节    input_tokens   HTTP
   *      2288           678        200
   *      4292          1272        200
   *      6322          1891        200
   *      8341          2952        400  (prompt 0 has 2952 tokens; expected 1–2050)
   *
   * 即约 **3.33 B/token**，这条比值是本常量的依据。**注意它不随 `num_ctx` 漂移**：
   * 取 4096 B 是**固定字节数**，刻意不跟随任何模型的窗口 —— 2026-10-15 tev1 系
   * 重拉后 `num_ctx` 已从 2050 变为 8192，若当时按「窗口的 60%」绑定，这个阈值就会
   * 自动跳到 16 KB，在旧模型上反而**不再能提前告警**。
   * （用**重复填充文本**探得的 6.6–7.0 B/token 约乐观一倍，不可作为依据 ——
   * 重复文本压成更少的 token。上述表格才是可复现的凝固口径。）
   *
   * **已知局限**：字节数是**粗略代理**。**CJK 等密排文字、ID/数字密集的文本，单位
   * 字节占用的 token 高于 3.33 B/token 这条英文散文口径**，故同样的 4096 B 在那种
   * 输入上会占掉更多 token —— 此阈值在该类输入上**保护不足**。权威守卫始终是服务端
   * 的 token 检查（超限回 HTTP 400，映射为 kind: 'context_overflow'）。
   *
   * **本常量现在的角色（ADR-16 / D7）**：它只是「**窗口信息未知**时的兜底」。选档阈值
   * 已改由 `lib/density.js` 的 `softBytesFor({ numCtx, text })` 按「窗口 × 0.6 × 语言密度」
   * 现算（中文 2.32 / 英文 3.33 B per token，数值在 density.js 单点维护）。窗口能从阶梯里
   * 读到（`defaultModel` 在 `ladder` 里）时**不再使用本常量**。
   */
  softBodyBytes: 4096,
  /**
   * 置信度告警的**策略**阈值（`strictly below` 即计入）。**不是**正确率判据、
   * 也**不是**任何拒绝行为的依据 —— 低于它只让工具层产出一行 `confidence_warning`、
   * 禁止上层把那些标签当作判定结果；`answers` 一律原样返回（只加旗，不清障）。
   *
   * 标定依据（`.temp/order-probe/`，模型 `tev1:0.8b`，4 题 × 6 个候选排列 = 24 次调用）：
   *
   *   题   真值        模型行为              conf 实测（6 个排列）                        τ=0.25 的结果
   *   i1   outage      稳定答错（答 degraded） 0.192 .152 .096 .127 .040 .080                6/6 全部拦下
   *   i2   degraded    6/6 答对              0.617 .349 .293 .262 .283 .575                0 误伤
   *   i3   healthy     5/6 答对              0.816 .538 .935 .627 .236 .139                2 拦下（1 对 1 错）
   *   i4   （边界）     答案随排列翻转         0.149 .245 .073 .077 .165 .125                6/6 全部拦下
   *
   * 另：**全部 8 种「因排列而改变的标签」模式（展开 27 次）的 conf 落在 0.064–0.245**，
   * 故 τ=0.25 覆盖 100%（τ=0.2 会漏掉 conf=0.245 与 0.229 共 5 次）。
   *
   * **已知局限（不可消除，只能记录）**：
   * ① 该标定是**小样本、单模型、单题族**（4 题 / 24 次 / `tev1:0.8b`），不是普适边界；
   *    两个模型的 confidence 尺度差一个量级（0.8b 实测 0.06–0.94，4.2B 在同类题上恒 0.91–0.98）
   *    ⇒ **换模型必须重新标定**，本常量只是本机 `tev1:0.8b` 上的经验起点。
   * ② **它不是安全保证**：跨会话调研（Tessera 探针）里唯一一次顺序翻转发生在 conf **0.357**
   *    —— 而且拿到更高 conf 的恰是**错**的那个标签（正确标签 0.275）⇒ τ=0.25 会漏掉那一例。
   * ③ `confidence = 1 − H(p)/ln N` 是**分布集中度，不是校准正确率**（规格 §8 第 5 条），
   *    所以门限只降低风险，不能把"未被告警"读成"可信"。
   */
  minConfidence: 0.25,
};

/** 合法题型。**清单的唯一来源是 `lib/wire.js`**（上游线的合法值归那一层管）。 */
const QUESTION_TYPES = new Set(WIRE_TYPES);

/** 输入不合法。消息一律写成「哪里错 + 合法范围 + 怎么改」。 */
export class DecisionValidationError extends Error {
  /**
   * @param {string} message 面向模型的报错（含合法值清单与可行做法）
   * @param {{ kind?: string }} [info] 稳定的判据 `kind`，缺省 `invalid_request`。
   *   上层按 kind 分派（如 `aggregate_requires_scan` / `scan_requires_text_state`），
   *   所以 kind 是契约的一部分，不能一律压成 invalid_request。
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DecisionValidationError';
    this.kind = typeof info.kind === 'string' && info.kind !== '' ? info.kind : 'invalid_request';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'object') return '对象';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function validateChoice(at, criteria, maxChoiceOptions) {
  if (!isPlainObject(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（choice）必须是「选项名 → 描述」的对象，`
      + '例如 {"billing":"Payments and refunds","bug":"Software errors"}。',
    );
  }
  const keys = Object.keys(criteria);
  if (keys.length < LIMITS.minOptions || keys.length > maxChoiceOptions) {
    throw new DecisionValidationError(
      `${at}.criteria（choice）有 ${keys.length} 个选项，合法范围 ${LIMITS.minOptions}–${maxChoiceOptions}。`,
    );
  }
  for (const key of keys) {
    if (key.trim() === '') {
      throw new DecisionValidationError(`${at}.criteria（choice）的选项名不能为空白。`);
    }
  }
}

function validateScore(at, criteria) {
  if (!Array.isArray(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（score）必须是由低到高排列的字符串数组，`
      + '例如 ["Routine: no time pressure","Soon: a customer is inconvenienced","Immediate: a critical service is unavailable"]。',
    );
  }
  if (criteria.length < LIMITS.minOptions || criteria.length > LIMITS.maxScoreLevels) {
    throw new DecisionValidationError(
      `${at}.criteria（score）有 ${criteria.length} 档，合法范围 ${LIMITS.minOptions}–${LIMITS.maxScoreLevels}。`,
    );
  }
  for (const [index, entry] of criteria.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new DecisionValidationError(`${at}.criteria[${index}]（score）必须是非空字符串。`);
    }
  }
}

function validateNoul(at, criteria) {
  if (criteria === undefined) return;
  if (!isPlainObject(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（noul）只能是 {"false": "...", "true": "..."} 这样的对象，或整体省略。`,
    );
  }
  for (const key of Object.keys(criteria)) {
    if (key !== 'false' && key !== 'true') {
      throw new DecisionValidationError(
        `${at}.criteria（noul）只接受 "false" 和 "true" 两个键（收到 ${JSON.stringify(key)}）；或整体省略。`,
      );
    }
  }
}

function validateQuestion(at, question, seenNames, maxChoiceOptions) {
  if (!isPlainObject(question)) {
    throw new DecisionValidationError(`${at} 必须是对象（收到 ${describe(question)}）。`);
  }
  if (typeof question.name !== 'string' || question.name.trim() === '') {
    throw new DecisionValidationError(`${at}.name 必须是非空字符串；答案以它为键返回。`);
  }
  if (seenNames.has(question.name)) {
    throw new DecisionValidationError(
      `问题名重复：${JSON.stringify(question.name)}；每题 name 必须唯一，否则无法区分答案。`,
    );
  }
  seenNames.add(question.name);

  // V2 续：题名不得是纯数字串。线格式把 questions 编码成 JS 对象映射，而对象的
  // 整数样键（"1"/"42"）会被重排到最前，静默破坏模型给的「有序批量」语义。
  if (/^\d+$/.test(question.name)) {
    throw new DecisionValidationError(
      `${at}.name 不能是纯数字（收到 ${JSON.stringify(question.name)}）：`
      + '线格式用对象映射承载 questions，纯数字题名会被 JS 重排键序，破坏「有序批量」语义；'
      + '请改用 q1 这类题名。',
    );
  }

  if (!QUESTION_TYPES.has(question.type)) {
    throw new DecisionValidationError(
      `${at}.type 是 ${JSON.stringify(question.type)}，不支持；合法值只有 ${WIRE_TYPES.join('、')}。`,
    );
  }
  if (question.instructions === undefined) {
    throw new DecisionValidationError(`${at}.instructions 必填（问题要问什么）。`);
  }

  if (question.type === 'choice') validateChoice(at, question.criteria, maxChoiceOptions);
  else if (question.type === 'score') validateScore(at, question.criteria);
  else validateNoul(at, question.criteria);
}

/**
 * 请求体的**归因分析**（本轮真机样例换来的教训）：body 大 ≠ 材料大。
 *
 * 样例：`stateSource` 取到 6922B 材料，35 题各写一遍同样的判据 ⇒ 请求体 26056B，其中 **73% 是问题文本**；
 * 而该模型的 `input_tokens` 实测 ≈ **题数 × 请求体 token 数**（35 × 8076 ≈ 282651）。
 * 所以该瘦的是**重复文本**，不是材料 —— 而旧告警只会说「改用 stateSource / scan」，
 * 对已经用了 stateSource 的调用是**误导**。
 *
 * @param {string|object} state 生效材料
 * @param {Array} questions 题目数组
 * @returns {{ stateBytes: number, questionBytes: number, questionShare: number, repeatedQuestions: number, repeatedBytes: number, hint: string|null }} 归因与可行动提示
 */
export function analyzeBody(state, questions) {
  const stateText = typeof state === 'string' ? state : JSON.stringify(state ?? '');
  const stateBytes = Buffer.byteLength(stateText, 'utf8');
  const list = Array.isArray(questions) ? questions : [];
  let questionBytes = 0;
  const byInstruction = new Map();
  for (const question of list) {
    questionBytes += Buffer.byteLength(JSON.stringify({
      name: question?.name, type: question?.type, instructions: question?.instructions, criteria: question?.criteria,
    }), 'utf8');
    const key = typeof question?.instructions === 'string' ? question.instructions : JSON.stringify(question?.instructions ?? null);
    const group = byInstruction.get(key) ?? { count: 0, bytes: Buffer.byteLength(key, 'utf8') };
    group.count += 1;
    byInstruction.set(key, group);
  }
  let repeatedQuestions = 0;
  let repeatedBytes = 0;
  for (const group of byInstruction.values()) {
    if (group.count >= 2) {
      repeatedQuestions += group.count - 1;
      repeatedBytes += (group.count - 1) * group.bytes;
    }
  }
  const total = questionBytes + stateBytes;
  const hints = [];
  if (list.length >= 3 && questionBytes > stateBytes) {
    hints.push(`问题文本占请求体 ${total === 0 ? 0 : Math.round((questionBytes / total) * 100)}%（材料仅 ${stateBytes}B）`);
  }
  if (repeatedQuestions >= 2) {
    hints.push(`${repeatedQuestions} 题的 instructions 与其它题逐字相同，重复文本 ${repeatedBytes}B`);
  }
  if (hints.length > 0) {
    hints.push('模型按题数×请求体计费（本机样例 35 题 × 8076 token ≈ 282651 input_tokens）⇒ 该瘦的是重复文本而不是材料：把共享判据只写一次（放进 state，或压进 criteria），instructions 只留该题差异');
  }
  return {
    stateBytes,
    questionBytes,
    questionShare: total === 0 ? 0 : questionBytes / total,
    repeatedQuestions,
    repeatedBytes,
    hint: hints.length === 0 ? null : hints.join('；'),
  };
}

/**
 * 校验 `questions` 数组（数量 + 逐题形状）。抽成独立导出是因为 v3 的编排层要用它：
 * wire body 的组装已归 `lib/wire.js`，本层只负责**把模型给的东西审成可行动的报错**。
 *
 * @param {unknown} questions 模型给的题目数组
 * @param {{ maxChoiceOptions?: number }} [options]
 * @throws {DecisionValidationError}
 */
export function validateQuestions(questions, { maxChoiceOptions = LIMITS.maxChoiceOptions } = {}) {
  if (!Array.isArray(questions)) {
    throw new DecisionValidationError(`questions 必须是数组（收到 ${describe(questions)}）。`);
  }
  if (questions.length < 1 || questions.length > LIMITS.maxQuestions) {
    throw new DecisionValidationError(
      `questions 有 ${questions.length} 题，合法范围 1–${LIMITS.maxQuestions}；请拆分为多次调用。`,
    );
  }
  const seenNames = new Set();
  for (const [index, question] of questions.entries()) {
    validateQuestion(`questions[${index}]`, question, seenNames, maxChoiceOptions);
  }
}

/** 允许的 `depth` 值。`normal` 是缺省（ADR-14）。 */
export const DEPTHS = Object.freeze(['quick', 'normal', 'deep']);

/**
 * 解析 `depth`。缺省 `normal`；非法值即报错（含合法值清单，模型才改得动）。
 *
 * @param {unknown} value 模型给的 `depth`
 * @returns {'quick'|'normal'|'deep'} 生效深度
 * @throws {DecisionValidationError} 非法值
 */
export function resolveDepth(value) {
  if (value === undefined || value === null) return 'normal';
  if (!DEPTHS.includes(value)) {
    throw new DecisionValidationError(`depth 只允许 ${DEPTHS.join(' / ')}（收到 ${JSON.stringify(value)}）。`, { kind: 'invalid_request' });
  }
  return value;
}

/**
 * 把 `material` 的三种形态归一成一个**纯数据**描述（不读盘、不发请求）。
 *
 * ADR-12 的形态：
 * ```text
 * material: string                          // 内联材料
 *         | { file: { path, startLine?, endLine? } }
 *         | { glob: { pattern, limit? } }
 * ```
 * 安全边界不变量（工作区内、读取上限、单文件报错 vs glob 截断）**不在这一层**：
 * 它们由 `lib/source.js` 的 `validateSourceDescriptor` + `ctx.fs.contains` 在真正读盘时把关，
 * 本函数只把形状翻译成那个读取器认的描述符。
 *
 * @param {unknown} material 模型给的 `material`
 * @returns {{ kind: 'inline', text: string }
 *   | { kind: 'file', fields: { path: string, startLine?: number, endLine?: number } }
 *   | { kind: 'glob', fields: { pattern: string, limit?: number } }}
 * @throws {DecisionValidationError} 形状不合法
 */
export function normalizeMaterial(material) {
  if (typeof material === 'string') {
    if (material.trim() === '') {
      throw new DecisionValidationError('material 不能是空字符串；它就是所有判定共享的那份材料。', { kind: 'material_invalid' });
    }
    return { kind: 'inline', text: material };
  }
  if (!isPlainObject(material)) {
    throw new DecisionValidationError(
      `material 必须是字符串（内联材料）或 {file:{...}} / {glob:{...}} 对象（收到 ${describe(material)}）。`,
      { kind: 'material_invalid' },
    );
  }
  const hasFile = material.file !== undefined && material.file !== null;
  const hasGlob = material.glob !== undefined && material.glob !== null;
  if (hasFile && hasGlob) {
    throw new DecisionValidationError('material 的 file 与 glob 只能给一个（两个都给会让「材料是哪份」有歧义）。', { kind: 'material_conflict' });
  }
  if (!hasFile && !hasGlob) {
    throw new DecisionValidationError(
      `material 对象必须含 file 或 glob 之一（收到键 ${JSON.stringify(Object.keys(material))}）。`,
      { kind: 'material_invalid' },
    );
  }
  if (hasFile) {
    const file = material.file;
    if (!isPlainObject(file)) {
      throw new DecisionValidationError(`material.file 必须是对象（收到 ${describe(file)}）。`, { kind: 'material_invalid' });
    }
    const unknown = Object.keys(file).filter((key) => key !== 'path' && key !== 'startLine' && key !== 'endLine');
    if (unknown.length > 0) {
      throw new DecisionValidationError(
        `material.file 只接受 path / startLine / endLine（多出 ${JSON.stringify(unknown)}）。`,
        { kind: 'material_invalid' },
      );
    }
    if (typeof file.path !== 'string' || file.path.trim() === '') {
      throw new DecisionValidationError('material.file.path 必须是非空字符串（工作区相对路径）。', { kind: 'material_invalid' });
    }
    return { kind: 'file', fields: { path: file.path, startLine: file.startLine, endLine: file.endLine } };
  }
  const glob = material.glob;
  if (!isPlainObject(glob)) {
    throw new DecisionValidationError(`material.glob 必须是对象（收到 ${describe(glob)}）。`, { kind: 'material_invalid' });
  }
  const unknown = Object.keys(glob).filter((key) => key !== 'pattern' && key !== 'limit');
  if (unknown.length > 0) {
    throw new DecisionValidationError(
      `material.glob 只接受 pattern / limit（多出 ${JSON.stringify(unknown)}）。`,
      { kind: 'material_invalid' },
    );
  }
  if (typeof glob.pattern !== 'string' || glob.pattern.trim() === '') {
    throw new DecisionValidationError('material.glob.pattern 必须是非空字符串（如 docs/*.md）。', { kind: 'material_invalid' });
  }
  return { kind: 'glob', fields: { pattern: glob.pattern, limit: glob.limit } };
}

/**
 * 归一 + 读取：内联形态直接返回文本，引用形态**经注入的读取器**读盘。
 *
 * 读盘必须注入而不是在这里 import：本模块保持纯函数、零 I/O（可离线测试），
 * 而 `ctx.fs` 只在 `lib/tool.js` 里存在（本仓「唯一接触 ctx 的文件」这条边界）。
 *
 * @param {unknown} material 模型给的 `material`
 * @param {{ read?: Function, signal?: AbortSignal, cwd?: string }} [io] 读取器与读取选项
 * @returns {Promise<{ text: string, source: object|undefined }>} 读取器给出的 `source` 原样保留
 * @throws {DecisionValidationError} 形状不合法，或缺少读取器
 */
export async function resolveMaterial(material, { read, signal, cwd } = {}) {
  const shape = normalizeMaterial(material);
  if (shape.kind === 'inline') return { text: shape.text, source: undefined };
  if (typeof read !== 'function') {
    throw new DecisionValidationError('读取引用式 material 需要注入读取器（本模块不做 I/O）。', { kind: 'invalid_request' });
  }
  const loaded = await read({ kind: shape.kind, ...shape.fields }, { signal, cwd });
  return { text: loaded.state, source: loaded.source };
}

/**
 * `items` 与 `questions` **恰有其一**（ADR-11）。两者语义不同（同判据判 N 项 vs 一材料多问），
 * 都给出会让「哪个生效」有歧义，都不给则没有可判的对象。
 *
 * `rubric` / `type` 是**批量模式**的必给字段，也在这里一并把关 —— schema 里不写模式分支
 * （会把注入预算翻倍，ADR-14），故这层是唯一把关点。
 *
 * @param {{ items?: unknown, questions?: unknown, rubric?: unknown, type?: unknown }} args 工具参数
 * @returns {'items'|'questions'} 生效模式
 * @throws {DecisionValidationError} `kind` 为 `mode_conflict` / `mode_missing` / `mode_invalid`
 */
export function assertModeExclusive({ items, questions, rubric, type, criteria } = {}) {
  const hasItems = items !== undefined && items !== null;
  const hasQuestions = questions !== undefined && questions !== null;
  if (hasItems && hasQuestions) {
    throw new DecisionValidationError(
      'items 与 questions 是两种互斥模式：只能给一个 —— batch（同判据判 N 项）或 mixed（一份材料多个不同问题）。',
      { kind: 'mode_conflict' },
    );
  }
  if (!hasItems && !hasQuestions) {
    throw new DecisionValidationError(
      '必须给 items（batch：material + rubric + items + type）或 questions（mixed：material + questions）其中之一。',
      { kind: 'mode_missing' },
    );
  }
  if (hasItems) {
    // noul 没有标签集：批量 noul 给 criteria 是无意义的（它返回一个概率，不是标签）。
    if (type === 'noul' && criteria !== undefined && criteria !== null) {
      throw new DecisionValidationError(
        'type: noul 时不接受 criteria（noul 返回一个概率，没有标签集）。'
        + '可行动项：去掉 criteria；若要 false/true 的题面描述，请改用 mixed 模式（questions 里逐题写）。',
        { kind: 'criteria_not_allowed' },
      );
    }
    if (!Array.isArray(items)) {
      throw new DecisionValidationError(`items 必须是数组（收到 ${describe(items)}）。`, { kind: 'mode_invalid' });
    }
    if (items.length < 1 || items.length > LIMITS.maxItems) {
      throw new DecisionValidationError(
        `items 有 ${items.length} 项，合法范围 1–${LIMITS.maxItems}；请拆分或减少项数。`,
        { kind: 'mode_invalid' },
      );
    }
    if (typeof rubric !== 'string' || rubric.trim() === '') {
      throw new DecisionValidationError(
        'batch 模式必须给 rubric：对 N 项**共享**的那一条判据，只写一次（wire 层会替模型重复它）。',
        { kind: 'mode_invalid' },
      );
    }
    if (!WIRE_TYPES.includes(type)) {
      throw new DecisionValidationError(
        `batch 模式必须给 type，合法值只有 ${WIRE_TYPES.join('、')}（收到 ${JSON.stringify(type)}）。`,
        { kind: 'mode_invalid' },
      );
    }
    return 'items';
  }
  // mixed 模式的标签集**只能**写在每题自己的 criteria 里：顶层 criteria 会被复制到每个 item，
  // 而这里的每题判据各不相同 —— 出现即报错，不给「谁生效」留空间。
  if (criteria !== undefined && criteria !== null) {
    throw new DecisionValidationError(
      'criteria 只属于 batch 模式（顶层 criteria 会被复制到每个 item）；'
      + 'mixed 模式的标签集必须写在每题自己的 questions[].criteria 里。'
      + '可行动项：把 criteria 移进每个问题，或改用 batch 模式（material + rubric + items + type）。',
      { kind: 'criteria_requires_items_mode' },
    );
  }
  if (!Array.isArray(questions)) {
    throw new DecisionValidationError(`questions 必须是数组（收到 ${describe(questions)}）。`, { kind: 'mode_invalid' });
  }
  return 'questions';
}

/**
 * 批量模式的共享 `criteria` 校验。shape 规则与逐题完全相同（复用同一批校验器），
 * 故调用方只写一次、wire 层再复制到每个问题。
 *
 * @param {{ type: string, criteria?: unknown, maxChoiceOptions?: number }} input
 * @throws {DecisionValidationError}
 */
export function assertBatchCriteria({ type, criteria, maxChoiceOptions = LIMITS.maxChoiceOptions } = {}) {
  if (type === 'choice') validateChoice('criteria', criteria, maxChoiceOptions);
  else if (type === 'score') validateScore('criteria', criteria);
  else validateNoul('criteria', criteria);
}

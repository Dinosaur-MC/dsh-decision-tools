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
import { EVENT_TYPES } from './event-log.js';
import { isUnsafePath } from './source.js';

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
  /** 带图片的请求体上限：上游 `/v1/systemone` 对带图请求放宽到 32 MiB。 */
  maxImageBodyBytes: 32 * 1024 * 1024,
  /** 单次请求最多图片数（本插件策略值，不是服务端硬限）。 */
  maxImages: 8,
  /** 单张图片原始字节上限（base64 编码前）。 */
  maxImageBytes: 16 * 1024 * 1024,
  /** 单次请求图片原始字节总量上限（base64 编码前）。 */
  maxTotalImageBytes: 24 * 1024 * 1024,
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

function validateChoice(at, criteria, maxChoiceOptions, label = `${at}.criteria`) {
  // 简写：["yes","no"] ⇒ {yes:"yes",no:"no"}。对象形态仍可给每个选项写描述。
  let normalized = criteria;
  if (Array.isArray(criteria)) {
    normalized = {};
    for (const [index, entry] of criteria.entries()) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new DecisionValidationError(
          `${label}[${index}]（choice）的简写选项必须是非空字符串。`,
          { kind: 'invalid_request' },
        );
      }
      if (Object.hasOwn(normalized, entry)) {
        throw new DecisionValidationError(
          `${label}（choice）的简写选项重复：${JSON.stringify(entry)}；每个选项名必须唯一。`,
          { kind: 'invalid_request' },
        );
      }
      // 用 defineProperty 而不是 normalized[entry]：后者遇到 "__proto__" 会改原型、
      // 静默丢掉这个选项（review-api 实测 `["a","b","__proto__"]` 仍通过）。
      Object.defineProperty(normalized, entry, {
        value: entry, enumerable: true, configurable: true, writable: true,
      });
    }
  }
  if (!isPlainObject(normalized)) {
    throw new DecisionValidationError(
      `${label}（choice）必须是「选项名 → 描述」的对象，或字符串数组简写，`
      + '例如 {"billing":"Payments and refunds","bug":"Software errors"} / ["billing","bug"]。',
      { kind: 'invalid_request' },
    );
  }
  const keys = Object.keys(normalized);
  if (keys.length < LIMITS.minOptions || keys.length > maxChoiceOptions) {
    throw new DecisionValidationError(
      `${label}（choice）有 ${keys.length} 个选项，合法范围 ${LIMITS.minOptions}–${maxChoiceOptions}。`,
      { kind: 'invalid_request' },
    );
  }
  for (const key of keys) {
    if (key.trim() === '') {
      throw new DecisionValidationError(`${label}（choice）的选项名不能为空白。`, { kind: 'invalid_request' });
    }
  }
  return normalized;
}

function validateScore(at, criteria, label = `${at}.criteria`) {
  // 简写：{min:1,max:5} ⇒ ["1","2","3","4","5"]。档位数仍受 2–10 约束。
  let normalized = criteria;
  if (isPlainObject(criteria) && (Object.hasOwn(criteria, 'min') || Object.hasOwn(criteria, 'max'))) {
    const unknown = Object.keys(criteria).filter((key) => key !== 'min' && key !== 'max');
    if (unknown.length > 0) {
      throw new DecisionValidationError(
        `${label}（score）的简写只接受 min / max（多出 ${JSON.stringify(unknown)}）。`,
        { kind: 'invalid_request' },
      );
    }
    const { min, max } = criteria;
    // 不要求 min ≥ 0：数组形态允许负数标签，简写必须能表达同一组档位。
    if (!Number.isInteger(min) || !Number.isInteger(max) || max <= min) {
      throw new DecisionValidationError(
        `${label}（score）简写需要整数 min < max（收到 min=${JSON.stringify(min)}, max=${JSON.stringify(max)}）。`,
        { kind: 'invalid_request' },
      );
    }
    const count = max - min + 1;
    if (count < LIMITS.minOptions || count > LIMITS.maxScoreLevels) {
      throw new DecisionValidationError(
        `${label}（score）简写展开后有 ${count} 档，合法范围 ${LIMITS.minOptions}–${LIMITS.maxScoreLevels}。`,
        { kind: 'invalid_request' },
      );
    }
    normalized = Array.from({ length: count }, (_, index) => String(min + index));
  }
  if (!Array.isArray(normalized)) {
    throw new DecisionValidationError(
      `${label}（score）必须是由低到高排列的字符串数组，或 {min,max} 简写，`
      + '例如 ["Routine: no time pressure","Soon: a customer is inconvenienced","Immediate: a critical service is unavailable"]。',
      { kind: 'invalid_request' },
    );
  }
  if (normalized.length < LIMITS.minOptions || normalized.length > LIMITS.maxScoreLevels) {
    throw new DecisionValidationError(
      `${label}（score）有 ${normalized.length} 档，合法范围 ${LIMITS.minOptions}–${LIMITS.maxScoreLevels}。`,
      { kind: 'invalid_request' },
    );
  }
  for (const [index, entry] of normalized.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new DecisionValidationError(`${label}[${index}]（score）必须是非空字符串。`, { kind: 'invalid_request' });
    }
  }
  return normalized;
}

function validateNoul(at, criteria, label = `${at}.criteria`) {
  if (criteria === undefined) return;
  if (!isPlainObject(criteria)) {
    throw new DecisionValidationError(
      `${label}（noul）只能是 {"false": "...", "true": "..."} 这样的对象，或整体省略。`,
      { kind: 'invalid_request' },
    );
  }
  for (const [key, value] of Object.entries(criteria)) {
    if (key !== 'false' && key !== 'true') {
      throw new DecisionValidationError(
        `${label}（noul）只接受 "false" 和 "true" 两个键（收到 ${JSON.stringify(key)}）；或整体省略。`,
      { kind: 'invalid_request' },
    );
    }
    // 值也必须是**可读的描述文本**：此前只查键，`{true: 123}` 能一路进到 wire 与线上请求（审查 P3）。
    if (typeof value !== 'string' || value.trim() === '') {
      throw new DecisionValidationError(
        `${label}（noul）的 ${JSON.stringify(key)} 必须是非空字符串描述（收到 ${JSON.stringify(value)}）。`,
      { kind: 'invalid_request' },
    );
    }
  }
}

function validateQuestion(at, question, seenNames, maxChoiceOptions) {
  if (!isPlainObject(question)) {
    throw new DecisionValidationError(`${at} 必须是对象（收到 ${describe(question)}）。`, { kind: 'invalid_request' });
  }
  if (typeof question.name !== 'string' || question.name.trim() === '') {
    throw new DecisionValidationError(`${at}.name 必须是非空字符串；答案以它为键返回。`, { kind: 'invalid_request' });
  }
  if (seenNames.has(question.name)) {
    throw new DecisionValidationError(
      `问题名重复：${JSON.stringify(question.name)}；每题 name 必须唯一，否则无法区分答案。`,
      { kind: 'invalid_request' },
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
      { kind: 'invalid_request' },
    );
  }

  if (!QUESTION_TYPES.has(question.type)) {
    throw new DecisionValidationError(
      `${at}.type 是 ${JSON.stringify(question.type)}，不支持；合法值只有 ${WIRE_TYPES.join('、')}。`,
      { kind: 'invalid_request' },
    );
  }
  if (question.instructions === undefined) {
    throw new DecisionValidationError(`${at}.instructions 必填（问题要问什么）。`, { kind: 'invalid_request' });
  }

  if (question.type === 'choice') question.criteria = validateChoice(at, question.criteria, maxChoiceOptions);
  else if (question.type === 'score') question.criteria = validateScore(at, question.criteria);
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
    hints.push('模型按题数×请求体计费（本机样例 35 题 × 8076 token ≈ 282651 input_tokens）⇒ 该瘦的是重复文本而不是材料：把共享判据只写一次（放进 rubric，或压进 criteria），instructions 只留该题差异');
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
    throw new DecisionValidationError(`questions 必须是数组（收到 ${describe(questions)}）。`, { kind: 'mode_invalid' });
  }
  if (questions.length < 1 || questions.length > LIMITS.maxQuestions) {
    throw new DecisionValidationError(
      `questions 有 ${questions.length} 题，合法范围 1–${LIMITS.maxQuestions}；请拆分为多次调用。`,
      { kind: 'mode_invalid' },
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
function normalizeImagePaths(raw) {
  if (raw === undefined || raw === null) return [];
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : null;
  if (list === null) {
    throw new DecisionValidationError('material.images 必须是图片路径字符串或字符串数组。', { kind: 'material_invalid' });
  }
  if (list.length === 0) {
    throw new DecisionValidationError('material.images 不能是空数组；至少给一张图片。', { kind: 'material_invalid' });
  }
  if (list.length > LIMITS.maxImages) {
    throw new DecisionValidationError(
      `material.images 一次最多 ${LIMITS.maxImages} 张（收到 ${list.length} 张）。`,
      { kind: 'material_invalid' },
    );
  }
  return list.map((path, index) => {
    if (typeof path !== 'string' || path.trim() === '') {
      throw new DecisionValidationError(`material.images[${index}] 必须是非空路径字符串。`, { kind: 'material_invalid' });
    }
    if (isUnsafePath(path)) {
      throw new DecisionValidationError(
        `material.images[${index}] 必须是工作区根内的相对路径（拒绝绝对路径与 .. 段）：${path}`,
        { kind: 'material_invalid' },
      );
    }
    return path;
  });
}

export function normalizeMaterial(material) {
  if (typeof material === 'string') {
    if (material.trim() === '') {
      throw new DecisionValidationError('material 不能是空字符串；它就是所有判定共享的那份材料。', { kind: 'material_invalid' });
    }
    return { kind: 'inline', text: material, images: [] };
  }
  if (!isPlainObject(material)) {
    throw new DecisionValidationError(
      `material 必须是字符串（内联材料）或对象（text / file / glob / images / tool；收到 ${describe(material)}）。`,
      { kind: 'material_invalid' },
    );
  }

  // 顶层只认 text / file / glob / images（tool 在 tool.js 的委托分支单独处理）：
  // 未知键一律拒绝，避免模型写错键时被静默丢弃。
  const unknownTop = Object.keys(material).filter((key) => !['text', 'file', 'glob', 'images'].includes(key));
  if (unknownTop.length > 0) {
    throw new DecisionValidationError(
      `material 对象只接受 text / file / glob / images（多出 ${JSON.stringify(unknownTop)}）；内联材料也可直接传字符串。`,
      { kind: 'material_invalid' },
    );
  }
  const hasText = material.text !== undefined && material.text !== null;
  const hasFile = material.file !== undefined && material.file !== null;
  const hasGlob = material.glob !== undefined && material.glob !== null;
  const images = normalizeImagePaths(material.images);
  if (hasText && (hasFile || hasGlob)) {
    throw new DecisionValidationError('material 的 text 与 file / glob 只能给一个（避免「材料是哪份」有歧义）。', { kind: 'material_conflict' });
  }
  if (hasFile && hasGlob) {
    throw new DecisionValidationError('material 的 file 与 glob 只能给一个（两个都给会让「材料是哪份」有歧义）。', { kind: 'material_conflict' });
  }
  if (!hasText && !hasFile && !hasGlob && images.length === 0) {
    throw new DecisionValidationError(
      `material 对象必须含 text / file / glob / images 至少一个（收到键 ${JSON.stringify(Object.keys(material))}）。`,
      { kind: 'material_invalid' },
    );
  }
  if (hasText) {
    if (typeof material.text !== 'string' || material.text.trim() === '') {
      throw new DecisionValidationError('material.text 必须是非空字符串。', { kind: 'material_invalid' });
    }
    return { kind: 'inline', text: material.text, images };
  }
  if (hasFile) {
    const rawFile = material.file;
    const file = typeof rawFile === 'string' ? { path: rawFile } : rawFile;
    if (!isPlainObject(file)) {
      throw new DecisionValidationError(`material.file 必须是对象或字符串路径（收到 ${describe(rawFile)}）。`, { kind: 'material_invalid' });
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
    return { kind: 'file', fields: { path: file.path, startLine: file.startLine, endLine: file.endLine }, images };
  }
  if (hasGlob) {
    const rawGlob = material.glob;
    const glob = typeof rawGlob === 'string' ? { pattern: rawGlob } : rawGlob;
    if (!isPlainObject(glob)) {
      throw new DecisionValidationError(`material.glob 必须是对象或字符串模式（收到 ${describe(rawGlob)}）。`, { kind: 'material_invalid' });
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
    return { kind: 'glob', fields: { pattern: glob.pattern, limit: glob.limit }, images };
  }
  // images-only：state 为空串，图片由 wire 的 images 字段承载。
  return { kind: 'inline', text: '', images };
}

/**
 * 归一 + 读取：内联形态直接返回文本，引用形态**经注入的读取器**读盘。
 *
 * 读盘必须注入而不是在这里 import：本模块保持纯函数、零 I/O（可离线测试），
 * 而 `ctx.fs` 只在 `lib/tool.js` 里存在（本仓「唯一接触 ctx 的文件」这条边界）。
 *
 * @param {unknown} material 模型给的 `material`
 * @param {{ read?: Function, signal?: AbortSignal, cwd?: string }} [io] 读取器与读取选项
 * @returns {Promise<{ text: string, source: object|undefined, images: string[] }>} 读取器给出的 `source` 原样保留；`images` 是待读的图片路径
 * @throws {DecisionValidationError} 形状不合法，或缺少读取器
 */
export async function resolveMaterial(material, { read, signal, cwd } = {}) {
  const shape = normalizeMaterial(material);
  if (shape.kind === 'inline') return { text: shape.text, source: undefined, images: shape.images ?? [] };
  if (typeof read !== 'function') {
    throw new DecisionValidationError('读取引用式 material 需要注入读取器（本模块不做 I/O）。', { kind: 'invalid_request' });
  }
  const loaded = await read({ kind: shape.kind, ...shape.fields }, { signal, cwd });
  return { text: loaded.state, source: loaded.source, images: shape.images ?? [] };
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
  // 顶层 `type` 在 mixed 模式里此前被**静默忽略**（wire 根本不带它），而同一层的 `criteria` 会显式报错 ——
  // 同层两种严格度会让调用方以为给的是「全局题型」。统一为报错。
  if (type !== undefined && type !== null) {
    throw new DecisionValidationError(
      'type 只属于 batch 模式；mixed 模式的题型逐题写在 questions[].type 里。'
      + '可行动项：把 type 移进每个问题，或改用 batch 模式（material + rubric + items + type）。',
      { kind: 'type_requires_items_mode' },
    );
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
  // 第 4 个参数是**报错用的定位名**：批量模式下这个标签集就是顶层 `criteria` 本身，
  // 故直接报 `criteria（choice）…`，而不是把 at='criteria' 再拼一次成 `criteria.criteria`（task-14 复审 P2-1）。
  if (type === 'choice') return validateChoice('criteria', criteria, maxChoiceOptions, 'criteria');
  if (type === 'score') return validateScore('criteria', criteria, 'criteria');
  validateNoul('criteria', criteria, 'criteria');
  return criteria;
}
/**
 * Monitor 的参数面与上限（规格 `docs/superpowers/specs/2026-10-17-monitor-and-pipe-design.md` §4.1）。
 *
 * 契约要点（每一条都是用户裁定，不是实现细节）：
 *
 * - 计数按**探测结果**累加（电平口径）⇒ **不存在去抖/冷却窗**（没有 `minGapMs`；`countMode` 是存在的，见下）；
 * - 计数**不持久化**（每次运行从 0 起算）⇒ 没有 `persistCount`，也因此不需要重置通道；
 * - `at`/`atIso` 毫秒时间戳**只作记录**，不参与命中判定；
 * - `intervalMs` 由调用模型给，但生效值被抬到 `Config.minProbeIntervalMs` 之上（用户可以设下限，模型不能绕）；
 * - `timeoutMs` 被抬到 `>= intervalMs`，否则前台一次探测都跑不到就超时。
 *
 * **已删除的参数显式报错而不是静默忽略**：静默忽略会让调用方以为冷却生效了。
 */
export const MONITOR_LIMITS = Object.freeze({
  defaultProbeIntervalMs: 5000,
  minProbeIntervalMs: 1000,
  maxProbeIntervalMs: 3600000,
  defaultTimeoutMs: 120000,
  minTimeoutMs: 1000,
  maxTimeoutMs: 3600000,
  defaultTailBytes: 4096,
  maxTailBytes: 65536,
  defaultCountThreshold: 1,
  maxCountThreshold: 1000000,
  defaultCountMode: 'cumulative',
  countModes: Object.freeze(['cumulative', 'consecutive']),
  defaultNotifyEvery: 1,
  maxNotifyEvery: 1000000,
  defaultHitThreshold: 0.5,
  defaultNotifyCoalesceWindowMs: 5000,
  defaultMaxNotificationsPerMinute: 6,
  maxNotificationsPerMinute: 600,
  sourceKinds: Object.freeze(['job', 'file', 'glob', 'command', 'events']),
  modes: Object.freeze(['once', 'continuous']),
  notifyModes: Object.freeze(['none', 'inbox']),
  removedKeys: Object.freeze(['minGapMs', 'persistCount', 'resetCount']),
  allowedKeys: Object.freeze([
    'description', 'rubric', 'type', 'criteria', 'hitThreshold',
    'source', 'tailBytes', 'mode', 'intervalMs', 'timeoutMs', 'background',
    'countThreshold', 'countMode', 'notifyEvery', 'notify', 'coalesce', 'maxNotificationsPerMinute',
  ]),
});

/**
 * 上游委托的默认禁递归名单：上游工具名不得是本插件自己的工具。
 * 宿主**没有**深度护栏 —— 实测把工具委托给自己会一路递归（首版探针无限递归，只能 job_kill），
 * 所以这条限制必须由我们自己加。
 */
export const UPSTREAM_SELF_TOOLS = Object.freeze(['decision', 'monitor']);

function clampInt(value, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(Math.max(n, min), max);
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * `source` 的形状校验（Monitor 采样源）。
 * @throws {DecisionValidationError} kind 为 `source_invalid`
 */
function normalizeMonitorSource(source) {
  const kinds = MONITOR_LIMITS.sourceKinds.join('、');
  if (!isPlainObject(source)) {
    throw new DecisionValidationError(
      `source 必须是对象，例如 { kind: 'file', path: 'notes.txt' }；合法 kind：${kinds}。`,
      { kind: 'source_invalid' },
    );
  }
  const kind = source.kind;
  if (!MONITOR_LIMITS.sourceKinds.includes(kind)) {
    throw new DecisionValidationError(`source.kind 只能是 ${kinds} 之一（收到 ${describe(kind)}）。`, { kind: 'source_invalid' });
  }
  if (kind === 'job' && source.id !== undefined && (typeof source.id !== 'string' || source.id.trim() === '')) {
    throw new DecisionValidationError('source.id 必须是非空字符串（省略表示监视本会话最新的作业）。', { kind: 'source_invalid' });
  }
  // `select`/`jobKind` 由 lib/monitor.js 的 selectJobView 实现；此前白名单漏了这两个键 ⇒
  // 模型按参数面传 `select` 会得到「不接受 select」，实现成了不可达代码（真机踩到）。
  if (kind === 'job' && source.select !== undefined && source.select !== 'newest' && source.select !== 'oldest') {
    throw new DecisionValidationError('source.select 只能是 newest 或 oldest（省略时按 newest）。', { kind: 'source_invalid' });
  }
  if (kind === 'job' && source.jobKind !== undefined && (typeof source.jobKind !== 'string' || source.jobKind.trim() === '')) {
    throw new DecisionValidationError('source.jobKind 必须是非空字符串（如 monitor、pwsh、bash）。', { kind: 'source_invalid' });
  }
  if (kind === 'file' && (typeof source.path !== 'string' || source.path.trim() === '')) {
    throw new DecisionValidationError('source.kind=file 时必须给 path（工作区内相对路径）。', { kind: 'source_invalid' });
  }
  if (kind === 'glob' && (typeof source.pattern !== 'string' || source.pattern.trim() === '')) {
    throw new DecisionValidationError('source.kind=glob 时必须给 pattern，例如 docs/*.md。', { kind: 'source_invalid' });
  }
  if (kind === 'command' && !Array.isArray(source.argv)) {
    throw new DecisionValidationError('source.kind=command 时必须给 argv（字符串数组）。', { kind: 'source_invalid' });
  }
  // `events.types` 必须是**已知类型**：拼错在参数阶段就拒（而不是运行期读成「事件没发生」）。
  if (kind === 'events' && Array.isArray(source.types)) {
    for (const type of source.types) {
      if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) {
        throw new DecisionValidationError(
          `source.types 里有未知事件类型 ${JSON.stringify(type)}；合法值只有 ${EVENT_TYPES.join('、')}。`,
          { kind: 'source_invalid' },
        );
      }
    }
  }
  if (kind === 'events' && !Array.isArray(source.types)) {
    throw new DecisionValidationError('source.kind=events 时必须给 types（事件名数组，如 agent/status）。', { kind: 'source_invalid' });
  }
  const allowedByKind = {
    job: ['kind', 'id', 'select', 'jobKind'],
    file: ['kind', 'path', 'startLine', 'endLine'],
    glob: ['kind', 'pattern', 'limit'],
    command: ['kind', 'argv'],
    events: ['kind', 'types', 'limit'],
  };
  const ok = new Set(allowedByKind[kind]);
  for (const key of Object.keys(source)) {
    if (!ok.has(key)) {
      throw new DecisionValidationError(
        `source.kind=${kind} 不接受 ${key}；该 kind 的键：${[...ok].join('、')}。`,
        { kind: 'source_invalid' },
      );
    }
  }
  return { ...source };
}

/**
 * 校验并归一 Monitor 的参数。钳制**只发生在本地**并把说明放进 `clampNotes`（由工具层拼进 `notes`）。
 *
 * @param {object} args 模型给的参数
 * @param {{ config?: { minProbeIntervalMs?: number } }} [options] `minProbeIntervalMs` 来自部署配置（用户可设下限）
 * @throws {DecisionValidationError} kind 为 `monitor_invalid` 或 `source_invalid`
 */
export function validateMonitorArgs(args = {}, { config = {} } = {}) {
  if (!isPlainObject(args)) {
    throw new DecisionValidationError(`monitor 的参数必须是对象（收到 ${describe(args)}）。`, { kind: 'monitor_invalid' });
  }
  const allowed = new Set(MONITOR_LIMITS.allowedKeys);
  const removed = new Set(MONITOR_LIMITS.removedKeys);
  for (const key of Object.keys(args)) {
    if (allowed.has(key)) continue;
    if (removed.has(key)) {
      throw new DecisionValidationError(
        `${key} 不存在：Monitor 按探测结果计数（电平口径，没有冷却窗），计数也不持久化。`,
        { kind: 'monitor_invalid' },
      );
    }
    throw new DecisionValidationError(
      `monitor 不认识参数 ${key}；合法参数：${MONITOR_LIMITS.allowedKeys.join('、')}。`,
      { kind: 'monitor_invalid' },
    );
  }
  const source = normalizeMonitorSource(args.source);
  // description 是模型面的必填参数（宿主按 PARAMETERS.required 拒绝缺参调用）；这里给
  // 直接调用 startBackgroundMonitor 的装配层/测试一个无歧义回落，label 永远非空。
  const description = typeof args.description === 'string' && args.description.trim() !== ''
    ? args.description.trim().replace(/\s+/g, ' ').slice(0, 200)
    : 'monitor';
  const clampNotes = [];
  const floor = clampInt(numberOr(config.minProbeIntervalMs, MONITOR_LIMITS.minProbeIntervalMs), 1, MONITOR_LIMITS.maxProbeIntervalMs);
  const requested = clampInt(numberOr(args.intervalMs, MONITOR_LIMITS.defaultProbeIntervalMs), 1, MONITOR_LIMITS.maxProbeIntervalMs);
  const intervalMs = Math.max(requested, floor);
  if (intervalMs !== requested) {
    clampNotes.push(`intervalMs 被钳制：${requested} → ${intervalMs}（下限来自部署配置 minProbeIntervalMs=${floor}）。`);
  }
  const requestedTimeout = Math.trunc(numberOr(args.timeoutMs, MONITOR_LIMITS.defaultTimeoutMs));
  let timeoutMs = clampInt(requestedTimeout, MONITOR_LIMITS.minTimeoutMs, MONITOR_LIMITS.maxTimeoutMs);
  if (timeoutMs !== requestedTimeout) {
    clampNotes.push(`timeoutMs 被钳制：${requestedTimeout} → ${timeoutMs}（合法区间 ${MONITOR_LIMITS.minTimeoutMs}–${MONITOR_LIMITS.maxTimeoutMs} ms）。`);
  }
  if (timeoutMs < intervalMs) {
    clampNotes.push(`timeoutMs 被钳制：${timeoutMs} → ${intervalMs}（必须不小于 intervalMs，否则一次探测都跑不到）。`);
    timeoutMs = intervalMs;
  }
  const mode = args.mode === undefined ? 'once' : args.mode;
  if (!MONITOR_LIMITS.modes.includes(mode)) {
    throw new DecisionValidationError(`mode 只能是 ${MONITOR_LIMITS.modes.join(' 或 ')}（收到 ${describe(mode)}）。`, { kind: 'monitor_invalid' });
  }
  const notify = args.notify === undefined ? 'none' : args.notify;
  if (!MONITOR_LIMITS.notifyModes.includes(notify)) {
    throw new DecisionValidationError(`notify 只能是 ${MONITOR_LIMITS.notifyModes.join(' 或 ')}（收到 ${describe(notify)}）。`, { kind: 'monitor_invalid' });
  }
  // P1（审查 task-35）：`type` 只实现了 noul；choice/score 会被 decideForMonitor 吞成 errors=1 的假失败。
  // 与其留一个「参数面说能用、实际不可用」的坑，不如当场拒绝并指路。
  if (args.type !== undefined && args.type !== 'noul') {
    throw new DecisionValidationError(
      'monitor 只支持 noul 题型（命中判定读的是 P(true)）；choice/score 没有「命中」语义。'
      + '可行动项：把判据改写成 noul（是/否），或改用 decision 做 choice/score。',
      { kind: 'monitor_invalid' },
    );
  }
  const countThresholdRaw = args.countThreshold;
  if (countThresholdRaw !== undefined && (!Number.isInteger(countThresholdRaw) || countThresholdRaw < 1)) {
    throw new DecisionValidationError('countThreshold 必须是不小于 1 的整数（它是达成门槛，不是概率）。', { kind: 'monitor_invalid' });
  }
  const countThreshold = countThresholdRaw === undefined
    ? MONITOR_LIMITS.defaultCountThreshold
    : clampInt(countThresholdRaw, 1, MONITOR_LIMITS.maxCountThreshold);
  if (countThreshold !== countThresholdRaw && countThresholdRaw !== undefined) {
    clampNotes.push(`countThreshold 被钳制：${countThresholdRaw} → ${countThreshold}（上限 ${MONITOR_LIMITS.maxCountThreshold}）。`);
  }
  const countMode = args.countMode === undefined ? MONITOR_LIMITS.defaultCountMode : args.countMode;
  if (!MONITOR_LIMITS.countModes.includes(countMode)) {
    throw new DecisionValidationError(
      `countMode 只能是 ${MONITOR_LIMITS.countModes.join(' 或 ')}（收到 ${describe(countMode)}）。`,
      { kind: 'monitor_invalid' },
    );
  }
  const notifyEveryRaw = args.notifyEvery;
  if (notifyEveryRaw !== undefined && (!Number.isInteger(notifyEveryRaw) || notifyEveryRaw < 1)) {
    throw new DecisionValidationError('notifyEvery 必须是不小于 1 的整数（常驻模式每命中 N 次发一次通知）。', { kind: 'monitor_invalid' });
  }
  const notifyEvery = notifyEveryRaw === undefined
    ? MONITOR_LIMITS.defaultNotifyEvery
    : clampInt(notifyEveryRaw, 1, MONITOR_LIMITS.maxNotifyEvery);
  if (notifyEveryRaw !== undefined && notifyEvery !== notifyEveryRaw) {
    clampNotes.push(`notifyEvery 被钳制：${notifyEveryRaw} → ${notifyEvery}（上限 ${MONITOR_LIMITS.maxNotifyEvery}）。`);
  }
  let hitThreshold = MONITOR_LIMITS.defaultHitThreshold;
  if (args.hitThreshold !== undefined) {
    if (typeof args.hitThreshold !== 'number' || !Number.isFinite(args.hitThreshold)) {
      throw new DecisionValidationError('hitThreshold 必须是 0–1 之间的数字（单次判定的概率门槛，不是计数）。', { kind: 'monitor_invalid' });
    }
    hitThreshold = Math.min(Math.max(args.hitThreshold, 0), 1);
    if (hitThreshold !== args.hitThreshold) {
      clampNotes.push(`hitThreshold 被钳制：${args.hitThreshold} → ${hitThreshold}（合法范围 0–1）。`);
    }
  }
  if (args.tailBytes !== undefined && (!Number.isInteger(args.tailBytes) || args.tailBytes < 1)) {
    throw new DecisionValidationError('tailBytes 必须是不小于 1 的整数（每次采样读取的字节窗口）。', { kind: 'monitor_invalid' });
  }
  const tailBytes = args.tailBytes === undefined
    ? MONITOR_LIMITS.defaultTailBytes
    : clampInt(args.tailBytes, 1, MONITOR_LIMITS.maxTailBytes);
  if (args.tailBytes !== undefined && tailBytes !== args.tailBytes) {
    clampNotes.push(`tailBytes 被钳制：${args.tailBytes} → ${tailBytes}（上限 ${MONITOR_LIMITS.maxTailBytes}）。`);
  }
  const perMinuteDefault = clampInt(numberOr(config.maxNotificationsPerMinute, MONITOR_LIMITS.defaultMaxNotificationsPerMinute), 1, MONITOR_LIMITS.maxNotificationsPerMinute);
  const perMinuteRaw = args.maxNotificationsPerMinute === undefined ? perMinuteDefault : args.maxNotificationsPerMinute;
  if (typeof perMinuteRaw !== 'number' || !Number.isInteger(perMinuteRaw) || perMinuteRaw < 1) {
    throw new DecisionValidationError('maxNotificationsPerMinute 必须是不小于 1 的整数。', { kind: 'monitor_invalid' });
  }
  const maxNotificationsPerMinute = clampInt(perMinuteRaw, 1, MONITOR_LIMITS.maxNotificationsPerMinute);
  if (maxNotificationsPerMinute !== perMinuteRaw) {
    clampNotes.push(`maxNotificationsPerMinute 被钳制：${perMinuteRaw} → ${maxNotificationsPerMinute}（上限 ${MONITOR_LIMITS.maxNotificationsPerMinute}）。`);
  }
  for (const [key, value] of [['background', args.background], ['coalesce', args.coalesce]]) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new DecisionValidationError(`${key} 必须是布尔值（收到 ${describe(value)}）。`, { kind: 'monitor_invalid' });
    }
  }
  return {
    description,
    mode,
    source,
    intervalMs,
    timeoutMs,

    countThreshold,
    countMode,
    notifyEvery,
    hitThreshold,
    tailBytes,
    background: args.background === true,
    notify,
    coalesce: args.coalesce !== false,
    maxNotificationsPerMinute,
    coalesceWindowMs: clampInt(numberOr(config.notifyCoalesceWindowMs, MONITOR_LIMITS.defaultNotifyCoalesceWindowMs), 0, 3600000),
    clampNotes,
  };
}

/**
 * 校验并归一 `decision` 的上游委托参数（规格 §5）。
 *
 * 拒绝的两种形态：**自递归**（上游是本插件工具，宿主无深度护栏）与**静态二层嵌套**
 * （`arguments.upstream`）—— 运行期的深度计数由 `lib/pipe.js` 兜底。
 *
 * @param {unknown} upstream
 * @param {{ selfToolNames?: readonly string[] }} [options]
 * @throws {DecisionValidationError} kind 为 `upstream_invalid` 或 `upstream_self_recursion`
 */
export function validateUpstream(upstream, { selfToolNames = UPSTREAM_SELF_TOOLS } = {}) {
  if (!isPlainObject(upstream)) {
    throw new DecisionValidationError(`upstream 必须是对象，例如 { tool: 'pwsh', arguments: { command: 'npm test' } }（收到 ${describe(upstream)}）。`, { kind: 'upstream_invalid' });
  }
  for (const key of Object.keys(upstream)) {
    if (key !== 'tool' && key !== 'arguments') {
      throw new DecisionValidationError(`upstream 只接受 tool 与 arguments（收到多余键 ${key}）。`, { kind: 'upstream_invalid' });
    }
  }
  if (typeof upstream.tool !== 'string' || upstream.tool.trim() === '') {
    throw new DecisionValidationError('upstream.tool 必须是非空字符串（要委托执行的工具名，与模型可见工具同名）。', { kind: 'upstream_invalid' });
  }
  const tool = upstream.tool.trim();
  if (selfToolNames.includes(tool)) {
    throw new DecisionValidationError(
      `不能把 ${tool} 委托给 ${tool}：自递归没有宿主护栏（实测会一路递归到进程被杀），要链式判定请分两次调用。`,
      { kind: 'upstream_self_recursion' },
    );
  }
  const cargs = upstream.arguments === undefined ? {} : upstream.arguments;
  if (!isPlainObject(cargs)) {
    throw new DecisionValidationError(`upstream.arguments 必须是对象（收到 ${describe(cargs)}）。`, { kind: 'upstream_invalid' });
  }
  if (isPlainObject(cargs.upstream)) {
    throw new DecisionValidationError('upstream.arguments 里不能再放 upstream（静态二层委托被拒）。', { kind: 'upstream_invalid' });
  }
  return { tool, arguments: { ...cargs } };
}

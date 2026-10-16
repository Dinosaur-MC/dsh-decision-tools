/**
 * 线格式适配层（ADR-15）：**本文件是唯一知道 `/v1/systemone` 线格式的地方**。
 *
 * 为什么要单列一层：上游的协议细节（`questions` 是「题名 → 问题对象」的映射、
 * 每题各带 `instructions`、`criteria` 逐题复制、`keep_alive`）此前散落在
 * `validate.js` 与调用方里，改一处要动多处；而工具面（模型看到的参数）应当是**领域接口**
 * （`material` / `rubric` / `items` / `questions` / `type`），不该出现上游形状。
 *
 * **零 import、零 I/O、纯函数** —— 只做形状组装，不校验、不发请求、不读盘。
 * 校验与可行动报错在 `lib/validate.js`（那里需要 `DecisionValidationError`，
 * 本层要保持零依赖，故两者刻意分开）。
 *
 * @module dsh-decision-tools/wire
 */

/** 上游认的题型。**数值与合法清单只有这一处来源**（工具面的 `type` 参数与校验层都从这里取）。 */
export const WIRE_TYPES = Object.freeze(['choice', 'noul', 'score']);

/** 需要逐题携带 `criteria` 的题型（上游 `noul` 只接受可选的 false/true 题面）。 */
const TYPES_WITH_CRITERIA = new Set(['choice', 'score']);

/** 判据块的固定标签（r6 定稿：判据放在材料**之后**；位置会移动概率，属契约）。 */
const RUBRIC_LABEL = '判据：';

/**
 * 组装发往 `/v1/systemone` 的请求体。
 *
 * 两种模式的 `questions` 形状都收敛在这里：
 * - **批量**（给了 `items`）：`{ '<i>': { type, instructions: items[i-1] } }`，1-based 序号为键；
 *   `choice`/`score` 把调用方只写一次的 `criteria` **复制到每个问题**（上游逐题要求）。
 * - **异质**（给 `questions`）：`{ '<name>': { type, instructions, criteria? } }`。
 *   题名只作**映射键**，不再重复进值（值是上游声明的字段集合）。
 *
 * `state` = 材料 + `'\n\n'` + `'判据：'` + 判据。**没有 rubric 时原样用材料**（迁移期
 * 的旧路径逐字节不变）。判据只出现一次正是本层存在的意义：旧形状把判据抄了 N 遍。
 *
 * @param {object} input
 * @param {string|object|Array} input.material 生效材料（文本，或在旧路径下原样透传的结构化材料）
 * @param {string} [input.rubric] 批量模式的共享判据
 * @param {unknown[]} [input.items] 批量模式的待判项（每项自带完整待判对象）
 * @param {string} [input.type] 批量模式的题型（`WIRE_TYPES` 之一）
 * @param {unknown} [input.criteria] 批量模式的判据（`choice`/`score` 用；复制到每题）
 * @param {object[]} [input.questions] 异质模式的问题数组 `{ name, type, instructions, criteria? }`
 * @param {string} input.model 生效模型
 * @param {string|number} [input.keepAlive] 透传给服务端的 `keep_alive`（未设则不下发该字段）
 * @returns {{ model: string, state: unknown, questions: Record<string, object>, keep_alive?: string|number }}
 */
export function toWireRequest({
  material, rubric, items, type, criteria, questions, model, keepAlive,
} = {}) {
  const state = typeof rubric === 'string' && rubric !== ''
    ? `${material}${String.fromCharCode(10, 10)}${RUBRIC_LABEL}${rubric}`
    : material;

  const batch = Array.isArray(items) && items.length > 0;
  const questionsByName = batch
    ? Object.fromEntries(items.map((item, index) => {
      const question = { type, instructions: item };
      if (TYPES_WITH_CRITERIA.has(type) && criteria !== undefined) question.criteria = criteria;
      return [String(index + 1), question];
    }))
    : Object.fromEntries((Array.isArray(questions) ? questions : []).map((question) => [
      question.name,
      {
        type: question.type,
        instructions: question.instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      },
    ]));

  const body = { model, state, questions: questionsByName };
  if (keepAlive !== undefined) body.keep_alive = keepAlive;
  return body;
}

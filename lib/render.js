/**
 * 把 System One 的 `answers` 渲染成模型可读的紧凑文本。
 *
 * 为什么不做成 JSON：模型读逐行文本比读嵌套 JSON 更省 token 也更不易误读；
 * 概率按降序排列，让「次优选项」可见 —— 低 confidence 时的决策依据正是分布本身，
 * 而不是那个被选中的结论。完整原始值仍可通过 output.schema 取到。
 *
 * 纯函数，只产出 `{ type: 'text', text }` 形状，无 DSH 依赖。
 * @module dsh-decision-tools/render
 */

/** 数值缺失或非有限时的占位符：既不写 `undefined`，也不抛错。 */
const DASH = '—';

/** 非数组的普通对象判据（本模块零 import，故自带一份）。 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 有限数按固定小数位格式化；否则退化占位。 */
function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : DASH;
}

/** 排序键：非数值项一律排到最后，避免比较器返回 NaN 造成乱序。 */
function orderKey(value) {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** 概率按降序排成 `k=0.1234`，四位小数足够分辨；非数值项退化占位而非抛错。 */
function formatProbabilities(probabilities) {
  if (!isPlainRecord(probabilities)) return DASH;
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => orderKey(right) - orderKey(left))
    .map(([key, value]) => `${key}=${formatNumber(value, 4)}`)
    .join(', ');
}

/**
 * 每题一行。**对残缺答案必须是全函数（绝不抛错）**：宿主把 `render` 的异常包成
 * `ToolOutputError: output.render failed: …`（`dsh-tools/lib/index.js:3549-3551`），
 * 于是一次**成功**的调用会变成工具失败。而 `OUTPUT_SCHEMA` 的 `answers` 是
 * `additionalProperties: true`，残缺形状能通过前面的无损 JSON 与 schema 两段
 * —— 所以这里是唯一兜底点：缺字段一律渲染成 `—`。
 */
function formatAnswer(name, width, answer) {
  const label = name.padEnd(width);
  switch (answer?.type) {
    case 'choice':
      return `${label}  choice  ${answer.choice ?? DASH}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${formatNumber(answer.confidence, 3)}`;
    case 'noul':
      // 显式写成 P(true)：这个值是概率，不是布尔，措辞必须让模型无法误读。
      return `${label}  noul    P(true)=${formatNumber(answer.noul, 4)}`;
    case 'score': {
      const topLevel = isPlainRecord(answer.probabilities)
        ? String(Object.keys(answer.probabilities).length - 1)
        : DASH;
      return `${label}  score   ${formatNumber(answer.score, 4)} / ${topLevel}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${formatNumber(answer.confidence, 3)}`;
    }
    default:
      return `${label}  ${answer?.type ?? 'unknown'}  ${JSON.stringify(answer)}`;
  }
}

/**
 * `output.render` 的实现。
 * @param {unknown} _args 调用参数（不参与渲染）
 * @param {{ model: string, answers: Record<string, any>, usage?: { input_tokens: number, output_tokens: number } }} value 已校验的规范返回值
 * @returns {{ type: 'text', text: string }[]}
 */
export function renderAnswers(_args, value) {
  const answers = value?.answers ?? {};
  const names = Object.keys(answers);
  const width = names.reduce((max, name) => Math.max(max, name.length), 0);

  const lines = names.map((name) => formatAnswer(name, width, answers[name]));
  // 零答案时给一行明确占位：空文本与「真的没有答案」无法区分，模型会读到一个
  // 没有任何内容的工具结果。
  if (lines.length === 0) lines.push('(no answers returned)');
  if (value?.usage) {
    lines.push(`(usage: input_tokens=${value.usage.input_tokens} output_tokens=${value.usage.output_tokens})`);
  }

  // 体积口径（需求 M2）：让「这次为什么慢 / 为什么退化」可归因，也让模型看得见
  // 自己离 64 KiB 硬上限还有多远。是否告警、阈值多少属于**策略**，由工具层决定并
  // 通过 body_warning 传入；render 只呈现 —— 保持纯函数、零 import。
  if (Number.isFinite(value?.state_bytes) && Number.isFinite(value?.body_bytes)) {
    lines.push(`体积: state=${value.state_bytes}B body=${value.body_bytes}B`);
  }
  if (typeof value?.body_warning === 'string' && value.body_warning !== '') {
    lines.push(value.body_warning);
  }
  // 置信度告警（规格 §4.11）：与 body_warning 同一取向 —— **门限与文案都由工具层决定**，
  // render 只原样打印一行，保持纯函数、无策略、零 import。放在体积口径之后，让
  // 「哪些标签不可用」成为结果的最后一行（最靠近模型读到的位置）。
  if (typeof value?.confidence_warning === 'string' && value.confidence_warning !== '') {
    lines.push(value.confidence_warning);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

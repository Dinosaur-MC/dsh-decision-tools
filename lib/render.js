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

/** 概率按降序排成 `k=0.1234`，四位小数足够分辨。 */
function formatProbabilities(probabilities) {
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => right - left)
    .map(([key, value]) => `${key}=${value.toFixed(4)}`)
    .join(', ');
}

function formatAnswer(name, width, answer) {
  const label = name.padEnd(width);
  switch (answer?.type) {
    case 'choice':
      return `${label}  choice  ${answer.choice}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${answer.confidence.toFixed(3)}`;
    case 'noul':
      // 显式写成 P(true)：这个值是概率，不是布尔，措辞必须让模型无法误读。
      return `${label}  noul    P(true)=${answer.noul.toFixed(4)}`;
    case 'score': {
      const topLevel = Object.keys(answer.probabilities).length - 1;
      return `${label}  score   ${answer.score.toFixed(4)} / ${topLevel}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${answer.confidence.toFixed(3)}`;
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
  if (value?.usage) {
    lines.push(`(usage: input_tokens=${value.usage.input_tokens} output_tokens=${value.usage.output_tokens})`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

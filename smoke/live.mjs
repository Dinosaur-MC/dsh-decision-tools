#!/usr/bin/env node
/**
 * 真机冒烟：对本机 Ollama 跑一次三型混合请求，打印结论、概率、usage 与耗时。
 * 不参与 CI（需要 Ollama 在跑且已 pull 模型），也不入包。
 *
 * 用法：node smoke/live.mjs [模型名]   （默认 tev1:0.8b）
 * 退出码：0 成功；1 失败（附 Ollama 侧的 kind 与 hint，或「拿到了什么」的明确报错）。
 *
 * v3 起组装口径与工具一致：**校验层**（validateQuestions）与**线格式层**（toWireRequest）分开调用，
 * 不再经 v2 那个把两者合一的单体入口（ADR-15：线格式只有一个产地）。
 *
 * ⚠️ **2026-10-16 修「假绿」**：旧版本把 `callSystemOne` 的原始回包 `{model,answers,usage}` 直接传给
 * `renderAnswers`，而 `lib/render.js` 读的是 **五键 value 的 `value.results`** ⇒ 它**永远**打印
 * `(no results returned)` 且退出码 0、usage 一行都不打（该行自 `b418072` 起从未真正校验过）。
 * 现在：① 按五键形状组装后再渲染；② 真的断言「有答案 / 有 usage / 渲染出的不是空占位」，
 * 任一不成立即非 0 退出并说明拿到了什么。
 */
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { validateQuestions } from '../lib/validate.js';
import { toWireRequest } from '../lib/wire.js';
import { renderAnswers } from '../lib/render.js';

const model = process.argv[2] ?? 'tev1:0.8b';
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const questions = [
  {
    name: 'label',
    type: 'choice',
    instructions: 'Which label fits this ticket?',
    criteria: { billing: 'Payments and refunds', bug: 'Software errors', account: 'Login and account access' },
  },
  { name: 'refund', type: 'noul', instructions: 'Is the customer requesting a refund?' },
  {
    name: 'urgency',
    type: 'score',
    instructions: 'How urgently does this ticket need a response?',
    criteria: [
      'Routine: no time pressure',
      'Soon: a customer is inconvenienced',
      'Immediate: a critical service is unavailable',
    ],
  },
];

/** 取概率最大的键（渲染用的兜底标签）。 */
function argmaxLabel(probabilities) {
  if (typeof probabilities !== 'object' || probabilities === null) return null;
  let best = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const [key, value] of Object.entries(probabilities)) {
    if (Number.isFinite(value) && value > bestValue) { bestValue = value; best = key; }
  }
  return best;
}

/**
 * **仅供本冒烟脚本显示**：把原始 `answers` 折成五键 value 的 `results`（供 `renderAnswers` 读）。
 * 它不是第二个真源 —— 工具侧的真实组装在 `lib/tool.js` 的 `buildResult`；这里只求「真机回包能被
 * 渲染成非空结果并可见地打印出来」，从而让旧版那种假绿不可能再发生。
 */
function toDisplayResults(answers, criteriaById = {}) {
  return Object.entries(answers).map(([id, answer]) => {
    if (answer?.type === 'noul' && Number.isFinite(answer.noul)) {
      return { id, type: 'noul', value: answer.noul >= 0.5, probabilities: { true: answer.noul, false: 1 - answer.noul } };
    }
    const probabilities = answer?.probabilities;
    let label = typeof answer?.choice === 'string' && answer.choice !== '' ? answer.choice : argmaxLabel(probabilities);
    // score 的概率键是 0..N-1 下标；工具层会把下标翻成档位标签（lib/tool.js 的 bestLabel），这里照做。
    const criteria = criteriaById[id];
    if (answer?.type === 'score' && Array.isArray(criteria)) {
      const index = Number.parseInt(label, 10);
      if (Number.isInteger(index) && index >= 0 && index < criteria.length) label = criteria[index];
    }
    const value = label;
    const entry = { id, type: answer?.type ?? 'unknown', value: value ?? null };
    if (probabilities !== undefined) entry.probabilities = probabilities;
    if (Number.isFinite(answer?.confidence)) entry.confidence = answer.confidence;
    return entry;
  });
}

validateQuestions(questions);
const body = toWireRequest({
  material: 'Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.',
  questions,
  model,
});

console.log(`model   : ${model}`);
console.log(`baseUrl : ${baseUrl}`);
const started = Date.now();
try {
  const raw = await callSystemOne({ baseUrl, body, timeoutMs: 180000 });
  const elapsed = Date.now() - started;

  const criteriaById = Object.fromEntries(questions.map((question) => [question.name, question.criteria]));
  const results = toDisplayResults(raw.answers ?? {}, criteriaById);
  const value = {
    results,
    coverage: {
      requested: results.length,
      answered: results.filter((entry) => entry.value !== null && entry.value !== undefined).length,
      batches: 1,
      truncated: false,
      truncatedBy: null,
      failed: 0,
      aborted: false,
    },
    material: { source: 'inline', bytes: Buffer.byteLength(String(body.state), 'utf8') },
    cost: {
      model: raw.model ?? model,
      inputTokens: Number.isFinite(raw.usage?.input_tokens) ? raw.usage.input_tokens : null,
      bodyBytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
      wallMs: elapsed,
      escalated: false,
      attempts: [{ model: raw.model ?? model, failureKind: null }],
    },
    notes: [`模型选择：${raw.model ?? model}（冒烟脚本显式指定）。`],
  };
  const text = renderAnswers({}, value)[0].text;

  // ---- 真的断言：这是「假绿」的直接守卫 ----
  const problems = [];
  if (results.length === 0) problems.push('服务端没有返回任何 answers');
  if (!Number.isFinite(raw.usage?.input_tokens)) problems.push('回包里没有 usage.input_tokens（计费口径必须可见）');
  if (text.includes('(no results returned)')) problems.push('渲染出 0 条结果 —— 五键形状没组装对（历史假绿）');
  if (text.includes('undefined') || text.includes('NaN')) problems.push(`渲染文本里有 undefined/NaN：${text}`);
  if (problems.length > 0) {
    console.error('FAILED: 真机回包未通过冒烟断言');
    console.error(`problems: ${problems.join(' | ')}`);
    console.error('raw answers keys: ' + JSON.stringify(Object.keys(raw.answers ?? {})));
    console.error('raw usage: ' + JSON.stringify(raw.usage));
    console.error(text);
    process.exit(1);
  }

  console.log(`elapsed : ${elapsed} ms`);
  console.log('usage   : ' + JSON.stringify(raw.usage));
  console.log('---');
  console.log(text);
} catch (error) {
  const elapsed = Date.now() - started;
  console.error(`FAILED after ${elapsed} ms`);
  if (error instanceof SystemOneError) {
    console.error(`kind: ${error.kind}`);
    console.error(`message: ${error.message}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}

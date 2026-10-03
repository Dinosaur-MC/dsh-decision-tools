#!/usr/bin/env node
/**
 * 真机冒烟：对本机 Ollama 跑一次三型混合请求，打印结论、概率与耗时。
 * 不参与 CI（需要 Ollama 在跑且已 pull 模型），也不入包。
 *
 * 用法：node smoke/live.mjs [模型名]   （默认 tev1:0.8b）
 * 退出码：0 成功；1 失败（附 Ollama 侧的 kind 与 hint）。
 */
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { prepareRequest } from '../lib/validate.js';
import { renderAnswers } from '../lib/render.js';

const model = process.argv[2] ?? 'tev1:0.8b';
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const body = prepareRequest({
  defaultModel: model,
  state: 'Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.',
  questions: [
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
  ],
});

console.log(`model   : ${model}`);
console.log(`baseUrl : ${baseUrl}`);
const started = Date.now();
try {
  const value = await callSystemOne({ baseUrl, body, timeoutMs: 180000 });
  const elapsed = Date.now() - started;
  console.log(`elapsed : ${elapsed} ms`);
  console.log('---');
  console.log(renderAnswers(body, value)[0].text);
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

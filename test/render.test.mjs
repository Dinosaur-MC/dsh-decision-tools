import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnswers } from '../lib/render.js';

/** 取出渲染出的纯文本。 */
function textOf(value) {
  const blocks = renderAnswers({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  return blocks[0].text;
}

const USAGE = { input_tokens: 799, output_tokens: 4 };

test('choice：给出结论、降序概率与 confidence', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      label: {
        type: 'choice',
        choice: 'bug',
        probabilities: { billing: 0.0063, bug: 0.9593, account: 0.0343 },
        confidence: 0.8292,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^label\s+choice\s+bug\s+p=\{bug=0\.9593, account=0\.0343, billing=0\.0063\}\s+conf=0\.829$/m);
  assert.match(text, /usage: input_tokens=799 output_tokens=4/);
});

test('noul：渲染成 P(true) 数值而不是布尔字面量', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: { refund: { type: 'noul', noul: 0.47510873373302426 } },
    usage: USAGE,
  });
  // 整行逐字比对：既能证明保留了 4 位小数，也能证明没有退化成 true/false。
  assert.equal(text.split('\n')[0], 'refund  noul    P(true)=0.4751');
});

test('score：显示 x / (N-1)，概率按档位下标降序', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      urgency: {
        type: 'score',
        score: 1.1542321654504228,
        legend: { 0: 'Routine', 1: 'Soon', 2: 'Immediate' },
        probabilities: { 0: 0.0691, 1: 0.7075, 2: 0.2234 },
        confidence: 0.3043,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^urgency\s+score\s+1\.1542 \/ 2\s+p=\{1=0\.7075, 2=0\.2234, 0=0\.0691\}\s+conf=0\.304$/m);
});

test('多题：每题一行，名字按最长者对齐', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      a: { type: 'noul', noul: 0.5 },
      longer: { type: 'noul', noul: 0.25 },
    },
    usage: USAGE,
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'a       noul    P(true)=0.5000');
  assert.equal(lines[1], 'longer  noul    P(true)=0.2500');
});

test('没有 usage 时不渲染 usage 行', () => {
  const text = textOf({ model: 'tev1:0.8b', answers: { q: { type: 'noul', noul: 1 } } });
  assert.equal(text, 'q  noul    P(true)=1.0000');
});

test('未知答案类型不炸，退化为 JSON', () => {
  const text = textOf({ model: 'm', answers: { q: { type: 'mystery', value: 1 } } });
  assert.match(text, /q\s+mystery/);
  assert.match(text, /"value":1/);
});

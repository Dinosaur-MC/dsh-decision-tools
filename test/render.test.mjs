import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnswers } from '../lib/render.js';

/** 取出渲染出的纯文本（本层恒为单个 text 块）。 */
function textOf(value, skill) {
  const blocks = renderAnswers({}, value, skill);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  return blocks[0].text;
}

/** ADR-13 的规范返回值：三种题型 + 全套元信息（用于逐字全文断言）。 */
const CANON = {
  results: [
    { id: 'label', type: 'choice', value: 'bug',
      probabilities: { billing: 0.0063, bug: 0.9593, account: 0.0343 }, confidence: 0.8292 },
    { id: 'refund', type: 'noul', value: false,
      probabilities: { true: 0.47510873373302426, false: 0.5248912662669757 } },
    { id: 'urgency', type: 'score', value: 'Soon',
      probabilities: { 0: 0.0691, 1: 0.7075, 2: 0.2234 }, confidence: 0.3043 },
  ],
  coverage: { requested: 3, answered: 3, batches: 1, truncated: false, truncatedBy: null, failed: 0, aborted: false },
  material: { source: 'file', bytes: 300,
    descriptor: { kind: 'file', path: 'docs/spec.md', bytes: 300, startLine: 1, endLine: 20, lines: 20 } },
  cost: { model: 'tev1:0.8b', inputTokens: 799, bodyBytes: 682, wallMs: 97, escalated: false,
    attempts: [{ model: 'tev1:0.8b', failureKind: null }] },
  notes: ['模型选择：tev1:0.8b（fits-default）。'],
};

test('五键齐全时逐字全文：results 逐项 + coverage/material/cost + notes 原样', () => {
  assert.equal(textOf(CANON), [
    'label    choice  bug  p={bug=0.9593, account=0.0343, billing=0.0063}  conf=0.829',
    'refund   noul    P(true)=0.4751',
    'urgency  score   Soon  p={1=0.7075, 2=0.2234, 0=0.0691}  conf=0.304',
    '覆盖: requested=3 answered=3 batches=1 truncated=false failed=0 aborted=false',
    '材料: file docs/spec.md L1-20（300B，不进上下文）',
    'cost: model=tev1:0.8b input_tokens=799 body=682B wall=97ms escalated=false attempts=1',
    '模型选择：tev1:0.8b（fits-default）。',
  ].join('\n'));
});

test('choice：所选标签 + 降序概率 + confidence', () => {
  const [row] = textOf({ results: [CANON.results[0]] }).split('\n');
  assert.equal(row, 'label  choice  bug  p={bug=0.9593, account=0.0343, billing=0.0063}  conf=0.829');
});

test('noul：只打 P(true)（取自 probabilities.true），不打布尔 value', () => {
  const [row] = textOf({ results: [CANON.results[1]] }).split('\n');
  assert.equal(row, 'refund  noul    P(true)=0.4751');
  assert.equal(row.includes(' false'), false, '布尔 value 不得出现在渲染里（它会让模型把概率读成判定）');
  assert.equal(row.includes('value='), false, '不得回显 value 字段本身');
});

test('score：value 是档位标签；概率键是 0..N-1 下标（不折算均值）', () => {
  const [row] = textOf({ results: [CANON.results[2]] }).split('\n');
  assert.equal(row, 'urgency  score   Soon  p={1=0.7075, 2=0.2234, 0=0.0691}  conf=0.304');
});

test('多结果：id 按最长者对齐', () => {
  const text = textOf({ results: [
    { id: 'a', type: 'noul', value: true, probabilities: { true: 0.5, false: 0.5 } },
    { id: 'longer', type: 'noul', value: false, probabilities: { true: 0.25, false: 0.75 } },
  ] });
  assert.equal(text, ['a       noul    P(true)=0.5000', 'longer  noul    P(true)=0.2500'].join('\n'));
});

test('未答项（value:null、无 probabilities）逐项占位，且严格保持 results 顺序', () => {
  const text = textOf({
    results: [
      { id: 'ok', type: 'noul', value: true, probabilities: { true: 0.9, false: 0.1 } },
      { id: 'missing', type: 'noul', value: null },
      { id: 'gone', type: 'choice', value: null },
    ],
    coverage: { requested: 3, answered: 1, batches: 1, truncated: false, truncatedBy: null, failed: 2, aborted: false },
  });
  assert.equal(text.split('\n').slice(0, 3).join('\n'), [
    'ok       noul    P(true)=0.9000',
    'missing  noul    (no answer)',
    'gone     choice  (no answer)',
  ].join('\n'));
  assert.match(text, /^覆盖: requested=3 answered=1 .*failed=2 aborted=false$/m);
});

test('coverage：truncatedBy 只在截断时出现；缺失字段退化成 —', () => {
  const cut = textOf({ coverage: { requested: 5, answered: 4, batches: 2, truncated: true, truncatedBy: 'chunks', failed: 1, aborted: false } });
  assert.match(cut, /^覆盖: requested=5 answered=4 batches=2 truncated=true\(by=chunks\) failed=1 aborted=false$/m);
  const bare = textOf({ coverage: {} });
  assert.match(bare, /^覆盖: requested=— answered=— batches=— truncated=— failed=— aborted=—$/m);
});

test('material：inline / file / glob 三种形状各自渲染，glob 不得按 file 形状渲染', () => {
  assert.match(textOf({ material: { source: 'inline', bytes: 113 } }), /^材料: inline（113B，不进上下文）$/m);
  assert.match(textOf({ material: CANON.material }), /^材料: file docs\/spec\.md L1-20（300B，不进上下文）$/m);
  assert.match(textOf({ material: { source: 'glob', bytes: 5123, descriptor: { kind: 'glob', pattern: 'docs/**/*.md', files: ['a.md', 'b.md'], bytes: 5123, truncated: true, remaining: 2 } } }),
    /^材料: glob docs\/\*\*\/\*\.md（2 个文件，已截断）（5123B，不进上下文）$/m);
  assert.match(textOf({ material: { source: 'glob', bytes: 10, descriptor: { kind: 'glob', pattern: 'p', files: [], bytes: 10, truncated: false, remaining: 0 } } }),
    /^材料: glob p（0 个文件）（10B，不进上下文）$/m);
});

test('cost：升档时附「尝试」一行（成功项 failureKind=null 渲染成 ok）', () => {
  const one = textOf({ cost: { model: 'tev1:0.8b', inputTokens: 10, bodyBytes: 20, wallMs: 5, escalated: false, attempts: [{ model: 'tev1:0.8b', failureKind: null }] } });
  assert.match(one, /^cost: model=tev1:0\.8b input_tokens=10 body=20B wall=5ms escalated=false attempts=1$/m);
  assert.doesNotMatch(one, /尝试:/);
  const two = textOf({ cost: { model: 'nimble-v3:latest', inputTokens: 30, bodyBytes: 40, wallMs: 9, escalated: true,
    attempts: [{ model: 'tev1:0.8b', failureKind: 'context_overflow' }, { model: 'nimble-v3:latest', failureKind: null }] } });
  assert.equal(two, [
    '(no results returned)',
    'cost: model=nimble-v3:latest input_tokens=30 body=40B wall=9ms escalated=true attempts=2',
    '尝试: tev1:0.8b(context_overflow) → nimble-v3:latest(ok)',
  ].join('\n'));
});

test('notes 原样逐行输出、保持顺序，排在元信息之后、配套 skill 之前', () => {
  const text = textOf({
    results: [{ id: 'q', type: 'noul', value: true, probabilities: { true: 1, false: 0 } }],
    cost: { model: 'm', inputTokens: 1, bodyBytes: 2, wallMs: 3, escalated: false, attempts: [] },
    notes: ['模型选择：m（fits-default）。', '体积归因：…', 'confidence 告警：以下 1 题…'],
  }, 'SKILL BODY');
  const lines = text.split('\n');
  assert.deepEqual(lines.slice(1, 4), ['cost: model=m input_tokens=1 body=2B wall=3ms escalated=false attempts=0', '模型选择：m（fits-default）。', '体积归因：…']);
  assert.equal(lines[4], 'confidence 告警：以下 1 题…');
  assert.deepEqual(lines.slice(5), ['', '=== companion skill: how to read these values ===', 'SKILL BODY']);
});

test('notes 里的空串与缺键同义：不得打出空行', () => {
  const withEmpty = textOf({ notes: ['a', '', 'b'] });
  const without = textOf({ notes: ['a', 'b'] });
  assert.equal(withEmpty, without);
  assert.equal(withEmpty, '(no results returned)\na\nb');
});

test('notes 里的非字符串项按 String(note) 落进文本、null/undefined 跳过（该分支此前删掉也不红）', () => {
  // task-12 复审的定点变异实证：删掉 lib/render.js:182-184 的 else-if 分支后 render 仍 16/16 绿。
  // schema 已限 notes: string[]，故这是防御分支；但「没守卫」意味着它可以被静默删除 —— 本用例钉住它。
  const text = textOf({ notes: [42, null, { a: 1 }, undefined, true, ''] });
  assert.equal(text, ['(no results returned)', '42', '[object Object]', 'true'].join('\n'),
    '{} 按 String() 落成 [object Object]；null/undefined/空串走跳过语义');
  assert.doesNotThrow(() => textOf({ notes: [[1, 2], Symbol('s')] }));
});

test('零结果给明确占位行，而不是空文本；占位后仍照常输出元信息', () => {
  assert.equal(textOf({ results: [] }), '(no results returned)');
  assert.equal(textOf({}), '(no results returned)');
  assert.equal(textOf({ results: [], coverage: { requested: 0, answered: 0, batches: 0 } }),
    ['(no results returned)', '覆盖: requested=0 answered=0 batches=0 truncated=— failed=— aborted=—'].join('\n'));
});

test('全函数：残缺 / 异形 value 一律不抛（宿主会把异常变成工具失败）', () => {
  const odd = [
    { results: [null, 42, 'x'] },
    { results: [{ id: 7, type: 'mystery', value: { a: 1 } }] },
    { results: [{ type: 'choice' }] },
    { results: [{ id: 'q', type: 'choice', value: 'a', probabilities: { a: 0.9, b: 'oops', c: 0.1 }, confidence: 0.5 }] },
    { results: [{ id: 'q', type: 'score', value: 2, probabilities: null }] },
    { coverage: 'nope', material: 5, cost: [], notes: 'x' },
    { results: [{ id: 'q', type: 'choice', value: 'a', probabilities: { a: null } }] },
  ];
  for (const value of odd) assert.equal(typeof textOf(value), 'string');
  assert.match(textOf({ results: [{ id: 'q', type: 'choice', value: 'a', probabilities: { a: 0.9, b: 'oops', c: 0.1 } }] }),
    /^q  choice  a  p=\{a=0\.9000, c=0\.1000, b=—\}  conf=—$/m);
  assert.equal(textOf({ results: [{ id: 'q', type: 'mystery', value: { a: 1 } }] }), 'q  mystery  {"id":"q","type":"mystery","value":{"a":1}}');
  assert.match(textOf({ results: [42] }), /^—  unknown  42$/m);
  assert.match(textOf({ results: [{ id: 'q', type: 'score', value: 2, probabilities: null }] }), /^q  score   2  p=\{—\}  conf=—$/m);
});

test('缺失数值退化占位符而不是字面 undefined/NaN', () => {
  const text = textOf({ results: [
    { id: 'a', type: 'choice', value: 'bug' },
    { id: 'b', type: 'noul', value: true },
    { id: 'c', type: 'score', value: 'high' },
  ] });
  assert.equal(text, [
    'a  choice  bug  p={—}  conf=—',
    'b  noul    P(true)=—',
    'c  score   high  p={—}  conf=—',
  ].join('\n'));
  assert.equal(/undefined|NaN/.test(text), false);
});

test('§4.8 承重断言：render 不自行判断阈值 —— 低 confidence 且 notes 为空时逐字全文里没有告警', () => {
  const value = {
    results: [{ id: 'q', type: 'choice', value: 'bug', probabilities: { bug: 0.5, x: 0.5 }, confidence: 0.01 }],
    notes: [],
  };
  assert.equal(textOf(value), 'q  choice  bug  p={bug=0.5000, x=0.5000}  conf=0.010');
  const huge = { ...value, material: { source: 'inline', bytes: 1e9 },
    cost: { model: 'm', inputTokens: 1, bodyBytes: 1e15, wallMs: 1, escalated: false, attempts: [] } };
  assert.doesNotMatch(textOf(huge), /超过建议|告警/);
});

test('companion skill：给了正文才附，且附在最后；没给/空白时不得出现标题行', () => {
  assert.equal(textOf({ results: [] }, 'BODY'), '(no results returned)\n\n=== companion skill: how to read these values ===\nBODY');
  assert.doesNotMatch(textOf({ results: [] }), /companion skill/);
  assert.doesNotMatch(textOf({ results: [] }, '   '), /companion skill/);
  assert.doesNotMatch(textOf({ results: [] }, ''), /companion skill/);
});

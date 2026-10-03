import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest, DecisionValidationError, LIMITS } from '../lib/validate.js';

const TICKET = 'Our checkout has returned 500 errors since 9am.';
const CHOICE_Q = {
  name: 'label',
  type: 'choice',
  instructions: 'Which label fits this ticket?',
  criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
};

/** 一个最小合法请求。 */
function base(overrides = {}) {
  return {
    state: TICKET,
    questions: [CHOICE_Q],
    defaultModel: 'tev1:0.8b',
    ...overrides,
  };
}

/** 断言被拒，并且消息里含指定模式。 */
function expectReject(args, matcher) {
  assert.throws(() => prepareRequest(args), (error) => {
    assert.ok(
      error instanceof DecisionValidationError,
      `期望 DecisionValidationError，实际得到 ${error?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, matcher);
    return true;
  });
}

test('合法请求返回 body，且只带服务端认识的字段', () => {
  assert.deepEqual(prepareRequest(base()), {
    model: 'tev1:0.8b',
    state: TICKET,
    questions: [CHOICE_Q],
  });
});

test('model 参数覆盖 defaultModel；keepAlive 存在时下发 keep_alive', () => {
  assert.equal(prepareRequest(base({ model: 'tev1:latest' })).model, 'tev1:latest');
  assert.equal(prepareRequest(base({ keepAlive: '5m' })).keep_alive, '5m');
  assert.equal('keep_alive' in prepareRequest(base()), false);
});

test('V9 model 必须是非空字符串', () => {
  expectReject(base({ defaultModel: undefined }), /model 必须是非空字符串/);
  expectReject(base({ model: '' }), /model 必须是非空字符串/);
});

test('state 接受字符串/对象/数组，拒绝空串与标量', () => {
  assert.doesNotThrow(() => prepareRequest(base({ state: { ticket: TICKET } })));
  assert.doesNotThrow(() => prepareRequest(base({ state: [{ id: 1 }] })));
  expectReject(base({ state: '   ' }), /state 不能是空字符串/);
  expectReject(base({ state: 42 }), /state 必须是字符串、对象或数组/);
});

test('V1 questions 数量 1–64，且必须是数组', () => {
  const noul = (i) => ({ name: `q${i}`, type: 'noul', instructions: 'Is this English?' });
  assert.doesNotThrow(() => prepareRequest(base({ questions: Array.from({ length: 64 }, (_, i) => noul(i)) })));
  expectReject(base({ questions: Array.from({ length: 65 }, (_, i) => noul(i)) }), /questions 有 65 题/);
  expectReject(base({ questions: [] }), /questions 有 0 题/);
  expectReject(base({ questions: 'nope' }), /questions 必须是数组/);
});

test('V2 问题名必须非空且唯一', () => {
  expectReject(
    base({ questions: [CHOICE_Q, { ...CHOICE_Q }] }),
    /问题名重复：\"label\"/,
  );
  expectReject(
    base({ questions: [{ name: '  ', type: 'noul', instructions: 'x' }] }),
    /name 必须是非空字符串/,
  );
});

test('V3 类型只接受 choice / noul / score', () => {
  expectReject(
    base({ questions: [{ name: 'a', type: 'boolean', instructions: 'x' }] }),
    /合法值只有 choice、noul、score/,
  );
});

test('V4 choice 选项数 2–26，且必须是对象', () => {
  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `desc ${i}`]));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(26) }] })));
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(1) }] }), /有 1 个选项，合法范围 2–26/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(27) }] }), /有 27 个选项，合法范围 2–26/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: ['a', 'b'] }] }), /必须是「选项名 → 描述」的对象/);
});

test('V5/V6 score 必须是由低到高的字符串数组，长度 2–26', () => {
  const score = (criteria) => ({ name: 's', type: 'score', instructions: 'How urgent?', criteria });
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(['low', 'high'])] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(Array.from({ length: 26 }, (_, i) => `lv${i}`))] })));
  expectReject(base({ questions: [score(['only'])] }), /有 1 档，合法范围 2–26/);
  expectReject(base({ questions: [score(Array.from({ length: 27 }, (_, i) => `lv${i}`))] }), /有 27 档，合法范围 2–26/);
  expectReject(base({ questions: [score({ 0: 'low', 1: 'high' })] }), /必须是由低到高排列的字符串数组/);
  expectReject(base({ questions: [score(['low', '  '])] }), /criteria\[1\]（score）必须是非空字符串/);
});

test('V7 noul 的 criteria 只接受 false/true 键，或整体省略', () => {
  const noul = (criteria) => ({ name: 'n', type: 'noul', instructions: 'Is it?', ...(criteria === undefined ? {} : { criteria }) });
  assert.doesNotThrow(() => prepareRequest(base({ questions: [noul()] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [noul({ false: 'No', true: 'Yes' })] })));
  expectReject(base({ questions: [noul({ no: 'No', yes: 'Yes' })] }), /只接受 "false" 和 "true" 两个键/);
  expectReject(base({ questions: [noul(['No', 'Yes'])] }), /只能是 \{"false"/);
});

test('instructions 必填', () => {
  expectReject(base({ questions: [{ name: 'x', type: 'noul' }] }), /instructions 必填/);
});

test('V8 边界：正好 65536 字节通过，再多 1 字节被拒', () => {
  // 与 prepareRequest 组装出的 body 逐字段一致，才能精确落在边界上。
  const overhead = (n) => Buffer.byteLength(JSON.stringify({
    model: 'tev1:0.8b',
    state: 'x'.repeat(n),
    questions: [CHOICE_Q],
  }), 'utf8');

  let lo = 0;
  let hi = 70000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (overhead(mid) <= LIMITS.maxBodyBytes) lo = mid;
    else hi = mid - 1;
  }
  assert.ok(overhead(lo) <= LIMITS.maxBodyBytes);
  assert.ok(overhead(lo + 1) > LIMITS.maxBodyBytes);

  assert.doesNotThrow(() => prepareRequest(base({ state: 'x'.repeat(lo) })));
  expectReject(base({ state: 'x'.repeat(lo + 1) }), /请求体 \d+ 字节，超过服务端上限 65536 字节；/);
});

test('LIMITS 与服务端文档一致', () => {
  assert.deepEqual(LIMITS, { maxQuestions: 64, minOptions: 2, maxOptions: 26, maxBodyBytes: 65536 });
});

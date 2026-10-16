import {
  test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest,
  DecisionValidationError,
  LIMITS,
  analyzeBody,
  resolveStrategy,
} from '../lib/validate.js';

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
  // ADR-15：题名只作**映射的键**，值里只有上游声明的字段（不再把整个问题对象塞进去）。
  assert.deepEqual(prepareRequest(base()), {
    model: 'tev1:0.8b',
    state: TICKET,
    questions: {
      label: {
        type: 'choice',
        instructions: 'Which label fits this ticket?',
        criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
      },
    },
  });
});

test('V10 线格式：questions 被转成「题名 → 问题对象」的映射，不是数组（ADR-6）', () => {
  // 本机实测：数组形状被服务端在**解析阶段**拒绝（HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"，0.071s 返回），
  // 对象形状才 200。这条用例是那个真机事实在本地套件里的落点。
  const body = prepareRequest(base({
    questions: [
      { name: 'a', type: 'noul', instructions: 'First?' },
      { name: 'b', type: 'noul', instructions: 'Second?' },
    ],
  }));
  assert.equal(Array.isArray(body.questions), false, 'questions 不能是数组');
  assert.equal(typeof body.questions, 'object');
  assert.deepEqual(Object.keys(body.questions), ['a', 'b'], '键为题名，且保持模型给的顺序');
  assert.equal(body.questions.a.instructions, 'First?');
  assert.equal(body.questions.b.instructions, 'Second?');
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

test('V4 choice 选项数 2–255（服务端按模型可放宽），且必须是对象', () => {
  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `desc ${i}`]));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(26) }] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(255) }] })),
    '255 是 OpenAPI 的 maxProperties，也是本机实测上限（256 才 400）');
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(1) }] }), /有 1 个选项，合法范围 2–255/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(256) }] }), /有 256 个选项，合法范围 2–255/);
  // 覆盖点：OpenAPI 明说 "The option limit depends on the model"，故上限可配。
  assert.doesNotThrow(() => prepareRequest(base({
    questions: [{ ...CHOICE_Q, criteria: opts(30) }], maxChoiceOptions: 30,
  })));
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(31) }], maxChoiceOptions: 30 }),
    /有 31 个选项，合法范围 2–30/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: ['a', 'b'] }] }), /必须是「选项名 → 描述」的对象/);
});

test('V5/V6 score 必须是由低到高的字符串数组，长度 2–10（与 choice 的 255 无关）', () => {
  const score = (criteria) => ({ name: 's', type: 'score', instructions: 'How urgent?', criteria });
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(['low', 'high'])] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(Array.from({ length: 10 }, (_, i) => `lv${i}`))] })));
  expectReject(base({ questions: [score(['only'])] }), /有 1 档，合法范围 2–10/);
  expectReject(base({ questions: [score(Array.from({ length: 11 }, (_, i) => `lv${i}`))] }), /有 11 档，合法范围 2–10/);
  // ★ 回归：11–26 档曾因与 choice 共用 maxOptions=26 而被本地**放行**，
  // 直到服务端才 400 `score criteria must be an array of 2–10 levels`。
  expectReject(base({ questions: [score(Array.from({ length: 26 }, (_, i) => `lv${i}`))] }),
    /有 26 档，合法范围 2–10/, '26 档必须在本地被拦，不得发往服务端');
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
  // 注意 questions 必须是 V10/ADR-15 转换后的**对象映射**形状，且值里**没有** `name`
  // （题名只是映射的键）—— 用数组或整个问题对象会让这个 helper 与真实 body 长度不同，
  // 二分会落在错的边界上（该测试本就用于探测 body 形状漂移）。
  const overhead = (n) => Buffer.byteLength(JSON.stringify({
    model: 'tev1:0.8b',
    state: 'x'.repeat(n),
    questions: { label: { type: 'choice', instructions: 'Which label fits this ticket?', criteria: { billing: 'Payments and refunds', bug: 'Software errors' } } },
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
  expectReject(base({ state: 'x'.repeat(lo + 1) }), /请求体 \d+ 字节，超过服务端上限 65536 字节（64 KiB）；请缩减 state/);
});

test('LIMITS 冻结：服务端硬限 + 本地阈值（体积/置信度/引用式读取/扫描预算）', () => {
  // softBodyBytes 不是服务端限制，是本地的**策略**阈值（非实测退化点）；
  // 它同样被逐字锁定，避免有人顺手调小/调大而不留痕。
  // minConfidence 同理是**策略**阈值：它只决定 `confidence_warning` 那一行，不改变任何
  // 拒绝行为；0.25 的标定样本（4 题 × 6 个候选排列）与其三条已知局限同样写在该常量注释里。
  //
  // maxChoiceOptions 与 maxScoreLevels **必须分开**（2026-10-15 修正）：服务端对二者是
  // 独立约束 —— OpenAPI 写 choice `maxProperties: 255`（且注明 "The option limit depends
  // on the model"）、score `maxItems: 10`。修正前是单个 `maxOptions: 26`，两个方向都错。
  assert.deepEqual(LIMITS, {
    maxQuestions: 64,
    minOptions: 2,
    maxChoiceOptions: 255,
    maxScoreLevels: 10,
    maxBodyBytes: 65536,
    // v2 新增（ADR-7 / ADR-9）：引用式读取上限 + 扫描的三重预算与自适应轮数。
    // maxSourceBytes 必须 < maxBodyBytes（65536），否则 state 会先被 body 守卫拒掉。
    maxSourceBytes: 61440,
    scanMaxChunks: 32,
    scanMaxTotalBytes: 4194304,
    scanDeadlineMs: 180000,
    scanMaxAdaptRounds: 2,
    softBodyBytes: 4096,
    minConfidence: 0.25,
  });
});

test('V2 续：题名不得为纯数字串（纯数字会被 JS 对象映射重排，破坏有序批量语义）', () => {
  expectReject(
    base({ questions: [{ name: '1', type: 'noul', instructions: 'x' }] }),
    /不能是纯数字[\s\S]*请改用 q1/,
  );
  // 非纯数字题名不受影响。注意本规则比实际的「整数索引键」集合略宽
  // （"01" 其实不会被重排，这里同样会拒），宁可多拒也不错排。
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ name: '1a', type: 'noul', instructions: 'x' }] })));
});

test('analyzeBody：把请求体归因到材料与问题文本，并识别逐字重复的判据', () => {
  const rubric = '这段判据很长'.repeat(20);
  const questions = [1, 2, 3, 4].map((n) => ({ name: 'r' + n, type: 'noul', instructions: rubric }));
  const out = analyzeBody('short material', questions);
  assert.equal(out.stateBytes, 14);
  assert.ok(out.questionBytes > out.stateBytes, '问题文本远大于材料');
  assert.equal(out.repeatedQuestions, 3, '4 题逐字相同 ⇒ 3 题是重复的');
  assert.ok(out.repeatedBytes > 0);
  assert.match(out.hint, /只写一次/, '必须给出可行动建议');
  assert.ok(out.questionShare > 0.5);
  const clean = analyzeBody('x'.repeat(200), [{ name: 'a', type: 'noul', instructions: 'one' }, { name: 'b', type: 'noul', instructions: 'two' }, { name: 'c', type: 'noul', instructions: 'three' }]);
  assert.equal(clean.hint, null, '材料占多数且无重复 ⇒ 不出提示');
});
test('resolveStrategy：scan 要求字符串 state，否则给结构化错误（r7 P0）', () => {
  // 旧实现不校验这一条：scan + 结构化 state 会一路走到 chunk() 的 text.split 上，
  // 抛一个没有 kind 的裸 TypeError（调用方拿不到判据，也看不到可行做法）。
  assert.throws(() => resolveStrategy({ strategy: 'scan' }, { a: 1 }), (error) => {
    assert.equal(error.name, 'DecisionValidationError');
    assert.equal(error.kind, 'scan_requires_text_state');
    assert.match(error.message, /字符串/, '消息要说清 scan 要的是文本');
    assert.match(error.message, /stateSource/, '消息必须给出可行做法');
    return true;
  });
  assert.equal(resolveStrategy({ strategy: 'scan' }, 'text'), 'scan', '字符串材料照常扫描');
  // 非 scan 时结构化 state 不归这里管（由 prepareRequest 的 state 校验负责）。
  assert.equal(resolveStrategy({ strategy: 'auto' }, { a: 1 }), 'auto');
  assert.equal(resolveStrategy({}, undefined), 'auto', '缺省策略仍是 auto');
  assert.throws(() => resolveStrategy({ strategy: 'chunk' }, 'text'),
    (error) => error.kind === 'invalid_request');
});
import {
  test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionValidationError,
  LIMITS,
  analyzeBody,
  validateQuestions,
  DEPTHS,
  resolveDepth,
  normalizeMaterial,
  resolveMaterial,
  assertModeExclusive,
  assertBatchCriteria,
} from '../lib/validate.js';
import { toWireRequest } from '../lib/wire.js';

const TICKET = 'Our checkout has returned 500 errors since 9am.';
const CHOICE_Q = {
  name: 'label',
  type: 'choice',
  instructions: 'Which label fits this ticket?',
  criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
};

/**
 * 一个最小合法题目集（v3：校验层的入口是 validateQuestions，材料由 material 层归一）。
 * maxChoiceOptions 保留成可覆盖项，供 V4 的「上限可配」用例。
 */
function base(overrides = {}) {
  return {
    questions: [CHOICE_Q],
    maxChoiceOptions: LIMITS.maxChoiceOptions,
    ...overrides,
  };
}

/**
 * 走**仍在生产使用**的校验入口（validateQuestions）。v2 那个把「校验 + 组装 body」合一的
 * 单体入口已删除：body 组装归 lib/wire.js、64 KiB 守卫归 lib/tool.js，故本文件保留的全部
 * 断言都只依赖逐题校验这一层。
 */
function validateRequest(request) {
  validateQuestions(request.questions, { maxChoiceOptions: request.maxChoiceOptions });
}

/** 断言被拒，并且消息里含指定模式。第三个参数是 `{ kind }`（缺省 invalid_request）；
 *  传字符串时按旧用法忽略（历史调用里有把说明文字放第三位的）。 */
function expectReject(args, matcher, options = {}) {
  const kind = options !== null && typeof options === 'object' && typeof options.kind === 'string' ? options.kind : 'invalid_request';
  assert.throws(() => validateRequest(args), (error) => {
    assert.ok(
      error instanceof DecisionValidationError,
      `期望 DecisionValidationError，实际得到 ${error?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, kind, '错误 kind 是契约的一部分');
    assert.match(error.message, matcher);
    return true;
  });
}


test('V10 线格式：questions 被转成「题名 → 问题对象」的映射，不是数组（ADR-6 / ADR-15）', () => {
  // 本机实测：数组形状被服务端在**解析阶段**拒绝（HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"，0.071s 返回），
  // 对象形状才 200。这条用例是那个真机事实在本地套件里的落点。
  const body = toWireRequest({
    material: TICKET,
    model: 'tev1:0.8b',
    questions: [
      { name: 'a', type: 'noul', instructions: 'First?' },
      { name: 'b', type: 'noul', instructions: 'Second?' },
    ],
  });
  assert.equal(Array.isArray(body.questions), false, 'questions 不能是数组');
  assert.equal(typeof body.questions, 'object');
  assert.deepEqual(Object.keys(body.questions), ['a', 'b'], '键为题名，且保持模型给的顺序');
  assert.equal(body.questions.a.instructions, 'First?');
  assert.equal(body.questions.b.instructions, 'Second?');
});


test('V1 questions 数量 1–64，且必须是数组', () => {
  const noul = (i) => ({ name: `q${i}`, type: 'noul', instructions: 'Is this English?' });
  assert.doesNotThrow(() => validateRequest(base({ questions: Array.from({ length: 64 }, (_, i) => noul(i)) })));
  // 数量与形态属于**模式约束** ⇒ kind=mode_invalid（与 batch 模式 items 超限同口径）。
  expectReject(base({ questions: Array.from({ length: 65 }, (_, i) => noul(i)) }), /questions 有 65 题/, { kind: 'mode_invalid' });
  expectReject(base({ questions: [] }), /questions 有 0 题/, { kind: 'mode_invalid' });
  expectReject(base({ questions: 'nope' }), /questions 必须是数组/, { kind: 'mode_invalid' });
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

test('V4 choice 选项数 2–255（服务端按模型可放宽）；对象或 string[] 简写', () => {
  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `desc ${i}`]));
  assert.doesNotThrow(() => validateRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(26) }] })));
  assert.doesNotThrow(() => validateRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(255) }] })),
    '255 是 OpenAPI 的 maxProperties，也是本机实测上限（256 才 400）');
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(1) }] }), /有 1 个选项，合法范围 2–255/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(256) }] }), /有 256 个选项，合法范围 2–255/);
  // 覆盖点：OpenAPI 明说 "The option limit depends on the model"，故上限可配。
  assert.doesNotThrow(() => validateRequest(base({
    questions: [{ ...CHOICE_Q, criteria: opts(30) }], maxChoiceOptions: 30,
  })));
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(31) }], maxChoiceOptions: 30 }),
    /有 31 个选项，合法范围 2–30/);
  assert.doesNotThrow(() => validateRequest(base({ questions: [{ ...CHOICE_Q, criteria: ['a', 'b'] }] })));
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: ['a', 'a'] }] }), /重复/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: ['a', ''] }] }), /非空字符串/);
});

test('V5/V6 score 必须是由低到高的字符串数组，长度 2–10（与 choice 的 255 无关）', () => {
  const score = (criteria) => ({ name: 's', type: 'score', instructions: 'How urgent?', criteria });
  assert.doesNotThrow(() => validateRequest(base({ questions: [score(['low', 'high'])] })));
  assert.doesNotThrow(() => validateRequest(base({ questions: [score(Array.from({ length: 10 }, (_, i) => `lv${i}`))] })));
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
  assert.doesNotThrow(() => validateRequest(base({ questions: [noul()] })));
  assert.doesNotThrow(() => validateRequest(base({ questions: [noul({ false: 'No', true: 'Yes' })] })));
  expectReject(base({ questions: [noul({ no: 'No', yes: 'Yes' })] }), /只接受 "false" 和 "true" 两个键/);
  expectReject(base({ questions: [noul(['No', 'Yes'])] }), /只能是 \{"false"/);
});

test('instructions 必填', () => {
  expectReject(base({ questions: [{ name: 'x', type: 'noul' }] }), /instructions 必填/);
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
    // 批量模式的上限与 maxQuestions 同值（两种模式最终都编码成同样多个问题）。
    maxItems: 64,
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
  assert.doesNotThrow(() => validateRequest(base({ questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] })));
  assert.doesNotThrow(() => validateRequest(base({ questions: [{ name: '1a', type: 'noul', instructions: 'x' }] })));
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

test('assertModeExclusive：两模式互斥（同给 mode_conflict、都不给 mode_missing）', () => {
  const items = ['甲'];
  const questions = [{ name: 'q', type: 'noul', instructions: 'x' }];
  assert.throws(() => assertModeExclusive({ items, questions, rubric: 'r', type: 'noul' }), (error) => {
    assert.equal(error.name, 'DecisionValidationError');
    assert.equal(error.kind, 'mode_conflict');
    return true;
  });
  assert.throws(() => assertModeExclusive({}), (error) => {
    assert.equal(error.kind, 'mode_missing');
    assert.match(error.message, /items/, '消息必须给出两种可行写法');
    assert.match(error.message, /questions/);
    return true;
  });
  assert.equal(assertModeExclusive({ items, rubric: '共享判据', type: 'noul' }), 'items');
  assert.equal(assertModeExclusive({ questions }), 'questions');
  // batch 模式的必给字段（schema 里不写模式分支，故这里是唯一把关点）。
  assert.throws(() => assertModeExclusive({ items }), (error) => error.kind === 'mode_invalid');
  assert.throws(() => assertModeExclusive({ items, rubric: '   ', type: 'noul' }),
    (error) => error.kind === 'mode_invalid');
  assert.throws(() => assertModeExclusive({ items, rubric: 'r', type: 'boolean' }),
    (error) => error.kind === 'mode_invalid' && /合法值只有/.test(error.message));
  // items 超过上限（= 64）报错，边界 64 放行。
  const many = (n) => Array.from({ length: n }, (_, i) => 'i' + i);
  assert.equal(assertModeExclusive({ items: many(64), rubric: 'r', type: 'noul' }), 'items');
  assert.throws(() => assertModeExclusive({ items: many(65), rubric: 'r', type: 'noul' }),
    (error) => error.kind === 'mode_invalid' && /65 项/.test(error.message));

  // criteria 的模式归属（lead 2026-10-16 追认为契约）：batch 用**顶层** criteria（wire 层复制到每题）；
  // mixed 模式的标签集只能写在每题自己的 criteria 里，出现顶层即报错；noul 没有标签集。
  assert.equal(assertModeExclusive({ items, rubric: 'r', type: 'choice', criteria: { a: 'A', b: 'B' } }), 'items');
  assert.throws(() => assertModeExclusive({ questions, criteria: { a: 'A', b: 'B' } }),
    (error) => error.kind === 'criteria_requires_items_mode' && /每题自己的 questions\[\]\.criteria/.test(error.message));
  assert.throws(() => assertModeExclusive({ items, rubric: 'r', type: 'noul', criteria: { false: '否', true: '是' } }),
    (error) => error.kind === 'criteria_not_allowed');
});

test('resolveDepth：缺省 normal，非法值报错并给出合法清单', () => {
  assert.equal(resolveDepth(undefined), 'normal');
  assert.equal(resolveDepth(null), 'normal');
  assert.equal(resolveDepth('quick'), 'quick');
  assert.equal(resolveDepth('deep'), 'deep');
  assert.throws(() => resolveDepth('scan'), (error) => {
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, /quick \/ normal \/ deep/, '必须给出合法值清单');
    return true;
  });
});

test('analyzeBody 的模型可见提示只称 v3 参数名（rubric，不再是已删除的 state）', () => {
  const questions = ['同一句', '同一句', '同一句'].map((text, index) => ({ name: `q${index}`, type: 'noul', instructions: text }));
  const out = analyzeBody('材料', questions);
  assert.ok(out.hint !== null, '反空转：重复题面必须触发提示');
  assert.match(out.hint, /instructions 与其它题逐字相同/, '反空转：确认走的是「重复文本」这条分支');
  assert.match(out.hint, /放进 rubric/, '修复后的 v3 指向');
  assert.doesNotMatch(out.hint, /\bstate\b/, 'v3 工具面八键里没有 state —— 模型照着改参只会再失败一次');
});

test('normalizeMaterial：内联 / file / glob 三形态归一，形状错误给结构化拒绝', () => {
  assert.deepEqual(normalizeMaterial('材料'), { kind: 'inline', text: '材料' });
  assert.deepEqual(normalizeMaterial({ file: { path: 'docs/a.md', startLine: 2, endLine: 3 } }),
    { kind: 'file', fields: { path: 'docs/a.md', startLine: 2, endLine: 3 } });
  assert.deepEqual(normalizeMaterial({ glob: { pattern: 'docs/*.md', limit: 5 } }),
    { kind: 'glob', fields: { pattern: 'docs/*.md', limit: 5 } });
  assert.throws(() => normalizeMaterial(''), (error) => error.kind === 'material_invalid');
  assert.throws(() => normalizeMaterial(42), (error) => error.kind === 'material_invalid');
  assert.throws(() => normalizeMaterial({}), (error) => error.kind === 'material_invalid');
  assert.throws(() => normalizeMaterial({ file: { path: 'a' }, glob: { pattern: 'b' } }),
    (error) => error.kind === 'material_conflict');
  assert.throws(() => normalizeMaterial({ file: { path: '' } }),
    (error) => error.kind === 'material_invalid' && /path/.test(error.message));
  assert.throws(() => normalizeMaterial({ glob: { pattern: 'a', kind: 'file' } }),
    (error) => error.kind === 'material_invalid' && /只接受 pattern \/ limit/.test(error.message));
});

test('resolveMaterial：内联不读盘；引用形态交给注入的读取器（本模块零 I/O）', async () => {
  const inline = await resolveMaterial('内联', { read: () => { throw new Error('不该被调用'); } });
  assert.deepEqual(inline, { text: '内联', source: undefined });

  const calls = [];
  const read = async (descriptor, options) => {
    calls.push({ descriptor, options });
    return { state: '读到的正文', source: { kind: 'file', path: descriptor.path, bytes: 15 } };
  };
  const loaded = await resolveMaterial({ file: { path: 'docs/a.md' } }, { read, cwd: 'F:/ws', signal: undefined });
  assert.equal(loaded.text, '读到的正文');
  assert.equal(loaded.source.path, 'docs/a.md');
  assert.deepEqual(calls[0].descriptor, { kind: 'file', path: 'docs/a.md', startLine: undefined, endLine: undefined });
  assert.equal(calls[0].options.cwd, 'F:/ws');
  await assert.rejects(() => resolveMaterial({ glob: { pattern: '*.md' } }, {}),
    (error) => error.kind === 'invalid_request');
});

test('assertBatchCriteria：批量模式的共享 criteria 复用逐题校验器', () => {
  assert.doesNotThrow(() => assertBatchCriteria({ type: 'choice', criteria: { a: 'A', b: 'B' } }));
  assert.doesNotThrow(() => assertBatchCriteria({ type: 'score', criteria: ['低', '高'] }));
  assert.doesNotThrow(() => assertBatchCriteria({ type: 'noul', criteria: { false: '否', true: '是' } }));
  assert.throws(() => assertBatchCriteria({ type: 'choice', criteria: { a: 'A' } }), /合法范围 2–255/);
  assert.throws(() => assertBatchCriteria({ type: 'score', criteria: ['低'] }), /合法范围 2–10/);
  assert.throws(() => assertBatchCriteria({ type: 'noul', criteria: { no: '否' } }), /只接受 "false" 和 "true"/);
});

// ---- task-14 复审 P2-1 / P2-7 的守卫（2026-10-16）----

test('批量 criteria 的报错定位是 criteria（…），不得再拼成 criteria.criteria', () => {
  const cases = [
    [() => assertBatchCriteria({ type: 'choice', criteria: { a: 'A' } }), /^criteria（choice）有 1 个选项，合法范围 2–255。/],
    [() => assertBatchCriteria({ type: 'score', criteria: ['低'] }), /^criteria（score）有 1 档，合法范围 2–10。/],
    [() => assertBatchCriteria({ type: 'noul', criteria: { no: '否' } }), /^criteria（noul）只接受 "false" 和 "true"/],
  ];
  for (const [fn, re] of cases) {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    assert.ok(error !== null, '必须报错');
    assert.match(error.message, re);
    assert.doesNotMatch(error.message, /criteria\.criteria/, '顶层 criteria 不得被报成 criteria.criteria');
  }
  // 逐题（mixed）模式的定位保持不变：questions[0].criteria（choice）…
  // 逐题（mixed）模式的定位保持不变：questions[0].criteria（choice）…（用谓词，避免 assert.throws
  // 把正则作用在 `String(error)` 的类名前缀上）。
  assert.throws(
    () => validateQuestions([{ name: 'q1', type: 'choice', instructions: 'x', criteria: { a: 'A' } }]),
    (error) => {
      assert.match(error.message, /^questions\[0\]\.criteria（choice）有 1 个选项/);
      return true;
    },
  );
});

test('normalizeMaterial：顶层未知键 fail-closed（不再静默丢弃），合法形状不受影响', () => {
  assert.throws(() => normalizeMaterial({ file: { path: 'a.txt' }, extra: 1 }), (error) => {
    assert.equal(error.kind, 'material_invalid');
    assert.match(error.message, /只接受 file 或 glob/);
    assert.match(error.message, /"extra"/);
    return true;
  });
  assert.throws(() => normalizeMaterial({ glob: { pattern: 'a/*' }, stateSource: {} }), /只接受 file 或 glob/);
  assert.deepEqual(normalizeMaterial({ file: { path: 'a.txt', startLine: 1, endLine: 3 } }),
    { kind: 'file', fields: { path: 'a.txt', startLine: 1, endLine: 3 } });
  assert.deepEqual(normalizeMaterial('材料'), { kind: 'inline', text: '材料' });
});
// ——— Monitor 与上游委托管道（规格 2026-10-17）———
import { validateMonitorArgs, validateUpstream, MONITOR_LIMITS } from '../lib/validate.js';

const M_SRC = { kind: 'file', path: 'notes.txt' };

test('monitor：intervalMs 被抬到配置下限并给出钳制说明', () => {
  const r = validateMonitorArgs(
    { rubric: '材料里是否出现了目标事件', source: M_SRC, intervalMs: 10 },
    { config: { minProbeIntervalMs: 1000 } },
  );
  assert.equal(r.intervalMs, 1000);
  assert.ok(r.clampNotes.some((n) => n.includes('intervalMs')), '必须说明发生了钳制');
});

test('monitor：timeoutMs 小于 intervalMs 时被抬到 intervalMs 并说明', () => {
  const r = validateMonitorArgs({ rubric: 'x', source: M_SRC, intervalMs: 5000, timeoutMs: 1000 });
  assert.equal(r.intervalMs, 5000);
  assert.equal(r.timeoutMs, 5000);
  assert.ok(r.clampNotes.some((n) => n.includes('timeoutMs')));
});

test('monitor：未知 source.kind 报错并列合法值', () => {
  assert.throws(
    () => validateMonitorArgs({ rubric: 'x', source: { kind: 'nope' } }),
    (e) => e.kind === 'source_invalid' && /job/.test(e.message) && /glob/.test(e.message),
  );
});

test('monitor：已删除的四个参数被显式拒绝（无 CD / 电平计数 / 不持久化）', () => {
  for (const k of ['minGapMs', 'countMode', 'persistCount', 'resetCount']) {
    assert.throws(
      () => validateMonitorArgs({ rubric: 'x', source: M_SRC, [k]: 1 }),
      (e) => e.kind === 'monitor_invalid' && e.message.includes(k) && e.message.includes('不存在'),
      '参数 ' + k + ' 必须被拒绝而不是静默忽略',
    );
  }
});

test('monitor：默认值符合规格（5s 间隔 / 120s 超时 / 计数阈值 1 / 不通知）', () => {
  const r = validateMonitorArgs({ rubric: 'x', source: { kind: 'job', id: 'job-1' } });
  assert.equal(r.intervalMs, MONITOR_LIMITS.defaultProbeIntervalMs);
  assert.equal(r.timeoutMs, MONITOR_LIMITS.defaultTimeoutMs);
  assert.equal(r.countThreshold, 1);
  assert.equal(r.notify, 'none');
  assert.equal(r.mode, 'once');
  assert.equal(r.tailBytes, MONITOR_LIMITS.defaultTailBytes);
});

test('monitor：countThreshold 必须是不小于 1 的整数', () => {
  for (const bad of [0, -1, 1.5, '3']) {
    assert.throws(() => validateMonitorArgs({ rubric: 'x', source: M_SRC, countThreshold: bad }), (e) => e.kind === 'monitor_invalid');
  }
});

test('upstream：缺 tool 或 tool 为空白时报错', () => {
  for (const bad of [undefined, {}, { tool: '  ' }, { tool: 7 }]) {
    assert.throws(() => validateUpstream(bad), (e) => e.kind === 'upstream_invalid');
  }
});

test('upstream：自递归被拒（上游工具名是本插件工具）', () => {
  assert.throws(
    () => validateUpstream({ tool: 'decision' }),
    (e) => e.kind === 'upstream_self_recursion' && e.message.includes('decision'),
  );
  assert.throws(() => validateUpstream({ tool: 'monitor' }), (e) => e.kind === 'upstream_self_recursion');
});

test('upstream：静态二层嵌套被拒，正常调用被归一', () => {
  assert.throws(() => validateUpstream({ tool: 'pwsh', arguments: { upstream: { tool: 'pwsh' } } }), (e) => e.kind === 'upstream_invalid');
  const r = validateUpstream({ tool: ' pwsh ', arguments: { command: 'echo hi' } });
  assert.equal(r.tool, 'pwsh');
  assert.deepEqual(r.arguments, { command: 'echo hi' });
});
test('monitor：严格化后的参数不许静默降级', () => {
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: M_SRC, hitThreshold: '0.9' }), (e) => e.kind === 'monitor_invalid');
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: M_SRC, background: 'true' }), (e) => e.kind === 'monitor_invalid');
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: M_SRC, coalesce: 0 }), (e) => e.kind === 'monitor_invalid');
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: M_SRC, tailBytes: 1.5 }), (e) => e.kind === 'monitor_invalid');
  assert.throws(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a', bogus: 1 } }), (e) => e.kind === 'source_invalid');
  const big = validateMonitorArgs({ rubric: 'x', source: M_SRC, countThreshold: 1e9, tailBytes: 1e9, hitThreshold: 5 });
  assert.equal(big.countThreshold, MONITOR_LIMITS.maxCountThreshold);
  assert.equal(big.tailBytes, MONITOR_LIMITS.maxTailBytes);
  assert.equal(big.hitThreshold, 1);
  assert.equal(big.clampNotes.length, 3, '三处钳制都必须留痕');
});

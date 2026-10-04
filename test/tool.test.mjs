import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { resolveSoftBodyBytes } from '../lib/tool.js';
import { TOOL_DESCRIPTION } from '../lib/parameters.js';
import { LIMITS } from '../lib/validate.js';
import { startFakeOllama } from './fake-ollama.mjs';

/**
 * 计数口径（各文件用例数；改动本文件时必须同步更新 —— 用例**总数**没有任何自动核对，
 * 但「README 配置表键集/顺序 == Config 投影」这条不变量自 2026-10-04 起由
 * `test/parameters.test.mjs` 的 `README 的配置表键集与顺序…` 一条自动守卫）：
 * `validate 15 + render 9 + client 14 + parameters 3 + tool 7 = 48`
 * → 2026-10-04 本文件新增 3 条（可配置的体积告警），此后为
 * `validate 15 + render 9 + client 14 + parameters 3 + tool 10 = 51`
 * → 同日 `parameters.test.mjs` 新增 1 条（README 配置表守卫），此后为
 * `validate 15 + render 9 + client 14 + parameters 4 + tool 10 = 52`
 * → 同日 `5df48a1` 给 `parameters.test.mjs` 补九条逐点锚点（+9），此后为
 * `validate 15 + render 9 + client 14 + parameters 13 + tool 10 = 61`
 * → 同日缺陷审查轮修复（F1/F2/F3），此后为
 * `validate 15 + render 12 + client 19 + parameters 13 + tool 13 = 72`。
 */

/**
 * 一个够用的假 ctx：**刻意只提供 tools**。
 * 本插件不注册 prompt 段（ADR-5），所以缺少 systemPrompt 时 apply 必须照常工作 ——
 * 这个假 ctx 本身就是那条不变量的守卫：一旦有人再加回 systemPrompt 调用，测试会直接崩。
 */
function fakeCtx() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
    },
  };
}

const ANSWERS = {
  model: 'tev1:0.8b',
  answers: { label: { type: 'choice', choice: 'bug', probabilities: { bug: 1 }, confidence: 1 } },
  usage: { input_tokens: 12, output_tokens: 1 },
};

test('插件导出形状与默认配置', () => {
  assert.equal(name, 'decision-tools');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Config({}), {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'tev1:0.8b',
    timeoutMs: 120000,
    toolName: 'decision',
  });
});

test('默认 toolName 配置下的工具名与 schema', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({}));

  assert.equal(registered.length, 1);
  const definition = registered[0];
  assert.equal(definition.name, 'decision');

  // 注意：defineTool 会把 DSL 投影成 JSON Schema 再放回 definition.parameters
  // （宿主定义文件 index.js:848 `parameterSchemaSpecToJsonSchema(options.parameters)`），
  // 所以参数名在 `.properties` 上，`required` 是根上的数组而非逐属性注解。
  assert.deepEqual(Object.keys(definition.parameters), ['type', 'properties', 'required']);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['state', 'questions', 'model']);
  assert.deepEqual(definition.parameters.required, ['state', 'questions']);

  // ADR-5 的就地守卫：使用指引必须真的挂在已注册的工具上（而不是只写在模块里）。
  assert.equal(definition.description, TOOL_DESCRIPTION);

  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(definition.output.schema.properties),
    ['model', 'answers', 'usage', 'state_bytes', 'body_bytes', 'body_warning'],
  );
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
});

test('toolName 配置改变工具名', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({ toolName: 'decide' }));
  assert.equal(registered[0].name, 'decide');
});

test('execute 打到 /v1/systemone 并原样返回 answers', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));

    const value = await registered[0].execute(
      { state: 'x', questions: [{ name: 'label', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );

    // 返回值 = 客户端结果 + 本插件自己产出的体积字段（需求 M2），故逐字段比对。
    assert.equal(value.model, ANSWERS.model);
    assert.deepEqual(value.answers, ANSWERS.answers);
    assert.deepEqual(value.usage, ANSWERS.usage);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/v1/systemone');
    assert.equal(fake.requests[0].json.model, 'tev1:0.8b');

    // 体积可归因：必须按**转换后的线格式**度量，与 V8 的硬守卫同一口径 ——
    // 所以直接和该次真实请求体的字节数比对（比「存在且为数值」强）。
    assert.equal(typeof value.state_bytes, 'number');
    assert.equal(typeof value.body_bytes, 'number');
    assert.equal(value.state_bytes, Buffer.byteLength('x', 'utf8'));
    assert.equal(value.body_bytes, Buffer.byteLength(fake.requests[0].raw, 'utf8'));

    // 小 state 下不得出现告警键：宿主要求返回值是无损 JSON 值，undefined 字段会拒绝。
    assert.equal('body_warning' in value, false);
  } finally {
    await fake.close();
  }

  // 同源的第二条：服务端回包**不含 usage** 时，返回值里也**不得出现** usage 键。
  // 宿主对每个成功返回值跑 snapshotJsonValue，值为 `undefined` 的 own key 会让它判定
  // 「不是无损 JSON」并抛 ToolOutputError —— 于是一次完全成功的调用被报成工具失败。
  // 因此这里用一个只有 model/answers 的回包驱动一次真实往返（同一用例，不新增用例）。
  const noUsage = await startFakeOllama(() => ({
    status: 200,
    body: { model: ANSWERS.model, answers: ANSWERS.answers },
  }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: noUsage.baseUrl }));

    const value = await registered[0].execute(
      { state: 'x', questions: [{ name: 'label', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );

    assert.equal('usage' in value, false);
    assert.equal('body_warning' in value, false);
  } finally {
    await noUsage.close();
  }
});

test('execute 的本地校验错误不会发出网络请求', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));

    const error = await registered[0]
      .execute({ state: 'x', questions: [] }, { signal: undefined })
      .then(() => null, (e) => e);

    assert.equal(error.name, 'DecisionValidationError');
    assert.match(error.message, /questions 有 0 题/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('execute 把服务端错误映射成 SystemOneError', async () => {
  const fake = await startFakeOllama(() => ({ status: 404, body: { error: 'model not found' } }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));

    const error = await registered[0]
      .execute({ state: 'x', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] }, { signal: undefined })
      .then(() => null, (e) => e);

    assert.equal(error.name, 'SystemOneError');
    assert.equal(error.kind, 'model_missing');
  } finally {
    await fake.close();
  }
});

/**
 * 一个 body 确实**越过默认软阈值**（`LIMITS.softBodyBytes`）的 payload：5000 字节 state。
 * 三条新用例共用它，且各自都断言 `body_bytes > LIMITS.softBodyBytes` —— 否则"没有告警"
 * 这类否定式断言会静默退化成恒真，无法区分"开关关了"与"从来没到过阈值"。
 */
const BIG_ARGS = {
  state: 'x'.repeat(5000),
  questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }],
};

/** 走真实注册路径：apply(Config(...)) 之后调用已注册工具的 execute。 */
async function executeWith(baseUrl, config, args) {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({ baseUrl, ...config }));
  return registered[0].execute(args, { signal: undefined });
}

test('softBodyBytes 配置改变告警出现的位置（阈值两侧，经 execute 验证）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const run = (config) => executeWith(fake.baseUrl, config, BIG_ARGS);

    const byDefault = await run({});
    const lowThreshold = await run({ softBodyBytes: 2000 });
    const highThreshold = await run({ softBodyBytes: 20000 });

    // 同一 payload、同一假服务端：三次 execute 度到的 body 必须逐字节一致，
    // 否则"阈值两侧"的对比不成立。
    assert.equal(byDefault.body_bytes, lowThreshold.body_bytes);
    assert.equal(lowThreshold.body_bytes, highThreshold.body_bytes);
    // 承重前提：该 payload 必须高于默认阈值，否则本用例静默退化成恒真。
    assert.ok(
      byDefault.body_bytes > LIMITS.softBodyBytes,
      `fixture body ${byDefault.body_bytes} 必须高于 softBodyBytes ${LIMITS.softBodyBytes}`,
    );

    // 未设 ⇒ 回落到 LIMITS.softBodyBytes（该默认值只有 validate.js 一处来源）。
    assert.equal('body_warning' in byDefault, true);
    assert.match(
      byDefault.body_warning,
      new RegExp(`已超过建议的 ${LIMITS.softBodyBytes} 字节`),
    );

    // 自定义阈值的**下方**（2000 < body）：告警，且文案引用的是配置值而非默认值。
    assert.equal('body_warning' in lowThreshold, true);
    assert.match(lowThreshold.body_warning, /已超过建议的 2000 字节/);

    // 自定义阈值的**上方**（20000 > body）：同一个 body 却没有告警。
    assert.equal('body_warning' in highThreshold, false);
    assert.equal(highThreshold.body_warning, undefined);
  } finally {
    await fake.close();
  }
});

test('bodyWarning: false 时任何体积都不产出 body_warning 键（经 execute 验证）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const run = (config) => executeWith(fake.baseUrl, config, BIG_ARGS);

    const off = await run({ bodyWarning: false });
    // 承重前提：关掉开关时 body 仍远高于阈值，故"键不存在"只可能来自开关。
    assert.ok(
      off.body_bytes > LIMITS.softBodyBytes,
      `fixture body ${off.body_bytes} 必须高于 softBodyBytes ${LIMITS.softBodyBytes}`,
    );
    assert.equal('body_warning' in off, false);
    // 也不得退化成 `false` 或空串：宿主按无损失 JSON 校验，schema 里它是 string。
    assert.equal(off.body_warning, undefined);

    // 未设与显式 true 都必须**照常告警** —— 否则"关闭"可能只是"从来没告警过"。
    assert.equal('body_warning' in await run({}), true);
    assert.equal('body_warning' in await run({ bodyWarning: true }), true);
  } finally {
    await fake.close();
  }
});

test('absurd softBodyBytes（1e9）被静默钳到 maxBodyBytes，行为等同上限', async () => {
  // 机制断言：钳制在 execute 层面**几乎不可观测**（任何 ≥ maxBodyBytes 的阈值都不会
  // 触发告警，因为 prepareRequest 先按同一字节数拒绝），所以"生效值"本身是这条规则
  // 唯一的承重点 —— 少了它，一个"完全不钳制"的实现也能通过下面全部断言。
  assert.equal(resolveSoftBodyBytes(1e9), LIMITS.maxBodyBytes);
  assert.equal(resolveSoftBodyBytes(LIMITS.maxBodyBytes + 1), LIMITS.maxBodyBytes);
  // 钳制只在顶端：未越上限的值必须原样通过。
  assert.equal(resolveSoftBodyBytes(2000), 2000);
  // 未设 ⇒ 回落 LIMITS.softBodyBytes。
  assert.equal(resolveSoftBodyBytes(undefined), LIMITS.softBodyBytes);

  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const absurd = await executeWith(fake.baseUrl, { softBodyBytes: 1e9 }, BIG_ARGS);
    const atCap = await executeWith(
      fake.baseUrl,
      { softBodyBytes: LIMITS.maxBodyBytes },
      BIG_ARGS,
    );

    // execute 层面：1e9 的结果与显式 maxBodyBytes **完全相同**（同一 payload 下都不告警），
    // 即它被折到上限，而不是按 1e9 的原值另走一条路。
    assert.deepEqual(absurd, atCap);
    assert.equal('body_warning' in absurd, false);
    // 承重前提：body 高于默认阈值，否则上面两条都不表达"被钳到上限"。
    assert.ok(absurd.body_bytes > LIMITS.softBodyBytes);
    assert.ok(absurd.body_bytes <= LIMITS.maxBodyBytes);
  } finally {
    await fake.close();
  }
});

test('model 参数逐次覆盖默认模型', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    await registered[0].execute(
      { state: 'x', model: 'tev1:latest', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );
    assert.equal(fake.requests[0].json.model, 'tev1:latest');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// F3（2026-10-04 缺陷审查轮）：无意义的取值必须在**加载期**就被拒，而不是留到
// 调用期抛 RangeError（AbortSignal.timeout(-1)）或让告警恒真（阈值 <= 0）。
// ---------------------------------------------------------------------------

test('F3：Config 拒绝非正的 timeoutMs（加载期报错，不留到调用期抛 RangeError）', () => {
  assert.throws(() => Config({ timeoutMs: 0 }), /expected number >= 1/);
  assert.throws(() => Config({ timeoutMs: -1 }), /expected number >= 1/);
  assert.equal(Config({ timeoutMs: 1 }).timeoutMs, 1);
});

test('F3：Config 拒绝负的 softBodyBytes（0 是合法策略值：每次都告警）', () => {
  assert.throws(() => Config({ softBodyBytes: -1 }), /expected number >= 0/);
  assert.equal(Config({ softBodyBytes: 0 }).softBodyBytes, 0);
});

test('F3：resolveSoftBodyBytes 对非有限/负值回落默认，绝不返回 NaN', () => {
  // schemastery 会把 NaN 静默折成 null（实测），故 .min() 拦不住它 ——
  // 这一层是 NaN 的唯一防线：否则 Math.min(null, 65536) = 0 ⇒ 每次调用都告警。
  assert.equal(resolveSoftBodyBytes(NaN), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(null), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(-1), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(0), 0);
  assert.equal(resolveSoftBodyBytes(undefined), LIMITS.softBodyBytes);
});

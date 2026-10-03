import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { TOOL_DESCRIPTION } from '../lib/parameters.js';
import { startFakeOllama } from './fake-ollama.mjs';

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

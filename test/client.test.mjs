import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { startFakeOllama } from './fake-ollama.mjs';

const BODY = {
  model: 'tev1:0.8b',
  state: 'Our checkout has returned 500 errors since 9am.',
  questions: [{ name: 'q', type: 'noul', instructions: 'Is this English?' }],
};

const OK = {
  model: 'tev1:0.8b',
  answers: { q: { type: 'noul', noul: 0.4751 } },
  usage: { input_tokens: 799, output_tokens: 1 },
};

/** 起假服务、跑断言、必定关掉。 */
async function withServer(handler, run) {
  const fake = await startFakeOllama(handler);
  try { await run(fake); } finally { await fake.close(); }
}

/** 调用并返回 error（而非抛）。 */
async function failure(options) {
  return callSystemOne(options).then(() => null, (error) => error);
}

test('成功：POST /v1/systemone，原样返回 answers 与 usage', async () => {
  await withServer(() => ({ status: 200, body: OK }), async (fake) => {
    const result = await callSystemOne({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.deepEqual(result, OK);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].url, '/v1/systemone');
    assert.deepEqual(fake.requests[0].json, BODY);
  });
});

test('404 → model_missing，提示 ollama pull', async () => {
  await withServer(() => ({ status: 404, body: { error: 'model not found' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.ok(error instanceof SystemOneError);
    assert.equal(error.kind, 'model_missing');
    assert.equal(error.status, 404);
    assert.match(error.hint, /ollama pull tev1:0\.8b/);
  });
});

test('413 → too_large', async () => {
  await withServer(
    () => ({ status: 413, body: { error: 'request body must not exceed 64 KiB without images' } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'too_large');
      assert.match(error.hint, /64 KiB/);
    },
  );
});

test('400 → invalid_request，带出服务端原文与合法类型清单', async () => {
  await withServer(
    () => ({ status: 400, body: { error: 'question "urgent": type must be choice, noul, or score' } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'invalid_request');
      assert.match(error.message, /type must be choice, noul, or score/);
      assert.match(error.hint, /choice、noul、score/);
    },
  );
});

test('500 且含 non-finite logit → model_broken，点名换模型（照抄本机真实响应形状）', async () => {
  // Ollama 0.35.1 实测的响应体：外层 error 是一个「装着 JSON 的字符串」。
  const realBody = JSON.stringify({
    error: JSON.stringify({ error: { code: 500, message: 'Clef: non-finite logit', type: 'server_error' } }),
  });
  await withServer(() => ({ status: 500, body: realBody }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'model_broken');
    assert.match(error.message, /non-finite logit/);
    assert.match(error.hint, /tev1/);
  });
});

test('其他 500 → server_error', async () => {
  await withServer(() => ({ status: 500, body: { error: 'scoring failed' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'server_error');
    assert.match(error.message, /scoring failed/);
  });
});

test('连接被拒 → unreachable，提示 ollama serve', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: OK }));
  const { baseUrl } = fake;
  await fake.close();
  const error = await failure({ baseUrl, body: BODY, timeoutMs: 2000 });
  assert.equal(error.kind, 'unreachable');
  assert.match(error.hint, /ollama serve/);
});

test('超时 → timeout，提示首次调用含模型加载', async () => {
  await withServer(() => ({ hang: true }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 150 });
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /150 ms 内没有返回/);
    assert.match(error.hint, /模型加载/);
  });
});

test('调用方取消 → aborted（与超时可区分）', async () => {
  await withServer(() => ({ hang: true }), async (fake) => {
    const controller = new AbortController();
    const pending = callSystemOne({
      baseUrl: fake.baseUrl, body: BODY, timeoutMs: 30000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.then(() => null, (e) => e);
    assert.equal(error.kind, 'aborted');
  });
});

test('非 JSON 响应 → bad_response', async () => {
  await withServer(() => ({ status: 200, body: 'not json at all' }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'bad_response');
  });
});

test('缺 answers 字段 → bad_response', async () => {
  await withServer(() => ({ status: 200, body: { model: 'tev1:0.8b' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'bad_response');
    assert.match(error.message, /没有 answers/);
  });
});

test('fetchImpl 可注入（单测无需真实网络）', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(OK), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await callSystemOne({
    baseUrl: 'http://example.invalid:1', body: BODY, timeoutMs: 5000, fetchImpl,
  });
  assert.deepEqual(result, OK);
  assert.equal(seen.url, 'http://example.invalid:1/v1/systemone');
  assert.equal(seen.init.method, 'POST');
});

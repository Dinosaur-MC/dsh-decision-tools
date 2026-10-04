import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { startFakeOllama } from './fake-ollama.mjs';

// 这是**线格式**的 body：Task 3 的 client 层直接收 body、不经过 prepareRequest，
// 所以 questions 必须是对象映射 —— 假服务现在会像真服务一样拒绝数组（ADR-6）。
const BODY = {
  model: 'tev1:0.8b',
  state: 'Our checkout has returned 500 errors since 9am.',
  questions: { q: { name: 'q', type: 'noul', instructions: 'Is this English?' } },
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

// 本机实测的服务端原文（`.temp/ctx-probe/probe.out`，`node .temp/ctx-probe/probe.mjs` 可复现）：
// 16226 字节的 body → HTTP 400。注意 `1` 与 `2050` 之间是 **en dash U+2013**，不是 ASCII 连字 ——
// 这里是逐字节照抄真机响应，不是手写的近似串。
const CONTEXT_OVERFLOW_BODY = '{"error":"prompt 0 has 2359 tokens; expected 1–2050 (input is never truncated)"}';
/** 同一个错误的容忍写法：ASCII 连字 + 数字两侧多余空白。 */
const CONTEXT_OVERFLOW_BODY_TOLERANT = '{"error":"prompt 0 has 12 tokens; expected 1 -  88 (input is never truncated)"}';

test('400 → invalid_request，带出服务端原文与合法类型清单；上下文溢出则 → context_overflow', async () => {
  await withServer(
    () => ({ status: 400, body: { error: 'question "urgent": type must be choice, noul, or score' } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'invalid_request');
      assert.match(error.message, /type must be choice, noul, or score/);
      assert.match(error.hint, /choice、noul、score/);
      assert.match(error.hint, /2[-–]26/, 'hint 必须保留可行动的选项数约束');
      // ADR-6 之后 callSystemOne 只收 prepareRequest 产出的线格式（questions 恒为对象映射），
      // 而工具对**模型**公布的参数契约是数组、validate.js 的 V1 还会拒绝模型直接给对象，
      // 所以 400 不可能是 questions 的形状问题。hint 里再出现「对象映射」就是在教模型做
      // 一次注定失败的重试 —— 这条断言钉住它不得回潮。
      assert.doesNotMatch(error.hint, /对象映射|数组/);
    },
  );

  // 续：真机上唯一会发生的 400 是**上下文溢出** —— 有效上限是模型的 num_ctx（本机
  // tev1:0.8b = 2050），不是架构声明的 context length（262144）。这一支若不从 400 里分出来，
  // 调用方拿到的 hint 会把它指向一个 ADR-6 之后不可能存在的原因（题型/选项数/题名）。
  await withServer(() => ({ status: 400, body: CONTEXT_OVERFLOW_BODY }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'context_overflow');
    assert.equal(error.status, 400);
    assert.match(error.message, /请求超出模型上下文：2359 token，上限 2050。/,
      'message 必须同时给出服务端报的实际 token 数与上限');
    assert.match(error.message, /input is never truncated/, '服务端原文必须保持可用');
    assert.match(error.hint, /缩减 state/);
    assert.match(error.hint, /num_ctx/, 'hint 必须给出调高该模型 num_ctx 这条路');
    assert.match(error.hint, /更大的模型/, 'hint 必须给出换模型这条路');
    assert.match(error.hint, /未被截断/, '必须明说输入未被截断，别让调用方以为拿到了部分答案');
    assert.doesNotMatch(error.hint, /choice|noul|score|数组|对象映射/,
      '溢出与请求形状无关，hint 不得回落到形状类建议');
  });

  // 容忍写法：ASCII 连字、数字两侧空白。服务端把 en dash 换成 `-` 时不能退化成 invalid_request。
  await withServer(() => ({ status: 400, body: CONTEXT_OVERFLOW_BODY_TOLERANT }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'context_overflow');
    assert.match(error.message, /请求超出模型上下文：12 token，上限 88。/);
  });
});

test('线格式守卫：假服务以与真服务同形的 400 拒绝数组形状的 questions（ADR-6）', async () => {
  // 假服务现在照真服务的样子拒绝错形状（本机实测数组 → HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"）。
  // 这条用例的意义是**让守卫本身被钉住** —— 没有它，守卫就是一个在套件里永不触发的
  // 死分支，改坏了也没人知道；而它正是防止"线格式违规再次本地全绿地溜过"的那道闸。
  await withServer(
    () => ({ status: 200, body: { model: 'tev1:0.8b', answers: {} } }),
    async (fake) => {
      const error = await failure({
        baseUrl: fake.baseUrl,
        body: { model: 'tev1:0.8b', state: 'x', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] },
        timeoutMs: 5000,
      });
      assert.equal(error.kind, 'invalid_request');
      assert.equal(error.status, 400);
      assert.match(error.message, /but can't find closing/);
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

test('调用方取消 → aborted，且立即生效（不被 timeoutMs 兜住）', async () => {
  await withServer(() => ({ hang: true }), async (fake) => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = callSystemOne({
      baseUrl: fake.baseUrl, body: BODY, timeoutMs: 30000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.then(() => null, (e) => e);
    assert.equal(error.kind, 'aborted');
    // 关键：取消必须真正中止 fetch，而不是等 timeoutMs 到点。
    // 若把 AbortSignal.any 换成只传 timeoutSignal，kind 仍是 'aborted'
    // （toTransportError 里另有 signal?.aborted 检查保持分类正确），
    // 但那时代价是 socket 一直挂到 timeoutMs（本任务 30s、Task 4 默认 120s）。
    // 这条耗时断言就是为那个回归设的 —— 规格 §4.3 明写「工具被取消能真中断」。
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `cancel 应立即生效，实际耗时 ${elapsed}ms（timeoutMs 是 30000）`);
  });
});

test('body 读取中途断连 → SystemOneError，而不是没有 kind 的裸 TypeError', async () => {
  await withServer(() => ({ truncate: true }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    // 这条用例钉住的是：响应头已到、body 读到一半失败时，错误仍必须被映射。
    // 若 callSystemOne 里 `await response.text()` 落在 try 之外，这里收到的会是
    // undici 的 TypeError: terminated —— 没有 kind，Task 4 的工具按 kind 分派就会崩。
    assert.ok(
      error instanceof SystemOneError,
      `期望 SystemOneError，实际 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, 'unreachable');
    assert.match(error.hint, /ollama serve/);
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

// ---------------------------------------------------------------------------
// 以下五条钉住 2026-10-04 缺陷审查轮的 F1/F2/F3：越界形状与非法配置都必须是
// 带 kind 的 SystemOneError，而不是裸 TypeError / RangeError，也不是把一次
// **成功**调用交给宿主去判 INVALID_TOOL_OUTPUT。
// ---------------------------------------------------------------------------

test('F2：baseUrl 非法 → bad_config（SystemOneError），不得逃出裸 TypeError', async () => {
  // new URL('/v1/systemone', 'localhost:11434') 会抛 TypeError: Invalid URL，
  // 而该构造原先在 try 之外 ⇒ 逃出本函数 @throws {SystemOneError} 的契约。
  const error = await failure({ baseUrl: 'localhost:11434', body: BODY, timeoutMs: 5000 });
  assert.ok(
    error instanceof SystemOneError,
    `期望 SystemOneError，实际 ${error?.constructor?.name}: ${error?.message}`,
  );
  assert.equal(error.kind, 'bad_config');
  assert.match(error.message, /baseUrl/);
  assert.match(error.hint, /http:\/\/localhost:11434/);
});

test('F2：baseUrl 带路径前缀时前缀被保留（不再被前导斜杠静默丢弃）', async () => {
  await withServer(() => ({ status: 200, body: OK }), async (fake) => {
    const result = await callSystemOne({ baseUrl: `${fake.baseUrl}/ollama`, body: BODY, timeoutMs: 5000 });
    assert.deepEqual(result, OK);
    assert.equal(fake.requests[0].url, '/ollama/v1/systemone');
  });
});

test('F3：timeoutMs 为 0 / 负数 / NaN → bad_config，且不发请求', async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; return new Response('{}', { status: 200 }); };
  for (const bad of [0, -5, NaN]) {
    const error = await failure({ baseUrl: 'http://example.invalid:1', body: BODY, timeoutMs: bad, fetchImpl });
    assert.ok(
      error instanceof SystemOneError,
      `timeoutMs=${bad} 期望 SystemOneError，实际 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, 'bad_config');
    assert.match(error.message, /timeoutMs/);
  }
  assert.equal(called, 0, '配置非法时不得发出请求');
});

test('F1a：200 缺 model → bad_response（否则宿主判 value is not lossless JSON）', async () => {
  await withServer(
    () => ({ status: 200, body: { answers: { q: { type: 'noul', noul: 0.5 } } } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.ok(error instanceof SystemOneError);
      assert.equal(error.kind, 'bad_response');
      assert.equal(error.status, 200);
      assert.match(error.message, /model/);
    },
  );
});

test('F1b：200 的 answers 是数组 / usage 不是对象 → bad_response', async () => {
  // 原判定是 typeof parsed.answers !== 'object'，数组能穿过；宿主随后判
  // "value.answers" must be an object（usage 同理），把成功调用变成工具失败。
  await withServer(
    () => ({ status: 200, body: { model: 'tev1:0.8b', answers: [] } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'bad_response');
      assert.match(error.message, /answers/);
    },
  );

  await withServer(
    () => ({ status: 200, body: { model: 'tev1:0.8b', answers: { q: { type: 'noul', noul: 0.5 } }, usage: 7 } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'bad_response');
      assert.match(error.message, /usage/);
    },
  );
});

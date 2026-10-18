import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callSystemOne, classifyOverflow, SystemOneError } from '../lib/client.js';
import { applyAll as apply, Config } from './helpers/apply-all.mjs';
import { overflowReply, startFakeOllama } from './fake-ollama.mjs';
import { isFetchBlockedPort } from './helpers/fetch-ports.mjs';
import { firstFreeBlockedPort, startHttpServerOnPort } from './helpers/http.mjs';

// 这是**线格式**的 body：client 层直接收 body、不经过校验层，
// 所以 questions 必须是对象映射 —— 假服务现在会像真服务一样拒绝数组（ADR-6 / ADR-15）。
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
      // hint 必须保留可行动的**两条**边界，且不得再把二者混成一个数
      // （2026-10-15：旧文案写「选项数与等级数需在 2–26」，两个方向都错）。
      assert.match(error.hint, /choice 选项数需在 2[-–]255/, 'hint 必须给出 choice 的真实上限');
      assert.match(error.hint, /score 等级数需在 2[-–]10/, 'hint 必须给出 score 的真实上限');
      // ADR-15 之后 callSystemOne 只收线格式层（lib/wire.js）组装的 body（questions 恒为对象映射），
      // 而工具对**模型**公布的参数契约是 items / questions 数组、本地校验还会拒绝模型直接给对象，
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
    assert.equal(error.actual, 2359, 'A 分支必须把实测 token 数挂到错误对象上');
    assert.equal(error.limit, 2050, 'A 分支必须把服务端上限挂到错误对象上');
    assert.match(error.message, /请求超出模型上下文：2359 token，上限 2050。/,
      'message 必须同时给出服务端报的实际 token 数与上限');
    assert.match(error.message, /input is never truncated/, '服务端原文必须保持可用');
    assert.match(error.hint, /缩小 material/, 'hint 必须用 v3 的参数名（material），不得再让模型去改 state');
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

// clef 系走**不打印数字**的溢出分支：本机实测原文（`.temp/numctx/probe.json` 三条记录）逐字节照抄。
const CONTEXT_OVERFLOW_OPAQUE_BODY =
  '{"error":"decision prompt exceeds the model context (input is never truncated)"}';

test('400 → clef 系不打印数字的溢出同样是 context_overflow，且 actual/limit 缺席', async () => {
  await withServer(() => ({ status: 400, body: CONTEXT_OVERFLOW_OPAQUE_BODY }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'context_overflow', 'B 分支不得退化成 invalid_request');
    assert.equal(error.status, 400);
    assert.equal(error.actual, undefined, 'B 分支没有实际 token 数');
    assert.equal(error.limit, undefined, 'B 分支没有上限');
    assert.match(error.message, /服务端未给出具体 token 数/);
    assert.match(error.message, /input is never truncated/, '服务端原文必须保持可用');
    assert.match(error.hint, /num_ctx/, 'hint 仍须给出调高 num_ctx 这条路');
    assert.doesNotMatch(error.hint, /choice|noul|score|选项数|对象映射/,
      '溢出与请求形状无关，hint 不得回落到形状类建议');
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

test('调用方取消 → aborted，且取消信号必须传到 fetch（机制判据，零墙钟）', async () => {
  // 旧判据是 Date.now() + elapsed < 2000（真墙钟）—— 与本仓 2026-10-16 立下的「含墙钟的用例不得
  // 使用真实计时」有张力。它要防的回归只有一种：**只把 timeoutSignal 交给 fetch**。实测该回归：
  // kind 仍是 'aborted'（toTransportError 另有 signal?.aborted 检查），但 callSystemOne 要到
  // 30016 ms 才结算、socket 到 30018 ms 才关 —— 正常路径是 71 ms / 72 ms（`.temp/task-20/probe-cancel.mjs`）。
  //
  // ⚠️ 判据**不能**写成「连接最终被关了」：那件事终会发生（fetch 自己超时也会关），先 await 结算
  // 再等关闭事件就永远等得到 —— 实测那种写法在该回归下仍然绿（不承重，已废弃）。这里改钉**机制**：
  // 真正发出去的那次 fetch 拿到的 signal，必须随手持 signal 的 abort 一起 abort。
  const passed = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    passed.push(init.signal);
    const fail = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (init.signal?.aborted === true) fail();
    else init.signal?.addEventListener('abort', fail, { once: true });
  });
  const controller = new AbortController();
  const settled = callSystemOne({
    baseUrl: 'http://example.invalid:1', body: BODY, timeoutMs: 1000, signal: controller.signal, fetchImpl,
  }).then(() => null, (error) => error);
  // 等 fetch 真的被调用（一轮宏任务足够），然后取消，再让传播跑完。
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(passed[0]?.aborted, true,
    '★ 取消信号必须传到真正发出的那次 fetch（只传 timeoutSignal 时这里恒 false，连接挂到 timeoutMs）');
  const error = await settled;
  assert.equal(error.kind, 'aborted', '取消必须分类成 aborted（不是 timeout / transport）');
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

test('apiKey 以 Bearer 发送，systemOnePath 可改', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(OK), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await callSystemOne({
    baseUrl: 'http://example.invalid:1',
    body: BODY,
    timeoutMs: 5000,
    apiKey: 'secret-key',
    path: 'custom/systemone',
    fetchImpl,
  });
  assert.equal(seen.url, 'http://example.invalid:1/custom/systemone');
  assert.equal(seen.init.headers.authorization, 'Bearer secret-key');
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

// ---------------------------------------------------------------------------
// 装置不变量（2026-10-16，并发 flake 的真根因）：假服务**只交出 fetch 能用的端口**。
//
// 旧记录的失败原文是 `无法连接 Ollama：http://127.0.0.1:5060`（以及 5061），而 5060/5061
// 都在 WHATWG Fetch 的 blocked port 列表里：fetch 对表内端口**在本地直接拒绝**，请求永远不到
// 服务端，于是「假服务明明在听」的用例收到 unreachable。旧结论把成因记成「undici 进程级全局池」，
// 已被证伪（证据见 .temp/task-6/ 与计划 Task 16：200/200 复现形状全绿、600 轮连接翻腾 0 失败、
// 27833 条端口事件关联 0 命中、undici 不可 import）。真根因是端口落在 fetch 禁用列表上，
// 所以装置必须跳过它们 —— 这两条用例就是那条不变量的守卫。
// ---------------------------------------------------------------------------

test('装置不变量：假服务跳过 fetch 的 blocked port，只交出真正能用的端口', async () => {
  // 注入端口分配器，确定性地把装置逼到「先拿到两个禁用端口」的情形（与端口是否空闲无关：
  // 实现是在绑定前预检，所以不会去占用一个注定不可用的端口）。
  const pending = [5060, 5061, 0];
  const fake = await startFakeOllama(() => ({ status: 500, body: { error: 'boom' } }), {
    allocatePort: () => pending.shift(),
  });
  try {
    assert.deepEqual(fake.blockedPortsSkipped.slice(0, 2), [5060, 5061], '禁用端口必须被跳过并留痕');
    assert.ok(fake.blockedPortsSkipped.every((p) => isFetchBlockedPort(p)), '被跳过的必须确实都是禁用端口');
    assert.equal(isFetchBlockedPort(fake.port), false, '交出的端口必须能被 fetch 使用');
    // 端到端判据：交出的 baseUrl 必须真的能发出请求（旧装置在这一步会得到 unreachable）。
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'server_error');
    assert.equal(fake.requests.length, 1, '服务端必须真的收到这次请求');
  } finally {
    await fake.close();
  }
});

test('显式要求 blocked port：装置必须拒绝，而不是交出一个必然发不出请求的 baseUrl', async () => {
  await assert.rejects(
    () => startFakeOllama(() => ({ status: 200, body: OK }), { port: 5060 }),
    (error) => {
      assert.match(error.message, /5060/);
      assert.match(error.message, /blocked port/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 真根因的**可复现形态**（2026-10-16）：把假服务真的起在一个 fetch 禁用端口上。
// 失败形态是「服务端在听、请求却从未发出」—— 旧记录里它只是不可解释的 unreachable，
// 提示还指向「确认 Ollama 已在运行」。本用例把它钉成 bad_port 这个稳定判据。
// ---------------------------------------------------------------------------

test('blocked port 单列判据：服务端在听却 0 命中时给 bad_port 与可行动提示，不得混成 unreachable', async () => {
  const port = await firstFreeBlockedPort();
  const raw = await startHttpServerOnPort(port, () => ({ status: 500, body: { error: 'boom' } }));
  try {
    const error = await failure({ baseUrl: raw.baseUrl, body: BODY, timeoutMs: 5000 });
    // 「服务端一条都没收到」是这一类故障的判别性证据：失败发生在 fetch 内部，不是网络也不是服务端。
    assert.equal(raw.requests.length, 0, '服务端在听，却一条请求都没收到 —— 请求在本地被拒');
    assert.equal(error.kind, 'bad_port', 'fetch 的 blocked port 必须单列判据，不得混成 unreachable');
    assert.equal(error.status, undefined, '请求从未发出，没有 HTTP 状态码');
    assert.match(error.hint, /端口/, 'hint 必须给出「换端口 / 改 baseUrl」这条唯一可行的做法');
    assert.match(error.message, new RegExp(String(port)), 'message 必须点名那个被拒的端口');
    assert.doesNotMatch(error.hint, /ollama serve/, '这不是「Ollama 没在运行」，误导性提示不得回归');
  } finally {
    await raw.close();
  }
});

// ---------------------------------------------------------------------------
// Ollama 0.40.5 换了溢出文案（P0 回归）：本机实测原文见下，可复跑 `node .temp/task-21/probe-overflow.mjs`
// （43341 B 真实技术文档切片 → HTTP 400；换文案后旧正则认不出 ⇒ 自动升档与 deep 分块真机失效）。
const CONTEXT_OVERFLOW_BODY_CURRENT = '{"error":"request (13900 tokens) exceeds the available context size (8192 tokens), try increasing it"}';

test('溢出分类：0.40.5 当前文案 → context_overflow 且 actual/limit 正确（旧实现返 null 的 P0）', async () => {
  assert.deepEqual(
    classifyOverflow('request (13900 tokens) exceeds the available context size (8192 tokens), try increasing it'),
    { numbered: true, actual: 13900, limit: 8192 },
    '★ 当前上游文案必须被判成「带数字的溢出」，否则自动升档永远不触发',
  );
  assert.equal(CONTEXT_OVERFLOW_BODY_CURRENT.includes('13900'), true);
  await withServer(() => overflowReply({ actual: 13900, limit: 8192 }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'context_overflow', '当前文案不得退化成 invalid_request（否则 hint 会指向题型/选项数）');
    assert.equal(error.actual, 13900);
    assert.equal(error.limit, 8192);
    assert.match(error.message, /请求超出模型上下文：13900 token，上限 8192。/);
    assert.match(error.hint, /缩小 material/);
    assert.doesNotMatch(error.hint, /choice|noul|score|对象映射/, '溢出与请求形状无关');
  });
});

test('溢出分类：旧文案仍认（回归），非溢出文本仍返 null', () => {
  assert.deepEqual(classifyOverflow('prompt 0 has 2359 tokens; expected 1\u20132050 (input is never truncated)'),
    { numbered: true, actual: 2359, limit: 2050 }, 'en dash 的旧文案必须继续认');
  assert.deepEqual(classifyOverflow('prompt 0 has 12 tokens; expected 1 -  88 (input is never truncated)'),
    { numbered: true, actual: 12, limit: 88 }, 'ASCII 连字 + 空白容忍必须继续认');
  assert.deepEqual(classifyOverflow('decision prompt exceeds the model context'),
    { numbered: false }, '不打印数字的分支必须继续认');
  assert.equal(classifyOverflow('question "urgent": type must be choice, noul, or score'), null,
    '形状类 400 不得被误判成溢出');
});

test('端到端：假服务用**当前文案**回 400 ⇒ 工具层真的升档（而非当作 invalid_request 直接抛）', async () => {
  // 首档 tev1:0.8b 用 0.40.5 新文案回 400；升档目标 wide:latest 回 200。
  const fake = await startFakeOllama((req) => (req.json?.model === 'tev1:0.8b'
    ? overflowReply({ actual: 9000, limit: 8192 })
    : {
      status: 200,
      body: {
        model: req.json?.model,
        usage: { input_tokens: 42, output_tokens: 1 },
        answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((k) => [k, { type: 'noul', noul: 0.7 }])),
      },
    }));
  try {
    const registered = [];
    const ctx = {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
      skills: { get: async (n) => ({ name: n, content: '# companion skill body' }) },
    };
    apply(ctx, Config({ baseUrl: fake.baseUrl, defaultModel: 'tev1:0.8b', ladder: [{ model: 'tev1:0.8b', numCtx: 8192 }, { model: 'wide:latest', numCtx: 32768 }] }));
    const value = await registered[0].execute({ material: 'm', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] }, { signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } });
    assert.equal(value.cost.escalated, true, '★ 当前文案必须触发升档；旧实现会当 invalid_request 直接抛');
    assert.equal(value.cost.model, 'wide:latest');
    assert.deepEqual(fake.requests.map((request) => request.json?.model), ['tev1:0.8b', 'wide:latest']);
    assert.match(value.notes.join(' '), /模型选择：.*wide:latest/);
  } finally {
    await fake.close();
  }
});

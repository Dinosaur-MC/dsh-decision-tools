/**
 * 可编程的假 Ollama，只用于测试（不入包）。
 * 记录收到的每个请求体，便于断言「校验失败时不该发出网络请求」这类性质。
 *
 * **端口纪律（2026-10-16，并发 flake 的真根因）**：`fetch()` 对 WHATWG Fetch 的 blocked port
 * 列表里的端口**在本地直接拒绝**（`TypeError: fetch failed`，cause.message = `bad port`），
 * 请求永远不会到达服务端；而 `listen(0)` 拿到的系统临时端口**会**偶尔落在表里 ——
 * 本机实测命中过 5060 / 5061 / 4190 / 6666-6669 / 6679 / 6697（旧 flake capture 的原文端口
 * 就是 5060 / 5061）。那种情形下用例看到的是 `无法连接 Ollama：http://127.0.0.1:5060`，
 * 与网络状态和 Ollama 是否运行都无关。
 * 所以本装置**只交出 fetch 能用的端口**：候选端口在表里就跳过（必要时重新挑），
 * 显式要求禁用端口则直接拒绝。列表与判据见 `./helpers/fetch-ports.mjs`。
 *
 * @module dsh-decision-tools/test/fake-ollama
 */
import http from 'node:http';
import { assertFetchUsablePort, isFetchBlockedPort } from './helpers/fetch-ports.mjs';

/**
 * 上游「上下文溢出」400 的**两种真实文案** —— 厂商换过措辞，判据必须两种都认。
 *
 * · `legacy`：2026-10-16 之前本机实测原文（`1–2050` 之间是 en dash U+2013）。
 * · `current`：**Ollama 0.40.5 起**本机实测原文（43341 B 真实技术文档切片 → HTTP 400）：
 *   `request (13900 tokens) exceeds the available context size (8192 tokens), try increasing it`。
 *   可复跑：`node .temp/task-21/probe-overflow.mjs`。
 *
 * 换文案曾让 `classifyOverflow()` 返 null ⇒ 真机自动升档与 deep 内部分块**整体失效**（P0）。
 */
export const OVERFLOW_WORDS = Object.freeze({
  legacy: ({ actual, limit }) => `prompt 0 has ${actual} tokens; expected 1\u2013${limit} (input is never truncated)`,
  current: ({ actual, limit }) => `request (${actual} tokens) exceeds the available context size (${limit} tokens), try increasing it`,
});

/**
 * 造一个溢出 400 回包。默认用**当前**（0.40.5+）文案；旧文案传 `{ wording: 'legacy' }`。
 * @param {{ wording?: 'legacy'|'current', actual?: number, limit?: number }} [options]
 * @returns {{ status: number, body: { error: string } }}
 */
export function overflowReply({ wording = 'current', actual = 2100, limit = 2050 } = {}) {
  const word = OVERFLOW_WORDS[wording];
  if (word === undefined) throw new Error(`未知的溢出文案 ${JSON.stringify(wording)}（只支持 legacy / current）。`);
  return { status: 400, body: { error: word({ actual, limit }) } };
}

/** 绑定一次，成功 resolve，失败 reject（区分 EADDRINUSE 之类的绑定失败）。 */
function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.removeListener('listening', onListening); reject(error); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * @param {(request: { method: string, url: string, raw: string, json: unknown }) => { status?: number, body?: unknown, hang?: boolean, truncate?: boolean } | 'destroy'} handler
 * @param {{ port?: number, allocatePort?: (attempt: number) => number | undefined | Promise<number | undefined>, maxPortAttempts?: number }} [options]
 *   `port`：显式端口（落在 blocked 列表里直接抛错）；
 *   `allocatePort`：注入端口分配器（测试用：确定性地复现「装置拿到禁用端口」）；
 *   都不给 ⇒ `listen(0)`，由系统挑，挑到禁用端口就重挑。
 */
export async function startFakeOllama(handler, options = {}) {
  const { port: explicitPort, allocatePort, maxPortAttempts = 20 } = options;
  if (explicitPort !== undefined) assertFetchUsablePort(explicitPort);

  const requests = [];
  const blockedPortsSkipped = [];

  for (let attempt = 1; attempt <= maxPortAttempts; attempt += 1) {
    const requested = explicitPort ?? (allocatePort === undefined ? 0 : await allocatePort(attempt)) ?? 0;
    // 预检：注定发不出请求的端口不去占用它（与「该端口是否空闲」无关 ⇒ 复现用例是确定性的）。
    if (isFetchBlockedPort(requested)) {
      blockedPortsSkipped.push(Number(requested));
      continue;
    }

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(raw); } catch { json = undefined; }
        const record = { method: req.method, url: req.url, raw, json };
        requests.push(record);

        // 线格式契约守卫（ADR-6）：真实服务端要求 questions 是「题名 → 问题对象」的
        // 映射，数组会在**解析阶段**被拒（本机实测 HTTP 400
        // "Value looks like object, but can't find closing '}' symbol"）。
        // 假服务照做 —— 否则整套本地测试在结构上无法发现这类线格式违规，
        // 而"本地全绿 + 真机全挂"正是这个缺陷第一次溜过去的原因。
        if (json !== undefined && json.questions !== undefined
          && (json.questions === null || typeof json.questions !== 'object' || Array.isArray(json.questions))) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: "Value looks like object, but can't find closing '}' symbol" }));
          return;
        }

        const reply = handler(record);
        if (reply === 'destroy') { req.socket.destroy(); return; }
        if (reply.hang) return; // 永不响应：用于测超时与取消
        if (reply.truncate) {
          // 先发响应头与半个 body，等数据真正刷出后再掐断 socket —— 于是客户端是在
          // **读 body** 时失败（undici 抛 TypeError: terminated），而不是在 fetch 阶段
          // 失败。这正是「body 读取也必须被守卫」要覆盖的路径：不加守卫时它会逃成一个
          // 没有 kind 的裸错误，绕过 @throws {SystemOneError} 的契约。
          res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
          res.write('{"model":"tev1:0.8b","answers":', () => { res.socket.destroy(); });
          return;
        }
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
      });
    });

    try {
      await listenOnce(server, requested);
    } catch (error) {
      // 显式端口绑不上（被占用等）⇒ 原样抛出；分配器/系统给的端口绑不上 ⇒ 换一个重挑。
      if (explicitPort !== undefined) throw error;
      continue;
    }

    const port = server.address().port;
    if (isFetchBlockedPort(port)) {
      // `listen(0)` 抽查：系统可能恰好给到禁用端口（这就是旧 flake 的成因）。
      blockedPortsSkipped.push(port);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      continue;
    }

    // 泄漏的假服务不得拖住 `node --test` 退出：否则**任何**断言失败（close 前的 throw）都会把
    // 整轮测试变成超时挂死，看起来像死锁而不像失败（实测：duration_ms=89368 才被 timeout 杀掉）。
    server.unref();

    return {
      port,
      baseUrl: `http://127.0.0.1:${port}`,
      requests,
      blockedPortsSkipped,
      async close() {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  throw new Error(
    `假服务连续 ${maxPortAttempts} 次都没拿到 fetch 能用的端口：`
    + `被跳过的禁用端口 [${blockedPortsSkipped.join(', ')}]。`
    + '（fetch 拒绝连接 WHATWG Fetch 的 blocked port；见 test/helpers/fetch-ports.mjs。）',
  );
}

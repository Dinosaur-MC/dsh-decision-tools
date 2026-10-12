/**
 * 可编程的假 Ollama，只用于测试（不入包）。
 * 记录收到的每个请求体，便于断言「校验失败时不该发出网络请求」这类性质。
 * @module dsh-decision-tools/test/fake-ollama
 */
import http from 'node:http';

/**
 * @param {(request: { method: string, url: string, raw: string, json: unknown }) => { status?: number, body?: unknown, hang?: boolean, truncate?: boolean } | 'destroy'} handler
 */
export async function startFakeOllama(handler) {
  const requests = [];
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

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  // 泄漏的假服务不得拖住 `node --test` 退出：否则**任何**断言失败（close 前的 throw）都会把
  // 整轮测试变成超时挂死，看起来像死锁而不像失败（本轮实测：duration_ms=89368 才被 timeout 杀掉）。
  server.unref();
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

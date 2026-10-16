/**
 * 装置侧 HTTP 小工具：用于**复现「fetch blocked port 陷阱」**的用例。
 *
 * 那里必须把服务**真的**起在一个禁用端口上，才能证明故障形态是
 * 「服务端在听、请求却从未发出」（fetch 在本地拒绝，服务端 0 命中）。
 * 正常用例不要用本模块 —— 用 `startFakeOllama`（它保证只交出 fetch 能用的端口）。
 *
 * @module dsh-decision-tools/test/helpers/http
 */
import http from 'node:http';
import net from 'node:net';
import { FETCH_BLOCKED_PORTS } from './fetch-ports.mjs';

/**
 * 绑定**指定端口**的最小假服务（不含 ADR-6 线格式守卫，仅用于陷阱复现）。
 * @param {number} port
 * @param {() => { status?: number, body?: unknown }} handler
 */
export async function startHttpServerOnPort(port, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, raw: Buffer.concat(chunks).toString('utf8') });
      const reply = handler();
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  server.unref();
  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 该端口现在能不能绑（= 空闲）。 */
async function bindable(port) {
  const probe = net.createServer();
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => { probe.close(() => resolve(true)); });
  });
}

/**
 * 从 blocked 列表里挑一个**当前空闲**的端口，给陷阱复现用例用。
 * 列表里有 80+ 个端口，正常情况下必有一个空闲；全被占用才抛错。
 * @param {readonly number[]} [candidates]
 */
export async function firstFreeBlockedPort(candidates = FETCH_BLOCKED_PORTS) {
  for (const port of candidates) {
    if (await bindable(port)) return port;
  }
  throw new Error('没有空闲的 blocked port：复现用例需要至少一个 fetch 禁用端口是空闲的。');
}

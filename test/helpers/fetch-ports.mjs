/**
 * WHATWG Fetch 的 **blocked port** 列表（fetch 的 “bad port”）。
 *
 * 为什么测试装置必须知道它：`fetch()` 对落在表里的端口**在本地直接拒绝**，
 * 不建立任何连接，抛 `TypeError: fetch failed`（`cause.message === 'bad port'`）。
 * 而假服务用 `listen(0)` 拿系统临时端口 —— 一旦落在表里就出现「假服务在听、请求却从未发出」
 * 的假故障：`lib/client.js` 把 `TypeError` 归为 `unreachable`，用例收到的是
 * `无法连接 Ollama：http://127.0.0.1:5060`（旧 flake capture 的原文端口正是 5060/5061）。
 *
 * 列表来源：Fetch 规范 “port blocking”（`fetch.spec.whatwg.org`）。本机实证（2026-10-16，
 * Node v22.22.1 / undici）：对表内端口 + 每个端口的前后邻居各起一个**在听**的假服务并发请求，
 * 82 个表内端口全部 `kind=unreachable` 且服务端 `requests.length === 0`（1 个被占用跳过），
 * 103 个表外邻居全部 `kind=server_error` 且 `requests.length === 1` —— 零不符。
 * 复跑：`node .temp/task-6/probe-badport-list.mjs`（探针不入库）。
 *
 * @module dsh-decision-tools/test/helpers/fetch-ports
 */

/** Fetch 拒绝连接的端口（升序，便于人工核对）。 */
export const FETCH_BLOCKED_PORTS = Object.freeze([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679,
  6697, 10080,
]);

const BLOCKED = new Set(FETCH_BLOCKED_PORTS);

/**
 * 该端口是不是 fetch 的 blocked port（⇒ 请求会在本地被拒，服务端收不到）。
 * @param {number|string} port
 * @returns {boolean}
 */
export function isFetchBlockedPort(port) {
  return BLOCKED.has(Number(port));
}

/**
 * 假服务交出的端口必须**真的能被 fetch 使用**；否则直接失败，而不是给出一个
 * 注定发不出请求的 baseUrl（那会以 `unreachable` 的形式伪装成网络故障）。
 * @param {number|string} port
 * @returns {number} 原样返回端口
 * @throws {Error} 端口落在 blocked 列表里
 */
export function assertFetchUsablePort(port) {
  const n = Number(port);
  if (isFetchBlockedPort(n)) {
    throw new Error(
      `端口 ${n} 在 WHATWG Fetch 的 blocked port 列表里：fetch 会在本地直接拒绝，`
      + '请求永远发不到服务端（表现为 kind=unreachable）。假服务必须换一个端口。',
    );
  }
  return n;
}

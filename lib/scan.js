/**
 * 分块扫描（ADR-9）的**纯编排**：分块 → 逐块调用（注入的 `callModel`）→ 失败隔离 → 预算与中断。
 *
 * 零 I/O：真正的 HTTP 由 `lib/tool.js` 以 `callModel` 注入。这样「自适应定块、失败隔离、
 * 三重预算、中断保留部分结果」这套语义全部可以离线测试。
 *
 * @module dsh-decision-tools/scan
 */
import { chunk } from './source.js';

/** v2 只支持串行：并发收益在本机**未实测**（Ollama 按模型装载，通常串行排队），不发布未验证的并发。 */
export const MAX_CONCURRENCY = 1;

/**
 * 逐块扫描一段文本。
 *
 * **顺序保证**：`chunks` 与调用顺序都按原文顺序；`remaining` 同时计入「未成块的行」与
 * 「已成块但没来得及跑的行」，因此中断/触顶时它是可靠的欠账量。
 *
 * @param {object} input
 * @param {string} input.text 完整文本
 * @param {number} input.budgetBytes 单块字节预算
 * @param {number} [input.maxChunks] 块数上限
 * @param {number} [input.maxTotalBytes] 累计字节上限
 * @param {number} [input.deadlineMs] 墙钟预算（**独立于**单次请求超时）
 * @param {number} [input.concurrency] 只支持 1
 * @param {(arg: { name: string, text: string, startLine: number, endLine: number, bytes: number }) => Promise<unknown>} input.callModel 单块调用
 * @param {() => number} [input.now] 时间源（测试注入）
 * @param {AbortSignal} [input.signal] 中断信号
 * @param {'none'|'any'} [input.aggregate] 是否产出暂定聚合
 * @returns {Promise<{ chunks: object[], failed: object[], truncated: boolean,
 *   truncatedBy: 'chunks'|'totalBytes'|'deadline'|null, aborted: boolean, remaining: number,
 *   aggregate?: object }>}
 * @throws {Error} `concurrency !== 1` 或 `callModel` 不是函数
 */
export async function runScan({
  text,
  budgetBytes,
  maxChunks,
  maxTotalBytes,
  deadlineMs,
  concurrency = MAX_CONCURRENCY,
  callModel,
  now = () => Date.now(),
  signal,
  aggregate = 'none',
}) {
  if (concurrency !== MAX_CONCURRENCY) {
    throw new Error(`concurrency 只支持 ${MAX_CONCURRENCY}（并发收益未实测，v2 不发布未验证的并发）。`);
  }
  if (typeof callModel !== 'function') throw new Error('runScan 需要注入 callModel。');
  const planned = chunk(text, { budgetBytes, maxChunks, maxTotalBytes });
  const chunks = [];
  const failed = [];
  let truncated = planned.truncated;
  let truncatedBy = planned.truncatedBy;
  let aborted = false;
  let remaining = planned.remaining;
  const t0 = deadlineMs === undefined ? 0 : now();
  for (let index = 0; index < planned.chunks.length; index += 1) {
    const item = planned.chunks[index];
    if (signal?.aborted === true) {
      aborted = true;
      remaining += planned.chunks.slice(index).reduce((n, c) => n + (c.endLine - c.startLine + 1), 0);
      break;
    }
    if (deadlineMs !== undefined && now() - t0 > deadlineMs) {
      truncated = true;
      truncatedBy = 'deadline';
      remaining += planned.chunks.slice(index).reduce((n, c) => n + (c.endLine - c.startLine + 1), 0);
      break;
    }
    try {
      const answers = await callModel({
        name: item.name, text: item.text, startLine: item.startLine, endLine: item.endLine, bytes: item.bytes,
      });
      chunks.push({ name: item.name, startLine: item.startLine, endLine: item.endLine, bytes: item.bytes, answers });
    } catch (error) {
      failed.push({
        chunk: item.name,
        kind: error?.kind ?? 'unknown',
        message: error?.message ?? String(error),
      });
    }
  }
  const agg = aggregate === 'any' ? aggregateNoul(chunks) : undefined;
  return {
    chunks,
    failed,
    truncated,
    truncatedBy,
    aborted,
    remaining,
    ...(agg === undefined ? {} : { aggregate: agg }),
  };
}

/**
 * 跨块聚合：**只处理 `noul`**（唯一带单一标量概率的题型），取逐块最大值并标 `provisional`。
 *
 * `choice` / `score` 不做标量聚合 —— 跨块的概率没有校准证据，`max` 是未校准分数，
 * 宁可缺席也不要给调用方一个看起来能用的数。返回值里有一句显式的免责说明。
 *
 * @param {{ name: string, answers: object }[]} entries 已成功的块
 * @returns {{ provisional: true, note: string, perQuestion: Record<string, { max: number, chunks: string[] }> }}
 */
export function aggregateNoul(entries) {
  const perQuestion = {};
  for (const entry of entries) {
    for (const [name, answer] of Object.entries(entry.answers ?? {})) {
      if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) continue;
      const current = perQuestion[name];
      if (current === undefined || answer.noul > current.max) {
        perQuestion[name] = { max: answer.noul, chunks: [entry.name] };
      } else if (answer.noul === current.max) {
        current.chunks.push(entry.name);
      }
    }
  }
  return {
    provisional: true,
    note: '跨块概率未经校准，逐块最大值只是定位线索，不得作为判定依据。',
    perQuestion,
  };
}

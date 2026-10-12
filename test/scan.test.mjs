import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan, aggregateNoul, MAX_CONCURRENCY } from '../lib/scan.js';

const DOC = ['# A', '', 'one', '', '# B', '', 'two', '', '# C', '', 'three'].join('\n');
const BUDGET = 12;

function echoModel(log) {
  return async ({ name, text, startLine, endLine, bytes }) => {
    log.push({ name, text, startLine, endLine, bytes });
    return { [name]: { type: 'noul', noul: 0.5 } };
  };
}

test('串行扫描：按块顺序调用，结果保持原序', async () => {
  const log = [];
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, callModel: echoModel(log) });
  assert.ok(r.chunks.length >= 3, `至少 3 块，实际 ${r.chunks.length}`);
  assert.deepEqual(log.map((l) => l.name), r.chunks.map((c) => c.name));
  assert.deepEqual(r.chunks.map((c) => c.name), r.chunks.map((_, i) => `c${i + 1}`));
  assert.equal(r.failed.length, 0);
  assert.equal(r.aborted, false);
  assert.equal(r.truncated, false);
  assert.equal(log[0].startLine, 1);
  assert.equal(log[0].bytes, r.chunks[0].bytes);
  assert.ok(log[0].text.length > 0, '注入的 callModel 必须拿到正文（用它去发请求）');
  assert.equal(r.chunks[0].text, undefined,
    '★ 扫描结果**不得回显材料正文** —— 材料不进 agent 上下文正是 A7 的全部意义');
});

test('单块失败被隔离，其余块照跑（绝不因一块丢掉整次扫描）', async () => {
  const calls = [];
  const model = async (arg) => {
    calls.push(arg.name);
    if (arg.name === 'c2') { const e = new Error('块太大'); e.kind = 'context_overflow'; throw e; }
    return { ok: true };
  };
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, callModel: model });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].chunk, 'c2');
  assert.equal(r.failed[0].kind, 'context_overflow');
  assert.ok(r.failed[0].bytes > 0, '失败项必须带上块的字节数（自适应重切要用）');
  assert.equal(r.chunks.length, calls.length - 1);
  assert.ok(r.chunks.some((c) => c.name === 'c3'), '失败块之后的块必须继续跑');
});

test('失败项带上原始 message，便于归因', async () => {
  const model = async () => { throw new Error('boom'); };
  const r = await runScan({ text: 'x', budgetBytes: 8, callModel: model });
  assert.equal(r.failed[0].kind, 'unknown', '没有 kind 的异常记为 unknown，不吞掉');
  assert.match(r.failed[0].message, /boom/);
});

test('中断：signal 已 abort 时立即停止，保留已得结果', async () => {
  const controller = new AbortController();
  const log = [];
  const model = async (arg) => { log.push(arg.name); controller.abort(); return { a: 1 }; };
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, callModel: model, signal: controller.signal });
  assert.equal(r.aborted, true);
  assert.equal(r.chunks.length, 1, '已得的那一块必须保留');
  assert.equal(log.length, 1, '中断后不得再发起调用');
});

test('墙钟预算：超时后停止并发 truncatedBy = deadline', async () => {
  let t = 0;
  const now = () => (t += 1000);
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, deadlineMs: 1500, callModel: echoModel([]), now });
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'deadline');
  assert.equal(r.chunks.length, 1);
  assert.ok(r.remaining > 0);
});

test('块预算触顶 → truncatedBy = chunks 且 remaining 报未发块的行数', async () => {
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, maxChunks: 1, callModel: echoModel([]) });
  assert.equal(r.chunks.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'chunks');
  assert.ok(r.remaining > 0);
});

test('累计字节触顶 → truncatedBy = totalBytes', async () => {
  const r = await runScan({ text: DOC, budgetBytes: BUDGET, maxTotalBytes: 4, callModel: echoModel([]) });
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'totalBytes');
  assert.equal(r.chunks.length, 0);
});

test('并发 > 1 在 v2 直接拒绝（收益未实测，串行是唯一受支持形态）', async () => {
  await assert.rejects(runScan({ text: DOC, budgetBytes: BUDGET, concurrency: 2, callModel: echoModel([]) }),
    /concurrency 只支持 1/);
  assert.equal(MAX_CONCURRENCY, 1);
});

test('aggregateNoul：取逐块最大概率并标暂定；非 noul 不聚合', () => {
  const entries = [
    { name: 'c1', answers: { q: { type: 'noul', noul: 0.2 }, pick: { type: 'choice', probabilities: { a: 1 } } } },
    { name: 'c2', answers: { q: { type: 'noul', noul: 0.8 } } },
    { name: 'c3', answers: { q: { type: 'noul', noul: 0.5 } } },
  ];
  const agg = aggregateNoul(entries);
  assert.equal(agg.provisional, true);
  assert.match(agg.note, /不得作为判定依据/);
  assert.equal(agg.perQuestion.q.max, 0.8);
  assert.deepEqual(agg.perQuestion.q.chunks, ['c2']);
  assert.equal(agg.perQuestion.pick, undefined, 'choice/score 没有跨块标量，不聚合');
  assert.deepEqual(aggregateNoul([]).perQuestion, {});
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverNotice } from '../lib/deliver.js';
import { runMonitor, EVIDENCE_MAX_BYTES } from '../lib/monitor.js';

const spyTarget = () => {
  const calls = { followup: 0, inject: 0, cancel: 0 };
  return {
    calls,
    agent: {
      followup() { calls.followup += 1; },
      inject() { calls.inject += 1; },
      cancel() { calls.cancel += 1; },
    },
  };
};

test('deliverNotice：followup 只用于 mode=followup，inject 用于静默；绝不调用 cancel', () => {
  const a = spyTarget();
  assert.equal(deliverNotice(undefined, 'followup', { message: { id: 'm1' } }, { agent: a.agent }), true);
  assert.deepEqual(a.calls, { followup: 1, inject: 0, cancel: 0 });
  const b = spyTarget();
  assert.equal(deliverNotice(undefined, 'inject', { message: { id: 'm2' } }, { agent: b.agent }), true);
  assert.deepEqual(b.calls, { followup: 0, inject: 1, cancel: 0 }, 'inject 只能走 inject');
  assert.deepEqual(b.calls.cancel, 0, '绝不 cancel');
});

test('deliverNotice：没有 info.agent 时按 sessionId 经 ctx.agents 解析；解析不到就静默 false', () => {
  const a = spyTarget();
  let asked = null;
  const agents = { get: (sid) => { asked = sid; return a.agent; } };
  assert.equal(deliverNotice(agents, 'followup', { message: {} }, { sessionId: 's-1' }), true);
  assert.equal(asked, 's-1');
  assert.equal(deliverNotice(agents, 'followup', { message: {} }, {}), false, '无 sessionId ⇒ false');
  assert.equal(deliverNotice({}, 'followup', { message: {} }, { sessionId: 's-1' }), false, '无 agents.get ⇒ false');
  assert.equal(deliverNotice(agents, 'followup', {}, { sessionId: 's-1' }), false, 'payload 无 message ⇒ false');
});

test('deliverNotice：目标抛错被吞掉（通知失败不得影响监控本体）', () => {
  const agent = { followup() { throw new Error('boom'); }, inject() { throw new Error('boom'); } };
  assert.equal(deliverNotice(undefined, 'followup', { message: {} }, { agent }), false);
  assert.equal(deliverNotice(undefined, 'inject', { message: {} }, { agent }), false);
});

test('tool.js 必须走 lib/deliver.js（防止把最后一跳又塞回闭包里、重新变成不可测）', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../lib/tool.js', import.meta.url), 'utf8');
  assert.match(source, /deliverNotice\(ctx\.agents,/);
  assert.ok(!/target\.followup\(message\)/.test(source), 'tool.js 里不应再出现直投逻辑');
});

test('evidence 上限：长样本只留最后 EVIDENCE_MAX_BYTES 字节（改常量会红）', async () => {
  const long = 'x'.repeat(5000);
  let now = 0;
  const out = await runMonitor({
    sources: { read: async () => ({ text: long, totalBytes: 5000, truncated: false }) },
    decide: async () => ({ probability: 1 }),
    clock: () => now,
    sleep: async (ms) => { now += ms; },
    args: { source: { kind: 'file', path: 'a.txt' }, rubric: 'x', intervalMs: 1000, timeoutMs: 1000, countThreshold: 1, tailBytes: 4096, mode: 'once', hitThreshold: 0.5 },
  });
  assert.equal(out.hit, true);
  assert.equal(Buffer.byteLength(out.evidence, 'utf8'), EVIDENCE_MAX_BYTES, 'evidence 必须恰好是 1024 B 的尾部');
  assert.equal(Buffer.byteLength(out.evidence, 'utf8'), 1024, '常量本身也要钉住');
});
test('空样本预检短路：立即返回、不调 Decision、不等到 deadline', async () => {
  let now = 0; let sleeps = 0; let decides = 0;
  const out = await runMonitor({
    sources: { read: async () => ({ text: '   ', totalBytes: 3, truncated: false }) },
    decide: async () => { decides += 1; return { probability: 1 }; },
    clock: () => now,
    sleep: async (ms) => { sleeps += 1; now += ms; },
    args: { source: { kind: 'file', path: 'a.txt' }, rubric: 'x', intervalMs: 1000, timeoutMs: 5000, countThreshold: 1, tailBytes: 4096, mode: 'once', hitThreshold: 0.5 },
  });
  assert.equal(out.emptySource, true, '必须标记空源短路');
  assert.equal(out.samples, 1, '只采样一次就返回');
  assert.equal(out.timedOut, false, '不是超时结束');
  assert.equal(out.hit, false);
  assert.equal(decides, 0, '空样本不得调用 Decision');
  assert.equal(sleeps, 0, '不得进入休眠/等待');
});
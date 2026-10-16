import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, DEFAULT_WAKE_BUDGET, RATE_WINDOW_MS } from '../lib/notify.js';

/** 记录投递的假 deliver：调用参数原样留档（**零真实 inbox**，本模块只经它出站）。 */
function recorder() {
  const calls = [];
  return {
    calls,
    deliver(mode, payload) {
      calls.push({ mode, payload });
    },
  };
}

/** 注入时钟：测试**绝不 sleep 真实时间**，一律手动推进。 */
function fakeClock(start) {
  let now = Number.isFinite(start) ? start : 1700000000000;
  return {
    clock: () => now,
    advance(ms) { now += ms; },
  };
}

test('createNotifier：缺 deliver 直接拒绝（通知必须经注入的出站口）', () => {
  assert.throws(() => createNotifier({}), (error) => error instanceof TypeError);
});

test('notify：缺 text 直接拒绝（空通知没有意义）', () => {
  const { deliver } = recorder();
  const notifier = createNotifier({ deliver, clock: fakeClock().clock, coalesceWindowMs: 0 });
  assert.throws(() => notifier.notify({ kind: 'hit' }), (error) => error instanceof TypeError);
  assert.throws(() => notifier.notify({ kind: 'hit', text: '' }), (error) => error instanceof TypeError);
});

test('notify：目标空闲走 followup、目标忙走 inject（官方范式），mode 只有这两个取值', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 100 });

  const idle = notifier.notify({ key: 'k1', text: 'a', idle: true, at: t.clock() });
  const busy = notifier.notify({ key: 'k2', text: 'b', idle: false, at: t.clock() });
  const unknown = notifier.notify({ key: 'k3', text: 'c', at: t.clock() });
  const explicit = notifier.notify({ key: 'k4', text: 'd', idle: true, mode: 'inject', at: t.clock() });

  assert.equal(idle.mode, 'followup');
  assert.equal(busy.mode, 'inject');
  assert.equal(unknown.mode, 'inject', '目标状态未知时默认不唤醒（保守）');
  assert.equal(explicit.mode, 'inject', 'evt.mode 可显式覆盖推断');
  assert.deepEqual(calls.map((call) => call.mode), ['followup', 'inject', 'inject', 'inject']);
  for (const call of calls) assert.ok(['followup', 'inject'].includes(call.mode));
});

test('合并：同窗口内同类事件只投递一次，窗口外可再投', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 5000, maxPerMinute: 100 });

  const first = notifier.notify({ key: 'hit', text: '命中 1', idle: true });
  const second = notifier.notify({ key: 'hit', text: '命中 2', idle: true });
  assert.equal(first.delivered, true);
  assert.equal(second.delivered, false);
  assert.equal(second.reason, 'coalesced');
  assert.equal(second.coalescedCount, 1);
  assert.equal(calls.length, 1, '被合并的那次不得出站');

  t.advance(5001);
  const third = notifier.notify({ key: 'hit', text: '命中 3', idle: true });
  assert.equal(third.delivered, true);
  assert.equal(calls.length, 2);
  assert.equal(third.suppressedCount, 1);
});

test('合并只按 key：不同 key 互不影响；coalesceWindowMs=0 或 evt.coalesce=false 关闭合并', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 5000, maxPerMinute: 100 });

  notifier.notify({ key: 'a', text: '1' });
  notifier.notify({ key: 'b', text: '2' });
  assert.equal(calls.length, 2);

  const noCoalesce = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 100 });
  noCoalesce.notify({ key: 'same', text: '3' });
  noCoalesce.notify({ key: 'same', text: '4' });
  assert.equal(calls.length, 4, '窗口为 0 时不做合并');

  const bypass = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 5000, maxPerMinute: 100 });
  bypass.notify({ key: 'same2', text: '5' });
  bypass.notify({ key: 'same2', text: '6', coalesce: false });
  assert.equal(calls.length, 6, 'evt.coalesce=false 跳过本次合并检查');
});

test('限频：滑动一分钟内最多 maxPerMinute 条，被压制的那次不占额度且可观测', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 3 });

  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(notifier.notify({ key: 'k' + i, text: 'n' + i }));

  assert.deepEqual(results.map((r) => r.reason), ['delivered', 'delivered', 'delivered', 'rate_limited', 'rate_limited']);
  assert.equal(calls.length, 3);
  assert.equal(results[4].suppressedCount, 2);
  assert.equal(results[4].rateLimitedCount, 2);
  assert.equal(results[4].deliveredCount, 3);
  assert.deepEqual(notifier.stats().rateLimitedCount, 2);

  t.advance(RATE_WINDOW_MS + 1);
  const after = notifier.notify({ key: 'k-after', text: 'after' });
  assert.equal(after.delivered, true, '窗口滑过后额度恢复');
});

test('唤醒预算：连续唤醒用尽后 followup 降级为 inject（消息仍送达、不再唤醒）', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 100, wakeBudget: 2 });

  const r1 = notifier.notify({ key: 'h1', text: '1', idle: true });
  const r2 = notifier.notify({ key: 'h2', text: '2', idle: true });
  const r3 = notifier.notify({ key: 'h3', text: '3', idle: true });

  assert.deepEqual([r1.mode, r2.mode, r3.mode], ['followup', 'followup', 'inject']);
  assert.equal(r3.delivered, true, '降级不是丢弃：消息仍送达');
  assert.equal(r3.wakeDegraded, true);
  assert.equal(notifier.stats().wakeDegradedCount, 1);
  assert.equal(notifier.stats().wakesUsed, 2);
  assert.equal(calls.length, 3);
});

test('唤醒预算按「连续」计：目标忙的那次不唤醒，并重置连续计数', () => {
  const { deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 100, wakeBudget: 1 });

  const r1 = notifier.notify({ key: 'a', text: '1', idle: true });
  const r2 = notifier.notify({ key: 'b', text: '2', idle: false });
  const r3 = notifier.notify({ key: 'c', text: '3', idle: true });
  assert.deepEqual([r1.mode, r2.mode, r3.mode], ['followup', 'inject', 'followup']);
  assert.equal(notifier.stats().wakeDegradedCount, 0);
});

test('消息 id 唯一且形状可直接交给 agent.followup / agent.inject', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0, maxPerMinute: 600 });

  const ids = new Set();
  for (let i = 0; i < 50; i += 1) {
    const result = notifier.notify({ key: 'k' + i, text: 'body ' + i, idle: i % 2 === 0, at: t.clock() });
    assert.equal(result.delivered, true);
    assert.ok(typeof result.id === 'string' && result.id.length > 0);
    assert.ok(!ids.has(result.id), '宿主对重复 MessageId 会抛 already pending');
    ids.add(result.id);
  }
  assert.equal(ids.size, 50);

  const message = calls[0].payload.message;
  assert.equal(message.id, calls[0].payload.id);
  assert.equal(message.role, 'user');
  assert.deepEqual(message.content, [{ type: 'text', text: 'body 0' }]);
  assert.equal(message.source.kind, 'user');
  assert.equal(message.source.form, 'notice');
  assert.equal(calls[0].payload.text, 'body 0');
  assert.equal(calls[0].payload.event.text, 'body 0');
});

test('deliver 抛错时不算已投递、不记合并时刻，因此可以重试', () => {
  const attempted = [];
  let failures = 0;
  const deliver = (mode, payload) => {
    attempted.push(payload.id);
    if (failures === 0) {
      failures += 1;
      throw new Error('inbox rejected');
    }
  };
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 5000, maxPerMinute: 100 });

  const failed = notifier.notify({ key: 'hit', text: 'x' });
  assert.equal(failed.delivered, false);
  assert.equal(failed.reason, 'deliver_failed');
  assert.equal(failed.id, null);
  assert.equal(notifier.stats().failedCount, 1);
  assert.equal(notifier.stats().deliveredCount, 0);

  const retried = notifier.notify({ key: 'hit', text: 'x' });
  assert.equal(retried.delivered, true, '失败那次不占用合并窗口');
  assert.equal(attempted.length, 2);
});

test('notify：窗口按注入的 at 走（evt.at 参与合并窗与限频窗，不只是记录）', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 5000, maxPerMinute: 100 });

  notifier.notify({ key: 'k', text: '1' });
  const sameClock = notifier.notify({ key: 'k', text: '2' });
  assert.equal(sameClock.reason, 'coalesced', '同一个 at ⇒ 落在合并窗内');

  const jumped = notifier.notify({ key: 'k', text: '3', at: t.clock() + 5001 });
  assert.equal(jumped.delivered, true, '用 at 跳过合并窗（clock() 本身没动）⇒ at 确实参与窗口计算');
  assert.equal(calls.length, 2);
});

test('通知器只有 notify/stats 两个出入口：从不持有 agent，也绝不调用 agent.cancel', () => {
  const { calls, deliver } = recorder();
  const t = fakeClock();
  const notifier = createNotifier({ deliver, clock: t.clock, coalesceWindowMs: 0 });
  notifier.notify({ key: 'a', text: '1', idle: true });
  assert.deepEqual(Object.keys(notifier).sort(), ['notify', 'stats']);
  assert.equal(DEFAULT_WAKE_BUDGET > 0, true);
  for (const call of calls) assert.ok(['followup', 'inject'].includes(call.mode));
});

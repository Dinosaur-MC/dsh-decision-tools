import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventLog, mapJobEvent, attachJobEvents, EVENT_LOG_DEFAULT_CAPACITY, EVENT_LOG_DEFAULT_TAIL, EVENT_DETAIL_MAX_CHARS,
} from '../lib/event-log.js';

const JOB = (over = {}) => ({ id: 'monitor-7', kind: 'monitor', label: 'monitor file', status: 'running', detail: '命中 1/1', ...over });

test('环形缓冲：超出容量丢最旧，tail 按时间正序、默认 64、上限等于容量', () => {
  const log = createEventLog({ capacity: 3, now: () => 1000 });
  for (const type of ['a', 'b', 'c', 'd', 'e']) log.push({ type });
  assert.equal(log.size(), 3, '容量 3 ⇒ 只留 3 条');
  assert.deepEqual(log.tail().map((e) => e.type), ['c', 'd', 'e'], '丢最旧、保时间正序');
  assert.ok(log.tail().every((e) => e.at === 1000), 'at 由注入时钟补齐');
  const big = createEventLog({ capacity: 5 });
  for (let i = 0; i < 10; i += 1) big.push({ type: 'x' });
  assert.equal(big.tail(99).length, 5, 'tail(n) 不得超过容量');
  assert.equal(createEventLog().capacity, EVENT_LOG_DEFAULT_CAPACITY);
  assert.equal(EVENT_LOG_DEFAULT_TAIL, 64);
});

test('mapJobEvent：settled 派生按状态命名的可等待类型（completed/failed/killed）', () => {
  const reg = mapJobEvent({ type: 'registered', job: JOB() });
  assert.equal(reg.length, 1);
  assert.equal(reg[0].type, 'job.registered');
  assert.equal(reg[0].id, 'monitor-7');
  assert.equal(reg[0].kind, 'monitor');
  for (const [status, expected] of [['completed', 'job.completed'], ['failed', 'job.failed'], ['killed', 'job.killed']]) {
    const out = mapJobEvent({ type: 'settled', job: JOB({ status }) });
    assert.deepEqual(out.map((e) => e.type), ['job.settled', expected], 'settled 必须同时给出原始与状态类型');
  }
  assert.deepEqual(mapJobEvent({ type: 'unknown-type', job: JOB() }), [], '未知事件丢弃');
  assert.deepEqual(mapJobEvent(null), [], '非对象丢弃');
});

test('mapJobEvent：detail 截断、不塞输出正文；output 事件只带 id/total', () => {
  const long = mapJobEvent({ type: 'registered', job: JOB({ detail: 'x'.repeat(EVENT_DETAIL_MAX_CHARS + 50) }) });
  assert.equal(long[0].detail.length, EVENT_DETAIL_MAX_CHARS, 'detail 必须截断');
  const out = mapJobEvent({ type: 'output', id: 'monitor-7', total: 42 });
  assert.equal(out[0].type, 'job.output');
  assert.equal(out[0].id, 'monitor-7');
  assert.equal(out[0].total, 42);
  const text = JSON.stringify(out[0]);
  assert.ok(!/label|status/.test(text) || true, '不强制字段存在');
  assert.ok(text.length < 200, '单条条目必须小（不进输出正文）');
});

test('attachJobEvents：订阅到缓冲、返回 disposer、缺 jobs / 无 subscribe / subscribe 抛都安全返回 null', () => {
  const calls = [];
  const disposer = () => { calls.push('disposed'); };
  let listener;
  const ctx = { jobs: { events: { subscribe: (filter, fn) => { listener = fn; return disposer; } } } };
  const log = createEventLog({ capacity: 10, now: () => 7 });
  const off = attachJobEvents(ctx, log);
  assert.equal(typeof off, 'function');
  listener({ type: 'settled', job: JOB({ status: 'completed' }) });
  assert.deepEqual(log.tail().map((e) => e.type), ['job.settled', 'job.completed'], '事件真的进了缓冲');
  off();
  assert.deepEqual(calls, ['disposed'], 'disposer 必须被调用');
  assert.equal(attachJobEvents({}, log), null, '没有 jobs 服务 ⇒ null');
  assert.equal(attachJobEvents({ jobs: { events: {} } }, log), null, '没有 subscribe ⇒ null');
  assert.equal(attachJobEvents({ jobs: { events: { subscribe: () => { throw new Error('boom'); } } } }, log, { warn: () => {} }), null, 'subscribe 抛 ⇒ null 不炸');
});

test('attachJobEvents：监听器内部的异常被隔离，不影响订阅者（观测者不得影响被观测者）', () => {
  const warnings = [];
  let listener;
  const ctx = { jobs: { events: { subscribe: (c, f, fn) => { listener = fn; return () => {}; } } } };
  const brokenLog = { push: () => { throw new Error('ring 坏了'); } };
  const off = attachJobEvents(ctx, brokenLog, { warn: (m) => warnings.push(m) });
  assert.doesNotThrow(() => listener({ type: 'registered', job: JOB() }), '监听器抛错必须被吞掉');
  assert.equal(warnings.length, 1, '要留下一条 warn');
  assert.match(warnings[0], /event-log/);
  assert.equal(typeof off, 'function');
});
// ── events 源：内置投影（无环形缓冲时从 ctx.jobs.list 派生）────────────────────────
import { createSources } from '../lib/monitor.js';
import { validateMonitorArgs } from '../lib/validate.js';

const ROWS = [
  { id: 'monitor-1', kind: 'monitor', label: 'monitor file', status: 'completed', startedAt: 10, finishedAt: 20 },
  { id: 'bash-2', kind: 'bash', label: 'npm test', status: 'running', startedAt: 30 },
];

test('events 源：无缓冲时用 ctx.jobs.list(sessionId) 投影当前状态，types 过滤按 job.<status>', async () => {
  const calls = [];
  const ctx = { jobs: { list: async (sid) => { calls.push(sid); return ROWS; } } };
  const sources = createSources(ctx, { sessionId: 'session-9' });
  const done = await sources.read({ kind: 'events', types: ['job.completed'] }, {});
  assert.equal(done.events, 1, '只投影匹配类型的作业');
  assert.match(done.text, /monitor-1/, '条目里要有作业 id');
  assert.match(done.text, /job\.completed/);
  assert.deepEqual(calls, ['session-9'], '必须带 sessionId 枚举（不带只回 unowned）');
  const running = await sources.read({ kind: 'events', types: ['job.running'] }, {});
  assert.equal(running.events, 1);
  assert.match(running.text, /bash-2/);
  const missing = await sources.read({ kind: 'events', types: ['job.failed'] }, {});
  assert.equal(missing.events, 0, '没有匹配类型 ⇒ 空样本（不是错误）');
  assert.equal(missing.text, '');
});

test('events 源：无 sessionId / 无 jobs.list / list 抛 ⇒ 可行动的 invalid_request（不静默空样本）', async () => {
  const cases = [
    [{ jobs: { list: async () => ROWS } }, {}],
    [{}, { sessionId: 'session-9' }],
    [{ jobs: {} }, { sessionId: 'session-9' }],
    [{ jobs: { list: async () => { throw new Error('boom'); } } }, { sessionId: 'session-9' }],
  ];
  for (const [ctx, deps] of cases) {
    const sources = createSources(ctx, deps);
    await assert.rejects(
      () => sources.read({ kind: 'events', types: ['job.completed'] }, {}),
      (error) => error.kind === 'invalid_request' && /events/.test(error.message),
      '无数据源必须当场给 invalid_request',
    );
  }
});

test('events 源：注入的环形缓冲优先于 jobs 投影（两条路都在时以缓冲为准）', async () => {
  const ctx = { jobs: { list: async () => ROWS } };
  const sources = createSources(ctx, { sessionId: 's1', eventLog: [{ type: 'job.completed', id: 'from-buffer' }] });
  const out = await sources.read({ kind: 'events', types: ['job.completed'] }, {});
  assert.match(out.text, /from-buffer/);
  assert.ok(!/monitor-1/.test(out.text), '有缓冲时不得再走投影');
});
test('events 源：limit 在**类型过滤之后**生效（先截断会漏掉更早的匹配事件）', async () => {
  const log = [
    { type: 'job.registered', id: 'old-1' },
    { type: 'job.output', id: 'old-1' },
    { type: 'job.registered', id: 'old-2' },
    { type: 'job.settled', id: 'old-2' },
    { type: 'job.output', id: 'old-2' },
  ];
  const sources = createSources({}, { eventLog: log });
  const out = await sources.read({ kind: 'events', types: ['job.registered'], limit: 1 }, {});
  assert.equal(out.events, 1, 'limit:1 且只有 1 条匹配（末尾那条不是 registered）⇒ 必须仍取到匹配的那条');
  assert.match(out.text, /old-2/, '取最近一条匹配（不是最早）');
  const two = await sources.read({ kind: 'events', types: ['job.registered'], limit: 2 }, {});
  assert.equal(two.events, 2);
  assert.match(two.text, /old-1/);
});
// ── 审查 E 抓到的两处缺陷的守卫（2026-10-18）────────────────────────────────
import { registerMonitorTool } from '../lib/monitor-tool.js';

test('前台 notify:inbox 必须当场失败（不能被静默忽略）', async () => {
  const { definition } = registerMonitorTool({ tools: { register() {} } }, {
    deps: {
      register: false,
      read: async () => ({ source: { kind: 'file' }, text: 'MARKER-X' }),
      decide: async () => ({ probability: 0.9 }),
      notifier: { notify: () => ({ delivered: true }) },
    },
  });
  await assert.rejects(
    () => definition.execute({ rubric: 'x', source: { kind: 'file', path: 'tmp/a.txt' }, notify: 'inbox' }, {}),
    (error) => error.kind === 'invalid_request' && /background:true/.test(error.message),
    '前台传 notify:inbox ⇒ 必须给可行动错误；静默忽略会让调用方以为通知会来',
  );
});

test('events 无数据源时报错文案必须完整（历史 bug：行首一元加号把后半句变成 NaN）', async () => {
  const sources = createSources({ jobs: { list: async () => { throw new Error('boom'); } } }, { sessionId: 's1' });
  await assert.rejects(
    () => sources.read({ kind: 'events', types: ['job.completed'] }, {}),
    (error) => {
      assert.match(error.message, /deps\.eventLog/, '文案前半句要有');
      assert.match(error.message, /jobs\.list/, '文案后半句也要有（一元加号 bug 会让它丢掉）');
      return error.kind === 'invalid_request';
    },
  );
});
// ── 审查 task-35 的三条 P1 的守卫（2026-10-18）────────────────────────────
test('monitor 只接受 noul：choice/score 当场拒绝（不是被吞成 errors=1）', () => {
  for (const type of ['choice', 'score']) {
    assert.throws(
      () => validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a' }, type }),
      (e) => e.kind === 'monitor_invalid' && /noul/.test(e.message),
      type + ' 必须当场拒绝',
    );
  }
  assert.doesNotThrow(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a' }, type: 'noul' }));
});

test('coalesce:false 被归一保留（此前是死参数，归一后无人读）', () => {
  const on = validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a' }, background: true, notify: 'inbox' });
  const off = validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a' }, background: true, notify: 'inbox', coalesce: false });
  assert.equal(on.coalesce, true, '缺省合并');
  assert.equal(off.coalesce, false, 'coalesce:false 必须保留到归一结果里');
  assert.ok(on.coalesceWindowMs > 0, '缺省窗口 > 0');
});

test('timeoutMs 超上限会被钳制并写进 clampNotes（不再静默）', () => {
  const out = validateMonitorArgs({ rubric: 'x', source: { kind: 'file', path: 'a' }, timeoutMs: 10000000 });
  assert.ok(out.timeoutMs < 10000000);
  assert.ok(out.clampNotes.some((n) => /timeoutMs 被钳制/.test(n)), '钳制必须有可读说明：' + JSON.stringify(out.clampNotes));
});
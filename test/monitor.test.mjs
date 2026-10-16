import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSources,
  runMonitor,
  startBackgroundMonitor,
  formatProgressLine,
  tailOf,
  EVIDENCE_MAX_BYTES,
  MONITOR_JOB_KIND,
} from '../lib/monitor.js';
import { DecisionSourceError } from '../lib/source.js';

const NL = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

/**
 * 假 fs 树（与 test/tool.test.mjs 的 treeFs 同形）：resolve / contains / listDir / readBytes。
 * 刻意不写带反斜杠的正则：本文件的源码在别处生成，避开转义歧义。
 */
function treeFs(files) {
  const norm = (path) => {
    let p = String(path).split(BACKSLASH).join('/');
    while (p.startsWith('./')) p = p.slice(2);
    if (p === '.' || p === '') return '';
    while (p.endsWith('/')) p = p.slice(0, -1);
    return p;
  };
  const target = (key) => ({ key });
  const join = (base, name) => (base === '' ? name : base + '/' + name);
  return {
    async resolve(path) {
      const clean = norm(path);
      return target(clean);
    },
    contains(root, child) {
      return child.key === root.key || (root.key === '' ? child.key !== '' : child.key.startsWith(root.key + '/'));
    },
    async listDir(t) {
      const base = norm(t.key);
      const known = Object.keys(files).some((path) => path === base || path.startsWith(base + '/'));
      if (base !== '' && !known) throw new Error('NOT_FOUND: ' + base);
      const prefix = base === '' ? '' : base + '/';
      const seen = new Map();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const type = slash < 0 ? 'file' : 'directory';
        if (!seen.has(name)) seen.set(name, { name, type, target: target(join(base, name)) });
      }
      return [...seen.values()];
    },
    async readBytes(t, _signal, maxBytes) {
      const raw = Buffer.from(files[norm(t.key)] === undefined ? '' : files[norm(t.key)], 'utf8');
      if (raw.byteLength > maxBytes) throw new Error('FS_TOO_LARGE');
      return raw;
    },
  };
}

/** 注入时钟 + 休眠：**绝不 sleep 真实时间**，休眠只推进假时钟。 */
function fakeTime(start) {
  let now = Number.isFinite(start) ? start : 1700000000000;
  const sleeps = [];
  return {
    sleeps,
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    advance: (ms) => { now += ms; },
  };
}

/** 假作业服务：把 list / readAt 的**完整实参**留档（arity 也要断言）。 */
function jobCtx(options = {}) {
  const calls = [];
  const views = options.views === undefined ? [] : options.views;
  const jobs = {
    list(...args) {
      calls.push({ op: 'list', args });
      return views;
    },
    readAt(...args) {
      calls.push({ op: 'readAt', args });
      return options.read === undefined
        ? { chunks: [], next: 0, lossy: false }
        : options.read(args[0], args[1], args[2]);
    },
  };
  const ctx = { jobs };
  if (options.sessions !== null) {
    const sessions = options.sessions === undefined ? [{ id: 'session-1' }] : options.sessions;
    ctx.sessions = { list: () => sessions };
  }
  return { ctx, calls };
}

/** 假采样源：第 n 次 read 返回 texts[n]，越界复用最后一个。 */
function stubSources(texts) {
  const reads = [];
  return {
    reads,
    async read(source, options) {
      reads.push({ source, options });
      const text = texts[Math.min(reads.length - 1, texts.length - 1)];
      return {
        kind: 'file',
        text,
        bytes: Buffer.byteLength(text, 'utf8'),
        totalBytes: Buffer.byteLength(text, 'utf8'),
        truncated: false,
      };
    },
  };
}

/** 假判定器：按序列返回判定，函数项直接调用（可用来抛错）；seen 挂在函数上便于断言。 */
function stubDecide(verdicts) {
  const seen = [];
  const decide = async (text, meta) => {
    seen.push({ text, index: meta.index, at: meta.at });
    const verdict = verdicts[Math.min(seen.length - 1, verdicts.length - 1)];
    return typeof verdict === 'function' ? verdict() : verdict;
  };
  decide.seen = seen;
  return decide;
}

test('tailOf：按字节取尾且不劈开多字节字符', () => {
  assert.equal(tailOf('hello', 5), 'hello');
  assert.equal(tailOf('hello', 99), 'hello');
  assert.equal(tailOf('hello', 3), 'llo');
  assert.equal(tailOf('你好世界', 12), '你好世界');
  assert.equal(tailOf('你好世界', 6), '世界');
  assert.equal(tailOf('你好世界', 5), '界');
  assert.equal(tailOf(undefined, 4), '');
});

test('createSources：job 采样源必须带 sessionId 枚举，且只读尾部 tailBytes 窗口', async () => {
  const text = '0123456789ABCDEFGHIJ';
  const views = [
    { id: 'pwsh-1', kind: 'pwsh', label: 'first', owner: 'session-1', status: 'completed', output: { total: 20 } },
    { id: 'pwsh-2', kind: 'pwsh', label: 'second', owner: 'session-1', status: 'running', output: { total: 20 } },
  ];
  const { ctx, calls } = jobCtx({ views, read: (_id, from) => ({ chunks: [{ at: 1, text: text.slice(from) }], next: 20, lossy: false }) });
  const read = await createSources(ctx).read({ kind: 'job' }, { tailBytes: 5 });

  assert.equal(calls[0].op, 'list');
  assert.equal(calls[0].args.length, 1, 'list 必须带 caller：不带只回 unowned 作业（实测 2 条 vs 0 条）');
  assert.equal(calls[0].args[0], 'session-1');
  assert.deepEqual(calls[1].args, ['pwsh-2', 15, 'session-1'], '默认监视本会话最新作业，窗口起点 = total - tailBytes');
  assert.equal(read.text, 'FGHIJ');
  assert.equal(read.bytes, 5);
  assert.equal(read.kind, 'job');
  assert.equal(read.jobId, 'pwsh-2');
  assert.equal(read.totalBytes, 20);
  assert.equal(read.truncated, true);
  assert.equal(read.lossy, false);
});

test('createSources：job 采样源按 id 读；id 不存在报 source_missing', async () => {
  const views = [{ id: 'pwsh-1', kind: 'pwsh', owner: 'session-1', status: 'running', output: { total: 20 } }];
  const { ctx, calls } = jobCtx({ views, read: () => ({ chunks: [{ at: 1, text: 'tail' }], next: 20, lossy: false }) });
  const sources = createSources(ctx);

  const read = await sources.read({ kind: 'job', id: 'pwsh-1' }, { tailBytes: 5 });
  assert.deepEqual(calls[1].args, ['pwsh-1', 15, 'session-1']);
  assert.equal(read.text, 'tail');

  await assert.rejects(() => sources.read({ kind: 'job', id: 'gone' }, { tailBytes: 5 }), (error) => {
    assert.ok(error instanceof DecisionSourceError);
    assert.equal(error.kind, 'source_missing');
    return true;
  });
});

test('createSources：本会话没有作业报 source_missing；kind=subagent 的作业无输出源（total 恒 0）', async () => {
  const empty = jobCtx({ views: [] });
  await assert.rejects(() => createSources(empty.ctx).read({ kind: 'job' }, { tailBytes: 8 }), (error) => error.kind === 'source_missing');

  const sub = jobCtx({ views: [{ id: 'subagent-1', kind: 'subagent', owner: 'session-1', status: 'running', output: { total: 0 } }] });
  const read = await createSources(sub.ctx).read({ kind: 'job' }, { tailBytes: 8 });
  assert.equal(read.text, '');
  assert.equal(read.bytes, 0);
  assert.equal(read.totalBytes, 0);
  assert.equal(read.truncated, false, '没有输出源不是「截断」，是本来就没有内容');
});

test('createSources：file 采样源复用 source.js 的行范围与字节语义', async () => {
  const full = 'line1' + NL + 'line2' + NL + 'line3' + NL + 'line4' + NL;
  const sources = createSources({ fs: treeFs({ 'logs/a.txt': full }) });

  const tail = await sources.read({ kind: 'file', path: 'logs/a.txt' }, { tailBytes: 6 });
  assert.equal(tail.text, 'line4' + NL);
  assert.equal(tail.bytes, 6);
  assert.equal(tail.totalBytes, Buffer.byteLength(full, 'utf8'));
  assert.equal(tail.truncated, true);
  assert.deepEqual(tail.files, ['logs/a.txt']);

  const ranged = await sources.read({ kind: 'file', path: 'logs/a.txt', startLine: 2, endLine: 3 }, { tailBytes: 4096 });
  assert.equal(ranged.text, 'line2' + NL + 'line3');
  assert.equal(ranged.truncated, false);
});

test('createSources：file 的越界/超限各按其 kind 报错（工作区根围栏 + 超限不截断）', async () => {
  const outside = { fs: { resolve: async (p) => ({ key: p }), contains: () => false, readBytes: async () => Buffer.from('x') } };
  await assert.rejects(() => createSources(outside).read({ kind: 'file', path: 'a.txt' }, { tailBytes: 4 }), (error) => error.kind === 'source_outside_root');

  const tooLarge = { fs: { resolve: async (p) => ({ key: p }), contains: () => true, readBytes: async () => { throw new Error('FS_TOO_LARGE'); } } };
  await assert.rejects(() => createSources(tooLarge).read({ kind: 'file', path: 'a.txt' }, { tailBytes: 4 }), (error) => error.kind === 'source_too_large');
});

test('createSources：glob 复用既有遍历与表头语义，并同样受 tailBytes 限制', async () => {
  const files = { 'logs/a.log': 'aaa' + NL, 'logs/b.log': 'bbb' + NL, 'logs/c.txt': 'ccc' + NL };
  const sources = createSources({ fs: treeFs(files) });

  const read = await sources.read({ kind: 'glob', pattern: 'logs/*.log' }, { tailBytes: 4096 });
  assert.ok(read.text.includes('===== logs/a.log ====='));
  assert.ok(read.text.includes('===== logs/b.log ====='));
  assert.equal(read.text.includes('c.txt'), false);
  assert.deepEqual(read.files, ['logs/a.log', 'logs/b.log']);
  assert.equal(read.truncated, false);

  const windowed = await sources.read({ kind: 'glob', pattern: 'logs/*.log' }, { tailBytes: 4 });
  assert.ok(Buffer.byteLength(windowed.text, 'utf8') <= 4);
  assert.equal(windowed.truncated, true);
});

test('createSources：未知 kind / 未注入 runCommand 的 command / 未注入缓冲的 events 都给出可行动报错', async () => {
  const bare = createSources({});
  await assert.rejects(() => bare.read({ kind: 'nope' }, { tailBytes: 4 }), (error) => error.kind === 'invalid_request');
  await assert.rejects(() => bare.read({ kind: 'command', argv: ['echo'] }, { tailBytes: 4 }), (error) => error.kind === 'invalid_request');
  await assert.rejects(() => bare.read({ kind: 'events', types: [] }, { tailBytes: 4 }), (error) => error.kind === 'invalid_request');
  await assert.rejects(() => bare.read(null, { tailBytes: 4 }), (error) => error.kind === 'invalid_request');
});

test('createSources：command 与 events 在装配层注入后可用（本模块不自行 spawn 子进程）', async () => {
  const cmd = createSources({}, { runCommand: async (_source, options) => ({ text: 'out:' + options.tailBytes, totalBytes: 99, exitCode: 3 }) });
  const out = await cmd.read({ kind: 'command', argv: ['echo', 'x'] }, { tailBytes: 8 });
  assert.equal(out.text, 'out:8');
  assert.equal(out.totalBytes, 99);
  assert.equal(out.exitCode, 3);

  const events = createSources({ monitorEventLog: [{ type: 'agent/status', status: 'running' }, { type: 'tools/result', name: 'x' }] });
  const evt = await events.read({ kind: 'events', types: ['agent/status'] }, { tailBytes: 4096 });
  assert.ok(evt.text.includes('agent/status'));
  assert.equal(evt.text.includes('tools/result'), false);
  assert.equal(evt.events, 1);
});

test('runMonitor：按探测结果计数（电平）——countThreshold=3 时第 3 次命中才返回，命中即 +1 无去抖', async () => {
  const t = fakeTime();
  const progress = [];
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: stubDecide([0.9, 0.1, 0.9, 0.9, 0.9]),
    clock: t.clock,
    sleep: t.sleep,
    args: {
      source: { kind: 'file', path: 'x' },
      intervalMs: 1000,
      timeoutMs: 60000,
      countThreshold: 3,
      hitThreshold: 0.5,
      onProgress: (summary) => { progress.push(summary.count); },
    },
  });
  assert.equal(result.hit, true);
  assert.equal(result.count, 3);
  assert.equal(result.countThreshold, 3);
  assert.equal(result.samples, 4);
  assert.equal(result.hitSamples, 3);
  assert.deepEqual(progress, [1, 1, 2, 3], '连续命中各自 +1：没有去抖、没有冷却窗、没有 minGapMs');
  assert.equal(t.sleeps.length, 3);
});

test('runMonitor：at/atIso/firstAt/lastAt 是 epoch 毫秒整数、只作记录', async () => {
  const t0 = 1700000000000;
  const t = fakeTime(t0);
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: stubDecide([0.9]),
    clock: t.clock,
    sleep: t.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1 },
  });
  assert.equal(result.firstAt, t0);
  assert.equal(result.lastAt, t0);
  assert.equal(result.at, t0);
  assert.equal(Number.isInteger(result.at), true);
  assert.equal(result.atIso, new Date(t0).toISOString());
  assert.equal(result.elapsedMs, 0);
});

test('runMonitor：同一判定序列在不同步长下结论一致（时间不参与判定）', async () => {
  const run = async (intervalMs) => {
    const t = fakeTime();
    return runMonitor({
      sources: stubSources(['a']),
      decide: stubDecide([0.9, 0.1, 0.9, 0.9, 0.9]),
      clock: t.clock,
      sleep: t.sleep,
      args: { source: { kind: 'file', path: 'x' }, intervalMs, timeoutMs: 60000, countThreshold: 3 },
    });
  };
  const slow = await run(1000);
  const fast = await run(7);
  assert.equal(slow.hit, fast.hit);
  assert.equal(slow.count, fast.count);
  assert.equal(slow.samples, fast.samples);
  assert.notEqual(slow.at, fast.at, 'at 只作记录 ⇒ 会随步长变化，但从不参与判定');
});

test('runMonitor：hitThreshold 决定单次命中（0.4 不算、0.6 算）', async () => {
  const t = fakeTime();
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: stubDecide([0.4, 0.6]),
    clock: t.clock,
    sleep: t.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1, hitThreshold: 0.5 },
  });
  assert.equal(result.hit, true);
  assert.equal(result.count, 1);
  assert.equal(result.samples, 2);
  assert.equal(result.confidence, null);
});

test('runMonitor：decide 支持数字与对象（probability / hit / value）三种形状', async () => {
  const shapes = [[0.8], [{ probability: 0.8 }], [{ hit: true }], [{ value: true }]];
  for (const verdicts of shapes) {
    const t = fakeTime();
    const result = await runMonitor({
      sources: stubSources(['a']),
      decide: stubDecide(verdicts),
      clock: t.clock,
      sleep: t.sleep,
      args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1 },
    });
    assert.equal(result.hit, true, JSON.stringify(verdicts));
    assert.equal(result.count, 1, JSON.stringify(verdicts));
  }
});

test('runMonitor：signal abort 立即返回 hit=false 且保留已累计 count，不抛', async () => {
  const t = fakeTime();
  const controller = new AbortController();
  let first = true;
  const sources = {
    async read() {
      if (first) {
        first = false;
        controller.abort();
      }
      return { kind: 'file', text: 'a', bytes: 1, totalBytes: 1, truncated: false };
    },
  };
  const result = await runMonitor({
    sources,
    decide: async () => 0.9,
    clock: t.clock,
    sleep: t.sleep,
    signal: controller.signal,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 3 },
  });
  assert.equal(result.hit, false);
  assert.equal(result.aborted, true);
  assert.equal(result.count, 1, '已累计的 count 必须保留在返回值里');
  assert.equal(result.samples, 1);
  assert.equal(t.sleeps.length, 0, 'abort 后不再休眠');
});

test('runMonitor：进入循环前就 aborted ⇒ 立刻返回、零探测、不抛', async () => {
  const controller = new AbortController();
  controller.abort();
  const t = fakeTime();
  const sources = stubSources(['a']);
  const result = await runMonitor({
    sources,
    decide: async () => 0.9,
    clock: t.clock,
    sleep: t.sleep,
    signal: controller.signal,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1 },
  });
  assert.equal(result.hit, false);
  assert.equal(result.aborted, true);
  assert.equal(result.count, 0);
  assert.equal(result.samples, 0);
  assert.equal(result.at, null);
  assert.equal(result.atIso, null);
  assert.equal(sources.reads.length, 0);
});

test('runMonitor：自管 deadline 到点返回 hit=false（不挂死、不等宿主抢占）', async () => {
  const t = fakeTime();
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: async () => 0.1,
    clock: t.clock,
    sleep: t.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 3000, countThreshold: 1 },
  });
  assert.equal(result.hit, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.count, 0);
  assert.equal(result.samples, 3);
  assert.equal(result.elapsedMs, 3000);
});

test('runMonitor：休眠最多睡到 deadline，绝不睡过头', async () => {
  const t = fakeTime();
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: async () => 0.1,
    clock: t.clock,
    sleep: t.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 10000, timeoutMs: 2500, countThreshold: 1 },
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(t.sleeps, [2500], 'intervalMs 大于剩余预算时只睡到 deadline');
  assert.equal(result.samples, 1);
});

test('runMonitor：注入的时钟/休眠不前进时循环仍可证终止（maxProbes 硬停）', async () => {
  const t = fakeTime();
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: async () => 0.1,
    clock: () => 1700000000000,
    sleep: async () => {},
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 5000, countThreshold: 1 },
  });
  assert.equal(result.hit, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.samples, 6, 'ceil(timeoutMs / intervalMs) + 1');
  assert.equal(t.sleeps.length, 0);
});

test('runMonitor：单次采样/判定失败不终止监控（记进 errors、按未命中处理）', async () => {
  const t1 = fakeTime();
  let nth = 0;
  const decide = async () => {
    nth += 1;
    if (nth === 1) throw new Error('ollama down');
    return 0.9;
  };
  const decideFailed = await runMonitor({
    sources: stubSources(['a']),
    decide,
    clock: t1.clock,
    sleep: t1.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1 },
  });
  assert.equal(decideFailed.hit, true);
  assert.equal(decideFailed.samples, 2);
  assert.equal(decideFailed.errors, 1);
  assert.equal(decideFailed.count, 1);

  const t2 = fakeTime();
  let reads = 0;
  const sources = {
    async read() {
      reads += 1;
      if (reads === 1) throw new Error('source missing');
      return { kind: 'file', text: 'a', bytes: 1, totalBytes: 1, truncated: false };
    },
  };
  const readFailed = await runMonitor({
    sources,
    decide: async () => 0.9,
    clock: t2.clock,
    sleep: t2.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 1000, timeoutMs: 60000, countThreshold: 1 },
  });
  assert.equal(readFailed.hit, true);
  assert.equal(readFailed.samples, 2);
  assert.equal(readFailed.errors, 1);
});

test('runMonitor：evidence 只保留命中那次的有限尾部（硬上限），onHit 只在达成门槛时触发', async () => {
  const t = fakeTime();
  const long = 'x'.repeat(5000);
  const hits = [];
  const result = await runMonitor({
    sources: stubSources([long, long, long]),
    decide: async () => 0.9,
    clock: t.clock,
    sleep: t.sleep,
    args: {
      source: { kind: 'file', path: 'x' },
      intervalMs: 1000,
      timeoutMs: 60000,
      countThreshold: 3,
      onHit: (summary) => { hits.push(summary.count); },
    },
  });
  assert.equal(result.hit, true);
  assert.deepEqual(hits, [3], '达成门槛前不通知');
  assert.ok(Buffer.byteLength(result.evidence, 'utf8') <= EVIDENCE_MAX_BYTES);
  assert.ok(result.evidence.length > 0);
});

test('runMonitor：mode=continuous 达成门槛后继续跑到 deadline，命中持续触发 onHit', async () => {
  const t = fakeTime();
  const hits = [];
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: async () => 0.9,
    clock: t.clock,
    sleep: t.sleep,
    args: {
      source: { kind: 'file', path: 'x' },
      intervalMs: 1000,
      timeoutMs: 5000,
      countThreshold: 2,
      mode: 'continuous',
      onHit: (summary) => { hits.push(summary.count); },
    },
  });
  assert.equal(result.mode, 'continuous');
  assert.equal(result.hit, true);
  assert.equal(result.count, 5);
  assert.equal(result.samples, 5);
  assert.equal(result.timedOut, true);
  assert.deepEqual(hits, [2, 3, 4, 5]);
});

test('runMonitor：缺 clock/sleep 直接拒绝（零真实墙钟守卫）', async () => {
  const base = { sources: stubSources(['a']), decide: async () => 0.9, args: { source: { kind: 'file', path: 'x' } } };
  await assert.rejects(() => runMonitor({ ...base }), (error) => error instanceof TypeError);
  await assert.rejects(() => runMonitor({ ...base, clock: () => 0 }), (error) => error instanceof TypeError);
  await assert.rejects(() => runMonitor({ ...base, sleep: async () => {} }), (error) => error instanceof TypeError);
});

test('runMonitor：把实际生效的 intervalMs/timeoutMs 回报给装配层（钳制说明由工具层拼）', async () => {
  const t = fakeTime();
  const result = await runMonitor({
    sources: stubSources(['a']),
    decide: async () => 0.1,
    clock: t.clock,
    sleep: t.sleep,
    args: { source: { kind: 'file', path: 'x' }, intervalMs: 2000, timeoutMs: 4000, countThreshold: 1 },
  });
  assert.equal(result.intervalMs, 2000);
  assert.equal(result.timeoutMs, 4000);
});

test('formatProgressLine：一行内含 count/countThreshold 与已监控时长', () => {
  assert.equal(formatProgressLine({ count: 2, countThreshold: 3, probability: 0.712, elapsedMs: 45000, hit: false }), '待命中 2/3 · P=0.71 · 已监控 45s');
  assert.equal(formatProgressLine({ count: 3, countThreshold: 3, probability: 0.712, elapsedMs: 45000, hit: true }), '命中 3/3 · P=0.71 · 已监控 45s');
  assert.equal(formatProgressLine({ count: 0, countThreshold: 1, elapsedMs: 0, hit: false }), '待命中 0/1 · P=- · 已监控 0s');
});

/** 假 jobs 服务：可让前 N 次 start 抛「no job controller」；run 内联执行并留档进度。 */
function backgroundJobs(options = {}) {
  const failStarts = options.failStarts === undefined ? 0 : options.failStarts;
  const state = { starts: 0, attached: null, specs: [], progress: [] };
  const jobs = {
    start(spec) {
      state.starts += 1;
      if (state.starts <= failStarts) {
        throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)');
      }
      state.specs.push(spec);
      const id = 'monitor-job-' + state.starts;
      spec.run({ id, updateProgress: (line) => state.progress.push(line), append() {} });
      return id;
    },
    attachController(name) {
      state.attached = name;
      return () => {};
    },
  };
  return { jobs, state };
}

test('startBackgroundMonitor：先 start；命中「no job controller」才 attachController 再重试一次', async () => {
  const { jobs, state } = backgroundJobs({ failStarts: 1 });
  const t = fakeTime();
  const result = startBackgroundMonitor({ jobs }, {
    source: { kind: 'file', path: 'a' }, intervalMs: 1000, timeoutMs: 5000, countThreshold: 1,
  }, {
    sources: stubSources(['hit']), decide: async () => 0.9, clock: t.clock, sleep: t.sleep,
  });

  assert.equal(result.jobId, 'monitor-job-2');
  assert.equal(state.starts, 2);
  assert.equal(state.attached, 'dsh-decision-tools-monitor');

  const settled = await result.done;
  assert.equal(settled.status, 'completed');
  assert.ok(state.progress.length >= 1);
  assert.ok(state.progress[0].includes('1/1'), '进度行必须含 count/countThreshold');
  assert.ok(state.progress[0].includes('已监控'));
  assert.ok(state.progress[0].includes('s'));
  assert.ok(state.specs[0].kind === MONITOR_JOB_KIND);
});

test('startBackgroundMonitor：notify=inbox 命中送通知（空闲⇒followup），且绝不调用 agent.cancel', async () => {
  const { jobs, state } = backgroundJobs();
  const t = fakeTime();
  const deliveries = [];
  const cancelled = [];
  const agent = { status: 'idle', cancel: () => { cancelled.push(1); }, followup: () => {}, inject: () => {} };
  const result = startBackgroundMonitor({ jobs }, {
    source: { kind: 'file', path: 'a' }, intervalMs: 1000, timeoutMs: 5000, countThreshold: 1, notify: 'inbox',
  }, {
    sources: stubSources(['hit']),
    decide: async () => 0.9,
    clock: t.clock,
    sleep: t.sleep,
    agent,
    sessionId: 'session-1',
    deliver: (mode, payload) => { deliveries.push({ mode, payload }); },
  });

  assert.equal(state.specs[0].owner, 'session-1');
  await result.done;
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].mode, 'followup', '目标空闲 ⇒ 唤醒');
  assert.equal(deliveries[0].payload.message.source.form, 'notice');
  assert.ok(deliveries[0].payload.id.includes('notice-'));
  assert.ok(deliveries[0].payload.text.includes('命中'));
  assert.equal(cancelled.length, 0, '绝不调用 agent.cancel（实测它会清空整个 inbox）');
});

test('startBackgroundMonitor：notify=inbox 但没注入 deliver/notify ⇒ 直接拒绝，不静默丢通知', () => {
  const { jobs } = backgroundJobs();
  assert.throws(
    () => startBackgroundMonitor({ jobs }, { source: { kind: 'file', path: 'a' }, notify: 'inbox' }, { decide: async () => 0.9 }),
    (error) => error instanceof TypeError,
  );
});

test('startBackgroundMonitor：start 抛别的错时原样透传，绝不私自 attachController', () => {
  const jobs = {
    start() { throw new Error('jobs are disabled by policy'); },
    attachController() { throw new Error('must not be called'); },
  };
  assert.throws(
    () => startBackgroundMonitor({ jobs }, { source: { kind: 'file', path: 'a' } }, { decide: async () => 0.9 }),
    (error) => error.message.includes('disabled by policy'),
  );
});

test('startBackgroundMonitor：run 被重复调用时第二次是空操作（start 只该成功一次）', async () => {
  const { jobs, state } = backgroundJobs();
  const t = fakeTime();
  const result = startBackgroundMonitor({ jobs }, {
    source: { kind: 'file', path: 'a' }, intervalMs: 1000, timeoutMs: 5000, countThreshold: 1,
  }, {
    sources: stubSources(['hit']), decide: async () => 0.9, clock: t.clock, sleep: t.sleep,
  });
  await result.done;
  const duplicate = state.specs[0].run({ id: 'dup', updateProgress: () => {} });
  const settled = await duplicate.done;
  assert.equal(settled.status, 'killed');
  assert.equal(settled.detail, 'duplicate start ignored');
});


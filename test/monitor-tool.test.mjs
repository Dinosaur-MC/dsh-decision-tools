import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerMonitorTool,
  renderMonitor,
  createMonitorSources,
  TOOL_DESCRIPTION,
  PARAMETERS,
  OUTPUT_SCHEMA,
  MONITOR_TOOL_DEFAULT_NAME,
} from '../lib/monitor-tool.js';
import { MONITOR_LIMITS, validateMonitorArgs, DecisionValidationError } from '../lib/validate.js';
import { DecisionSourceError } from '../lib/source.js';

/** 注入时钟 + 休眠：**绝不 sleep 真实时间**，休眠只推进假时钟。 */
function fakeTime(start) {
  let now = Number.isFinite(start) ? start : 1700000000000;
  const sleeps = [];
  return {
    sleeps,
    clock: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  };
}

/** 够用的假 ctx：默认只给 tools.register；用例按需补 jobs/sessions/fs。 */
function fakeCtx(options = {}) {
  const registered = [];
  const ctx = {
    tools: {
      register: (definition) => {
        registered.push(definition);
        return () => {};
      },
    },
  };
  for (const key of ['jobs', 'sessions', 'fs', 'agents']) {
    if (options[key] !== undefined) ctx[key] = options[key];
  }
  return { ctx, registered };
}

/** 假 reader：模拟 decision 用的 createSourceReader —— 形状 { state, source }，参数 (descriptor, { signal, cwd })。 */
function fakeReader(files) {
  const calls = [];
  const read = async (descriptor, options) => {
    calls.push({ descriptor, options });
    const key = descriptor.kind === 'file' ? descriptor.path : descriptor.pattern;
    const text = files[key];
    if (text === undefined) {
      throw new DecisionSourceError('source 指向的文件不存在：' + key, { kind: 'source_missing' });
    }
    return {
      state: text,
      source: {
        kind: descriptor.kind,
        path: descriptor.path,
        pattern: descriptor.pattern,
        bytes: Buffer.byteLength(text, 'utf8'),
        truncated: false,
      },
    };
  };
  read.calls = calls;
  return read;
}

/** 假 jobs 服务：内联执行 run 并留档句柄（后台分支的契约：先 start，抛 no job controller 才 attachController）。 */
function fakeJobs(options = {}) {
  const failStarts = options.failStarts === undefined ? 0 : options.failStarts;
  const state = { starts: 0, attached: null, specs: [], handles: [], progress: [] };
  const jobs = {
    start(spec) {
      state.starts += 1;
      if (state.starts <= failStarts) {
        throw new Error('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)');
      }
      state.specs.push(spec);
      const id = 'monitor-job-' + state.starts;
      state.handles.push(spec.run({ id, updateProgress: (line) => state.progress.push(line) }));
      return id;
    },
    attachController(name) {
      state.attached = name;
      return () => {};
    },
  };
  return { jobs, state };
}

/** 假 sessions：job 采样源枚举必须带 sessionId。 */
function fakeSessions(ids) {
  const calls = [];
  return {
    calls,
    sessions: {
      list() {
        calls.push({ argc: arguments.length });
        return ids.map((id) => ({ id }));
      },
    },
  };
}

const EXEC = { signal: undefined, agent: { id: 'session-1', session: { header: { cwd: 'F:/ws' } } } };

/** 一遍标准注册（decide 恒命中）。 */
function setup(extraDeps = {}, options = {}) {
  const t = fakeTime();
  const ctxOptions = { ...options };
  const { ctx, registered } = fakeCtx(ctxOptions);
  const read = fakeReader(options.files === undefined ? { 'logs/a.txt': 'hello world' } : options.files);
  const out = registerMonitorTool(ctx, {
    config: options.config === undefined ? {} : options.config,
    deps: {
      decide: async () => ({ probability: 0.9 }),
      read,
      clock: t.clock,
      sleep: t.sleep,
      ...extraDeps,
    },
  });
  return { ctx, registered, read, out, time: t };
}

test('注册形状：name/description/parameters/output.render 齐备，render 返回内容块数组', () => {
  const { ctx, registered, out } = setup();
  assert.equal(out.name, MONITOR_TOOL_DEFAULT_NAME);
  assert.equal(out.registered, true);
  assert.equal(registered.length, 1);
  assert.equal(registered[0], out.hostDefinition, 'ctx.tools.register 收到的必须是 defineTool 归一后的对象');

  const definition = out.definition;
  assert.equal(definition.name, 'monitor');
  assert.equal(definition.description, TOOL_DESCRIPTION);
  assert.equal(typeof definition.execute, 'function');
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(definition.output.schema, OUTPUT_SCHEMA);

  const blocks = definition.output.render({}, {
    background: true, mode: 'once', source: { kind: 'file', path: 'a' }, clampNotes: [], notes: [], jobId: 'j-1',
  });
  assert.ok(Array.isArray(blocks), '宿主直接对 render 结果做 content.some(...)：返回字符串会让整次调用崩');
  assert.ok(blocks.length > 0);
  for (const block of blocks) assert.equal(block.type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
});

test('参数用紧凑方言（逐属性 required / object 显式 additionalProperties），归一后是原生 JSON Schema', () => {
  const { out } = setup();
  assert.equal(PARAMETERS.rubric.required, true);
  assert.equal(PARAMETERS.source.required, true);
  assert.equal(PARAMETERS.source.additionalProperties, false);
  assert.equal(PARAMETERS.source.properties.kind.required, true);
  assert.ok(Array.isArray(PARAMETERS.source.properties.kind.enum));
  const native = out.hostDefinition.parameters;
  assert.ok(Array.isArray(native.required), 'defineTool 把逐属性注解收集成根上的 required 数组');
  assert.deepEqual(native.required.slice().sort(), ['rubric', 'source']);
  assert.equal(native.properties.source.additionalProperties, false, '嵌套 object 节点的 additionalProperties 必须落到归一后的 schema 上');
  assert.equal(native.properties.source.properties.kind.type, 'string');
  assert.equal(native.properties.source.properties.kind.enum.includes('file'), true);
});

test('参数键集与 MONITOR_LIMITS.allowedKeys 完全一致（两端漂移会红）', () => {
  assert.deepEqual(Object.keys(PARAMETERS).slice().sort(), MONITOR_LIMITS.allowedKeys.slice().sort());
});

test('注入预算：description 与参数 schema 各自不超上限', () => {
  const descriptionBytes = Buffer.byteLength(TOOL_DESCRIPTION, 'utf8');
  const schemaBytes = Buffer.byteLength(JSON.stringify(PARAMETERS), 'utf8');
  assert.ok(descriptionBytes <= 1900, 'description ' + descriptionBytes + 'B > 1900B');
  assert.ok(schemaBytes <= 3600, 'parameters ' + schemaBytes + 'B > 3600B');
  console.log('# description=' + descriptionBytes + 'B parameters=' + schemaBytes + 'B');
});

test('execute 走 validateMonitorArgs：钳制生效，clampNotes 原样透传（notes 未注入时等于它）', async () => {
  const { out } = setup();
  const value = await out.definition.execute(
    { rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' }, intervalMs: 1 },
    EXEC,
  );
  assert.equal(value.intervalMs, MONITOR_LIMITS.minProbeIntervalMs, 'intervalMs 被抬到配置下限');
  assert.equal(value.background, false);
  assert.equal(value.hit, true);
  assert.equal(value.count, 1);
  assert.ok(Array.isArray(value.clampNotes) && value.clampNotes.length === 1);
  assert.ok(value.clampNotes[0].includes('intervalMs'));
  assert.deepEqual(value.notes, value.clampNotes, '未注入 composeNotes 时 notes 就是 clampNotes 的透传');

  const second = await out.definition.execute(
    { rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' }, intervalMs: 60000, timeoutMs: 5000 },
    EXEC,
  );
  assert.equal(second.intervalMs, 60000);
  assert.equal(second.timeoutMs, 60000, 'timeoutMs 被抬到 intervalMs');
  assert.ok(second.clampNotes.some((note) => note.includes('timeoutMs')));
});

test('execute 拒绝非法参数（校验层是唯一入口）', async () => {
  const { out } = setup();
  await assert.rejects(() => out.definition.execute({ rubric: 'x' }, EXEC), (error) => {
    assert.ok(error instanceof DecisionValidationError);
    assert.equal(error.kind, 'source_invalid');
    return true;
  });
  await assert.rejects(
    () => out.definition.execute({ rubric: 'x', source: { kind: 'file', path: 'a' }, minGapMs: 10 }, EXEC),
    (error) => error instanceof DecisionValidationError,
  );
});

test('decide 拿得到本次调用的 rubric / 阈值 / 信号（meta 透传，只用 text 的包装照常工作）', async () => {
  const seen = [];
  const { out } = setup({
    decide: async (text, meta) => { seen.push({ text, meta }); return { probability: 0.9 }; },
  });
  const value = await out.definition.execute(
    { rubric: 'has the marker appeared', source: { kind: 'file', path: 'logs/a.txt' }, hitThreshold: 0.7, type: 'noul' },
    EXEC,
  );
  assert.equal(value.hit, true);
  assert.equal(seen.length, 1, 'once + countThreshold=1 ⇒ 命中的那次探测即返回');
  assert.equal(seen[0].text, 'hello world');
  assert.equal(seen[0].meta.rubric, 'has the marker appeared');
  assert.equal(seen[0].meta.hitThreshold, 0.7);
  assert.equal(seen[0].meta.type, 'noul');
  assert.equal(seen[0].meta.index, 0);
  assert.equal(seen[0].meta.at, 1700000000000);
  assert.equal(seen[0].meta.source.kind, 'file');
  assert.equal(seen[0].meta.signal, undefined);
});

test('composeNotes 注入后 notes 用它的结果（本模块只透传，不新增文案）', async () => {
  const { out } = setup({ composeNotes: ({ clampNotes }) => ['(tool) ' + clampNotes.length] });
  const value = await out.definition.execute({ rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' }, intervalMs: 1 }, EXEC);
  assert.deepEqual(value.notes, ['(tool) 1']);
  assert.equal(value.clampNotes.length, 1, 'clampNotes 始终原样透传');
});

test('file 源走注入的 read：断言被调用、描述符与 cwd 正确，且绝不碰 ctx.fs（没有第二份实现）', async () => {
  const touched = [];
  const fs = {
    resolve: async () => { touched.push('resolve'); return { key: 'x' }; },
    contains: () => { touched.push('contains'); return true; },
    readBytes: async () => { touched.push('readBytes'); return Buffer.from('nope'); },
    listDir: async () => { touched.push('listDir'); return []; },
  };
  const { out, read } = setup({}, { fs, files: { 'logs/a.txt': 'hello world' } });
  const value = await out.definition.execute({ rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' } }, EXEC);

  assert.equal(read.calls.length, 1, 'file 源必须走注入的 deps.read');
  assert.deepEqual(read.calls[0].descriptor, { kind: 'file', path: 'logs/a.txt' });
  assert.equal(read.calls[0].options.cwd, 'F:/ws');
  assert.deepEqual(touched, [], 'monitor-tool 不得自己实现文件读取（否则又是一份漂移的语义）');
  assert.equal(value.hit, true);
  assert.equal(value.evidence, 'hello world');
});

test('glob 源同样走注入的 read，并保留描述符形状', async () => {
  const { out, read } = setup({}, { files: { 'logs/*.txt': 'globbed' } });
  const value = await out.definition.execute({ rubric: 'x', source: { kind: 'glob', pattern: 'logs/*.txt' } }, EXEC);
  assert.equal(read.calls.length, 1);
  assert.deepEqual(read.calls[0].descriptor, { kind: 'glob', pattern: 'logs/*.txt' });
  assert.equal(value.hit, true);
  assert.equal(value.evidence, 'globbed');
});

test('缺 deps.read 时 file/glob 源当场报可行动错误（配置错误不被探测循环吞掉）', async () => {
  const t = fakeTime();
  const { ctx } = fakeCtx();
  const out = registerMonitorTool(ctx, { deps: { decide: async () => ({ probability: 0.9 }), clock: t.clock, sleep: t.sleep } });

  await assert.rejects(
    () => out.definition.execute({ rubric: 'x', source: { kind: 'file', path: 'a.txt' } }, EXEC),
    (error) => {
      assert.ok(error instanceof DecisionSourceError);
      assert.equal(error.kind, 'invalid_request');
      assert.ok(error.message.includes('deps.read'));
      return true;
    },
  );
  await assert.rejects(
    () => out.definition.execute({ rubric: 'x', source: { kind: 'glob', pattern: 'a/*' } }, EXEC),
    (error) => error instanceof DecisionSourceError && error.message.includes('deps.read'),
  );
  assert.equal(t.sleeps.length, 0, '当场失败：一次探测都不该跑');
});

test('createMonitorSources：file 分支套用 tailBytes 尾部窗口，并如实报告总量', async () => {
  const long = 'x'.repeat(5000);
  const read = fakeReader({ 'big.txt': long });
  const sources = createMonitorSources({}, { deps: { read } });
  const out = await sources.read({ kind: 'file', path: 'big.txt' }, { tailBytes: 10 });
  assert.equal(Buffer.byteLength(out.text, 'utf8'), 10);
  assert.equal(out.totalBytes, 5000);
  assert.equal(out.truncated, true);
  assert.equal(read.calls[0].options.cwd, undefined);
});

test('job 源仍走 monitor.js 的采样器：枚举带 sessionId、readAt 带 caller', async () => {
  const listCalls = [];
  const readAtCalls = [];
  const jobs = {
    list(...args) { listCalls.push(args); return [{ id: 'pwsh-1', kind: 'pwsh', status: 'running', output: { total: 6 } }]; },
    readAt(...args) { readAtCalls.push(args); return { chunks: [{ at: 1, text: 'tail!' }], next: 6, lossy: false }; },
  };
  const { ctx } = fakeCtx({ jobs });
  const t = fakeTime();
  const out = registerMonitorTool(ctx, { deps: { decide: async () => ({ probability: 0.9 }), clock: t.clock, sleep: t.sleep } });
  const value = await out.definition.execute({ rubric: 'x', source: { kind: 'job' } }, EXEC);

  assert.deepEqual(listCalls, [['session-1']], '枚举必须带 sessionId（不带只回 unowned）');
  assert.deepEqual(readAtCalls, [['pwsh-1', 0, 'session-1']]);
  assert.equal(value.hit, true);
  assert.equal(value.evidence, 'tail!');
});

test('后台分支：注册作业并原样返回 jobId（不阻塞）', async () => {
  const { jobs, state } = fakeJobs();
  const t = fakeTime();
  const { ctx } = fakeCtx({ jobs });
  const read = fakeReader({ 'logs/a.txt': 'hit' });
  const out = registerMonitorTool(ctx, {
    deps: { decide: async () => ({ probability: 0.9 }), read, clock: t.clock, sleep: t.sleep },
  });

  const value = await out.definition.execute({
    rubric: 'x',
    source: { kind: 'file', path: 'logs/a.txt' },
    background: true,
    intervalMs: 1000,
    timeoutMs: 5000,
    countThreshold: 1,
  }, EXEC);
  assert.equal(value.background, true);
  assert.equal(value.jobId, 'monitor-job-1');
  assert.equal(value.mode, 'once');

  const settled = await state.handles[0].done;
  assert.equal(settled.status, 'completed');
  assert.ok(state.progress.length >= 1);
  assert.ok(state.progress[0].includes('1/1'));
});

test('后台分支：no job controller 时 attachController 后重试，并把 notifier 接到命中通知', async () => {
  const { jobs, state } = fakeJobs({ failStarts: 1 });
  const t = fakeTime();
  const { ctx } = fakeCtx({ jobs });
  const read = fakeReader({ 'logs/a.txt': 'hit' });
  const notices = [];
  const out = registerMonitorTool(ctx, {
    deps: {
      decide: async () => ({ probability: 0.9 }),
      read,
      clock: t.clock,
      sleep: t.sleep,
      notifier: { notify: (evt) => { notices.push(evt); } },
      agent: { status: 'idle' },
    },
  });

  const value = await out.definition.execute({
    rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' },
    background: true, notify: 'inbox', intervalMs: 1000, timeoutMs: 5000, countThreshold: 1,
  }, EXEC);
  assert.equal(value.jobId, 'monitor-job-2');
  assert.equal(state.attached, 'dsh-decision-tools-monitor');
  assert.equal(state.specs[0].owner, 'session-1');

  await state.handles[0].done;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].key, 'monitor-hit');
  assert.ok(notices[0].text.includes('命中'));
});

test('后台 + notify=inbox 但没注入 notifier/deliver ⇒ 直接拒绝，不静默丢通知', async () => {
  const { jobs } = fakeJobs();
  const t = fakeTime();
  const { ctx } = fakeCtx({ jobs });
  const read = fakeReader({ 'logs/a.txt': 'hit' });
  const out = registerMonitorTool(ctx, { deps: { decide: async () => ({ probability: 0.9 }), read, clock: t.clock, sleep: t.sleep } });
  await assert.rejects(
    () => out.definition.execute({ rubric: 'x', source: { kind: 'file', path: 'logs/a.txt' }, background: true, notify: 'inbox' }, EXEC),
    (error) => error instanceof TypeError,
  );
});

test('render 是全函数：异形 value 退化占位、绝不抛、绝不漏 undefined / NaN', () => {
  const foreground = renderMonitor({}, {
    background: false, mode: 'once', source: { kind: 'job' },
    clampNotes: [], notes: [],
    hit: true, count: 1, countThreshold: 1, samples: 2, hitSamples: 1, elapsedMs: 1000,
    probability: 0.91, confidence: null, level: true,
    at: 1700000000000, atIso: new Date(1700000000000).toISOString(),
    firstAt: 1700000000000, lastAt: 1700001000000, intervalMs: 1000, timeoutMs: 5000,
    aborted: false, timedOut: false, errors: 0, evidence: 'hello',
  });
  assert.ok(Array.isArray(foreground));
  const text = foreground[0].text;
  assert.ok(text.includes('HIT'));
  assert.ok(text.includes('hello'));
  assert.ok(!text.includes('undefined'));
  assert.ok(!text.includes('NaN'));

  for (const bad of [null, undefined, 0, 'x', [], { hit: 'yes', count: {}, clampNotes: 'no', notes: [null, 1, ''] }]) {
    const blocks = renderMonitor({}, bad);
    assert.ok(Array.isArray(blocks));
    assert.equal(blocks[0].type, 'text');
    assert.ok(!blocks[0].text.includes('undefined'));
    assert.ok(!blocks[0].text.includes('NaN'));
  }
});

test('render 把 clampNotes 与 notes 都印出来且不重复（clampNotes 只透传也不丢）', () => {
  const blocks = renderMonitor({}, {
    background: true, mode: 'once', source: { kind: 'file', path: 'a' }, jobId: 'j-1',
    clampNotes: ['intervalMs 被钳制：1 → 1000'], notes: ['intervalMs 被钳制：1 → 1000'],
  });
  const text = blocks[0].text;
  assert.equal(text.split('intervalMs 被钳制：1 → 1000').length - 1, 1, '同一条不得印两遍');
  assert.ok(text.includes('jobId j-1'));

  const onlyClamp = renderMonitor({}, {
    background: true, mode: 'once', source: { kind: 'file', path: 'a' }, jobId: 'j-2',
    clampNotes: ['timeoutMs 被钳制：5 → 60000'], notes: [],
  });
  assert.ok(onlyClamp[0].text.includes('timeoutMs 被钳制：5 → 60000'), '工具层没并进 notes 时也不能丢');
});

test('自定义工具名：config.monitorToolName 覆盖缺省 monitor', () => {
  const t = fakeTime();
  const { ctx, registered } = fakeCtx();
  const out = registerMonitorTool(ctx, {
    config: { monitorToolName: 'watch_it' },
    deps: { decide: async () => ({ probability: 0.9 }), clock: t.clock, sleep: t.sleep },
  });
  assert.equal(out.name, 'watch_it');
  assert.equal(out.definition.name, 'watch_it');
  assert.equal(registered[0].name, 'watch_it');
});

test('deps.register=false 时只造不注册（返回定义与归一后的宿主定义）', () => {
  const t = fakeTime();
  const { ctx, registered } = fakeCtx();
  const out = registerMonitorTool(ctx, {
    config: {},
    deps: { decide: async () => ({ probability: 0.9 }), clock: t.clock, sleep: t.sleep, register: false },
  });
  assert.equal(out.registered, false);
  assert.equal(registered.length, 0);
  assert.equal(typeof out.definition.execute, 'function');
  assert.equal(typeof out.hostDefinition.execute, 'function');
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SPILL_MAX_BYTES,
  DecisionPipeError,
  MAX_DELEGATION_DEPTH,
  SHA256_PREFIX_CHARS,
  runUpstream,
  spillRead,
  spillWrite,
  withDeadline,
} from '../lib/pipe.js';
import { DecisionValidationError } from '../lib/validate.js';

/**
 * 上游委托管道（规格 §5 / 计划 Task 7-9）。
 *
 * 装置纪律：
 *  - 委托**只**用假 ctx.tools.execute（受限会话里真跑 pwsh 一律 EPERM，真机留给 Task 11 的 P4）；
 *  - 超时与取消**只**用注入的假定时器 ⇒ 零真实墙钟判定；
 *  - 转储写在仓库内被 git 忽略的 .temp/pipe-test/（工作区可写，不污染受跟踪文件）。
 */

const WORKSPACE = fileURLToPath(new URL('..', import.meta.url));
const TEST_ROOT = fileURLToPath(new URL('../.temp/pipe-test/', import.meta.url));
const REPLACEMENT_CHAR = String.fromCharCode(0xFFFD);

fs.rmSync(TEST_ROOT, { recursive: true, force: true });
fs.mkdirSync(TEST_ROOT, { recursive: true });

function freshDir(name) {
  const dir = path.join(TEST_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
    clearTimeout(handle) { if (timers[handle] !== undefined) timers[handle].cleared = true; },
  };
}

let execSeq = 0;
function makeExec(overrides = {}) {
  execSeq += 1;
  const controller = new AbortController();
  const callId = 'call_t' + execSeq;
  const exec = {
    callId,
    rootCallId: callId,
    token: { tool: 'tool-token' },
    agent: { id: 'session-t' },
    signal: controller.signal,
    ...overrides,
  };
  return { exec, controller };
}

function fakeCtx(handler) {
  const calls = [];
  return {
    calls,
    ctx: {
      tools: {
        execute(args) {
          calls.push(args);
          return handler(args);
        },
      },
    },
  };
}

const okResult = (value) => ({ isError: false, value, content: [] });

async function rejectsWithKind(promise, kind) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DecisionValidationError, '期望 DecisionValidationError，得到 ' + error?.name);
    assert.equal(error.kind, kind);
    return true;
  });
}

function rejectsSpillPath(fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DecisionPipeError, '期望 DecisionPipeError，得到 ' + error?.name);
    assert.equal(error.kind, 'spill_path_rejected');
    return true;
  });
}

test('pipe：契约常量固定（1 层委托 / 16 位 sha256 前缀 / 默认转储上限为正数）', () => {
  assert.equal(MAX_DELEGATION_DEPTH, 1);
  assert.equal(SHA256_PREFIX_CHARS, 16);
  assert.ok(Number.isInteger(DEFAULT_SPILL_MAX_BYTES) && DEFAULT_SPILL_MAX_BYTES > 0);
});

test('runUpstream：委托同时带 agent 与 parent，并透传 rootCallId / 派生唯一 callId', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx(() => okResult('ok'));
  const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: { command: 'echo hi', description: 'x' } });
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args.name, 'pwsh');
  assert.deepEqual(args.arguments, { command: 'echo hi', description: 'x' });
  assert.ok(Object.hasOwn(args, 'agent'), '必须带 agent（不带时作用域内的工具名会 unknown）');
  assert.ok(Object.hasOwn(args, 'parent'), '必须带 parent（不带时模型面 content 会被截断）');
  assert.equal(args.agent, exec.agent);
  assert.equal(args.parent, exec.token);
  assert.equal(args.rootCallId, exec.rootCallId);
  assert.match(args.callId, /^call_t[0-9]+:up:[0-9]+$/);
  assert.deepEqual(Object.keys(out).sort(), ['bytes', 'isError', 'raw', 'toolName']);
  await runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
  assert.notEqual(calls[0].callId, calls[1].callId);
});

test('runUpstream：exec.signal 原样转发（同一实例），abort 后上游拿到的实例已 abort', async () => {
  const { exec, controller } = makeExec();
  let forwarded = null;
  const { ctx } = fakeCtx((args) => new Promise((resolve) => {
    forwarded = args.signal;
    args.signal.addEventListener('abort', () => resolve({ isError: true, error: { message: 'tool call aborted', info: { code: 'ABORTED' } }, content: [] }), { once: true });
  }));
  const pending = runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(forwarded, controller.signal);
  controller.abort();
  const out = await pending;
  assert.equal(forwarded.aborted, true);
  assert.equal(out.isError, true);
  assert.equal(out.error.code, 'ABORTED');
});

test('runUpstream：普通工具取 value（对象按 JSON 规范化、字符串原样、bytes 为 UTF-8 字节数）', async () => {
  const { exec } = makeExec();
  const { ctx } = fakeCtx((args) => okResult(args.name === 'read' ? { path: 'a.md', bytes: 3 } : '纯文本 ok'));
  const asObject = await runUpstream(ctx, exec, { tool: 'read', arguments: {} });
  assert.equal(asObject.raw, JSON.stringify({ path: 'a.md', bytes: 3 }, null, 2));
  assert.equal(asObject.bytes, Buffer.byteLength(asObject.raw, 'utf8'));
  assert.equal(asObject.isError, false);
  const asText = await runUpstream(ctx, exec, { tool: 'echo', arguments: {} });
  assert.equal(asText.raw, '纯文本 ok');
  assert.equal(asText.bytes, Buffer.byteLength('纯文本 ok', 'utf8'));
  assert.equal(Object.hasOwn(asText, 'exitCode'), false);
});

test('runUpstream：进程型取 stdout+stderr 与 exitCode，并带出宿主转储路径与 truncated', async () => {
  const { exec } = makeExec();
  const { ctx } = fakeCtx(() => okResult({
    kind: 'foreground',
    exitCode: 2,
    signal: null,
    timedOut: false,
    stdout: { text: 'out-line', truncated: true, spillPath: '/tmp/host-spill-out.log' },
    stderr: { text: 'err-line', truncated: false },
  }));
  const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(out.raw, 'out-line' + String.fromCharCode(10) + 'err-line');
  assert.equal(out.exitCode, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.spillPath, '/tmp/host-spill-out.log');
  assert.equal(out.bytes, Buffer.byteLength(out.raw, 'utf8'));
  assert.deepEqual(Object.keys(out).sort(), ['bytes', 'exitCode', 'isError', 'raw', 'spillPath', 'toolName', 'truncated']);
});

test('runUpstream：进程型未截断时不出现 spillPath，truncated 为 false', async () => {
  const { exec } = makeExec();
  const { ctx } = fakeCtx(() => okResult({
    kind: 'foreground',
    exitCode: 0,
    stdout: { text: 'done', truncated: false },
    stderr: { text: '', truncated: false },
  }));
  const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(out.raw, 'done');
  assert.equal(out.truncated, false);
  assert.equal(Object.hasOwn(out, 'spillPath'), false);
});

test('runUpstream：isError 不 throw，透传 error.info.code，未知工具文案写「不存在或被禁用」', async () => {
  const { exec } = makeExec();
  const { ctx } = fakeCtx(() => ({
    isError: true,
    error: { message: 'unknown tool "no_such_tool"', info: { name: 'ToolNotFoundError', code: 'UNKNOWN_TOOL' } },
    content: [{ type: 'text', text: 'Error: unknown tool "no_such_tool"' }],
  }));
  const out = await runUpstream(ctx, exec, { tool: 'no_such_tool', arguments: {} });
  assert.equal(out.isError, true);
  assert.equal(out.error.code, 'UNKNOWN_TOOL');
  assert.match(out.error.message, /不存在或被禁用/);
  assert.equal(out.raw, '');
  assert.equal(out.bytes, 0);
});

test('runUpstream：ABORTED / TOOL_TIMEOUT / 自定义 code 都逐字透传', async () => {
  const { exec } = makeExec();
  for (const code of ['ABORTED', 'TOOL_TIMEOUT', 'EACCES']) {
    const { ctx } = fakeCtx(() => ({ isError: true, error: { message: 'boom ' + code, info: { code } }, content: [] }));
    const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
    assert.equal(out.isError, true);
    assert.equal(out.error.code, code);
    assert.ok(out.error.message.length > 0);
  }
});

test('runUpstream：execute 抛错（同步 / 异步）不向上抛，归一为可判读的 code', async () => {
  const { exec } = makeExec();
  const syncCtx = { tools: { execute() { throw new Error('sync boom'); } } };
  const syncOut = await runUpstream(syncCtx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(syncOut.isError, true);
  assert.equal(syncOut.error.code, 'TOOL_ERROR');
  assert.match(syncOut.error.message, /sync boom/);
  const asyncCtx = { tools: { execute: async () => { const error = new Error('async boom'); error.code = 'EIO'; throw error; } } };
  const asyncOut = await runUpstream(asyncCtx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(asyncOut.isError, true);
  assert.equal(asyncOut.error.code, 'EIO');
  assert.match(asyncOut.error.message, /async boom/);
});

test('runUpstream：宿主返回非对象结果按错误上报，不静默当空输出', async () => {
  const { exec } = makeExec();
  const { ctx } = fakeCtx(() => 'not-an-object');
  const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} });
  assert.equal(out.isError, true);
  assert.equal(out.error.code, 'TOOL_ERROR');
  assert.match(out.error.message, /非对象结果/);
});

test('runUpstream：上游忽略 signal 时，timeoutMs 到点仍自行返回 TOOL_TIMEOUT（假定时器）', async () => {
  const { exec } = makeExec();
  const gate = deferred();
  const timers = fakeTimers();
  const { ctx } = fakeCtx(() => gate.promise);
  const pending = runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} }, {
    timeoutMs: 500,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.equal(timers.timers.length, 1, 'deadline 必须挂上');
  assert.equal(timers.timers[0].ms, 500);
  timers.timers[0].fn();
  const out = await pending;
  assert.equal(out.isError, true);
  assert.equal(out.error.code, 'TOOL_TIMEOUT');
  assert.equal(timers.timers[0].cleared, true);
  gate.resolve(okResult('late'));
  await gate.promise;
});

test('禁自递归：decision / monitor 不得作为上游工具，且拒绝发生在派发之前', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx(() => okResult('ok'));
  await rejectsWithKind(runUpstream(ctx, exec, { tool: 'decision', arguments: {} }), 'upstream_self_recursion');
  await rejectsWithKind(runUpstream(ctx, exec, { tool: 'monitor', arguments: {} }), 'upstream_self_recursion');
  await rejectsWithKind(runUpstream(ctx, exec, { tool: ' decision ', arguments: {} }), 'upstream_self_recursion');
  assert.equal(calls.length, 0);
});

test('禁自递归：selfToolNames 可覆盖（部署改了工具名也拦得住）', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx(() => okResult('ok'));
  await rejectsWithKind(
    runUpstream(ctx, exec, { tool: 'decision_v4', arguments: {} }, { selfToolNames: ['decision_v4'] }),
    'upstream_self_recursion',
  );
  assert.equal(calls.length, 0);
});

test('禁二层委托：上游工具再委托回本插件时被拒（callId 前缀链）', async () => {
  const { exec } = makeExec();
  const holder = {};
  let nestedError = null;
  const { ctx } = fakeCtx(async (args) => {
    try {
      await runUpstream(holder.ctx, { ...exec, callId: args.callId, parent: { nested: true } }, { tool: 'pwsh', arguments: {} });
    } catch (error) {
      nestedError = error;
    }
    return okResult('outer-ok');
  });
  holder.ctx = ctx;
  const out = await runUpstream(ctx, exec, { tool: 'some_tool', arguments: {} });
  assert.equal(out.isError, false);
  assert.ok(nestedError instanceof DecisionValidationError);
  assert.equal(nestedError.kind, 'upstream_depth_exceeded');
  assert.match(nestedError.message, /只允许 1 层委托/);
});

test('禁二层委托：宿主没给 callId 前缀链时按 exec.parent 兜底拒绝', async () => {
  const { exec } = makeExec();
  const holder = {};
  let nestedError = null;
  const { ctx } = fakeCtx(async () => {
    try {
      await runUpstream(holder.ctx, { ...exec, callId: 'call_other_tool', parent: { nested: true } }, { tool: 'pwsh', arguments: {} });
    } catch (error) {
      nestedError = error;
    }
    return okResult('outer-ok');
  });
  holder.ctx = ctx;
  const out = await runUpstream(ctx, exec, { tool: 'other_tool', arguments: {} });
  assert.equal(out.isError, false);
  assert.equal(nestedError?.kind, 'upstream_depth_exceeded');
});

test('深度计数不误伤兄弟委托：同一顶层调用并发两次委托都放行', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx((args) => Promise.resolve(okResult(args.name)));
  const [a, b] = await Promise.all([
    runUpstream(ctx, exec, { tool: 'tool_a', arguments: {} }),
    runUpstream(ctx, exec, { tool: 'tool_b', arguments: {} }),
  ]);
  assert.equal(a.raw, 'tool_a');
  assert.equal(b.raw, 'tool_b');
  assert.notEqual(calls[0].callId, calls[1].callId);
});

test('深度计数不泄漏：被拒一次、成功一次之后，新的顶层委托仍放行', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx(() => okResult('ok'));
  await rejectsWithKind(runUpstream(ctx, exec, { tool: 'decision', arguments: {} }), 'upstream_self_recursion');
  assert.equal((await runUpstream(ctx, exec, { tool: 'read', arguments: {} })).isError, false);
  assert.equal((await runUpstream(ctx, exec, { tool: 'read', arguments: {} })).isError, false);
  assert.equal(calls.length, 2);
});

test('runUpstream：upstream 形状不合法时给可行动报错（缺 tool / arguments 非对象）', async () => {
  const { exec } = makeExec();
  const { ctx, calls } = fakeCtx(() => okResult('ok'));
  await rejectsWithKind(runUpstream(ctx, exec, {}), 'upstream_invalid');
  await rejectsWithKind(runUpstream(ctx, exec, { tool: '   ' }), 'upstream_invalid');
  await rejectsWithKind(runUpstream(ctx, exec, { tool: 'read', arguments: 'nope' }), 'upstream_invalid');
  assert.equal(calls.length, 0);
});

test('runUpstream：ctx 可给插件 ctx（ctx.tools）或工具服务本身；都没有时 pipe_unavailable', async () => {
  const { exec } = makeExec();
  const service = { execute: () => okResult('ok') };
  assert.equal((await runUpstream(service, exec, { tool: 'read', arguments: {} })).raw, 'ok');
  assert.equal((await runUpstream({ tools: service }, exec, { tool: 'read', arguments: {} })).raw, 'ok');
  await assert.rejects(runUpstream({}, exec, { tool: 'read', arguments: {} }), (error) => {
    assert.ok(error instanceof DecisionPipeError);
    assert.equal(error.kind, 'pipe_unavailable');
    return true;
  });
});
test('runUpstream：真实 Cordis ctx（未 inject 的 execute 读取会抛）仍走 ctx.tools 完成委托', async () => {
  const { exec } = makeExec();
  const calls = [];
  const ctx = {};
  Object.defineProperty(ctx, 'execute', {
    get() { throw new Error('cannot get property "execute" without inject'); },
    configurable: true,
  });
  ctx.tools = { execute(args) { calls.push(args); return okResult('spawn-ok'); } };
  const out = await runUpstream(ctx, exec, { tool: 'pwsh', arguments: { command: 'Write-Output PROBE-OK' } });
  assert.equal(out.isError, false);
  assert.equal(out.raw, 'spawn-ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.equal(calls[0].agent, exec.agent);
  assert.equal(calls[0].parent, exec.token);
});

test('runUpstream：ctx.tools 读取会抛、而 ctx 本身即工具服务时兜底分支仍可用', async () => {
  const { exec } = makeExec();
  const service = { execute: () => okResult('direct-ok') };
  Object.defineProperty(service, 'tools', {
    get() { throw new Error('cannot get property "tools" without inject'); },
    configurable: true,
  });
  const out = await runUpstream(service, exec, { tool: 'read', arguments: {} });
  assert.equal(out.raw, 'direct-ok');
});

test('runUpstream：execute 与 tools 读取都抛时归一为 pipe_unavailable（不泄漏平台报错）', async () => {
  const { exec } = makeExec();
  const ctx = {};
  for (const key of ['execute', 'tools']) {
    Object.defineProperty(ctx, key, {
      get() { throw new Error('cannot get property "' + key + '" without inject'); },
      configurable: true,
    });
  }
  await assert.rejects(runUpstream(ctx, exec, { tool: 'pwsh', arguments: {} }), (error) => {
    assert.ok(error instanceof DecisionPipeError, '期望 DecisionPipeError，得到 ' + error?.name);
    assert.equal(error.kind, 'pipe_unavailable');
    assert.match(error.message, /工具服务/);
    return true;
  });
});

test('spillWrite：无条件落盘（几字节也写），bytes / fullBytes / sha256Prefix 与磁盘相符', () => {
  const dir = freshDir('spill-small');
  const out = spillWrite('hi', { dir, label: 'upstream' });
  const onDisk = fs.readFileSync(out.path);
  assert.equal(onDisk.toString('utf8'), 'hi');
  assert.equal(out.bytes, onDisk.length);
  assert.equal(out.bytes, 2);
  assert.equal(out.fullBytes, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.sha256Prefix, sha256Hex(onDisk).slice(0, SHA256_PREFIX_CHARS));
  assert.equal(path.dirname(out.path), path.resolve(dir));
  assert.deepEqual(Object.keys(out).sort(), ['bytes', 'fullBytes', 'path', 'sha256Prefix', 'truncated']);
});

test('spillWrite：空输出也落盘（bytes 0），不是「小就不写」', () => {
  const dir = freshDir('spill-empty');
  const out = spillWrite('', { dir });
  assert.equal(fs.existsSync(out.path), true);
  assert.equal(out.bytes, 0);
  assert.equal(out.fullBytes, 0);
  assert.equal(out.truncated, false);
});

test('spillWrite：超 maxBytes 时截断并如实报告 truncated 与 fullBytes', () => {
  const dir = freshDir('spill-cut');
  const out = spillWrite('ABCDEFGHIJ', { dir, maxBytes: 4 });
  assert.equal(out.truncated, true);
  assert.equal(out.fullBytes, 10);
  assert.equal(out.bytes, 4);
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'ABCD');
  assert.equal(out.sha256Prefix, sha256Hex(fs.readFileSync(out.path)).slice(0, SHA256_PREFIX_CHARS));
});

test('spillWrite：截断不切断多字节字符（回退到字符边界，读回无替换字符）', () => {
  const dir = freshDir('spill-multibyte');
  const out = spillWrite('中中中', { dir, maxBytes: 5 });
  assert.equal(out.truncated, true);
  assert.ok(out.bytes <= 5);
  assert.equal(out.bytes % 3, 0);
  const text = fs.readFileSync(out.path, 'utf8');
  assert.equal(text, '中');
  assert.equal(text.includes(REPLACEMENT_CHAR), false);
});

test('spillWrite：dir 不存在时递归创建；两次调用路径不同', () => {
  const dir = path.join(TEST_ROOT, 'spill-nested', 'a', 'b');
  fs.rmSync(path.join(TEST_ROOT, 'spill-nested'), { recursive: true, force: true });
  const first = spillWrite('x', { dir });
  const second = spillWrite('x', { dir });
  assert.equal(fs.existsSync(first.path), true);
  assert.notEqual(first.path, second.path);
});

test('spillWrite：缺 dir 抛 DecisionPipeError(kind=spill_dir_missing)', () => {
  assert.throws(() => spillWrite('x', {}), (error) => {
    assert.ok(error instanceof DecisionPipeError);
    assert.equal(error.kind, 'spill_dir_missing');
    return true;
  });
});

test('spillRead：allowedRoots 内的转储逐字读回（含非 ASCII 与换行）', () => {
  const dir = freshDir('read-ok');
  const text = '中文 & ascii' + String.fromCharCode(10) + 'second line';
  const file = spillWrite(text, { dir }).path;
  assert.equal(spillRead(file, { allowedRoots: [dir] }), text);
});

test('spillRead：拒绝 allowedRoots 之外的路径（即便文件真实存在）', () => {
  const dir = freshDir('read-outside');
  const outside = path.join(WORKSPACE, 'lib', 'pipe.js');
  assert.equal(fs.existsSync(outside), true);
  rejectsSpillPath(() => spillRead(outside, { allowedRoots: [dir] }));
  rejectsSpillPath(() => spillRead(path.join(WORKSPACE, 'lib'), { allowedRoots: [dir] }));
  rejectsSpillPath(() => spillRead(path.join(dir, '..', 'read-ok'), { allowedRoots: [dir] }));
});

test('spillRead：拒绝含 .. 段的路径（即使解析后仍落在 root 内）', () => {
  const dir = freshDir('read-dotdot');
  const file = spillWrite('x', { dir }).path;
  const sneaky = dir + path.sep + 'sub' + path.sep + '..' + path.sep + path.basename(file);
  rejectsSpillPath(() => spillRead(sneaky, { allowedRoots: [dir] }));
});

test('spillRead：allowedRoots 缺失或为空时一律拒绝（fail-closed，不默认放行）', () => {
  const dir = freshDir('read-noRoots');
  const file = spillWrite('x', { dir }).path;
  rejectsSpillPath(() => spillRead(file));
  rejectsSpillPath(() => spillRead(file, {}));
  rejectsSpillPath(() => spillRead(file, { allowedRoots: [] }));
  rejectsSpillPath(() => spillRead(file, { allowedRoots: [''] }));
});

test('spillRead：Windows 下根的大小写差异不影响判定', { skip: process.platform !== 'win32' }, () => {
  const dir = freshDir('read-case');
  const file = spillWrite('case-insensitive', { dir }).path;
  assert.equal(spillRead(file, { allowedRoots: [dir.toUpperCase()] }), 'case-insensitive');
});

test('spillRead：符号链接指向根外时被拒（realpath 收紧，绝不放宽）', (t) => {
  const dir = freshDir('read-link');
  const outside = path.join(WORKSPACE, 'lib', 'pipe.js');
  const link = path.join(dir, 'escape.js');
  try {
    fs.symlinkSync(outside, link, 'file');
  } catch (error) {
    t.skip('本机不允许创建符号链接（' + (error.code ?? error.message) + '）');
    return;
  }
  rejectsSpillPath(() => spillRead(link, { allowedRoots: [dir] }));
});

test('spillRead：文件不存在时抛 spill_read_failed（与路径拒绝分开）', () => {
  const dir = freshDir('read-missing');
  assert.throws(() => spillRead(path.join(dir, 'nope.txt'), { allowedRoots: [dir] }), (error) => {
    assert.ok(error instanceof DecisionPipeError);
    assert.equal(error.kind, 'spill_read_failed');
    return true;
  });
});

test('withDeadline：fn 先完成时返回其值，并清掉定时器', async () => {
  const timers = fakeTimers();
  const out = await withDeadline(async () => 42, { timeoutMs: 1000, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  assert.deepEqual(out, { timedOut: false, aborted: false, value: 42, error: undefined });
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].cleared, true);
});

test('withDeadline：fn 抛错被捕获成 error 字段（不向上抛）', async () => {
  const boom = new Error('boom');
  const out = await withDeadline(() => { throw boom; }, { timeoutMs: 1000 });
  assert.equal(out.timedOut, false);
  assert.equal(out.aborted, false);
  assert.equal(out.error, boom);
  assert.equal(out.value, undefined);
});

test('withDeadline：定时器先到返回 timedOut，且之后 fn 完成不会翻盘', async () => {
  const timers = fakeTimers();
  const gate = deferred();
  const pending = withDeadline(() => gate.promise, { timeoutMs: 10, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  assert.equal(timers.timers.length, 1);
  timers.timers[0].fn();
  const out = await pending;
  assert.equal(out.timedOut, true);
  assert.equal(out.value, undefined);
  gate.resolve('late');
  await gate.promise;
  assert.equal((await pending).timedOut, true);
});

test('withDeadline：signal abort 立刻返回 aborted 并清掉定时器', async () => {
  const timers = fakeTimers();
  const controller = new AbortController();
  const pending = withDeadline(() => new Promise(() => {}), {
    signal: controller.signal,
    timeoutMs: 50,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  controller.abort();
  const out = await pending;
  assert.deepEqual(out, { timedOut: false, aborted: true, value: undefined, error: undefined });
  assert.equal(timers.timers[0].cleared, true);
});

test('withDeadline：signal 已 abort 时直接返回，不调用 fn', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const out = await withDeadline(() => { called = true; return 1; }, { signal: controller.signal, timeoutMs: 50 });
  assert.equal(out.aborted, true);
  assert.equal(called, false);
});

test('withDeadline：timeoutMs 非正 / 非有限时不设定时器（不伪造 deadline）', async () => {
  for (const timeoutMs of [0, -1, Number.NaN, undefined]) {
    const timers = fakeTimers();
    const out = await withDeadline(async () => 'ok', { timeoutMs, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
    assert.equal(out.value, 'ok');
    assert.equal(timers.timers.length, 0);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUpstreamMaterial } from '../lib/tool.js';
import { DecisionSourceError } from '../lib/source.js';

/** 一个真实的临时转储目录（转储由插件自建，测试里用 mkdtemp 给一个干净起点）。 */
const newDir = () => mkdtempSync(join(tmpdir(), 'dsh-upstream-test-'));
const EXEC = { agent: { id: 'agent-1' }, token: 'tok-1', rootCallId: 'root-1', callId: 'call-1' };

test('material.tool：委托执行必须同时带 agent 与 parent，且原始输出无条件转储可逐字取回', async () => {
  const spillDir = newDir();
  const calls = [];
  const ctx = { tools: { execute: async (args) => { calls.push(args); return { isError: false, value: 'HELLO-RAW' + String.fromCharCode(10), content: 'HELLO-RAW' + String.fromCharCode(10) }; } } };
  const r = await resolveUpstreamMaterial(ctx, EXEC, { name: 'pwsh', arguments: { command: 'echo hi' } }, { spillDir, spillMaxBytes: 4096 });
  assert.equal(r.source, 'tool');
  assert.equal(r.upstreamTool, 'pwsh');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, EXEC.agent, '必须带 agent：不带时作用域外的工具名报 unknown tool');
  assert.equal(calls[0].parent, EXEC.token, '必须带 parent：不带时模型面 content 会被截断');
  assert.equal(calls[0].name, 'pwsh');
  assert.ok(r.spillPath.startsWith(spillDir), '转储必须落在给定的自建目录内');
  assert.equal(readFileSync(r.spillPath, 'utf8'), r.text, '原始字节必须能从转储逐字取回（不吞掉）');
  assert.ok(r.bytes > 0);
  assert.equal(r.truncated, false);
  rmSync(spillDir, { recursive: true, force: true });
});

test('material.tool：小输出也照样落盘（无条件），并且 bytes 与转储内容一致', async () => {
  const spillDir = newDir();
  const ctx = { tools: { execute: async () => ({ isError: false, value: 'x' }) } };
  const r = await resolveUpstreamMaterial(ctx, EXEC, { name: 'pwsh' }, { spillDir });
  assert.equal(readFileSync(r.spillPath, 'utf8'), 'x', '10 字节也要有转储 —— 否则句柄不存在');
  assert.equal(r.bytes, 1);
  rmSync(spillDir, { recursive: true, force: true });
});

test('material.tool：自递归、上游失败、无 tools 服务都是可行动错误而不是静默', async () => {
  const spillDir = newDir();
  const ok = { tools: { execute: async () => ({ isError: false, value: 'x' }) } };
  await assert.rejects(
    () => resolveUpstreamMaterial(ok, EXEC, { name: 'decision' }, { spillDir }),
    (e) => e.kind === 'upstream_self_recursion',
    '自递归必须被拒（宿主没有深度护栏）',
  );
  const fail = { tools: { execute: async () => ({ isError: true, error: { code: 'UNKNOWN_TOOL', message: 'unknown tool "nope"' } }) } };
  await assert.rejects(
    () => resolveUpstreamMaterial(fail, EXEC, { name: 'nope' }, { spillDir }),
    (e) => e instanceof DecisionSourceError && String(e.kind).startsWith('upstream_') && /UNKNOWN_TOOL/.test(e.message),
    '上游失败要透传 code 并给可行动项',
  );
  await assert.rejects(
    () => resolveUpstreamMaterial({}, EXEC, { name: 'pwsh' }, { spillDir }),
    (e) => e.kind === 'tool_service_missing',
  );
  rmSync(spillDir, { recursive: true, force: true });
});
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateQuestions, validateMonitorArgs } from '../lib/validate.js';

const noul = (criteria) => ({ name: 'q', type: 'noul', instructions: 'x', ...(criteria === undefined ? {} : { criteria }) });

test('noul criteria 的值必须是可读描述（此前只查键，{true:123} 能通过）', () => {
  assert.doesNotThrow(() => validateQuestions([noul({ true: 'yes', false: 'no' })]));
  assert.doesNotThrow(() => validateQuestions([noul()]));
  for (const bad of [{ true: 123 }, { true: '' }, { false: '   ' }, { yes: 'x' }]) {
    assert.throws(() => validateQuestions([noul(bad)]), /criteria/, JSON.stringify(bad) + ' 必须被拒');
  }
});

test('rebuild 刷新判定：版本不同就要重拷（否则 DSH 升级后静默跑旧包）', async () => {
  const mod = await import('../scripts/rebuild-node-modules.mjs');
  const has = typeof mod.needsRefresh === 'function';
  assert.ok(has, 'scripts/rebuild-node-modules.mjs 必须导出 needsRefresh（可单测，避免只能靠人眼）');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rebuild-'));
  const src = path.join(root, 'src'); const dst = path.join(root, 'dst');
  fs.mkdirSync(src, { recursive: true }); fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'p', version: '2.0.0' }));
  fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }));
  assert.equal(mod.needsRefresh(src, dst), true, '1.0.0 → 2.0.0 必须刷新');
  fs.writeFileSync(path.join(dst, 'package.json'), JSON.stringify({ name: 'p', version: '2.0.0' }));
  assert.equal(mod.needsRefresh(src, dst), false, '同版本不重复拷');
  fs.rmSync(path.join(dst, 'package.json'));
  assert.equal(mod.needsRefresh(src, dst), true, '目标缺 package.json ⇒ 需要刷新');
  fs.rmSync(root, { recursive: true, force: true });
});
test('空源短路：execute 返回 samples=1、不调 decide，并在 notes 里说明原因', async () => {
  const { registerMonitorTool } = await import('../lib/monitor-tool.js');
  let decides = 0;
  const { definition } = registerMonitorTool({ tools: { register() {} } }, {
    deps: {
      register: false,
      read: async () => ({ text: '' }),
      decide: async () => { decides += 1; return { probability: 1 }; },
    },
  });
  const value = await definition.execute({ rubric: 'x', source: { kind: 'file', path: 'tmp/empty.txt' } }, {});
  assert.equal(value.samples, 1);
  assert.equal(value.emptySource, true);
  assert.equal(decides, 0, '空源不得调用 Decision');
  assert.ok(value.notes.some((n) => /空内容/.test(n)), 'notes 必须说明短路：' + JSON.stringify(value.notes));

  assert.equal(value.emptyReason, undefined, '内部字段不得外泄');
});
test('events.types 词表：拼错在参数阶段被拒并列出合法值', () => {
  const out = (() => { try { validateMonitorArgs({ rubric: 'x', source: { kind: 'events', types: ['job.failedd'] } }); return null; } catch (e) { return e; } })();
  assert.ok(out, '拼错的类型必须被拒');
  assert.equal(out.kind, 'source_invalid');
  assert.match(out.message, /job\.failedd/);
  assert.match(out.message, /job\.failed/, '必须列出合法值');
  assert.doesNotThrow(() => validateMonitorArgs({ rubric: 'x', source: { kind: 'events', types: ['job.failed', 'job.completed'] } }));
});
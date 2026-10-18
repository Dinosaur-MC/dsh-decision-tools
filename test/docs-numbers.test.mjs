import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 防复发守卫：`docs/architecture.md` §1.2 的「模块数 / 总行数」与模块表，必须与 `lib/*.js` 实测一致。
 *
 * 为什么需要它：docs-writer 与 verifier 两轮独立审查都发现同一类漂移（17/5906 → 18/6353 → 20/6483），
 * 每次都是「代码加了模块、文档忘了改」，而且没有任何测试会红。这里把它变成一次性检查。
 */
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const DOC = path.join(ROOT, 'docs', 'architecture.md');

const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).sort();
const actualLines = new Map(libFiles.map((f) => [f, fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8').split('\n').length - 1]));
const total = [...actualLines.values()].reduce((a, b) => a + b, 0);
const doc = fs.readFileSync(DOC, 'utf8');

test('§1.2 标题里的模块数与总行数 == lib/*.js 实测', () => {
  const m = doc.match(/### 1\.2 模块图（(\d+) 个模块 \/ (\d+) 行/);
  assert.ok(m, '§1.2 标题必须写「（N 个模块 / M 行」');
  assert.equal(Number(m[1]), libFiles.length, '模块数漂移：文档 ' + m[1] + ' vs 实测 ' + libFiles.length);
  assert.equal(Number(m[2]), total, '总行数漂移：文档 ' + m[2] + ' vs 实测 ' + total);
});

test('§1.2 模块表每一行的行数 == 该文件实测（且不多不少）', () => {
  const rows = [...doc.matchAll(/^\| `([^`]+\.js)` \| (\d+) \|/gm)];
  assert.ok(rows.length >= 15, '模块表应有至少 15 行，实际 ' + rows.length);
  const problems = [];
  const documented = new Set();
  for (const [, file, lines] of rows) {
    documented.add(file);
    const actual = actualLines.get(file);
    if (actual === undefined) { problems.push(file + ' 文档里有、lib/ 里没有'); continue; }
    if (Number(lines) !== actual) problems.push(file + '：文档 ' + lines + ' vs 实测 ' + actual);
  }
  for (const file of actualLines.keys()) if (!documented.has(file)) problems.push(file + ' 在 lib/ 里但模块表没写');
  assert.deepEqual(problems, [], '模块表与实测不一致：\n' + problems.join('\n'));
});
test('§5 的顶层用例数与测试文件数 == 实测（例数由实跑决定，不在此断言）', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const top = doc.match(/顶层 `test\(` 声明 \*\*(\d+)\*\* 条/);
  const files = doc.match(/共 \*\*(\d+)\*\* 个测试文件/);
  assert.ok(top && files, '§5 必须写明顶层用例数与测试文件数');
  const testDir = path.join(ROOT, 'test');
  const actualFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).length;
  let actualTop = 0;
  for (const f of fs.readdirSync(testDir)) {
    if (!f.endsWith('.test.mjs')) continue;
    const src = fs.readFileSync(path.join(testDir, f), 'utf8');
    actualTop += (src.match(/^test\(/gm) ?? []).length;
  }
  assert.equal(Number(top[1]), actualTop, '顶层 test 数漂移：文档 ' + top[1] + ' vs 实测 ' + actualTop);
  assert.equal(Number(files[1]), actualFiles, '测试文件数漂移：文档 ' + files[1] + ' vs 实测 ' + actualFiles);
});
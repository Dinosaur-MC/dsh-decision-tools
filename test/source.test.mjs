import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionSourceError,
  isUnsafePath,
  validateSourceDescriptor,
  sliceByLines,
  chunk,
  splitGlobPattern,
  matchGlobSegment,
  isRecursiveGlob,
} from '../lib/source.js';

const DOC = ['# Title', '', 'para one', 'para two', '', '## Sec', 'x', '', 'tail'].join('\n');

function expectReject(fn, matcher) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DecisionSourceError, `期望 DecisionSourceError，得到 ${error?.name}`);
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, matcher);
    return true;
  });
}

test('isUnsafePath：绝对路径（POSIX / Windows / UNC）与 .. 段一律判不安全', () => {
  assert.equal(isUnsafePath('docs/a.md'), false);
  assert.equal(isUnsafePath('a/b/c.md'), false);
  assert.equal(isUnsafePath('/etc/passwd'), true);
  assert.equal(isUnsafePath('C:\\Windows\\x.txt'), true);
  assert.equal(isUnsafePath('\\\\srv\\share\\x'), true);
  assert.equal(isUnsafePath('a/../../b.md'), true);
  assert.equal(isUnsafePath('../b.md'), true);
});

test('validateSourceDescriptor：file 相对路径通过并只保留已知键', () => {
  assert.deepEqual(validateSourceDescriptor({ kind: 'file', path: 'docs/a.md' }), { kind: 'file', path: 'docs/a.md' });
  assert.deepEqual(validateSourceDescriptor({ kind: 'file', path: 'a.md', startLine: 2, endLine: 9 }),
    { kind: 'file', path: 'a.md', startLine: 2, endLine: 9 });
});

test('validateSourceDescriptor：拒绝绝对路径与 .. 段（引用式不得成为越权读盘口子）', () => {
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: '/etc/passwd' }), /工作区根内的相对路径/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: '../x.md' }), /工作区根内的相对路径/);
  expectReject(() => validateSourceDescriptor({ kind: 'glob', pattern: 'C:\\x\\*.md' }), /工作区根内的相对 glob/);
});

test('validateSourceDescriptor：形状错误一律可行动报错', () => {
  expectReject(() => validateSourceDescriptor(null), /必须是对象/);
  expectReject(() => validateSourceDescriptor([]), /必须是对象/);
  expectReject(() => validateSourceDescriptor({ kind: 'dir', path: 'a' }), /只允许 file 或 glob/);
  expectReject(() => validateSourceDescriptor({ kind: 'file' }), /path 必须是非空字符串/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: '' }), /path 必须是非空字符串/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: 'a.md', extra: 1 }), /不认识键/);
  expectReject(() => validateSourceDescriptor({ kind: 'glob', pattern: '*.md', path: 'x' }), /不认识键/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: 'a.md', startLine: 0 }), /startLine 必须是 ≥ 1 的整数/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: 'a.md', startLine: 1.5 }), /startLine 必须是 ≥ 1 的整数/);
  expectReject(() => validateSourceDescriptor({ kind: 'file', path: 'a.md', startLine: 5, endLine: 2 }), /不得小于 startLine/);
});

test('validateSourceDescriptor：glob 的 pattern 与 limit', () => {
  assert.deepEqual(validateSourceDescriptor({ kind: 'glob', pattern: 'docs/**/*.md' }),
    { kind: 'glob', pattern: 'docs/**/*.md' });
  assert.deepEqual(validateSourceDescriptor({ kind: 'glob', pattern: '*.md', limit: 3 }),
    { kind: 'glob', pattern: '*.md', limit: 3 });
  expectReject(() => validateSourceDescriptor({ kind: 'glob', pattern: '*.md', limit: 0 }), /limit 必须是 ≥ 1 的整数/);
  expectReject(() => validateSourceDescriptor({ kind: 'glob', pattern: '' }), /pattern 必须是非空字符串/);
});

test('sliceByLines：1-based 闭区间，逐字取行', () => {
  const text = 'l1\nl2\nl3\nl4';
  assert.equal(sliceByLines(text, 2, 3).text, 'l2\nl3');
  assert.equal(sliceByLines(text, 4, 4).text, 'l4');
  assert.equal(sliceByLines(text, 1, 4).text, text);
  assert.deepEqual(sliceByLines(text, 2, 3), { text: 'l2\nl3', startLine: 2, endLine: 3, lines: 4 });
  assert.equal(sliceByLines(text).text, text, '不传区间即整份');
});

test('sliceByLines：越界报错，绝不静默截断', () => {
  const text = 'l1\nl2\nl3\nl4';
  expectReject(() => sliceByLines(text, 0, 2), /startLine 0 越界/);
  expectReject(() => sliceByLines(text, 5, 6), /startLine 5 越界/);
  expectReject(() => sliceByLines(text, 1, 5), /endLine 5 越界/);
  expectReject(() => sliceByLines(text, 3, 2), /endLine 2 越界/);
});

test('chunk：空文本零块；短文本一块', () => {
  assert.deepEqual(chunk('', { budgetBytes: 16 }), { chunks: [], truncated: false, remaining: 0, totalBytes: 0, truncatedBy: null });
  const one = chunk('abc', { budgetBytes: 16 });
  assert.equal(one.chunks.length, 1);
  assert.equal(one.chunks[0].text, 'abc');
  assert.equal(one.chunks[0].name, 'c1');
  assert.equal(one.chunks[0].bytes, 3);
});

test('chunk：按预算切且优先落在语义边界（空行）上', () => {
  const r = chunk(DOC, { budgetBytes: 20 });
  assert.equal(r.truncated, false);
  assert.equal(r.remaining, 0);
  assert.equal(r.chunks.length, 3);
  assert.equal(r.chunks[0].text, '# Title\n', '第一块必须停在空行边界');
  assert.equal(r.chunks[0].startLine, 1);
  assert.equal(r.chunks[0].endLine, 2);
  assert.equal(r.chunks[1].text, 'para one\npara two\n');
  assert.equal(r.chunks[2].text, '## Sec\nx\n\ntail');
  assert.deepEqual(r.chunks.map((c) => c.name), ['c1', 'c2', 'c3']);
  assert.equal(r.chunks.some((c) => /^\d+$/.test(c.name)), false, '块名不得为纯数字（本题 V2 守卫）');
  for (const c of r.chunks) assert.ok(c.bytes <= 20, `块 ${c.name} 超预算：${c.bytes}`);
  assert.equal(r.totalBytes, r.chunks.reduce((n, c) => n + c.bytes, 0), 'totalBytes 是已发出块的字节合计');
});

test('chunk：maxChunks 触顶 → 截断并报告剩余行数', () => {
  const r = chunk(DOC, { budgetBytes: 20, maxChunks: 1 });
  assert.equal(r.chunks.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'chunks');
  assert.equal(r.remaining, 7, '共 9 行，已发 2 行');
});

test('chunk：maxTotalBytes 触顶 → 截断（块本身仍完整）', () => {
  const r = chunk(DOC, { budgetBytes: 20, maxTotalBytes: 20 });
  assert.equal(r.chunks.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.truncatedBy, 'totalBytes');
  assert.equal(r.remaining, 7);
});

test('chunk：单行超预算 → 硬切，且每片仍不超预算', () => {
  const r = chunk('A'.repeat(50), { budgetBytes: 10, maxChunks: 10 });
  assert.equal(r.chunks.length, 5);
  for (const c of r.chunks) {
    assert.ok(c.bytes <= 10, `片 ${c.name} 超预算：${c.bytes}`);
    assert.equal(c.startLine, 1);
    assert.equal(c.endLine, 1);
  }
  assert.equal(r.chunks.map((c) => c.text).join(''), 'A'.repeat(50), '硬切不得丢字符');
});

test('chunk：budgetBytes 非法即报错（不猜默认值）', () => {
  expectReject(() => chunk('abc', { budgetBytes: 0 }), /budgetBytes 必须是 ≥ 1 的整数/);
  expectReject(() => chunk('abc', {}), /budgetBytes 必须是 ≥ 1 的整数/);
});

test('splitGlobPattern：起始目录 + 逐段模式（纯字面路径的 segments 为空）', () => {
  assert.deepEqual(splitGlobPattern('docs/*.md'), { base: 'docs', segments: ['*.md'] });
  assert.deepEqual(splitGlobPattern('*/*.md'), { base: '', segments: ['*', '*.md'] });
  assert.deepEqual(splitGlobPattern('a/b/*.txt'), { base: 'a/b', segments: ['*.txt'] });
  assert.deepEqual(splitGlobPattern('docs/**/*.md'), { base: 'docs', segments: ['**', '*.md'] });
  assert.deepEqual(splitGlobPattern('**/*.md'), { base: '', segments: ['**', '*.md'] });
  // 整条都没有通配符 ⇒ 纯字面路径，调用方按 file 读，不必遍历目录。
  assert.deepEqual(splitGlobPattern('a/b/c.txt'), { base: 'a/b/c.txt', segments: [] });
});

test('matchGlobSegment：* 不跨段、? 单字符、元字符按字面处理', () => {
  assert.equal(matchGlobSegment('*.md', 'a.md'), true);
  assert.equal(matchGlobSegment('*.md', 'a.txt'), false);
  assert.equal(matchGlobSegment('*.md', 'x/a.md'), false, '* 不得跨越 /');
  assert.equal(matchGlobSegment('README.md', 'README.md'), true);
  assert.equal(matchGlobSegment('a?.md', 'ab.md'), true);
  assert.equal(matchGlobSegment('a?.md', 'a.md'), false);
  assert.equal(matchGlobSegment('report-*.txt', 'report-1.txt'), true);
  // 文件名里的正则元字符必须当字面量（否则 `a.md` 会匹配 `axmd`）。
  assert.equal(matchGlobSegment('a.md', 'axmd'), false);
  assert.equal(matchGlobSegment('v1.0', 'v1x0'), false);
  assert.equal(matchGlobSegment('v1.0', 'v1.0'), true);
  assert.equal(matchGlobSegment('a+b', 'aab'), false);
  assert.equal(matchGlobSegment('a+b', 'a+b'), true);
});

test('isRecursiveGlob：只有 ** 需要递归下降', () => {
  assert.equal(isRecursiveGlob(['*.md']), false);
  assert.equal(isRecursiveGlob(['**', '*.md']), true);
  assert.equal(isRecursiveGlob(['*', '**']), true);
  assert.equal(isRecursiveGlob([]), false);
});
test('chunk：hardSplit 分支也必须遵守 maxChunks（r3 审查 P0#2）', () => {
  // 单行 200 KB：整块超过 budget ⇒ 走 hardSplit 分支，旧实现一次把它全部推入，maxChunks 形同虚设。
  const out = chunk('A'.repeat(200000), { budgetBytes: 4096, maxChunks: 32, maxTotalBytes: 4 * 1024 * 1024 });
  assert.equal(out.chunks.length, 32, `块数必须被 maxChunks 夹住（实际 ${out.chunks.length}）`);
  assert.equal(out.truncated, true, '触顶必须标截断，否则调用方以为材料完整');
  assert.equal(out.truncatedBy, 'chunks');
  assert.ok(out.remaining > 0, 'remaining 必须为正（后续行还没切）');
  assert.ok(out.chunks.every((c) => c.bytes <= 4096), '每块仍不得超 budget');
  // 极端：budget=1 时同一支会被调用上千次，也必须停在 maxChunks。
  const tight = chunk('A'.repeat(1000), { budgetBytes: 1, maxChunks: 5 });
  assert.equal(tight.chunks.length, 5);
  assert.equal(tight.truncatedBy, 'chunks');
});

// ---- task-14 复审 P2-2 的守卫（2026-10-16）----

test('chunk：hardSplit 碎片靠字节区间区分（行区间相同），remaining 按行计、不按碎片计', () => {
  const text = 'x'.repeat(200 * 1024);
  const r = chunk(text, { budgetBytes: 4096, maxChunks: 32, maxTotalBytes: 4194304 });
  assert.equal(r.chunks.length, 32);
  assert.equal(r.truncatedBy, 'chunks');
  // 整行只算 1 行「未完整发出」（不是 50 个碎片）——旧口径下消费方按行差累加会高估。
  assert.equal(r.remaining, 1);
  // 行区间本来就是同一行（文档已如实写明「此时按行区间无法区分」），可区分性靠 byteStart/byteEnd。
  assert.deepEqual([...new Set(r.chunks.map((c) => `${c.startLine}-${c.endLine}`))], ['1-1']);
  const ranges = r.chunks.map((c) => [c.byteStart, c.byteEnd]);
  assert.ok(ranges.every(([b, e]) => Number.isInteger(b) && Number.isInteger(e) && e > b));
  assert.ok(ranges.every(([b], i) => (i === 0 ? b === 0 : b === ranges[i - 1][1])), '碎片字节区间必须不重叠、无空隙');
  assert.equal(ranges[ranges.length - 1][1], r.totalBytes);
  assert.ok(r.chunks.every((c) => text.slice(c.byteStart, c.byteEnd) === c.text), '字节区间必须能精确切回碎片文本');
  assert.deepEqual(r.chunks[0].part, { index: 1, total: 50 });
  assert.deepEqual(r.chunks[31].part, { index: 32, total: 50 });
});

test('chunk：正常路径行区间互不重叠，且每块都带可切回的字节区间', () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
  const r = chunk(text, { budgetBytes: 200, maxChunks: 32, maxTotalBytes: 1048576 });
  assert.equal(r.truncated, false);
  assert.ok(r.chunks.length > 1);
  assert.ok(r.chunks.every((c, i) => i === 0 || c.startLine > r.chunks[i - 1].endLine), '正常路径行区间不得重叠');
  assert.ok(r.chunks.every((c) => text.slice(c.byteStart, c.byteEnd) === c.text));
  assert.equal(r.remaining, 0);
});

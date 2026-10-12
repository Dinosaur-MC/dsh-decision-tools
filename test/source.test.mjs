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

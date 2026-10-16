import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cjkShare, bytesPerToken, softBytesFor } from '../lib/density.js';
import { ESCALATION_MARGIN } from '../lib/escalate.js';

test('cjkShare：按码点统计，空串 0、纯中文 1、混排按比例', () => {
  assert.equal(cjkShare(''), 0);
  assert.equal(cjkShare('plain english text'), 0);
  assert.equal(cjkShare('这是中文材料'), 1);
  assert.equal(cjkShare('中a'), 0.5);
  assert.equal(cjkShare('中，。'), 1, 'CJK 标点与全角形态同属密排文字');
});

test('bytesPerToken：CJK 占比 ≥ 0.3 用 2.32，否则 3.33（r6 实测口径）', () => {
  assert.equal(bytesPerToken('这是中文材料'), 2.32);
  assert.equal(bytesPerToken('plain english text'), 3.33);
  // 边界：恰好 0.3 算密排（阈值取 >=）。
  assert.equal(bytesPerToken('中'.repeat(3) + 'abcdefg'), 2.32);
  assert.equal(bytesPerToken('中'.repeat(2) + 'abcdefg'), 3.33);
});

test('softBytesFor：窗口 × 0.6 × 密度；窗口未知返回 undefined（交给兜底常量）', () => {
  assert.equal(softBytesFor({ numCtx: 8192, text: 'plain english' }), Math.floor(8192 * 0.6 * 3.33));
  assert.ok(softBytesFor({ numCtx: 16384, text: 'plain english' }) > softBytesFor({ numCtx: 8192, text: 'plain english' }),
    '窗口越大阈值越大，且恒为窗口的 60% × 密度');
  assert.equal(softBytesFor({ numCtx: 8192, text: '中'.repeat(4000) }), Math.floor(8192 * 0.6 * 2.32));
  // 同样的字节数，中文判为更吃容量 ⇒ 阈值更小。
  assert.ok(softBytesFor({ numCtx: 8192, text: '中'.repeat(4000) }) < softBytesFor({ numCtx: 8192, text: 'a'.repeat(4000) }));
  assert.equal(softBytesFor({ numCtx: undefined, text: 'x' }), undefined, '窗口未知 ⇒ 调用方回落 LIMITS.softBodyBytes');
  assert.equal(softBytesFor({ numCtx: 0, text: 'x' }), undefined);
  assert.equal(softBytesFor({ numCtx: Number.NaN, text: 'x' }), undefined);
  assert.equal(softBytesFor({ numCtx: 1000, margin: 0.5, text: 'abc' }), Math.floor(1000 * 0.5 * 3.33));
});

test('默认 margin 必须与 escalate 的 ESCALATION_MARGIN 绑定（任一被改即红）', () => {
  // density 是零 import 模块，故这条绑定只能由测试来钉：默认值 0.6 与 ESCALATION_MARGIN 是两处
  // 字面量，改一处而忘另一处时，本用例会红（task-12 复审 P2-5）。
  assert.equal(ESCALATION_MARGIN, 0.6, '本仓的策略余量');
  assert.equal(softBytesFor({ numCtx: 4096, text: 'abc' }), Math.floor(4096 * ESCALATION_MARGIN * 3.33),
    'softBytesFor 的默认 margin 必须等于 ESCALATION_MARGIN');
  assert.equal(softBytesFor({ numCtx: 4096, text: '中' }), Math.floor(4096 * ESCALATION_MARGIN * 2.32));
});

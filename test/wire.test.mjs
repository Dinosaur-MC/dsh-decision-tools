import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toWireRequest } from '../lib/wire.js';

const LF2 = String.fromCharCode(10, 10);

test('判据写在材料之后，且只出现一次（ADR-15 的位置契约）', () => {
  const body = toWireRequest({ material: '材料', rubric: '判据X', items: ['甲', '乙'], type: 'noul', model: 'm' });
  assert.equal(body.state, '材料' + LF2 + '判据：判据X');
  assert.equal(body.state.split('判据X').length - 1, 1, '判据只能出现一次');
  assert.deepEqual(Object.keys(body.questions), ['1', '2'], '批量模式的键是 1-based 序号');
  assert.equal(body.questions['1'].instructions, '甲');
  assert.equal(body.questions['1'].type, 'noul');
  assert.equal(body.model, 'm');
});

test('批量模式：choice/score 的 criteria 复制到每个问题，值里不得再带题名（ADR-15）', () => {
  const criteria = { billing: 'pay', bug: 'errors' };
  const body = toWireRequest({ material: 'm', rubric: 'r', items: ['甲', '乙'], type: 'choice', criteria, model: 'x' });
  assert.deepEqual(body.questions['1'], { type: 'choice', instructions: '甲', criteria });
  assert.deepEqual(body.questions['2'].criteria, criteria);
  assert.equal('name' in body.questions['1'], false, '题名只作映射键，不重复进值');
  // noul 不复制 criteria（上游只在 choice/score 上要它）。
  const noul = toWireRequest({ material: 'm', rubric: 'r', items: ['甲'], type: 'noul', criteria, model: 'x' });
  assert.deepEqual(noul.questions['1'], { type: 'noul', instructions: '甲' });
});

test('异质模式：键为题名，值只有 type/instructions/criteria', () => {
  const body = toWireRequest({
    material: '材料',
    rubric: '判据',
    model: 'm',
    questions: [
      { name: 'a', type: 'noul', instructions: '问甲' },
      { name: 'b', type: 'score', instructions: '问乙', criteria: ['低', '高'] },
    ],
  });
  assert.deepEqual(Object.keys(body.questions), ['a', 'b'], '顺序与调用方给的一致');
  assert.deepEqual(body.questions.a, { type: 'noul', instructions: '问甲' });
  assert.deepEqual(body.questions.b, { type: 'score', instructions: '问乙', criteria: ['低', '高'] });
  assert.equal(body.state, '材料' + LF2 + '判据：判据');
});

test('没有 rubric 时不拼判据块（迁移期的 v2 路径逐字节不变）', () => {
  const body = toWireRequest({ material: 'material', model: 'm', questions: [{ name: 'q', type: 'noul', instructions: 'x' }] });
  assert.equal(body.state, 'material');
  assert.equal('rubric' in body, false);
});

test('keep_alive 只在此处透传；缺席时该键整个不出现', () => {
  const withAlive = toWireRequest({ material: 'm', rubric: 'r', items: ['甲'], type: 'noul', model: 'm', keepAlive: '5m' });
  assert.equal(withAlive.keep_alive, '5m');
  const without = toWireRequest({ material: 'm', rubric: 'r', items: ['甲'], type: 'noul', model: 'm' });
  assert.equal('keep_alive' in without, false);
  assert.equal(without.keep_alive, undefined);
});

test('纯函数：不改入参、不 import 任何东西（wire.js 是唯一知道上游线格式的地方）', () => {
  const questions = [{ name: 'q', type: 'noul', instructions: 'x', extra: 'ignored' }];
  const body = toWireRequest({ material: 'm', model: 'x', questions });
  assert.deepEqual(questions, [{ name: 'q', type: 'noul', instructions: 'x', extra: 'ignored' }], '入参不得被修改');
  assert.equal('extra' in body.questions.q, false, '未声明的字段不得进 wire body');
});

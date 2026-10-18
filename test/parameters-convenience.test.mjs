import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBatchCriteria, normalizeMaterial, validateQuestions,
} from '../lib/validate.js';

test('choice criteria：string[] 归一为 {label:label}，对象形态仍可用', () => {
  assert.deepEqual(assertBatchCriteria({ type: 'choice', criteria: ['yes', 'no'] }), { yes: 'yes', no: 'no' });
  assert.deepEqual(assertBatchCriteria({ type: 'choice', criteria: { a: 'A', b: 'B' } }), { a: 'A', b: 'B' });
  assert.throws(() => assertBatchCriteria({ type: 'choice', criteria: ['yes', 'yes'] }), /重复/);
  const proto = assertBatchCriteria({ type: 'choice', criteria: ['a', 'b', '__proto__'] });
  assert.deepEqual(Object.keys(proto), ['a', 'b', '__proto__']);
  assert.equal(Object.getOwnPropertyDescriptor(proto, '__proto__').value, '__proto__');
  assert.throws(() => assertBatchCriteria({ type: 'choice', criteria: ['yes'] }), /合法范围/);
  assert.throws(() => assertBatchCriteria({ type: 'choice', criteria: ['yes', ''] }), /非空字符串/);
});

test('score criteria：{min,max} 展开为字符串档位，数组形态仍可用', () => {
  assert.deepEqual(assertBatchCriteria({ type: 'score', criteria: { min: 1, max: 5 } }), ['1', '2', '3', '4', '5']);
  assert.deepEqual(assertBatchCriteria({ type: 'score', criteria: ['low', 'high'] }), ['low', 'high']);
  assert.throws(() => assertBatchCriteria({ type: 'score', criteria: { min: 5, max: 1 } }), /min < max/);
  assert.deepEqual(assertBatchCriteria({ type: 'score', criteria: { min: -1, max: 2 } }), ['-1', '0', '1', '2']);
  assert.throws(() => assertBatchCriteria({ type: 'score', criteria: { min: 1, max: 20 } }), /合法范围 2–10/);
  assert.throws(() => assertBatchCriteria({ type: 'score', criteria: { min: 1, max: 3, step: 1 } }), /只接受 min \/ max/);
});

test('questions 里的 criteria 同样归一', () => {
  const questions = [
    { name: 'q1', type: 'choice', instructions: '选一个', criteria: ['a', 'b'] },
    { name: 'q2', type: 'score', instructions: '打分', criteria: { min: 0, max: 2 } },
  ];
  validateQuestions(questions);
  assert.deepEqual(questions[0].criteria, { a: 'a', b: 'b' });
  assert.deepEqual(questions[1].criteria, ['0', '1', '2']);
});

test('material 简写：{file:"…"} / {glob:"…"} 等价于对象形态', () => {
  assert.deepEqual(normalizeMaterial({ file: 'README.md' }), { kind: 'file', fields: { path: 'README.md', startLine: undefined, endLine: undefined }, images: [] });
  assert.deepEqual(normalizeMaterial({ glob: 'docs/*.md' }), { kind: 'glob', fields: { pattern: 'docs/*.md', limit: undefined }, images: [] });
  assert.deepEqual(normalizeMaterial({ file: { path: 'a.md', startLine: 2 }, images: ['shot.png'] }), { kind: 'file', fields: { path: 'a.md', startLine: 2, endLine: undefined }, images: ['shot.png'] });
});

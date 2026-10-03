import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { PARAMETERS, TOOL_DESCRIPTION } from '../lib/parameters.js';

test('参数契约的结构不变量（DSL 的硬性要求）', () => {
  assert.deepEqual(Object.keys(PARAMETERS), ['state', 'questions', 'model']);
  assert.equal(PARAMETERS.state.required, true);
  assert.equal(PARAMETERS.questions.required, true);
  assert.equal(PARAMETERS.model.required, undefined);

  // state 必须是三选一联合，且 object 分支显式声明 openness。
  assert.equal(PARAMETERS.state.oneOf.length, 3);
  const objectBranch = PARAMETERS.state.oneOf.find((branch) => branch.type === 'object');
  assert.equal(typeof objectBranch.additionalProperties, 'boolean');

  // questions 是对象数组，且对象是封闭的（防止模型塞进未声明字段）。
  assert.equal(PARAMETERS.questions.type, 'array');
  assert.equal(PARAMETERS.questions.items.type, 'object');
  assert.equal(PARAMETERS.questions.items.additionalProperties, false);
  assert.deepEqual(
    Object.keys(PARAMETERS.questions.items.properties),
    ['name', 'type', 'instructions', 'criteria'],
  );

  // 类型枚举里绝不能出现 boolean（服务端只认 noul）。
  assert.deepEqual(PARAMETERS.questions.items.properties.type.enum, ['choice', 'noul', 'score']);

  // criteria 用 oneOf 在本地挡住「对象还是数组」这一最常见误用。
  assert.equal(PARAMETERS.questions.items.properties.criteria.oneOf.length, 2);
});

test('描述里必须点明 noul 不是布尔、confidence 不是正确率', () => {
  const text = `${TOOL_DESCRIPTION} ${PARAMETERS.questions.items.properties.type.description}`;
  assert.match(text, /not a boolean|not `boolean`/);
  assert.match(text, /NOT accuracy/);
});

test('能投影成 JSON Schema，且 required 只含 state 与 questions', () => {
  const json = parameterSchemaSpecToJsonSchema(PARAMETERS);
  assert.equal(json.type, 'object');
  assert.ok(json.properties.state);
  assert.ok(json.properties.questions);
  assert.ok(json.properties.model);
  assert.equal(json.required.includes('state'), true);
  assert.equal(json.required.includes('questions'), true);
  assert.equal(json.required.includes('model'), false);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeOllama } from './fake-ollama.mjs';
import { publishSharedConfig, clearSharedConfig } from '../lib/config-bus.js';
import { applyDecision } from '../lib/tool.js';

const EXEC = { signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };

function fakeCtx() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
      skills: { get: async (name) => ({ name, content: '# companion skill body' }) },
    },
  };
}

test('execute 每次现取共享模型：改句柄后下一次调用即生效，无需重载行', async () => {
  const fake = await startFakeOllama((req) => ({
    status: 200,
    body: {
      model: req.json?.model,
      answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((key) => [key, { type: 'noul', noul: 0.8 }])),
    },
  }));
  clearSharedConfig();
  let model = 'model-one';
  publishSharedConfig({ baseUrl: fake.baseUrl, defaultModel: { get: () => model }, timeoutMs: 5000 });
  const { registered, ctx } = fakeCtx();
  applyDecision(ctx, {});
  const definition = registered[0];
  assert.equal(definition.name, 'decision');

  const call = () => definition.execute({ material: '材料', rubric: '判据', type: 'noul', items: ['甲'] }, EXEC);
  const first = await call();
  assert.equal(first.cost.model, 'model-one');
  model = 'model-two';
  const second = await call();
  assert.equal(second.cost.model, 'model-two');
  assert.equal(second.cost.model, fake.requests[1].json.model);

  clearSharedConfig();
  await fake.close();
});

test('model: "auto" 等价于省略，不被当成模型名', async () => {
  const fake = await startFakeOllama((req) => ({
    status: 200,
    body: {
      model: req.json?.model,
      answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((key) => [key, { type: 'noul', noul: 0.8 }])),
    },
  }));
  clearSharedConfig();
  publishSharedConfig({ baseUrl: fake.baseUrl, defaultModel: 'auto-default', timeoutMs: 5000 });
  const { registered, ctx } = fakeCtx();
  applyDecision(ctx, {});
  const definition = registered[0];
  const result = await definition.execute({ material: '材料', rubric: '判据', type: 'noul', items: ['甲'], model: 'auto' }, EXEC);
  assert.equal(result.cost.model, 'auto-default');
  assert.notEqual(fake.requests[0].json.model, 'auto');
  clearSharedConfig();
  await fake.close();
});

test('工具行 modelOverride 句柄优先于共享 defaultModel，且每次现取', async () => {
  const fake = await startFakeOllama((req) => ({
    status: 200,
    body: {
      model: req.json?.model,
      answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((key) => [key, { type: 'noul', noul: 0.8 }])),
    },
  }));
  clearSharedConfig();
  publishSharedConfig({ baseUrl: fake.baseUrl, defaultModel: 'shared-model', timeoutMs: 5000 });
  let override = '';
  const { registered, ctx } = fakeCtx();
  applyDecision(ctx, { modelOverride: { get: () => override } });
  const definition = registered[0];
  const call = () => definition.execute({ material: '材料', rubric: '判据', type: 'noul', items: ['甲'] }, EXEC);

  const first = await call();
  assert.equal(first.cost.model, 'shared-model');
  override = 'pinned-model';
  const second = await call();
  assert.equal(second.cost.model, 'pinned-model');

  clearSharedConfig();
  await fake.close();
});

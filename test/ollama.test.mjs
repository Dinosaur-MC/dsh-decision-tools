import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listModels, describeModel, discoverModels, formatLadder, normalizeBase, DEFAULT_OLLAMA_BASE } from '../lib/ollama.js';

const response = (body, { ok = true, status = 200 } = {}) => ({ ok, status, json: async () => body });
const failing = (status) => ({ ok: false, status, json: async () => ({}) });

test('normalizeBase：去尾斜杠、拒绝空/非法 URL（抛可行动错误）', () => {
  assert.equal(normalizeBase('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normalizeBase('http://h:1/sub/'), 'http://h:1/sub');
  assert.equal(normalizeBase(), DEFAULT_OLLAMA_BASE);
  for (const bad of ['', '   ', 'localhost:11434']) {
    assert.throws(() => normalizeBase(bad), (e) => e.kind === 'bad_config');
  }
});

test('listModels：映射 /api/tags 的字段；空列表返回 []', async () => {
  const calls = [];
  const models = await listModels({
    baseUrl: 'http://x:11434/',
    fetchImpl: async (url, init) => { calls.push(url); assert.equal(init.headers.accept, 'application/json'); return response({ models: [
      { name: 'tev1:0.8b', size: 1024, details: { family: 'llama', parameter_size: '0.8B' }, modified_at: '2026-10-01T00:00:00Z' },
      { name: 'nimble:latest' },
      { noName: true },
    ] }); },
  });
  assert.equal(calls[0], 'http://x:11434/api/tags');
  assert.deepEqual(models.map((m) => m.name), ['tev1:0.8b', 'nimble:latest']);
  assert.equal(models[0].sizeBytes, 1024);
  assert.equal(models[0].family, 'llama');
  assert.equal(models[1].sizeBytes, undefined, '缺字段不填 undefined 键之外的值');
  const empty = await listModels({ fetchImpl: async () => response({}) });
  assert.deepEqual(empty, []);
});

test('listModels：modelsPath / apiKey / OpenAI data 形状', async () => {
  const calls = [];
  const models = await listModels({
    baseUrl: 'http://x:1', modelsPath: '/v1/models', apiKey: 'k',
    fetchImpl: async (url, init) => {
      calls.push({ url, headers: init.headers });
      return response({ data: [{ id: 'remote-model' }] });
    },
  });
  assert.equal(calls[0].url, 'http://x:1/v1/models');
  assert.equal(calls[0].headers.authorization, 'Bearer k');
  assert.deepEqual(models.map((m) => m.name), ['remote-model']);
});

test('listModels：连接失败 / HTTP 错 / 坏 JSON 各自给出稳定 kind', async () => {
  await assert.rejects(() => listModels({ fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } }), (e) => e.kind === 'transport' && /无法连接/.test(e.message));
  await assert.rejects(() => listModels({ fetchImpl: async () => failing(500) }), (e) => e.kind === 'http_error');
  await assert.rejects(() => listModels({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } }) }), (e) => e.kind === 'bad_response');
});

test('describeModel：从 model_info 的 *.context_length 取最大值；show 失败报 http_error', async () => {
  const meta = await describeModel('tev1:0.8b', { fetchImpl: async (url, init) => {
    assert.equal(url, 'http://localhost:11434/api/show');
    assert.equal(JSON.parse(init.body).model, 'tev1:0.8b');
    return response({ model_info: { 'llama.context_length': 8192, 'other.context_length': 4096 }, details: { family: 'llama', parameter_size: '0.8B' }, capabilities: ['completion'] });
  } });
  assert.equal(meta.contextLength, 8192);
  assert.equal(meta.family, 'llama');
  await assert.rejects(() => describeModel('missing', { fetchImpl: async () => failing(404) }), (e) => e.kind === 'http_error');
});

test('discoverModels：单个模型的 show 失败不拖垮整体（保留名称 + metaError）', async () => {
  const out = await discoverModels({ fetchImpl: async (url) => {
    if (url.endsWith('/api/tags')) return response({ models: [{ name: 'good' }, { name: 'broken' }] });
    if (url.endsWith('/api/show')) return response({});
    return response({});
  } });
  // /api/show 对两者都返回空 model_info ⇒ 都缺 contextLength，但都保留在结果里。
  assert.deepEqual(out.map((m) => m.name), ['good', 'broken']);
  assert.equal(out[0].contextLength, undefined);
});
test('formatLadder：只收有 contextLength 的，按容量升序、去重', () => {
  const ladder = formatLadder([
    { name: 'big', contextLength: 32768 },
    { name: 'small', contextLength: 8192 },
    { name: 'small', contextLength: 8192 },
    { name: 'unknown' },
    { name: 'zero', contextLength: 0 },
  ]);
  assert.deepEqual(ladder, [{ model: 'small', numCtx: 8192 }, { model: 'big', numCtx: 32768 }]);
});
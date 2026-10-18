import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

test('核心行：同源模型发现端点读取已保存配置并转发 Bearer key', async () => {
  let handler;
  let seen;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url, headers: init.headers };
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'remote-a' }, { id: 'remote-b' }] }) };
  };
  try {
    const ctx = {
      effect: (fn) => fn(),
      inject: (deps, callback) => callback({
        effect: (fn) => fn(),
        webServer: {
          register: (spec) => { handler = spec.handler; return () => {}; },
        },
      }),
    };
    apply(ctx, { baseUrl: 'http://model.example:1', apiKey: 'secret', modelsPath: '/v1/models' });
    assert.equal(typeof handler, 'function');
    let status;
    let body;
    const res = {
      writeHead: (code, headers) => { status = code; assert.equal(headers['content-type'], 'application/json; charset=utf-8'); },
      end: (text) => { body = text; },
    };
    await handler({ method: 'GET' }, res);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { models: ['remote-a', 'remote-b'] });
    assert.equal(seen.url, 'http://model.example:1/v1/models');
    assert.equal(seen.headers.authorization, 'Bearer secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { publishSharedConfig } from '../lib/config-bus.js';
import { applyDecision } from '../lib/tool.js';

const cwd = process.cwd();
const ROOT = path.resolve(cwd);
publishSharedConfig({
  baseUrl: 'http://localhost:11434',
  defaultModel: 'tev1:0.8b',
  timeoutMs: 180000,
  keepAlive: '30m',
  modelsPath: '/api/tags',
  systemOnePath: 'v1/systemone',
  modelOrder: '',
  escalationEnabled: true,
  ladder: [],
  toolName: 'decision',
  monitorToolName: 'monitor',
});
const registered = [];
const ctx = {
  tools: { register: (definition) => { registered.push(definition); return () => {}; } },
  skills: { get: async (name) => ({ name, content: '# decision-usage' }) },
  fs: {
    async resolve(p, opts = {}) { return path.resolve(opts.cwd ?? cwd, String(p)); },
    contains(root, child) { return child === root || child.startsWith(root + path.sep); },
    async readBytes(target, _signal, maxBytes) {
      const raw = await readFile(target);
      if (raw.byteLength > maxBytes) throw new Error('FS_TOO_LARGE');
      return raw;
    },
  },
};
applyDecision(ctx, { modelOverride: 'clef-flash:latest' });
assert.equal(registered.length, 1);
const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd } } } };

const questions = [{ name: 'has_text', type: 'noul', instructions: 'Does the image contain any text?' }];
const value = await registered[0].execute({
  material: { images: ['.temp/image-probe/probe.png'] },
  model: 'clef-flash:latest',
  questions,
}, exec);

assert.equal(value.results.length, 1);
assert.equal(value.results[0].type, 'noul');
assert.equal(typeof value.results[0].value, 'boolean');
assert.equal(value.material.images.count, 1);
assert.match(value.notes[0], /模型选择：clef-flash:latest/);
assert.match(value.notes[1], /图片：1 张/);
console.log(JSON.stringify({
  result: value.results[0],
  material: value.material,
  notes: value.notes,
  cost: value.cost,
}, null, 2));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SharedConfig, DecisionConfig, MonitorConfig } from '../lib/configs.js';

function loadClient() {
  let loaded;
  const window = { __ModuleLoader__: { load: (entry) => { loaded = entry; } } };
  vm.runInContext(readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8'), vm.createContext({ window, console }));
  const React = { createElement: () => ({}) };
  return loaded.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      SettingsForm: function () {}, SettingsValueField: function () {}, Checkbox: function () {},
      Button: function () {}, SegmentedControl: function () {},
    };
    throw new Error('unexpected require: ' + name);
  });
}

function volatilePaths(schema) {
  const json = schema.toJSON();
  const refs = json.refs;
  const paths = new Set();
  function walk(id, prefix, inherited) {
    const node = refs[id];
    const isVolatile = inherited || node?.meta?.volatile === true;
    if (prefix.length > 0 && isVolatile) paths.add(prefix.join('.'));
    for (const [key, childId] of Object.entries(node?.dict ?? {})) {
      walk(childId, prefix.concat(key), isVolatile);
    }
  }
  walk(json.uid, [], false);
  return paths;
}

const PATCH = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('契约：package 声明 dsh.client 与 ./client；核心行是裸包名', () => {
  assert.equal(PACKAGE.dsh?.client?.platform, 'web');
  assert.equal(PACKAGE.exports['./client'], './lib/browser.js');
  assert.equal(PACKAGE.exports['./decision'], './lib/decision-entry.js');
  assert.equal(PACKAGE.exports['./monitor'], './lib/monitor-entry.js');
  const rows = new Map();
  const re = /- id:\s*([A-Za-z0-9-]+)\s*\n\s*name:\s*'([^']+)'/g;
  let match;
  while ((match = re.exec(PATCH)) !== null) rows.set(match[1], match[2]);
  assert.equal(rows.get('decision-tools-plugin'), 'dsh-decision-tools');
  assert.equal(rows.get('decision-tools-decision'), 'dsh-decision-tools/decision');
  assert.equal(rows.get('decision-tools-monitor'), 'dsh-decision-tools/monitor');
  assert.equal(rows.get('decision-tools-skill'), 'dsh-decision-tools/skill');
});

test('契约：client ROWS 的每个字段都是对应 Config 的 volatile 路径', () => {
  const client = loadClient();
  const schemas = {
    'decision-tools-plugin': SharedConfig,
    'decision-tools-decision': DecisionConfig,
    'decision-tools-monitor': MonitorConfig,
  };
  for (const row of client.__internals.ROWS) {
    const schema = schemas[row.rowId];
    assert.ok(schema, 'missing schema for ' + row.rowId);
    const volatile = volatilePaths(schema);
    for (const field of row.fields) {
      assert.ok(volatile.has(field.path.join('.')), row.rowId + ': ' + field.path.join('.') + ' must be volatile');
    }
  }
});

test('契约：client ROWS 的行 id 与 patch 的四个行完全一致', () => {
  const client = loadClient();
  const rowIds = new Set([...client.__internals.ROWS.map((row) => row.rowId)]);
  const patchIds = new Set([...PATCH.matchAll(/- id:\s*([A-Za-z0-9-]+)/g)].map((match) => match[1]));
  assert.deepEqual([...rowIds], ['decision-tools-plugin', 'decision-tools-decision', 'decision-tools-monitor']);
  for (const id of rowIds) assert.ok(patchIds.has(id), 'patch missing row ' + id);
  assert.ok(patchIds.has('decision-tools-skill'), 'skill row must stay in patch');
});

test('契约：Config 不再暴露旧的双布尔开关', () => {
  for (const schema of [SharedConfig, DecisionConfig, MonitorConfig]) {
    const json = schema.toJSON();
    assert.equal(Object.hasOwn(json.refs[json.uid].dict, 'decisionEnabled'), false);
    assert.equal(Object.hasOwn(json.refs[json.uid].dict, 'monitorEnabled'), false);
  }
});

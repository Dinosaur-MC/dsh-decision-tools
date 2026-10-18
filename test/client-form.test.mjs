import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function loadClient() {
  let loaded;
  const window = {
    __ModuleLoader__: {
      load: (entry) => { loaded = entry; },
    },
  };
  const context = vm.createContext({ window, console, setTimeout, clearTimeout });
  vm.runInContext(readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8'), context);
  assert.ok(loaded, 'browser.js must call window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-decision-tools');
  const React = { createElement: (type, props, ...children) => ({ type, props, children }) };
  const require = (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      SettingsForm: function () {}, SettingsValueField: function () {}, Checkbox: function () {},
      Button: function () {}, SegmentedControl: function () {},
    };
    throw new Error('unexpected require: ' + name);
  };
  const exports = loaded.factory(require);
  return exports;
}

function fakeScope(initial) {
  let snapshot = initial;
  const listeners = new Set();
  const mutations = [];
  return {
    mutations,
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    mutate: async (ops, revision) => {
      mutations.push({ ops, revision });
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        value: { ...snapshot.value },
        user: { ...snapshot.user },
      };
      for (const op of ops) {
        if (op.op === 'set') snapshot.value[op.path[0]] = op.value;
        else delete snapshot.value[op.path[0]];
      }
      listeners.forEach((listener) => listener());
      return true;
    },
  };
}

test('浏览器半：ROWS / rowKey / locale 契约', () => {
  const client = loadClient();
  const internals = client.__internals;
  assert.deepEqual([...internals.ROWS.map((row) => row.rowId)], [
    'decision-tools-plugin',
    'decision-tools-decision',
    'decision-tools-monitor',
  ]);
  assert.equal(internals.rowKey('decision-tools-plugin'), 'dsh-decision-tools#decision-tools-plugin');
  for (const dictionary of [internals.zh, internals.en]) {
    for (const [key, value] of Object.entries(dictionary)) {
      assert.equal(typeof value, 'string', key + ' must be a string');
      assert.notEqual(value, '', key + ' must not be empty');
    }
  }
});

test('浏览器半：staged edit / save / unset 与 revision fence', async () => {
  const client = loadClient();
  const { RowConfigForm, ROWS } = client.__internals;
  const core = ROWS[0];
  const scope = fakeScope({
    status: 'ready',
    writable: true,
    revision: 3,
    value: { baseUrl: 'http://old' },
    base: {},
    user: { baseUrl: 'http://old' },
  });
  const form = new RowConfigForm(scope, core);
  assert.equal(form.project().dirty, false);
  form.edit('baseUrl', 'http://new');
  assert.equal(form.project().dirty, true);
  assert.deepEqual(form.project().fields.find((field) => field.key === 'baseUrl').text, 'http://new');
  await form.save();
  assert.equal(scope.mutations.length, 1);
  assert.equal(scope.mutations[0].revision, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(scope.mutations[0].ops)), [{ op: 'set', path: ['baseUrl'], value: 'http://new' }]);
  assert.equal(form.project().dirty, false);

  form.edit('baseUrl', '');
  assert.equal(form.project().dirty, true);
  await form.save();
  assert.deepEqual(JSON.parse(JSON.stringify(scope.mutations[1].ops)), [{ op: 'unset', path: ['baseUrl'] }]);
  form.dispose();
});

test('浏览器半：保存失败保留草稿；只读禁用', async () => {
  const client = loadClient();
  const { RowConfigForm, ROWS } = client.__internals;
  const scope = fakeScope({ status: 'ready', writable: true, revision: 1, value: {}, base: {}, user: {} });
  scope.mutate = async () => false;
  const form = new RowConfigForm(scope, ROWS[0]);
  form.edit('defaultModel', 'nimble:latest');
  await form.save();
  assert.equal(form.project().failed, true);
  assert.equal(form.project().dirty, true);
  const readonlyScope = fakeScope({ status: 'ready', writable: false, revision: 1, value: {}, base: {}, user: {} });
  const readonly = new RowConfigForm(readonlyScope, ROWS[0]);
  assert.equal(readonly.project().writable, false);
  assert.equal(readonly.project().available, true);
  form.dispose();
  readonly.dispose();
});

test('浏览器半：数字格式与空值语义', () => {
  const client = loadClient();
  const { RowConfigForm, ROWS } = client.__internals;
  const scope = fakeScope({ status: 'ready', writable: true, revision: 1, value: { timeoutMs: 120000 }, base: {}, user: {} });
  const form = new RowConfigForm(scope, ROWS[0]);
  form.edit('timeoutMs', 'abc');
  const field = form.project().fields.find((entry) => entry.key === 'timeoutMs');
  assert.equal(field.invalid, true);
  assert.equal(field.invalidReason, 'number');
  form.edit('timeoutMs', '');
  assert.equal(form.project().fields.find((entry) => entry.key === 'timeoutMs').text, '');
  form.dispose();
});

test('浏览器半：空值仍投影出生效默认（字段下方的默认值）', () => {
  const client = loadClient();
  const { RowConfigForm, ROWS, FIELD_DEFAULTS, zh, en } = client.__internals;
  const scope = fakeScope({ status: 'ready', writable: true, revision: 1, value: {}, base: {}, user: {} });
  const core = new RowConfigForm(scope, ROWS[0]);
  for (const row of ROWS) {
    for (const field of row.fields) {
      assert.ok(FIELD_DEFAULTS[field.key] && FIELD_DEFAULTS[field.key].text, 'missing default for ' + field.key);
      assert.ok(zh[field.key + '.label'], 'missing zh label for ' + field.key);
      assert.ok(en[field.key + '.label'], 'missing en label for ' + field.key);
    }
  }
  for (const key of ['modelsTitle', 'modelsHint', 'modelsFilter', 'modelsEmpty', 'modelsNoMatch', 'currentDefault', 'inOrder', 'modelsAddAll', 'modelsColumnModel', 'modelsColumnContext', 'modelsColumnSize', 'modelsColumnRole', 'modelsColumnAction', 'modelsAllFamilies', 'modelsAllCapabilities', 'modelsAnyContext', 'refreshModels', 'modelsLoading', 'modelLoadFailed', 'useModel', 'addToOrder', 'capability.completion', 'capability.tools', 'capability.vision', 'capability.embedding']) {
    assert.ok(zh[key] && en[key], 'missing model picker label ' + key);
  }
  for (const group of ['connection', 'runtime', 'models', 'behavior', 'scan', 'probe']) {
    assert.ok(zh['group.' + group] && en['group.' + group], 'missing group label ' + group);
  }
  const coreFields = core.project().fields;
  assert.equal(coreFields.find((entry) => entry.key === 'defaultModel').defaultText, 'tev1:0.8b');
  assert.equal(coreFields.find((entry) => entry.key === 'timeoutMs').defaultText, '120000 ms');
  assert.equal(coreFields.find((entry) => entry.key === 'escalationEnabled').checked, true);
  const decision = new RowConfigForm(scope, ROWS.find((row) => row.rowId === 'decision-tools-decision'));
  const decisionFields = decision.project().fields;
  assert.equal(decisionFields.find((entry) => entry.key === 'bodyWarning').checked, true);
  assert.equal(decisionFields.find((entry) => entry.key === 'defaultDepth').value, 'normal');
  assert.equal(decisionFields.find((entry) => entry.key === 'softBodyBytes').defaultText, '4096 B');
  const monitor = new RowConfigForm(scope, ROWS.find((row) => row.rowId === 'decision-tools-monitor'));
  assert.equal(monitor.project().fields.find((entry) => entry.key === 'minProbeIntervalMs').defaultText, '1000 ms');
  core.dispose();
  decision.dispose();
  monitor.dispose();
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/browser.js', import.meta.url), 'utf8');

function loadClient(requireFn) {
  let loaded;
  const window = { __ModuleLoader__: { load: (entry) => { loaded = entry; } } };
  vm.runInContext(SOURCE, vm.createContext({ window, console }));
  return loaded.factory(requireFn);
}

function react() {
  return { createElement: (type, props, ...children) => ({ type, props, children }) };
}
function primitives() {
  const component = (name) => function component(props) { return { type: name, props }; };
  return {
    SettingsForm: component('SettingsForm'),
    SettingsValueField: component('SettingsValueField'),
    Checkbox: component('Checkbox'),
    Button: component('Button'),
    SegmentedControl: component('SegmentedControl'),
  };
}

function fakeCtx() {
  const registered = [];
  const injected = [];
  const served = [];
  const warnings = [];
  const form = {
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 0, value: {}, base: {}, user: {} }),
    subscribe: () => () => {},
    mutate: async () => true,
  };
  return {
    registered, injected, served, warnings,
    ctx: {
      effect: (fn) => fn(),
      logger: { warn: (message) => warnings.push(message) },
      locale: { register: (ns, dictionaries) => { registered.push({ kind: 'locale', ns, dictionaries }); return () => {}; } },
      configForms: {
        get: (ns) => { registered.push({ kind: 'form', ns }); return form; },
        whileServed: (namespaces, register) => { served.push(...namespaces); return register(); },
      },
      slots: {
        inject: (name, register) => { injected.push(name); return register(); },
        register: (spec, component) => { registered.push({ kind: 'slot', spec, component }); return () => {}; },
      },
    },
  };
}

test('apply 注册三行 page + core note，并保持 key/whileServed 契约', () => {
  const client = loadClient((name) => {
    if (name === 'react') return react();
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives();
    throw new Error('unexpected require: ' + name);
  });
  assert.deepEqual([...client.inject], ['slots', 'locale', 'configForms']);
  const { ctx, registered, injected, served } = fakeCtx();
  client.apply(ctx);
  const pages = registered.filter((entry) => entry.kind === 'slot' && entry.spec.name === 'plugins.row.config');
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((entry) => entry.spec.key).sort(), [
    'dsh-decision-tools#decision-tools-decision',
    'dsh-decision-tools#decision-tools-monitor',
    'dsh-decision-tools#decision-tools-plugin',
  ]);
  for (const page of pages) {
    const face = page.spec.inject();
    assert.equal(typeof face.hooks.rowForm.getSnapshot, 'function');
    assert.equal(typeof face.edit, 'function');
    assert.equal(typeof face.save, 'function');
  }
  assert.equal(injected.filter((name) => name === 'plugins.row.config').length, 3);
  assert.deepEqual(served.sort(), ['decision-tools-decision', 'decision-tools-monitor', 'decision-tools-plugin']);
  const notes = registered.filter((entry) => entry.kind === 'slot' && entry.spec.name === 'plugins.detail.section');
  assert.equal(notes.length, 1);
});

test('缺 React：不注册任何贡献，apply 只 warn', () => {
  const client = loadClient((name) => {
    if (name === 'react') throw new Error('missing');
    throw new Error('unexpected: ' + name);
  });
  assert.equal(typeof client.apply, 'function');
  const { ctx, registered, warnings } = fakeCtx();
  client.apply(ctx);
  assert.equal(registered.length, 0);
  assert.ok(warnings.some((message) => message.includes('client disabled')));
});

test('缺 primitives / 单个导出：用 HTML 兜底继续注册，并 warn', () => {
  const cases = [
    ['primitives missing', (name) => { if (name === 'react') return react(); throw new Error('missing'); }],
    ['primitive export missing', (name) => {
      if (name === 'react') return react();
      const value = primitives();
      delete value.SegmentedControl;
      return value;
    }],
  ];
  for (const [label, requireFn] of cases) {
    const client = loadClient(requireFn);
    const { ctx, registered, warnings } = fakeCtx();
    client.apply(ctx);
    assert.equal(registered.filter((entry) => entry.kind === 'slot').length, 4, label + ' must register');
    assert.ok(warnings.some((message) => message.includes('HTML fallback')), label + ' must warn');
  }
});

test('没有 ctx.effect 时仍注册，不提前 dispose form', () => {
  const client = loadClient((name) => {
    if (name === 'react') return react();
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives();
    throw new Error('unexpected require: ' + name);
  });
  const { ctx, registered } = fakeCtx();
  delete ctx.effect;
  client.apply(ctx);
  assert.equal(registered.filter((entry) => entry.kind === 'slot').length, 4);
});

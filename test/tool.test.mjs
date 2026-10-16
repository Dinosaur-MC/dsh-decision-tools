import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { resolveSoftBodyBytes, resolveMinConfidence, collectLowConfidence, OUTPUT_SCHEMA, COMPANION_SKILL } from '../lib/tool.js';
import { SKILL_NAME } from '../lib/skill.js';
import { TOOL_DESCRIPTION } from '../lib/parameters.js';
import { LIMITS } from '../lib/validate.js';
import { startFakeOllama } from './fake-ollama.mjs';

/**
 * 够用的假 ctx：刻意只给 tools（+ 用例可选的 fs/skills）。
 * 本插件不注册 prompt 段（ADR-5），缺 systemPrompt 也必须照常工作 —— 这个假 ctx 就是那条守卫。
 */
function treeFs(files) {
  const norm = (path) => path.replace(/\\/g, '/').replace(/^\.\/?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const ROOT = '.';
  const target = (key) => ({ key });
  const join = (base, name) => (base === ROOT ? `./${name}` : `${base}/${name}`);
  const resolveCalls = [];
  return {
    resolveCalls,
    async resolve(path, opts = {}) {
      resolveCalls.push({ path: String(path), cwd: opts.cwd });
      const clean = norm(String(path));
      return target(clean === '.' || clean === '' ? ROOT : `./${clean}`);
    },
    contains(root, child) {
      return child.key === root.key || child.key.startsWith(root.key === ROOT ? './' : `${root.key}/`);
    },
    async listDir(t) {
      const base = norm(t.key);
      // 真机的 listDir 对不存在的目录是**抛错**（→ source_missing），不是返回空表。
      if (base !== '' && base !== '.' && !Object.keys(files).some((path) => path === base || path.startsWith(`${base}/`))) {
        throw new Error(`NOT_FOUND: ${base}`);
      }
      const prefix = base === '' ? '' : `${base}/`;
      const seen = new Map();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const type = slash < 0 ? 'file' : 'directory';
        if (!seen.has(name)) seen.set(name, { name, type, target: target(join(t.key, name)) });
      }
      return [...seen.values()];
    },
    async readBytes(t, _signal, maxBytes) {
      const raw = Buffer.from(files[norm(t.key)] ?? '', 'utf8');
      if (raw.byteLength > maxBytes) throw new Error('FS_TOO_LARGE');
      return raw;
    },
  };
}

function fakeCtx(options = {}) {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
      skills: options.skills === undefined
        ? { get: async (n) => ({ name: n, content: '# companion skill body' }) }
        : options.skills,
      ...(options.fs === undefined ? {} : { fs: options.fs }),
    },
  };
}

const EXEC = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };

/** noul 回包：请求里每一个键都答同一个概率（用来验证键映射与合并）。 */
const echoNoul = (p = 0.7) => (req) => ({
  status: 200,
  body: {
    model: req.json?.model,
    answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((key) => [key, { type: 'noul', noul: p }])),
  },
});

const ANSWERS = { model: 'tev1:0.8b', answers: { q1: { type: 'noul', noul: 0.7 } }, usage: { input_tokens: 12, output_tokens: 1 } };
const OVERFLOW = { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
const Q = (n = 'q1') => ({ name: n, type: 'noul', instructions: 'x' });
const ITEMS = (n, text = '甲') => Array.from({ length: n }, (_, i) => `${text}${i}`);
/** 一遍真实注册（无 fs）。 */
const register = (config = {}) => fakeCtx();

test('插件导出形状与默认配置', () => {
  assert.equal(name, 'decision-tools');
  assert.deepEqual(inject, ['tools', 'fs', 'skills'], '工具行硬依赖 skills 服务：没有技能服务就不提供工具');
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Config({}), {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'tev1:0.8b',
    timeoutMs: 120000,
    toolName: 'decision',
    escalationEnabled: true,
    escalationMaxAttempts: 3,
    ladder: [],
  });
});

test('工具名、参数契约（8 键 / required 只有 material）与输出契约（5 键）', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({}));
  const definition = registered[0];
  assert.equal(definition.name, 'decision');
  assert.deepEqual(Object.keys(definition.parameters.properties),
    ['material', 'rubric', 'items', 'questions', 'type', 'criteria', 'depth', 'model']);
  assert.deepEqual(definition.parameters.required, ['material'],
    'required 只有 material：depth 可选（缺省 normal），模式内的必给性由 assertModeExclusive 把关');
  assert.equal(definition.description, TOOL_DESCRIPTION);
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(definition.output.schema.properties),
    ['results', 'coverage', 'material', 'cost', 'notes'], 'ADR-13：输出只有这五个键');
  assert.equal(OUTPUT_SCHEMA.properties.coverage.additionalProperties, false);
});

test('material{file}：经 ctx.fs 读入、回显 descriptor 与字节数，且材料不进结果', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const fs = treeFs({ 'docs/a.md': 'line1\nline2\nline3' });
    const { registered, ctx } = fakeCtx({ fs });
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute(
      { material: { file: { path: 'docs/a.md', startLine: 2, endLine: 3 } }, questions: [Q('q')] },
      EXEC,
    );
    assert.deepEqual(fs.resolveCalls.map((call) => call.cwd), ['F:/ws', 'F:/ws']);
    assert.equal(value.material.source, 'file');
    assert.equal(value.material.descriptor.path, 'docs/a.md');
    assert.equal(value.material.descriptor.startLine, 2);
    assert.equal(value.material.bytes, 11, 'state 是切片后的材料');
    assert.equal(JSON.stringify(value).includes('line1'), false, '★ 材料不得回显在结果里');
  } finally {
    await fake.close();
  }
});

test('material{glob}：按模式收集并加路径表头；** 递归、limit 触顶标截断', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const fs = treeFs({ 'docs/a.md': 'A', 'docs/x/b.md': 'B', 'docs/x/y/c.md': 'C', 'skip.txt': 'S' });
    const { registered, ctx } = fakeCtx({ fs });
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const all = await registered[0].execute(
      { material: { glob: { pattern: 'docs/**/*.md' } }, questions: [Q('q')] },
      EXEC,
    );
    assert.equal(all.material.source, 'glob');
    assert.deepEqual(all.material.descriptor.files, ['docs/a.md', 'docs/x/b.md', 'docs/x/y/c.md'], '** 覆盖任意深度');
    assert.equal(all.material.descriptor.truncated, false);
    const one = await registered[0].execute(
      { material: { glob: { pattern: 'docs/**/*.md', limit: 1 } }, questions: [Q('q')] },
      EXEC,
    );
    assert.equal(one.material.descriptor.files.length, 1);
    assert.equal(one.material.descriptor.truncated, true, 'limit 触顶必须标截断，不能静默漏文件');
    assert.ok(one.material.descriptor.remaining >= 1);
  } finally {
    await fake.close();
  }
});

test('material：路径越界与空/缺失引用都变成结构化错误，且不发网络请求', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const fs = treeFs({ 'docs/a.md': 'A' });
    const { registered, ctx } = fakeCtx({ fs });
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const reject = (material) => registered[0].execute({ material, questions: [Q()] }, EXEC).then(() => null, (e) => e);
    const outside = await reject({ file: { path: '../secret.md' } });
    assert.equal(outside.name, 'DecisionSourceError', '绝对路径/.. 由第一道闸拦下');
    const empty = await reject({ glob: { pattern: 'docs/*.txt' } });
    assert.equal(empty.kind, 'source_empty');
    const missing = await reject({ glob: { pattern: 'ghost/*.md' } });
    assert.equal(missing.kind, 'source_missing');
    assert.equal(fake.requests.length, 0, '本地拒绝不得发出请求');
  } finally {
    await fake.close();
  }
});

test('batch 模式：wire body 里判据只出现一次且在材料之后、键为 1-based 序号、criteria 复制到每题', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    await registered[0].execute(
      { material: '材料', rubric: '判据X', items: ['甲', '乙'], type: 'choice', criteria: { a: 'A', b: 'B' } },
      EXEC,
    );
    const sent = fake.requests[0].json;
    assert.equal(sent.state, '材料' + String.fromCharCode(10, 10) + '判据：判据X');
    assert.equal(sent.state.split('判据X').length - 1, 1, '共享判据只能出现一次');
    assert.deepEqual(Object.keys(sent.questions), ['1', '2']);
    assert.deepEqual(sent.questions['1'], { type: 'choice', instructions: '甲', criteria: { a: 'A', b: 'B' } });
    assert.equal('name' in sent.questions['1'], false, '题名只是映射的键');
  } finally {
    await fake.close();
  }
});

test('mixed 模式：键为题名、值不含 name；顶层 criteria 报 criteria_requires_items_mode', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    await registered[0].execute({ material: 'm', questions: [Q('a'), Q('b')] }, EXEC);
    const sent = fake.requests[0].json;
    assert.deepEqual(Object.keys(sent.questions), ['a', 'b']);
    assert.deepEqual(sent.questions.a, { type: 'noul', instructions: 'x' });

    const error = await registered[0]
      .execute({ material: 'm', questions: [Q('a')], criteria: { a: 'A', b: 'B' } }, EXEC)
      .then(() => null, (e) => e);
    assert.equal(error.kind, 'criteria_requires_items_mode');
    assert.equal(fake.requests.length, 1, '被拒的调用不得发请求');
  } finally {
    await fake.close();
  }
});

test('模式互斥与上限：两者同给 / 都不给 / items 超 64 都在本地报错且不发请求', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const reject = (args) => registered[0].execute(args, EXEC).then(() => null, (e) => e);
    const both = await reject({ material: 'm', rubric: 'r', items: ['甲'], type: 'noul', questions: [Q()] });
    assert.equal(both.kind, 'mode_conflict');
    const neither = await reject({ material: 'm' });
    assert.equal(neither.kind, 'mode_missing');
    const tooMany = await reject({ material: 'm', rubric: 'r', items: ITEMS(65), type: 'noul' });
    assert.equal(tooMany.kind, 'mode_invalid');
    assert.match(tooMany.message, /65 项/);
    const noRubric = await reject({ material: 'm', items: ['甲'], type: 'noul' });
    assert.equal(noRubric.kind, 'mode_invalid');
    const noType = await reject({ material: 'm', rubric: 'r', items: ['甲'] });
    assert.equal(noType.kind, 'mode_invalid');
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('输出只有五个键；旧键（answers/usage/plan/chunks/scan/source/…）全部不出现', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute({ material: 'm', questions: [Q('q1')] }, EXEC);
    assert.deepEqual(Object.keys(value).sort(), ['cost', 'coverage', 'material', 'notes', 'results']);
    for (const key of ['answers', 'usage', 'state_bytes', 'body_bytes', 'body_warning', 'confidence_warning', 'source', 'escalated', 'plan', 'chunks', 'scan', 'model']) {
      assert.equal(key in value, false, `旧键 ${key} 不得出现（ADR-13 硬切）`);
    }
    assert.deepEqual(value.results, [{ id: 'q1', type: 'noul', value: true, probabilities: { true: 0.7, false: 0.30000000000000004 } }]);
    assert.equal(value.coverage.requested, 1);
    assert.equal(value.coverage.answered, 1);
    assert.equal(value.coverage.batches, 1);
    assert.equal(value.coverage.failed, 0);
    assert.equal(value.material.source, 'inline');
    assert.equal(value.cost.model, 'tev1:0.8b');
    assert.equal(value.cost.inputTokens, 12);
  } finally {
    await fake.close();
  }
});

test('results 与请求项一一对应：未答的项以 value=null 占位并在 notes 里点名', async () => {
  const fake = await startFakeOllama((req) => ({ status: 200, body: { model: req.json?.model, answers: { 1: { type: 'noul', noul: 0.9 } } } }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute({ material: 'm', rubric: 'r', items: ['甲', '乙'], type: 'noul' }, EXEC);
    assert.equal(value.results.length, 2);
    assert.deepEqual(value.results.map((entry) => entry.id), ['1', '2']);
    assert.equal(value.results[1].value, null);
    assert.equal(value.coverage.answered, 1);
    assert.equal(value.coverage.failed, 1);
    assert.match(value.notes.join(' '), /没有为这些 id 返回答案/);
  } finally {
    await fake.close();
  }
});

test('非容量类失败不得换档：提升目标回 500 时原样上抛，且不再试更大的档（r7 P0）', async () => {
  const seen = [];
  const fake = await startFakeOllama((req) => {
    const model = req.json?.model;
    seen.push(model);
    if (model === 'mid:latest') return { status: 500, body: { error: 'boom' } };
    if (model === 'wide:latest') return { status: 200, body: ANSWERS };
    return OVERFLOW;
  });
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [
      { model: 'tev1:0.8b', numCtx: 8192 },
      { model: 'mid:latest', numCtx: 16384 },
      { model: 'wide:latest', numCtx: 32768 },
    ] }));
    const error = await registered[0]
      .execute({ material: 'x'.repeat(300), questions: [Q('q1')] }, EXEC)
      .then(() => null, (e) => e);
    assert.equal(error?.kind, 'server_error', '非容量类失败必须原样上抛，不得被容量提升掩盖');
    assert.deepEqual(seen, ['tev1:0.8b', 'mid:latest'], '换档救不了 500 ⇒ wide 不该被尝试');
  } finally {
    await fake.close();
  }
});

test('升档耗尽：三档全溢出 ⇒ 统一终态 escalation_exhausted，附尝试过的模型与失败分类（r7 P0）', async () => {
  const seen = [];
  const fake = await startFakeOllama((req) => { seen.push(req.json?.model); return OVERFLOW; });
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [
      { model: 'tev1:0.8b', numCtx: 8192 },
      { model: 'mid:latest', numCtx: 16384 },
      { model: 'wide:latest', numCtx: 32768 },
    ] }));
    const error = await registered[0]
      .execute({ material: 'x'.repeat(300), questions: [Q('q1')] }, EXEC)
      .then(() => null, (e) => e);
    assert.equal(error?.name, 'SystemOneError');
    assert.equal(error?.kind, 'escalation_exhausted');
    assert.deepEqual(error?.attempts, [
      { model: 'tev1:0.8b', failureKind: 'context_overflow' },
      { model: 'mid:latest', failureKind: 'context_overflow' },
      { model: 'wide:latest', failureKind: 'context_overflow' },
    ]);
    assert.deepEqual(seen, ['tev1:0.8b', 'mid:latest', 'wide:latest']);
  } finally {
    await fake.close();
  }
});

test('提升失败不得粘滞：坏档一次失败后，下一次调用必须回到默认模型（r1 审查 P0）', async () => {
  const seen = [];
  const fake = await startFakeOllama((req) => {
    const model = req.json?.model;
    seen.push(model);
    if (model === 'big:latest') return { status: 404, body: { error: 'model not found' } };
    const len = req.json?.state?.length ?? 0;
    if (len > 5000) return { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
    return { status: 200, body: ANSWERS };
  });
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'big:latest', numCtx: 8194 }] }));
    const questions = [Q('q1')];
    // 大材料（9000 B）越过默认档（8192×0.6×3.33≈16360？不 —— 默认档不在阶梯里，故用兜底 4096 B）
    // ⇒ 选档落到阶梯唯一的 big:latest ⇒ 404。本用例只钉「坏档不得粘滞」。
    const first = await registered[0].execute({ material: 'A'.repeat(9000), questions }, EXEC).catch((error) => error);
    assert.equal(typeof first?.message, 'string', '提升目标不可用时首次调用应当失败');
    const second = await registered[0].execute({ material: 'B'.repeat(300), questions }, EXEC);
    assert.equal(second.cost.model, 'tev1:0.8b', '粘滞被毒化时这里会是 big:latest');
    assert.equal(seen.filter((model) => model === 'big:latest').length, 1, '坏档只该被尝试一次');
  } finally {
    await fake.close();
  }
});

test('A 方案：小材料走默认档，大材料直发大档，回到小材料又降回来', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const questions = [Q('q1')];
    await registered[0].execute({ material: 'A'.repeat(300), questions }, EXEC);
    assert.equal(fake.requests[0].json.model, 'tev1:0.8b', '小材料必须走默认档');
    await registered[0].execute({ material: 'A'.repeat(40000), questions }, EXEC);
    assert.equal(fake.requests[1].json.model, 'nimble-v3:latest', '★ 大材料**直发**大档：不得先发默认档吃一次 400');
    await registered[0].execute({ material: 'A'.repeat(300), questions }, EXEC);
    assert.equal(fake.requests[2].json.model, 'tev1:0.8b', '★ 回到小材料必须降回默认档');
  } finally {
    await fake.close();
  }
});

test('容量按语言密度算：同样 12000 字节，中文材料被判为更吃容量（r6 的 2.32 B/token）', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const questions = [Q('q1')];
    await registered[0].execute({ material: 'a'.repeat(12000), questions }, EXEC);
    assert.equal(fake.requests[0].json.model, 'tev1:0.8b', 'ASCII 材料仍在默认档');
    await registered[0].execute({ material: '中'.repeat(4000), questions }, EXEC);
    assert.equal(fake.requests[1].json.model, 'clef-flash:latest', '中文按 2.32 B/token 估算，必须升档');
  } finally {
    await fake.close();
  }
});

test('depth quick：超预算就地报错（绝不悄悄分批），且不发任何请求', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'tev1:0.8b', numCtx: 512 }] }));
    const error = await registered[0]
      .execute({ material: 'x'.repeat(5000), questions: [Q('q1')], depth: 'quick' }, EXEC)
      .then(() => null, (e) => e);
    assert.equal(error?.kind, 'quick_over_budget');
    assert.match(error.message, /depth: normal/, '必须给出可行做法');
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('depth quick：装得下时只发一次（不分批）', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, defaultModel: 'wide:latest', ladder: [{ model: 'wide:latest', numCtx: 32768 }] }));
    const value = await registered[0].execute(
      { material: 'm', rubric: 'r', items: ITEMS(6), type: 'noul', depth: 'quick' },
      EXEC,
    );
    assert.equal(fake.requests.length, 1);
    assert.equal(value.coverage.batches, 1);
    assert.equal(value.results.length, 6);
    assert.equal(value.cost.model, 'wide:latest');
  } finally {
    await fake.close();
  }
});

test('depth normal：小窗口下按预算分批，coverage.batches = 请求数，results 顺序与 items 一致', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'tev1:0.8b', numCtx: 512 }] }));
    const value = await registered[0].execute(
      { material: 'm', rubric: 'r', items: ITEMS(8, 'x'.repeat(400)), type: 'noul' },
      EXEC,
    );
    assert.ok(value.coverage.batches >= 2, `应切成多批，实际 ${value.coverage.batches}`);
    assert.equal(value.coverage.batches, fake.requests.length, '每批恰好一次请求');
    assert.equal(value.results.length, 8, '分批只改请求次数，不改返回结构');
    assert.deepEqual(value.results.map((entry) => entry.id), ['1', '2', '3', '4', '5', '6', '7', '8']);
    // 批内键是全局序号 ⇒ 所有请求的键并集恰为 1..8，无重复、无缺号。
    const keys = fake.requests.flatMap((request) => Object.keys(request.json.questions));
    assert.equal(new Set(keys).size, keys.length, '跨批的键不得重复（重映射即乱序）');
    assert.deepEqual([...new Set(keys)].sort((a, b) => Number(a) - Number(b)), ['1', '2', '3', '4', '5', '6', '7', '8']);
    assert.match(value.notes.join(' '), new RegExp('分了 \\d+ 批'));
  } finally {
    await fake.close();
  }
});

test('depth deep：35 项在大窗口模型下只发 1 次请求', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, defaultModel: 'wide:latest', ladder: [{ model: 'wide:latest', numCtx: 32768 }] }));
    const value = await registered[0].execute(
      { material: 'm', rubric: 'r', items: ITEMS(35), type: 'noul', depth: 'deep' },
      EXEC,
    );
    assert.equal(fake.requests.length, 1, '窗口足够大时 35 项必须一次发完');
    assert.equal(value.coverage.batches, 1);
    assert.equal(value.coverage.requested, 35);
    assert.equal(value.coverage.answered, 35);
  } finally {
    await fake.close();
  }
});

test('depth deep：材料连大档都装不下 ⇒ 转内部分块扫描（只有 deep 允许）', async () => {
  const fake = await startFakeOllama((req) => {
    const text = String(req.json?.state ?? '');
    if (text.length > 1200) return { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
    return echoNoul()(req);
  });
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'tev1:0.8b', numCtx: 8192 }], scanFirstChunkBytes: 1000 }));
    const value = await registered[0].execute(
      { material: 'x'.repeat(5000), questions: [Q('q1')], depth: 'deep' },
      EXEC,
    );
    assert.ok(value.results[0].value !== null, '分块后每块都在装得下的范围内 ⇒ 必须有答案');
    assert.match(value.notes.join(' '), /内部分块扫描/, '必须如实报告走了分块');
    assert.equal(value.coverage.truncated, false);
    assert.ok(fake.requests.length > 1, '分块意味着多次请求');
  } finally {
    await fake.close();
  }
});

test('depth normal：同样的材料不扫描（不主动分块），原样抛溢出错误', async () => {
  const fake = await startFakeOllama(() => OVERFLOW);
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'tev1:0.8b', numCtx: 8192 }], scanFirstChunkBytes: 1000 }));
    const error = await registered[0]
      .execute({ material: 'x'.repeat(5000), questions: [Q('q1')], depth: 'normal' }, EXEC)
      .then(() => null, (e) => e);
    assert.equal(error?.kind, 'context_overflow');
    assert.equal(fake.requests.length, 1, 'normal 不分块 ⇒ 只发一次');
  } finally {
    await fake.close();
  }
});

test('model 参数是逃生口：逐次覆盖默认模型，并写进 cost.model', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute({ material: 'm', questions: [Q('q1')], model: 'tev1:latest' }, EXEC);
    assert.equal(fake.requests[0].json.model, 'tev1:latest');
    assert.equal(value.cost.model, 'tev1:latest');
    assert.equal(value.cost.escalated, false);
    assert.deepEqual(value.cost.attempts, [{ model: 'tev1:latest', failureKind: null }]);
  } finally {
    await fake.close();
  }
});

test('notes：低置信度的题被点名（不再有独立的 confidence_warning 键），且 answers 原样进 results', async () => {
  // 注意：`noul` 不带 confidence，collectLowConfidence 按设计跳过它 —— 低置信必须用 choice/score 演示。
  const body = { model: 'tev1:0.8b', answers: {
    weak: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.3 }, confidence: 0.2 },
    sure: { type: 'choice', choice: 'bug', probabilities: { bug: 0.9 }, confidence: 0.9 },
  } };
  const fake = await startFakeOllama(() => ({ status: 200, body }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, minConfidence: 0.5 }));
    const value = await registered[0].execute({
      material: 'm',
      questions: [
        { name: 'weak', type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
        { name: 'sure', type: 'choice', instructions: 'y', criteria: { bug: 'Bug', billing: 'Billing' } },
      ],
    }, EXEC);
    assert.equal('confidence_warning' in value, false);
    assert.match(value.notes.join(' '), /confidence 告警：以下 1 题/);
    assert.match(value.notes.join(' '), /weak\(0\.200\)/, '被点名的是低置信的那题，且带数值');
    assert.equal(value.results[1].value, 'bug', '只加旗、不清障：被点名的照样给答案');
  } finally {
    await fake.close();
  }
});

test('notes：minConfidence 0 关闭门限（同一批低置信答案也不出告警行）', async () => {
  const body = { model: 'tev1:0.8b', answers: { weak: { type: 'choice', choice: 'a', probabilities: { a: 0.2 }, confidence: 0.05 } } };
  const fake = await startFakeOllama(() => ({ status: 200, body }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, minConfidence: 0 }));
    const value = await registered[0].execute({ material: 'm', questions: [
      { name: 'weak', type: 'choice', instructions: 'x', criteria: { a: 'A', b: 'B' } },
    ] }, EXEC);
    assert.equal(value.notes.some((line) => line.includes('confidence 告警')), false);
  } finally {
    await fake.close();
  }
});

test('notes：体积归因指向「重复的问题文本」而不是误导性地让人改材料（真机样例）', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, softBodyBytes: 500 }));
    const value = await registered[0].execute(
      { material: '短材料', rubric: '判据', items: ITEMS(5, 'x'.repeat(300)), type: 'noul' },
      EXEC,
    );
    const text = value.notes.join(' ');
    assert.match(text, /已超过建议的 500 字节/);
    assert.match(text, /该瘦的是问题文本|逐字相同/, '必须指向重复文本，不能只说「改材料」');
  } finally {
    await fake.close();
  }
});

test('notes：bodyWarning: false 时不产出体积告警行（但其它 notes 仍在）', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl, softBodyBytes: 500, bodyWarning: false }));
    const value = await registered[0].execute(
      { material: '短材料', rubric: '判据', items: ITEMS(5, 'x'.repeat(300)), type: 'noul' },
      EXEC,
    );
    assert.equal(value.notes.some((line) => line.includes('已超过建议的')), false);
    assert.match(value.notes.join(' '), /模型选择/, '选档原因仍在（与体积开关无关）');
  } finally {
    await fake.close();
  }
});

test('拿不到配套 skill 时拒绝服务（不是静默降级）', async () => {
  const { registered, ctx } = fakeCtx({ skills: { get: async () => undefined } });
  apply(ctx, Config({}));
  const error = await registered[0].execute({ material: 'm', questions: [Q()] }, EXEC).then(() => null, (e) => e);
  assert.equal(error.name, 'DecisionSourceError');
  assert.equal(error.kind, 'skill_missing');
});

test('首次使用把配套 skill 正文随结果交付，第二次只留提示（构造性保证「用工具=拿到指引」）', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute({ material: 'm', questions: [Q('q1')] }, EXEC);
    const first = registered[0].output.render({}, value).map((part) => part.text).join('\n');
    const second = registered[0].output.render({}, value).map((part) => part.text).join('\n');
    assert.match(first, /companion skill body/);
    assert.doesNotMatch(second, /companion skill body/);
  } finally {
    await fake.close();
  }
});

test('配套 skill 的跨文件不变量：工具声明必须指名同一个 skill 名', () => {
  assert.equal(COMPANION_SKILL, SKILL_NAME);
});

test('execute 的本地校验错误不会发出网络请求', async () => {
  const fake = await startFakeOllama(echoNoul());
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const error = await registered[0].execute({ material: 'm', questions: [] }, EXEC).then(() => null, (e) => e);
    assert.equal(error.name, 'DecisionValidationError');
    assert.match(error.message, /questions 有 0 题/);
    assert.equal(fake.requests.length, 0);
  } finally {
    await fake.close();
  }
});

test('execute 把服务端错误映射成 SystemOneError', async () => {
  const fake = await startFakeOllama(() => ({ status: 404, body: { error: 'model not found' } }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const error = await registered[0].execute({ material: 'm', questions: [Q('q1')] }, EXEC).then(() => null, (e) => e);
    assert.equal(error.name, 'SystemOneError');
    assert.equal(error.kind, 'model_missing');
  } finally {
    await fake.close();
  }
});

test('F3：Config 拒绝非正 timeoutMs 与负的 softBodyBytes / minConfidence（加载期报错）', () => {
  assert.throws(() => Config({ timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => Config({ timeoutMs: -1 }));
  assert.throws(() => Config({ softBodyBytes: -1 }));
  assert.throws(() => Config({ minConfidence: -0.1 }));
  assert.doesNotThrow(() => Config({ softBodyBytes: 0 }));
  assert.doesNotThrow(() => Config({ minConfidence: 0 }));
});

test('F3：resolveSoftBodyBytes / resolveMinConfidence 对非有限/负值回落默认，且各自钳制', () => {
  assert.equal(resolveSoftBodyBytes(undefined), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(Number.NaN), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(-1), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(1e9), LIMITS.maxBodyBytes, 'absurd 阈值被静默钳到硬上限');
  assert.equal(resolveSoftBodyBytes(0), 0, '0 是合法策略值（每次都告警）');
  assert.equal(resolveMinConfidence(undefined), LIMITS.minConfidence);
  assert.equal(resolveMinConfidence(Number.NaN), LIMITS.minConfidence);
  assert.equal(resolveMinConfidence(5), 1, '门限钳到 [0,1]');
  assert.equal(resolveMinConfidence(0), 0, '0 = 关闭');
});

test('§4.11：collectLowConfidence 跳过 noul、缺失按低计、<=0 关闭、且绝不修改入参', () => {
  const answers = {
    a: { type: 'choice', confidence: 0.9 },
    b: { type: 'choice', confidence: 0.1 },
    c: { type: 'choice' },
    d: { type: 'noul', noul: 0.02 },
  };
  const flagged = collectLowConfidence(answers, 0.25);
  assert.deepEqual(flagged.map((item) => item.name), ['b', 'c']);
  assert.equal(flagged[1].confidence, null, '缺失 confidence 按低计');
  assert.deepEqual(collectLowConfidence(answers, 0), [], '门限 <= 0 表示关闭');
  assert.deepEqual(collectLowConfidence(null, 0.5), []);
  assert.equal(Object.keys(answers).length, 4, '入参不得被修改');
  assert.equal(answers.c.confidence, undefined);
});

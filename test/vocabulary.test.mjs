import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyAll as apply, Config } from './helpers/apply-all.mjs';
import { TOOL_DESCRIPTION, PARAMETERS } from '../lib/parameters.js';
import { renderAnswers } from '../lib/render.js';
import { startFakeOllama } from './fake-ollama.mjs';

/**
 * 模型可见文案的词表守卫（task-19 ③，2026-10-16）。
 *
 * **要防的是什么**：v2 的参数名（`stateSource` / 把 `state` 当参数引用）在 v3 已不存在；文案里
 * 再出现它，模型照着报错去改参只会再失败一次。task-18 的守卫只盖 `lib/source.js` —— 把
 * `lib/tool.js` / `lib/client.js` 的模型可见串改回旧名，当时 tool/client 的用例仍全绿。
 *
 * 三层（由弱到强）：① 源码层：`lib/*.js` 的**字符串字面量**（注释不算、标识符不算 —— wire 的
 * 字段名 `state` 是合法代码标识符，不是模型可见的参数引用）；② 说明书层：工具 description 与
 * 整棵参数 schema 的每个字符串；③ 实测层：真实调用路径上的**报错 message** 与 **notes 渲染文本**。
 */

/** v2 的死名（v3 代码里任何位置都不该有）。 */
const V2_DEAD = /\bstateSource\b|\bstate_bytes\b|\bbody_bytes\b/;
/** `state` 只在**字符串字面量**里按参数引用看待（代码里的 wire 字段名 / 变量名不算）。 */
const V2_STATE = /\bstate\b/;
const hasV2 = (text) => V2_DEAD.test(text) || V2_STATE.test(text);

/** 读一个单/双引号字面量（i → 开引号）。 */
function readQuoted(source, i, quote) {
  let text = '';
  i += 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
    if (ch === quote) return { text, next: i + 1 };
    text += ch;
    i += 1;
  }
  return { text, next: i };
}

/** 跳过模板插值 `${ … }`（i → `${` 之后），顺带收集其中嵌套的字面量。 */
function skipBraced(source, i, out) {
  let depth = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === "'" || ch === '"') { const r = readQuoted(source, i, ch); out.push(r.text); i = r.next; continue; }
    if (ch === '`') { const r = readTemplate(source, i, out); i = r.next; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return i;
}

/** 读一个模板字面量（i → 反引号）：文本片段进 out，`${…}` 里的**代码**不进。 */
function readTemplate(source, i, out) {
  let text = '';
  i += 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { text += source[i + 1] ?? ''; i += 2; continue; }
    if (ch === '`') { out.push(text); return { text, next: i + 1 }; }
    if (ch === '$' && source[i + 1] === '{') { out.push(text); text = ''; i = skipBraced(source, i + 2, out); continue; }
    text += ch;
    i += 1;
  }
  out.push(text);
  return { text, next: i };
}

/** 抽出源码里的所有字符串字面量文本（注释 / 标识符 / `${}` 内的代码都不算）。 */
function stringLiterals(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && source[i + 1] === '*') { i += 2; while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1; i += 2; continue; }
    if (ch === "'" || ch === '"') { const r = readQuoted(source, i, ch); out.push(r.text); i = r.next; continue; }
    if (ch === '`') { const r = readTemplate(source, i, out); i = r.next; continue; }
    i += 1;
  }
  return out;
}

function collectStrings(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) collectStrings(item, out);
  else if (node !== null && typeof node === 'object') for (const value of Object.values(node)) collectStrings(value, out);
  return out;
}

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
const EXEC = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };

test('① 源码层：lib/*.js 的字符串字面量里不得出现 v2 参数名', async () => {
  const dir = fileURLToPath(new URL('../lib/', import.meta.url));
  const names = (await readdir(dir)).filter((name) => name.endsWith('.js')).sort();
  assert.ok(names.length >= 13, `lib/ 下应有 13 个模块，实际 ${names.length}`);
  const literals = [];
  for (const name of names) {
    const source = await readFile(dir + name, 'utf8');
    for (const text of stringLiterals(source)) literals.push({ file: name, text });
  }
  // **反空转自检**：扫描器若失效（抽不到字面量），下面的否定断言会恒真。
  assert.ok(literals.length >= 200, `抽到的字面量太少（${literals.length}）—— 扫描器可能失效`);
  for (const file of ['tool.js', 'validate.js', 'render.js', 'parameters.js', 'client.js', 'source.js', 'wire.js']) {
    assert.ok(literals.filter((item) => item.file === file).length >= 3, `${file} 的字面量没整批抽到`);
  }
  assert.ok(literals.some((item) => /模型选择/.test(item.text)), '必须抽到 notes 的选档结论文案');
  assert.ok(literals.some((item) => /判据/.test(item.text)), '必须抽到判据相关文案（wire / 提示）');
  assert.ok(literals.some((item) => /decision/.test(item.text)), '必须抽到工具名文案');
  const hits = literals.filter((item) => hasV2(item.text));
  assert.deepEqual(hits, [], '模型可见字符串里出现 v2 参数名：' + JSON.stringify(hits));
});

test('② 说明书层：工具 description 与参数 schema 的每个字符串都不得出现 v2 参数名', () => {
  const texts = [TOOL_DESCRIPTION, ...collectStrings(PARAMETERS)];
  assert.ok(texts.length >= 12, `schema 里的字符串太少（${texts.length}）—— 反空转`);
  assert.ok(texts.some((text) => /rubric/.test(text)), '必须能看到 v3 的 rubric 说明');
  assert.ok(texts.some((text) => /items/.test(text)), '必须能看到 v3 的 items 说明');
  const hits = texts.filter(hasV2);
  assert.deepEqual(hits, [], '说明书里出现 v2 参数名：' + JSON.stringify(hits));
});

test('③ 实测层：坏调用的模型可见报错不得出现 v2 参数名', async () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({ baseUrl: 'http://127.0.0.1:1' }));
  const cases = [
    ['两模式同时给', { material: 'm', items: ['a'], type: 'noul', questions: [{ name: 'q', type: 'noul', instructions: 'x' }] }],
    ['两模式都不给', { material: 'm' }],
    ['material 形状错', { material: 42 }],
    ['items 空数组', { material: 'm', items: [], type: 'noul' }],
    ['type 非法', { material: 'm', items: ['a'], type: 'nope' }],
    ['choice 缺 criteria', { material: 'm', items: ['a'], type: 'choice' }],
    ['criteria 与 type 不匹配', { material: 'm', items: ['a'], type: 'noul', criteria: { a: 'A' } }],
    ['depth 非法', { material: 'm', items: ['a'], type: 'noul', depth: 'nope' }],
  ];
  const kinds = [];
  for (const [label, args] of cases) {
    const error = await registered[0].execute(args, EXEC).then(() => null, (caught) => caught);
    assert.ok(error !== null, `${label}：必须给结构化报错`);
    if (error.name === 'DecisionValidationError') {
      // 本层（lib/validate.js）的结构化报错：必须带稳定 kind。
      assert.equal(typeof error.kind, 'string', `${label}：本层报错必须带稳定 kind`);
      kinds.push(error.kind);
    } else {
      // 更外层（宿主按声明 schema 拦下）先报错：message 里只允许出现 **v3** 的键名。
      assert.match(error.message, /invalid arguments/, `${label}：非本层报错应是宿主参数校验`);
      assert.match(error.message, /"material"|"type"|"depth"/, `${label}：宿主报错必须指向 v3 键名`);
    }
    assert.ok(!hasV2(error.message), `${label}：模型可见 message 出现 v2 参数名 —— ${error.message}`);
  }
  assert.ok(kinds.length >= 4, `本层结构化报错至少 4 例（实际 ${kinds.length}）—— 反空转`);
  assert.ok(kinds.includes('mode_conflict') && kinds.includes('mode_missing'), '两种模式错误必须都覆盖到');
});

test('④ 实测层：notes 渲染后的模型可见文本不得出现 v2 参数名（含瘦身提示）', async () => {
  const fake = await startFakeOllama((req) => ({
    status: 200,
    body: { model: req.json?.model, answers: Object.fromEntries(Object.keys(req.json?.questions ?? {}).map((key) => [key, { type: 'noul', noul: 0.7 }])) },
  }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const value = await registered[0].execute(
      { material: 'm', rubric: 'r', items: ['同一句', '同一句', '同一句'], type: 'noul' },
      EXEC,
    );
    const blocks = renderAnswers({}, value, undefined);
    assert.equal(blocks.length, 1);
    const text = blocks[0].text;
    assert.match(text, /该瘦的是重复文本/, '反空转：这条渲染确实带 analyzeBody 的提示');
    assert.match(text, /放进 rubric/, '提示必须指向 v3 的 rubric');
    assert.ok(!hasV2(text), '渲染文本里出现 v2 参数名：' + text);
  } finally {
    await fake.close();
  }
});

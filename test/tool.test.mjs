import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { resolveSoftBodyBytes, resolveMinConfidence, collectLowConfidence } from '../lib/tool.js';
import { COMPANION_SKILL } from '../lib/tool.js';
import { SKILL_NAME } from '../lib/skill.js';
import { TOOL_DESCRIPTION } from '../lib/parameters.js';
import { LIMITS } from '../lib/validate.js';
import { startFakeOllama } from './fake-ollama.mjs';

/**
 * 计数口径（各文件用例数；改动本文件时必须同步更新 —— 用例**总数**没有任何自动核对，
 * 但「README 配置表键集/顺序 == Config 投影」这条不变量自 2026-10-04 起由
 * `test/parameters.test.mjs` 的 `README 的配置表键集与顺序…` 一条自动守卫）：
 * `validate 15 + render 9 + client 14 + parameters 3 + tool 7 = 48`
 * → 2026-10-04 本文件新增 3 条（可配置的体积告警），此后为
 * `validate 15 + render 9 + client 14 + parameters 3 + tool 10 = 51`
 * → 同日 `parameters.test.mjs` 新增 1 条（README 配置表守卫），此后为
 * `validate 15 + render 9 + client 14 + parameters 4 + tool 10 = 52`
 * → 同日 `5df48a1` 给 `parameters.test.mjs` 补九条逐点锚点（+9），此后为
 * `validate 15 + render 9 + client 14 + parameters 13 + tool 10 = 61`
 * → 同日缺陷审查轮修复（F1/F2/F3），此后为
 * `validate 15 + render 12 + client 19 + parameters 13 + tool 13 = 72`。
 * → 2026-10-06 置信度门限 delta：本文件 +5（门限两侧、0 关闭、纯函数语义、Config/resolve），
 * `render.test.mjs` +3（告警行原样打印、缺键不自行判断、与体积行的先后），
 * `parameters.test.mjs` +1（§4.9 第 10 点锚点：告警是旗不是过滤器），此后为
 * `validate 15 + render 15 + client 19 + parameters 14 + tool 18 = 81`。
 */

/**
 * 一个够用的假 ctx：**刻意只提供 tools**。
 * 本插件不注册 prompt 段（ADR-5），所以缺少 systemPrompt 时 apply 必须照常工作 ——
 * 这个假 ctx 本身就是那条不变量的守卫：一旦有人再加回 systemPrompt 调用，测试会直接崩。
 */
/**
 * 形状**照 `@deepseek-ai/dsh-fs` 的 types 抄**（不是猜的）：
 *   `resolve(path)`          → 不透明 target（这里用 `{ key }` 代替）
 *   `contains(root, child)`  → canonical containment
 *   `listDir(target)`        → `{ name, type: 'file'|'directory'|'other', target }[]`（只给一层）
 *   `readBytes(target, s, maxBytes)` → 超限抛错（真机是 FS_TOO_LARGE），**不截断**
 * `files` 是「工作区相对路径 → 内容」的扁平表；目录由路径前缀推导。
 */
function treeFs(files) {
  const norm = (path) => path.replace(/\\/g, '/').replace(/^\.\/?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  /** 工作区根的 target 用 `.` 表示（真机是后端的真实根目标，**不是空串**）。 */
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
      // 「用该工具必须拿到配套 skill」：默认给一个在场的假技能注册表；用例可覆盖成缺失。
      skills: options.skills === undefined
        ? { get: async (n) => ({ name: n, content: '# companion skill body' }) }
        : options.skills,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    },
  };
}

const ANSWERS = {
  model: 'tev1:0.8b',
  answers: { label: { type: 'choice', choice: 'bug', probabilities: { bug: 1 }, confidence: 1 } },
  usage: { input_tokens: 12, output_tokens: 1 },
};

test('插件导出形状与默认配置', () => {
  assert.equal(name, 'decision-tools');
  assert.deepEqual(inject, ['tools', 'fs', 'skills'], '工具行硬依赖 skills 服务：没有技能服务就不提供工具');
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Config({}), {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'tev1:0.8b',
    timeoutMs: 120000,
    toolName: 'decision',
    // v2：提升默认开启、尝试次数默认 3；其余 v2 键刻意不设默认值（数值只有 LIMITS 一处来源）。
    escalationEnabled: true,
    escalationMaxAttempts: 3,
    // schemastery 把「未设的可选数组」物化成 []，故投影里出现空数组而不是缺席。
    ladder: [],
  });
});

test('默认 toolName 配置下的工具名与 schema', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({}));

  assert.equal(registered.length, 1);
  const definition = registered[0];
  assert.equal(definition.name, 'decision');

  // 注意：defineTool 会把 DSL 投影成 JSON Schema 再放回 definition.parameters
  // （宿主定义文件 index.js:848 `parameterSchemaSpecToJsonSchema(options.parameters)`），
  // 所以参数名在 `.properties` 上，`required` 是根上的数组而非逐属性注解。
  assert.deepEqual(Object.keys(definition.parameters), ['type', 'properties', 'required']);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['state', 'questions', 'stateSource', 'model', 'strategy', 'aggregate']);
  assert.deepEqual(definition.parameters.required, ['questions'],
    'v2：state 与 stateSource 恰有其一，故 required 只剩 questions（交叉约束由本地校验把关）');

  // ADR-5 的就地守卫：使用指引必须真的挂在已注册的工具上（而不是只写在模块里）。
  assert.equal(definition.description, TOOL_DESCRIPTION);

  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(definition.output.schema.properties),
    [
      'model', 'answers', 'usage', 'state_bytes', 'body_bytes', 'body_warning', 'confidence_warning',
      'source', 'escalated', 'plan', 'chunks', 'scan',
    ],
  );
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
});

test('stateSource{kind:file}：经 ctx.fs 读入，回显 source 且不进上下文', async () => {
  const fs = treeFs({ 'docs/a.md': 'line1\nline2\nline3' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'file', path: 'docs/a.md', startLine: 2, endLine: 3 }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  // ★ 机制断言：每个相对路径都必须带**本会话 cwd** —— 不给 cwd 时后端会回落到进程启动目录，
  // 于是相对路径解析到工作区之外（2026-10-13 运行态实测：`README.md` 报「文件不存在」）。
  assert.deepEqual(fs.resolveCalls.map((c) => c.cwd), ['F:/ws', 'F:/ws']);
  assert.deepEqual(fs.resolveCalls.map((c) => c.path), ['.', 'docs/a.md']);
  assert.deepEqual(value.source, { kind: 'file', path: 'docs/a.md', bytes: 11, startLine: 2, endLine: 3, lines: 3 });
  assert.equal(value.state_bytes, 11, 'state 是切片后的材料');
  assert.equal(JSON.stringify(value).includes('line1'), false, '★ 材料不得回显在结果里（A7 的全部意义）');
});

test('stateSource{kind:glob}：按模式收集并加路径表头', async () => {
  const fs = treeFs({ 'a.md': 'A', 'b.md': 'B', 'c.txt': 'C', 'docs/d.md': 'D' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: '*.md' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined },
  );
  assert.deepEqual(value.source.files, ['a.md', 'b.md'], '只取一层里的 .md');
  assert.equal(value.source.truncated, false);
  assert.equal(value.source.remaining, 0);
  assert.ok(value.source.bytes > 2);
});

test('stateSource{kind:glob}：** 递归下降；limit 触顶即标截断', async () => {
  const fs = treeFs({ 'docs/a.md': 'A', 'docs/x/b.md': 'B', 'docs/x/y/c.md': 'C' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const all = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: 'docs/**/*.md' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined },
  );
  assert.deepEqual(all.source.files, ['docs/a.md', 'docs/x/b.md', 'docs/x/y/c.md'], '** 覆盖任意深度');
  const one = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: 'docs/**/*.md', limit: 1 }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined },
  );
  assert.equal(one.source.files.length, 1);
  assert.equal(one.source.truncated, true, 'limit 触顶必须标截断，不能静默漏文件');
  assert.ok(one.source.remaining >= 1);
});

test('stateSource：解析后落在工作区根之外即拒绝（三道闸的第二道）', async () => {
  const fs = treeFs({ 'a.md': 'A' });
  const realResolve = fs.resolve;
  // 只有「目标文件」被解析到根外；根自己被解析到根外会让 containment 自比通过。
  fs.resolve = async (path) => (String(path) === '.' ? realResolve('.') : { key: '/outside' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  await assert.rejects(
    registered[0].execute(
      { stateSource: { kind: 'file', path: 'a.md' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined },
    ),
    (error) => error.kind === 'source_outside_root',
  );
});

test('strategy:scan 真的分块：返回 chunks、无顶层 answers，且**不发单次请求**', async () => {
  const tree = treeFs({ 'big.txt': 'A'.repeat(5000) });
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: tree });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const value = await registered[0].execute(
    { stateSource: { kind: 'file', path: 'big.txt' }, strategy: 'scan', questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.equal(value.plan.action, 'scan');
  assert.ok(Array.isArray(value.chunks) && value.chunks.length >= 2, `应切成 ≥2 块，实际 ${value.chunks?.length}`);
  assert.equal(value.answers, undefined, '扫描模式顶层不得有 answers（answers 与 chunks 恰有其一）');
  assert.equal(value.scan.truncated, false);
  assert.deepEqual(value.scan.failed, []);
  // ★ 回归断言：分派依据必须是「计划里的动作」。曾经按 `failure === undefined` 分派 ⇒
  // `strategy:'scan'` 悄悄退化成「先发单次再返回 answers」，既多花一次请求又永远不产出 chunks。
  assert.equal(fake.requests.length, value.chunks.length,
    '每个块恰好一次请求；若先发单次再分块，这里会多出一次');
  assert.equal(fake.requests[0].url, '/v1/systemone');
  assert.equal(JSON.stringify(value).includes('AAAA'), false, '★ 分块材料同样不得回显');
  await fake.close();
});

test('aggregate 只在 scan 下有意义：非 scan 传它必须报结构化错误，不得静默忽略（r7 P0）', async () => {
  // 旧实现：aggregate 参数被完整忽略 —— 非 scan 调用传了它既不改行为也不报错，
  // 调用方会以为「跨块聚合」生效了。
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    const error = await registered[0]
      .execute({ state: 'x', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }], aggregate: 'any' },
        { preview: false, signal: undefined })
      .then(() => null, (e) => e);
    assert.equal(error?.name, 'DecisionValidationError');
    assert.equal(error?.kind, 'aggregate_requires_scan');
    assert.match(error?.message, /strategy: scan/, '消息必须给出可行做法');
    assert.equal(fake.requests.length, 0, '本地校验失败不得发出网络请求');
  } finally {
    await fake.close();
  }
});

test('aggregate: any 在 scan 下真的接线：产出 aggregateNoul 的暂定聚合块（r7 P0）', async () => {
  const body = { model: 'tev1:0.8b', answers: { q1: { type: 'noul', noul: 0.7 } } };
  const fake = await startFakeOllama(() => ({ status: 200, body }));
  try {
    const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
    apply(ctx, Config({ baseUrl: fake.baseUrl, scanFirstChunkBytes: 8 }));
    const text = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    const value = await registered[0].execute(
      { state: text, strategy: 'scan', aggregate: 'any', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined },
    );
    // 聚合块只可能由 aggregateNoul 产出：provisional 标记 + perQuestion 的逐块最大值。
    assert.equal(value.scan.aggregate?.provisional, true, 'aggregate: any 必须真的产出聚合块');
    assert.equal(value.scan.aggregate.perQuestion.q1.max, 0.7);
    assert.ok(value.chunks.length >= 2, `需要多块才谈得上跨块聚合，实际 ${value.chunks?.length}`);
    // 不传 aggregate（且配置未设 scanAggregate）时该键整个缺席 —— 「any 才聚合」的对照。
    const plain = await registered[0].execute(
      { state: text, strategy: 'scan', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined },
    );
    assert.equal('aggregate' in plain.scan, false, '默认不得产出聚合块');
  } finally {
    await fake.close();
  }
});

test('auto + 结构化 state：溢出后不得退化成扫描（没有可分的行），保持单发失败（r7 P0）', async () => {
  // 旧实现把 scanAvailable 写死 true：结构化 state 溢出后 auto 会转扫描，
  // 而 chunk() 对非字符串做 text.split ⇒ 抛无 kind 的裸 TypeError。
  const fake = await startFakeOllama(() => ({
    status: 400,
    body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' },
  }));
  try {
    const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'tev1:0.8b', numCtx: 8192 }] }));
    const error = await registered[0]
      .execute({ state: { ticket: 'x' }, questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
        { preview: false, signal: undefined })
      .then(() => null, (e) => e);
    assert.equal(error?.kind, 'context_overflow', '没有可扫的块 ⇒ 原样上抛溢出错误，不得变成裸 TypeError');
    assert.equal(fake.requests.length, 1, '不得退化成分块扫描（那会多出多次请求）');
  } finally {
    await fake.close();
  }
});

test('升档耗尽：三档全溢出 ⇒ 统一终态 escalation_exhausted，附尝试过的模型与失败分类（r7 P0）', async () => {
  const seen = [];
  const fake = await startFakeOllama((req) => {
    seen.push(req.json?.model);
    return { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
  });
  try {
    const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
    apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [
      { model: 'tev1:0.8b', numCtx: 8192 },
      { model: 'mid:latest', numCtx: 16384 },
      { model: 'wide:latest', numCtx: 32768 },
    ] }));
    const error = await registered[0]
      .execute({ state: 'x'.repeat(300), strategy: 'inline', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
        { preview: false, signal: undefined })
      .then(() => null, (e) => e);
    assert.equal(error?.name, 'SystemOneError');
    assert.equal(error?.kind, 'escalation_exhausted',
      '旧实现在耗尽时抛最后一档的原始 context_overflow，调用方看不出「试过哪些档」');
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

test('glob：** 吃零层必须命中 a/b/file.md（r2 P0：旧实现只消耗一段）', async () => {
  const fs = treeFs({ 'a/b/file.md': 'AB', 'a/b/b/file.md': 'ABB', 'a/x/b/file.md': 'AXB' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: 'a/**/b/file.md' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.deepEqual([...value.source.files].sort(), ['a/b/b/file.md', 'a/b/file.md', 'a/x/b/file.md'],
    '** 吃零层时 `**` 与下一段都要被消耗，否则会漏掉 a/b/file.md');
});

test('glob：尾段通配符命中目录不得抛 TypeError，且同一文件只收一次（r2 两个 P0）', async () => {
  const fs = treeFs({ 'd1/leaf.txt': 'L', 'd2/sub/deep.txt': 'D', 'top.txt': 'T' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: '**/*' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.deepEqual([...value.source.files].sort(), ['d1/leaf.txt', 'd2/sub/deep.txt', 'top.txt']);
  assert.equal(new Set(value.source.files).size, value.source.files.length, '同一文件不得被重复收集');
});

test('glob：总量不足即截断（保留已收文件 + 报 remaining），不报错（r2 P0）', async () => {
  const fs = treeFs({ 'a.txt': 'A'.repeat(30000), 'b.txt': 'B'.repeat(50000) });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'glob', pattern: '*.txt' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.deepEqual(value.source.files, ['a.txt']);
  assert.equal(value.source.truncated, true, 'glob 总量超上限是截断，不是失败');
  assert.equal(value.source.remaining, 1);
  assert.ok(value.source.bytes <= LIMITS.maxSourceBytes, 'source.bytes 必须含表头，故不得超过上限');
});

test('glob：一个文件都没读到 → source_empty（不是「state 不能是空字符串」）', async () => {
  const fs = treeFs({ 'big.txt': 'A'.repeat(70000) });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  await assert.rejects(
    registered[0].execute(
      { stateSource: { kind: 'glob', pattern: '*.txt' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
    ),
    (error) => error.kind === 'source_empty' && /没有读到任何材料/.test(error.message),
  );
});

test('glob：起始目录不存在 → source_missing（不是 kind=undefined 的裸 Error）', async () => {
  const fs = treeFs({ 'a.md': 'A' });
  fs.listDir = async () => { throw new Error('cannot list "F:/ws/nope": not found'); };
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  await assert.rejects(
    registered[0].execute(
      { stateSource: { kind: 'glob', pattern: 'nope/**/*.md' }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
    ),
    (error) => error.kind === 'source_missing',
  );
});

test('提升失败不得粘滞：坏档一次失败后，下一次调用必须回到默认模型（r1 审查 P0）', async () => {
  const big = 'A'.repeat(9000);
  const small = 'B'.repeat(300);
  const seen = [];
  const fake = await startFakeOllama((req) => {
    const model = req.json?.model;
    seen.push(model);
    if (model === 'big:latest') return { status: 404, body: { error: 'model not found' } };
    const len = req.json?.state?.length ?? 0;
    if (len > 5000) {
      // 上报的 token 数要 **>2050（确实是溢出）且 ≤ 8194×0.6=4916（big 档才可选）**；
      // 报成 len+2000=11000 会让 selectEscalation 判「超过最大档」，big 一次都不会被尝试。
      return { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
    }
    return { status: 200, body: ANSWERS };
  });
  const { registered, ctx } = fakeCtx({ fs: treeFs({ 'big.txt': big, 'small.txt': small }) });
  apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [{ model: 'big:latest', numCtx: 8194 }] }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const questions = [{ name: 'q1', type: 'noul', instructions: 'x' }];
  // 首次：**估算**判为大材料 ⇒ 直发 ladder 里唯一的档（big:latest）⇒ 404。**已知偏差**：提升用尽时目前直接抛最初的溢出错误，
  // 而规格 §4 要求 auto 在「提升用尽」时转为扫描（登记为待办，r1 P1 / r3 P2）。
  // 本用例只钉「坏档不得粘滞」，故先接住这次抛出。
  const first = await registered[0].execute({ state: big, questions }, exec).catch((error) => error);
  assert.equal(typeof first?.message, 'string', '提升目标不可用时首次调用应当失败');
  const second = await registered[0].execute({ state: small, questions }, exec);
  assert.equal(second.model, 'tev1:0.8b', '粘滞被毒化时这里会是 big:latest');
  assert.equal(seen.filter((m) => m === 'big:latest').length, 1, '坏档只该被尝试一次');
  await fake.close();
});

test('非容量类失败不得换档：提升目标回 500 时原样上抛，且不再试更大的档（r7 P0）', async () => {
  // 旧实现：提升循环只判「要不要进循环」，一旦进了循环，每一档的失败都不分种类继续往上换
  // —— 于是中间某档回 500 会被静默吞掉，换一个更大的档重试成功，调用方永远看不到真实错误。
  const seen = [];
  const fake = await startFakeOllama((req) => {
    const model = req.json?.model;
    seen.push(model);
    if (model === 'mid:latest') return { status: 500, body: { error: 'boom' } };
    if (model === 'wide:latest') return { status: 200, body: ANSWERS };
    return { status: 400, body: { error: 'prompt 0 has 2100 tokens; expected 1\u20132050 (input is never truncated)' } };
  });
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [
    { model: 'tev1:0.8b', numCtx: 8192 },
    { model: 'mid:latest', numCtx: 16384 },
    { model: 'wide:latest', numCtx: 32768 },
  ] }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const error = await registered[0]
    .execute({ state: 'x'.repeat(300), questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] }, exec)
    .then(() => null, (e) => e);
  assert.equal(error?.kind, 'server_error', '非容量类失败必须原样上抛，不得被容量提升掩盖');
  assert.deepEqual(seen, ['tev1:0.8b', 'mid:latest'],
    '只发两次：初始档 + 第一个提升目标；wide 不该被尝试（换档救不了 500）');
  await fake.close();
});

test('A 方案：小材料走默认档，大材料直发大档，回到小材料又降回来（r5 实测省 13% 的那条规则）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const questions = [{ name: 'q1', type: 'noul', instructions: 'x' }];
  // 「大材料」的阈值随默认档容量走：默认档 tev1:0.8b 现为 num_ctx=8192 ⇒ 可用字节上限
  // 8192×3.33×0.6 ≈ 16368 B，故 6000 B 已不再是"大"。用 40000 B 越过 clef-flash
  // （16384 ⇒ ≈32735 B）后落到最大档 nimble-v3（32768 ⇒ ≈65470 B）。
  await registered[0].execute({ state: 'A'.repeat(300), questions }, exec);
  assert.equal(fake.requests[0].json.model, 'tev1:0.8b', '小材料必须走默认档（大档是它的 7–9 倍慢）');
  await registered[0].execute({ state: 'A'.repeat(40000), questions }, exec);
  assert.equal(fake.requests[1].json.model, 'nimble-v3:latest', '★ 大材料**直发**大档：不得先发默认档吃一次 400');
  await registered[0].execute({ state: 'A'.repeat(300), questions }, exec);
  assert.equal(fake.requests[2].json.model, 'tev1:0.8b', '★ 回到小材料必须降回默认档（旧粘滞会一直锁在大档上）');
  await fake.close();
});

test('A 方案：中等材料只升到「够用的最小档」（clef-flash 是真正可用的中间档）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const questions = [{ name: 'q1', type: 'noul', instructions: 'x' }];
  // 20000 B 越过 tev1（16368 B）但没越过 clef-flash（32735 B）⇒ 必须选最小够用档，
  // 而不是直接跳到最大档。这正是「排除 8194 死档、纳入 16384 中间档」的行为收益。
  await registered[0].execute({ state: 'A'.repeat(20000), questions }, exec);
  assert.equal(fake.requests[0].json.model, 'clef-flash:latest',
    '中等材料应落在够用的最小档，不得直接跳最大档');
  await fake.close();
});

test('容量按语言密度算：同样 12000 字节，中文材料被判为更吃容量（r6 的 2.32 B/token）', async () => {
  // ASCII：8192 × 0.6 × 3.33 ≈ 16360 B ⇒ 12000 B 装得下默认档。
  // 中文：8192 × 0.6 × 2.32 ≈ 11401 B ⇒ 同样的字节数必须往上换档。
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const questions = [{ name: 'q1', type: 'noul', instructions: 'x' }];
  await registered[0].execute({ state: 'a'.repeat(12000), questions }, exec);
  assert.equal(fake.requests[0].json.model, 'tev1:0.8b', '英文/ASCII 材料仍在默认档');
  await registered[0].execute({ state: '中'.repeat(4000), questions }, exec);
  assert.equal(fake.requests[1].json.model, 'clef-flash:latest', '中文材料按 2.32 B/token 估算，必须升档');
  await fake.close();
});

test('A 方案：估算偏乐观而实际溢出时，仍走既有的溢出提升兜底', async () => {
  const fake = await startFakeOllama((req) => (req.json?.model === 'nimble-v3:latest'
    ? { status: 400, body: { error: 'prompt 0 has 3000 tokens; expected 1\u201332768 (input is never truncated)' } }
    : { status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl, ladder: [
    { model: 'tev1:0.8b', numCtx: 8192 },
    { model: 'nimble-v3:latest', numCtx: 32768 },
    { model: 'synthetic-wide:latest', numCtx: 65536 },
  ] }));
  const value = await registered[0].execute(
    { state: 'A'.repeat(20000), questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.equal(fake.requests[0].json.model, 'nimble-v3:latest');
  assert.equal(value.model, 'synthetic-wide:latest', '溢出后按阶梯提升到下一档');
  assert.equal(value.escalated?.to, 'synthetic-wide:latest');
  assert.equal(value.escalated?.from, 'nimble-v3:latest');
  await fake.close();
});

test('A 方案：显式 model 优先于容量选择，并被记进粘滞（R1 不变）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const questions = [{ name: 'q1', type: 'noul', instructions: 'x' }];
  const first = await registered[0].execute({ state: 'A'.repeat(100), questions, model: 'tev1:latest' }, exec);
  assert.equal(fake.requests[0].json.model, 'tev1:latest', '显式指定必须被尊重');
  assert.equal(first.model, 'tev1:latest');
  assert.equal(first.plan.model, 'tev1:latest', 'plan 里回显的也必须是显式选中的档');
  // 注：plan.reason 描述的是**策略**（inline/scan/escalate），不反映选档原因 ——
  // 「选档原因可观测」已登记为待办（r3 审查 P2：成功提升时 plan 回显 reason=inline）。
  await fake.close();
});

test('配套 skill 的跨文件不变量：工具声明必须指名同一个 skill 名', () => {
  assert.equal(COMPANION_SKILL, SKILL_NAME, 'lib/tool.js 的 COMPANION_SKILL 必须等于 lib/skill.js 的 SKILL_NAME');
  assert.match(TOOL_DESCRIPTION, new RegExp(SKILL_NAME), '常驻描述必须指名配套 skill，否则模型无从知道指引在哪');
});

test('拿不到配套 skill 时拒绝服务（不是静默降级）', async () => {
  const { registered, ctx } = fakeCtx({ skills: { get: async () => undefined } });
  apply(ctx, Config({}));
  await assert.rejects(
    registered[0].execute(
      { state: 'x', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] },
      { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
    ),
    (error) => error.kind === 'skill_missing' && /配套技能/.test(error.message),
  );
});

test('首次使用把配套 skill 正文随结果交付，第二次只留提示（构造性保证「用工具=拿到指引」）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const exec = { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } };
  const args = { state: 'x', questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] };
  const value = await registered[0].execute(args, exec);
  const rendered = registered[0].output.render({}, value);
  assert.match(rendered[0].text, /companion skill/, '首次渲染必须带出 skill 正文');
  const second = await registered[0].execute(args, exec);
  const rendered2 = registered[0].output.render({}, second);
  assert.doesNotMatch(rendered2[0].text, /companion skill/, '第二次不重复交付全文');
  await fake.close();
});
test('toolName 配置改变工具名', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({ toolName: 'decide' }));
  assert.equal(registered[0].name, 'decide');
});

test('execute 打到 /v1/systemone 并原样返回 answers', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));

    const value = await registered[0].execute(
      { state: 'x', questions: [{ name: 'label', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );

    // 返回值 = 客户端结果 + 本插件自己产出的体积字段（需求 M2），故逐字段比对。
    assert.equal(value.model, ANSWERS.model);
    assert.deepEqual(value.answers, ANSWERS.answers);
    assert.deepEqual(value.usage, ANSWERS.usage);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/v1/systemone');
    assert.equal(fake.requests[0].json.model, 'tev1:0.8b');

    // 体积可归因：必须按**转换后的线格式**度量，与 V8 的硬守卫同一口径 ——
    // 所以直接和该次真实请求体的字节数比对（比「存在且为数值」强）。
    assert.equal(typeof value.state_bytes, 'number');
    assert.equal(typeof value.body_bytes, 'number');
    assert.equal(value.state_bytes, Buffer.byteLength('x', 'utf8'));
    assert.equal(value.body_bytes, Buffer.byteLength(fake.requests[0].raw, 'utf8'));

    // 小 state 下不得出现告警键：宿主要求返回值是无损 JSON 值，undefined 字段会拒绝。
    assert.equal('body_warning' in value, false);
  } finally {
    await fake.close();
  }

  // 同源的第二条：服务端回包**不含 usage** 时，返回值里也**不得出现** usage 键。
  // 宿主对每个成功返回值跑 snapshotJsonValue，值为 `undefined` 的 own key 会让它判定
  // 「不是无损 JSON」并抛 ToolOutputError —— 于是一次完全成功的调用被报成工具失败。
  // 因此这里用一个只有 model/answers 的回包驱动一次真实往返（同一用例，不新增用例）。
  const noUsage = await startFakeOllama(() => ({
    status: 200,
    body: { model: ANSWERS.model, answers: ANSWERS.answers },
  }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: noUsage.baseUrl }));

    const value = await registered[0].execute(
      { state: 'x', questions: [{ name: 'label', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );

    assert.equal('usage' in value, false);
    assert.equal('body_warning' in value, false);
  } finally {
    await noUsage.close();
  }
});

test('execute 的本地校验错误不会发出网络请求', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));

    const error = await registered[0]
      .execute({ state: 'x', questions: [] }, { signal: undefined })
      .then(() => null, (e) => e);

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

    const error = await registered[0]
      .execute({ state: 'x', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] }, { signal: undefined })
      .then(() => null, (e) => e);

    assert.equal(error.name, 'SystemOneError');
    assert.equal(error.kind, 'model_missing');
  } finally {
    await fake.close();
  }
});

/**
 * 一个 body 确实**越过默认软阈值**（`LIMITS.softBodyBytes`）的 payload：5000 字节 state。
 * 三条新用例共用它，且各自都断言 `body_bytes > LIMITS.softBodyBytes` —— 否则"没有告警"
 * 这类否定式断言会静默退化成恒真，无法区分"开关关了"与"从来没到过阈值"。
 */
const BIG_ARGS = {
  state: 'x'.repeat(5000),
  questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }],
};

/** 走真实注册路径：apply(Config(...)) 之后调用已注册工具的 execute。 */
async function executeWith(baseUrl, config, args) {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({ baseUrl, ...config }));
  return registered[0].execute(args, { signal: undefined });
}

test('softBodyBytes 配置改变告警出现的位置（阈值两侧，经 execute 验证）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const run = (config) => executeWith(fake.baseUrl, config, BIG_ARGS);

    const byDefault = await run({});
    const lowThreshold = await run({ softBodyBytes: 2000 });
    const highThreshold = await run({ softBodyBytes: 20000 });

    // 同一 payload、同一假服务端：三次 execute 度到的 body 必须逐字节一致，
    // 否则"阈值两侧"的对比不成立。
    assert.equal(byDefault.body_bytes, lowThreshold.body_bytes);
    assert.equal(lowThreshold.body_bytes, highThreshold.body_bytes);
    // 承重前提：该 payload 必须高于默认阈值，否则本用例静默退化成恒真。
    assert.ok(
      byDefault.body_bytes > LIMITS.softBodyBytes,
      `fixture body ${byDefault.body_bytes} 必须高于 softBodyBytes ${LIMITS.softBodyBytes}`,
    );

    // 未设 ⇒ 回落到 LIMITS.softBodyBytes（该默认值只有 validate.js 一处来源）。
    assert.equal('body_warning' in byDefault, true);
    assert.match(
      byDefault.body_warning,
      new RegExp(`已超过建议的 ${LIMITS.softBodyBytes} 字节`),
    );

    // 自定义阈值的**下方**（2000 < body）：告警，且文案引用的是配置值而非默认值。
    assert.equal('body_warning' in lowThreshold, true);
    assert.match(lowThreshold.body_warning, /已超过建议的 2000 字节/);

    // 自定义阈值的**上方**（20000 > body）：同一个 body 却没有告警。
    assert.equal('body_warning' in highThreshold, false);
    assert.equal(highThreshold.body_warning, undefined);
  } finally {
    await fake.close();
  }
});

test('bodyWarning: false 时任何体积都不产出 body_warning 键（经 execute 验证）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const run = (config) => executeWith(fake.baseUrl, config, BIG_ARGS);

    const off = await run({ bodyWarning: false });
    // 承重前提：关掉开关时 body 仍远高于阈值，故"键不存在"只可能来自开关。
    assert.ok(
      off.body_bytes > LIMITS.softBodyBytes,
      `fixture body ${off.body_bytes} 必须高于 softBodyBytes ${LIMITS.softBodyBytes}`,
    );
    assert.equal('body_warning' in off, false);
    // 也不得退化成 `false` 或空串：宿主按无损失 JSON 校验，schema 里它是 string。
    assert.equal(off.body_warning, undefined);

    // 未设与显式 true 都必须**照常告警** —— 否则"关闭"可能只是"从来没告警过"。
    assert.equal('body_warning' in await run({}), true);
    assert.equal('body_warning' in await run({ bodyWarning: true }), true);
  } finally {
    await fake.close();
  }
});

test('absurd softBodyBytes（1e9）被静默钳到 maxBodyBytes，行为等同上限', async () => {
  // 机制断言：钳制在 execute 层面**几乎不可观测**（任何 ≥ maxBodyBytes 的阈值都不会
  // 触发告警，因为 prepareRequest 先按同一字节数拒绝），所以"生效值"本身是这条规则
  // 唯一的承重点 —— 少了它，一个"完全不钳制"的实现也能通过下面全部断言。
  assert.equal(resolveSoftBodyBytes(1e9), LIMITS.maxBodyBytes);
  assert.equal(resolveSoftBodyBytes(LIMITS.maxBodyBytes + 1), LIMITS.maxBodyBytes);
  // 钳制只在顶端：未越上限的值必须原样通过。
  assert.equal(resolveSoftBodyBytes(2000), 2000);
  // 未设 ⇒ 回落 LIMITS.softBodyBytes。
  assert.equal(resolveSoftBodyBytes(undefined), LIMITS.softBodyBytes);

  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const absurd = await executeWith(fake.baseUrl, { softBodyBytes: 1e9 }, BIG_ARGS);
    const atCap = await executeWith(
      fake.baseUrl,
      { softBodyBytes: LIMITS.maxBodyBytes },
      BIG_ARGS,
    );

    // execute 层面：1e9 的结果与显式 maxBodyBytes **完全相同**（同一 payload 下都不告警），
    // 即它被折到上限，而不是按 1e9 的原值另走一条路。
    assert.deepEqual(absurd, atCap);
    assert.equal('body_warning' in absurd, false);
    // 承重前提：body 高于默认阈值，否则上面两条都不表达"被钳到上限"。
    assert.ok(absurd.body_bytes > LIMITS.softBodyBytes);
    assert.ok(absurd.body_bytes <= LIMITS.maxBodyBytes);
  } finally {
    await fake.close();
  }
});

test('model 参数逐次覆盖默认模型', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  try {
    const { registered, ctx } = fakeCtx();
    apply(ctx, Config({ baseUrl: fake.baseUrl }));
    await registered[0].execute(
      { state: 'x', model: 'tev1:latest', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] },
      { signal: undefined },
    );
    assert.equal(fake.requests[0].json.model, 'tev1:latest');
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// F3（2026-10-04 缺陷审查轮）：无意义的取值必须在**加载期**就被拒，而不是留到
// 调用期抛 RangeError（AbortSignal.timeout(-1)）或让告警恒真（阈值 <= 0）。
// ---------------------------------------------------------------------------

test('F3：Config 拒绝非正的 timeoutMs（加载期报错，不留到调用期抛 RangeError）', () => {
  assert.throws(() => Config({ timeoutMs: 0 }), /expected number >= 1/);
  assert.throws(() => Config({ timeoutMs: -1 }), /expected number >= 1/);
  assert.equal(Config({ timeoutMs: 1 }).timeoutMs, 1);
});

test('F3：Config 拒绝负的 softBodyBytes（0 是合法策略值：每次都告警）', () => {
  assert.throws(() => Config({ softBodyBytes: -1 }), /expected number >= 0/);
  assert.equal(Config({ softBodyBytes: 0 }).softBodyBytes, 0);
});

test('F3：resolveSoftBodyBytes 对非有限/负值回落默认，绝不返回 NaN', () => {
  // schemastery 会把 NaN 静默折成 null（实测），故 .min() 拦不住它 ——
  // 这一层是 NaN 的唯一防线：否则 Math.min(null, 65536) = 0 ⇒ 每次调用都告警。
  assert.equal(resolveSoftBodyBytes(NaN), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(null), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(-1), LIMITS.softBodyBytes);
  assert.equal(resolveSoftBodyBytes(0), 0);
  assert.equal(resolveSoftBodyBytes(undefined), LIMITS.softBodyBytes);
});

// ---------------------------------------------------------------------------
// §4.11（2026-10-06 delta · 置信度门限）：把「低置信度就升级」从 description 里的一句
// 建议变成**可执行、可断言的一行输出**。三条不可动摇的性质：
//   ① **只加旗，不清障** —— answers 逐字原样返回，绝不因置信度低而删题/改标签/拒绝；
//   ② 门限与文案是**策略**，住在工具层（render 只呈现，见 render.test.mjs）；
//   ③ 缺失 confidence 按**保守方向**计入（它不是"高置信"，是"未知"）。
// ---------------------------------------------------------------------------

/**
 * 混合置信度的回包，四条各司其职：高于 / 低于 / **缺失** confidence，以及一型没有
 * confidence 语义的 `noul`。任何一条被漏判都会让下面的断言打红。
 */
const MIXED_ANSWERS = {
  model: 'tev1:0.8b',
  answers: {
    solid: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 },
    shaky: { type: 'choice', choice: 'a', probabilities: { a: 0.4, b: 0.35, c: 0.25 }, confidence: 0.05 },
    missing: { type: 'score', score: 1.2, probabilities: { 0: 0.3, 1: 0.4, 2: 0.3 } },
    prob: { type: 'noul', noul: 0.49 },
  },
};

/** 与 MIXED_ANSWERS 对应的合法请求参数（题名与回包键一一对齐）。 */
const MIXED_ARGS = {
  state: 'x',
  questions: [
    { name: 'solid', type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } },
    { name: 'shaky', type: 'choice', instructions: '?', criteria: { a: 'A', b: 'B' } },
    { name: 'missing', type: 'score', instructions: '?', criteria: ['low', 'mid', 'high'] },
    { name: 'prob', type: 'noul', instructions: '?' },
  ],
};

test('§4.11 execute：只把低于门限（或缺失）的题写进 confidence_warning，answers 逐字原样返回', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: MIXED_ANSWERS }));
  try {
    const byDefault = await executeWith(fake.baseUrl, {}, MIXED_ARGS);

    // ① 只加旗、不清障：answers 必须与回包**逐字相同** —— 既不删掉低置信的题，
    // 也不把它改写成别的标签或补一个 confidence。
    assert.deepEqual(byDefault.answers, MIXED_ANSWERS.answers);

    assert.equal('confidence_warning' in byDefault, true);
    // 未设 ⇒ 回落到 LIMITS.minConfidence（该默认值只有 validate.js 一处来源）。
    assert.match(byDefault.confidence_warning, new RegExp(`低于 ${LIMITS.minConfidence}`));
    assert.match(byDefault.confidence_warning, /以下 2 题/);
    assert.match(byDefault.confidence_warning, /shaky\(0\.050\)/);
    // ③ 缺失 confidence 按保守方向计入，并显式渲染成 — 而不是漏掉或写 NaN。
    assert.match(byDefault.confidence_warning, /missing\(—\)/);
    // 高于门限的 solid 不得在列；noul 没有 confidence 语义，同样不得在列。
    assert.doesNotMatch(byDefault.confidence_warning, /solid/);
    assert.doesNotMatch(byDefault.confidence_warning, /prob\(/);

    // 阈值两侧对照（同一批答案、同一假服务端）：把门限压到 0.01 ⇒ 只剩缺失那题；
    // 抬到 0.95 ⇒ 连信心最高的 solid(0.900) 也被拦下。两侧都动，才排除"阈值没被读"。
    const low = await executeWith(fake.baseUrl, { minConfidence: 0.01 }, MIXED_ARGS);
    assert.match(low.confidence_warning, /以下 1 题/);
    assert.match(low.confidence_warning, /missing\(—\)/);
    assert.doesNotMatch(low.confidence_warning, /shaky/);

    const high = await executeWith(fake.baseUrl, { minConfidence: 0.95 }, MIXED_ARGS);
    assert.match(high.confidence_warning, /以下 3 题/);
    assert.match(high.confidence_warning, /solid\(0\.900\)/);
    // 任何阈值下 answers 都不变（门限只影响那一行字）。
    assert.deepEqual(high.answers, MIXED_ANSWERS.answers);
  } finally {
    await fake.close();
  }
});

test('§4.11 execute：minConfidence: 0 关闭门限（同一批低置信答案也不产出该键）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: MIXED_ANSWERS }));
  try {
    const off = await executeWith(fake.baseUrl, { minConfidence: 0 }, MIXED_ARGS);
    assert.equal('confidence_warning' in off, false);
    // 也不得退化成 `false` 或空串：宿主按无损 JSON 校验，schema 里它是 string。
    assert.equal(off.confidence_warning, undefined);

    // 承重前提：同一批答案在默认门限下**确实**会告警，否则上面两条只证明"从没到过阈值"。
    assert.equal('confidence_warning' in await executeWith(fake.baseUrl, {}, MIXED_ARGS), true);
  } finally {
    await fake.close();
  }
});

test('§4.11：Config 拒绝负的 minConfidence（0 合法且语义是关闭）', () => {
  assert.throws(() => Config({ minConfidence: -1 }), /expected number >= 0/);
  assert.equal(Config({ minConfidence: 0 }).minConfidence, 0);
  assert.equal(Config({ minConfidence: 0.4 }).minConfidence, 0.4);
});

test('§4.11：resolveMinConfidence 对非有限/负值回落默认，且钳到 [0,1]', () => {
  assert.equal(resolveMinConfidence(undefined), LIMITS.minConfidence);
  assert.equal(resolveMinConfidence(NaN), LIMITS.minConfidence);
  assert.equal(resolveMinConfidence(null), LIMITS.minConfidence);
  assert.equal(resolveMinConfidence(-1), LIMITS.minConfidence);
  // 0 是**合法策略值且语义为关闭** —— 不得被当成"未设"而回落默认（与 softBodyBytes: 0
  // 方向相反：那里 0 是"每次都告警"）。这一条是两种语义不互相传染的唯一承重点。
  assert.equal(resolveMinConfidence(0), 0);
  assert.equal(resolveMinConfidence(0.4), 0.4);
  // confidence 的定义域是 [0,1]，更高的阈值只表达"全部告警" ⇒ 折到上界。
  assert.equal(resolveMinConfidence(2), 1);
});

test('§4.11：collectLowConfidence 跳过 noul、缺失按低计、<=0 关闭、且绝不修改入参', () => {
  const answers = {
    ok: { type: 'choice', confidence: 0.5 },
    low: { type: 'choice', confidence: 0.1 },
    missing: { type: 'choice' },
    nan: { type: 'score', confidence: Number.NaN },
    prob: { type: 'noul', noul: 0.01 },
  };
  const snapshot = JSON.stringify(answers);

  assert.deepEqual(collectLowConfidence(answers, 0.25), [
    { name: 'low', confidence: 0.1 },
    { name: 'missing', confidence: null },
    { name: 'nan', confidence: null },
  ]);
  // 纯函数：只读入参、不改写（"只加旗，不清障"在函数级也成立）。
  assert.equal(JSON.stringify(answers), snapshot);

  // 门限恰好等于 confidence 时**放行**（严格小于才告警）—— 边界写死，防止 <= 实现蒙过。
  assert.deepEqual(collectLowConfidence({ a: { type: 'choice', confidence: 0.25 } }, 0.25), []);

  // <= 0 一律关闭，含"缺失 confidence"那条保守分支（否则 0 会退化成"全部告警"）。
  assert.deepEqual(collectLowConfidence(answers, 0), []);
  assert.deepEqual(collectLowConfidence(answers, -1), []);

  // 形状异常不得抛错（answers 由服务端回包来，client 只保证它是非数组对象）。
  assert.deepEqual(collectLowConfidence(null, 0.25), []);
  assert.deepEqual(collectLowConfidence(undefined, 0.25), []);
  assert.deepEqual(collectLowConfidence([], 0.25), []);
  assert.deepEqual(collectLowConfidence({}, 0.25), []);
});

test('重复判据会被归因出来：告警指向问题文本，而不是误导性地让人改材料（真机样例）', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: ANSWERS }));
  const { registered, ctx } = fakeCtx({ fs: treeFs({}) });
  apply(ctx, Config({ baseUrl: fake.baseUrl }));
  const rubric = '是否属于本课题不可裁的核心文献'.repeat(12);
  const questions = [1, 2, 3, 4, 5].map((n) => ({ name: 'r' + n, type: 'noul', instructions: rubric }));
  const value = await registered[0].execute(
    { state: 'x'.repeat(50), questions },
    { preview: false, signal: undefined, agent: { session: { header: { cwd: 'F:/ws' } } } },
  );
  assert.equal(typeof value.body_warning, 'string', '应当出告警');
  assert.match(value.body_warning, /问题文本|重复/, '告警必须归因到问题文本');
  assert.match(value.body_warning, /只写一次/, '并给可行动建议');
  await fake.close();
});

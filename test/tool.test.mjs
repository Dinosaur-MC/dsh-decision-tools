import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { resolveSoftBodyBytes, resolveMinConfidence, collectLowConfidence } from '../lib/tool.js';
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
  return {
    async resolve(path) {
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
  assert.deepEqual(inject, ['tools', 'fs']);
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
  const fakes = [{ name: 'a.md', key: 'docs/a.md' }];
  const fs = treeFs({ 'docs/a.md': 'line1\nline2\nline3' });
  const { registered, ctx } = fakeCtx({ fs });
  apply(ctx, Config({}));
  const value = await registered[0].execute(
    { stateSource: { kind: 'file', path: 'docs/a.md', startLine: 2, endLine: 3 }, questions: [{ name: 'q', type: 'noul', instructions: 'x' }] },
    { preview: false, signal: undefined },
  );
  assert.deepEqual(value.source, { kind: 'file', path: 'docs/a.md', bytes: 11, startLine: 2, endLine: 3, lines: 3 });
  assert.equal(value.state_bytes, 11, 'state 是切片后的材料');
  assert.equal(JSON.stringify(value).includes('line1'), false, '★ 材料不得回显在结果里（A7 的全部意义）');
  assert.equal(fakes.length, 1);
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

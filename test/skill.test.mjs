import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apply, parseSkill, inject, name, PROVIDER, SKILL_NAME, BUNDLED_SKILL_RANK } from '../lib/skill.js';

const ASSET = fileURLToPath(new URL('../assets/decision-usage/SKILL.md', import.meta.url));

function fakeCtx() {
  const providers = [];
  return { providers, ctx: { skills: { registerProvider: (create) => { providers.push(create({ invalidate() {} })); return () => {}; } } } };
}

test('插件身份与注入：独立入口、只依赖 skills', () => {
  assert.equal(name, 'decision-tools-skill');
  assert.deepEqual(inject, ['skills'], '缺技能注册表时本插件不激活，主插件不受影响');
  assert.equal(SKILL_NAME, 'decision-usage');
  assert.equal(PROVIDER, 'dsh-decision-tools');
  assert.equal(BUNDLED_SKILL_RANK, 600, '与 @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK 数值一致');
});

test('apply 恰注册一个 provider，且候选形状正确', async () => {
  const { providers, ctx } = fakeCtx();
  apply(ctx);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, PROVIDER);
  const candidates = await providers[0].list();
  assert.equal(candidates.length, 1);
  const candidate = candidates[0];
  assert.equal(candidate.name, SKILL_NAME);
  assert.equal(candidate.source, 'bundled');
  assert.equal(candidate.rank, BUNDLED_SKILL_RANK);
  assert.equal(candidate.provider, PROVIDER);
  assert.deepEqual(candidate.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.ok(candidate.description.length > 0);
});

test('resourceBase.path 是**原生路径**（fileURLToPath），不是百分号编码的 URL pathname', async () => {
  const { providers, ctx } = fakeCtx();
  apply(ctx);
  const [candidate] = await providers[0].list();
  assert.equal(candidate.resourceBase.kind, 'directory');
  assert.equal(candidate.resourceBase.path, fileURLToPath(new URL('../assets/decision-usage/', import.meta.url)),
    '必须是 fileURLToPath 的产物：换回 URL.pathname 即红（Windows 上会变成 /F:/… 且保留 %20）');
  assert.doesNotMatch(candidate.resourceBase.path, /%[0-9A-Fa-f]{2}/, '模型可见路径不得含百分号编码');
  // 负对照：URL.pathname 对含空格的路径确实留下 %20 —— 证明上面的断言不是恒真。
  // （Windows 的 file URL 必须带盘符，否则 fileURLToPath 抛 ERR_INVALID_FILE_URL_PATH。）
  const spaced = new URL('file:///C:/tmp/a%20b/');
  assert.match(spaced.pathname, /%20/, 'pathname 保留编码（这正是旧写法的缺陷）');
  assert.doesNotMatch(fileURLToPath(spaced), /%/, 'fileURLToPath 解码');
});

test('get 返回正文且**不含 frontmatter**（正文才是模型读到的东西）', async () => {
  const { providers, ctx } = fakeCtx();
  apply(ctx);
  const [candidate] = await providers[0].list();
  const skill = await providers[0].get(candidate);
  assert.equal(skill.name, SKILL_NAME);
  assert.doesNotMatch(skill.content, /^---/, 'frontmatter 不得进入正文');
  assert.doesNotMatch(skill.content, /description:/);
  assert.match(skill.content, /^# Using the local decision model/);
});

/**
 * v3 的必备内容：一条一锚点，一锚点一断言 —— 正文被「顺手精简」时点会静默消失，
 * 而 skill 是**按需加载**的（不在工具 description 里，删掉不会有别的守卫报警）。
 * 分组依据：ADR-11..16（两模式互斥 / material / 输出五键 / depth / wire / 密度）与 77dc063
 * 的两处裁定（confidence 保留进 notes、扫描内部化仅 deep）。
 */
const ANCHORS = [
  ['① 一次多题 + 绝不逐条循环', /ONE call[\s\S]*NEVER loop one call per item/],
  ['② 两模式互斥（items XOR questions）', /exactly one mode[\s\S]*giving both is an error/],
  ['③ criteria 两处形态：批量走顶层、异质走每题', /top-level `criteria` in batch mode, per-question in mixed mode/],
  ['④ material 三形态与安全边界（工作区相对 / 单文件报错 / glob 截断）', /workspace-root-relative[\s\S]*truncated/],
  ['⑤ depth 三档语义', /`quick`[\s\S]*`normal`[\s\S]*`deep`/],
  ['⑥ 分批不改变返回结构（results 与批次解耦）', /Batching never changes `results\[\]`/],
  ['⑦ 五键读法', /`results\[\]`[\s\S]*`coverage`[\s\S]*`cost`[\s\S]*`notes\[\]`/],
  ['⑧ confidence 是集中度不是正确率', /\(1 - H\/ln N\); it is NOT accuracy/],
  ['⑨ notes 点名是「旗」不是过滤器', /FLAG, not a filter[\s\S]*NOT thereby endorsed/],
  ['⑩ noul 是数值不是布尔', /`noul` returns a NUMBER, not a boolean[\s\S]*0\.475[\s\S]*47\.5% chance of yes/],
  ['⑪ score 报在 0..N-1 尺度（对应 probabilities 的键）', /0\.\.N-1 level scale, not normalised/],
  ['⑫ deep 的逐块最大只是定位线索，不是文档级结论', /locator, not a document-level probability/],
  ['⑬ 硬边界：概率不是证据、不得做 fail-open / fail-closed 判据', /artifact-level evidence[\s\S]*fail-open or fail-closed[\s\S]*deterministic rules/],
  ['⑭ 换档即换基座（门限不可沿用）', /different base model, so thresholds calibrated for one may not carry over/],
];
for (const [label, anchor] of ANCHORS) {
  test(`正文必备内容 ${label}`, () => {
    const raw = readFileSync(ASSET, 'utf8');
    assert.match(raw, anchor, `assets/decision-usage/SKILL.md 缺少锚点 ${anchor}（ADR-10 的七条必备内容之一）`);
  });
}

test('v3 词表：正文必须出现 items/rubric/depth，且不含被删除的旧词', () => {
  const raw = readFileSync(ASSET, 'utf8');
  for (const word of ['items', 'rubric', 'depth']) assert.match(raw, new RegExp(word));
  for (const gone of ['stateSource', 'strategy', 'aggregate', 'confidence_warning', 'body_warning']) {
    assert.equal(raw.includes(gone), false, `SKILL.md 不得再出现被删除的旧词 ${gone}`);
  }
  // 旧键只在被当作**字段引用**（反引号包裹）时才算违规：正文里的自然语言 answers 不算。
  // 注意 `escalated` / `source` 在 v3 里仍是**合法字段**（分别在 cost 与 material 内），故不入此表。
  for (const key of ['answers', 'chunks', 'usage', 'plan', 'scan', 'state_bytes', 'body_bytes']) {
    assert.equal(raw.includes('`' + key + '`'), false, `SKILL.md 不得再把旧键 ${key} 当字段引用`);
  }
  // 注意：v1/v2 不能用裸 substring 断言 —— 模型名 tev1 里就含 v1，而 ⑩ 要求它必须出现。
  assert.equal(/\bv1\b|\bv2\b/.test(raw), false, 'SKILL.md 不得出现 v1/v2 这类沿革措辞');
});

test('parseSkill：缺 frontmatter 或缺 description 一律抛错（不静默注册无法路由的 skill）', () => {
  assert.throws(() => parseSkill('# no frontmatter', 'x.md'), /缺少 YAML frontmatter/);
  assert.throws(() => parseSkill('---\nname: decision-usage\n---\nbody', 'x.md'), /缺少 description/);
  assert.throws(() => parseSkill('---\ndescription:\n---\nbody', 'x.md'), /缺少 description/);
  const ok = parseSkill('---\ndescription: Use when x.\n---\n\n# Body\n', 'x.md');
  assert.equal(ok.description, 'Use when x.');
  assert.equal(ok.content, '# Body');
});

/**
 * 目录里展示的是 description 的**前 ~200 字符**（超出截断为 …）。它决定模型是否会加载本 skill，
 * 所以两个工具名与主要触发词必须出现在这段前缀里 —— 只写在正文里等于不可发现。
 */
test('description 是可路由的：两个工具名与触发词都在前 200 字符内，且长度受限', () => {
  const { description } = parseSkill(readFileSync(ASSET, 'utf8'), ASSET);
  const head = description.slice(0, 200);
  assert.match(head, /`decision`|decision/, '前 200 字符必须提到 decision');
  assert.match(head, /`monitor`|monitor/, '前 200 字符必须提到 monitor（否则目录里被截掉）');
  for (const trigger of ['routing', 'classify', 'relevance', 'scoring', 'wait']) {
    assert.ok(head.includes(trigger), '前 200 字符缺少触发词：' + trigger);
  }
  assert.ok(description.length <= 400, 'description ' + description.length + ' 字符过长（目录条目要短）');
  assert.doesNotMatch(description, /Use when a bounded judgment/, '旧的可读性差的写法不得回归');
});
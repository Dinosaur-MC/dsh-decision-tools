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
 * ADR-10 的七条必备内容：一条一锚点，一锚点一断言 —— 正文被「顺手精简」时点会静默消失，
 * 而 skill 是**按需加载**的（不在工具 description 里，删掉不会有别的守卫报警）。
 */
const ANCHORS = [
  ['① 一次多题 + 绝不逐条循环', /NEVER loop one call per item/i],
  ['② 引用式材料与路径约束', /stateSource[\s\S]*workspace-root-relative/],
  ['③ confidence 不是正确率', /not accuracy/i],
  ['④ 提升换模型即换基座', /escalated[\s\S]*different base model/i],
  ['⑤ 扫描只答可定位问题 + 聚合暂定', /localizable[\s\S]*provisional/i],
  ['⑥ plan / chunks / scan 的读法', /`plan`[\s\S]*`chunks`[\s\S]*`scan`/],
  ['⑦ 硬边界：不得作为 fail-open / fail-closed 依据', /fail-open or fail-closed/],
];
for (const [label, anchor] of ANCHORS) {
  test(`正文必备内容 ${label}`, () => {
    const raw = readFileSync(ASSET, 'utf8');
    assert.match(raw, anchor, `assets/decision-usage/SKILL.md 缺少锚点 ${anchor}（ADR-10 的七条必备内容之一）`);
  });
}

test('parseSkill：缺 frontmatter 或缺 description 一律抛错（不静默注册无法路由的 skill）', () => {
  assert.throws(() => parseSkill('# no frontmatter', 'x.md'), /缺少 YAML frontmatter/);
  assert.throws(() => parseSkill('---\nname: decision-usage\n---\nbody', 'x.md'), /缺少 description/);
  assert.throws(() => parseSkill('---\ndescription:\n---\nbody', 'x.md'), /缺少 description/);
  const ok = parseSkill('---\ndescription: Use when x.\n---\n\n# Body\n', 'x.md');
  assert.equal(ok.description, 'Use when x.');
  assert.equal(ok.content, '# Body');
});

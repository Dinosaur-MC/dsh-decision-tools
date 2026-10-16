/**
 * 随包 Skill 的插件入口（ADR-10）：把 `decision-usage` 作为 `bundled` 候选注册进 `ctx.skills`。
 *
 * **为什么是独立入口**（v3 起主插件的 `inject` 是 `['tools','fs','skills']` —— 工具行也必须拿到技能，
 * 否则拒绝服务；两个入口刻意不同名，正是为了各自单独启停）：技能注册与工具注册的**生命周期分开**，
 * 换 / 停随包 skill 时不必动工具行。第一方的做法同样是独立行（`dsh-skill-badge` 即独立包），
 * 或用 `ctx.inject(['skills'], cb)`。
 *
 * **为什么不用 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK`**：它是**可选 peer**，未安装时
 * `import` 会让本模块整个加载失败。故这里只复制那个刻度的数值，并在这条注释里登记来源。
 *
 * @module dsh-decision-tools/skill
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 插件身份名（`lib/tool.js` 用 `decision-tools`，这里刻意不同名以便单独启停）。 */
export const name = 'decision-tools-skill';

/** 只依赖技能注册表；缺它时本插件不激活，主插件不受影响。 */
export const inject = ['skills'];

/** 技能名（kebab-case，与 `assets/<name>/SKILL.md` 同名）。 */
export const SKILL_NAME = 'decision-usage';

/** provider 名（第一方的命名习惯是包名去掉 `@deepseek-ai/` 前缀）。 */
export const PROVIDER = 'dsh-decision-tools';

/**
 * 随包 skill 的优先级刻度，与 `@deepseek-ai/dsh-skill` 的 `BUNDLED_SKILL_RANK` **数值一致**（600）。
 * 不 import 的原因见文件头：那个包是可选 peer。
 */
export const BUNDLED_SKILL_RANK = 600;

/** SKILL.md 的绝对路径（包内资产，随 `files` 白名单发布）。 */
export function skillFileUrl() {
  return new URL(`../assets/${SKILL_NAME}/SKILL.md`, import.meta.url);
}

/**
 * 解析 SKILL.md：YAML frontmatter 里的 `description` 是**必需**的（缺即抛错，不静默注册一个
 * 无法路由的 skill），正文是 frontmatter 之后的部分。
 *
 * @param {string} raw 文件原文
 * @param {string} path 出错时用的路径
 * @returns {{ description: string, content: string }}
 * @throws {Error} 缺 frontmatter 或缺 description
 */
export function parseSkill(raw, path) {
  const matched = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (matched === null) throw new Error(`${path}: 缺少 YAML frontmatter（至少需要 description）。`);
  const description = /^description:\s*(.+)$/m.exec(matched[1])?.[1]?.trim();
  if (description === undefined || description === '') throw new Error(`${path}: frontmatter 里缺少 description。`);
  return { description, content: raw.slice(matched[0].length).trim() };
}

/**
 * 装配：注册一个**不可变**的 provider，`get()` 每次从磁盘重读正文（与
 * `dsh-sandbox-windows-acl` 的 acl-skill 同取向：源单一、不在内存里留副本）。
 *
 * @param {any} ctx 宿主上下文（只需 `skills`）
 */
export function apply(ctx) {
  ctx.skills.registerProvider(() => ({
    name: PROVIDER,
    async list() {
      const raw = await readFile(skillFileUrl(), 'utf8');
      const { description } = parseSkill(raw, `assets/${SKILL_NAME}/SKILL.md`);
      return [{
        name: SKILL_NAME,
        description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER,
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        // `fileURLToPath` 而不是 `URL.pathname`：后者会把空格/非 ASCII 留成 `%20`/`%E4%B8%AD`
        // 原样交给模型（第一方 dsh-skill-badge 同样用 fileURLToPath）。
        resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`../assets/${SKILL_NAME}/`, import.meta.url)) },
        locator: SKILL_NAME,
      }];
    },
    async get(entry) {
      const { rank: _rank, locator: _locator, ...summary } = entry;
      const raw = await readFile(skillFileUrl(), 'utf8');
      return { ...summary, content: parseSkill(raw, `assets/${SKILL_NAME}/SKILL.md`).content };
    },
  }));
}

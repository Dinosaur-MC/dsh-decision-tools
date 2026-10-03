import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { PARAMETERS, TOOL_DESCRIPTION } from '../lib/parameters.js';
import { Config } from '../lib/tool.js';

test('参数契约的结构不变量（DSL 的硬性要求）', () => {
  assert.deepEqual(Object.keys(PARAMETERS), ['state', 'questions', 'model']);
  assert.equal(PARAMETERS.state.required, true);
  assert.equal(PARAMETERS.questions.required, true);
  assert.equal(PARAMETERS.model.required, undefined);

  // state 必须是三选一联合，且 object 分支显式声明 openness。
  assert.equal(PARAMETERS.state.oneOf.length, 3);
  const objectBranch = PARAMETERS.state.oneOf.find((branch) => branch.type === 'object');
  assert.equal(typeof objectBranch.additionalProperties, 'boolean');

  // questions 是对象数组，且对象是封闭的（防止模型塞进未声明字段）。
  assert.equal(PARAMETERS.questions.type, 'array');
  assert.equal(PARAMETERS.questions.items.type, 'object');
  assert.equal(PARAMETERS.questions.items.additionalProperties, false);
  assert.deepEqual(
    Object.keys(PARAMETERS.questions.items.properties),
    ['name', 'type', 'instructions', 'criteria'],
  );

  // 类型枚举里绝不能出现 boolean（服务端只认 noul）。
  assert.deepEqual(PARAMETERS.questions.items.properties.type.enum, ['choice', 'noul', 'score']);

  // criteria 用 oneOf 在本地挡住「对象还是数组」这一最常见误用。
  assert.equal(PARAMETERS.questions.items.properties.criteria.oneOf.length, 2);
});

test('描述里必须点明 noul 不是布尔、confidence 不是正确率', () => {
  const text = `${TOOL_DESCRIPTION} ${PARAMETERS.questions.items.properties.type.description}`;
  assert.match(text, /not a boolean|not `boolean`/);
  assert.match(text, /NOT accuracy/);
});

/**
 * 权威键集 = 宿主投影出的配置 schema（`Config.dict`），**不是**在本文件里复述键名 ——
 * 复述一份就等于把「改代码要同步改这里」变成新的漂移点。
 * `schemastery` 的 `dict` 保持 `z.object({...})` 的书写顺序，故顺序也可作为断言。
 */
const AUTHORITATIVE_KEYS = Object.keys(Config.dict ?? {});

/** 配置表的识别锚点：表头行必须逐字命中它，且下一行是 Markdown 分隔行。 */
const TABLE_HEADER = '| Key | Default | Meaning |';

/** 对不齐时能直接改 README 的报错文本：文件名 + 期望的表头 + 缺/多/乱序三类差集。 */
function inconsistency(file, detail) {
  return `${file}: README 的 ## Configuration 表格键必须与 lib/tool.js 的 Config 投影一致`
    + `（集合与顺序都要一致）。期望表头 "${TABLE_HEADER}"，后随 "|---|" 分隔行。`
    + `\n  权威键（Config.dict）：${AUTHORITATIVE_KEYS.join(', ')}\n  ${detail}`;
}

/**
 * 从 README 的 `## Configuration` 小节里按**解析出的键**取表，不看格式排版 ——
 * 重新排版表格不该让本用例变红，增删改一个 Config 键而不动文档才该。
 *
 * 解析失败一律**抛错**（绝不返回空数组后静默通过）：定位不到小节、找不到表头 + 分隔行、
 * 或一行数据都没解析出来，都算文档结构不可识别。
 */
function readConfigTableKeys(file) {
  const lines = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8').split('\n');
  const heading = lines.findIndex((line) => line.trim() === '## Configuration');
  if (heading < 0) {
    throw new Error(`${file}: 找不到 "## Configuration" 小节 —— 无法核对配置表，请先补回该小节。`);
  }

  const header = lines.findIndex((line, index) => index > heading && line.trim() === TABLE_HEADER);
  if (header < 0 || !/^\|[\s|:-]+\|$/.test(lines[header + 1]?.trim() ?? '')) {
    throw new Error(`${file}: "## Configuration" 下找不到配置表表头 "${TABLE_HEADER}" 及其后的 "|---|" 分隔行。`);
  }

  const keys = [];
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) break;
    const match = /^\|\s*`([A-Za-z0-9_]+)`\s*\|/.exec(line);
    if (match) keys.push(match[1]);
  }
  if (keys.length === 0) {
    throw new Error(`${file}: 配置表存在，但一行键都没解析出来（期望如 "| \`baseUrl\` | ... |"）。`);
  }
  return keys;
}

test('README 的配置表键集与顺序必须与 Config 的投影一致（两份 README）', () => {
  assert.equal(AUTHORITATIVE_KEYS.length > 0, true, 'Config.dict 为空 ⇒ 投影读法失效，守卫会假绿');

  for (const file of ['README.md', 'README.zh.md']) {
    const documented = readConfigTableKeys(file);
    const missing = AUTHORITATIVE_KEYS.filter((key) => !documented.includes(key));
    const extra = documented.filter((key) => !AUTHORITATIVE_KEYS.includes(key));
    const renamed = [...new Set([...missing, ...extra])].sort().join(', ');
    const detail = missing.length || extra.length
      ? `差集：文档缺少 [${missing.join(', ')}]、文档多出 [${extra.join(', ')}]（改名的键为 ${renamed}）`
      : `键集相同但顺序不同：文档 [${documented.join(', ')}]`;
    assert.deepEqual(documented, AUTHORITATIVE_KEYS, inconsistency(file, detail));
  }
});

test('能投影成 JSON Schema，且 required 只含 state 与 questions', () => {
  const json = parameterSchemaSpecToJsonSchema(PARAMETERS);
  assert.equal(json.type, 'object');
  assert.ok(json.properties.state);
  assert.ok(json.properties.questions);
  assert.ok(json.properties.model);
  assert.equal(json.required.includes('state'), true);
  assert.equal(json.required.includes('questions'), true);
  assert.equal(json.required.includes('model'), false);
});

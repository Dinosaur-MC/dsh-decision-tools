import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { PARAMETERS, TOOL_DESCRIPTION } from '../lib/parameters.js';
import { SharedConfig, DecisionConfig, MonitorConfig } from '../lib/configs.js';

/** 随包 skill 的正文：§4.9 的使用指引允许住在它里面（按需加载），但必须在 description 或它之中一处。 */
const SKILL_BODY = readFileSync(fileURLToPath(new URL('../assets/decision-usage/SKILL.md', import.meta.url)), 'utf8');

test('参数契约的结构不变量（DSL 的硬性要求）', () => {
  // 顺序即注入顺序：材料 → 判据 → 两种模式 → 题型 → 深度 → 逃生口。
  assert.deepEqual(Object.keys(PARAMETERS),
    ['material', 'rubric', 'items', 'questions', 'type', 'criteria', 'depth', 'model']);

  // required 只有 material（两种模式共用的必给字段）。**模式内的必给性不写进 schema**：
  // 用 oneOf 写 items/questions 两条分支会把常驻 schema 的注入预算翻倍（ADR-14），
  // 故 rubric/items/type 与 questions 的必给性由 lib/validate.js 的 assertModeExclusive 把关。
  assert.equal(PARAMETERS.material.required, true);
  for (const key of ['rubric', 'items', 'questions', 'type', 'criteria', 'depth', 'model']) {
    assert.equal(PARAMETERS[key].required, undefined, `${key} 的必给性按模式在校验层把关`);
  }
  // depth 缺省 normal（ADR-14），只有两档语义可选之外的枚举值在本地被拒。
  assert.deepEqual(PARAMETERS.depth.enum, ['quick', 'normal', 'deep']);

  // material：内联字符串 + 引用两种形态（file / glob / tool 同在 object 分支里，恰有其一由校验层把关）。
  assert.equal(PARAMETERS.material.oneOf.length, 2);
  const reference = PARAMETERS.material.oneOf.find((branch) => branch.type === 'object');
  assert.equal(typeof reference.additionalProperties, 'boolean');
  assert.deepEqual(Object.keys(reference.properties), ['file', 'glob', 'tool']);
  assert.equal(reference.properties.file.oneOf.length, 2, 'file 接受字符串简写或对象');
  assert.equal(reference.properties.glob.oneOf.length, 2, 'glob 接受字符串简写或对象');
  const fileObject = reference.properties.file.oneOf.find((branch) => branch.type === 'object');
  const globObject = reference.properties.glob.oneOf.find((branch) => branch.type === 'object');
  assert.equal(fileObject.properties.path.required, true);
  assert.equal(globObject.properties.pattern.required, true);
  assert.equal(reference.properties.tool.properties.name.required, true, 'tool 必须显式给工具名');
  assert.deepEqual(
    Object.keys(reference.properties.tool.properties),
    ['name', 'arguments'],
    'arguments 是被委托工具自己的参数面，故只做开放对象（不复制它的 schema）',
  );
  assert.equal(typeof reference.properties.tool.properties.arguments.additionalProperties, 'boolean');
  for (const branch of [fileObject, globObject, reference.properties.tool]) {
    assert.equal(typeof branch.additionalProperties, 'boolean', 'object 节点必须显式声明 openness');
  }

  // questions 是对象数组，且对象是封闭的（防止模型塞进未声明字段）。
  assert.equal(PARAMETERS.questions.type, 'array');
  assert.equal(PARAMETERS.questions.items.type, 'object');
  assert.equal(PARAMETERS.questions.items.additionalProperties, false);
  assert.deepEqual(
    Object.keys(PARAMETERS.questions.items.properties),
    ['name', 'type', 'instructions', 'criteria'],
  );

  // 类型枚举里绝不能出现 boolean（服务端只认 noul）；批量模式的 type 与它同源。
  assert.deepEqual(PARAMETERS.questions.items.properties.type.enum, ['choice', 'noul', 'score']);
  assert.deepEqual(PARAMETERS.type.enum, PARAMETERS.questions.items.properties.type.enum);

  // items 是自由数组：每项自带完整待判对象（D2），定位由 material 决定。
  assert.equal(PARAMETERS.items.type, 'array');

  // 批量模式的共享 criteria（choice 选项集 / score 档位）：**只写一次**，wire 层复制到每题。
  // 没有它，批量 choice/score 就没有选项集来源（ADR-15 的「调用方只写一次」）。
  assert.equal(PARAMETERS.criteria.oneOf.length, 2);
  assert.deepEqual(
    PARAMETERS.criteria.oneOf.map((branch) => branch.type),
    PARAMETERS.questions.items.properties.criteria.oneOf.map((branch) => branch.type),
    '与逐题 criteria 同形（复用同一批校验器）',
  );

  // criteria 用 oneOf 在本地挡住「对象还是数组」这一最常见误用。
  assert.equal(PARAMETERS.questions.items.properties.criteria.oneOf.length, 2);
});

test('描述里必须写明两模式互斥（items 与 questions 同时给出即报错）', () => {
  assert.match(TOOL_DESCRIPTION, /mutually exclusive/i);
  assert.match(TOOL_DESCRIPTION, /Giving both, or neither, is an error/);
});

test('skill 必须覆盖 material.tool（否则模型永远不知道能委托工具）且不得说 noul 不带 criteria', () => {
  assert.match(SKILL_BODY, /tool: \{ name, arguments\? \}/, 'skill 必须写明 material.tool 形态');
  assert.match(SKILL_BODY, /material\.spillPath/, 'skill 必须说明原始输出会落盘并回传 spillPath');
  assert.doesNotMatch(SKILL_BODY, /noul` takes none|`noul` takes none/, 'noul 接受 {false,true} 描述，不能再说「takes none」');
});

test('描述里必须点明 noul 不是布尔、confidence 不是正确率', () => {
  const text = `${TOOL_DESCRIPTION} ${SKILL_BODY} ${PARAMETERS.questions.items.properties.type.description}`;
  assert.match(text, /not a boolean|not `boolean`/);
  assert.match(text, /NOT accuracy/);
});

/**
 * §4.9 的九点使用指引**只**住在 `TOOL_DESCRIPTION` 里（ADR-5 不注册 prompt 段），所以描述被
 * 「顺手精简」时点会**静默消失** —— 本文件原先只钉住第 4、5 两点，另外七点删掉套件照样全绿。
 * 这里给每点配一个**判别性锚点**，三个口径：
 *   1. 只匹配 **shipped 描述本身**，不拼接参数 schema —— 参数里存在同义句（如
 *      `type.description` 的「not `boolean`」），拼接会让断言靠 schema 假绿。
 *   2. 锚点取**该点独有的语义指纹**，跨行用 `[\s\S]*` 而不是 `.*`（描述里有换行）。
 *   3. 一锚点一用例：删掉第 6/7/8 点时会**分别报红三条**，而不是只报第一条。
 */
const POINT_ANCHORS = [
  [1, '何时用：候选集已知有界，要的是概率不是文字', /routing, classification, filtering, relevance judgement and scoring/],
  [2, '何时不用：开放式生成 / 需要推理链', /Not for open-ended generation or problems needing a chain of reasoning/],
  [3, '一批多题：ONE call，绝不逐题循环', /in ONE call[\s\S]*Never loop one call per item/],
  [4, 'noul 返回布尔 value，P(true) 含 0.475 例子', /`noul` returns a BOOLEAN[\s\S]*probabilities\.true[\s\S]*0\.475[\s\S]*47\.5% chance of yes/],
  [5, 'confidence 是集中度不是正确率，低置信度读 probabilities 并升级', /\(1 - H\/ln N\); it is NOT accuracy[\s\S]*read `probabilities`[\s\S]*escalate[\s\S]*your own reasoning/],
  [6, '概率不是证据：不得当正确性证据、不得单独决定放行，需产物级证据', /PROBABILITIES, not proof[\s\S]*never let it be\s+the sole basis for a pass\/allow decision[\s\S]*artifact-level evidence[\s\S]*triage only/],
  [7, '不得决定路由、不得做 fail-open / fail-closed 判据', /must NOT decide routing[\s\S]*fail-open or fail-closed[\s\S]*deterministic rules/],
  [8, 'tev1 不产文本 ⇒ 需要可读判据时换生成类模型', /tev1 family returns only probabilities and never text[\s\S]*generative model/],
  [9, 'score 报在 0..N-1 尺度，不归一化', /0\.\.N-1 level scale, not normalised/],
  // 点 10 的锚点取「旗不过滤」的语义指纹（不带旧键名）：旧 SKILL 与新 SKILL（notes[] 措辞）都能命中。
  [10, '置信度告警是「旗」不是过滤器：被点名的才升级，未被点名不等于可信', /FLAG, not a\s+filter[\s\S]*NOT thereby endorsed/],
];

for (const [point, label, anchor] of POINT_ANCHORS) {
  test(`§4.9 点 ${point}：${label}`, () => {
    // 该点可以住在常驻 description，也可以住在按需加载的 skill 正文；但**必须住在其中一处**
    // ——否则模型要么每轮都为它付费，要么永远看不到它。
    assert.match(
      anchor.test(TOOL_DESCRIPTION) ? TOOL_DESCRIPTION : SKILL_BODY,
      anchor,
      `§4.9 第 ${point} 点（${label}）在 shipped TOOL_DESCRIPTION 里找不到锚点 ${anchor}`
        + ' —— 该点只能住在 description（ADR-5），删掉就等于永久丢失。',
    );
  });
}

/**
 * 权威键集 = 宿主投影出的配置 schema（`Config.dict`），**不是**在本文件里复述键名 ——
 * 复述一份就等于把「改代码要同步改这里」变成新的漂移点。
 * `schemastery` 的 `dict` 保持 `z.object({...})` 的书写顺序，故顺序也可作为断言。
 */
const AUTHORITATIVE_KEYS = [
  ...Object.keys(SharedConfig.dict ?? {}),
  ...Object.keys(DecisionConfig.dict ?? {}),
  ...Object.keys(MonitorConfig.dict ?? {}),
];

/** 配置表的识别锚点：表头行必须逐字命中它，且下一行是 Markdown 分隔行。 */
const TABLE_HEADER = '| Key | Default | Meaning |';

/** 对不齐时能直接改 README 的报错文本：文件名 + 期望的表头 + 缺/多/乱序三类差集。 */
function inconsistency(file, detail) {
  return `${file}: README 的 ## Configuration 表格键必须与 lib/configs.js 的三条 Config 投影一致`
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

test('注入预算守卫：常驻 description 与 skill 正文各自有上限，防止再长回去', () => {
  const descBytes = Buffer.byteLength(TOOL_DESCRIPTION, 'utf8');
  const skillBytes = Buffer.byteLength(SKILL_BODY, 'utf8');
  const schemaBytes = Buffer.byteLength(JSON.stringify(PARAMETERS), 'utf8');
  assert.ok(descBytes <= 1900, `常驻 description ${descBytes}B 超过 1900B：每轮注入的内容必须精打细算`);
  assert.ok(schemaBytes <= 3600, `参数 schema ${schemaBytes}B 超过 3600B：常驻 schema 才是注入成本的主体（压缩后 3402B）`);
  // 2026-10-18 用户裁定：skill 必须把功能写全 ⇒ 上限由 4000B 提到 8000B（按需加载，不在每轮注入里）。
  assert.ok(skillBytes <= 8000, `skill 正文 ${skillBytes}B 超过 8000B`);
});

test('能投影成 JSON Schema，且 required 只剩 material（模式必给性在校验层）', () => {
  const json = parameterSchemaSpecToJsonSchema(PARAMETERS);
  assert.equal(json.type, 'object');
  for (const key of ['material', 'rubric', 'items', 'questions', 'type', 'criteria', 'depth', 'model']) {
    assert.ok(json.properties[key], `缺少参数 ${key}`);
  }
  assert.deepEqual(json.required, ['material'],
    'depth 可选（缺省 normal）；模式内的必给字段由 assertModeExclusive 把关');
});

test('skill 必须写全两个工具的**全部参数名与 source.kind**（用户裁定：功能写全）', async () => {
  const { PARAMETERS: DECISION_PARAMS } = await import('../lib/parameters.js');
  const { PARAMETERS: MONITOR_PARAMS } = await import('../lib/monitor-tool.js');
  const { EVENT_TYPES } = await import('../lib/event-log.js');
  const body = SKILL_BODY;
  const missing = [];
  for (const key of Object.keys(DECISION_PARAMS)) if (!body.includes('`' + key + '`')) missing.push('decision.' + key);
  for (const key of Object.keys(MONITOR_PARAMS)) if (!body.includes('`' + key + '`')) missing.push('monitor.' + key);
  for (const kind of ['job', 'file', 'glob', 'command', 'events']) if (!body.includes('`' + kind + '`')) missing.push('source.kind=' + kind);
  for (const type of EVENT_TYPES) if (!body.includes(type)) missing.push('event:' + type);
  assert.deepEqual(missing, [], 'skill 未写明这些功能：' + JSON.stringify(missing));
  assert.match(body, /emptySource/, '空源短路必须写明');
  assert.match(body, /job_output/, '后台结果读取方式必须写明');
});
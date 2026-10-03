# dsh-decision-tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把本机 Ollama 的 System One 决策能力（`POST /v1/systemone`）注册成 DSH 的一个模型可见工具 `decision`，一次调用可问 1–64 道 `choice`/`noul`/`score` 混合题并共享同一 `state`。

**Architecture:** 纯 JS 免构建的 Cordis 插件（照搬 `G:\LAB\202608\dsh-win-multi-bash` 形态）。核心逻辑按「与 harness 无关」与「接触 ctx」切分：`parameters.js`/`validate.js`/`render.js`/`client.js` 四个模块零 DSH 依赖（前三个零依赖，`client.js` 只用 `fetch`/`AbortSignal` 标准 API），只有 `tool.js` 接触 `ctx`。这样绝大部分逻辑可以用 `node:test` 独立测，且将来做 CLI 或评测装置可直接复用。**不注册 prompt 段**（ADR-5）：使用指引全部在工具 description 里，`inject` 只需 `tools`。

**Tech Stack:** Node.js 22（`node:test`、`node:http`、内建 `fetch`/`AbortSignal`）；`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/schemastery`（`Config`）、`@deepseek-ai/cordis`（插件宿主）——三者均为 **peerDependencies**，运行时由宿主提供，开发期用软链接入。零新增第三方依赖。

**Spec:** `docs/superpowers/specs/2026-10-04-dsh-decision-tools-design.md`

## Global Constraints

- **零新增第三方依赖。** 测试只用 `node:test` + `node:assert/strict` + `node:http`；不引入 tsup/vitest/jest/eslint。
- **构建策略 = 纯 JS 免构建**（ADR-1）。`lib/*.js` 直接手写 ESM，无编译步骤。`package.json` 必须 `"type": "module"`。
- **文本文件统一 LF。** 仓库根已有 `.gitattributes`（`* text=auto eol=lf` + 二进制例外）。每写一批文件后按**真实 CR 字节计数**验证（`tr -cd '\r' < f | wc -c` 必须为 0），不得靠 grep 目视。
- **打包白名单**（用户 2026-10-04 跨项目裁定）：`files` 只含 `lib/**/*.js`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`LICENSE`、`THIRD_PARTY_NOTICES`。`test/`、`smoke/`、`scripts/`、`docs/`、`.temp/` **一律不入包**。
- **临时/探测产物写 `.temp/`**（已 gitignore），不入库。
- **服务端硬限**：无图请求体 ≤ **65536 字节**；`questions` **1–64**；`choice`/`score` 候选项 **2–26**；问题类型只有 `choice`、`noul`、`score`（**没有** `boolean`）。
- **默认配置值**：`baseUrl='http://localhost:11434'`、`defaultModel='tev1:0.8b'`、`timeoutMs=120000`、`toolName='decision'`、`keepAlive` 未设。
- **已验证的宿主事实**（不得凭记忆改写）：DSH profile = `web`；`@deepseek-ai/dsh-tools@0.2.0-rc.2`；本插件 `inject` 只需 `['tools']`；`defineTool` 的参数与输出都用**紧凑 DSL**（`ValueSchemaSpec`/`ParameterSchemaSpec`），**不是**裸 JSON Schema；**宿主用 `output.schema` 对每个成功返回值强校验**；参数由注册表 `validateArgs` 强校验；`object` 节点**必须**写 `additionalProperties`；`oneOf` **至少 2 个分支**；`required: true` 是**逐属性**注解；该 DSL **没有** `minItems`/`maxProperties` 类关键字；`ContentBlock` 形状是 `{ type: 'text', text: string }`。
- **不注册 prompt 段**（ADR-5）：`SECTION_ORDERS` 的 32 个具名槽位全部被第一方占用，没有留给第三方工具的槽位；`getSectionOrder(name)` 对未注册名返回 `undefined`，会被 `section()` 的 finite 检查抛错；`section()` 去重键是 `name` 而非 `order`，故裸魔数不会被拦住（这正是必须避免它的原因）。全部指引写进 `TOOL_DESCRIPTION`。
- **宿主会对返回值强校验**：`defineTool` 的 `output.schema` 是「每一个成功返回值都要被它校验通过的」schema，写窄了会让正常返回变成工具失败。
- **测试命令固定为** `node --test "test/*.test.mjs"`。**不要**用 `node --test test/` —— 在 Node 22.22.1 上它会把 `test/` 当模块路径去 `require`，报 `MODULE_NOT_FOUND`。
- **不得在 Node 里用 `child_process` 抓子进程输出**（本机沙箱下管道 stdio 会 EPERM）。需要发现路径时用 `process.execPath` 推导。

---

## File Structure

| 文件 | 职责 | 依赖 |
|---|---|---|
| `package.json` | 包元信息、`files` 白名单、peerDeps、`dsh.bundle.patch` | — |
| `cordis.patch.yml` | 把插件行插进 composition | — |
| `lib/parameters.js` | 工具的模型可见契约：描述（含全部使用指引）+ 参数 schema（纯数据，零 import） | 无 |
| `lib/validate.js` | 语义前置校验 + 组装请求体（DSL 表达不了的限制都在这里） | 无 |
| `lib/render.js` | `answers` → 紧凑逐行文本 | 无 |
| `lib/client.js` | HTTP 调用、超时/取消、错误映射 | 无（只用标准 API） |
| `lib/tool.js` | `defineTool` 装配 + `apply()` | dsh-tools, schemastery |
| `lib/index.js` | 转出 `name/inject/Config/apply` | tool.js |
| `scripts/link-peers.mjs` | 开发期把宿主 peer 包软链进 `node_modules/`（零网络） | 无 |
| `test/fake-ollama.mjs` | `node:http` 可编程假服务 | 无 |
| `test/{validate,render,client,parameters,tool}.test.mjs` | 单元测试 | 视文件而定 |
| `smoke/live.mjs` | 真机冒烟（不进 CI、不入包） | 无 |
| `README.md` / `README.zh.md` | 用法、配置、限制 | — |
| `LICENSE` / `THIRD_PARTY_NOTICES` | MIT + 第三方声明 | — |

---

## Task 1: 开发环境接入 + 本地校验层

本地校验是整个插件的主要价值（把服务端的 400/413 变成模型能据此改正的错误），且它是纯函数，先从它开始。同时把「测试能解析宿主包」这件事一次性解决。

**Files:**
- Create: `scripts/link-peers.mjs`
- Create: `package.json`
- Create: `lib/validate.js`
- Test: `test/validate.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `LIMITS` = `{ maxQuestions: 64, minOptions: 2, maxOptions: 26, maxBodyBytes: 65536 }`
  - `class DecisionValidationError extends Error` —— 带 `name='DecisionValidationError'`、`kind='invalid_request'`
  - `prepareRequest({ state, questions, model, defaultModel, keepAlive }) → body`，`body = { model, state, questions, keep_alive? }`；违反任一条目时抛 `DecisionValidationError`

- [ ] **Step 1: 写开发期 peer 软链脚本**

创建 `scripts/link-peers.mjs`：

```js
#!/usr/bin/env node
/**
 * 把 DSH 自带的 peer 包软链进本仓库的 node_modules/，让 `node --test` 能解析
 * `@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery`。
 *
 * 为什么需要：本插件声明的是 peerDependencies（运行时由宿主提供），仓库里不装它们；
 * 但测试要 import 这些包，而 ESM 只认 node_modules 解析。软链是零网络、零新增依赖的做法。
 *
 * 用法：node scripts/link-peers.mjs [--from <dsh 包目录>]
 * 发现顺序：--from → $DSH_PKG_ROOT → dirname(process.execPath)/node_modules/@deepseek-ai/dsh
 * （末项即本机 Node 的全局安装位置；实测它与 nvm 那份 dsh 是同一个目录。）
 *
 * 注意：不使用 child_process —— 本机沙箱下抓子进程输出会 EPERM。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PEERS = ['dsh-tools', 'schemastery', 'cordis'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveDshRoot() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--from');
  if (flag !== -1 && argv[flag + 1]) return path.resolve(argv[flag + 1]);
  if (process.env.DSH_PKG_ROOT) return path.resolve(process.env.DSH_PKG_ROOT);
  return path.join(path.dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh');
}

const dshRoot = resolveDshRoot();
const peersDir = path.join(dshRoot, 'node_modules', '@deepseek-ai');
if (!fs.existsSync(peersDir)) {
  console.error(`找不到 DSH 的 peer 包目录：\n  ${peersDir}`);
  console.error('请用 --from 指定 dsh 包目录，例如：');
  console.error('  node scripts/link-peers.mjs --from "<...>/node_modules/@deepseek-ai/dsh"');
  process.exit(1);
}

const target = path.join(repoRoot, 'node_modules', '@deepseek-ai');
fs.mkdirSync(target, { recursive: true });

let linked = 0;
for (const peer of PEERS) {
  const source = path.join(peersDir, peer);
  if (!fs.existsSync(source)) {
    console.warn(`跳过（该 DSH 安装里没有）：${peer}`);
    continue;
  }
  const link = path.join(target, peer);
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(source, link, 'junction');
  console.log(`linked ${peer} -> ${source}`);
  linked += 1;
}
console.log(`\n完成：${linked} 个 peer 已接入 ${target}`);
```

- [ ] **Step 2: 运行它并确认解析成功**

```bash
cd /f/Dinosaur_MC/Studio/Project/dsh-decision-tools
node scripts/link-peers.mjs
node --input-type=module -e "import {defineTool,parameterSchemaSpecToJsonSchema} from '@deepseek-ai/dsh-tools'; import z from '@deepseek-ai/schemastery'; console.log('ok', typeof defineTool, typeof parameterSchemaSpecToJsonSchema, typeof z.union)"
```

Expected: 打印三行 `linked ...` 与 `完成：3 个 peer ...`，最后一行 `ok function function function`。
若报 `找不到 DSH 的 peer 包目录`，改用 `--from "D:\Program Files\nodejs\node_modules\@deepseek-ai\dsh"` 重试。

- [ ] **Step 3: 写 `package.json`**

（`dsh` 字段留到 Task 5 再加 —— `cordis.patch.yml` 那时才存在。）

```json
{
  "name": "dsh-decision-tools",
  "version": "0.1.0",
  "description": "DSH agent tool for local Ollama System One decision models: classify, answer yes/no, and score against a rubric in one batched request.",
  "keywords": ["dsh-plugin", "ollama", "decision", "system-one", "classification", "reranking"],
  "license": "MIT",
  "author": "Dinosaur_MC",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "files": [
    "lib/**/*.js",
    "cordis.patch.yml",
    "README.md",
    "README.zh.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES"
  ],
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  },
  "scripts": {
    "test": "node --test \"test/*.test.mjs\"",
    "link-peers": "node scripts/link-peers.mjs"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.1",
    "@deepseek-ai/dsh-tools": ">=0.2.0-rc.2",
    "@deepseek-ai/schemastery": ">=3.18.0"
  },
  "peerDependenciesMeta": {
    "@deepseek-ai/cordis": { "optional": true },
    "@deepseek-ai/dsh-tools": { "optional": true },
    "@deepseek-ai/schemastery": { "optional": true }
  }
}
```

- [ ] **Step 4: 写失败的测试**

创建 `test/validate.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest, DecisionValidationError, LIMITS } from '../lib/validate.js';

const TICKET = 'Our checkout has returned 500 errors since 9am.';
const CHOICE_Q = {
  name: 'label',
  type: 'choice',
  instructions: 'Which label fits this ticket?',
  criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
};

/** 一个最小合法请求。 */
function base(overrides = {}) {
  return {
    state: TICKET,
    questions: [CHOICE_Q],
    defaultModel: 'tev1:0.8b',
    ...overrides,
  };
}

/** 断言被拒，并且消息里含指定模式。 */
function expectReject(args, matcher) {
  assert.throws(() => prepareRequest(args), (error) => {
    assert.ok(
      error instanceof DecisionValidationError,
      `期望 DecisionValidationError，实际得到 ${error?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, 'invalid_request');
    assert.match(error.message, matcher);
    return true;
  });
}

test('合法请求返回 body，且只带服务端认识的字段', () => {
  assert.deepEqual(prepareRequest(base()), {
    model: 'tev1:0.8b',
    state: TICKET,
    questions: { label: CHOICE_Q },
  });
});

test('V10 线格式：questions 被转成「题名 → 问题对象」的映射，不是数组（ADR-6）', () => {
  // 本机实测：数组形状被服务端在**解析阶段**拒绝（HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"，0.071s 返回），
  // 对象形状才 200。这条用例是那个真机事实在本地套件里的落点。
  const body = prepareRequest(base({
    questions: [
      { name: 'a', type: 'noul', instructions: 'First?' },
      { name: 'b', type: 'noul', instructions: 'Second?' },
    ],
  }));
  assert.equal(Array.isArray(body.questions), false, 'questions 不能是数组');
  assert.equal(typeof body.questions, 'object');
  assert.deepEqual(Object.keys(body.questions), ['a', 'b'], '键为题名，且保持模型给的顺序');
  assert.equal(body.questions.a.instructions, 'First?');
  assert.equal(body.questions.b.instructions, 'Second?');
});

test('model 参数覆盖 defaultModel；keepAlive 存在时下发 keep_alive', () => {
  assert.equal(prepareRequest(base({ model: 'tev1:latest' })).model, 'tev1:latest');
  assert.equal(prepareRequest(base({ keepAlive: '5m' })).keep_alive, '5m');
  assert.equal('keep_alive' in prepareRequest(base()), false);
});

test('V9 model 必须是非空字符串', () => {
  expectReject(base({ defaultModel: undefined }), /model 必须是非空字符串/);
  expectReject(base({ model: '' }), /model 必须是非空字符串/);
});

test('state 接受字符串/对象/数组，拒绝空串与标量', () => {
  assert.doesNotThrow(() => prepareRequest(base({ state: { ticket: TICKET } })));
  assert.doesNotThrow(() => prepareRequest(base({ state: [{ id: 1 }] })));
  expectReject(base({ state: '   ' }), /state 不能是空字符串/);
  expectReject(base({ state: 42 }), /state 必须是字符串、对象或数组/);
});

test('V1 questions 数量 1–64，且必须是数组', () => {
  const noul = (i) => ({ name: `q${i}`, type: 'noul', instructions: 'Is this English?' });
  assert.doesNotThrow(() => prepareRequest(base({ questions: Array.from({ length: 64 }, (_, i) => noul(i)) })));
  expectReject(base({ questions: Array.from({ length: 65 }, (_, i) => noul(i)) }), /questions 有 65 题/);
  expectReject(base({ questions: [] }), /questions 有 0 题/);
  expectReject(base({ questions: 'nope' }), /questions 必须是数组/);
});

test('V2 问题名必须非空且唯一', () => {
  expectReject(
    base({ questions: [CHOICE_Q, { ...CHOICE_Q }] }),
    /问题名重复：\"label\"/,
  );
  expectReject(
    base({ questions: [{ name: '  ', type: 'noul', instructions: 'x' }] }),
    /name 必须是非空字符串/,
  );
});

test('V3 类型只接受 choice / noul / score', () => {
  expectReject(
    base({ questions: [{ name: 'a', type: 'boolean', instructions: 'x' }] }),
    /合法值只有 choice、noul、score/,
  );
});

test('V4 choice 选项数 2–26，且必须是对象', () => {
  const opts = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, `desc ${i}`]));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ ...CHOICE_Q, criteria: opts(26) }] })));
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(1) }] }), /有 1 个选项，合法范围 2–26/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: opts(27) }] }), /有 27 个选项，合法范围 2–26/);
  expectReject(base({ questions: [{ ...CHOICE_Q, criteria: ['a', 'b'] }] }), /必须是「选项名 → 描述」的对象/);
});

test('V5/V6 score 必须是由低到高的字符串数组，长度 2–26', () => {
  const score = (criteria) => ({ name: 's', type: 'score', instructions: 'How urgent?', criteria });
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(['low', 'high'])] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [score(Array.from({ length: 26 }, (_, i) => `lv${i}`))] })));
  expectReject(base({ questions: [score(['only'])] }), /有 1 档，合法范围 2–26/);
  expectReject(base({ questions: [score(Array.from({ length: 27 }, (_, i) => `lv${i}`))] }), /有 27 档，合法范围 2–26/);
  expectReject(base({ questions: [score({ 0: 'low', 1: 'high' })] }), /必须是由低到高排列的字符串数组/);
  expectReject(base({ questions: [score(['low', '  '])] }), /criteria\[1\]（score）必须是非空字符串/);
});

test('V7 noul 的 criteria 只接受 false/true 键，或整体省略', () => {
  const noul = (criteria) => ({ name: 'n', type: 'noul', instructions: 'Is it?', ...(criteria === undefined ? {} : { criteria }) });
  assert.doesNotThrow(() => prepareRequest(base({ questions: [noul()] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [noul({ false: 'No', true: 'Yes' })] })));
  expectReject(base({ questions: [noul({ no: 'No', yes: 'Yes' })] }), /只接受 "false" 和 "true" 两个键/);
  expectReject(base({ questions: [noul(['No', 'Yes'])] }), /只能是 \{"false"/);
});

test('instructions 必填', () => {
  expectReject(base({ questions: [{ name: 'x', type: 'noul' }] }), /instructions 必填/);
});

test('V8 边界：正好 65536 字节通过，再多 1 字节被拒', () => {
  // 与 prepareRequest 组装出的 body 逐字段一致，才能精确落在边界上。
  // 注意 questions 必须是 V10 转换后的**对象映射**形状 —— 用数组会让这个 helper
  // 与真实 body 长度不同，二分会落在错的边界上（该测试本就用于探测 body 形状漂移）。
  const overhead = (n) => Buffer.byteLength(JSON.stringify({
    model: 'tev1:0.8b',
    state: 'x'.repeat(n),
    questions: { label: CHOICE_Q },
  }), 'utf8');

  let lo = 0;
  let hi = 70000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (overhead(mid) <= LIMITS.maxBodyBytes) lo = mid;
    else hi = mid - 1;
  }
  assert.ok(overhead(lo) <= LIMITS.maxBodyBytes);
  assert.ok(overhead(lo + 1) > LIMITS.maxBodyBytes);

  assert.doesNotThrow(() => prepareRequest(base({ state: 'x'.repeat(lo) })));
  expectReject(base({ state: 'x'.repeat(lo + 1) }), /请求体 \d+ 字节，超过服务端上限 65536 字节（64 KiB）；请缩减 state/);
});

test('LIMITS 与服务端文档一致', () => {
  assert.deepEqual(LIMITS, { maxQuestions: 64, minOptions: 2, maxOptions: 26, maxBodyBytes: 65536 });
});
```

- [ ] **Step 5: 运行测试确认失败**

```bash
node --test "test/*.test.mjs"
```

Expected: FAIL —— `Cannot find module '.../lib/validate.js'`。

- [ ] **Step 6: 写实现**

创建 `lib/validate.js`：

```js
/**
 * 本地前置校验与请求体组装。
 *
 * 存在的理由：DSH 的紧凑 schema DSL 只有 type/enum/const，表达不了
 * 「1–64 题」「2–26 个选项」「问题名唯一」「请求体 ≤ 64 KiB」这些限制；
 * 而服务端的原始报错（例如 `question "urgent": type must be choice, noul, or score`）
 * 虽然准确，却不含合法值清单，模型容易重犯。这里把它们变成本地可行动的报错。
 *
 * 纯函数，无 DSH 依赖，便于独立测试与复用。
 * @module dsh-decision-tools/validate
 */

export const LIMITS = {
  maxQuestions: 64,
  minOptions: 2,
  maxOptions: 26,
  maxBodyBytes: 65536,
};

const QUESTION_TYPES = new Set(['choice', 'noul', 'score']);

/** 输入不合法。消息一律写成「哪里错 + 合法范围 + 怎么改」。 */
export class DecisionValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DecisionValidationError';
    this.kind = 'invalid_request';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '数组';
  if (typeof value === 'object') return '对象';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function validateModel(requested, fallback) {
  const resolved = requested === undefined ? fallback : requested;
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    throw new DecisionValidationError(
      `model 必须是非空字符串（收到 ${JSON.stringify(resolved)}）；`
      + '请在参数里传 model，或在插件配置里设 defaultModel。',
    );
  }
  return resolved;
}

function validateState(state) {
  if (typeof state === 'string') {
    if (state.trim() === '') {
      throw new DecisionValidationError('state 不能是空字符串；它是所有问题共享的待判定材料。');
    }
    return;
  }
  if (isPlainObject(state) || Array.isArray(state)) return;
  throw new DecisionValidationError(
    `state 必须是字符串、对象或数组（收到 ${describe(state)}）。`,
  );
}

function validateChoice(at, criteria) {
  if (!isPlainObject(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（choice）必须是「选项名 → 描述」的对象，`
      + '例如 {"billing":"Payments and refunds","bug":"Software errors"}。',
    );
  }
  const keys = Object.keys(criteria);
  if (keys.length < LIMITS.minOptions || keys.length > LIMITS.maxOptions) {
    throw new DecisionValidationError(
      `${at}.criteria（choice）有 ${keys.length} 个选项，合法范围 ${LIMITS.minOptions}–${LIMITS.maxOptions}。`,
    );
  }
  for (const key of keys) {
    if (key.trim() === '') {
      throw new DecisionValidationError(`${at}.criteria（choice）的选项名不能为空白。`);
    }
  }
}

function validateScore(at, criteria) {
  if (!Array.isArray(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（score）必须是由低到高排列的字符串数组，`
      + '例如 ["Routine: no time pressure","Soon: a customer is inconvenienced","Immediate: a critical service is unavailable"]。',
    );
  }
  if (criteria.length < LIMITS.minOptions || criteria.length > LIMITS.maxOptions) {
    throw new DecisionValidationError(
      `${at}.criteria（score）有 ${criteria.length} 档，合法范围 ${LIMITS.minOptions}–${LIMITS.maxOptions}。`,
    );
  }
  for (const [index, entry] of criteria.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new DecisionValidationError(`${at}.criteria[${index}]（score）必须是非空字符串。`);
    }
  }
}

function validateNoul(at, criteria) {
  if (criteria === undefined) return;
  if (!isPlainObject(criteria)) {
    throw new DecisionValidationError(
      `${at}.criteria（noul）只能是 {"false": "...", "true": "..."} 这样的对象，或整体省略。`,
    );
  }
  for (const key of Object.keys(criteria)) {
    if (key !== 'false' && key !== 'true') {
      throw new DecisionValidationError(
        `${at}.criteria（noul）只接受 "false" 和 "true" 两个键（收到 ${JSON.stringify(key)}）；或整体省略。`,
      );
    }
  }
}

function validateQuestion(at, question, seenNames) {
  if (!isPlainObject(question)) {
    throw new DecisionValidationError(`${at} 必须是对象（收到 ${describe(question)}）。`);
  }
  if (typeof question.name !== 'string' || question.name.trim() === '') {
    throw new DecisionValidationError(`${at}.name 必须是非空字符串；答案以它为键返回。`);
  }
  if (seenNames.has(question.name)) {
    throw new DecisionValidationError(
      `问题名重复：${JSON.stringify(question.name)}；每题 name 必须唯一，否则无法区分答案。`,
    );
  }
  seenNames.add(question.name);

  if (!QUESTION_TYPES.has(question.type)) {
    throw new DecisionValidationError(
      `${at}.type 是 ${JSON.stringify(question.type)}，不支持；合法值只有 choice、noul、score。`,
    );
  }
  if (question.instructions === undefined) {
    throw new DecisionValidationError(`${at}.instructions 必填（问题要问什么）。`);
  }

  if (question.type === 'choice') validateChoice(at, question.criteria);
  else if (question.type === 'score') validateScore(at, question.criteria);
  else validateNoul(at, question.criteria);
}

/**
 * 校验一次 decision 调用并组装发往 `/v1/systemone` 的请求体。
 * @param {{ state: unknown, questions: unknown, model?: string, defaultModel?: string, keepAlive?: string|number }} input
 * @returns {{ model: string, state: unknown, questions: Record<string, { type: string, instructions: string, criteria?: unknown }>, keep_alive?: string|number }}
 * @throws {DecisionValidationError} 任一条目不合规时
 */
export function prepareRequest({ state, questions, model, defaultModel, keepAlive }) {
  const resolvedModel = validateModel(model, defaultModel);
  validateState(state);

  if (!Array.isArray(questions)) {
    throw new DecisionValidationError(`questions 必须是数组（收到 ${describe(questions)}）。`);
  }
  if (questions.length < 1 || questions.length > LIMITS.maxQuestions) {
    throw new DecisionValidationError(
      `questions 有 ${questions.length} 题，合法范围 1–${LIMITS.maxQuestions}；请拆分为多次调用。`,
    );
  }
  const seenNames = new Set();
  for (const [index, question] of questions.entries()) {
    validateQuestion(`questions[${index}]`, question, seenNames);
  }

  // V10（ADR-6）：工具面对模型是**有序数组**，而线格式必须是**对象映射**。
  // 本机实测数组形状会被服务端在解析阶段拒绝（HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"，0.071s 返回），
  // 对象形状才 200。这一步转换是 ADR-2（工具面用数组）的必然代价。
  // 题名唯一（V2）正是这个映射有定义的前提 —— 重名会让后一个静默覆盖前一个。
  // 64 KiB 必须按转换后的真实线格式度量，故 V8 在下面按 body 量。
  const questionsByName = Object.fromEntries(
    questions.map((question) => [question.name, question]),
  );
  const body = { model: resolvedModel, state, questions: questionsByName };
  if (keepAlive !== undefined) body.keep_alive = keepAlive;

  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > LIMITS.maxBodyBytes) {
    throw new DecisionValidationError(
      `请求体 ${bytes} 字节，超过服务端上限 ${LIMITS.maxBodyBytes} 字节（64 KiB）；`
      + `请缩减 state，或把这 ${questions.length} 题拆成多次调用。`,
    );
  }
  return body;
}
```

- [ ] **Step 7: 运行测试确认通过**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 14 个 test。

- [ ] **Step 8: 语法检查与 LF 校验**

```bash
node --check lib/validate.js && node --check scripts/link-peers.mjs
for f in package.json lib/validate.js test/validate.test.mjs scripts/link-peers.mjs; do
  printf "%-34s CR=%s\n" "$f" "$(tr -cd '\r' < "$f" | wc -c)"
done
```

Expected: 无输出即语法 OK；每个文件 `CR=0`。

- [ ] **Step 9: 提交**

```bash
git add package.json lib/validate.js test/validate.test.mjs scripts/link-peers.mjs
git commit -F - <<'MSG'
feat(validate): 本地前置校验与请求体组装

DSH 的紧凑 schema DSL 只有 type/enum/const，表达不了 1-64 题、2-26 个选项、
问题名唯一、请求体 <= 64 KiB 这些服务端限制。把这些校验放在本地，是为了给出
"哪里错 + 合法范围 + 怎么改" 的报错，而不是把 Ollama 的 400/413 原样甩给模型。

同时加入开发期 peer 软链脚本（零网络、零新增依赖）：插件声明的是 peerDependencies，
运行时由宿主提供，但测试要 import 这些包，ESM 只认 node_modules 解析。

新增 scripts/link-peers.mjs（从 process.execPath 推导 dsh 位置，不使用 child_process）
新增 lib/validate.js（prepareRequest / DecisionValidationError / LIMITS）
新增 test/validate.test.mjs（14 个用例，含 V10 线格式映射与 64 KiB 边界二分）
新增 package.json（type=module、files 白名单、peerDeps）
MSG
```

---

## Task 2: 结果渲染层

**Files:**
- Create: `lib/render.js`
- Test: `test/render.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `renderAnswers(args, value) → ContentBlock[]`，其中 `value = { model, answers, usage? }`；返回 `[{ type: 'text', text }]`

- [ ] **Step 1: 写失败的测试**

创建 `test/render.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAnswers } from '../lib/render.js';

/** 取出渲染出的纯文本。 */
function textOf(value) {
  const blocks = renderAnswers({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(typeof blocks[0].text, 'string');
  return blocks[0].text;
}

const USAGE = { input_tokens: 799, output_tokens: 4 };

test('choice：给出结论、降序概率与 confidence', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      label: {
        type: 'choice',
        choice: 'bug',
        probabilities: { billing: 0.0063, bug: 0.9593, account: 0.0343 },
        confidence: 0.8292,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^label\s+choice\s+bug\s+p=\{bug=0\.9593, account=0\.0343, billing=0\.0063\}\s+conf=0\.829$/m);
  assert.match(text, /usage: input_tokens=799 output_tokens=4/);
});

test('noul：渲染成 P(true) 数值而不是布尔字面量', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: { refund: { type: 'noul', noul: 0.47510873373302426 } },
    usage: USAGE,
  });
  // 整行逐字比对：既能证明保留了 4 位小数，也能证明没有退化成 true/false。
  assert.equal(text.split('\n')[0], 'refund  noul    P(true)=0.4751');
});

test('score：显示 x / (N-1)，概率按档位下标降序', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      urgency: {
        type: 'score',
        score: 1.1542321654504228,
        legend: { 0: 'Routine', 1: 'Soon', 2: 'Immediate' },
        probabilities: { 0: 0.0691, 1: 0.7075, 2: 0.2234 },
        confidence: 0.3043,
      },
    },
    usage: USAGE,
  });
  assert.match(text, /^urgency\s+score\s+1\.1542 \/ 2\s+p=\{1=0\.7075, 2=0\.2234, 0=0\.0691\}\s+conf=0\.304$/m);
});

test('多题：每题一行，名字按最长者对齐', () => {
  const text = textOf({
    model: 'tev1:0.8b',
    answers: {
      a: { type: 'noul', noul: 0.5 },
      longer: { type: 'noul', noul: 0.25 },
    },
    usage: USAGE,
  });
  const lines = text.split('\n');
  assert.equal(lines[0], 'a       noul    P(true)=0.5000');
  assert.equal(lines[1], 'longer  noul    P(true)=0.2500');
});

test('没有 usage 时不渲染 usage 行', () => {
  const text = textOf({ model: 'tev1:0.8b', answers: { q: { type: 'noul', noul: 1 } } });
  assert.equal(text, 'q  noul    P(true)=1.0000');
});

test('未知答案类型不炸，退化为 JSON', () => {
  const text = textOf({ model: 'm', answers: { q: { type: 'mystery', value: 1 } } });
  assert.match(text, /q\s+mystery/);
  assert.match(text, /"value":1/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test "test/*.test.mjs"
```

Expected: FAIL —— `Cannot find module '.../lib/render.js'`。

- [ ] **Step 3: 写实现**

创建 `lib/render.js`：

```js
/**
 * 把 System One 的 `answers` 渲染成模型可读的紧凑文本。
 *
 * 为什么不做成 JSON：模型读逐行文本比读嵌套 JSON 更省 token 也更不易误读；
 * 概率按降序排列，让「次优选项」可见 —— 低 confidence 时的决策依据正是分布本身，
 * 而不是那个被选中的结论。完整原始值仍可通过 output.schema 取到。
 *
 * 纯函数，只产出 `{ type: 'text', text }` 形状，无 DSH 依赖。
 * @module dsh-decision-tools/render
 */

/** 概率按降序排成 `k=0.1234`，四位小数足够分辨。 */
function formatProbabilities(probabilities) {
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => right - left)
    .map(([key, value]) => `${key}=${value.toFixed(4)}`)
    .join(', ');
}

function formatAnswer(name, width, answer) {
  const label = name.padEnd(width);
  switch (answer?.type) {
    case 'choice':
      return `${label}  choice  ${answer.choice}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${answer.confidence.toFixed(3)}`;
    case 'noul':
      // 显式写成 P(true)：这个值是概率，不是布尔，措辞必须让模型无法误读。
      return `${label}  noul    P(true)=${answer.noul.toFixed(4)}`;
    case 'score': {
      const topLevel = Object.keys(answer.probabilities).length - 1;
      return `${label}  score   ${answer.score.toFixed(4)} / ${topLevel}  `
        + `p={${formatProbabilities(answer.probabilities)}}  conf=${answer.confidence.toFixed(3)}`;
    }
    default:
      return `${label}  ${answer?.type ?? 'unknown'}  ${JSON.stringify(answer)}`;
  }
}

/**
 * `output.render` 的实现。
 * @param {unknown} _args 调用参数（不参与渲染）
 * @param {{ model: string, answers: Record<string, any>, usage?: { input_tokens: number, output_tokens: number } }} value 已校验的规范返回值
 * @returns {{ type: 'text', text: string }[]}
 */
export function renderAnswers(_args, value) {
  const answers = value?.answers ?? {};
  const names = Object.keys(answers);
  const width = names.reduce((max, name) => Math.max(max, name.length), 0);

  const lines = names.map((name) => formatAnswer(name, width, answers[name]));
  if (value?.usage) {
    lines.push(`(usage: input_tokens=${value.usage.input_tokens} output_tokens=${value.usage.output_tokens})`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 20 个 test（14 + 6：validate + render）。

- [ ] **Step 5: 语法与 LF 校验**

```bash
node --check lib/render.js
for f in lib/render.js test/render.test.mjs; do printf "%-30s CR=%s\n" "$f" "$(tr -cd '\r' < "$f" | wc -c)"; done
```

Expected: 每个 `CR=0`。

- [ ] **Step 6: 提交**

```bash
git add lib/render.js test/render.test.mjs
git commit -F - <<'MSG'
feat(render): answers 渲染成紧凑逐行文本

模型读逐行文本比读嵌套 JSON 更省 token 也更不易误读。概率按降序排列，
让次优选项可见 —— confidence 低时的决策依据是分布本身，不是被选中的结论。

noul 显式渲染成 P(true)=x 而非布尔字面量，避免模型把它当确定结论。

新增 lib/render.js（renderAnswers）
新增 test/render.test.mjs（6 个用例，含多题对齐与未知类型退化）
MSG
```

---

## Task 3: System One 客户端

**Files:**
- Create: `test/fake-ollama.mjs`
- Create: `lib/client.js`
- Test: `test/client.test.mjs`

**Interfaces:**
- Consumes: 无（`body` 由 Task 1 的 `prepareRequest` 产出，但本模块不 import 它）
- Produces:
  - `class SystemOneError extends Error` —— 带 `kind`、`status?`、`hint?`
  - `callSystemOne({ baseUrl, body, timeoutMs, signal, fetchImpl }) → Promise<{ model, answers, usage }>`
  - `kind` 取值集合：`'unreachable' | 'timeout' | 'aborted' | 'transport' | 'model_missing' | 'too_large' | 'invalid_request' | 'model_broken' | 'server_error' | 'http_error' | 'bad_response'`

- [ ] **Step 1: 写假服务**

创建 `test/fake-ollama.mjs`：

```js
/**
 * 可编程的假 Ollama，只用于测试（不入包）。
 * 记录收到的每个请求体，便于断言「校验失败时不该发出网络请求」这类性质。
 * @module dsh-decision-tools/test/fake-ollama
 */
import http from 'node:http';

/**
 * @param {(request: { method: string, url: string, raw: string, json: unknown }) => { status?: number, body?: unknown, hang?: boolean, truncate?: boolean } | 'destroy'} handler
 */
export async function startFakeOllama(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json;
      try { json = JSON.parse(raw); } catch { json = undefined; }
      const record = { method: req.method, url: req.url, raw, json };
      requests.push(record);

      // 线格式契约守卫（ADR-6）：真实服务端要求 questions 是「题名 → 问题对象」的
      // 映射，数组会在**解析阶段**被拒（本机实测 HTTP 400
      // "Value looks like object, but can't find closing '}' symbol"）。
      // 假服务照做 —— 否则整套本地测试在结构上无法发现这类线格式违规，
      // 而"本地全绿 + 真机全挂"正是这个缺陷第一次溜过去的原因。
      if (json !== undefined && json.questions !== undefined
        && (json.questions === null || typeof json.questions !== 'object' || Array.isArray(json.questions))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: "Value looks like object, but can't find closing '}' symbol" }));
        return;
      }

      const reply = handler(record);
      if (reply === 'destroy') { req.socket.destroy(); return; }
      if (reply.hang) return; // 永不响应：用于测超时与取消
      if (reply.truncate) {
        // 先发响应头与半个 body，等数据真正刷出后再掐断 socket —— 于是客户端是在
        // **读 body** 时失败（undici 抛 TypeError: terminated），而不是在 fetch 阶段
        // 失败。这正是「body 读取也必须被守卫」要覆盖的路径：不加守卫时它会逃成一个
        // 没有 kind 的裸错误，绕过 @throws {SystemOneError} 的契约。
        res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        res.write('{"model":"tev1:0.8b","answers":', () => { res.socket.destroy(); });
        return;
      }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
```

- [ ] **Step 2: 写失败的测试**

创建 `test/client.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { startFakeOllama } from './fake-ollama.mjs';

// 这是**线格式**的 body：Task 3 的 client 层直接收 body、不经过 prepareRequest，
// 所以 questions 必须是对象映射 —— 假服务现在会像真服务一样拒绝数组（ADR-6）。
const BODY = {
  model: 'tev1:0.8b',
  state: 'Our checkout has returned 500 errors since 9am.',
  questions: { q: { name: 'q', type: 'noul', instructions: 'Is this English?' } },
};

const OK = {
  model: 'tev1:0.8b',
  answers: { q: { type: 'noul', noul: 0.4751 } },
  usage: { input_tokens: 799, output_tokens: 1 },
};

/** 起假服务、跑断言、必定关掉。 */
async function withServer(handler, run) {
  const fake = await startFakeOllama(handler);
  try { await run(fake); } finally { await fake.close(); }
}

/** 调用并返回 error（而非抛）。 */
async function failure(options) {
  return callSystemOne(options).then(() => null, (error) => error);
}

test('成功：POST /v1/systemone，原样返回 answers 与 usage', async () => {
  await withServer(() => ({ status: 200, body: OK }), async (fake) => {
    const result = await callSystemOne({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.deepEqual(result, OK);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].method, 'POST');
    assert.equal(fake.requests[0].url, '/v1/systemone');
    assert.deepEqual(fake.requests[0].json, BODY);
  });
});

test('404 → model_missing，提示 ollama pull', async () => {
  await withServer(() => ({ status: 404, body: { error: 'model not found' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.ok(error instanceof SystemOneError);
    assert.equal(error.kind, 'model_missing');
    assert.equal(error.status, 404);
    assert.match(error.hint, /ollama pull tev1:0\.8b/);
  });
});

test('413 → too_large', async () => {
  await withServer(
    () => ({ status: 413, body: { error: 'request body must not exceed 64 KiB without images' } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'too_large');
      assert.match(error.hint, /64 KiB/);
    },
  );
});

test('400 → invalid_request，带出服务端原文与合法类型清单', async () => {
  await withServer(
    () => ({ status: 400, body: { error: 'question "urgent": type must be choice, noul, or score' } }),
    async (fake) => {
      const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
      assert.equal(error.kind, 'invalid_request');
      assert.match(error.message, /type must be choice, noul, or score/);
      assert.match(error.hint, /choice、noul、score/);
      assert.match(error.hint, /对象映射/, 'hint 必须点明 questions 是对象映射 —— 真实的 400 常常来自形状而非类型');
    },
  );
});

test('线格式守卫：假服务以与真服务同形的 400 拒绝数组形状的 questions（ADR-6）', async () => {
  // 假服务现在照真服务的样子拒绝错形状（本机实测数组 → HTTP 400
  // "Value looks like object, but can't find closing '}' symbol"）。
  // 这条用例的意义是**让守卫本身被钉住** —— 没有它，守卫就是一个在套件里永不触发的
  // 死分支，改坏了也没人知道；而它正是防止"线格式违规再次本地全绿地溜过"的那道闸。
  await withServer(
    () => ({ status: 200, body: { model: 'tev1:0.8b', answers: {} } }),
    async (fake) => {
      const error = await failure({
        baseUrl: fake.baseUrl,
        body: { model: 'tev1:0.8b', state: 'x', questions: [{ name: 'q', type: 'noul', instructions: 'Yes?' }] },
        timeoutMs: 5000,
      });
      assert.equal(error.kind, 'invalid_request');
      assert.equal(error.status, 400);
      assert.match(error.message, /but can't find closing/);
    },
  );
});

test('500 且含 non-finite logit → model_broken，点名换模型（照抄本机真实响应形状）', async () => {
  // Ollama 0.35.1 实测的响应体：外层 error 是一个「装着 JSON 的字符串」。
  const realBody = JSON.stringify({
    error: JSON.stringify({ error: { code: 500, message: 'Clef: non-finite logit', type: 'server_error' } }),
  });
  await withServer(() => ({ status: 500, body: realBody }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'model_broken');
    assert.match(error.message, /non-finite logit/);
    assert.match(error.hint, /tev1/);
  });
});

test('其他 500 → server_error', async () => {
  await withServer(() => ({ status: 500, body: { error: 'scoring failed' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'server_error');
    assert.match(error.message, /scoring failed/);
  });
});

test('连接被拒 → unreachable，提示 ollama serve', async () => {
  const fake = await startFakeOllama(() => ({ status: 200, body: OK }));
  const { baseUrl } = fake;
  await fake.close();
  const error = await failure({ baseUrl, body: BODY, timeoutMs: 2000 });
  assert.equal(error.kind, 'unreachable');
  assert.match(error.hint, /ollama serve/);
});

test('超时 → timeout，提示首次调用含模型加载', async () => {
  await withServer(() => ({ hang: true }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 150 });
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /150 ms 内没有返回/);
    assert.match(error.hint, /模型加载/);
  });
});

test('调用方取消 → aborted，且立即生效（不被 timeoutMs 兜住）', async () => {
  await withServer(() => ({ hang: true }), async (fake) => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = callSystemOne({
      baseUrl: fake.baseUrl, body: BODY, timeoutMs: 30000, signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const error = await pending.then(() => null, (e) => e);
    assert.equal(error.kind, 'aborted');
    // 关键：取消必须真正中止 fetch，而不是等 timeoutMs 到点。
    // 若把 AbortSignal.any 换成只传 timeoutSignal，kind 仍是 'aborted'
    // （toTransportError 里另有 signal?.aborted 检查保持分类正确），
    // 但那时代价是 socket 一直挂到 timeoutMs（本任务 30s、Task 4 默认 120s）。
    // 这条耗时断言就是为那个回归设的 —— 规格 §4.3 明写「工具被取消能真中断」。
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `cancel 应立即生效，实际耗时 ${elapsed}ms（timeoutMs 是 30000）`);
  });
});

test('body 读取中途断连 → SystemOneError，而不是没有 kind 的裸 TypeError', async () => {
  await withServer(() => ({ truncate: true }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    // 这条用例钉住的是：响应头已到、body 读到一半失败时，错误仍必须被映射。
    // 若 callSystemOne 里 `await response.text()` 落在 try 之外，这里收到的会是
    // undici 的 TypeError: terminated —— 没有 kind，Task 4 的工具按 kind 分派就会崩。
    assert.ok(
      error instanceof SystemOneError,
      `期望 SystemOneError，实际 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.kind, 'unreachable');
    assert.match(error.hint, /ollama serve/);
  });
});

test('非 JSON 响应 → bad_response', async () => {
  await withServer(() => ({ status: 200, body: 'not json at all' }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'bad_response');
  });
});

test('缺 answers 字段 → bad_response', async () => {
  await withServer(() => ({ status: 200, body: { model: 'tev1:0.8b' } }), async (fake) => {
    const error = await failure({ baseUrl: fake.baseUrl, body: BODY, timeoutMs: 5000 });
    assert.equal(error.kind, 'bad_response');
    assert.match(error.message, /没有 answers/);
  });
});

test('fetchImpl 可注入（单测无需真实网络）', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify(OK), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await callSystemOne({
    baseUrl: 'http://example.invalid:1', body: BODY, timeoutMs: 5000, fetchImpl,
  });
  assert.deepEqual(result, OK);
  assert.equal(seen.url, 'http://example.invalid:1/v1/systemone');
  assert.equal(seen.init.method, 'POST');
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
node --test "test/*.test.mjs"
```

Expected: FAIL —— `Cannot find module '.../lib/client.js'`。

- [ ] **Step 4: 写实现**

创建 `lib/client.js`：

```js
/**
 * Ollama System One HTTP 客户端。
 *
 * 只负责四件事：拼 URL、发请求、把超时/取消/HTTP 失败映射成可行动的 SystemOneError、
 * 原样返回 `{ model, answers, usage }`。
 * 它**不认识 DSH** —— 便于将来被 CLI 或评测装置直接复用。
 *
 * @module dsh-decision-tools/client
 */

/** Clef 系模型在 Ollama 0.35.1 上的已知缺陷标记（本机实测：任何请求都触发）。 */
const BROKEN_MODEL_MARKER = 'non-finite logit';

/** 一次决策调用失败。`kind` 是稳定判据，`hint` 是给模型的下一步建议。 */
export class SystemOneError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: string, status?: number, hint?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'SystemOneError';
    this.kind = info.kind;
    this.status = info.status;
    this.hint = info.hint;
  }
}

/** 从响应体里取出服务端错误文本（Ollama 的 `error` 可能是字符串或对象）。 */
function extractErrorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === 'string') return parsed.error;
    if (parsed?.error !== undefined) return JSON.stringify(parsed.error);
  } catch {
    // 不是 JSON，退回原文
  }
  return text.trim() || '(空响应体)';
}

function toTransportError(error, { baseUrl, model, timeoutMs, signal }) {
  const name = error?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    if (signal?.aborted) {
      return new SystemOneError('调用被取消。', { kind: 'aborted' });
    }
    return new SystemOneError(
      `${model} 在 ${timeoutMs} ms 内没有返回。`,
      {
        kind: 'timeout',
        hint: '首次调用含模型加载（本机实测 0.8B 约 12s、4.2B 约 18.5s）；可调大 timeoutMs。',
      },
    );
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || name === 'TypeError') {
    return new SystemOneError(
      `无法连接 Ollama：${baseUrl}`,
      { kind: 'unreachable', hint: '确认 Ollama 已在运行（ollama serve）。' },
    );
  }
  return new SystemOneError(`请求失败：${error?.message ?? String(error)}`, { kind: 'transport' });
}

function toHttpError(status, text, model) {
  const detail = extractErrorDetail(text);
  if (status === 404) {
    return new SystemOneError(`模型 ${model} 未下载。`, {
      kind: 'model_missing', status, hint: `先运行：ollama pull ${model}`,
    });
  }
  if (status === 413) {
    return new SystemOneError('请求体超过服务端上限。', {
      kind: 'too_large', status, hint: '无图请求上限 64 KiB；请缩减 state 或拆分 questions。',
    });
  }
  if (status === 400) {
    return new SystemOneError(`Ollama 拒绝了请求：${detail}`, {
      kind: 'invalid_request', status,
      hint: '问题类型只允许 choice、noul、score；questions 必须是由题名索引的对象映射（不是数组）；choice/score 的选项数需在 2–26。',
    });
  }
  if (status === 500 && detail.includes(BROKEN_MODEL_MARKER)) {
    return new SystemOneError(`模型 ${model} 在本机 Ollama 上有已知缺陷：${detail}`, {
      kind: 'model_broken', status, hint: '改用 tev1 系模型（如 tev1:0.8b）；clef 系当前不可用。',
    });
  }
  if (status >= 500) {
    return new SystemOneError(`Ollama 服务端错误：${detail}`, { kind: 'server_error', status });
  }
  return new SystemOneError(`Ollama 返回 HTTP ${status}：${detail}`, { kind: 'http_error', status });
}

/**
 * 调用 `POST {baseUrl}/v1/systemone`。
 * @param {{ baseUrl: string, body: object, timeoutMs: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ model: string, answers: Record<string, unknown>, usage?: object }>}
 * @throws {SystemOneError}
 */
export async function callSystemOne({
  baseUrl, body, timeoutMs, signal, fetchImpl = fetch,
}) {
  const url = new URL('/v1/systemone', baseUrl).toString();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    throw toTransportError(error, { baseUrl, model: body.model, timeoutMs, signal });
  }

  // 读 body 也必须守卫：socket 在响应头到达之后、body 读完之前断掉（undici 抛
  // TypeError: terminated），或信号在读取途中触发，都会从这里逃出去 —— 那会绕过
  // 本函数 @throws {SystemOneError} 的契约，而 Task 4 的工具正是按 kind 分派的，
  // 一个没有 kind 的裸错误会变成工具失败而不是可行动的报错。
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw toTransportError(error, { baseUrl, model: body.model, timeoutMs, signal });
  }
  if (!response.ok) throw toHttpError(response.status, text, body.model);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SystemOneError(`Ollama 返回了无法解析的响应（HTTP ${response.status}）。`, {
      kind: 'bad_response', status: response.status,
    });
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.answers !== 'object' || parsed.answers === null) {
    throw new SystemOneError('Ollama 响应里没有 answers 字段。', {
      kind: 'bad_response', status: response.status,
    });
  }
  return { model: parsed.model, answers: parsed.answers, usage: parsed.usage };
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 34 个 test（14 + 6 + 14：validate + render + client）。

- [ ] **Step 6: 语法与 LF 校验**

```bash
node --check lib/client.js && node --check test/fake-ollama.mjs
for f in lib/client.js test/client.test.mjs test/fake-ollama.mjs; do printf "%-30s CR=%s\n" "$f" "$(tr -cd '\r' < "$f" | wc -c)"; done
```

Expected: 每个 `CR=0`。

- [ ] **Step 7: 提交**

```bash
git add lib/client.js test/client.test.mjs test/fake-ollama.mjs
git commit -F - <<'MSG'
feat(client): System One HTTP 客户端与错误映射

把 Ollama 的失败模式映射成模型能据此行动的 kind + hint：连接被拒提示 ollama serve、
404 提示 ollama pull、413 指出 64 KiB 上限、500 且含 non-finite logit 直接点名
clef 系在本机 0.35.1 上不可用并建议换 tev1。异常只分类不改写，成功响应原样透传。

client.js 不感知 DSH，便于将来复用到 CLI 或评测装置。

新增 lib/client.js（callSystemOne / SystemOneError，含 11 种 kind）
新增 test/fake-ollama.mjs（node:http 可编程假服务，记录请求体）
新增 test/client.test.mjs（14 个用例，含超时/取消【含生效耗时】可区分、body 读取中断、线格式守卫、注入 fetchImpl）
MSG
```

---

## Task 4: 工具契约与装配

**Files:**
- Create: `lib/parameters.js`
- Create: `lib/tool.js`
- Create: `lib/index.js`
- Test: `test/parameters.test.mjs`
- Test: `test/tool.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `prepareRequest`/`DecisionValidationError`；Task 2 的 `renderAnswers`；Task 3 的 `callSystemOne`/`SystemOneError`
- Produces:
  - `PARAMETERS`（`ParameterSchemaSpec`，键顺序 `state`、`questions`、`model`）、`TOOL_DESCRIPTION`（**承载全部使用指引**，见 ADR-5）
  - `name = 'decision-tools'`、`inject = ['tools']`、`Config`（schemastery）、`apply(ctx, config)`
  - `lib/index.js` 转出以上四者

- [ ] **Step 1: 写工具契约数据（含全部使用指引）**

创建 `lib/parameters.js`：

```js
/**
 * decision 工具的模型可见契约：描述与参数 schema。
 *
 * 纯数据模块，**不 import 任何东西** —— 这样 `test/parameters.test.mjs` 可以直接
 * 断言契约结构，不依赖宿主包解析。
 *
 * 用的是 DSH 的紧凑方言（ParameterSchemaSpec），不是裸 JSON Schema：
 *   - `required: true` 是逐属性注解（不是对象根上的数组）
 *   - 联合类型用 `oneOf`，至少 2 个分支
 *   - `object` 节点**必须**显式写 `additionalProperties`
 *   - 无约束节点是 `{ type: 'json' }`
 *
 * 这里只表达 DSL 能表达的东西（类型、枚举）。数量上限（1–64 题、2–26 选项）
 * 和体积上限由 lib/validate.js 在运行时检查。
 * @module dsh-decision-tools/parameters
 */

/** state 与 instructions 共用的「字符串或结构化内容」联合。 */
const CONTENT_SPEC = {
  oneOf: [
    { type: 'string', description: '纯文本。' },
    { type: 'object', additionalProperties: true, description: '对象；按 JSON 文本发给模型。' },
    { type: 'array', items: { type: 'json' }, description: '数组；按 JSON 文本发给模型。' },
  ],
};

export const TOOL_DESCRIPTION = [
  'Answer bounded decision questions about a shared piece of state with a local System One model.',
  'Use it for routing, classification, filtering, relevance judgement and scoring — tasks whose',
  'candidate set is known up front and whose useful answer is a probability rather than prose.',
  'Do not use it for open-ended generation or for problems that need a chain of reasoning.',
  'Ask every question about the same material in ONE call (up to 64). Never loop one call per item:',
  'each call re-sends the whole `state`.',
  'Question types: `choice` (pick one of 2-26 named options),',
  '`noul` (probability that a statement is true), and',
  '`score` (probability-weighted average over 2-26 ordered levels).',
  'Reading the answers: `noul` returns a NUMBER, not a boolean — 0.475 does not mean "no", it means',
  'a 47.5% chance of yes. `score` is reported on the 0..N-1 level scale, not normalised to 0-1.',
  '`confidence` measures how concentrated the distribution is (1 - H/ln N); it is NOT accuracy.',
  'Low confidence means the model is torn between options: read `probabilities` instead of the chosen',
  'answer, and escalate that question to your own reasoning rather than trusting it.',
  'These answers are PROBABILITIES, not proof. Never treat a `decision` result as correctness',
  'evidence, and never let it be the sole basis for a pass/allow decision — that requires',
  'artifact-level evidence. Use it for triage only, never as the final word.',
  'This tool must NOT decide routing, and must NOT be the basis of any fail-open or fail-closed',
  'policy: that belongs to deterministic rules, otherwise a broken decision model would break',
  'routing entirely.',
  'The tev1 family returns only probabilities and never text, so when a human-readable rationale',
  'must be preserved as evidence, use a generative model instead.',
].join(' ');

export const PARAMETERS = {
  state: {
    required: true,
    ...CONTENT_SPEC,
    description:
      'The material every question is asked about: a ticket, an email, a document, a JSON record, '
      + 'or a list of candidates. Sent once and shared by all questions.',
  },
  questions: {
    required: true,
    type: 'array',
    description:
      '1-64 questions about `state`, answered in one request. Each question carries its own `name` '
      + '(the key its answer comes back under) and `type`.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          required: true,
          description: 'Identifier for this question; the answer is returned under this key. Must be unique.',
        },
        type: {
          type: 'string',
          required: true,
          enum: ['choice', 'noul', 'score'],
          description:
            'choice = pick one option; noul = probability that something is true; '
            + 'score = rate against ordered levels. Note the spelling: `noul`, not `boolean`.',
        },
        instructions: {
          required: true,
          ...CONTENT_SPEC,
          description: 'What to decide, phrased as a question.',
        },
        criteria: {
          description:
            'choice: an object mapping option name to description (2-26 options). '
            + 'score: an array of level descriptions ordered from lowest to highest (2-26 levels). '
            + 'noul: optional {"false": "...", "true": "..."} descriptions; omit to use No/Yes.',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
    },
    examples: [
      [
        {
          name: 'label',
          type: 'choice',
          instructions: 'Which label fits this ticket?',
          criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
        },
        { name: 'refund', type: 'noul', instructions: 'Is the customer requesting a refund?' },
        {
          name: 'urgency',
          type: 'score',
          instructions: 'How urgently does this need a response?',
          criteria: ['Routine: no time pressure', 'Soon: a customer is inconvenienced', 'Immediate: a critical service is unavailable'],
        },
      ],
    ],
  },
  model: {
    type: 'string',
    description:
      'Override the configured default model for this call (default: tev1:0.8b). '
      + 'Bigger is not necessarily more correct — pick per task and verify.',
  },
};
```

- [ ] **Step 2: 写失败的契约测试**

创建 `test/parameters.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';
import { PARAMETERS, TOOL_DESCRIPTION } from '../lib/parameters.js';

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
```

- [ ] **Step 3: 运行确认失败**

```bash
node --test "test/parameters.test.mjs"
```

Expected: FAIL —— `Cannot find module '.../lib/parameters.js'`。

> **控制器勘误（第九处与第十处错误）。**
>
> **第九处（步骤顺序自相矛盾）**：初稿把 Step 1 写成"先建 `lib/parameters.js`"、Step 3 又期望 `Cannot find module '.../lib/parameters.js'` —— 模块在前一步已建，那个失败**不可能出现**。正确次序是**测试先行**：先写 `test/parameters.test.mjs`（Step 2），此时 `lib/parameters.js` 尚不存在 ⇒ Step 3 的 `Cannot find module` 才是真的；之后再落 Step 1 的契约数据。实现者据此执行并拿到了真实 RED。
>
> **第十处（断言对着源 DSL 而非投影后的形状）**：初稿的 `assert.deepEqual(Object.keys(definition.parameters), ['state','questions','model'])` **本机不可能成立**。`defineTool` 会先投影参数（宿主 `dsh-tools/lib/index.js:848`）⇒ 参数名在 `.properties`、`required` 在根上。**紧凑 DSL 是源格式，宿主会投影它；断言必须对着投影后的形状写。** 正确断言见 Step 6（并含 ADR-5 的 `description` 就地守卫与更新后的 `OUTPUT_SCHEMA` 六键集）。

- [ ] **Step 4: 运行确认通过**

```bash
node --test "test/parameters.test.mjs"
```

Expected: PASS —— 3 个 test 全绿。若 `parameterSchemaSpecToJsonSchema` 抛错，就是 DSL 写错了（最常见：object 分支漏 `additionalProperties`，或 `oneOf` 少于两个分支）。

- [ ] **Step 5: 写装配层**

创建 `lib/tool.js`：

```js
/**
 * decision 工具的装配：把纯逻辑模块接到 DSH 的 tools 服务上。
 * 本文件是唯一接触 `ctx` 的地方。
 * @module dsh-decision-tools/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { PARAMETERS, TOOL_DESCRIPTION } from './parameters.js';
import { prepareRequest, LIMITS } from './validate.js';
import { renderAnswers } from './render.js';
import { callSystemOne } from './client.js';

/**
 * 插件身份名。
 * 注意：这**不是**模型看到的工具名 —— 工具名取自配置 `toolName`（默认 `decision`）。
 */
export const name = 'decision-tools';

/** 只需要 tools：使用指引全部在工具 description 里，不注册 prompt 段（ADR-5）。 */
export const inject = ['tools'];

export const Config = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  defaultModel: z.string().default('tev1:0.8b'),
  timeoutMs: z.number().default(120000),
  toolName: z.string().default('decision'),
  // 可以是 "5m" 这类时长串或秒数；未设则不下发该字段，用服务端默认。
  keepAlive: z.union([z.string(), z.number()]).required(false),
});

/**
 * 返回值 schema。宿主会用它对**每一个成功返回值**做强校验，
 * 因此这里的字段必须与 `execute` 的返回严格对应；
 * 用 `additionalProperties: true` 容忍 Ollama 新增字段。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', required: true },
    answers: { type: 'object', additionalProperties: true, required: true },
    usage: { type: 'object', additionalProperties: true },
    // 体积可归因（需求 M2，见 Task 7 与规格 §4.8）。这三个字段**由本插件自己产出**，
    // 不是 Ollama 的回包字段，故必须显式声明 —— schema 是 additionalProperties:false。
    state_bytes: { type: 'number' },
    body_bytes: { type: 'number' },
    body_warning: { type: 'string' },
  },
};

export function apply(ctx, config = {}) {
  const { baseUrl, defaultModel, timeoutMs, toolName, keepAlive } = config;

  ctx.tools.register(defineTool({
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderAnswers,
    },
    async execute(args, exec) {
      const body = prepareRequest({
        state: args.state,
        questions: args.questions,
        model: args.model,
        defaultModel,
        keepAlive,
      });
      const result = await callSystemOne({ baseUrl, body, timeoutMs, signal: exec?.signal });

      // 体积可归因（需求 M2）。body_bytes 必须按**已转换的线格式**度量 —— 与 V8 的硬守卫
      // 同一口径，否则模型看到的数与真正的上限余量对不上。
      // state 可能是字符串，也可能是对象/数组（CONTENT_SPEC），故按序列化后的字节数报。
      const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
      const stateBytes = Buffer.byteLength(stateText, 'utf8');
      const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      const warning = bodyBytes > LIMITS.softBodyBytes
        ? `请求体 ${bodyBytes} 字节，已超过建议的 ${LIMITS.softBodyBytes} 字节：`
          + '可考虑拆成多次调用，或缩小 state。'
        : undefined;

      // 注意：宿主要求返回的是 JSON 值（否则 snapshotToolValue 会拒绝），
      // 所以 warning 为 undefined 时**整个键都不能出现**，不能写成 body_warning: undefined。
      // 宿主用 snapshotJsonValue 逐层检查返回值是否为**无损 JSON**：任何值为 `undefined`
      // 的 own key 都会让整次调用被判非法并抛 ToolOutputError —— 即「成功调用变成工具失败」。
      // 所以返回值必须**逐字段显式构造**，凡可能为 undefined 的键都要**整个不出现**。
      // 同一函数里 body_warning 已按此处理；usage 同样必须 —— 它来自服务端回包，可能缺席。
      return {
        model: result.model,
        answers: result.answers,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        state_bytes: stateBytes,
        body_bytes: bodyBytes,
        ...(warning === undefined ? {} : { body_warning: warning }),
      };
    },
  }));
}
```

创建 `lib/index.js`：

```js
/**
 * 包入口：composition 的插件行以包名 `dsh-decision-tools` 指向这里。
 * 全部实现都在 lib/tool.js，这里只做转出。
 * @module dsh-decision-tools
 */
export { name, inject, Config, apply } from './tool.js';
```

- [ ] **Step 6: 写装配测试**

创建 `test/tool.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { name, inject, Config, apply } from '../lib/index.js';
import { startFakeOllama } from './fake-ollama.mjs';

/**
 * 一个够用的假 ctx：**刻意只提供 tools**。
 * 本插件不注册 prompt 段（ADR-5），所以缺少 systemPrompt 时 apply 必须照常工作 ——
 * 这个假 ctx 本身就是那条不变量的守卫：一旦有人再加回 systemPrompt 调用，测试会直接崩。
 */
function fakeCtx() {
  const registered = [];
  return {
    registered,
    ctx: {
      tools: { register: (definition) => { registered.push(definition); return () => {}; } },
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
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
  assert.deepEqual(Config({}), {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'tev1:0.8b',
    timeoutMs: 120000,
    toolName: 'decision',
  });
});

test('默认 toolName 配置下的工具名与 schema', () => {
  const { registered, ctx } = fakeCtx();
  apply(ctx, Config({}));

  assert.equal(registered.length, 1);
  const definition = registered[0];
  assert.equal(definition.name, 'decision');
  // 注意：defineTool 会**先**跑 parameterSchemaSpecToJsonSchema(options.parameters)
  // （宿主 dsh-tools/lib/index.js:848）再放回 ⇒ definition.parameters 是**投影后的 JSON Schema**：
  // 键是 ['type','properties','required']，参数名在 .properties，required 是根上的数组。
  // **不要**对 Object.keys(definition.parameters) 断言参数名 —— 那是源 DSL 的形状，本机必红。
  assert.deepEqual(Object.keys(definition.parameters), ['type', 'properties', 'required']);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['state', 'questions', 'model']);
  assert.deepEqual(definition.parameters.required, ['state', 'questions']);
  // ADR-5 就地守卫：指引只放 description，故它必须原样就是 TOOL_DESCRIPTION
  assert.equal(definition.description, TOOL_DESCRIPTION);
  assert.equal(definition.output.schema.type, 'object');
  assert.equal(definition.output.schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(definition.output.schema.properties),
    ['model', 'answers', 'usage', 'state_bytes', 'body_bytes', 'body_warning'],
  );
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
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

    assert.deepEqual(value, ANSWERS);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/v1/systemone');
    assert.equal(fake.requests[0].json.model, 'tev1:0.8b');
  } finally {
    await fake.close();
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
```

- [ ] **Step 7: 运行全部测试**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 48 个 test（15 + 9 + 14 + 3 + 7：validate + render + client + parameters + tool）。
（15/9 是 Task 7 之后的口径；Task 7 在 Task 4 之前执行。）

**Task 7 delta 对本任务的追加要求（体积可归因的产出侧）** —— 上面的实现已含，测试侧需同步：

- `test/tool.test.mjs` 里断言 `output.schema.properties` 键集的那一处，期望值追加 `'state_bytes', 'body_bytes', 'body_warning'`（顺序与 `OUTPUT_SCHEMA` 一致）；`additionalProperties === false` 的断言保持不变。
- 在已有的 execute 往返用例里追加断言：返回值含数值型 `state_bytes` 与 `body_bytes`，且 **`body_bytes` 等于该次真实请求体的字节数**（可用 `Buffer.byteLength(fake.requests[0].raw, 'utf8')` 与返回值比对 —— 这条比"存在即可"强，它钉住的是**按转换后线格式度量**这个口径）。
- 小 state 的场景下**不得**出现 `body_warning` 键（`'body_warning' in value === false`），因为宿主要求返回是 JSON 值。
- **服务端回包不含 `usage` 时，返回值里也不得出现 `usage` 键**（`'usage' in value === false`）—— 用 `{status: 200, body: {model, answers}}` 驱动一次 execute 来断言。这条与上一条同源：值为 `undefined` 的 own key 会让宿主把整次调用判为非法。变异确认：把 `execute` 的返回改回 `...result` 展开 ⇒ 本条必须变红。
- 测试侧还需把 `output.schema.properties` 的键集断言更新为六个键（含三个体积字段），否则它会在 `OUTPUT_SCHEMA` 扩容后变红。
- 不新增用例文件；上述断言并入既有用例，故 Task 4 的用例数仍为 **7**。

- [ ] **Step 8: 语法与 LF 校验**

```bash
for f in lib/parameters.js lib/tool.js lib/index.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
for f in lib/parameters.js lib/tool.js lib/index.js test/parameters.test.mjs test/tool.test.mjs; do
  printf "%-34s CR=%s\n" "$f" "$(tr -cd '\r' < "$f" | wc -c)"
done
```

Expected: 每个 `CR=0`，无 `SYNTAX FAIL`。

- [ ] **Step 9: 提交**

```bash
git add lib/parameters.js lib/tool.js lib/index.js test/parameters.test.mjs test/tool.test.mjs
git commit -F - <<'MSG'
feat(tool): decision 工具装配与模型可见契约

单工具 + 数组式 questions（ADR-2）：一次调用问 1-64 题、choice/noul/score 混合、
共享同一 state。多条目判定（给 N 篇文档各打一次分）在一次请求里问完，避免重复传 state。

参数契约单独放在 parameters.js 且零 import，使契约测试不依赖宿主包解析。
使用指引全部写在工具 description 里、不注册 prompt 段（ADR-5）：SECTION_ORDERS 的
32 个具名槽位全被第一方占用，没有留给第三方工具的槽位，而 getSectionOrder 对未注册名
返回 undefined 会被 section() 抛错；且原计划里那段文字与 description 约 85% 同义。
description 因此吸收了原 prompt 段独有的两点：0.475 不代表否的具体例子、低置信度升级。

假 ctx 刻意只提供 tools —— 它本身就是"不依赖 systemPrompt"这条不变量的守卫。

新增 lib/parameters.js（PARAMETERS / TOOL_DESCRIPTION）
新增 lib/tool.js（name/inject/Config/apply，唯一接触 ctx 的文件，inject 仅 ['tools']）
新增 lib/index.js（转出包入口）
新增 test/parameters.test.mjs（3 个用例，含投影为 JSON Schema）
新增 test/tool.test.mjs（7 个用例，含假 ctx 与不发网络请求的断言）
MSG
```

---

## Task 5: 接线、安装与可见性验证

这一任务才让插件真正进入 DSH。安装动作会请求审批。

**Files:**
- Create: `cordis.patch.yml`
- Modify: `package.json`（加 `dsh` 字段）

**Interfaces:**
- Consumes: Task 4 的 `lib/index.js`（插件行以包名指向它）
- Produces: 一个已安装且 `application: applied` 的 bundle；本会话 `listTools` 中可见 `decision`

- [ ] **Step 1: 写 composition patch**

创建 `cordis.patch.yml`：

```yaml
# dsh-decision-tools — 把本机 Ollama 的 System One 决策能力注册成模型工具。
#
# 行说明：
#   decision-tools-tool — 注册 `decision` 工具（模型可见名由配置项 toolName 决定），
#     本插件不依赖平台，任何环境都注册。使用指引在工具 description 里，不注册 prompt 段（ADR-5）。
#
# 覆盖默认配置时，字段**直接写在行上**（patch 会替换整行 config，因此要重述全部字段）：
#   - insert:
#       - id: decision-tools-tool
#         name: 'dsh-decision-tools'
#         baseUrl: 'http://localhost:11434'
#         defaultModel: 'tev1:latest'
#         timeoutMs: 180000
#         toolName: 'decision'
#         keepAlive: '30m'

- insert:
    - id: decision-tools-tool
      name: 'dsh-decision-tools'
```

- [ ] **Step 2: 给 `package.json` 加 `dsh` 字段**

在 `"scripts"` 之前插入（注意保持 JSON 合法，前一行记得加逗号）：

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```

- [ ] **Step 3: 校验清单与 patch 语法**

```bash
node -e "const p=require('./package.json'); console.log('name:',p.name); console.log('patch:',p.dsh?.bundle?.patch); console.log('files:',JSON.stringify(p.files));"
node -e "const yaml=require('D:/Users/Dinos/AppData/Roaming/nvm/v22.22.1/node_modules/@deepseek-ai/dsh/node_modules/js-yaml'); const fs=require('fs'); console.log(JSON.stringify(yaml.load(fs.readFileSync('cordis.patch.yml','utf8'))));"
```

Expected: `patch: ./cordis.patch.yml`；patch 解析出 `[{insert:[{id:'decision-tools-tool',name:'dsh-decision-tools'}]}]`。

- [ ] **Step 4: 全量测试与语法检查**

```bash
node --check lib/index.js && node --check lib/tool.js && node --test "test/*.test.mjs"
for f in cordis.patch.yml package.json; do printf "%-20s CR=%s\n" "$f" "$(tr -cd '\r' < "$f" | wc -c)"; done
```

Expected: 测试 `# fail 0`；两个文件 `CR=0`。

- [ ] **Step 5: 提交**

```bash
git add cordis.patch.yml package.json
git commit -F - <<'MSG'
feat(bundle): 接线为可安装的 DSH bundle

cordis.patch.yml 插入一行 decision-tools-tool，指向包名 dsh-decision-tools
（经 exports["."] 解析到 lib/index.js）。本插件不需要任何配置，故该行只有 id/name；
**若将来要覆盖配置，必须写在行的 `config:` 键下** —— 平铺在行上会被静默忽略
（EntryOptions 只认 id/name/config/group/disabled/inject，只有 options.config 会传给插件）。

package.json 声明 dsh.bundle.patch，使 install_bundle 能找到接线。
MSG
```

> **控制器勘误（第十一处错误，由 Task 5 实现者实测发现）**：上面这段提交信息在修订前写的是「配置字段直接写在行上 —— patch 会替换整行 config，**无 config: 包裹层**」，**因果完全反了**。实测依据：`@deepseek-ai/cordis-plugin-loader` 的 `EntryOptions` 只有 `config?: any`；该包 `lib/index.js:461` 只把 `options.config` 传给插件；官方与第一方模板及本机活 profile（124 处 `config:`）一律用 `config:` 包裹。**症状（平铺则静默失效）记对了，归因记反了。**
>
> **影响面**：patch 的活代码只有 `id`/`name`，**不影响能否挂载**；受损的是注释示例 —— 照抄会静默失效，恰好制造出该事实警告过的症状。**已提交的 `a6fc183` 提交信息与 `cordis.patch.yml` 的注释都含这句错注**，属不可改历史（提交信息）与需修注释（文件）；本勘误是唯一权威更正。规格 §4.2 同错，已同步更正。
> **另**：注释示例里的 `tev1:latest` 是随手写的，与冻结默认 `tev1:0.8b` 不一致 ⇒ 一并统一，否则 Task 6 的 README 默认值表会与 patch 注释对不上。

- [ ] **Step 6: 安装到 web profile**

用绝对路径调用 `plugin_manager`：

```
plugin_manager(action="install_bundle", target="F:\\Dinosaur_MC\\Studio\\Project\\dsh-decision-tools")
```

此步会请求审批（`plugin_manager` 的每个动作都需要）。批准后读取返回值的 **`application`** 与 **`warnings`** 字段 —— 它们才是判断是否生效的依据，不是服务器日志或进程列表。

Expected: `application: applied`。若 `application` 不是 `applied`，或 `warnings` 非空，**停下来**按 warning 修 `cordis.patch.yml` 或 `lib/index.js`，不要继续。

- [ ] **Step 7: 验证工具真的可见**

```
cordis_inspect_query(platform="host", provider="Tool", method="listTools")
```

Expected: 返回的工具列表里出现 `decision`，其 `parameters` 含 `state`、`questions`、`model`。
这一步 `cordis_inspect_query` 无需审批，是比翻 `list_plugins` 更直接的证据。

- [ ] **Step 8: 在本会话真调一次**

调用 `decision` 工具（三型混合，一次请求）：

```json
{
  "state": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
  "questions": [
    { "name": "label", "type": "choice", "instructions": "Which label fits this ticket?",
      "criteria": { "billing": "Payments and refunds", "bug": "Software errors", "account": "Login and account access" } },
    { "name": "refund", "type": "noul", "instructions": "Is the customer requesting a refund?" },
    { "name": "urgency", "type": "score", "instructions": "How urgently does this ticket need a response?",
      "criteria": ["Routine: no time pressure", "Soon: a customer is inconvenienced", "Immediate: a critical service is unavailable"] }
  ]
}
```

Expected: 返回三行文本（`label` / `refund` / `urgency`）加一行 `(usage: ...)`。首次调用含模型加载，可能耗时 10–20 秒。

- [ ] **Step 9: 验证本地校验在真实链路里生效**

再调一次，故意传非法参数：

```json
{ "state": "x", "questions": [] }
```

Expected: 工具返回**错误**（不是让 Ollama 报 400），消息形如
`questions 有 0 题，合法范围 1–64；请拆分为多次调用。`

- [ ] **Step 10: 记录实测数字**

把 Step 8 的真实返回与耗时、Step 9 的真实错误文本写进 `.temp/decision-tools/verified.json`（不进库），供 Task 6 的 README 引用。

```bash
mkdir -p .temp/decision-tools
```

---

## Task 6: 真机冒烟、文档与打包边界

**Files:**
- Create: `smoke/live.mjs`
- Create: `README.md`
- Create: `README.zh.md`
- Create: `LICENSE`
- Create: `THIRD_PARTY_NOTICES`

**Interfaces:**
- Consumes: Task 1–4 的全部模块；Task 5 记录的实测数字
- Produces: 可复现的冒烟入口、两份 README、许可文件，以及一个**只含功能件**的包

- [ ] **Step 1: 写冒烟脚本**

创建 `smoke/live.mjs`：

```js
#!/usr/bin/env node
/**
 * 真机冒烟：对本机 Ollama 跑一次三型混合请求，打印结论、概率与耗时。
 * 不参与 CI（需要 Ollama 在跑且已 pull 模型），也不入包。
 *
 * 用法：node smoke/live.mjs [模型名]   （默认 tev1:0.8b）
 * 退出码：0 成功；1 失败（附 Ollama 侧的 kind 与 hint）。
 */
import { callSystemOne, SystemOneError } from '../lib/client.js';
import { prepareRequest } from '../lib/validate.js';
import { renderAnswers } from '../lib/render.js';

const model = process.argv[2] ?? 'tev1:0.8b';
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';

const body = prepareRequest({
  defaultModel: model,
  state: 'Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.',
  questions: [
    {
      name: 'label',
      type: 'choice',
      instructions: 'Which label fits this ticket?',
      criteria: { billing: 'Payments and refunds', bug: 'Software errors', account: 'Login and account access' },
    },
    { name: 'refund', type: 'noul', instructions: 'Is the customer requesting a refund?' },
    {
      name: 'urgency',
      type: 'score',
      instructions: 'How urgently does this ticket need a response?',
      criteria: [
        'Routine: no time pressure',
        'Soon: a customer is inconvenienced',
        'Immediate: a critical service is unavailable',
      ],
    },
  ],
});

console.log(`model   : ${model}`);
console.log(`baseUrl : ${baseUrl}`);
const started = Date.now();
try {
  const value = await callSystemOne({ baseUrl, body, timeoutMs: 180000 });
  const elapsed = Date.now() - started;
  console.log(`elapsed : ${elapsed} ms`);
  console.log('---');
  console.log(renderAnswers(body, value)[0].text);
} catch (error) {
  const elapsed = Date.now() - started;
  console.error(`FAILED after ${elapsed} ms`);
  if (error instanceof SystemOneError) {
    console.error(`kind: ${error.kind}`);
    console.error(`message: ${error.message}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
```

- [ ] **Step 2: 对两个可用模型各跑一次，记录数字**

```bash
cd /f/Dinosaur_MC/Studio/Project/dsh-decision-tools
node smoke/live.mjs tev1:0.8b
node smoke/live.mjs tev1:latest
```

Expected: 两次都打印三行答案与 `elapsed`。把实测模型、结论、概率与耗时记下来写进 README。
同时确认已知缺陷仍在（用于 README 的限制一节）：

```bash
node smoke/live.mjs clef-flash:latest
```

Expected: `FAILED`，`kind: model_broken`，消息含 `non-finite logit`，hint 建议换 tev1 系。（若这条**通过**了，说明上游已修复：更新 README 的限制条目，并考虑把视觉支持提回 v2 计划。）

- [ ] **Step 3: 写 `LICENSE`**

标准 MIT 正文，首行版权：`Copyright (c) 2026 Dinosaur_MC`。

- [ ] **Step 4: 写 `THIRD_PARTY_NOTICES`**

```text
dsh-decision-tools — third-party notices
========================================

Runtime peer dependencies (provided by the DSH host, not bundled here):

  @deepseek-ai/cordis        — MIT
  @deepseek-ai/dsh-tools     — MIT
  @deepseek-ai/schemastery   — MIT

No third-party source code is vendored into this package. The plugin talks to a
locally running Ollama server over its HTTP API (POST /v1/systemone); no Ollama
code is included or required at build time.

Model weights are NOT included. The decision models (tev1, nimble, clef, ...) are
downloaded separately through Ollama and carry their own licences.
```

- [ ] **Step 5: 写 `README.md`（英文）**

必须包含以下小节，内容取自实测（把 Task 5/6 记录的真实数字填进去）：

```markdown
# dsh-decision-tools

A DSH agent tool that puts a local [Ollama System One](https://docs.ollama.com/capabilities/decision)
model behind one tool call: classify, answer yes/no, and score against a rubric —
all in a single request that shares one piece of state.

## Why

Routing, filtering, relevance judgement and scoring are bounded decisions whose
useful answer is a probability, not prose. Sending them to a generative model is
slow and expensive. A System One decision model answers in one forward pass.

## Requirements

- Ollama >= 0.35.0 running locally
- At least one decision model: `ollama pull tev1:0.8b` (recommended default)
- DSH with `@deepseek-ai/dsh-tools` >= 0.2.0-rc.2

## Install

    plugin_manager(action="install_bundle", target="<absolute path to this package>")

Then confirm the tool is visible with
`cordis_inspect_query(platform="host", provider="Tool", method="listTools")`.

## Usage

One call, three question types, one shared state:

```json
{
  "state": "Our checkout has returned 500 errors since 9am.",
  "questions": [
    { "name": "label", "type": "choice",
      "instructions": "Which label fits this ticket?",
      "criteria": { "billing": "Payments and refunds", "bug": "Software errors" } },
    { "name": "refund", "type": "noul",
      "instructions": "Is the customer requesting a refund?" },
    { "name": "urgency", "type": "score",
      "instructions": "How urgently does this need a response?",
      "criteria": ["Routine", "Soon", "Immediate"] }
  ]
}
```

Returns one line per question plus a usage line:

    label    choice  bug      p={bug=0.9593, account=0.0343, billing=0.0063}  conf=0.829
    refund   noul    P(true)=0.4751
    urgency  score   1.1542 / 2  p={1=0.7075, 2=0.2234, 0=0.0691}  conf=0.304
    (usage: input_tokens=799 output_tokens=4)

## Question types

| Type | Criteria | Answer |
|---|---|---|
| `choice` | 2–26 named options with descriptions | the most likely option plus each option's probability |
| `noul` | optional `{"false": ..., "true": ...}` descriptions | `noul`: the probability of true (a number, not a boolean) |
| `score` | 2–26 descriptions ordered lowest → highest | `score`: probability-weighted mean of the zero-based levels, on the 0..N-1 scale |

`confidence` is distribution concentration, `1 - H(p)/ln N`. It is **not** calibrated accuracy.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama endpoint |
| `defaultModel` | `tev1:0.8b` | model when a call omits `model` |
| `timeoutMs` | `120000` | per-request budget, including cold model load |
| `toolName` | `decision` | the name the model sees |
| `keepAlive` | unset | passed through as `keep_alive`; unset uses the server default |

Override in `cordis.patch.yml` by writing the fields directly on the row.

## Known limitations

1. **`clef` / `clef-flash` are broken on Ollama 0.35.1.** Every request — plain text,
   with an image, or a single minimal `noul` — returns
   `500 {"message":"Clef: non-finite logit"}`. Vision is therefore not supported.
2. **Bigger is not necessarily more correct.** On the same ticket, `tev1:0.8b`
   answered `bug` while `tev1:latest` (4.2B) answered `billing` — and `billing` is
   the weaker answer given the text. Verify per task.
3. First call includes model load (measured: ~12 s for 0.8b, ~18.5 s for 4.2B).
4. No streaming, no tool calling, one request one response.
5. Server limits: 64 KiB request without images, 64 questions, 2–26 options per question.

## Development

    npm run link-peers     # symlink the host's peer packages (no network)
    npm test               # node --test "test/*.test.mjs"
    node smoke/live.mjs    # optional: hit the real local Ollama

`node --test test/` does **not** work on Node 22 — the directory form is treated as
a module path. Use the quoted glob.

## Licence

MIT. See LICENSE and THIRD_PARTY_NOTICES.
```

- [ ] **Step 6: 写 `README.zh.md`**

与英文版逐节对应，标题与表格保留，正文译成中文。**必须**包含：安装命令、一次三型混合调用的示例与真实输出、题型表、配置表（与默认值逐字一致）、已知限制 **6 条**（与规格 §8 **逐条对应**，不是 5 条；含 clef 缺陷的报错原文、0.8B/4.2B 分歧的实测内容、以及**「本插件只解决有界判定，开放式推理仍须交给生成式模型」这条适用范围声明**）、开发命令。

- [ ] **Step 7: 验证打包边界**

```bash
cd /f/Dinosaur_MC/Studio/Project/dsh-decision-tools
npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p'
```

Expected: 文件清单**只含** `lib/` 下的 6 个 `.js`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`LICENSE`、`THIRD_PARTY_NOTICES`、`package.json`。
**不得**出现 `test/`、`smoke/`、`scripts/`、`docs/`、`.temp/`。若出现，修 `files` 白名单后重跑。

- [ ] **Step 8: 全量回归 + LF 校验**

```bash
node --test "test/*.test.mjs"
echo "--- CR byte counts (all must be 0) ---"
for f in $(git ls-files); do
  n=$(tr -cd '\r' < "$f" | wc -c)
  [ "$n" -ne 0 ] && echo "CRLF FOUND: $f ($n)"
done
echo "(no CRLF FOUND lines above means pass)"
```

Expected: 测试 `# fail 0`；没有任何 `CRLF FOUND` 行。

- [ ] **Step 9: 提交**

```bash
git add smoke/live.mjs README.md README.zh.md LICENSE THIRD_PARTY_NOTICES
git commit -F - <<'MSG'
docs: README(中英) + 许可 + 真机冒烟

冒烟脚本对本机 Ollama 跑一次三型混合请求并打印耗时，退出码可判成败；
不参与 CI、不入包。

README 的已知限制全部来自本机实测：clef 系在 0.35.1 上任何请求都报
non-finite logit；同一题 tev1:0.8b 给 bug 而 tev1:latest 给 billing，
大模型不必然更合理；首次调用含模型加载。

打包边界按发布裁定收窄：test/smoke/scripts/docs/.temp 一律不入包，
并用 npm pack --dry-run 核验清单。

新增 smoke/live.mjs
新增 README.md README.zh.md LICENSE THIRD_PARTY_NOTICES
MSG
```

- [ ] **Step 10: 终检**

```bash
git log --oneline
git status --short
```

Expected: 6 个任务各有一次提交（**不是**全仓只有 6 个提交 —— 实际历史提交数远多于此）；`git status` 干净（`.temp/` 与 `node_modules/` 已被 gitignore）。

---

## Self-Review

**1. Spec coverage**

| 规格章节 | 落地任务 |
|---|---|
| §3 ADR-1 纯 JS 免构建 | Global Constraints + Task 1 Step 3（无构建链） |
| §3 ADR-2 单工具 + 数组式 questions | Task 4（`PARAMETERS.questions` 是数组，仅注册一个工具） |
| §3 ADR-3 v1 不做视觉 | 无 `images` 参数；Task 6 Step 2 复测 clef 缺陷 |
| §3 ADR-4 model 可逐次覆盖 | Task 1 Step 6（`prepareRequest`）+ Task 4 Step 6（覆盖测试） |
| §3 ADR-5 不注册 prompt 段 | Task 4 Step 1（description 吸收全部指引）+ Step 6（假 ctx **不提供** `systemPrompt`，作不变量守卫；并断言 `inject === ['tools']`） |
| §4.2 patch 与行/模块对应 | Task 5 Step 1–3 |
| §4.3 SystemOneClient | Task 3 |
| §4.4 tool.js 与 apply | Task 4 Step 5 |
| §4.5 参数 schema | Task 4 Step 1 + Step 2（结构不变量测试） |
| §4.6 校验规则 V1–V9 | Task 1 Step 6 + Step 4（每个 V 都有对应用例） |
| §4.7 错误映射表（8 行） | Task 3 Step 4 实现 + Step 2 用例：`unreachable`/`timeout`/`model_missing`/`too_large`/`invalid_request`/`model_broken`/`server_error`/`bad_response` 八行**逐行有用例**；额外覆盖 `aborted`（调用方取消，与超时可区分）。`transport` 与 `http_error` 是兜底分支，无直接用例 |
| §4.8 渲染 | Task 2 |
| §4.9 使用指引只放 description（ADR-5） | Task 4 Step 1（description 覆盖规格列出的六点）+ Step 2 的 `parameters.test.mjs`（断言点明 noul 非布尔、confidence 非正确率）+ Step 6 的 `tool.test.mjs`（假 ctx 无 `systemPrompt`） |
| §4.10 配置项 | Task 4 Step 5 + Step 6（`Config({})` 逐字断言） |
| §6 测试计划 | Task 1–4 的 test 文件；`fake-ollama.mjs` 在 Task 3 |
| §7 验收标准 1–6 | Task 5 Step 4/6/7/8/9 + Task 6 Step 8（LF 用真实字节计数） |
| §8 已知限制 | Task 6 Step 2（复测）+ Step 5/6（写入 README） |
| §9 打包边界 | Task 6 Step 7（`npm pack --dry-run`） |

无缺口。

**2. Placeholder scan**

已逐条检查：无 `TBD`/`TODO`/「稍后实现」/「加上适当的错误处理」/「参照 Task N」。
每个代码步骤都给出可直接落盘的完整实现；每个测试步骤都给出完整用例。
两处**有意**的延后且都已写明产出物：README 的实测数字（Task 6 Step 2 产出）、
`.temp/decision-tools/verified.json`（Task 5 Step 10 产出）。

**3. Type consistency**

- `prepareRequest` 的入参名在 Task 1 定义、Task 4/6 调用一致（`state`/`questions`/`model`/`defaultModel`/`keepAlive`）。
- `DecisionValidationError` 的 `name`/`kind` 在 Task 1 定义、Task 4 Step 7 断言一致。
- `SystemOneError` 的 `kind` 字符串集合在 Task 3 定义、Task 4 Step 7 断言 `model_missing` 一致。
- `renderAnswers(args, value)` 的签名在 Task 2 定义、Task 4 的 `output.render` 直接传入、Task 6 冒烟手工调用一致。
- `callSystemOne({ baseUrl, body, timeoutMs, signal, fetchImpl })` 在 Task 3 定义，Task 4 传 `{ baseUrl, body, timeoutMs, signal }`、Task 6 传 `{ baseUrl, body, timeoutMs }` —— 一致（`fetchImpl` 有默认值）。
- `Config` 的五个键名在 Task 4 定义，Task 5 的 patch 注释、Task 6 的 README 表格逐字一致。
- `OUTPUT_SCHEMA` 的 `model`/`answers`/`usage` 三键与 `callSystemOne` 的返回三键一致（若加键，两处必须同时改）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-04-dsh-decision-tools-plan.md`.

---

## Task 7: 需求 delta —— 题名禁纯数字 + 体积可归因

> **执行顺序**：本任务**在 Task 4 之前执行**。它修改 Task 1/Task 2 的**已交付件**（`lib/validate.js` 的 V2 与 `LIMITS`、`lib/render.js` 的输出），而 Task 4 的工具契约要消费这些改动。编号为 7 是因为它在本轮 SDD **运行途中**由需求 delta 追加；**不重排既有 1–6 的编号**，以免造成大量交叉引用漂移（`task-brief` 脚本按标题文字匹配任务号，与位置无关，故这样是安全的）。
>
> **来源与权威性（匿名化）**：这些需求项的来源是**匿名调研输入**（无出处、无归属）。**用户 2026-10-04 裁定：它们是「参考输入」，不是约束；且不入库、不引用、归匿名材料。** 控制器按技术价值逐条取舍：本任务做两件**便宜且已明确**的事（M3 的数字题名、M2 的体积回显）；重项（M1 引用式 `state`、M5 审计 JSONL、M3 的 `orderPolicy`）已进规格 §10 的 v2 台账并注明触发条件。
>
> **计数口径变化（本任务改变了用例数，在此显式声明以免漂移）**：本任务之后各文件用例数为 `validate 15 / render 9 / client 14`，合计 **38**；Task 4 完成后为 **48**。计划中 Task 1/2/3 的 `Expected` 行（14 / 20 / 34）记录的是**各自执行当时**的值，属历史记录，**此后一律以本任务与 Task 4 的计数为准**。

**Files:**
- Modify: `lib/validate.js`
- Modify: `test/validate.test.mjs`
- Modify: `lib/render.js`
- Modify: `test/render.test.mjs`

- [ ] **Step 1: 写失败的测试**

在 `test/validate.test.mjs` 末尾追加：

```js
test('V2 续：题名不得为纯数字串（纯数字会被 JS 对象映射重排，破坏有序批量语义）', () => {
  expectReject(
    base({ questions: [{ name: '1', type: 'noul', instructions: 'x' }] }),
    /不能是纯数字/,
  );
  // 非纯数字题名不受影响。注意本规则比实际的「整数索引键」集合略宽
  // （"01" 其实不会被重排，这里同样会拒），宁可多拒也不错排。
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ name: 'q1', type: 'noul', instructions: 'x' }] })));
  assert.doesNotThrow(() => prepareRequest(base({ questions: [{ name: '1a', type: 'noul', instructions: 'x' }] })));
});
```

在 `test/render.test.mjs` 末尾追加（fixture 写在函数内部，避免与文件既有常量重名）：

```js
test('体积口径：value 带 state_bytes/body_bytes 时追加一行', () => {
  const value = {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    usage: { input_tokens: 799, output_tokens: 1 },
    state_bytes: 101,
    body_bytes: 634,
  };
  const [block] = renderAnswers({}, value);
  assert.match(block.text, /^体积: state=101B body=634B$/m);
});

test('体积告警：body_warning 原样追加；缺失时不得凭空产生告警', () => {
  const warned = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
    body_warning: '请求体 20480 字节，已超过建议的 16384 字节：可考虑拆成多次调用，或缩小 state。',
  })[0];
  assert.match(warned.text, /^体积: state=20000B body=20480B$/m);
  assert.match(warned.text, /已超过建议的 16384 字节/);

  const plain = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 1,
    body_bytes: 2,
  })[0];
  assert.doesNotMatch(plain.text, /超过建议/);
});

test('体积口径：字段缺失时不打印该行（向后兼容）', () => {
  const [block] = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
  });
  assert.doesNotMatch(block.text, /体积:/);
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test "test/*.test.mjs"
```

Expected: FAIL —— **三条**新用例失败（纯数字题名当前会被放行；`体积:` 行当前不存在；告警不会被打印）。
> **勘误（控制器）**：本节初稿写"新增四条用例失败"，**是错的** —— 第四条「字段缺失时不打印该行」是否定式守卫，在实现之前天然为绿。这是控制器的错误陈述，不是实现者的偏差。

**Step 3 必须同时更新既有的 `LIMITS` 断言（控制器初稿漏了这一步，导致 Step 3 与 Step 4 自相矛盾）**

`test/validate.test.mjs` 里 `test('LIMITS 与服务端文档一致')` 对本对象做**严格 `deepEqual`**，多一个键必红 ⇒ 只加 `softBodyBytes` 而不同步它，逐字执行会得到 **37 pass / 1 fail**，永远到不了下面 Step 4 声称的 38/0。

**处置要求**：**不要**把该断言改成逐键子集比较 —— 那会削弱"LIMITS 被冻结"的强度。正确做法是在期望对象里补上 `softBodyBytes: 16384`（**仍是全键严格相等**），并加注释点明它**不是服务端限制、是本地策略阈值**。当前提交 `5b015ba` 已按此处置。

- [ ] **Step 3: 写实现**

`lib/validate.js` —— `LIMITS` 增加一项（**策略值，不是实测值**）：

```js
export const LIMITS = {
  maxQuestions: 64,
  minOptions: 2,
  maxOptions: 26,
  maxBodyBytes: 65536,
  /**
   * 体积告警的**策略**阈值（硬上限的 1/4），**不是**实测退化点。
   * 超过它只让工具层产出一行提示、让模型有机会自行拆批，**不改变任何拒绝行为**。
   * 本机从未测量「state 体积 → 判定质量」的曲线，故 description 里不得把它写成经验上限。
   */
  softBodyBytes: 16384,
};
```

`lib/validate.js` —— 在题名校验里，紧跟 `seenNames.add(question.name);` 之后插入：

```js
  // V2 续：题名不得是纯数字串。线格式把 questions 编码成 JS 对象映射，而对象的
  // 整数样键（"1"/"42"）会被重排到最前，静默破坏模型给的「有序批量」语义。
  if (/^\d+$/.test(question.name)) {
    throw new DecisionValidationError(
      `${at}.name 不能是纯数字（收到 ${JSON.stringify(question.name)}）：`
      + '线格式用对象映射承载 questions，纯数字题名会被 JS 重排键序，破坏「有序批量」语义；'
      + '请改用 q1 这类题名。',
    );
  }
```

`lib/render.js` —— `renderAnswers` 里，在 `usage` 段落之后、`return` 之前插入：

```js
  // 体积口径（需求 M2）：让「这次为什么慢 / 为什么退化」可归因，也让模型看得见
  // 自己离 64 KiB 硬上限还有多远。是否告警、阈值多少属于**策略**，由工具层决定并
  // 通过 body_warning 传入；render 只呈现 —— 保持纯函数、零 import。
  if (Number.isFinite(value?.state_bytes) && Number.isFinite(value?.body_bytes)) {
    lines.push(`体积: state=${value.state_bytes}B body=${value.body_bytes}B`);
  }
  if (typeof value?.body_warning === 'string' && value.body_warning !== '') {
    lines.push(value.body_warning);
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 38 个 test（15 + 9 + 14：validate + render + client）。
> 38 这个数是**含**上文「同步 `LIMITS` 断言」之后的。漏掉那一步会得到 37/1 —— 这正是控制器初稿的缺陷。

---

### Task 7 · 修复轮 1（Task 7 评审后追加；**三处全部计数中立，仍是 38**）

评审判 Approved，但指出一处**真实的测试缺口**：用例 B 的「无告警」fixture 用了 `body_bytes: 2`，**低于软阈值** ⇒ 一个**在 `render.js` 里硬编码自己那份 16384 阈值**的实现能通过全部用例 —— 而 §4.8 明令**策略不得进入渲染层**。也就是说那条架构约束当前**不可验证**。本修复轮把它变成可验证，并顺手关掉两个同文件的计数中立项。

- [ ] **Step R1: 改三处（只动两个测试文件）**

**(a) 用例 B 的负例 fixture 必须**高于**阈值** —— 这是本轮的主项。`test/render.test.mjs`：

```js
test('体积告警：body_warning 原样追加；无字段时不得凭空产生告警（即使已超阈值）', () => {
  const warned = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
    body_warning: '请求体 20480 字节，已超过建议的 16384 字节：可考虑拆成多次调用，或缩小 state。',
  })[0];
  assert.match(warned.text, /^体积: state=20000B body=20480B$/m);
  assert.match(warned.text, /已超过建议的 16384 字节/);

  // 关键：body_bytes **高于**软阈值却**不带** body_warning ⇒ 必须没有任何告警。
  // 若 render 自己内联了 16384 这个阈值，这一条会红 —— 它钉住的正是
  // 「策略属于工具层，render 只呈现」这条 §4.8 约束。
  const plain = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 20480,
  })[0];
  assert.doesNotMatch(plain.text, /超过建议/);
  assert.match(plain.text, /^体积: state=20000B body=20480B$/m);

  // 空字符串与「没有该键」必须同义：不得打印空行（否则模型会读到一行空白）。
  const empty = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    body_bytes: 20480,
    body_warning: '',
  })[0];
  assert.doesNotMatch(empty.text, /\n\s*$/);
  assert.equal(empty.text, plain.text.replace('state=20000B body=20480B', 'body=20480B'));
});
```

> 注：末条比较用拼接而非硬编码整串，是为了同时钉住「空串 == 缺键」且不把列宽写死。若实现者发现更直接的等价写法，可用，但**必须同时断言：空串与缺键的输出逐字相同**。
>
> **控制器勘误（本节初稿第六处错误）**：初稿写的 `plain.text.replace('state=20000B body=20480B','body=20480B')` **按字面执行必红** —— render 要求 `state_bytes` 与 `body_bytes` **同时有限**才打印体积行，而初稿给 `empty` 只补了 `body_bytes`。实现者依本节自家授权改用等价且更强的写法：给 `empty` 补 `state_bytes: 20000` 后直接 `assert.equal(empty.text, plain.text)`。**该写法必须与前面那条 `assert.match(plain.text, /^体积: state=20000B body=20480B$/m)` 同时存在** —— 否则「两个输出相等」是自指的，降级为只证明二者同形、不证明内容。

**(b) LIMITS 用例改名**（`test/validate.test.mjs`）—— 现在它锁的 5 个键里有 1 个不是服务端限制，名字说大了：

```js
test('LIMITS 冻结：4 项服务端硬限 + 1 项本地策略阈值', () => {
```

**(c) V2 报错里的补救子句补断言**（`test/validate.test.mjs`）—— 现在只 match 了「不能是纯数字」，没钉住它告诉调用方怎么办：

```js
  expectReject(
    base({ questions: [{ name: '1', type: 'noul', instructions: 'x' }] }),
    /不能是纯数字[\s\S]*请改用 q1/,
  );
```

**(d) `LIMITS.softBodyBytes` 的注释不得断言一个会失效的推导**（`lib/validate.js`）。现注释写「硬上限的 1/4」，而值是字面量 `16384` ⇒ 将来 `maxBodyBytes` 一旦变动，这句话**静默变假**（正是本项目反复出现的「文档与实现漂移」）。改为不依赖推导的措辞：

```js
  /**
   * 体积告警的**策略**阈值，**不是**实测退化点：超过它只让工具层产出一行提示、
   * 让模型有机会自行拆批，**不改变任何拒绝行为**。
   * 本机从未测量「state 体积 → 判定质量」的曲线，故 description 里不得把它写成经验上限。
   * 取值参照当时的硬上限（65536 的 1/4 = 16384）；**若 maxBodyBytes 变动，此处需重新评估**。
   */
  softBodyBytes: 16384,
```

**(e) 不改**：§4.8 说告警「紧随其后」，而实现让两条独立判定 ⇒ 理论上 `body_warning` 可以不带 `体积:` 行出现。评审者判定**不可达**（Task 4 的契约只在两个字节字段都有限时才产出告警），并明确建议**不要改** —— 因为「因为兄弟字段缺失就把告警吞掉」比多打一行更糟。控制器采纳：保持实现，仅在 §4.8 加一句说明。

- [ ] **Step R2: 跑测试**

```bash
node --test "test/*.test.mjs"
```

Expected: PASS —— `# fail 0`，共 **38** 个 test（计数不变：本轮只改 fixture 与断言，不新增用例）。

- [ ] **Step R3: 变异自检（本轮必须做的三枪，且每枪先证明落地）**

1. **主项**：在 `lib/render.js` 里把告警改成**内联策略阈值**（例如 `value.body_bytes > 16384` 就直接 push 固定文案）⇒ **(a) 的 `doesNotMatch` 必须变红**。若它仍绿，说明本轮的加固没生效。
2. 删掉 `&& value.body_warning !== ''` ⇒ **(a) 的空串断言必须变红**（此前这一枪是 38/38 全绿 = 无承重）。
3. 把 `LIMITS` 断言改回四项子集比较 ⇒ **(b) 改名后的用例**应仍绿（改名不影响强度），但**全对象 `deepEqual` 被换成子集时必须红** —— 若不然，说明断言被削弱了。

> **控制器勘误（Step R3-3 的期待无法达成）**：实测「换成子集断言」在**无漂移时恒真**，做不到"必须红"。正确的变异设计是**子集 + 注入漂移**：把 `LIMITS.softBodyBytes` 由 `16384` 改成 `8192`，则子集断言**仍全绿**，而全对象 `deepEqual` **立即红**。实现者据此执行并如实报告（未伪造必红运行）—— 那正是本轮要证明的事：**出厂断言的强度未被削弱**。

- [ ] **Step R4: LF 与提交**

四个文件 CR=0；提交信息说明「本轮把 §4.8 的『策略不进渲染层』从不可验证变为可验证」，并注明计数仍为 38。


- [ ] **Step 5: 语法与 LF 校验**

```bash
node --check lib/validate.js
node --check lib/render.js
for f in lib/validate.js lib/render.js test/validate.test.mjs test/render.test.mjs; do
  printf '%s CR=%s\n' "$f" "$(tr -cd '\r' < "$f" | wc -c)"
done
```

Expected: 两个 `node --check` 均通过；四个文件 `CR=0`（真实字节计数，不得靠 grep 目视）。

- [ ] **Step 6: 提交**

```bash
git add lib/validate.js lib/render.js test/validate.test.mjs test/render.test.mjs
git commit -F - <<'MSG'
feat(delta): 题名禁纯数字串 + 返回值体积可归因

来源：匿名调研输入（无出处、无归属；用户 2026-10-04 裁定：不入库、不引用、归匿名材料）。
用户 2026-10-04 裁定其为「参考输入，非约束」；控制器按技术价值取舍后采纳两件
便宜且已明确的事，重项（引用式 state、审计 JSONL、orderPolicy）进规格 §10 的 v2 台账。

1. V2 续：题名不得为纯数字串。线格式把 questions 编码成 JS 对象映射，对象的整数样键
   （"1"/"42"）会被重排到最前，静默破坏「有序批量」语义 —— 这一条在 ADR-6 里被记录为
   「已知边界」却一直没有禁止，本次堵上。规则用 /^\d+$/ 比实际的整数索引集合略宽
   （"01" 不会被重排但同样会拒），宁可多拒也不错排。

2. 体积可归因：render 在 value 带 state_bytes/body_bytes 时追加一行体积口径，并在
   body_warning 存在时原样追加告警行。阈值与告警策略留在工具层（Task 4）——
   render 保持纯函数、零 import。LIMITS.softBodyBytes = 16384 明确标注为**策略值**
   （硬上限的 1/4），不是实测退化点；本机没有测过「state 体积 → 判定质量」的曲线，
   故 description 里不得出现任何未经测量的「经验批量上限」。

新增 4 条用例（validate 1 条、render 3 条）。此后计数口径为 15/9/14，合计 38。
MSG
```

---

### Task 7 · 修复轮 2（限定范围复审后追加；**只动 `test/render.test.mjs`，计数仍 38**）

复审判 **可以进 Task 4**，但给了一条**控制器本身就该想到的** Important：修复轮 1 的保证**依赖措辞** —— 负例只用 `doesNotMatch(/超过建议/)` 这个**子串**匹配，所以一个**换种说法**内联阈值的实现（例如 `体积超过 16384 字节的建议值`）能通过全套。它手上有更强的惯用法（`assert.equal(text, '<literal>')`，同文件 :76 已在用），却把它用在了自指比较上。

**本轮把保证从「依赖措辞」升级为「逐字全文」，并把阈值取值依赖一并关掉。**

- [ ] **Step S1: 三处改动，全在同一用例内（不新增用例）**

**(a) 给 `plain` 补一条逐字全文相等**（紧挨现有的 `doesNotMatch` / 体积行正则之后，它们保留作为可读意图）：

```js
  assert.equal(plain.text, 'q  noul    P(true)=0.4751\n体积: state=20000B body=20480B');
```

**(b) 再加一个极端值 fixture，关掉「内联其它有限阈值」这一类**（含复审指出的 `65536` 变体）：

```js
  // 任何「在 render 里比较某个有限阈值」的实现都会在这里多打一行 ⇒ 逐字相等打红。
  // render 是纯函数，这个值在单测里完全合法（它不可能来自生产路径，那由 V8 挡住）。
  const huge = renderAnswers({}, {
    model: 'tev1:0.8b',
    answers: { q: { type: 'noul', noul: 0.4751 } },
    state_bytes: 20000,
    body_bytes: 1e15,
  })[0];
  assert.equal(huge.text, 'q  noul    P(true)=0.4751\n体积: state=20000B body=1000000000000000B');
```

**(c) 把 fixture↔常量 的耦合从「文档」变成「红灯」**（复审 Minor 4；需在文件顶部加 `import { LIMITS } from '../lib/validate.js';`）：

```js
  // 这条负例的全部意义在于 body_bytes **高于**软阈值；常量一旦被调高越过它，
  // 该用例会静默退化成恒真 —— 这行把那种退化变成红灯。（同理，上面的 1e15 不受影响。）
  assert.ok(20480 > LIMITS.softBodyBytes, '负例 fixture 必须高于 softBodyBytes，否则本条恒真');
```

- [ ] **Step S2: 跑测试** —— `node --test "test/*.test.mjs"` → 仍 **38/38**。

- [ ] **Step S3: 变异自检（两枪，每枪先证落地）**

1. 在 `lib/render.js` 里内联 `body_bytes > 16384` 且**换一种措辞**（例如文案改为 `体积超过 16384 字节的建议值`，**不含** `超过建议` 四字连排）⇒ **(a) 的逐字全文相等必须变红**。这一枪正是修复轮 1 会漏掉的那一支。
2. 内联 `body_bytes > 65536`（同一措辞不改）⇒ **(b) 的 `1e15` fixture 必须变红**。

- [ ] **Step S4: LF 与提交** —— 文件 CR=0；提交信息写明"把 §4.8 该保证从依赖措辞升级为逐字全文，并覆盖任意有限阈值"，注明计数仍 38。

# dsh-decision-tools — 设计规格

| 项 | 值 |
|---|---|
| 日期 | 2026-10-04 |
| 状态 | 设计已获用户批准（2026-10-04），本文件为待复核规格 |
| 工作区 | `F:\Dinosaur_MC\Studio\Project\dsh-decision-tools` |
| 目标 profile | `web`（`C:\Users\Dinos\.dsh\profiles\web`） |
| 决策来源 | 用户选择「A. DSH 插件：把 decision 能力做成 agent 工具」+「1. 单工具 `decision` + 数组式 `questions`」 |

---

## 1. 背景与问题

Ollama v0.35.0 起提供 System One 决策能力（`POST /v1/systemone`），由专门的 decision 模型回答**有界判定**：从枚举中选一个（`choice`）、估计是/否概率（`noul`）、按有序档位打分（`score`）。

这类判定在 Agent 循环里出现频率极高（意图路由、相关性过滤、RAG 重排序、候选打分、安全护栏），却通常被塞进昂贵的生成式 LLM。本机已具备全部前提：Ollama 在跑、三个 decision 模型已下载。缺的是**把它们接到 DSH agent 手上的那一层**。

本插件就是那一层：把 System One 暴露成一个模型可见工具，让 agent 用毫秒级、零 token 生成的本地判定替代高频的 System 2 推理。

## 2. 已冻结的现场事实（全部为本机实测，非推断）

| 事实 | 实测值 |
|---|---|
| Ollama 版本 | `0.35.1`（`/api/version`） |
| 端点 | `POST http://localhost:11434/v1/systemone`，本地请求无需 API key |
| decision 模型 | `tev1:0.8b`（752M/Q8_0）· `tev1:latest`（4.2B/Q8_0）· `clef-flash:latest`（9.1B/Q8_0，声明带视觉）；三者 `capabilities` 均为 `["decision"]` |
| 三型混用 | 同一请求内 `choice`+`noul`+`score` 可并存，返回结构符合 OpenAPI |
| `tev1:0.8b` 实测 | 冷启 ~12.0s 返回；`label=bug`(0.959)、`refund=0.475`、`urgency=1.154` |
| `tev1:latest` 实测 | 冷启 ~18.5s；`label=billing`、`refund=0.040`、`urgency=1.914` —— **与 0.8B 结论不同** |
| `clef-flash:latest` 实测 | **任何请求都 500**：`{"error":{"code":500,"message":"Clef: non-finite logit"}}`。已复现三种：纯文本多题、带 base64 图片、最小单题 `noul` |
| `noul` 命名 | 唯一合法字符串是 `noul`；写 `boolean` 会 400（本次实测踩到） |
| 服务端硬限 | 无图 ≤64 KiB、带图 ≤32 MiB；`questions` 1–64 个；`choice`/`score` 选项 2–26；不支持流式与 tools |
| `confidence` 语义 | `1 − H(p)/ln(N)`，分布集中度，**不是**校准正确率 |
| `score` 语义 | 档位下标（0 基）的概率加权平均，范围 `0..N-1`，**不归一化到 0–1** |

### DSH 接口事实（同样实测，来自已装包与本机先例）

| 事实 | 来源 |
|---|---|
| 工具注册 | `ctx.tools.register(defineTool({...}))`，`defineTool` 由 `@deepseek-ai/dsh-tools@0.2.0-rc.2` 导出 |
| 硬依赖注入 | `inject: ['tools']` 即可满足本插件（不注册 prompt 段，见 ADR-5）。`'systemPrompt'` 也是有效键，但本插件不再需要 |
| 参数 DSL | `ParameterSchemaSpec`：标量 / `array{items}` / `object{properties, additionalProperties(必填)}` / `json` / `oneOf`(≥2 分支)；必填是逐属性的 `required: true` |
| 结果 schema | `output: { schema: ValueSchemaSpec, render(args, value) => ContentBlock[] }`；宿主会用它对**每个成功返回值**强校验 |
| prompt 段（本插件不使用，见 ADR-5） | `ctx.systemPrompt.section({ name, order, text })`，`order` 应取自中央注册表 `ctx.systemPrompt.getSectionOrder("NAME")`。**实测三条**：①`SECTION_ORDERS` 的 32 个具名槽位（`HARNESS_IDENTITY:-1000` … `DEPLOYMENT_PERSONA_SUFFIX:10200`）**全部被第一方占用，没有留给第三方工具的槽位**；②`getSectionOrder` 是裸查表，未注册名返回 `undefined`，随即被 `section()` 的 finite 检查抛错；③`section()` 只拦非有限 order，去重键是 `name` 而非 `order` ⇒ 裸魔数不会被拦住，同 order 合法 |
| 配置 | `@deepseek-ai/schemastery` 的 `z`。**没有 `.optional()`**，可选性写 `.required(false)` |
| 免构建先例 | `G:\LAB\202608\dsh-win-multi-bash`：手写 ESM `lib/*.js` + `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 的 `insert:` 行 |

## 3. 架构决策

### ADR-1：构建策略 = 纯 JS 免构建（方案 A1）

**决定**：手写 ESM `lib/*.js`，不引入 TypeScript/tsup/vitest。

**理由**：本插件总量约 300 行 = 一个 HTTP 客户端 + 一个工具定义。类型收益有限，而 `install_bundle` 安装的是目录，免构建意味着改一行即生效、不存在「源码与产物漂移」这一类故障。先例 `dsh-win-multi-bash` 已验证该形态可用。

**代价与缓解**：失去静态类型检查 ⇒ 用 `node --check`（语法）+ `node:test`（契约）+ JSDoc `@type`（关键边界）三件套兜底。

**升级触发条件**：若模块数超过 5 个、或需要 UI/Client 半边，则升级到 TS + tsup（先例 `dsh-letta-memory`）。

### ADR-2：工具面 = 单工具 + 数组式 `questions`

**决定**：只注册一个工具 `decision`；`questions` 是有序数组，每题带 `name`/`type`，按 `type` 判别。

**理由**：多题共享同一 `state`，一个 HTTP 请求完成。过滤与重排天然是多条目场景（N 篇文档各判一次），拆成多工具会把 `state` 重复传输 N 次 —— 大 `state` 下这是数量级差别，且每次调用都要重新竞争模型锁。此外工具定义常驻上下文，一个定义比三个便宜。

**代价与缓解**：schema 嵌套一层数组 + 一处 `oneOf`。缓解手段是在 description 里给出两个完整示例（单题、三型混合）。

### ADR-3：v1 不做视觉

**决定**：不提供 `images` 参数。

**理由**：本机仅有的视觉 decision 模型 `clef-flash` 在 0.35.1 上完全不可用（连最小单题都 500）。而在 agent 场景里透传 base64 本身也是错设计 —— 图片 base64 会先塞满模型上下文（1 MB 图 ≈ 1.3 M 字符），远比收益大。真正可用的视觉支持应当接受**文件路径**并由插件侧读盘编码，那是一件独立工作。

**触发条件（v3）**：上游修复 `clef` 的 `non-finite logit` 后，实现「路径式」`images`。

### ADR-4：`model` 必须可逐次覆盖

**决定**：配置提供 `defaultModel`，工具参数提供可选 `model` 覆盖。

**理由**：实测同一题 0.8B 与 4.2B 给出不同答案（`bug` vs `billing`），而 4.2B 的答案在题面（500 错误、结账不可用）下并不更合理。**不存在「大就是好」**，调用方需要能按题选模型并自行测量。

### ADR-5：不注册 prompt 段，指引只放在工具 description

**决定**：`inject` 只需 `['tools']`；不调用 `ctx.systemPrompt.section()`；所有使用指引（何时用/何时不用、`noul` 是概率、`confidence` 不是正确率、`score` 的 0..N-1 尺度、一批多题）全部写在 `TOOL_DESCRIPTION` 里。原 `DECISION_SECTION` 中描述里没有的两点（「0.475 不等于否」的具体例子、「低置信度就升级给自己」）**并入 description**。

**理由（三条，按分量排序）**：

1. **重复**。原计划的 prompt 段与工具 description 逐句比对约 85% 同义，等于把同一份指引发两遍，prompt 成本翻倍而信息量不增。
2. **没有合法槽位可放**。实测 `SECTION_ORDERS` 的 32 个具名槽位全部被第一方占用（`TOOL_*` 由各工具具名占用、`MCP_SERVERS` 由 `dsh-mcp-client` 占用、`TOOLS_SDK` 由 `dsh-tools` 本体的 `tools:sdk` 段占用），**没有留给第三方工具的槽位**；而 `getSectionOrder(name)` 是裸查表，传未注册名得到 `undefined`，会被 `section()` 的 finite 检查抛错。所以任何写法都只能二选一：裸魔数（不受中央管理、且可能撞上未来新增槽位），或借用别人的槽名（语义不实）。
3. **机制强度**。`practices.md` 原则 4 要求「use the weakest mechanism that suffices」。工具 description 只在该工具被考虑时呈现，比全局 prompt 段更聚焦；而 `practices.md` 也明确「Do not listen to `system-prompt/assemble` to add or remove tools or text」。

**代价与接受**：失去一条全局行为提醒（「有界判定优先用 decision，而不是自己猜」）。这个提醒本就写在 description 里；若日后实测发现模型在明显该用 decision 的场合不用它，再按 ADR-6 重开此议题 —— 届时必须先用 `cordis_inspect_query` 查清当时的注册表是否有新槽位。

**撤回的旧写法**：本规格早期版本写过 `ctx.systemPrompt.section({ name: 'tool:decision', order: 105 })`。该 `105` 抄自 `G:\LAB\202608\dsh-win-multi-bash` 里 **vendored 的 0.1.7 时代副本**，不是现行惯例：现行版本全部 26 处 section 注册**无一使用裸数字**，一律 `getSectionOrder("NAME")`。105 落在 `DEPLOYMENT_PERSONA_PREFIX(0)` 与 `PLAN_POLICY(500)` 之间，而工具段位全部在 1000–3000 —— 不只是魔数，还在**错误的 band** 里。

### ADR-6：`questions` 在线格式上是**对象映射**，工具对模型暴露**数组** —— 中间必须有一次转换

**决定**：工具对模型暴露 `questions` 为**有序数组**（ADR-2），而发往 `POST /v1/systemone` 的 body 里 `questions` 必须是**对象映射** `{ "<题名>": { type, instructions, criteria? } }`。这一步转换由 `lib/validate.js` 的 `prepareRequest` 承担，且**必须发生在 64 KiB 体积检查之前**（体积按真实线格式度量）。

**实测依据（本机 Ollama 0.35.1，各打一次真机）**：

| 形状 | 结果 |
|---|---|
| 数组 | **HTTP 400** `{"error":"Value looks like object, but can't find closing '}' symbol"}` —— **0.071s** 返回 ⇒ 在请求体**解析**阶段即失败 |
| 对象映射 | **HTTP 200**，答案与 `usage` 正常 |
| 对象映射但每题**保留 `name` 字段** | **HTTP 200** ⇒ 转换可以**无损地保留原问题对象**，无需剥字段 |
| **空**对象映射 | **HTTP 400** `questions must contain 1–64 fields` |

官方 OpenAPI 亦明写 `questions: type: object`，`minProperties: 1`、`maxProperties: 64`、`additionalProperties` 为三种问题类型之一。

**为什么必须记进 ADR**：ADR-2 选择数组是**面向模型**的决定（数组有序、模型不易漏题名）；对象映射是**面向服务端**的约束。两者之间的转换是 ADR-2 的**必然代价**，而本规格早期版本、实施计划与已交付代码**三处都漏了这一步** —— 后果是每次真实调用都 400，而本地 32 个用例**全绿**：假服务只记录请求体、不校验形状。这是"本地全绿 + 真机全挂"的教科书形态，**只有端到端验收能拦住**。

**连带教训（已写进测试计划 §6）**：假服务必须**照真实服务端的样子拒绝错的形状**，否则整套本地测试在结构上无法发现线格式违规。已给 `test/fake-ollama.mjs` 加守卫：`questions` 不是普通对象即返回同样的 400。这是**结构性**对策，不是补一条用例。

**V2（题名唯一）与本次转换的关系**：V2 不只是防答案混淆 —— 它正是让这个映射**有定义**的前提。重名会让后一个静默覆盖前一个。

**已知边界与已采取的处置**：JS 对象的整数样键会被重排到最前，因此若题名是纯数字字符串（如 `"1"`），线格式上的顺序会与模型给的数组顺序不同。服务端文档明确「答案不传给后续问题」，即**服务端侧**题目相互独立、顺序无语义影响 —— 但这一条**不足以**放行数字题名，理由有二：①ADR-2 对**模型**承诺的是**有序数组**，「有序批量」是模型可见的契约，而返回的 `answers` 是对象、会被重排；②重排是**静默**的，模型无从察觉。

**处置：V2 禁止纯数字题名**（见 §4.6 V2 与 `lib/validate.js`）。

> **规格勘误**：本 ADR 初稿在此处写过「V2 不禁止数字题名」并把顺序问题记为「不修，仅记录」。该结论**已作废** —— 需求 delta 采纳了「题名禁纯数字串」后，V2 已禁止，实现与用例同步落地。把这段留着是为了记录一次真实的**规格自相矛盾**（ADR 的边界段与校验规则段互相打架），它由 Task 7 的评审发现；教训是：**当一条规则从「记录边界」升级为「禁止」时，必须同时回改所有把它记为「不禁止」的地方**，否则绑定文档会开始自我否证，而下游任务只读其中一处。

## 4. 组件设计

### 4.1 包结构

```
dsh-decision-tools/
├─ package.json                  # name/version/type=module/exports/dsh.bundle.patch/files
├─ cordis.patch.yml              # insert 一行：decision
├─ lib/
│  ├─ index.js                   # 包入口：re-export name/inject/Config/apply from ./tool.js
│  ├─ client.js                  # SystemOneClient
│  ├─ validate.js                # 本地前置校验（纯函数，便于单测）
│  ├─ render.js                  # answers → ContentBlock[]
│  └─ tool.js                    # defineTool 定义 + apply()
├─ test/
│  ├─ fake-ollama.mjs            # node:http 假服务，供各测试复用
│  ├─ client.test.mjs
│  ├─ validate.test.mjs
│  ├─ render.test.mjs
│  ├─ parameters.test.mjs        # 契约结构不变量（零 DSH 依赖，因 parameters.js 零 import）
│  └─ tool.test.mjs              # 装配与端到端（对假 Ollama）
├─ smoke/live.mjs                # 可选真机冒烟（不进 CI、不入包）
├─ README.md · README.zh.md
├─ LICENSE (MIT) · THIRD_PARTY_NOTICES
├─ .gitattributes
└─ .temp/                        # 探测产物，已 gitignore
```

**边界原则**：`client.js` 只管 HTTP 与错误映射，不知道 DSH 的存在；`validate.js`/`render.js` 是纯函数，零 DSH 依赖，可独立测试；只有 `tool.js` 接触 `ctx`。这样核心逻辑不绑定 harness，将来若要做 CLI 或评测装置可直接复用。

### 4.2 `cordis.patch.yml`

```yaml
- insert:
    - id: decision-tools-tool
      name: 'dsh-decision-tools'
      # 无 disabled 条件：本插件不依赖平台，任何环境都注册。
      # 可选 per-machine 覆盖（patch 会替换整行 config，启用时重述全部字段）：
      #   baseUrl: 'http://localhost:11434'
      #   defaultModel: 'tev1:0.8b'
```

`package.json` 侧：

```json
{
  "name": "dsh-decision-tools",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
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

**行与模块的对应关系（实现时不得弄反）**：

| 概念 | 取值 | 出处 |
|---|---|---|
| patch 行的 `name`（模块说明符） | `dsh-decision-tools` | 包根，经 `exports["."]` 解析到 `lib/index.js` |
| 插件身份 `name` 导出 | `'decision-tools'` | `lib/tool.js` 定义，`lib/index.js` 转出 |
| 模型可见的工具名 | `config.toolName`，默认 `'decision'` | `defineTool({ name })` |

**为什么用包根而不是子路径**：只注册一个工具，不需要多入口，`exports` 保持单点；先例用子路径是因为它有两个工具需要两行两个入口。

`lib/index.js` 的全部内容：

```js
export { name, inject, Config, apply } from './tool.js';
```

### 4.3 `lib/client.js` — SystemOneClient

```js
/** 决策调用失败。kind 见 4.7 映射表，供上层分支与渲染使用。 */
export class SystemOneError extends Error {
  /** @param {string} message @param {{ kind: string, status?: number, hint?: string }} info */
  constructor(message, info) {
    super(message);
    this.name = 'SystemOneError';
    this.kind = info.kind;
    this.status = info.status;
    this.hint = info.hint;
  }
}

export async function callSystemOne({
  baseUrl, body, timeoutMs, signal, fetchImpl = fetch,
}) { /* 见 4.3 职责 1–4 */ }
```

**职责**：

1. 发送**已组装好的** `body`（`{ model, state, questions }` + 可选 `keep_alive`）。**`questions` 的数组→对象转换与 64 KiB 体积检查都不在这里** —— 两者都在 `prepareRequest`（见 **ADR-6** 与 §4.6 的 V8/V10）。本函数不对 body 的形状做任何假设，它只负责传输。
2. 超时：`AbortSignal.timeout(timeoutMs)` 与调用方 `signal` 用 `AbortSignal.any([...])` 合并。**这个合并是硬要求，不是优化**：调用方取消时必须在毫秒级**真正中止** `fetch`，**不得**退化成等 `timeoutMs` 到点。退化的代价是隐蔽的 —— 分类仍可能正确地报 `aborted`（因为另有 `signal?.aborted` 检查），但 socket 会白白挂到超时上限（默认 120s）。该性质由 `test/client.test.mjs` 的**耗时断言**钉住（< 2000ms，而该用例的 `timeoutMs` 是 30000），仅靠 `kind` 断言无法发现退化。
3. 响应解析与错误映射（见 §4.7）。**body 读取本身也必须被守卫**：响应头已到达、body 尚未读完时 socket 断开（undici 抛 `TypeError: terminated`），或信号在读取途中触发 —— 两者都必须映射成带 `kind` 的 `SystemOneError`（见 §4.7 的 mid-body 行），不得逃成没有 `kind` 的裸错误，否则按 `kind` 分派的上层会把它当成未处理异常。
4. 成功时返回 `{ answers, usage }` **原样**，不重写、不归一化。

**可测试性**：`fetchImpl` 与 `signal` 均可注入 ⇒ 单测无需真实网络；`baseUrl` 可指向假服务端口。

### 4.4 `lib/tool.js` — 工具定义与 `apply()`

```js
export const name = 'decision-tools';        // 插件身份，不是工具名
export const inject = ['tools'];              // 只注册工具，不碰 systemPrompt（ADR-5）
export const Config = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  defaultModel: z.string().default('tev1:0.8b'),
  timeoutMs: z.number().default(120000),
  toolName: z.string().default('decision'),  // 这才是模型看到的工具名
  // keepAlive 可为 "5m" 这类时长串或秒数；未设则不下发该字段，用服务端默认 5m。
  // 已实测确认（schemastery 3.18.4）：z.union 存在；可选性用 .required(false) ——
  // 该库**没有** .optional()，写它会在插件加载时直接抛错。
  // Config({}) 实测得到 {baseUrl, defaultModel, timeoutMs, toolName}（keepAlive 被省略）。
  keepAlive: z.union([z.string(), z.number()]).required(false),
});

export function apply(ctx, config) {
  // 只注册工具。使用指引全部在 description 里，不注册 prompt 段（ADR-5）。
  ctx.tools.register(defineTool({
    name: config.toolName, description, parameters, output, execute,
  }));
}
```

`execute(args, exec)` 流程：`validate` → `callSystemOne` → 返回 `{ answers, usage }`。

### 4.5 参数 schema（精确）

```js
const contentSpec = {
  oneOf: [
    { type: 'string', description: '...' },
    { type: 'object', additionalProperties: true, description: '...' },
    { type: 'array', items: { type: 'json' }, description: '...' },
  ],
};

const parameters = {
  state: { required: true, ...contentSpec, description: '所有问题共享的待判定材料。' },
  questions: {
    required: true,
    type: 'array',
    description: '1–64 个问题，共享 state，按 type 判别。',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name:         { type: 'string', required: true, description: '问题标识，答案以它为键返回。' },
        type:         { type: 'string', required: true, enum: ['choice', 'noul', 'score'] },
        instructions: { required: true, ...contentSpec },
        criteria:     { description: 'choice=键→描述对象；score=由低到高的字符串数组；noul 可省略。',
                        oneOf: [
                          { type: 'object', additionalProperties: true },
                          { type: 'array', items: { type: 'string' } },
                        ] },
      },
    },
  },
  model: { type: 'string', description: '覆盖默认模型（默认 tev1:0.8b）。' },
};
```

**注意**（实现时不得省略）：
- `object` 节点**必须**写 `additionalProperties`，否则 DSL 编译报错。
- `oneOf` **至少两个分支**。
- `questions[].criteria` 用 `oneOf` 而非 `json`，是为了把「对象还是数组」这一最常见的误用挡在本地。
- 顶层参数是**隐式开放对象**，`required: true` 是逐属性注解，不是参数根上的数组。

### 4.6 本地校验规则（`lib/validate.js`，发请求前执行）

| # | 规则 | 违反时的消息要点 |
|---|---|---|
| V1 | `questions` 为数组且长度 1–64 | 「questions 有 N 题，服务端上限 64」 |
| V2 | 每题 `name` 为非空字符串、全局唯一、**且不得为纯数字串**（`/^\d+$/`） | 「问题名重复：X」；纯数字则「不能是纯数字（如 `"1"`）：线格式用 JS 对象映射承载 questions，整数样键会被 JS 重排到最前，破坏『有序批量』语义，请改用 `q1` 这类题名」 |
| V3 | `type ∈ {choice, noul, score}` | 「不支持的类型 X（合法：choice/noul/score）」 |
| V4 | `choice.criteria` 是对象，选项数 2–26，键非空 | 「choice 'X' 有 N 个选项，合法范围 2–26」 |
| V5 | `score.criteria` 是字符串数组，长度 2–26 | 「score 'X' 有 N 档，合法范围 2–26」 |
| V6 | `score.criteria` 为数组形态（对象形态明确报错） | 「score 的 criteria 必须是由低到高的数组」 |
| V7 | `noul.criteria` 若存在，只允许 `false`/`true` 键 | 「noul 只接受 false/true 两个键」 |
| V8 | 序列化 body ≤ 65536 字节 | 「请求 N 字节，超过 64 KiB 上限；请缩减 state 或拆分请求」 |
| V10 | **数组 → 对象映射**（ADR-6）：`body.questions` 必须是 `{ 题名: 问题对象 }`，且该转换在 V8 的体积度量之前完成 | 不面向用户报错；转换是构造步骤，其正确性由契约用例与假服务守卫共同钉住 |
| V9 | `model` 若提供则为非空字符串 | 「model 不能为空」 |

**设计意图**：把服务端的 400/413 变成**模型能据此改正的**错误消息。服务端原始报错（如 `question "urgent": type must be choice, noul, or score`）虽然准确但不含合法值清单，模型容易重犯。

### 4.7 错误映射表（`client.js`）

| 触发 | `kind` | 消息 |
|---|---|---|
| `fetch` 抛 `ECONNREFUSED` / `TypeError: fetch failed` | `unreachable` | 「Ollama 未在 {baseUrl} 运行（启动：`ollama serve`）」 |
| `AbortError` 且由 `timeoutMs` 触发 | `timeout` | 「{model} 在 {timeoutMs}ms 内未返回；首次调用含模型加载（实测 0.8B ~12s / 4.2B ~18.5s），可调大 timeoutMs」 |
| HTTP 404 | `model_missing` | 「模型 {model} 未下载：`ollama pull {model}`」 |
| HTTP 413 | `too_large` | 「请求体超过服务端上限（无图 64 KiB）」 |
| HTTP 400 | `invalid_request` | 原样带出服务端 `error` 字段 + 我们的定位提示 |
| HTTP 500 且 body 含 `non-finite logit` | `model_broken` | 「{model} 在 Ollama 0.35.1 上有已知缺陷（Clef: non-finite logit），请改用 tev1 系模型」 |
| HTTP 500 其他 | `server_error` | 原样带出服务端 `error` |
| 2xx 但 body 非 JSON / 缺 `answers` | `bad_response` | 「Ollama 返回了无法解析的响应」 |
| 响应头**已到达**、body 读完前 socket 断开（undici `TypeError: terminated`），或信号在读取途中触发 | `unreachable`（读取中断连）/ `aborted` / `timeout`（信号） | 复用各自对应行的文案；见下方注 |

映射结果以抛 `SystemOneError` 表达；`tool.js` 把它转成工具错误结果（`isError`），**不吞异常、不降级为猜测**。

**注 · mid-body 终止的映射是已知不精确的（有意保留，不细化）**：响应头已到达、body 尚未读完时连接断开，会落到 `toTransportError` 里 `name === 'TypeError'` 的兜底分支，报成 `unreachable` 并提示「确认 Ollama 已在运行（`ollama serve`）」。此时连接其实**建立过**，那条提示略有误导。选择保留而非细化，理由有三：①这是 undici 的通用兜底，收紧它会把「连接根本没建立」这个最常见且提示最准确的情形一起误伤；②为此新增一个 `kind` 等于给上层加一条几乎不会出现的分支；③真实收益只是文案更准，而代价是一个新的映射面。**该映射已被 `test/client.test.mjs` 的 mid-body 用例钉住** —— 将来若要细化，必须同步修改那条用例的 `kind` 断言。

### 4.8 渲染（`lib/render.js`）

`output.schema` 用 `oneOf` 覆盖三型 answer（`choice`/`noul`/`score`）+ `usage`，保证结构化无损。

`render(args, value)` 输出紧凑文本，每题一行，末尾附体积口径：

```
label    choice  bug    p={bug=0.9593, account=0.0343, billing=0.0063}  conf=0.829
refund   noul    P(true)=0.4751
urgency  score   1.154 / 2  p={1=0.7075, 2=0.2234, 0=0.0691}  conf=0.304
(usage: input_tokens=799 output_tokens=4)
体积: state=101B body=634B
```

（题名列宽由最长题名决定；精确间距与小数位由 `test/render.test.mjs` 钉住，本示例仅供读形。）

**理由**：模型读逐行文本比读嵌套 JSON 更省 token、更不易误读；概率按降序排列，让「次优选项」可见（用于阈值判断与不确定性识别）。完整原始 JSON 仍可通过 `output.schema` 取到。

**体积口径（需求 M2，v1 采纳「可归因」部分）**：`value` 里可带 `state_bytes` / `body_bytes`（数值）与 `body_warning`（字符串，可选）。`render` 在三者存在时打印：

- 一行 `体积: state=<n>B body=<n>B` —— 让「这次为什么慢 / 为什么退化」可归因，也让模型看得见自己离 64 KiB 硬上限还有多远。
- 若 `body_warning` 存在，紧随其后原样打印一行 —— **策略由工具层决定，render 只负责呈现**（保持 `render.js` 无策略、无 import）。

  > 两条判定是**彼此独立**的（各看自己的字段），所以理论上 `body_warning` 可以不带 `体积:` 行出现。已评审并**有意保留**：那条路径在当前契约下不可达（工具只在两个字节字段都有限时才产出告警），而「因为兄弟字段缺失就把告警吞掉」比多打一行更糟。此处记明为有意选择，不是遗漏。

**为什么软阈值不是渲染层的判断**：阈值是**策略**（提示模型自行拆批），不是事实；把它放在 `tool.js` 里，`render.js` 就仍是纯函数。`LIMITS.softBodyBytes` 定义在 `validate.js`（limits 的唯一出处），且**明确标注为策略取值（硬上限的 1/4），不是实测退化点** —— 本机没有测量过「state 体积 → 判定质量」的曲线，因此 description 里**不得**写入任何未经测量的「经验批量上限」。

### 4.9 使用指引的落点：只有工具 description（ADR-5）

不注册 prompt 段（理由见 ADR-5）。全部指引写进 `TOOL_DESCRIPTION`，必须覆盖以下六点，缺一不可 —— 这六点原计划分散在 prompt 段与 description 两处，现合并到一处：

1. **何时用**：候选集合已知且有界（路由、分类、过滤、相关性、打分）；需要的是概率而非文字。
2. **何时不用**：开放式生成、需要推理链、候选要边想边发现 —— 留给 System 2。
3. **一批多题**：同一材料的所有问题放在**一次**调用里（上限 64 题）；不要循环一题一次调用，那会重复发送整个 `state`。
4. **`noul` 是概率不是布尔**：返回值是「真」的概率。带一个具体例子（`0.475` 不代表「否」，而是 47.5% 的概率为是）。
5. **`confidence` 是分布集中度不是正确率**：`1 − H(p)/ln N`。低 confidence 表示模型在多个选项间摇摆 ⇒ 此时应读 `probabilities` 而不是只看被选中的结论。
6. **低置信度时升级**：把该题交回自己的推理，而不是直接采信。

另外 description 里要顺带给出数值边界（`choice`/`score` 2–26 项；`score` 报在 `0..N-1` 尺度上、不归一化），因为这些是模型自己推不出来的。

**另有三点同样必须写进 description（需求 M4/M6，v1 采纳）** —— 它们是**安全/口径声明**，不是使用技巧，缺了会让上层误用这个工具：

7. **结论不能作为正确性证据**：`decision` 返回的是概率分布，**不是**「判定通过」的凭据。任何「放过 / 放行」的决定必须另有**产物级证据**；本工具的答案只能用于**初筛**，不得作为终局。
8. **路由不由 decision 决定**：该走哪条路由是**确定性规则**的职责（否则 decision 一挂就无法路由 —— 自举困境）。本工具**不得**成为任何 fail-open / fail-closed 策略的判据来源。
9. **不产文本就不许当证据源**：`tev1` 系只产概率、不产文本 ⇒ 任何「需要留下可读判据给人看」的场合，必须换生成类模型，不能拿本工具的输出去充数。

**并且**：description 里**不得**出现任何未经测量的「经验上限」（例如「一批最多 N 题最稳」）。已有的是**服务端硬限**（1–64 题、2–26 选项、64 KiB），照写；超出硬限的批量建议必须**先测再写死**，测之前不写。

### 4.10 配置项

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `baseUrl` | string | `http://localhost:11434` | Ollama 地址 |
| `defaultModel` | string | `tev1:0.8b` | 缺省模型；可被逐次 `model` 覆盖 |
| `timeoutMs` | number | `120000` | 单次请求上限（含冷加载） |
| `toolName` | string | `decision` | 注册名 |
| `keepAlive` | string \| number | 未设 | 透传 `keep_alive`；未设则用服务端默认 5m |

**刻意不做的配置**：并发闸、重试次数、缓存。前两者会掩盖模型/服务缺陷，后者在有 `keep_alive` 的前提下收益不明。

## 5. 数据流

```
模型 → decision 工具调用
        ↓ validate.js      （本地规则 V1–V9，违规即返回可行动错误，不发网络请求）
        ↓ client.js        （组 body → 体积守卫 → fetch + 超时/取消合并）
        ↓ POST /v1/systemone
        ↓ client.js        （2xx 原样解析 / 非 2xx 按表映射为 SystemOneError）
        ↓ render.js        （answers → 紧凑逐行文本）
     模型 ← 工具结果（含 usage）
```

## 6. 测试计划（零新增依赖）

| 文件 | 覆盖 |
|---|---|
| `test/fake-ollama.mjs` | `node:http` 起一个可编程假服务：按路由返回预设状态码/body，记录收到的请求体 |
| `test/validate.test.mjs` | V1–V9 全矩阵：64/65 题、重复名、非法 type、1/2/26/27 选项、score 传对象、noul 传非法键、65536/65537 字节、空 model |
| `test/client.test.mjs` | 三型正常返回（含 `usage`）、404→`model_missing`、413→`too_large`、400→`invalid_request`、500+`non-finite logit`→`model_broken`、500 其他→`server_error`、连接拒绝→`unreachable`、超时→`timeout`、非 JSON→`bad_response`、`AbortSignal` 合并可中断 |
| `test/render.test.mjs` | 三型渲染文本快照；概率降序；`score` 显示 `x / N-1` |
| `test/schema.test.mjs` | `parameterSchemaSpecToJsonSchema(parameters)` 投影快照；断言 `questions.items.additionalProperties === false`、`state` 有 3 个 `oneOf` 分支 |
| `smoke/live.mjs` | 可选：真打本机 Ollama，三型各跑一次并打印结论与耗时（默认不跑） |

**命令**
```
node --test "test/*.test.mjs"
```

**两个不能用的写法（本机 Node 22.22.1 实测）**：
- `node --test test/` —— 目录形式被当成模块路径去 `require`，报 `MODULE_NOT_FOUND`。必须用带引号的 glob。
- `node --check lib/*.js` —— `--check` 只接受单个文件；bash 会展开 glob 但只检查第一个之外的会报「too many arguments」。逐文件检查。

**严格性**：`client.test.mjs` 与 `validate.test.mjs` 必须能在**没有 Ollama 运行**的环境下通过（全靠假服务与注入）。`smoke/live.mjs` 是唯一依赖真机的入口。

## 7. 验收标准

1. 每个 `lib/*.js` 逐文件 `node --check` 通过，`node --test "test/*.test.mjs"` 全绿。
2. `plugin_manager(action=install_bundle, target=<包绝对路径>)` 返回 `application: applied`（此步会请求审批）。
3. `cordis_inspect_query(platform=host, provider=Tool, method=listTools)` 结果中出现 `decision`，且 `parameters` 含 `state`/`questions`/`model`。
4. 在本会话真调一次 `decision`（三型混合题），返回三型答案且 `usage` 有值 —— 证明端到端可用。
5. 故意传非法参数（如 65 题、`type:'boolean'`、重复 `name`），得到**可行动的**本地报错，且假服务端未收到请求。
6. 仓库内所有文本文件为 LF（按真实字节计数验证，不靠 grep 目视）。
7. **线格式形状**：`prepareRequest` 返回的 `body.questions` 必须是**对象映射**（键为题名），**不得是数组**；且假服务对非对象形状返回 400（与真实服务端同形）。数组形状会在真机上 **0.071s 内 HTTP 400**，因此第 4 条真机验收也同时验证了本形状。

## 8. 已知限制（同步进 README）

1. `clef-flash:latest`（及 `clef`）在 Ollama 0.35.1 上任何请求都返回 500 `Clef: non-finite logit`；已验证三种请求形态均复现 ⇒ v1 不含视觉。
2. `tev1:0.8b` 与 `tev1:latest` 对同一题可给出不同答案，且更大者不必然更合理 ⇒ 请按题实测选型。
3. 首次调用含模型加载（实测 0.8B ~12s、4.2B ~18.5s）⇒ 默认超时 120s；`keep_alive` 可减少反复冷启。
4. 无流式、无 tools、一请求一响应；服务端硬限 64 KiB / 64 题 / 2–26 选项。
5. `confidence = 1 − H(p)/ln(N)` 是分布集中度，**不是**校准正确率；`noul` 是概率不是布尔。
6. 插件只解决「有界判定」；开放式推理仍须交给生成式模型。

## 9. 打包边界

`files` 白名单（与系统功能无关的一律不入包 —— 用户 2026-10-04 跨项目裁定）：

```
lib/**/*.js
cordis.patch.yml
README.md
README.zh.md
LICENSE
THIRD_PARTY_NOTICES
```

**排除**：`test/`、`smoke/`、`docs/`、`.temp/`、`.git*`。理由：测试与冒烟是开发装置，不是功能件；`install_bundle` 只解析 `cordis.patch.yml` 并 `import` `lib/`。

## 10. 未决与 v2 候选

| 项 | 触发条件 |
|---|---|
| **M1 · 引用式 `state`**（`stateSource: inline \| file{path,startLine,endLine} \| glob{pattern,limit}`）—— 让材料**根本不进模型上下文**。**这是跨会话调研里被标为「最高杠杆」的一项**，但代价明确：需文件系统访问 ⇒ 打破 ADR-1 边界，须新增纯函数模块（如 `lib/source.js`，由工具层注入 `rootDir`），并同时定四条约束（基准目录固定为工作区根、拒绝绝对路径与 `..`、读盘后做 64 KiB 检查并报可行动错误、单次读盘总量上限）—— **否则就是一个越权读盘口子**。调研本身建议：**先用一份 30 KB 规格做「内联 vs 引用」的廉价对照实验，测出真实 token 与质量差再定，而不是先写代码** |
| **M5 · 可复算的审计落盘**：追加型 JSONL（题面哈希 / 模型 / 选项顺序 / 答案 / 概率 / conf / 耗时 / usage / 代码版本），默认落工作区 `.temp/` 之下，只追加、不写仓库其他文件 | 出现「需要在使用现场复算判定比率」的需求时 |
| **M3 的 `orderPolicy: 'as-given' \| 'rotate'` 能力**：调研实测选项反序会翻转 **5/6** 的答案。v1 已把「选项顺序会改变答案」写进 description 并登记为已知限制；**做成能力**需要 N 倍上游调用，且需先测出轮换对准确率的真实增益 | 有准确率数据支持轮换收益时 |
| **M2 的软阈值**：v1 已采纳「体积回显」（`state_bytes`/`body_bytes`）。**软阈值告警**的阈值若要写成实测值而非策略值，需要先测「state 体积 → 判定质量」的曲线 | 测出该曲线时 |
| **M6 的两条工程口径**：① 超时按「热态短（实测 0.09–0.2s，5s 足够）、冷态有界放宽（另加 `min(基线×2, 60s)`，且只在探测说未驻留时加）」—— 把冷加载算进短超时会 **100% 打挂第一个请求**；② 熔断要区分错误类型（请求/配置类 400/413/白名单外**不计**，不可用类超时/5xx/连接失败**计**），命中时**不发请求、不等超时** | v1 单次调用形态没有熔断需求；出现常驻调用方时 |
| 视觉支持（路径式 `images`） | 上游修复 clef 的 `non-finite logit` |
| 独立客户端包 / CLI | 出现 DSH 之外的消费方（例如评测装置 C 方案） |
| 模型对照实测报告（原 C 方案） | 用户决定推进选型评测时 |
| TS + tsup 迁移 | 模块数 >5，或需要 Client/UI 半边 |

**v2 台账的来源与权威性（记录在案）**：上表 M/N 系列条目来自两份**跨会话产出的**工作区调研文档（`docs/superpowers/reviews/2026-10-04-ai-tiku-painpoint-research.md` 与 `…tessera-dev-painpoint-research.md`，各约 30 KB，写于本次实施运行途中）。**用户 2026-10-04 裁定：它们是「参考输入」，不是约束** ⇒ 本规格按技术价值逐条取舍，取者已并入 v1 正文（M2 回显、M3 数字题名、M4/M6 措辞），重者进本表 v2 待办。两份文档自述的复核时点早于 `70bbe75`，其中「ADR-6 由谁补」一问在本仓已由 ADR-6 结清。

---

## 附：本规格的依据来源

- Ollama 决策能力文档：<https://docs.ollama.com/capabilities/decision>
- Ollama System One API 参考（含完整 OpenAPI）：<https://docs.ollama.com/api/systemone>
- 用户提供的研究综述：`.temp/Decision LLM.md`（Decision LLM 背景与生态）
- 本机先例：`G:\LAB\202608\dsh-win-multi-bash`（免构建插件形态）、`G:\LAB\202608\memory`（TS 构建形态）
- 本机实测：见第 2 节，探测产物在 `.temp/probe/`（不入库）

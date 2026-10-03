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
| 硬依赖注入 | `inject: ['tools', 'systemPrompt']` 两个键均有效 |
| 参数 DSL | `ParameterSchemaSpec`：标量 / `array{items}` / `object{properties, additionalProperties(必填)}` / `json` / `oneOf`(≥2 分支)；必填是逐属性的 `required: true` |
| 结果 schema | `output: { schema: ValueSchemaSpec, render(args, value) => ContentBlock[] }` |
| prompt 段 | `ctx.systemPrompt.section({ name, order, text })` |
| 配置 | `@deepseek-ai/schemastery` 的 `z` |
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
│  ├─ prompt.js                  # DECISION_SECTION 常量
│  └─ tool.js                    # defineTool 定义 + apply()
├─ test/
│  ├─ fake-ollama.mjs            # node:http 假服务，供各测试复用
│  ├─ client.test.mjs
│  ├─ validate.test.mjs
│  ├─ render.test.mjs
│  └─ schema.test.mjs
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
  baseUrl, model, state, questions, keepAlive,
  timeoutMs, signal, fetchImpl = fetch,
}) { /* 见 4.3 职责 1–5 */ }
```

**职责**：
1. 组装 body：`{ model, state, questions }` + 可选 `keep_alive`
2. 发送前做 64 KiB 体积检查（`Buffer.byteLength(JSON.stringify(body))`）
3. 超时：`AbortSignal.timeout(timeoutMs)` 与调用方 `signal` 用 `AbortSignal.any([...])` 合并
4. 响应解析与错误映射（见 4.7）
5. 成功时返回 `{ answers, usage }` **原样**，不重写、不归一化

**可测试性**：`fetchImpl` 与 `signal` 均可注入 ⇒ 单测无需真实网络；`baseUrl` 可指向假服务端口。

### 4.4 `lib/tool.js` — 工具定义与 `apply()`

```js
export const name = 'decision-tools';        // 插件身份，不是工具名
export const inject = ['tools', 'systemPrompt'];
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
  const toolName = config.toolName;
  ctx.tools.register(defineTool({ name: toolName, description, parameters, output, execute }));
  ctx.systemPrompt.section({ name: `tool:${toolName}`, order: 105, text: DECISION_SECTION });
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
| V2 | 每题 `name` 为非空字符串且全局唯一 | 「问题名重复：X」 |
| V3 | `type ∈ {choice, noul, score}` | 「不支持的类型 X（合法：choice/noul/score）」 |
| V4 | `choice.criteria` 是对象，选项数 2–26，键非空 | 「choice 'X' 有 N 个选项，合法范围 2–26」 |
| V5 | `score.criteria` 是字符串数组，长度 2–26 | 「score 'X' 有 N 档，合法范围 2–26」 |
| V6 | `score.criteria` 为数组形态（对象形态明确报错） | 「score 的 criteria 必须是由低到高的数组」 |
| V7 | `noul.criteria` 若存在，只允许 `false`/`true` 键 | 「noul 只接受 false/true 两个键」 |
| V8 | 序列化 body ≤ 65536 字节 | 「请求 N 字节，超过 64 KiB 上限；请缩减 state 或拆分请求」 |
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

映射结果以抛 `SystemOneError` 表达；`tool.js` 把它转成工具错误结果（`isError`），**不吞异常、不降级为猜测**。

### 4.8 渲染（`lib/render.js`）

`output.schema` 用 `oneOf` 覆盖三型 answer（`choice`/`noul`/`score`）+ `usage`，保证结构化无损。

`render(args, value)` 输出紧凑文本，每题一行：

```
label   choice  bug            p={bug:0.959, account:0.034, billing:0.006}  conf=0.829
refund  noul    P(true)=0.475
urgency score   1.154 / 2       p={1:0.708, 2:0.223, 0:0.069}              conf=0.304
（usage: in=799 out=4）
```

**理由**：模型读逐行文本比读嵌套 JSON 更省 token、更不易误读；概率按降序排列，让「次优选项」可见（用于阈值判断与不确定性识别）。完整原始 JSON 仍可通过 `output.schema` 取到。

### 4.9 prompt 段（`lib/prompt.js`）

控制在 ~10 行，只讲模型自己看不出来的事：

1. **何时用** `decision`：候选集合已知且有界（路由、分类、过滤、打分、重排）；需要的是概率而非文字；同一批材料要问多题（一次请求问完）。
2. **何时不用**：开放式生成、需要推理链、候选需要边想边发现 —— 那些留给 System 2。
3. **`noul` 返回的是概率不是布尔**：`0.475` 不等于「否」，它是「真」的概率。
4. **`confidence` 是分布集中度不是正确率**：`conf=0.30` 表示模型在多档间摇摆，此时应看 `probabilities` 而非只看结论。
5. **阈值升级**：低置信度时把该题升级给 System 2 处理，而不是直接采信。

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
| 视觉支持（路径式 `images`） | 上游修复 clef 的 `non-finite logit` |
| 独立客户端包 / CLI | 出现 DSH 之外的消费方（例如评测装置 C 方案） |
| 模型对照实测报告（原 C 方案） | 用户决定推进选型评测时 |
| TS + tsup 迁移 | 模块数 >5，或需要 Client/UI 半边 |

---

## 附：本规格的依据来源

- Ollama 决策能力文档：<https://docs.ollama.com/capabilities/decision>
- Ollama System One API 参考（含完整 OpenAPI）：<https://docs.ollama.com/api/systemone>
- 用户提供的研究综述：`.temp/Decision LLM.md`（Decision LLM 背景与生态）
- 本机先例：`G:\LAB\202608\dsh-win-multi-bash`（免构建插件形态）、`G:\LAB\202608\memory`（TS 构建形态）
- 本机实测：见第 2 节，探测产物在 `.temp/probe/`（不入库）

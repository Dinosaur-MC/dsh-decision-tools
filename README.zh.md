# dsh-decision-tools

**向本地模型要概率，而不是要文字。** 两个 DSH 工具，把有界判定变成便宜、可重复的调用：

| 工具 | 回答什么 | 典型用法 |
|---|---|---|
| `decision` | 一份判据判 1–64 项，或一次问最多 64 个不同问题 | 筛列表、分类工单、路由请求、排序候选、「这段日志是不是失败？」 |
| `monitor` | 反复采样同一个源，直到判据成立 | 等构建结束、等某行出现、等作业失败 |

判定跑在**你自己的 Ollama**（`/v1/systemone`）上：不经过云服务，材料也不必进入对话上下文。

## 为什么值得用

- **天然省钱**：判据只发**一次**，一次调用判最多 64 项；逐项循环才是昂贵的反模式。
- **材料不进上下文**：传工作区文件、glob 或另一个工具的原始输出，你只读回答案。
- **输出诚实**：每个答案是概率 + `confidence`；部分完成写进 `coverage`，插件做了什么写在 `notes`。

## 环境要求

- 已启用本插件的 DSH 桌面版（见「安装」）。
- 本地 Ollama 提供 decision 模型 —— 默认 `tev1:0.8b`，可用 `model` 单次覆盖。
- 无需 API Key；判定本身不出网。

## 安装

开发期把工作区链进 profile，或启用已发布包，然后确认工具可见：

```
cordis_inspect_query(platform="host", provider="Tool", method="listTools")
```

随包技能 `decision-usage` 与工具一起注册，写全了每个参数，按需加载。

### 换用本机其它模型

默认值（`baseUrl` = `http://localhost:11434`、`defaultModel` = `tev1:0.8b`、四条 `ladder`）都只是**快照**。任何能应答 System One 端点的 Ollama 模型都能用：

- 单次指定 —— `model: "<名称>"`（同时关闭容量选择与升档）；
- 改会话默认 —— `defaultModel`；
- 换主机/端口 —— `baseUrl`；
- 调升档阶梯 —— `ladder: [{ model, numCtx }]`（见 Configuration）。

想知道本机实际装了哪些、并拿到可直接粘贴的 ladder：

```
node scripts/list-models.mjs          # 名称 · 上下文 · 参数量 · 大小
node scripts/list-models.mjs --json   # { models, ladder }
```

`numCtx` 取自 `/api/show` 的**声明**上下文长度（上限），运行时 `num_ctx` 可能更小。

## 快速开始

```jsonc
// 1) 筛列表：一份判据判 N 项
{ "material": "<列表或其上下文>", "rubric": "This is a bug report?",
  "items": ["app crashes on save", "please add dark mode"], "type": "noul" }

// 2) 对同一个文件问不同的问题
{ "material": { "file": { "path": "build.log", "startLine": 1, "endLine": 200 } },
  "questions": [
    { "name": "ok", "type": "noul", "instructions": "Did the build succeed?" },
    { "name": "why", "type": "choice", "instructions": "What failed?",
      "criteria": { "compile": "compile error", "test": "a test failed", "env": "missing dependency" } }
  ] }

// 3) 判另一个工具的输出，而不把它读进上下文
{ "material": { "tool": { "name": "git_bash", "arguments": { "command": "npm test" } } },
  "rubric": "Did the test suite pass?", "items": ["the test suite output"], "type": "noul" }

// 4) 等后台作业结束，并让插件通知你
{ "source": { "kind": "job", "id": "<jobId>" },
  "rubric": "Did the job finish successfully?", "background": true, "notify": "inbox" }
```

## `decision`：一次调用，一种模式

给 `material`，再加**恰好一种**模式：

| 模式 | 形状 | 含义 |
|---|---|---|
| 批量 | `rubric` + `items` + `type`（+ `criteria`） | 一份共享判据，逐项独立判定 |
| 混合 | `questions` | 对同一份材料问最多 64 个不同问题 |

| 参数 | 必填 | 说明 |
|---|---|---|
| `material` | 是 | 内联字符串 / `{file}` / `{glob}` / `{tool}` |
| `rubric` | 批量 | 唯一共享判据；线格式会替模型重复它 |
| `items` | 批量 | 1–64 个自包含项；直接传字符串也合法 |
| `questions` | 混合 | 1–64 个 `{name, type, instructions, criteria?}` |
| `type` | 批量 | `choice` / `noul` / `score`（混合模式逐题给） |
| `criteria` | choice/score | 标签集只写一次：批量走顶层，混合走每题 |
| `depth` | 否 | `quick`（不升档不分批）、`normal`（默认）、`deep`（可切块） |
| `model` | 否 | 固定模型；关闭容量选择与升档 |

**材料四形态**：内联文本 · `{ file: { path, startLine?, endLine? } }` · `{ glob: { pattern, limit? } }` · `{ tool: { name, arguments? } }`。工具输出**不进上下文**，全文落盘、路径回传为 `material.spillPath`；`tool` 不能与 `file`/`glob` 同时给，插件自身工具会被拒。

**读结果**：`results[]`（`id`/`type`/`value`/`probabilities?`/`confidence?`）· `coverage`（`requested`/`answered`/`batches`/`truncated`/`truncatedBy`/`failed`/`aborted`）· `cost`（`model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts`）· `notes`（首行是选档结论）。

`noul` 返回**布尔** `value`；P(true) 在 `probabilities.true` 里（0.475 = 47.5% 是）。`score` 落在 0..N-1 尺度；`choice` 返回所选标签。`confidence` 是分布集中度，**不是正确率** —— 当 `notes` 点名低置信项时，改读 `probabilities` 而不是标签。

## `monitor`：等一个事件

按间隔采样同一个源、每次问同一个判据、累计命中，达到 `countThreshold`（或 deadline）返回。它**绝不** kill、重试或取消任何东西。

| 采样源 | 允许的键 | 读什么 |
|---|---|---|
| `job` | `id?`、`select?`（`newest`/`oldest`）、`jobKind?` | 后台作业输出（缺省看本会话最新） |
| `file` | `path`、`startLine?`、`endLine?` | 工作区相对文件 |
| `glob` | `pattern`、`limit?` | 命中文件拼接 |
| `command` | `argv` | 复用插件上游管道重跑宿主命令 |
| `events` | `types`、`limit?` | 作业事件环形缓冲（无缓冲时退到当前作业列表） |

参数：`rubric`（必填）· `source`（必填）· `type`（仅 `noul`）· `hitThreshold`（0.5）· `tailBytes`（4096，上限 65536）· `mode`（`once`|`continuous`）· `intervalMs`（5000）· `timeoutMs`（120000）· `countThreshold`（1）· `background` · `notify` · `coalesce` · `maxNotificationsPerMinute`（6）。

- **空源立即返回**：`samples: 1`、`emptySource: true`、`hit: false` —— 不调模型、也不等 deadline。
- **后台**：`background: true` 立刻返回 `jobId`，用 `job_output` 读（读一次即消耗）。`notify: "inbox"` 命中时发通知，且**必须**是后台调用。
- **`command` 的 argv**：`argv[0]` 选解释器（`pwsh`、`git_bash`/`bash`/`sh`/`zsh`）；解释器标志会被剥掉；**带空格的参数要自己加引号**。
- **`events.types`** 按固定词表校验（`job.registered`、`job.stopping`、`job.output`、`job.progress`、`job.settled`、`job.completed`、`job.failed`、`job.killed`、`job.removed`、`job.running`、`job.unknown`），拼错报 `source_invalid`。

## Configuration

插件由四行组成：核心行、decision 行、monitor 行与 skill 行。每行在 Plugins 页都有自己的开关；核心/decision/monitor 三行还各有自己的 Configure 页。GUI 可改字段声明为 .volatile()，保存后下一次调用生效，无需重载行。toolName / monitorToolName / ladder / spillDirCap 是注册期或高级 YAML 项：在 cordis.patch.yml 里改，然后重载对应行。

### 核心行 — decision-tools-plugin（共享模型与运行时）

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | http://localhost:11434 | Ollama 地址；路径前缀会被保留；GUI 可改。 |
| `defaultModel` | tev1:0.8b | 工具行没有 modelOverride 时使用的模型；GUI 可改。 |
| `timeoutMs` | 120000 | 单次请求预算，含冷加载；GUI 可改。 |
| `keepAlive` | unset | 透传为 keep_alive；未设用服务端默认；GUI 可改。 |
| `apiKey` | 未设 | 可选；作为 Bearer token 发给远程 / System One 兼容接口；GUI 可改。 |
| `modelsPath` | /api/tags | 模型发现路径；OpenAI 兼容接口可用 `/v1/models`；GUI 可改。 |
| `systemOnePath` | v1/systemone | 判定接口路径（相对 baseUrl）；GUI 可改。 |
| `modelOrder` | 未设 | 逗号分隔的模型优先级；`model@numCtx` 可指定上下文；未知模型按 8192；GUI 可改。 |
| `escalationEnabled` | true | 上下文溢出时允许自动升档；GUI 可改。 |
| `ladder` | unset (DEFAULT_LADDER) | 有序的 {model,numCtx}[]；仅 YAML；改后重载核心行。 |
| `toolName` | decision | decision 工具的模型可见名；改后重载 decision 行。 |
| `monitorToolName` | monitor | monitor 工具的模型可见名；改后重载 monitor 行与 decision 行（两行都快照该名）。 |
| `spillDirCap` | unset (16 MiB) | 插件转储目录的字节上限；仅 YAML。 |

### decision 行 — decision-tools-decision

| Key | Default | Meaning |
|---|---|---|
| `modelOverride` | unset (core default) | 留空使用核心行的 defaultModel；GUI 可改。 |
| `defaultDepth` | normal | quick / normal / deep；调用省略 depth 时使用；GUI 可改。 |
| `bodyWarning` | true | false 时不再返回体积/文本形状提示；GUI 可改。 |
| `softBodyBytes` | unset (4096) | 超过该字节数会在 notes[] 带体积提示；0 表示每次都告警；GUI 可改。 |
| `minConfidence` | unset (0.25) | confidence 低于该值（或缺失）的 choice/score 项会被点名；0 关闭；GUI 可改。 |
| `maxChoiceOptions` | unset (255) | choice 选项数上限；GUI 可改。 |
| `escalationMaxAttempts` | 3 | 升档尝试次数上限；GUI 可改。 |
| `scanFirstChunkBytes` | unset (4096) | 首块字节预算；GUI 可改。 |
| `scanMaxChunks` | unset (32) | 单次扫描的块数上限；GUI 可改。 |
| `scanMaxTotalBytes` | unset (4 MiB) | 单次扫描的累计字节上限；GUI 可改。 |
| `scanDeadlineMs` | unset (180000) | 单次扫描的墙钟预算；GUI 可改。 |
| `scanAggregate` | none | none / any；any 会给跨块答案加一个暂定的最大概率；GUI 可改。 |

### monitor 行 — decision-tools-monitor

| Key | Default | Meaning |
|---|---|---|
| `modelOverride` | unset (core default) | 留空使用核心行的 defaultModel；GUI 可改。 |
| `minProbeIntervalMs` | unset (1000) | monitor 探测间隔下限；GUI 可改。 |
| `notifyCoalesceWindowMs` | unset (5000) | 同类通知合并窗口；0 表示不合并；GUI 可改。 |
| `maxNotificationsPerMinute` | unset (6) | 每分钟通知上限；GUI 可改。 |

覆盖既有行要用裸 id、不带 insert，字段写在 config 键下。config 是整块替换、不做深合并，所以覆盖时必须重述该行用到的全部字段。

    - id: decision-tools-plugin
      config:
        baseUrl: 'http://localhost:11434'
        defaultModel: 'tev1:0.8b'
        timeoutMs: 180000
        keepAlive: '30m'
    - id: decision-tools-decision
      config:
        modelOverride: 'tev1:0.8b'
        defaultDepth: normal
    - id: decision-tools-monitor
      config:
        modelOverride: 'nimble:latest'

三条 Config schema 在 lib/configs.js。

## 常见问题

| 现象 | 可能原因 | 处理 |
|---|---|---|
| `context_overflow` | 材料 + 问题超出模型窗口 | 用 `depth: "deep"` 切块、减小材料或减少问题数 |
| 工具列表里没有 | 插件未在 profile 启用 | 链接进 profile 后重载 |
| DSH 升级后 `ERR_MODULE_NOT_FOUND` | 工作区 `node_modules` 仍指向旧安装 | 在 DSH 内跑 `scripts/rebuild-node-modules.mjs`，再复跑测试 |
| `monitor` 返回 `hit:false` 且 `errors:0` | 源为空，或 `types` 没匹配到 | 看 `emptySource`；`notes` 会写原因 |
| `monitor` 返回 `errors: N > 0` | 读取或判定失败 | 看错误正文，渲染结果里也有 failed probes |
| `source.kind=events` 报错 | 该组合下事件源不可用 | 能回落时会退到本会话当前作业列表 |
| `invalid_request` / `mode_invalid` | 参数不合法 | 报错列出合法值；`mode_invalid` = 模式/数量/形态，`invalid_request` = 字段 |

## 边界与安全

- 这些是**概率，不是证据**：不得当作正确性证据，也不得单独作为放行/拒绝的依据（那需要产物级证据）。
- 工具**不得**决定路由，也**不得**作为任何 **fail-open / fail-closed** 策略的依据 —— 那属于确定性规则。
- `tev1` 只返回概率、不返回文本；需要可读理由时换生成类模型。
- 工具原始输出落到插件自建的临时目录（总上限 16 MiB，`spillDirCap`），路径随结果回传。
- 判定全程本地，插件自身不发起云调用。

## 开发

```
node --test test/*.test.mjs     # 全量套件
node --check lib/*.js          # 语法门
```

改过 `lib/` 后，先在 DSH 里重载插件再下结论：宿主跑的是最后一次加载的快照。

## Licence

MIT —— 见 [LICENSE](./LICENSE)。

## 无兼容层

这是一次性结构升级，不是版本过渡。旧行 id（`decision-tools-tool`）与旧配置键（`decisionEnabled` / `monitorEnabled`）不再被接受；使用上面的四行与三张 Config 表。契约见 [docs/architecture-current.md](./docs/architecture-current.md)，用例见 [docs/use-cases.md](./docs/use-cases.md)。

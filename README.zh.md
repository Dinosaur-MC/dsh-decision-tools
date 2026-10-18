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
  "rubric": "Did the test suite pass?" }

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
| `items` | 批量 | 1–64 个自包含的短对象 |
| `questions` | 混合 | 1–64 个 `{name, type, instructions, criteria?}` |
| `type` | 批量 | `choice` / `noul` / `score`（混合模式逐题给） |
| `criteria` | choice/score | 标签集只写一次：批量走顶层，混合走每题 |
| `depth` | 否 | `quick`（不升档不分批）、`normal`（默认）、`deep`（可切块） |
| `model` | 否 | 固定模型；关闭容量选择与升档 |

**材料四形态**：内联文本 · `{ file: { path, startLine?, endLine? } }` · `{ glob: { pattern, limit? } }` · `{ tool: { name, arguments? } }`。工具输出**不进上下文**，全文落盘、路径回传为 `material.spillPath`；`tool` 不能与 `file`/`glob` 同时给，插件自身工具会被拒。

**读结果**：`results[]`（`id`/`type`/`value`/`probabilities?`/`confidence?`）· `coverage`（`requested`/`answered`/`batches`/`truncated`/`truncatedBy`/`failed`/`aborted`）· `cost`（`model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts`）· `notes`（首行是选档结论）。

`noul` 返回**数值**（0.475 = 47.5% 是）；`score` 落在 0..N-1 尺度；`choice` 返回所选标签。`confidence` 是分布集中度，**不是正确率** —— 当 `notes` 点名低置信项时，改读 `probabilities` 而不是标签。

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

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址；路径前缀会被保留（`http://host/ollama` → `http://host/ollama/v1/systemone`） |
| `defaultModel` | `tev1:0.8b` | 调用未给 `model` 时使用的模型 |
| `timeoutMs` | `120000` | 单次请求预算，含冷加载 |
| `toolName` | `decision` | 模型看到的工具名 |
| `keepAlive` | 未设 | 透传为 `keep_alive`；未设则用服务端默认 |
| `softBodyBytes` | 未设（回落到 `LIMITS.softBodyBytes`，4096） | 超过该字节数的 body 会在 `notes[]` 里带一行体积归因 |
| `bodyWarning` | 未设（开启） | `false` 时永不产出该行；未设或 `true` 则保持开启 |
| `minConfidence` | 未设（回落到 `LIMITS.minConfidence`，0.25） | `confidence` 低于该值（或缺失）的 `choice`/`score` 项会被列进 `notes[]` 的一行；`0` 关闭该门限 |
| `maxChoiceOptions` | 未设（回落到 `LIMITS.maxChoiceOptions`，255） | `choice` 选项数上限。OpenAPI 明说 *「The option limit depends on the model」*，故模型不同时应在此调整。`score` 是**另一条**约束、由规格写死为 2–10，**不可配置**。 |
| `escalationEnabled` | `true` | 上下文溢出时自动提升到更大上下文的判定模型。调用时传了 `model` 会在该次调用禁用自动提升。 |
| `ladder` | 未设（用 `DEFAULT_LADDER`） | 有序的 `{ model, numCtx }[]` 提升候选。两处刻意排除：`clef:latest`（27B 在 8 GB 显存上 300 s 未返回）；`nimble:latest`（其 `num_ctx` 8194 只比 tev1 的 8192 大 2 token，永远过不了容量余量 ⇒ 一档**选不中**的档）。重拉模型后须重读 `/api/show`，这些是快照。 |
| `escalationMaxAttempts` | `3` | 提升尝试次数上限；用尽即抛可行动错误，绝不静默降级。 |
| `scanFirstChunkBytes` | 未设（用 `LIMITS.softBodyBytes`） | 首块字节预算；后续块据服务端自己的 token 数字重切。 |
| `scanMaxChunks` | 未设（用 `LIMITS.scanMaxChunks`） | 单次扫描的块数上限；触顶返回**部分结果**而非失败。 |
| `scanMaxTotalBytes` | 未设（用 `LIMITS.scanMaxTotalBytes`） | 单次扫描的累计字节上限。 |
| `scanDeadlineMs` | 未设（用 `LIMITS.scanDeadlineMs`） | 单次扫描的墙钟预算，**独立于** `timeoutMs`。 |
| `scanAggregate` | `none` | `any` 会给每道 `noul` 题加一个**暂定**的跨块最大概率。跨块概率未经校准 —— 不得当作判定依据。 |
| `minProbeIntervalMs` | 未设（用 `MONITOR_LIMITS.minProbeIntervalMs`，1000） | `monitor` 探测间隔的**下限**：模型给的 `intervalMs` 会被抬到不小于它。 |
| `notifyCoalesceWindowMs` | 未设（用 `MONITOR_LIMITS.defaultNotifyCoalesceWindowMs`，5000） | 同类 `monitor` 通知的合并窗口 —— inbox 自身没有任何背压。 |
| `maxNotificationsPerMinute` | 未设（用 `MONITOR_LIMITS.defaultMaxNotificationsPerMinute`，6） | `monitor` 通知的每分钟上限。 |
| `spillDirCap` | 未设（用 `DEFAULT_SPILL_MAX_BYTES`，16 MiB） | 管道自建转储目录（系统临时区）的总字节上限。 |
| `monitorToolName` | `monitor` | 第二个工具（`monitor`）的**模型可见名**。与其它工具重名时改它。 |

`softBodyBytes` 会被**静默钳到** `LIMITS.maxBodyBytes`（65536）—— 高于该字节硬上限的阈值
永远不可能触发；而把阈值设到模型**真实**容量（其 `num_ctx`）之上会让告警**静默失效**，
插件内部无从检测这一点 —— 权威守卫始终是服务端的 token 检查。

`minConfidence` **只加旗、不清障**：所有答案原样返回，插件绝不因置信度低而删除、改写或
拒绝任何一个。`0` 表示**关闭**该门限（注意与 `softBodyBytes: 0` 的语义**相反** —— 那里是
「每次都告警」），大于 `1` 的取值会被钳到 `1`。默认值 0.25 只在一份小样本上标定过
（`tev1:0.8b`，4 题 × 6 个候选排列）；不同模型的 confidence 尺度差约一个量级（同批题上
`tev1:0.8b` 实测 0.04–0.62，而**所有 4B 及以上的模型**恒在 0.77–0.99）⇒ **换模型必须重新
标定**；并且请注意：**在这些更大的模型上门限是惰性的** —— 它们的 confidence 从不会低于
0.25。它也不是安全保证：跨会话调研里唯一那次顺序翻转发生在 `confidence = 0.357`，高于本
阈值；且 `confidence` 是分布集中度，不是校准正确率。另：**选项顺序效应本身已查明是
0.8B 独有现象** —— 跨 6 个候选排列，`tev1:latest`(4B)、`clef-flash`(9.1B)、`nimble`(9B)、
`clef`(27B) 在全部 4 题上都给出完全相同的标签。

在 `cordis.patch.yml` 里**覆盖既有行**要用**裸 `id`、不带 `insert`**，并把字段写在行的
`config:` 键**下**。把字段**平铺在行上**会被静默忽略，也没有任何告警 —— 插件只会按默认值运行。

    - id: decision-tools-tool
      config:
        baseUrl: 'http://localhost:11434'
        defaultModel: 'tev1:0.8b'
        timeoutMs: 180000
        toolName: 'decision'
        keepAlive: '30m'

`config` 是**整块替换**、不做深合并，所以覆盖时必须重述该行用到的全部字段 —— 照抄上面
这一整块即可；行自己的键只有 `id`、`name`、`config`、`disabled`、`inject`、`intercept`
与 `isolate`。`insert:` 用于**新增一行**（本 bundle 自己的 patch 就是这么做的）；**覆盖既有行**
用裸 `id`、**不带 `insert`**。
上表默认值取自 `lib/tool.js` 的 `Config`。

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

## 从旧版迁移

v2 的顶层键（`state`、`answers`、`usage`、`strategy`、`aggregate` 等）已全部移除，改用 `material` + 一种模式。契约见 [docs/architecture-current.md](./docs/architecture-current.md)，用例见 [docs/use-cases.md](./docs/use-cases.md)。

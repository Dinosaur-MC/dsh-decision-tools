# dsh-decision-tools

一个 DSH 代理工具：把本机 [Ollama System One](https://docs.ollama.com/capabilities/decision)
模型藏在一次工具调用之后 —— 分类、是/否判定、按评分表打分，三件事在一次请求里完成，
共享同一段 state。

## Why

路由、过滤、相关性判断与打分都是**有界判定**：有用的答案是一个概率，不是一段文字。
把它们交给生成式模型既慢又贵。System One 决策模型一次前向传播就给出答案。

## Requirements

- 本机运行的 Ollama >= 0.35.0
- 至少一个决策模型：`ollama pull tev1:0.8b`（推荐的默认值）
- DSH 带 `@deepseek-ai/dsh-tools` >= 0.2.0-rc.2

## Install

    plugin_manager(action="install_bundle", target="<本包的绝对路径>")

然后用 `cordis_inspect_query(platform="host", provider="Tool", method="listTools")`
确认工具已可见。

## 工具

本包注册**两个**模型可见工具：

| 工具 | 是什么 |
|---|---|
| `decision` | 一份共享 `material` + 一条共享 `rubric`，一次请求判定：1–64 项（批量）或几个互不相同的问题（异质）。给的是概率，不是文字。 |
| `monitor` | **探测式等待原语**：按间隔采样一个 `source`，用同一个判定模型按你的 `rubric` 反复问「事件是否已发生」，累加命中次数，达到 `countThreshold`（或到 deadline）即返回。它绝不 kill、重试或派发任何东西 —— 见 [Monitor](#monitor)。 |

## Usage

一次调用、一份 `material`，两种**互斥**模式择一（同时给或都不给都报错）。

`material` 有**四种形态**；后三种是引用式，**永不进你的上下文**：

| 形态 | 何时用 |
|---|---|
| 纯字符串 | 材料小且本就在上下文里 |
| `{ file: { path, startLine?, endLine? } }` | 材料是工作区文件（1-based 闭区间）。单文件超上限是**报错**，绝不截断 |
| `{ glob: { pattern, limit? } }` | 一批文件。总量超上限是**截断**，由 `coverage.truncated` / `coverage.truncatedBy` 如实报告 —— 截断的材料绝不当完整材料用 |
| `{ tool: { name, arguments? } }` | 跑**另一个**工具并判它的**原始输出**，且不把输出拉进你的上下文。插件在进程内委托（**始终**带 `agent` 与 `parent`）、把原始输出**无条件**转储成文件，并回传 `material.spillPath` / `bytes` / `fullBytes` / `truncated`（进程型工具另带 `exitCode`）。委托给本插件自己的工具（`decision`、`monitor`）会被拒 —— 宿主自己没有递归护栏 |

**批量（batch）** —— 一条共享判据判 N 项，判据**只写一次**：

```json
{
  "material": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
  "rubric": "Is this ticket a payment failure that needs a refund?",
  "type": "noul",
  "items": ["ticket 12", "ticket 13", "ticket 14"]
}
```

**异质（mixed）** —— 同一份材料上问多个不同问题，每题自带 `criteria`：

```json
{
  "material": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
  "questions": [
    { "name": "label", "type": "choice",
      "instructions": "Which label fits this ticket?",
      "criteria": { "billing": "Payments and refunds", "bug": "Software errors",
                    "account": "Login and account access" } },
    { "name": "refund", "type": "noul",
      "instructions": "Is the customer requesting a refund?" },
    { "name": "urgency", "type": "score",
      "instructions": "How urgently does this ticket need a response?",
      "criteria": ["Routine: no time pressure",
                   "Soon: a customer is inconvenienced",
                   "Immediate: a critical service is unavailable"] }
  ]
}
```

`rubric` 只写一次，wire 层会替模型逐题重复，你不必按项抄。`choice` / `score` 的标签集也只写一次：
批量模式放**顶层** `criteria`，异质模式放每题里；`noul` 不接受任何 `criteria`，异质模式里出现
顶层 `criteria` 会报错。

上面那次异质请求的渲染结果 —— 每条结果一行，随后是 `coverage`、`material`、`cost`、`notes`：

    label    choice  bug  p={bug=0.9648, account=0.0293, billing=0.0059}  conf=0.847
    refund   noul    P(true)=0.5045
    urgency  score   Soon  p={1=0.7369, 2=0.1933, 0=0.0698}  conf=0.337
    覆盖: requested=3 answered=3 batches=1 truncated=false failed=0 aborted=false
    cost: model=tev1:0.8b input_tokens=796 body=682B wall=97ms escalated=false attempts=1
    模型选择：tev1:0.8b（fits-default）。

这些行的**形状**由渲染层（`lib/render.js`）固定；`noul` 刻意只打 `P(true)` —— `results[].value` 里的
布尔是阈值化产物，打出来会让人把概率读成判定。上面的概率与标签取自早前在本机 `tev1:0.8b` 上对同一
工单的实测分布；`coverage` / `cost` 两行的数字是**示意值** —— 本次改动换了 wire 形状，字节数与
`input_tokens` 请在你自己的机器上重测。

## Question types

| Type | Criteria | `results[]` 项 |
|---|---|---|
| `choice` | 2–255 个带描述的具名选项（`criteria` 对象） | `value` = 最可能的选项；`probabilities` = 选项 → 概率；带 `confidence` |
| `noul` | 可选 `{"false": ..., "true": ...}` 描述；**不接受 `criteria`**（批量模式下给了会被拒） | `value` = 布尔（`P(true) >= 0.5`）；`probabilities` = `{ true, false }`；**无** `confidence`（上游不返回） |
| `score` | 2–10 条由低到高排序的描述（`criteria` 数组） | `value` = 选中的档位标签；`probabilities` = 档位下标（0..N-1）→ 概率；带 `confidence` |

`score` 的概率加权均值不再作为数字返回，但你可用 `probabilities` 复算 `Σ index × p`。
`confidence` 是**分布集中度** `1 - H(p)/ln N`，**不是**校准正确率。`confidence` 低于 `minConfidence`
（或缺失）的项会被列进 `notes[]` 的一行 —— 这是**旗，不是过滤器**：没有任何答案被删除、改写或拒绝。

渲染时 `noul` 只打 `P(true)`，`choice` / `score` 打标签 + 降序概率。

## Monitor

`monitor` 是**探测式等待原语，不是调度器**。你给它一个 `source` 和一条 `rubric`（「什么算事件已发生」）；它按间隔采样、每次问一次判定模型，并把每次命中都计入计数。

```json
{
  "source": { "kind": "file", "path": "build.log" },
  "rubric": "日志里是否已出现 BUILD SUCCEEDED 这一行？",
  "intervalMs": 5000,
  "timeoutMs": 120000
}
```

- **按探测结果计数（电平口径）**：每次判定命中就 +1。**没有去抖、没有冷却窗** —— `countThreshold: 3` 大致等于「连续三次探测都命中」（量级 `3 × intervalMs`）。`minGapMs`、`countMode`、`persistCount`、`resetCount` **不存在**，传了会被**显式拒绝**而不是静默忽略。
- **时间戳只作记录**（`at`、`atIso`、`firstAt`、`lastAt`）—— 不参与命中判定。
- `intervalMs` 会被抬到部署下限（`Config.minProbeIntervalMs`）；`timeoutMs` 是**自管** deadline（宿主不抢占阻塞调用），被抬到不小于 `intervalMs`。两处钳制都写进 `notes`。
- `background: true` 注册宿主作业并立刻返回 `jobId`（之后用 `job_output` 读）。`notify: "inbox"` 在达到门槛时发通知（**仅 `background: true`**；前台传它会被当场拒绝），带合并 + 每分钟上限 + 唤醒预算 —— inbox 自身没有任何背压。
- `source.kind` 取 `job` / `file` / `glob` / `command` / `events` 之一。`file` 与 `glob` 走**与 `decision` 同一个 reader**（工作区相对、同一道 containment 闸）；`command` 走插件自己的上游管道（与 `decision` 的 `material.tool` 同一条）：`argv[0]` 选解释器（`pwsh`/`powershell`、`git_bash`/`bash`/`sh`/`zsh`），其余**按空格拼接**、解释器自身前导标志（`-c`/`-lc`/`-Command`/`-NoProfile`…）会被剥掉 —— **带空格的参数要自己加引号**。`events` 读插件的作业事件环形缓冲（`job.registered` / `job.settled` / `job.completed` / `job.failed` / `job.killed` …），没有缓冲时退到本会话**当前**作业列表。
- **命中只通知**。它绝不 kill、重试、派发或取消任何东西 —— 那由你决定。计数只在内存：每次调用从 0 起算，宿主重启即丢。
- **不适合**需要多轮推理、或候选要边想边发现的复杂目标 —— 它只回答你**现在就能写清**的有界问题。

前台调用返回 `hit` / `count` / `countThreshold`、各时间戳、命中那次采样的**有界尾部**（`evidence`，上限 1024 B），以及 `cost` / `coverage` / `notes`。

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

## Known limitations

1. **`clef` 系缺陷已于 2026-10-12 复测消失。** 原先在 Ollama 0.35.1 上任何请求都报
   `Clef: non-finite logit`；在 **0.40.3** 上复测（且模型文件被重拉过），`clef-flash:latest`、
   `clef:latest`、`nimble:latest` 三型全部返回 200，两个 `clef` 现已声明 `vision`。
   **修复来源无法单一归因**（Ollama 版本与模型文件两者都变了）。
   ⚠️ **2026-10-15 状态再变**：Ollama 升到 **0.40.4** 后，旧格式模型会被拒（`was downloaded
   in a format that is no longer supported`）；当日 16:08–18:0x 依次重拉
   `nimble:latest`/`clef-flash:latest`/`clef:latest` 之后，**6 个 decision 模型全部恢复可用**。
   ⇒ **模型可用性随重拉瞬变，任何「可用/不可用」的陈述都必须现测**。
   **但本扩展没有暴露图片输入**：没有 `images` 参数、也没有路径式读图 —— 上游 `/v1/systemone` 本身接受
   `images`（base64 PNG/JPEG/WebP，被该次请求的所有问题共享；本地整包上限 32 MiB 含 base64），
   `clef` / `clef-flash` 也能判图，所以这是**本扩展的缺口、不是上游限制** —— 见 ADR-3。
   `model_broken` 映射保留，作为上游回归的兜底。
2. **更大不必然更对。** 同一题上 `tev1:0.8b` 给 `bug`（p=0.9648），而
   `tev1:latest`（4.2B）给 `billing`（p=0.5710，`bug` 仅 0.3212）——
   按题面看 `billing` 是更弱的答案。请按题实测选型。
3. 首次调用含模型加载（本机实测：`tev1:0.8b` 冷 14.3 s、热 11.1 s；
   `tev1:latest` 冷 15.7 s、热 8.0 s）。
4. 无流式、无工具调用，一请求一响应。
5. 服务端硬限：无图请求 64 KiB、64 题、**`choice` 2–255 个选项**（OpenAPI 明说该上限
   依模型而异）与 **`score` 2–10 档** —— 这是**两条独立**的约束，不是同一个数。但真正
   先撞上的往往更小：有效上下文是该模型自己的 `num_ctx`，不是架构声明的 context length。本机
   `ollama show tev1:0.8b` 显示 `context length 262144`，而 `num_ctx = 8192`（2026-10-15
   重拉后；此前是 2050）；按真实英技术散文实测（约 3.33 B/token），该上限约折合
   `num_ctx / 3.33` 字节的 body，超出即返回 HTTP 400
   `prompt 0 has <N> tokens; expected 1–<M> (input is never truncated)`，
   映射为 `context_overflow` —— 输入**不会被截断**，也不会给出部分答案。
   本插件的**默认**体积告警阈值是一个固定字节数（`LIMITS.softBodyBytes = 4096` B），
   **刻意不跟随任何模型的 `num_ctx`**：它能在服务端拒绝**之前**响；越过它只在 `notes[]` 里
   多一行归因，**不改变任何拒绝行为**；而**选档**阈值自本次改动起改为按「窗口 × 0.6 余量 ×
   语言密度」现算（中文 2.32 / 英文 3.33 B per token，见 `lib/density.js`），本常量只在拿不到
   窗口信息时兜底。权威守卫仍是服务端的 token 检查。
   注意字节数只是**粗糙代理**：中日韩等密集文字与 ID 密集文本的 token/字节比
   远差于 3.33，此时该阈值**保护不足**。
6. **只解决「有界判定」。** 候选集合已知且有界的问题才归本插件；开放式生成、需要推理链、候选要边想边发现的情形，仍须交给生成式模型。
7. **置信度门限只加旗，不是保证。** 低于所配 `minConfidence`（或 `confidence` 缺失）的答案会被列进 `notes[]` 的一行；**没有任何答案**被删除、改写或拒绝。默认 0.25 只在一份小样本上标定过（`tev1:0.8b`，4 题 × 6 个候选排列），而不同模型的 confidence 尺度差约一个量级 ⇒ **换模型必须重新标定**。跨会话调研里唯一那次顺序翻转发生在 `confidence = 0.357`，高于本阈值；且 `confidence` 是分布集中度而非正确率 —— **没被列进告警 ≠ 该答案可信**。

## Development

    npm run link-peers     # 软链宿主的 peer 包（不走网络）
    npm test               # node --test "test/*.test.mjs"
    node smoke/live.mjs    # 可选：打真实的本机 Ollama

`node --test test/` 在 Node 22 上**不可用** —— 目录形式会被当成模块路径。
请用带引号的 glob。

`smoke/live.mjs` 需要本机 Ollama 在跑，不参与 CI；它是开发装置，
**刻意不进发布包**。

## Licence

MIT。见 LICENSE 与 THIRD_PARTY_NOTICES。

## 从旧版迁移（破坏性变更）

本版重建了工具面，**不提供兼容层** —— 下表的旧键不再作为参数接受、也不再出现在返回值里。要改的地方：

| 旧 | 新 | 要不要动手 |
|---|---|---|
| `state` | `material`（字符串仍是合法形态之一） | 改名 |
| `stateSource` | `material: { file: … }` / `{ glob: … }` | 改名 + 换形 |
| `strategy` | `depth: 'quick' \| 'normal' \| 'deep'` | 改名 + 选档 |
| `aggregate` | 删除（语义并入 `depth` 与自动分批） | 删掉 |
| 共享判据在每条 `questions[].instructions` 里重复 | `rubric`（只写一次）+ `items` + `type` | 改用批量模式 |
| 每个问题重复选项集 | 顶层 `criteria`（批量模式）；异质模式仍放每题 | 挪到顶层，只写一次 |
| `questions[].instructions` | 语义不变，但批量模式下它不再承载共享判据 | 视模式 |
| `answers[name]` | `results[]` —— `{ id, type, value, probabilities?, confidence? }` | 换读法 |
| `chunks` | 删除（结果始终在 `results`，每项一条） | 换读法 |
| `usage` / `state_bytes` / `body_bytes` | `cost`（`inputTokens` / `bodyBytes`） | 读 `cost` |
| `body_warning` / `confidence_warning` | `notes[]`（字符串，原样打印） | 读 `notes` |
| `source` | `material`（`{ source, bytes, descriptor? }`） | 读 `material` |
| `plan` | `notes[]`（首行写明模型与选档原因） | 读 `notes` |
| `escalated: { from, to, sticky }` | `cost.escalated`（布尔）+ `cost.attempts[]` | 读 `cost` |
| `scan`（`failed` / `truncated` / `aborted` / `remaining`） | `coverage`（`requested` / `answered` / `batches` / `truncated` / `truncatedBy` / `failed` / `aborted`） | 读 `coverage` |

另外：

- `items` 与 `questions` **互斥**：同时给（`mode_conflict`）或都不给（`mode_missing`）都报错。
- 扫描不再是参数：它是**只有** `depth: 'deep'` 才允许的内部行为；是否真的跑了由 `coverage` 如实报告，
  且「逐块最大只是**定位线索**，不是文档级结论」这条不变。
- 不变的部分：`model` 逃生口、提升的进程级粘滞、材料不进上下文的规则与工作区闸，以及上表所有 `Config` 键。
- 本包还随带一个 **skill**：启用 `dsh-decision-tools/skill` 行即把 `decision-usage` 放进会话技能目录（随包 `cordis.patch.yml` 默认两行都启用）。

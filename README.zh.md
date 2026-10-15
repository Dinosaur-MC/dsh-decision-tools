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

## Usage

一次调用、三种题型、共享同一段 state：

```json
{
  "state": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
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

**上面这次请求**的返回 —— 每题一行，末尾附 usage 与体积口径两行。本机 `tev1:0.8b`
的一次真实运行：`node smoke/live.mjs` 发的就是同一个请求，会打印上面四行（体积行由
工具层追加，冒烟脚本本身不打）。

    label    choice  bug  p={bug=0.9648, account=0.0293, billing=0.0059}  conf=0.847
    refund   noul    P(true)=0.5045
    urgency  score   1.1235 / 2  p={1=0.7369, 2=0.1933, 0=0.0698}  conf=0.337
    (usage: input_tokens=796 output_tokens=4)
    体积: state=113B body=682B

概率、分数与 token 数都是模型输出，换模型或换机器就会变；两个字节数刻画的是上面
那次请求本身，因此固定不变。

## Question types

| Type | Criteria | Answer |
|---|---|---|
| `choice` | 2–255 个带描述的具名选项 | 最可能的选项，外加每个选项的概率 |
| `noul` | 可选 `{"false": ..., "true": ...}` 描述 | `noul`：为真的概率（是一个数，不是布尔） |
| `score` | 2–10 条由低到高排序的描述 | `score`：零基等级的概率加权均值，落在 0..N-1 刻度上 |

`confidence` 是**分布集中度** `1 - H(p)/ln N`，**不是**校准正确率。

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址；路径前缀会被保留（`http://host/ollama` → `http://host/ollama/v1/systemone`） |
| `defaultModel` | `tev1:0.8b` | 调用未给 `model` 时使用的模型 |
| `timeoutMs` | `120000` | 单次请求预算，含冷加载 |
| `toolName` | `decision` | 模型看到的工具名 |
| `keepAlive` | 未设 | 透传为 `keep_alive`；未设则用服务端默认 |
| `softBodyBytes` | 未设（回落到 `LIMITS.softBodyBytes`，4096） | 超过该字节数的 body 会在返回值里带一行 `body_warning` |
| `bodyWarning` | 未设（开启） | `false` 时永不产出 `body_warning`；未设或 `true` 则保持开启 |
| `minConfidence` | 未设（回落到 `LIMITS.minConfidence`，0.25） | `confidence` 低于该值（或缺失）的 `choice`/`score` 答案会被列进 `confidence_warning`；`0` 关闭该门限 |
| `maxChoiceOptions` | 未设（回落到 `LIMITS.maxChoiceOptions`，255） | `choice` 选项数上限。OpenAPI 明说 *「The option limit depends on the model」*，故模型不同时应在此调整。`score` 是**另一条**约束、由规格写死为 2–10，**不可配置**。 |
| `escalationEnabled` | `true` | 上下文溢出时自动提升到更大上下文的判定模型。调用时传了 `model` 会在该次调用禁用自动提升。 |
| `ladder` | 未设（用 `DEFAULT_LADDER`） | 有序的 `{ model, numCtx }[]` 提升候选。内置阶梯**刻意不含 `clef:latest`**（27B 在 8 GB 显存上 300 s 未返回）。 |
| `escalationMaxAttempts` | `3` | 提升尝试次数上限；用尽即抛可行动错误，绝不静默降级。 |
| `scanFirstChunkBytes` | 未设（用 `LIMITS.softBodyBytes`） | 首块字节预算；后续块据服务端自己的 token 数字重切。 |
| `scanMaxChunks` | 未设（用 `LIMITS.scanMaxChunks`） | 单次扫描的块数上限；触顶返回**部分结果**而非失败。 |
| `scanMaxTotalBytes` | 未设（用 `LIMITS.scanMaxTotalBytes`） | 单次扫描的累计字节上限。 |
| `scanDeadlineMs` | 未设（用 `LIMITS.scanDeadlineMs`） | 单次扫描的墙钟预算，**独立于** `timeoutMs`。 |
| `scanAggregate` | `none` | `any` 会给每道 `noul` 题加一个**暂定**的跨块最大概率。跨块概率未经校准 —— 不得当作判定依据。 |

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
   **修复来源无法单一归因**（Ollama 版本与模型文件两者都变了）。**但本版仍不支持视觉**：
   没有 `images` 参数、也没有路径式读图 —— 见 ADR-3。`model_broken` 映射保留，作为上游回归的兜底。
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
   **刻意不跟随任何模型的 `num_ctx`**：它能在服务端拒绝**之前**响；越过它只在返回值里
   多一行 `body_warning`，**不改变任何拒绝行为**，权威守卫仍是服务端的 token 检查。
   注意字节数只是**粗糙代理**：中日韩等密集文字与 ID 密集文本的 token/字节比
   远差于 3.33，此时该阈值**保护不足**。
6. **只解决「有界判定」。** 候选集合已知且有界的问题才归本插件；开放式生成、需要推理链、候选要边想边发现的情形，仍须交给生成式模型。
7. **置信度门限只加旗，不是保证。** 低于所配 `minConfidence`（或 `confidence` 缺失）的答案会被列进 `confidence_warning`；**没有任何答案**被删除、改写或拒绝。默认 0.25 只在一份小样本上标定过（`tev1:0.8b`，4 题 × 6 个候选排列），而不同模型的 confidence 尺度差约一个量级 ⇒ **换模型必须重新标定**。跨会话调研里唯一那次顺序翻转发生在 `confidence = 0.357`，高于本阈值；且 `confidence` 是分布集中度而非正确率 —— **没被列进告警 ≠ 该答案可信**。

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

## v2（0.2.0）

契约已定稿，**没有兼容开关**。

- `state` 与 `stateSource` **恰有其一**。用 `stateSource` 时由插件自己读盘，材料**不进你的上下文**。
- `stateSource: { kind: 'file', path, startLine?, endLine? }` 或 `{ kind: 'glob', pattern, limit? }`。glob：`*` 不跨 `/`，`**` 表示任意深度。**单文件**超字节上限即报错；**glob 总量**超上限则**截断**（`source.truncated` / `source.remaining`）。
- `strategy`：`auto`（缺省）＝先直发，溢出时**自动提升**到更大上下文的判定模型，再退化为**分块扫描**；`inline` 从不扫描；`scan` 总是扫描。
- 提升是**进程级粘滞**的，且只在**未显式传 `model`** 时发生；发生时结果里带 `escalated: { from, to, sticky }`。
- 扫描返回 `chunks`（逐块答案 + 行范围），**顶层没有 `answers`**。`scan.failed` / `truncated` / `aborted` / `remaining` 说明这次扫描有多完整；`aggregate` 是**暂定**值，不得当作判定依据。
- `plan` 回显插件实际决定的策略（`strategy` / `action` / `model` / `reason`）。
- 本包还随带一个 **skill**：启用 `dsh-decision-tools/skill` 行即把 `decision-usage` 放进会话技能目录（随包 `cordis.patch.yml` 默认两行都启用）。

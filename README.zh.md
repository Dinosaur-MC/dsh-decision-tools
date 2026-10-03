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
| `choice` | 2–26 个带描述的具名选项 | 最可能的选项，外加每个选项的概率 |
| `noul` | 可选 `{"false": ..., "true": ...}` 描述 | `noul`：为真的概率（是一个数，不是布尔） |
| `score` | 2–26 条由低到高排序的描述 | `score`：零基等级的概率加权均值，落在 0..N-1 刻度上 |

`confidence` 是**分布集中度** `1 - H(p)/ln N`，**不是**校准正确率。

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址 |
| `defaultModel` | `tev1:0.8b` | 调用未给 `model` 时使用的模型 |
| `timeoutMs` | `120000` | 单次请求预算，含冷加载 |
| `toolName` | `decision` | 模型看到的工具名 |
| `keepAlive` | 未设 | 透传为 `keep_alive`；未设则用服务端默认 |

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

1. **`clef` / `clef-flash` 在 Ollama 0.35.1 上已损坏。** 任何请求 —— 纯文本、
   带图、或单个最小 `noul` —— 都返回 500，响应体为
   `{"error":"{\"error\":{\"code\":500,\"message\":\"Clef: non-finite logit\",\"type\":\"server_error\"}}"}`。
   因此本版不支持视觉。
2. **更大不必然更对。** 同一题上 `tev1:0.8b` 给 `bug`（p=0.9648），而
   `tev1:latest`（4.2B）给 `billing`（p=0.5710，`bug` 仅 0.3212）——
   按题面看 `billing` 是更弱的答案。请按题实测选型。
3. 首次调用含模型加载（本机实测：`tev1:0.8b` 冷 14.3 s、热 11.1 s；
   `tev1:latest` 冷 15.7 s、热 8.0 s）。
4. 无流式、无工具调用，一请求一响应。
5. 服务端硬限：无图请求 64 KiB、64 题、每题 2–26 个选项。但真正先撞上的往往更小：
   有效上下文是该模型自己的 `num_ctx`，不是架构声明的 context length。本机
   `ollama show tev1:0.8b` 显示 `context length 262144`，而 `num_ctx = 2050`；
   按真实英技术散文实测（约 3.33 B/token），该上限只折合 **约 6.8 KiB 的 body**，
   因此 **约 8 KB 的 body 就会返回 HTTP 400**
   `prompt 0 has <N> tokens; expected 1–<M> (input is never truncated)`，
   映射为 `context_overflow` —— 输入**不会被截断**，也不会给出部分答案。
   本插件的体积告警阈值**远在该上限之内**（`LIMITS.softBodyBytes = 4096` B
   ≈ 1230 token ≈ 2050 的 60 %），故能在服务端拒绝**之前**响；越过它只在返回值里
   多一行 `body_warning`，**不改变任何拒绝行为**，权威守卫仍是服务端的 token 检查。
   注意字节数只是**粗糙代理**：中日韩等密集文字与 ID 密集文本的 token/字节比
   远差于 3.33，此时该阈值**保护不足**。
6. **只解决「有界判定」。** 候选集合已知且有界的问题才归本插件；开放式生成、需要推理链、候选要边想边发现的情形，仍须交给生成式模型。

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

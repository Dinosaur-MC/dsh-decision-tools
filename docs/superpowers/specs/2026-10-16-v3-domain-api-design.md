# dsh-decision-tools v3 领域接口设计（ADR-11..16）

> 状态：**已定稿**（2026-10-16）。实现见 `docs/superpowers/plans/2026-10-16-v3-improvement-plan.md` 的 Phase 3（Task 8–14）。
> 上游依据：ADR-1..6（`2026-10-04-dsh-decision-tools-design.md`）、ADR-7..10（`2026-10-12-auto-strategy-design.md`）、
> 事实与实测：`docs/architecture-current.md`（含 §8 r6 真机数字）、`docs/use-cases.md`（五类判定形状）。
> 本规格只覆盖**工具面与适配层**；P0 正确性修复（计划 Phase 2）与可靠性增强（Phase 5）不在本文件。

## 0. 问题陈述（为什么必须改）

1. **上游形状泄漏**：`/v1/systemone` 的每个问题各带一条 `instructions`，于是「一份共享判据判 N 项」只能把判据抄 N 遍。真机样例：35 项、请求体 26056 B，**73% 是重复判据**；计费 `input_tokens = 282651 ≈ 35 × 8076`。
2. **模式中的模式**：`strategy`（分块）与 `aggregate`（聚合）把上游与插件的**实现细节**暴露给调用方；`aggregate` 目前甚至被完全忽略（计划 Task 3 修）。
3. **上游词汇散落**：`noul`/`instructions`/`criteria`/`keep_alive` 分布在 6 个模块（`validate` 34 处、`parameters` 11 处等），改一处要动多处。
4. **输出读法不统一**：`answers` 按题型解包、`chunks` 与它互斥、告警散成 `body_warning`/`confidence_warning`、上游计量以 `usage`/`state_bytes`/`body_bytes` 直接出现。

**收益口径（先声明，防止自欺）**：本改造可计入收益的只有两项——**请求体字节数**与**服务端计费 `input_tokens`**；r6 实测 35 项下二者分别 −59.2% 与 −45.3%。**墙钟只降 8.0%**，不得把本改造说成省时间，也不得把 `input_tokens` 当 GPU 时间代理量。

---

## ADR-11 · 两种模式，显式互斥（取代 v2 的「state 万能槽 + questions」）

**决策**：工具面只承认两种调用模式，**同时出现即报错**：

| 模式 | 必给字段 | 语义 |
|---|---|---|
| 批量项目判定 | `material` + `rubric` + `items` + `type`（`choice`/`score` 另需顶层 `criteria`） | 同一判据，对 N 个项目**各自独立**判定 |
| 单材料多问题 | `material` + `questions` | 同一份材料上问 M 个**互不相同**的问题 |

- **`items` 的身份契约**：每一项是**自带的完整待判对象**（短文本或标识均可），其内容由调用方给全；**材料内的定位由 `material` 决定**，工具不得让模型临时推断「这一项是引用还是内容」。
- **`questions[k]` 的形状**：`{ name, type, instructions, criteria? }`，`name` 唯一且非空。
- **`criteria` 的两处形态（不得混用）**：批量模式用**顶层 `criteria`**（标签集只写一次，wire 层复制到每题）；异质模式用**每题自己的 `criteria`**（不同问题可能有不同标签集）。**异质模式里出现顶层 `criteria` 即报错**（与 `items`/`questions` 互斥同源：不给「谁生效」留空间）。批量模式的顶层 `criteria` 只对 `choice`/`score` 有意义：`type: 'noul'` 配顶层 `criteria` ⇒ `criteria_not_allowed`（noul 的两标签题面是**异质模式每题字段**，按 ADR-1..6 原样保留）。
- 互斥校验发生在**校验层**（计划 Task 10 的 `assertModeExclusive`）：两者都给 ⇒ `kind='mode_conflict'`；都不给 ⇒ `kind='mode_missing'`。

**依据**：`docs/use-cases.md` 前五类形状（前三类与第四类语义不同）；外部评审 §4.2（避免「哪个字段生效」的歧义）。

**被取代**：v2 的 `state`（字符串/对象/数组）+ `stateSource` + 单一 `questions` 形状；v2 的「恰好 `state` 与 `stateSource` 其一」不变量被 ADR-12 取代。

**验收**：两模式互斥可测（`mode_conflict`/`mode_missing` 各一例）；`items` 数量上限 = `LIMITS.maxQuestions`（64）。

## ADR-12 · `material`：一种抽象，三种形态；安全边界不变量全部保留

**决策**：把 `state`/`stateSource` 归一为 `material`，取值三种：

```text
material: string                          // 内联材料
        | { file: { path, startLine?, endLine? } }
        | { glob: { pattern, limit? } }
```

**安全边界不变量（逐条保留，不得因抽象而丢失）**：
1. 路径必须落在**会话工作区**内（`ctx.fs.contains(root)`）；绝对路径、`..`、盘符、UNC、含 NUL 一律拒绝。
2. 读取必须受**上限**约束（单文件 `maxSourceBytes`）。
3. **单文件超限 → 报错**；**`glob` 总量超限 → 截断并报告**（两者语义不同，不得合并）。
4. 截断的材料**不得被当作完整材料**（`coverage.truncated`/`truncatedBy` 必须如实）。
5. `glob` 收不到任何文件 ⇒ `source_empty`；起始目录不存在 ⇒ `source_missing`（都不是裸 `Error`）。
6. 诊断信息不得被抽象吞掉：业务接口可以简单，但失败原因、尝试过的路径/模式必须留在错误与 `notes[]` 里。

**依据**：ADR-7（引用式材料）；外部评审 §4.3。

**验收**：三条既有安全用例（工作区外拒绝、超限报错、glob 截断）在新参数名下**逐条复跑**。

## ADR-13 · 输出统一为五键，旧键硬切

**决策**：返回值只有五个键（`required` 至少含 `results` 与 `coverage`）：

| 键 | 形状 |
|---|---|
| `results` | `[{ id, type, value, probabilities?, confidence? }]`：`noul` 的 `value` 为布尔；`choice`/`score` 的 `value` 为所选标签；`probabilities` 为各标签概率 |
| `coverage` | `{ requested, answered, batches, truncated, truncatedBy?, failed, aborted }` |
| `material` | `{ source: 'inline' \| 'file' \| 'glob', bytes, descriptor? }` |
| `cost` | `{ model, inputTokens, bodyBytes, wallMs, escalated, attempts[] }` |
| `notes` | `string[]`（体积归因、低置信、扫描与分批提示都在这里） |

**硬切**：不提供兼容层（延续 v2 先例）。`results` 与批次数解耦 —— 调用方看到的永远是 N 条结果，分批是实现细节（ADR-14 + D6）。

- **`confidence` 保留**（上游每题都回，成本为零）；低于 `minConfidence` 的项**在 `notes[]` 里点名**，不再有独立的 `confidence_warning` 键。ADR-5 十点锚点中围绕置信度的两条据此改写，语义不变（**旗，不过滤**）。
- **`coverage` 是对内部路径的如实报告**（分批 / 截断 / 失败 / 取消），不是调用方旋钮的回执。
- **逐题细节（实现冻结，供渲染与文档对齐）**：`noul` → `value` 为布尔且 `probabilities{true,false}`；上游对 `noul` **不回 `confidence`**（`choice`/`score` 有），缺失即视为低置信；`choice`/`score` → `value` 为所选标签，`score` 的加权均值可由 `probabilities` 的 `0..N-1` 键复算。
- **缺位表示**：`coverage.failed = requested − answered`；未答项在 `results` 里以 `value: null` **占位**（保持 `results.length === requested`，调用方不必靠下标对齐）。
- **`cost` 的两项语义**：`escalated` 为布尔（本次是否发生升档）；`attempts[]` 为 `{ model, failureKind }` 列表（诊断用，正常路径长度为 1）。

- **渲染层只呈现概率，不呈现阈值化判定**：`noul` 行只打 `P(true)`，**不打布尔 `value`** —— 布尔是阈值化产物，写进模型可见文本会让它把概率读成判定；`value` 仍保留在返回数据结构里供机器消费。渲染层**不做任何阈值比较**（阈值只在 `lib/tool.js` 一处），低置信只经 `notes[]` 表达。

- **模型选择的可观测性走 `notes[]`**：`plan` 已被本 ADR 硬切，选档结论以 `notes[]` 的首行呈现（形如 `模型选择：<model>（<选档原因>）`）——否则调用方无法从结果解释「为什么用了这个模型」。

**依据**：外部评审 §5.3（输出要能区分完成/部分完成/失败/取消）；当前 `answers`/`chunks` 互斥的读法对调用方是额外负担。

**被取代**：`answers`、`usage`、`state_bytes`、`body_bytes`、`body_warning`、`confidence_warning`、`source`、`escalated`、`plan`、`chunks`、`scan`（迁移见文末表）。

**验收**：五键存在且旧键**不出现**（逐键断言 `'answers' in value === false` 等）；`results.length === requested`（失败项也要有位置，或以 `coverage.failed` 说明缺位）。

## ADR-14 · `depth: quick | normal | deep` 取代 `strategy`；删 `aggregate`

| depth | 模型档位 | 溢出升档 | 允许自动分批 | 允许**内部扫描** | 超预算时 |
|---|---|---|---|---|---|
| `quick` | 只用默认档 | 否 | 否 | 否 | **报错**并给出可行建议（改 `normal`，或少给几项） |
| `normal`（默认） | 容量分派（最小够用档） | 是（≤`escalationMaxAttempts`） | 是 | 否（不主动扫描） | 按 body 预算分批 |
| `deep` | 从更大档起步 | 是（上限更高） | 是 | 是 | 分批 + 优先大窗口档 |

- **`aggregate` 删除**：逐块聚合是扫描的内部策略，不构成调用方契约；空转的参数比没有参数更坏。
- **`depth` 可选、缺省 `normal`**：JSON Schema 的 `required` **只有 `material`**。模式内部字段（`rubric`/`items`/`type`，或 `questions`）不写进 schema 的 required，也不写 `oneOf` 分支（会把注入预算翻倍）——由校验层把关：同给即 `mode_conflict`、都不给即 `mode_missing`。
- **扫描（分块）在 v3 是内部行为，不是调用方可选模式**：只有 `depth='deep'` 允许插件在「材料装不下」或「问题本身可定位」时走分块；`normal` 只允许分批（同一份材料切成多次请求），不切块。`coverage` 如实报告是否走了分块（`truncated`/`truncatedBy`/`failed`/`aborted`）。**逐块最大聚合只是定位线索，不是文档级结论** —— 这条语义保留（技能文档必须继续写），但不再暴露成参数。
- `model` 保留为**高级逃生口**：显式给出即关闭本次容量分派与升档（既有语义不变，R1 裁定保留）。

**依据**：外部评审 §4.1；`docs/architecture-current.md` 已知偏差 #1（`aggregate` 被忽略）。

**验收**：三档各有测试（`quick` 超预算必须报错而**不是**悄悄分批）；`strategy`/`aggregate` 两个参数名不再存在。

## ADR-15 · 线格式适配层 `lib/wire.js` 与 wire 形状

**决策**：`lib/wire.js` 是**唯一**知道 `/v1/systemone` 的地方（纯函数、零 import），把 `noul`/`criteria`/`instructions`/`keep_alive` 全部收进来。

**wire 形状（逐字契约）**：

```text
state      = <材料文本> + '\n\n' + '判据：' + <rubric>
questions  = { '<i>': { type, instructions: items[i] } }        // 批量模式，键为 1-based 序号
**题名只是映射的键**：`questions` 的**值不含 `name`**（`{ type, instructions, criteria? }`），避免同一信息出现两处。
           | { '<name>': { type, instructions, criteria? } }   // 异质模式
keep_alive 只在此处透传；model 由 client 传入，不进 state
```

- **判据写在材料之后**：r6 实测位置会移动概率（mean|ΔP| 0.0208、max 0.2236），而 `B-结尾` 对已按旧形状校准的调用方更平滑（ρ 0.904 vs 0.587）⇒ 位置是**契约**，不是实现细节。
- `choice`/`score` 的 `criteria` 在批量模式下**复制到每个问题**（上游逐题要求），但只在 wire 层发生，调用方只写一次。

**依据**：r6（`docs/architecture-current.md` §8）；外部评审 §4.1（协议细节集中一处）。

**验收**：`test/wire.test.mjs` 断言 `body.state` 恰含一次判据且位于材料之后、`questions` 的键与项一一对应；并用检索确认上游词汇除 `wire.js`（及显示用途的 `render.js`）外无命中。

## ADR-16 · 容量阈值 = 窗口 × 安全余量 × 语言密度

**决策**：新增 `lib/density.js`：`cjkShare(text)`、`bytesPerToken(text)`（CJK 占比 ≥ 0.3 ⇒ **2.32**，否则 **3.33**）、`softBytesFor({ numCtx, margin = 0.6, text })`。`selectByCapacity` 改吃算好的 `softBytes`；`LIMITS.softBodyBytes` 降级为「拿不到窗口信息时的兜底」。

**依据**：r6 实测中文 2.32 B/token（英文冻结口径 3.33）⇒ 旧的全局 4096 B 在中文下**过于乐观**（4096 B 中文约占当年 tev1 窗口的 86%）。外部评审 §3.2（区分容量不足/模型不可用/连接失败/超时/请求无效，只有容量不足才升档 —— 与计划 Task 2 同源）。

**验收**：密度三例（中文/英文/同字节数中文更吃容量）；既有 A 方案用例的期望值按新口径重算并**写明原因**。

---

## 附 A · 旧键 → 新键 迁移表（Task 13/14 直接照抄）

| 旧 | 处置 | 调用方要不要动手 |
|---|---|---|
| `state` | 改名为 `material`（字符串仍是合法形态之一） | 要（改名） |
| `stateSource` | 并入 `material`（`{file:…}` / `{glob:…}`） | 要（改名 + 换形） |
| `strategy` | 删除，改传 `depth` | 要（改名 + 选档） |
| `aggregate` | 删除（语义并入 depth 与自动分批） | 要（删掉） |
| `questions[].instructions` | **语义不变**，但在批量模式下不再承载共享判据 | 视模式 |
| `criteria` | **新增顶层字段**（批量模式用；异质模式仍在每题里传） | 要（批量模式新写法） |
| 新增 `rubric`/`items`/`type` | 批量模式的必给字段 | 要（新写法） |
| `answers` | 改为 `results[]` | 要（换读法） |
| `chunks` | 删除（结果始终在 `results`） | 要（换读法） |
| `usage` / `state_bytes` / `body_bytes` | 合并进 `cost`（`inputTokens` / `bodyBytes`） | 要 |
| `body_warning` / `confidence_warning` | 合并进 `notes[]`（字符串，保留原文） | 要 |
| `source` / `escalated` / `plan` / `scan` | 归入 `material` / `cost` / `coverage` / `notes` | 要 |

## 附 B · 每轮回归都要保住的不变量

1. 恰好一种模式（取代旧的「state 与 stateSource 恰有其一」）。
2. `results` 与批次解耦：分批只改请求次数，不改返回结构。
3. 工作区闸 + 读取上限 + 「单文件报错 / glob 截断」两种语义。
4. 配套 skill 的跨文件不变量（`COMPANION_SKILL === SKILL_NAME`）与**首次使用交付 skill 正文**。
5. 注入预算：描述 ≤1900 B、参数 schema ≤3600 B、skill ≤4000 B。
6. 只有容量类错误才升档；升级成功才写粘滞（R1）。
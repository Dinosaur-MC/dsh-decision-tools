# `decision` 工具：使用场景（use cases）

> 与 `docs/architecture-current.md` 配套：那篇讲**是什么**，这篇讲**什么场景该用、怎么调、成本与边界在哪**。
> 事实基线：2026-10-19 代码态 · 套件 455/455 绿 · 本包注册**两个**模型可见工具：`decision`（八键：`material`/`rubric`/`items`/`questions`/`type`/`criteria`/`depth`/`model`）与 `monitor`（探测式等待原语，见 §7）。

## 0. 判定形状（决定它适配哪些场景）

- 输入 = **一份共享材料** + **1–64 个有界问题**；输出 = 每题的概率 / 标签 / 分档。
- **不产文字**、不做推理链、**本扩展不带图片输入**（上游 System One 支持 `images`，见 §5 口径注）。
- 适用前提三条：**候选集已知且有限**、**判据能写清**、**答案能用概率表达**。
- **`monitor` 是另一个工具、不是本工具的档位**：它把同一份判定能力用在「对同一个问题反复问」上（等一个事件发生），见 §7。

## 1. 五类判定形状（主分类）

| # | 形状 | 典型场景 | 题型 | 材料与判据怎么给 | 一次项数 | 旧 API 的手感（对照） |
|---|---|---|---|---|---|---|
| 1 | **逐项二值筛选**（同判据判 N 项） | 文献/资料是否属于核心集 · 候选是否相关 · 告警是否真阳 · 工单是否需人工 · 段落是否含敏感信息 | `noul` | `material`（共享材料）+ `rubric`（判据，只写一次）+ `items`（每项自带完整短对象） | 10–64 | **最别扭**：判据要抄 N 遍（真机 35 项实测：请求体 73% 是重复判据） |
| 2 | **同标签集归类**（N 项各自归一类） | 意图路由 · 工单/日志分类 · 渠道识别 · 失败原因归类 | `choice`（选项 2–255） | 同上 + 顶层 `criteria`（选项集，只写一次） | 10–64 | 判据与选项集都要抄 N 遍 |
| 3 | **分档打分 / 排序** | RAG 重排 · 相关性分级 · 候选质量分档 · 风险等级 | `score`（档位 2–10） | 同上 + 顶层 `criteria`（档位描述，只写一次） | 10–64 | 档位描述要抄 N 遍 |
| 4 | **一材料多异质问题** | 一份合同问 5 个不同问题 · 一份报告问是否合规/是否含某字段/是否需复核 | 混合 | 材料=那一份；每题自己的 `instructions` | 2–10 | 手感尚可（本来就该每题一句） |
| 5 | **长材料定位**（哪些块提到 X） | 跨长文或多文件找相关段 · 大文档初筛候选段 | `noul` | `material` 的 file/glob；材料装不下时 `depth: 'deep'` 允许内部按块扫描 | 1–8 | 分块只答**可定位**问题；材料过大时装不下就报错，不会自动分块 |

## 2. `material` 的四种形态

| 形态 | 何时用 | 注意 |
|---|---|---|
| 内联字符串 | 材料小（几百字节）且本就在上下文里 | 每多一份材料就多一份请求体 |
| `{ file: { path, startLine?, endLine? } }` | 材料在工作区文件里、**不想进自己的上下文** | `path` 必须**工作区相对**（绝对路径 / `..` / 逃逸符号链接一律拒）；行范围 1-based 闭区间；单文件超上限**报错**，不截断 |
| `{ glob: { pattern, limit? } }` | 一批文件要一起判 | `*` 不跨目录、`**` 任意深度；总量超上限**截断**，并在 `coverage.truncated` / `coverage.truncatedBy` 如实报告 —— **截断的材料不得当完整材料用** |
| `{ tool: { name, arguments? } }` | 材料是**另一个工具的输出**：既不想把它拉进自己的上下文，又要判它 | 插件在**进程内**委托执行（**始终**带 `agent` 与 `parent`）、取**原始输出**、**无条件**转储，并把 `spillPath`/`bytes`/`fullBytes`/`truncated`(/`exitCode`) 回传到 `material` —— 原始输出**不被吞掉**。**禁自递归**（名单含生效的 `toolName` 与 `monitorToolName`）。缺 `agent` 会让作用域外工具名报 unknown tool；缺 `parent` 会让模型面 content 被截断 |

四种形态由 `material` **一个参数**承载（取代旧版的 `state` + `stateSource`），且后三种引用式形态都由插件自己取料、**永不进你的上下文**。`material` 是**必填**。

## 3. 场景 → 调用骨架

### 3.1 逐项二值筛选（35 条文献，真机案例）

v3 形状 —— 判据只写一次，N 项各自只带自己的短对象：

```jsonc
{
  material: { file: { path: 'docs/开题报告.md', startLine: 233, endLine: 269 } },
  rubric: '属于 lens/双向变换、结构化编辑、增量解析、块↔文本同步的直接来源 ⇒ true；背景铺陈/领域泛论/教学综述/可替代工具文档 ⇒ false',
  items: [ '文献 [1]', '文献 [2]', …, '文献 [35]' ],
  type: 'noul',
  depth: 'normal'
}
```

**历史对照（旧形状，已被 v3 取代）**：同一个判定在旧工具面上只能把判据抄进每题的 `instructions`：

```jsonc
{
  stateSource: { kind: 'file', path: 'docs/开题报告.md', startLine: 233, endLine: 269 },
  questions: [ { name: 'r1', type: 'noul', instructions: '<判据全文> + 文献 [1]' }, … ]
}
```

实测代价（2026-10-13，旧形状）：请求体 26056 B（73% 是判据）、`input_tokens` 282651（= 题数 × 请求体）、被推出小模型窗口被迫用 nimble。**该样例发生时 tev1:0.8b 的窗口是 2050**；窗口现为 8192，同样的形状不再必然触发升档 —— 但「按题数重复计费」这一条与窗口无关，仍然成立。

### 3.2 一材料多问（异质问题，mixed 模式）

```jsonc
{ material: '<合同全文>',
  questions: [
    { name: '合规', type: 'noul', instructions: '是否含自动续约条款？' },
    { name: '风险', type: 'score', instructions: '风险等级', criteria: [ '低', '中', '高' ] } ] }
```

### 3.3 长材料定位（深档 + `coverage` 读法）

```jsonc
{
  material: { glob: { pattern: 'docs/**', limit: 20 } },
  depth: 'deep',
  questions: [ { name: '提到X', type: 'noul', instructions: '本段是否提到 X' } ]
}
```

扫描在 v3 里**不是调用方旋钮**：只有 `depth: 'deep'` 才允许插件在「材料装不下 / 问题本身可定位」时内部分块；`normal` 只允许**分批**（同一份材料切成多次请求，调用方看到的仍是 N 条结果），`quick` 连分批都不做（超预算直接报错并给建议）。是否真的走了分块，由 **`coverage`** 如实报告（`truncated` / `truncatedBy` / `failed` / `aborted`）。逐块最大值只作定位线索，**不是**文档级结论。

## 4. 成本与窗口：决定「一次能问多少」

- **计费 = 题数 × 请求体**（已实测：`input_tokens = Σ prompt_k`）⇒ 重复判据被乘 N 次；
- **窗口**（`num_ctx`，2026-10-15 实测）：`tev1:0.8b` 8192 · `tev1:latest` 8192 · `clef-flash:latest` 16384 · `nimble-v3:latest` 32768 · `nimble:latest` 8194 · `clef:latest` 16384；默认阶梯现为 `tev1:0.8b` → `tev1:latest` → `clef-flash:latest` → `nimble-v3:latest`；
- **字节换算**：英文 3.33 B/token，**中文实测 2.32 B/token** ⇒ 中文材料要按更小的字节数留余量；
- 结论：项数多时要么**判据只写一次**（v3 形状），要么让插件按 body 预算**分批**；`depth: 'deep'` 的内部分块救的是**材料太大**，**不救题数太多**。

## 5. 反场景（不要用它做这些事）

| 不要做 | 理由 | 替代 |
|---|---|---|
| 开放式生成、写文案、出摘要 | 它**不产文字**，只回概率 | 生成式模型 |
| 需要推理链、多跳计算 | 不做逐步推理 | 生成式模型 + 明确步骤 |
| 需要**可读判据**作为证据存档 | tev1 系只回概率 | 生成式模型，或人写结论 |
| 路由 / 放行的**最终判据**（fail-open/closed） | 概率不是证明；模型坏了会连带坏掉路由 | 确定性规则；本工具只做初筛 |
| 对整篇长文问**整体**结论并交给深档内部分块 | 逐块最大 ≠ 文档级概率 | 先分块定位候选段（`depth: 'deep'`），再对候选段单发提问 |
| 图片 / 视觉判定 | **当前 DSH 扩展不支持**（`decision` 工具面没有 `images` 参数） | 直接用 Ollama `/v1/systemone` 的 `images` 字段（本扩展未包），或另用视觉模型/工具 |
| 把结果当**正确性证据** | 概率是提示不是证据 | 产物级证据 |

> **口径注（图片，2026-10-16）**：**上游 System One 支持图片** —— `/v1/systemone` 请求体有 `images` 字段
> （base64 编码的 PNG/JPEG/WebP，被该次请求的所有问题共享），**Clef / Clef Flash 可判图**
> （官方决策指南原文：「Clef and Clef Flash read images alongside the state」）。本仓库的 `decision` 扩展
> **没有把 `images` 暴露成工具参数**，所以上表记「不支持」——这是**本扩展的缺口，不是上游或 System One 的限制**。
> 本地请求体限制也因此分两档：文本与 schema（不含图）≤64 KiB，整包（含 base64 与 JSON）≤32 MiB。

## 6. 场景 × API 适配度（v3 的验收标准）

| 场景 | 旧形状要写多少重复 | v3 之后 |
|---|---|---|
| 逐项二选一（N 项同判据） | 判据 × N | **判据 1 份 + N 个 item**（形状上不可能重复） |
| 同标签集归类（N 项） | 判据 × N + 选项集 × N | 判据 1 份 + 选项集 1 份 |
| 分档打分（N 项） | 判据 × N + 档位 × N | 同上 |
| 一材料多问 | 本来就不重复 | 保持（`questions` 模式；与 `items` **互斥**，不能并存） |
| 长材料定位 | 不需要重复 | 保持；批大小由插件按 body 预算决定 |

## 7. `monitor`：等一个事件发生（第二个工具）

`monitor` 与 `decision` 共用同一个判定内核，但用途相反：`decision` 是**一次性批量判定**，`monitor` 是**对同一个问题反复问、直到答案稳定**。

### 7.1 三个典型场景

| 场景 | `source` | 判据（`rubric`）怎么写 |
|---|---|---|
| 文件里出现某行 | `{ file: { path: 'build.log' } }` | 「尾部是否已出现 `BUILD SUCCEEDED`？」 |
| 后台作业输出出现关键字 | `{ job: { id: '<jobId>' } }`（省略 `id` 看本会话最新作业；也可用 `select: 'oldest'` 或 `jobKind` 过滤） | 「作业尾部是否已报告完成 / 报错？」 |
| 一批文件里出现命中 | `{ glob: { pattern: 'out/*.json' } }` | 「是否有任何一个文件包含 `"status":"failed"`？」 |

调用骨架：

```jsonc
{
  description: 'watch build.log for BUILD SUCCEEDED',
  source: { kind: 'file', path: 'build.log' },
  rubric: '日志尾部是否已出现 BUILD SUCCEEDED？',
  countThreshold: 2,      // 累计两次命中；要连续两次则加 countMode: 'consecutive'
  intervalMs: 5000,
  timeoutMs: 120000
}
```

### 7.2 `command` 与 `events` 两个源（真机口径）

```jsonc
// 等一条命令的输出满足判据（自己会重复执行，委托复用 decision 的委托管道）
{ description: 'watch command output',
  source: { kind: 'command', argv: ['pwsh', '-Command', 'Get-Content build.log -Tail 20'] },
  rubric: '输出里是否出现 BUILD SUCCEEDED？', intervalMs: 5000, timeoutMs: 120000 }

// 等某个作业失败（有事件缓冲时读历史事件；没有缓冲时退到「此刻的状态投影」）
{ description: 'watch for failed jobs',
  source: { kind: 'events', types: ['job.failed'] }, rubric: '是否已有作业处于 failed？',
  mode: 'continuous', notifyEvery: 1, timeoutMs: 600000 }
```

- `command`：`argv[0]` 是解释器（`pwsh` / `git_bash|bash|sh`），其余按空格拼成命令文本；**带空格的参数要自己加引号**（`['bash','-lc','echo "a b"']`）。解释器自己的前导标志会被剥掉。
- **空样本**：`file`/`glob` 为空时 `monitor` 当场返回（`emptySource=true`，`samples=1`，**不调 Decision**）；`job`/`events`/`command` 的空样本按 P=0 记一次未命中并继续等待（事件还没发生，空不会自己变成非空）。
- `events`：优先用装配层注入的环形缓冲（**有历史**：`job.registered`/`job.settled`/`job.completed`/`job.failed`/`job.killed` …）；没有缓冲时退到 `ctx.jobs.list(sessionId)` 的**当前状态投影**（只反映此刻）。空样本判 P=0（不调模型），没有数据源当场 `invalid_request`。

### 7.3 适合 / 不适合

- **适合**：判据现在就能写清、事件由外部过程产生、你只想知道「发生了没有」。
- **不适合**：需要跨多轮推理的复杂目标；候选要边想边发现的开放问题；以及**想让它替你做动作** —— 它只通知。
- **判据（`rubric`）要写成可判的形状**（真机实测，同一文件同一模型）：`材料里是否包含字符串 MARKER-X` ⇒ p=0.992；`材料里是否逐字出现 MARKER-X` ⇒ **p=0.656**；`第一行是否以 MARKER-X 开头` ⇒ p=0.948。三次的 `evidence` 都逐字正确 ⇒ 概率差异来自**措辞**，不是采样。别用「逐字出现」「是否正确」这类模糊限定，用「包含/等于/以…开头/是否出现某行」。
- **全程不阻断**：`hit` 只进返回值与通知，绝不进任何 pass / allow / deny 判定。

### 7.4 反场景与硬边界

| 不要做 | 理由 |
|---|---|
| 期待命中后自动 kill / 重试 / 派发 | 插件**只通知**；动作必须由调用方显式发起 |
| 把 `at` / `atIso` 当判定输入，或用时间戳结算持续时间 | 毫秒**只作记录**，不参与命中判定；持续时间要用 `countThreshold × intervalMs` 的量级去估 |
| 传 `minGapMs` / `persistCount` / `resetCount` | 这些参数**不存在**：计数按探测结果累加（无冷却窗）且**不持久化**，传了会**显式报错**；`countMode` 是存在的（`cumulative`/`consecutive`） |
| 把它当持久调度器 / 跨重启监控 | 存活边界 = 前台调用时长或宿主进程寿命；宿主重启即连同作业与计数一起消失 |
| 起了 `background: true` 就不管 | 用 `job_output` 读 `jobId`；`notify: 'inbox'` 的合并、限频与唤醒预算是**防刷屏**的，不是投递保证 |

补充（2026-10-19 当前契约）：

- `description` 必填并折叠为单行；后台作业 label = `source.kind` + `description`；作业 kind 是工具名 `monitor`，`source.kind` 是输入参数。
- `job_output` 是**流式过程**：ISO 毫秒时间戳 + `config` / `hit=true|false`（连续模式 miss 只在下降沿写）/ `trigger_num` / `summary`，不再回最终 JSON。作业状态：abort ⇒ `killed`；全部探测 errors（无有效 verdict）⇒ `failed`；timeout/有有效 verdict ⇒ `completed`。
- `finished [...]` 的 detail：`once` 为 `hit/P|EP/dur_time`（`countThreshold>1` 用 EP），`continuous` 为 `trigger_num/EP/dur_time`。EP：once = Σ(hit P)/N（N=countThreshold，hit 不足 N 时补 0；0 hit ⇒ 0）；continuous = 各 trigger 的 P 均值（trigger P = 窗口 hit P 之和 / notifyEvery；trigger_num=0 ⇒ 0）。`hit=false` 时概率字段取 **1−EP**；布尔型 verdict 无 P 时按 0.00（detail/通知/流都不出现 `-`）；时间单位 ms。永久源错误（描述符/越界/显式作业 id 不存在/文件超限）当场失败，瞬态读取错误继续重试；abort 会打断 in-flight decide/sleep。
- 通知只在 **trigger** 时发（`once` 达标 / `continuous` 每 `notifyEvery` 次命中），正文一行：`decision-monitor: <jobId> (monitor: <label>) triggered [<ISO>, <detail>]. Inspect with job_output {"job_id":"…"}.`

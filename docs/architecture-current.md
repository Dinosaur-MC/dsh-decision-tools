# dsh-decision-tools — 现状盘点（架构 / 功能 / 接口）

> 快照时点：HEAD `549b057`（2026-10-13）· 套件 **174/174 绿** · 工作树干净。
> 本文只描述**现状**（as-is），不含 v3 提案；末尾单列已知偏差与待定项。

## 0. 一句话

把本机 Ollama 的 **System One** 判定能力（`POST /v1/systemone`，只回概率、不产文字）包装成一个 DSH agent 工具 `decision`：
一次调用问 1–64 题、共享同一份材料、由本机决策模型以毫秒级返回概率化判定。

## 1. 架构

### 1.1 装配（composition）

两个独立插件行（`cordis.patch.yml` 的 `- insert:` 块）：

| 行 | 包入口 | `inject` | 作用 |
|---|---|---|---|
| `decision-tools-tool` | `dsh-decision-tools`（`lib/index.js` → `tool.js`） | `['tools','fs','skills']` | 注册模型可见工具 `decision` |
| `decision-tools-skill` | `dsh-decision-tools/skill`（`lib/skill.js`） | `['skills']` | 注册随包 skill `decision-usage` |

- 无运行时依赖；peer 依赖 `dsh-tools` / `dsh-skill` / `cordis` / `schemastery`（`package.json`）。
- 打包白名单：`lib/**/*.js`、`assets/**`、`cordis.patch.yml`、两份 README、`LICENSE`、`THIRD_PARTY_NOTICES`（`docs/` 与 `test/` **不入包**）。
- 运行态通过 profile 的 `link:` symlink 指向工作区 ⇒ 磁盘代码即运行代码，**改码后要重载宿主**才生效。

### 1.2 模块图（行数 / 职责 / 依赖方向）

| 模块 | 行 | 职责 | 依赖 |
|---|---|---|---|
| `tool.js` | 674 | **唯一接触 `ctx` 的文件**：装配、参数解析、编排（单发/提升/扫描）、输出与渲染接线 | 其余全部 |
| `validate.js` | 362 | 参数与请求体校验、`LIMITS`、`prepareRequest`（工具面 → 线格式）、`analyzeBody`（体积归因） | — |
| `source.js` | 323 | 引用式材料：描述符校验、行范围切片、`chunk` 分块、glob 匹配器 | — |
| `client.js` | 311 | HTTP 层：`callSystemOne`、错误分类（含两种溢出分支）、`SystemOneError` | — |
| `escalate.js` | 232 | 阶梯、选档（`selectEscalation`）、粘滞（`resolveSticky`）、单飞、**容量分派 `selectByCapacity`** | — |
| `parameters.js` | 144 | 模型可见参数契约 `PARAMETERS` + 常驻 `TOOL_DESCRIPTION` | — |
| `render.js` | 144 | 把结果渲染成给模型看的文本（零 import 的纯函数） | — |
| `scan.js` | 129 | 分块扫描编排、`MAX_CONCURRENCY`、聚合 `aggregateNoul` | — |
| `skill.js` | 84 | 注册随包 skill（provider、frontmatter 解析、资产定位） | — |
| `plan.js` | 67 | 决策表：`planAction`（send/inline/scan/escalate/fail） | — |
| `index.js` | 6 | 入口再导出 | — |

依赖方向：`tool.js` → 全部纯模块；纯模块之间**无循环依赖**，且 `render.js` 零 import。

### 1.3 一次调用的数据流

1. **入口**：`execute(args, exec)`；先 `ctx.skills.get('decision-usage')`，拿不到 ⇒ 抛 `kind=skill_missing` **拒绝服务**。
2. **参数校验**：`assertStateExclusive`（`state` 与 `stateSource` 恰有其一）→ `resolveStrategy` → 逐题校验（题名唯一、题型合法、`choice` 选项数 2–`maxChoiceOptions`（默认 255）、`score` 档位 2–10）。
3. **材料物化**：`source.js` 读盘（三道闸：描述符字符串校验 / `ctx.fs.contains(root)` / `readBytes` 上限）。`file` 超限**报错**；`glob` 总量超限**截断**并报 `truncated`/`remaining`。材料**不进模型上下文**。
4. **模型选择**：`selectByCapacity` —— 显式 `model` 优先 → 估算字节 ≤ 默认档阈值走默认档 → 否则取阶梯里**容量足够的最小档** → 都不够取最大档 → 阶梯空/容量未知才用粘滞兜底。结果写进 `sticky`。
5. **请求**：`prepareRequest` 把工具面转成线格式（数组 → **对象映射**）；单飞闸 `createSingleFlight`（互斥，不共享结果）。
6. **溢出与提升**：命中 `context_overflow` 且未显式指定模型 ⇒ 沿阶梯逐档重试（`escalationMaxAttempts`，默认 3）；**只有成功才写粘滞**。
7. **扫描**（`strategy=scan` 或 auto 的兜底）：`scan.js` 按语义边界分块、逐块问、失败隔离、可中断、有 deadline；`answers` 与 `chunks` **互斥**。
8. **输出与渲染**：写 12 键结果（含体积告警、置信告警、`plan`），`render` 生成模型看到的文本；**首次使用**把 skill 正文一并交付。

### 1.4 边界与不变量

- 唯一接触 `ctx` 的是 `tool.js`；其余模块是**纯函数**（可独立单测）。
- 不注册 prompt 段（ADR-5）；使用指引住在「工具描述 + 随包 skill」两处（前者常驻、后者按需）。
- `answers` 与 `chunks` 在所有返回路径上互斥；返回值的 own key 一律**无损 JSON**（宿主会强校验）。

## 2. 功能清单

| 功能 | 现状 | 出处 |
|---|---|---|
| 三题型 | `choice` / `noul` / `score`，可混用，共享一份材料 | `parameters.js` |
| 内联材料 | `state`（字符串/对象/数组） | 同上 |
| 引用式材料 | `stateSource{kind:'file'}` 支持 1-based 行范围；`{kind:'glob'}` 支持 `*`/`?`/`**`、`limit`、总量截断 | `source.js` |
| 安全闸 | 绝对路径/`..`/盘符/UNC/含 NUL 拒绝；`contains` 要求落在工作区根内 | `source.js`+`tool.js` |
| 自动提升 | 溢出 ⇒ 沿阶梯换更大窗口模型；可关闭（配置）；**失败不粘滞** | `escalate.js`+`tool.js` |
| 粘滞 | 进程级记住「显式指定」与「成功提升」的档，供之后不带 `model` 的调用继承（用户裁定 R1） | 同上 |
| 容量分派 | 按本次材料估算需求选最小可用档（A 方案，实测省约 13%） | `selectByCapacity` |
| 分块扫描 | 语义边界切块、逐块问、`aggregate` 暂定聚合、失败隔离、`aborted`/`deadline` | `scan.js` |
| 置信度门限 | 低于阈值 ⇒ `confidence_warning` 逐题点名（**旗**，不过滤） | `tool.js` |
| 体积告警 | 超 `softBodyBytes` ⇒ 告警；**按 `analyzeBody` 归因**到材料还是问题文本 | `validate.js`+`tool.js` |
| 随包 skill | `decision-usage`，**首次使用工具时随结果交付一次** | `skill.js` |
| 取消 | `AbortSignal` 贯穿读取与 HTTP | `client.js`/`tool.js` |

## 3. 接口

### 3.1 模型可见工具面（参数契约）

| 参数 | 必填 | 形状 | 说明 |
|---|---|---|---|
| `state` | 否 | `string` 或 `object` 或 `array` | 内联材料；与 `stateSource` **恰有其一** |
| `questions` | **是** | `[{name, type, instructions, criteria?}]` | 1–64 题；`name` 唯一 |
| `stateSource` | 否 | `{kind:'file'|'glob', path?, startLine?, endLine?, pattern?, limit?}` | 引用式材料，**不进上下文** |
| `model` | 否 | `string` | 显式指定；**同时关闭本次自动提升**，并写进粘滞 |
| `strategy` | 否 | `auto` / `inline` / `scan` | 默认 `auto`（直发 → 提升 → 扫描） |
| `aggregate` | 否 | `none` / `any` | **仅 scan 生效**；非 scan 时是空转 |

### 3.2 输出契约（12 键，`required: []`）

`model` · `answers` · `usage` · `state_bytes` · `body_bytes` · `body_warning` · `confidence_warning` · `source` · `escalated` · `plan` · `chunks` · `scan`

- `answers[name] = {type, noul|choice|probabilities, confidence}`（**按题型解包**）；
- `chunks[]` 与 `answers` 互斥；`scan` 给 `failed`/`truncated`/`truncatedBy`/`aborted`/`remaining`/`bytesPerChunk`/`aggregate?`；
- `plan = {strategy, action, model, reason}`（`reason` 描述**策略**，不描述选档原因）。

### 3.3 线格式（上游）与解耦现状

线格式：`POST /v1/systemone` 的 `{model, state, questions: {<题名>: {type, instructions, criteria}}, keep_alive?}`；`questions` 必须是**对象映射**（数组会被服务端 400 拒）。

**现状：没有独立的线格式适配层**。上游词汇散落：`validate.js` 34 处、`parameters.js` 11、`client.js` 5、`scan.js` 5、`tool.js` 4、`render.js` 2（`noul`/`instructions`/`criteria`/`keep_alive`/`systemone`）。→ 这是 v3 要收的账。

### 3.4 配置接口（15 键）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址 |
| `defaultModel` | `tev1:0.8b` | 默认档 |
| `timeoutMs` | `120000` | 单请求超时 |
| `toolName` | `decision` | 模型看到的工具名 |
| `keepAlive` | 未设（服务端默认 5 min） | 透传上游 |
| `softBodyBytes` | 未设 ⇒ `LIMITS.softBodyBytes`(4096) | 体积告警阈值 |
| `bodyWarning` | 未设（开） | `false` 关闭体积告警 |
| `minConfidence` | 未设 ⇒ `LIMITS.minConfidence`(0.25) | 置信度门限 |
| `escalationEnabled` | `true` | 是否自动提升 |
| `ladder` | `[]` ⇒ `DEFAULT_LADDER` | 可覆盖阶梯 |
| `escalationMaxAttempts` | `3` | 提升尝试上限 |
| `scanFirstChunkBytes` / `scanMaxChunks` / `scanMaxTotalBytes` / `scanDeadlineMs` | 未设 ⇒ 各自的 `LIMITS` | 扫描三重预算与墙钟 |
| `scanAggregate` | 未设 | 服务端默认的聚合模式 |

### 3.5 skill 接口

`{name: 'decision-usage', provider: 'dsh-decision-tools', source: 'bundled', rank: 600, invocation: {modelInvocable: true, userInvocable: true}, resourceBase: {kind:'directory', path: <assets 目录>}}`；正文来自 `assets/decision-usage/SKILL.md`（frontmatter 必须含 `description`）。

### 3.6 模块导出面（public surface）

- `client`: `callSystemOne` · `classifyOverflow` · `SystemOneError`
- `validate`: `LIMITS` · `prepareRequest` · `assertStateExclusive` · `resolveStrategy` · `analyzeBody` · `DecisionValidationError`
- `source`: `validateSourceDescriptor` · `isUnsafePath` · `sliceByLines` · `chunk` · `splitGlobPattern` · `globSegmentToRegExp` · `matchGlobSegment` · `isRecursiveGlob` · `DecisionSourceError`
- `escalate`: `DEFAULT_LADDER` · `ESCALATION_MARGIN` · `BYTES_PER_TOKEN` · `selectEscalation` · `demandOf` · `selectByCapacity` · `resolveSticky` · `createSingleFlight` · `describeExhausted`
- `plan`: `planAction` · `STRATEGIES`；`render`: `renderAnswers`；`scan`: `runScan` · `aggregateNoul` · `MAX_CONCURRENCY`
- `tool`: `name` · `inject` · `Config` · `COMPANION_SKILL` · `OUTPUT_SCHEMA` · `apply`（+ `resolveSoftBodyBytes` / `resolveMinConfidence` / `collectLowConfidence`）

### 3.7 常量与阈值（`LIMITS`，唯一来源）

`maxQuestions: 64` · `minOptions: 2` · `maxChoiceOptions: 255` · `maxScoreLevels: 10` · `maxBodyBytes: 65536` · `maxSourceBytes: 61440` · `scanMaxChunks: 32` · `scanMaxTotalBytes: 4194304` · `scanDeadlineMs: 180000` · `scanMaxAdaptRounds: 2` · `softBodyBytes: 4096` · `minConfidence: 0.25`

## 4. 成本与容量口径（真机实测冻结）

- **模型窗口**（`num_ctx`，2026-10-15 重拉后实测）：tev1:0.8b num_ctx                        8192 · tev1:latest num_ctx                        8192 · clef-flash:latest num_ctx                        16384 · nimble-v3:latest num_ctx                        32768 · nimble:latest num_ctx                        8194 · clef:latest num_ctx                        16384。**注意：这与 2026-10-13 之前的记录不同**（当时 tev1:0.8b 为 2050、默认阶梯含 `nimble:latest` 8194）。
  `tev1:0.8b` **8192** · `tev1:latest` **8192** · `nimble:latest` **8194** ·
  `clef-flash:latest` **16384** · `clef:latest` **16384** · `nimble-v3:latest` **32768**。
  （旧值 `2050 / 2050 / 8194 / 16384` 已随模型重拉失效。）
  ⚠️ **这是快照**：`num_ctx` 会在模型重拉后变化，权威读法是 `/api/show` 的 `parameters`。
- **模型可用性（2026-10-15 18:07 实测）**：**6 个 decision 模型全部可用**（`tev1:0.8b` /
  `tev1:latest` / `nimble:latest` / `nimble-v3:latest` / `clef-flash:latest` / `clef:latest`）。
  ⚠️ Ollama **0.40.4 会拒收未重拉的旧格式模型**（`was downloaded in a format that is no
  longer supported`），而**该状态随重拉瞬变**：同日内 `nimble`/`clef-flash`/`clef`
  先后由不可用变为可用（16:08→18:0x）。⇒ 任何「可用/不可用」陈述**必须现测**，
  且不得据一次瞬态把模型移出配置。
- **测试装置的并发竞态（2026-10-15 记录，非产品缺陷）**：在**人为并发负载**下，套件会出现
  约 1/10 概率的间歇失败，症状是 client 层分类从预期值退化为 **`unreachable`**
  （第 4/5/7/138/141 例都出现过，**每次不同的用例**）。已证**不是本轮改动引入**：
  ① 同样的竞态在改动前的 **HEAD（`409a526`）隔离 worktree 上同样复现**；② 我的 `lib/client.js`
  改动**只是注释**；③ 空闲时连跑 40 次无命中，只有加并发负载才出现。根因是**每个用例各起一个
  临时端口上的假服务、而 undici 连接池是进程级全局的**，负载下端口被复用导致池中旧连接指向
  已关闭的服务。`server.keepAliveTimeout = 0` 试过**无效**（仍 1/11 命中）⇒ 已撤回，未留在仓库。
  真正要修需要**按用例隔离 fetch 调度器**（`undici` 的 `Agent`/`Pool` 显式注入）而非依赖全局池。
- **服务端 criteria 硬限**（OpenAPI + 实测）：`choice` **2–255**（规格注明依模型而异；
  256 → 400 `too many options (256), this model supports at most 255`）·
  `score` **2–10**（11 → 400 `score criteria must be an array of 2–10 levels`）。
  二者是**独立约束**，不可共用一个常量。
- **冷加载**：tev1 约 4.8 s · nimble 约 15.0 s；**warm 单次**：小材料 97 ms vs 865 ms（大档慢 7–9 倍）。
- **计费口径（已证实）**：`input_tokens = Σ prompt_k = 题数 ×(该 body 的精确 token 数 + 每问模板常数 38)+（题号≥10 的题数）` ⇒ 请求体被**按题数重复计费**。
- **字节↔token**：英文冻结口径 3.33 B/token；**实测中文语料 2.32 B/token** ⇒ 同为 4096 B，中文约占 tev1 窗口的 **86%**（注释里写的是留 40%）。
- **扫描并发**：只支持 1（实测 c=2/4 在真实形态下仅 1.02–1.07×，代价是单块延迟 1.7–2.6×）。
- **注入预算**：常驻 description 1642 B + 参数 schema 3402 B + 输出 schema 609 B = **5653 B ≈ 1698 token/轮**；skill 正文 3976 B 只在首次使用时到达。

## 5. 测试与门禁

- 套件 `node --test test/*.test.mjs` = **174 例**（显式 `test(` 159 条 + 表驱动生成 17 条：§4.9 锚点 10、skill 锚点 7）。
- 守卫：§4.9 十点判别性锚点、README 配置表与 `Config` 投影一致、注入预算上限（description ≤1900 / schema ≤3600 / skill ≤4000）、`COMPANION_SKILL === SKILL_NAME`、缺 skill 拒服务、首次交付 skill 正文。
- 另有：`node --check lib/*.js`、CR 字节 = 0、变异自检（累计 30+ 个定点变异全杀）、隔离实例真机冒烟。

## 6. 已知偏差 / 未修 / 待定

| # | 项 | 状态 |
|---|---|---|
| 1 | `aggregate` 参数被**完全忽略**（只读配置 `scanAggregate`） | r3 审查 P1，未修 |
| 2 | `strategy:'scan'` + 结构化 `state` ⇒ 裸 `TypeError` | r3 审查 P1，未修 |
| 3 | `describeExhausted` 被 import 却**零调用**（提升用尽抛原始错误） | r1 审查 P1，未修 |
| 4 | 提升循环不复查 `failure.kind` ⇒ 非溢出失败也换档，真实错误被丢弃 | r1/r3 P1，未修 |
| 5 | 规格 §3.3.5（B 支放宽 4 轮）与 §3.3.4（413 折算重切）未实现 | r1 P1，未修 |
| 6 | **中文 2.32 B/token** ⇒ 按字节的容量阈值对 CJK 过于乐观（中文安全阈值应约 2853 B） | r6 实测，未修 |
| 7 | `resolveSticky` 已无调用者（A 方案引入 `selectByCapacity` 后） | 孤岛代码，待删 |
| 8 | `plan.reason` 不反映选档原因（只反映策略） | r3 P2，待定 |
| 9 | 文案漂移：`lstat` 闸（已改 realpath+contains）、部分 v1/v2 措辞、规格 §9 状态未回写 | 文档级 |
| 10 | 显式 `model` 永久改写进程级粘滞 | **用户已裁定保留（R1）** |

## 7. 上游词汇泄漏面（v3 要收的账）

| 我们的字段 | 上游来源 | 后果 |
|---|---|---|
| `state` 单槽 | `/v1/systemone` 的 `state` | 材料 / 判据 / 待判项挤在一个字符串 |
| `questions[].instructions` | 上游同名字段 | **上游每题一个 instruction** ⇒ 共享判据被迫重复 N 遍 |
| `type: choice/noul/score`、`criteria` | 上游题型 | 要在 skill 里教「noul 不是 boolean」 |
| `answers[name]` 题型包装 | 上游回包 | 读法按题型分散 |
| `usage` / `keep_alive` / `model` | 上游计量与 Ollama 概念 | 暴露「按题数重复计费」的口径 |
| `strategy` / `aggregate` | 上游分块与换模型实现 | 出现「模式中的模式」 |
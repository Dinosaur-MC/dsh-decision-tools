# dsh-decision-tools — 现状盘点（架构 / 功能 / 接口）

> 快照时点：HEAD `a0ad872`（2026-10-16）· 套件 **213/213 绿** · 工作树干净。已过一轮三人交叉对抗复审（task-12/13/14）与 Lead 终检，并在其后完成四轮修复（`3475758` / `588015d` / `5dba57d`+`2540e30` / `a0ad872`）。
> 本文描述 **v3 现状**（as-is）：工具面已收敛为 material/rubric/items/questions/type/criteria/depth/model 八键，输出统一五键。

## 0. 一句话

把本机 Ollama 的 **System One** 判定能力（`POST /v1/systemone`，只回概率、不产文字）包装成一个 DSH agent 工具 `decision`：
一次调用用**一份共享材料 + 一份共享判据**判定 1–64 个项目（或对一份材料问若干互不相同的问题），由本机决策模型返回概率化判定。

## 1. 架构

### 1.1 装配（composition）

两个独立插件行（`cordis.patch.yml` 的 `- insert:` 块）：

| 行 | 包入口 | `inject` | 作用 |
|---|---|---|---|
| `decision-tools-tool` | `dsh-decision-tools`（`lib/index.js` → `tool.js`） | `['tools','fs','skills']` | 注册模型可见工具 `decision` |
| `decision-tools-skill` | `dsh-decision-tools/skill`（`lib/skill.js`） | `['skills']` | 注册随包 skill `decision-usage` |

- 无运行时依赖；peer 依赖 `dsh-tools` / `dsh-skill` / `cordis` / `schemastery`（`package.json`）。
- 打包白名单：`lib/**/*.js`、`assets/**`、`cordis.patch.yml`、两份 README、`LICENSE`、`THIRD_PARTY_NOTICES`；`npm pack` 实测 **20 files / 78.0 kB**（`docs/`、`test/`、`smoke/` 在 git 里被跟踪但**不入包**）。
- 运行态通过 profile 的 `link:` symlink 指向工作区 ⇒ 磁盘代码即运行代码，**改码后要重载宿主**才生效。

### 1.2 模块图（13 个模块 / 3364 行）

| 模块 | 行 | 职责 |
|---|---|---|
| `tool.js` | 1015 | **唯一接触 `ctx` 的文件**：装配、参数解析、编排（分批 / 三档 depth / 内部扫描）、输出五键与渲染接线 |
| `validate.js` | 539 | 校验层：`LIMITS`、两模式互斥、material 归一、depth 解析、逐题校验、`analyzeBody` 体积归因 |
| `client.js` | 328 | HTTP 层：`callSystemOne`、错误分类（含溢出与 **fetch blocked port** 分支）、`SystemOneError` |
| `source.js` | 361 | 引用式材料：描述符校验、行范围切片、`chunk` 分块、glob 匹配器 |
| `escalate.js` | 286 | 阶梯、选档、单飞、容量分派 `selectByCapacity`、终态 `describeExhausted` |
| `render.js` | 193 | 把结果渲染成给模型看的文本（**零 import** 的纯函数） |
| `parameters.js` | 163 | 模型可见参数契约（八键）+ 常驻 `TOOL_DESCRIPTION` |
| `scan.js` | 151 | 分块扫描编排、`MAX_CONCURRENCY`、聚合 `aggregateNoul` |
| `density.js` | 88 | **语言密度层**：CJK 占比 → 2.32 / 3.33 B per token，`softBytesFor(窗口 × 0.6 × 密度)` |
| `skill.js` | 85 | 注册随包 skill（provider、frontmatter 解析、资产定位） |
| `wire.js` | 76 | **线格式唯一产地**：`WIRE_TYPES`、`toWireRequest`（判据写在材料之后） |
| `plan.js` | 73 | 决策表：`planAction`（send/scan/escalate/fail）—— **depth=deep 分块的唯一入口** |
| `index.js` | 6 | 入口再导出 |

依赖方向：`tool.js` → 全部纯模块；纯模块之间无循环依赖，`wire.js`/`render.js` 零 import。

### 1.3 一次调用的数据流

1. **入口**：`execute(args, exec)`；先 `ctx.skills.get('decision-usage')`，拿不到 ⇒ 抛 `kind=skill_missing` **拒绝服务**。
2. **模式与参数校验**：`assertModeExclusive` —— `items`（批量）与 `questions`（异质）**恰有其一**，同给即 `mode_conflict`、都不给即 `mode_missing`；`resolveDepth` 解析三档（缺省 `normal`）；逐题校验（题名唯一、题型合法、选项/档位按题型各自的 LIMITS）。
3. **材料物化**：`normalizeMaterial` 归一三形态（内联字符串 / `file` / `glob`），`resolveMaterial` 经 `source.js` 读盘（三道闸：描述符校验 / `ctx.fs.contains(root)` / `readBytes` 上限）。**单文件超限报错**；**glob 总量超限截断**并报 `coverage.truncated`/`truncatedBy`。材料**不进模型上下文**。
4. **模型选择**：`selectByCapacity` —— 显式 `model` 优先 → 估算字节（`softBytesFor`，按窗口与语言密度）≤ 默认档阈值走默认档 → 否则取阶梯里容量足够的最小档 → 都不够取最大档 → 阶梯空/容量未知才用粘滞兜底。选档结论以 `notes` 首行对外可见。
5. **线格式组装**：`wire.js` 的 `toWireRequest` 把 `material + rubric + items/questions + type + criteria + model + keepAlive` 组装成 `{model, state, questions}`：**`state` = 材料 + 两换行 + 判据块**（判据只出现一次、位于材料之后），`questions` 为对象映射（键为题名或 1-based 序号，值不含 name）。
6. **请求与提升**：单飞闸 `createSingleFlight`（互斥，不共享结果）；命中 `context_overflow` 且未显式指定模型 ⇒ 沿阶梯逐档重试（`escalationMaxAttempts`，默认 3）；**只有容量类错误才升档**，**只有成功才写粘滞**；用尽时抛统一终态 `escalation_exhausted`（附 `attempts`）。
7. **分批与内部扫描**（按 `depth`）：`quick` 只用默认档、不升档不分批（超预算报错）；`normal` 允许按 body 预算**分批**（只改请求次数，不改返回结构）；`deep` 额外允许**内部分块扫描**（`planAction` 定；失败隔离、可中断、有 deadline）。调用方看到的永远是 `results[]`，分批/分块是内部实现。
8. **输出与渲染**：写**五键**结果（`results` / `coverage` / `material` / `cost` / `notes`），`render` 生成模型看到的文本（**只呈现概率、不呈现阈值化判定**；阈值比较只在 `tool.js` 一处）；**首次使用**把 skill 正文一并交付。

### 1.4 边界与不变量

- 唯一接触 `ctx` 的是 `tool.js`；其余模块是纯函数（可独立单测，`wire.js`/`render.js` 零 import）。
- 不注册 prompt 段（ADR-5）；使用指引住在「工具描述 + 随包 skill」两处（前者常驻、后者按需）。
- **两模式互斥**（取代 v2 的「state 与 stateSource 恰有其一」）；`results` 与批次解耦；结果五键的 own value 一律是无损 JSON（宿主会强校验）。
- 安全边界不变量：工作区内、读取上限、「单文件报错 / glob 截断」两种语义不可混同、截断的材料不得当完整材料用。

## 2. 功能清单

| 功能 | 现状 | 出处 |
|---|---|---|
| 三题型 | `choice` / `noul` / `score`，可混用，共享一份材料 | `parameters.js`+`wire.js` |
| 两种模式 | 批量 `material+rubric+items+type`（顶层 `criteria` 可选）· 异质 `material+questions` | `validate.js` |
| 内联材料 | `material` 为字符串 | 同上 |
| 引用式材料 | `material:{file}` 支持 1-based 行范围；`material:{glob}` 支持 `*`/`?`/`**`、`limit`、总量截断 | `source.js` |
| 安全闸 | 绝对路径/`..`/盘符/UNC/含 NUL 拒绝；`contains` 要求落在工作区根内 | `source.js`+`tool.js` |
| 自动提升 | 溢出 ⇒ 沿阶梯换更大窗口模型；可关闭（配置）；**非容量错误不换档**、失败不粘滞 | `escalate.js`+`tool.js` |
| 粘滞 | 进程级记住「显式指定」与「成功提升」的档（用户裁定 R1） | 同上 |
| 容量分派 | 按材料估算需求选最小可用档；阈值 = 窗口 × 0.6 × 语言密度 | `selectByCapacity`+`density.js` |
| 分批 / 内部扫描 | 按 `depth`：normal 允许分批、deep 允许分块；结果始终在 `results`，分块/截断由 `coverage` 如实报告 | `tool.js`+`scan.js`+`plan.js` |
| 置信度信号 | 低于 `minConfidence` ⇒ 在 `notes[]` 点名（**旗**，不过滤；无独立告警键） | `tool.js` |
| 体积告警 | 超阈值 ⇒ 按 `analyzeBody` 归因（材料 or 问题文本），写入 `notes[]` | `validate.js`+`tool.js` |
| 随包 skill | `decision-usage`，**首次使用工具时随结果交付一次** | `skill.js` |
| 取消 | `AbortSignal` 贯穿读取与 HTTP | `client.js`/`tool.js` |

## 3. 接口

### 3.1 模型可见工具面（八键）

| 参数 | 必填 | 形状 | 说明 |
|---|---|---|---|
| `material` | **是** | `string` 或 `{file:{path,startLine?,endLine?}}` 或 `{glob:{pattern,limit?}}` | 共享材料；引用式形态**不进上下文** |
| `rubric` | 批量模式必填 | `string` | 共享判据，**只写一次**；wire 层放在材料之后 |
| `items` | 批量模式必填 | 数组（≤64） | 每项是**自带完整待判对象**的短文本或标识；schema 允许任意 JSON，非字符串项**原样透传**给上游 |
| `questions` | 异质模式必填 | `[{name,type,instructions,criteria?}]`（1–64） | 与 `items` **互斥**；每题自己的判据/选项 |
| `type` | 批量模式必填 | `choice`/`noul`/`score` | 批量模式的题型 |
| `criteria` | 批量 choice/score **必填** | 对象或数组 | **批量模式的顶层标签集**；`noul` 给即 `criteria_not_allowed`；异质模式写在每题里（schema 的 `required` 不含它，缺失由校验层给可行动报错） |
| `depth` | 否 | `quick`/`normal`/`deep` | 缺省 `normal`；三档语义见 1.3 第 7 步 |
| `model` | 否 | `string` | 显式指定；**同时关闭本次容量分派与自动提升**，并写进粘滞 |

JSON Schema 的 `required` **只有 `material`**；模式内部必填由校验层把关（同给 `mode_conflict` / 都不给 `mode_missing`）。

### 3.2 输出契约（五键）

| 键 | 形状 |
|---|---|
| `results` | `[{id,type,value,probabilities?,confidence?}]`：`noul` 的 `value` 为布尔（上游不回 `confidence`），`choice`/`score` 为所选标签 |
| `coverage` | `{requested,answered,batches,truncated,truncatedBy?,failed,aborted}`。`truncated` = **材料自身截断（glob 总量超 `maxSourceBytes`）或扫描截断**；`truncatedBy` 取值 `material` / `chunks` / `totalBytes` / `deadline`（未截断为 null）；`aborted` = 调用方取消（含最后一块因取消失败）；未答项在 `results` 里以 `value:null` **占位**（保持 `results.length === requested`） |
| `material` | `{source:'inline'/'file'/'glob',bytes,descriptor?}` |
| `cost` | `{model,inputTokens,bodyBytes,wallMs,escalated,attempts[]}`。`inputTokens`/`bodyBytes` = 本次调用**实际发出的全部请求**之和（含分批、deep 内部分块、失败尝试）；`attempts` 只记**选档/升档**尝试（`{model,failureKind}`，成功项 `failureKind=null`），同档内的分批/分块不逐条记 |
| `notes` | `string[]`：**首行是选档结论**（模型选择：<model>（<原因>）），其后是体积归因、低置信点名、扫描提示 |

硬切说明：v2 的 `answers`/`usage`/`state_bytes`/`body_bytes`/`body_warning`/`confidence_warning`/`source`/`escalated`/`plan`/`chunks`/`scan` 与 `strategy`/`aggregate` 参数**全部不再存在**（迁移见两份 README 的「旧→新」表）。

### 3.3 线格式（上游）与解耦

线格式：`POST /v1/systemone` 的 `{model, state, questions:{<题名>:{type,instructions,criteria}}, keep_alive?}`；`questions` 必须是**对象映射**（数组会被服务端 400 拒）。

- **组装唯一产地**：`lib/wire.js` 的 `toWireRequest`（`state` = 材料 + 两换行 + 判据块；判据只出现一次、且在材料之后 —— 位置是契约，见 §8）。
- **上游词汇仍在**：`noul`/`criteria`/`instructions` 等类型词汇在 `wire.js`（`WIRE_TYPES` 单一来源）与校验层（题型基数规则）出现，这是**业务校验的合法用词**；判据是「body 的构造只有一处」，而不是「字面上不出现上游词」。

### 3.4 配置接口（17 键）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址 |
| `defaultModel` | `tev1:0.8b` | 默认档 |
| `timeoutMs` | `120000` | 单请求超时 |
| `toolName` | `decision` | 模型看到的工具名 |
| `keepAlive` | 未设（服务端默认 5 min） | 透传上游（只在 wire 层出现） |
| `softBodyBytes` | 未设 ⇒ 按窗口×0.6×语言密度算；`LIMITS.softBodyBytes`(4096) 为兜底 | 体积告警阈值 |
| `bodyWarning` | 未设（开） | `false` 关闭体积告警 |
| `minConfidence` | 未设 ⇒ `LIMITS.minConfidence`(0.25) | 置信度门限 |
| `maxChoiceOptions` | 未设 ⇒ `LIMITS.maxChoiceOptions`(255) | 选项数**宽松默认**；权威是服务端 400 |
| `escalationEnabled` | `true` | 是否自动提升 |
| `ladder` | `[]` ⇒ `DEFAULT_LADDER` | 可覆盖阶梯（`{model,numCtx}`） |
| `escalationMaxAttempts` | `3` | 提升尝试上限 |
| `scanFirstChunkBytes` / `scanMaxChunks` / `scanMaxTotalBytes` / `scanDeadlineMs` | 未设 ⇒ 各自的 `LIMITS` | 扫描三重预算与墙钟 |
| `scanAggregate` | 未设 | 聚合模式（仅内部扫描路径使用） |

### 3.5 skill 接口

`{name:'decision-usage', provider:'dsh-decision-tools', source:'bundled', rank:600, invocation:{modelInvocable:true, userInvocable:true}, resourceBase:{kind:'directory', path:<assets 目录>}}`；正文来自 `assets/decision-usage/SKILL.md`（3945 B，frontmatter 必须含 `description`）。

### 3.6 模块导出面（public surface）

- `wire`: `WIRE_TYPES` · `toWireRequest`；`density`: `CJK_BYTES_PER_TOKEN` · `ASCII_BYTES_PER_TOKEN` · `CJK_SHARE_THRESHOLD` · `cjkShare` · `bytesPerToken` · `softBytesFor`
- `client`: `callSystemOne` · `classifyOverflow` · `SystemOneError`
- `validate`: `LIMITS` · `DEPTHS` · `DecisionValidationError` · `analyzeBody` · `validateQuestions` · `resolveDepth` · `normalizeMaterial` · `resolveMaterial` · `assertModeExclusive` · `assertBatchCriteria`
- `source`: `validateSourceDescriptor` · `isUnsafePath` · `sliceByLines` · `chunk` · `splitGlobPattern` · `globSegmentToRegExp` · `matchGlobSegment` · `isRecursiveGlob` · `DecisionSourceError`
- `escalate`: `DEFAULT_LADDER` · `ESCALATION_MARGIN` · `BYTES_PER_TOKEN` · `selectEscalation` · `demandOf` · `selectByCapacity` · `createSingleFlight` · `describeExhausted`
- `plan`: `planAction` · `STRATEGIES`；`render`: `renderAnswers`；`scan`: `runScan` · `aggregateNoul` · `MAX_CONCURRENCY`；`skill`: `name` · `inject` · `SKILL_NAME` · `PROVIDER` · `BUNDLED_SKILL_RANK` · `skillFileUrl` · `parseSkill` · `apply`
- `tool`: `name` · `inject` · `Config` · `COMPANION_SKILL` · `OUTPUT_SCHEMA` · `apply`（+ `resolveSoftBodyBytes` / `resolveMinConfidence` / `collectLowConfidence`）

### 3.7 常量与阈值（`LIMITS`，唯一来源）

`maxQuestions:64` · `maxItems:64` · `minOptions:2` · `maxChoiceOptions:255` · `maxScoreLevels:10` · `maxBodyBytes:65536` · `maxSourceBytes:61440` · `scanMaxChunks:32` · `scanMaxTotalBytes:4194304` · `scanDeadlineMs:180000` · `scanMaxAdaptRounds:2` · `softBodyBytes:4096` · `minConfidence:0.25`

## 4. 成本与容量口径（真机实测冻结）

- **模型窗口**（`num_ctx`，2026-10-15 重拉后实测）：`tev1:0.8b` 8192 · `tev1:latest` 8192 · `nimble:latest` 8194 · `clef-flash:latest` 16384 · `clef:latest` 16384 · `nimble-v3:latest` 32768。⚠️ 这是**快照**，权威读法是 `/api/show` 的 `parameters`（旧值 2050/2050/8194/16384 已随重拉失效）。
  - 补充（2026-10-16 实测）：`nimble:latest` 的 `modified_at = 2026-10-15T16:10`，其**服务端在 400 里报的可用窗口是 8448 token**（与 `/api/show` 的 num_ctx 8194 略有差异，以服务端报错为准）。
- **模型可用性**：6 个 decision 模型现均可用；但 Ollama 会拒收未重拉的旧格式模型，而**该状态随重拉瞬变** ⇒ 「可用/不可用」必须现测，不得据一次瞬态改配置。
- **测试装置的并发 flake（已定位并修复）**：真根因是 **WHATWG Fetch 的 blocked port** —— 装置曾从临时端口区间抽到规范禁用端口（5060/5061/4190/6666-6669/6679/6697 等），`fetch` 在本地直接拒绝、请求从未发出（服务端 `requests.length = 0`），旧码把它误判为 `unreachable` 并给出误导提示。**证伪了早先的 undici 全局池假设**（规定复现形状 200/200 绿、600 轮翻腾 0 失败、27833 条端口事件 0 条「在听却 ECONNREFUSED」）。修法：装置永不交出禁用端口（`cee0baa`）+ `lib/client.js` 单列 `bad_port` 判据（`4fb1d7a`）。
- **服务端 criteria 硬限**：`choice` **2–255** · `score` **2–10**（两者独立约束）。口径注：2–255 是**本机实测值**、非跨版本契约（官方文档自身不一致：决策指南写 2–26、API 参考写 maxProperties 255 且注明取决于模型）⇒ **运行时能力优先于静态常量**，`Config.maxChoiceOptions` 是覆盖点，权威是服务端 400（本机无机器可读规格：`/openapi.json` 等一律 404）。
- **冷加载**：tev1 约 4.8 s · nimble 约 15.0 s；**warm 单次**：小材料 97 ms vs 865 ms。
- **计费口径（已证实）**：`input_tokens = Σ prompt_k = 题数 ×(该 body 的精确 token 数 + 每问模板常数 38) +（题号≥10 的题数）` ⇒ 请求体被**按题数重复计费**。
- **字节↔token**：英文 3.33 B/token；**中文实测 2.32 B/token**（`density.js` 按 CJK 占比确定性推断，阈值 = 窗口 × 0.6 × 密度）。
- **扫描并发**：只支持 1（实测 c=2/4 在真实形态下仅 1.02–1.07×，代价是单块延迟 1.7–2.6×）。
- **注入预算（v3 现状）**：description **1809 B**（守卫 ≤1900）+ 参数 schema **3580 B**（≤3600）+ 输出 schema **841 B** = **6230 B ≈ 1871 token/轮**；skill 正文 3945 B（≤4000）只在首次使用时到达。⇒ 常驻成本比 v2 末期（5653 B ≈ 1698 token/轮）**涨了**：省的是每次调用的请求体与计费，不是常驻。

## 5. 测试与门禁

- 套件 `node --test test/*.test.mjs` = **213 例**（显式 `test(` **189** 条 + 表驱动 **24** 条 = §4.9 锚点 10 + skill 锚点 14）。**含墙钟的用例一律不得使用真实计时**：deep 的多轮重切预算用可注入时钟 + 纯函数 `scanRoundBudget` 断言（曾有一条用服务端忙等 60 ms 的用例在并行负载下抖红，已重写）。
- 守卫：§4.9 判别性锚点、skill 锚点（十四条 v3 读法 + 词表负例）、README 配置表与 `Config` 投影一致、注入预算上限（description ≤1900 / schema ≤3600 / skill ≤4000）、`COMPANION_SKILL === SKILL_NAME`、缺 skill 拒服务、首次交付 skill 正文。
- 另有：`node --check lib/*.js`、CR 字节 = 0、变异自检（累计 30+ 定点变异全杀）、隔离实例真机冒烟。
- **装置不变量**（`cee0baa` 之后）：假服务永不交出 fetch 禁用端口；并发负载下错误分类不退化为 `unreachable`。

## 6. 已知偏差 / 遗留 / 待定

| # | 项 | 状态 |
|---|---|---|
| 1 | `aggregate` 参数被完全忽略 | **已修**：参数已删除（v3 用 depth + 内部分块） |
| 2 | `strategy:'scan'` + 结构化 state ⇒ 裸 TypeError | **已修**：strategy 删除；结构化材料在 material 层被拒（`material_invalid`） |
| 3 | `describeExhausted` 零调用 | **已修**：升档耗尽抛统一终态 `escalation_exhausted`（附 `attempts`） |
| 4 | 提升循环不复查 `failure.kind` | **已修**：只有容量类错误才换档，其余透传原始错误 |
| 5 | 规格 §3.3.5 / §3.3.4 未实现 | **已消解**：相关策略（strategy/scan 旋钮）在 v3 已删除 |
| 6 | 中文 2.32 B/token 导致按字节的阈值过于乐观 | **已修**：`density.js` 按语言密度算阈值（窗口 × 0.6 × 密度） |
| 7 | `resolveSticky` 无调用者（孤岛代码） | **已修**：`6b740cc` 删除 |
| 8 | `plan.reason` 不反映选档原因 | **已修**：`plan` 被硬切，选档结论改由 `notes[]` 首行承载 |
| 9 | 文案漂移（历史段落、规格 §9 状态） | 文档级，随本轮文档批次收敛 |
| 10 | 显式 `model` 永久改写进程级粘滞 | **用户已裁定保留（R1）** |
| 11 | 墙钟**不可作卖点**（比值随模型状态漂移） | 口径纪律，见 §8 |
| 12 | `A` 形状 64 项在 nimble 上**不可执行** | 实测结论（设计要求，非缺陷） |
| 13 | `notes[0]` 契约未落地（选档结论曾被告警挤到末位） | **已修** `3475758` + 会红的守卫 |
| 14 | 单飞闸 JSDoc 与实现相反（照注释改会复活 r3 的 P0） | **已修** `588015d`（含读源码的守卫用例） |
| 15 | 材料截断未进 `coverage`（调用方会误认为材料完整） | **已修** `5dba57d`（新增契约值 `truncatedBy='material'`） |
| 16 | deep 分块流量未计入 `cost`（notes 与 cost 自相矛盾） | **已修** `5dba57d` |
| 17 | `scan.js` 硬切时 `remaining` 按行差高估 | **已修** `2540e30`（按行区间展开去重） |
| 18 | `lib/source.js` 的模型可见报错仍称 `stateSource`（照报错改参只会再失败） | **已修** `a0ad872`（13 处改 v3 参数路径 + 2 条回归守卫，含反空转自检） |
| 19 | 一条新守卫用真实墙钟判据（负载下抖红） | **已修** `2540e30`：改为可注入时钟 + 纯函数 `scanRoundBudget`；**含墙钟的用例一律不得使用真实计时** |

## 7. 上游词汇与形状的「账」已收

| 曾经的泄漏 | v3 处置 |
|---|---|
| `state` 单槽（材料/判据/待判项挤在一起） | `material` + `rubric` + `items` 三段式，语义分开 |
| `questions[].instructions` 被迫重复 N 遍判据 | `rubric` 只写一次，wire 层放进 `state`（材料之后） |
| 上游题型词汇散落 6 个模块 | body 构造收进 `lib/wire.js`；`WIRE_TYPES` 单一来源 |
| `answers` 按题型解包 + `chunks` 互斥 | `results[]` 单一读法，分批/分块只进 `coverage` |
| `usage`/`state_bytes`/`body_bytes` 直接暴露上游计量 | 合并进 `cost`（`inputTokens`/`bodyBytes`） |
| `strategy`/`aggregate`（模式中的模式） | `depth` 三档 + 内部自动分批/分块 |

## 8. 真机实测：共享判据写在哪里

### 8.1 r6（2026-10-13，旧窗口时代）

| 写法 | 请求体 | `usage.input_tokens` | 墙钟中位 | 准确率 |
|---|---|---|---|---|
| A 每题重复判据 | 22587 B | 254406 | 9973 ms | 31/35 |
| B 判据只写一次在 `state`（**定稿**） | 9213 B | 139256 | 9179 ms | 35/35 |
| B 但判据放在材料**之前** | 9213 B | 139256 | 9081 ms | 35/35 |

- **位置是契约**：B-开头与 B-结尾标签 35/35 一致，但概率会移动（mean|ΔP| 0.0208、max 0.2236）；对已按 A 校准的调用方 B-结尾更平滑（ρ 0.904 vs 0.587）⇒ 定稿「判据放在材料之后」。
- 计费口径（已证实）：`input_tokens = Σ_k prompt_k`；6 组 (项数, 体积) 对照逐 token 相等。
- **墙钟必须按批取中位**：r6 的 rep 1–3 与 rep 11–15 是两批，并池会把 A 拖到 13025.5 ms ⇒ 凭空出现 −29.8% 的假降幅。

### 8.2 run2（2026-10-16，v3 定稿形状，静默窗口单批）

| 档 | 臂 | 请求体 | `input_tokens` | 墙钟中位 | 准确率 |
|---|---|---|---|---|---|
| 10 | A / v3 | 6476 / **2929** | 20101 / **11291** | 3591 / 2739 ms | 10/10 · 10/10 |
| 35 | A / v3 | **22587** / **9165** | 239706 / **123121** | 29386 / 16446 ms | 32/35 · 32/35 |
| 64 | A / v3 | 41291 / 16414 | **不可测（5/5 被拒）** / 402423 | — / 37372 ms | — · 61/64 |

- **字节收益复现**：35 项 −59.4%（r6 −59.2%），且 A/35 请求体 **22587 B 与 r6 逐字相同**（dry 自检 matchR6）⇒ 基准锚住；64 项字节 −60.2%。
- **计费收益复现**：−48.6%（r6 −45.3%）。
- ⚠️ **墙钟不作卖点**：本轮比值 −44.0%，但绝对耗时是 r6 的约 2.9 倍 ⇒ 跨重拉不可直比（nimble 于 2026-10-15 重拉）；run2 五轮 29302–30201 ms 极紧，**排除了负载解释**。
- ⚠️ **准确率增益未复现**：两臂同为 32/35（r6 曾记 31/35 与 35/35）⇒ 不得沿用「更准」。
- ✅ **旧形状 64 项不可执行**：`request (12460 tokens) exceeds the available context size (8448 tokens)`，5/5 被拒；v3/64 单请求答出 61/64。⇒ 旧形状在 64 项规模上**装不进窗口**，不是「更贵」。
- shape 硬门：驱动工具 + recording 假服务截获**实际发出的 body**，逐条符合 §3.3 的形状。

**一句话口径**：这次改造的收益是**请求体 −59%、计费 −49%、64 项从不可行变为可行**；**不是省时间，也不是更准**。

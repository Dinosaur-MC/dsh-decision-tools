# dsh-decision-tools — 现状盘点（架构 / 功能 / 接口）

> 快照时点：代码 HEAD 2026-10-18（本轮三人交叉审查修复后）· 套件 **431 例**（430 pass / 1 skip / 0 fail） · 工作树干净（本轮文档提交在其上）。已过一轮三人交叉对抗复审（task-12/13/14）与 Lead 终检、四轮修复（`3475758` / `588015d` / `5dba57d`+`2540e30` / `a0ad872`）；其后新增 Monitor 与上游委托管道（`b1485e6`→`fcc1d86`），修掉一条真机 P0（`7a3c104`，见 §6 #22），并由 task-31 给 `decision` 补了同类宿主校验守卫（`b55b942`），本文已回填。
> 本文描述 **v3 + 四行/GUI 现状**（as-is）：`decision` 工具面为 material/rubric/items/questions/type/criteria/depth/model 八键，输出统一五键；同时注册第二个模型可见工具 `monitor`。

## 0. 一句话

把本机 Ollama 的 **System One** 判定能力（`POST /v1/systemone`，只回概率、不产文字）包装成一个 DSH agent 工具 `decision`：
一次调用用**一份共享材料 + 一份共享判据**判定 1–64 个项目（或对一份材料问若干互不相同的问题），由本机决策模型返回概率化判定。

本插件注册**两个**模型可见工具：`decision`（上面的判定）与 `monitor`（**异步探测式等待原语** —— 按间隔反复采样一个来源，用同一个判定内核问「目标事件是否已发生」，**按探测结果计数**，命中即返回；前台可阻塞等待，后台可作为宿主作业运行并通知）。

## 1. 架构

### 1.1 装配（composition）

四个独立插件行（`cordis.patch.yml` 的 `- insert:` 块）：

| 行 | 包入口 | `inject` | 作用 |
|---|---|---|---|
| `decision-tools-plugin` | `dsh-decision-tools`（`lib/index.js`） | `[]` | 核心行：发布共享模型/运行时配置；裸包名承载 `dsh.client` 与 `lib/browser.js` 浏览器半 |
| `decision-tools-decision` | `dsh-decision-tools/decision`（`lib/decision-entry.js`） | `['tools','fs','skills']` | 只注册 `decision` 工具 |
| `decision-tools-monitor` | `dsh-decision-tools/monitor`（`lib/monitor-entry.js`） | `['tools','fs','jobs','agents']` | 只注册 `monitor` 工具 |
| `decision-tools-skill` | `dsh-decision-tools/skill`（`lib/skill.js`） | `['skills']` | 注册随包 skill `decision-usage` |

- 无运行时依赖；peer 依赖 `dsh-tools` / `dsh-skill` / `cordis` / `schemastery`（`package.json`）。
- 打包白名单：`lib/**/*.js`、`assets/**`、`cordis.patch.yml`、两份 README、`LICENSE`、`THIRD_PARTY_NOTICES`；`npm pack --dry-run` 实测 **32 files**（大小以实跑为准；`docs/`、`test/`、`smoke/` 在 git 里被跟踪但**不入包**）。
- 运行态通过 profile 的 `link:` symlink 指向工作区 ⇒ 磁盘代码即运行代码，**改码后要重载宿主**才生效。

### 1.2 模块图（25 个模块 / 7985 行，`wc -l lib/*.js` 实测于 2026-10-18 代码态）

| 模块 | 行 | 职责 |
|---|---|---|
| `tool.js` | 1324 | 装配与编排中枢：decision/monitor 两条工具行共用的引擎（参数解析、分批 / depth 三档 / 内部扫描、输出五键与渲染接线）；source reader 由两条行各自创建 |
| `monitor.js` | 988 | Monitor 内核：五类采样源适配、探测循环、按探测结果计数、前台 deadline/取消、后台作业注册与进度 |
| `validate.js` | 905 | 校验层：LIMITS / MONITOR_LIMITS、两模式互斥、material 归一（含 file/glob 字符串简写）、depth 解析、逐题校验、criteria 归一（choice string[] / score {min,max}）、analyzeBody、validateMonitorArgs / validateUpstream |
| `pipe.js` | 525 | 上游委托管道：runUpstream（同时带 agent 与 parent）、原始输出提取、无条件转储 spillWrite、白名单读取器、委托深度上限 |
| `monitor-tool.js` | 578 | monitor 的模型可见面：紧凑方言参数契约、全函数 render（返回内容块数组）、注册 |
| `source.js` | 361 | 引用式材料：描述符校验、行范围切片、chunk 分块、glob 匹配器 |
| `client.js` | 352 | HTTP 层：callSystemOne、错误分类（含溢出与 fetch blocked port 分支）、SystemOneError |
| `escalate.js` | 328 | 阶梯、选档、单飞、容量分派 selectByCapacity、终态 describeExhausted |
| `render.js` | 193 | 把结果渲染成给模型看的文本（零 import 的纯函数） |
| `notify.js` | 178 | 通知策略：合并窗、限频、唤醒预算、投递（绝不调用 agent.cancel） |
| `parameters.js` | 183 | 模型可见参数契约（八键，含 material 简写分支）+ 常驻 TOOL_DESCRIPTION |
| `ollama.js` | 183 | 模型发现（Ollama /api/tags 或 OpenAI /v1/models + /api/show）：名称/上下文长度/参数量；支持 modelsPath 与 Bearer apiKey |
| `scan.js` | 151 | 分块扫描编排、MAX_CONCURRENCY、聚合 aggregateNoul |
| `event-log.js` | 158 | monitor 的 events 源生产者：定长环形缓冲 + 从 ctx.jobs 事件流映射 job.<status>（只读不写、故障隔离） |
| `density.js` | 88 | 语言密度层：CJK 占比 → 2.32 / 3.33 B per token，softBytesFor(窗口 × 0.6 × 密度) |
| `skill.js` | 88 | 注册随包 skill（provider、frontmatter 解析、资产定位） |
| `wire.js` | 76 | 线格式唯一产地：WIRE_TYPES、toWireRequest（判据写在材料之后） |
| `plan.js` | 73 | 决策表：planAction（send/scan/escalate/fail）—— depth=deep 分块的唯一入口 |
| `deliver.js` | 43 | 通知的最后一跳：deliverNotice(agents, mode, payload, info)（followup/inject 二分、绝不 cancel、失败静默） |
| `index.js` | 75 | 核心行入口：发布共享模型/运行时配置；裸包名承载 dsh.client 与浏览器半 |
| `browser.js` | 916 | 浏览器半：核心 bundle 卡片 + 两个工具行 Configure 表单、模型发现/顺序按钮、字段默认值、locale / CSS、staged save + revision fence；缺 primitives 用 HTML 兜底 |
| `config-bus.js` | 133 | 共享活配置总线：核心行发布 baseUrl/defaultModel/timeoutMs/keepAlive/apiKey/modelsPath/systemOnePath/modelOrder/escalationEnabled/ladder/toolName/monitorToolName/spillDirCap 的句柄，工具行每次读取；modelOrder 重排 ladder |
| `configs.js` | 56 | 三条行的 Config schema：SharedConfig / DecisionConfig / MonitorConfig（GUI 字段 .volatile()） |
| `decision-entry.js` | 15 | decision 行入口：Config + 只注册 decision 工具 |
| `monitor-entry.js` | 15 | monitor 行入口：Config + 只注册 monitor 工具 |
依赖方向：`tool.js` → 全部纯模块；纯模块之间无循环依赖，`wire.js`/`render.js` 零 import。接触 `ctx` 的**不止** tool.js：`monitor.js` 只在 `createSources` 里经注入的 ctx 触碰 `jobs`/`sessions`，`pipe.js` 只碰 `ctx.tools`，`monitor-tool.js` 只把 ctx 转交（注释里说明「本模块没有任何文件/glob 读取实现」）。

### 1.3 一次调用的数据流

1. **入口**：`execute(args, exec)`；先 `ctx.skills.get('decision-usage')`，拿不到 ⇒ 抛 `kind=skill_missing` **拒绝服务**。
2. **模式与参数校验**：`assertModeExclusive` —— `items`（批量）与 `questions`（异质）**恰有其一**，同给即 `mode_conflict`、都不给即 `mode_missing`；`resolveDepth` 解析三档（缺省 `normal`）；逐题校验（题名唯一、题型合法、选项/档位按题型各自的 LIMITS）。
3. **材料物化**：`normalizeMaterial` 归一**三形态**（内联字符串 / `file` / `glob`）；`tool` 由 `execute` 走 `resolveUpstreamMaterial` 旁路（不经 `normalizeMaterial`，故 `{tool,file}` 这类双给由 `execute` 显式报 `material_conflict`）。三种由 `resolveMaterial` 经 `source.js` 读盘（三道闸：描述符校验 / `ctx.fs.contains(root)` / `readBytes` 上限）：**单文件超限报错**；**glob 总量超限截断**并报 `coverage.truncated`/`truncatedBy`。第四种 `material:{tool:{name,arguments?}}` 走 `resolveUpstreamMaterial`：在**插件内**委托执行上游工具（`ctx.tools.execute`，**必须同时带 `agent` 与 `parent`**）、取**原始输出**、**无条件**转储到自建目录，并把 `material.spillPath`/`bytes`/`fullBytes`/`truncated`(/`exitCode`) 回传 —— **原始输出不被吞掉**；禁自递归（名单含生效的 `toolName` 与 `monitorToolName`）。材料一律**不进模型上下文**。
4. **模型选择**：`selectByCapacity` —— 显式 `model` 优先 → 估算字节（`softBytesFor`，按窗口与语言密度）≤ 默认档阈值走默认档 → 否则取阶梯里容量足够的最小档 → 都不够取最大档 → 阶梯空/容量未知才用粘滞兜底。选档结论以 `notes` 首行对外可见。
5. **线格式组装**：`wire.js` 的 `toWireRequest` 把 `material + rubric + items/questions + type + criteria + model + keepAlive` 组装成 `{model, state, questions}`：**`state` = 材料 + 两换行 + 判据块**（判据只出现一次、位于材料之后），`questions` 为对象映射（键为题名或 1-based 序号，值不含 name）。
6. **请求与提升**：单飞闸 `createSingleFlight`（互斥，不共享结果）；命中 `context_overflow` 且未显式指定模型 ⇒ 沿阶梯逐档重试（`escalationMaxAttempts`，默认 3）；**只有容量类错误才升档**，**只有成功才写粘滞**；用尽时抛统一终态 `escalation_exhausted`（附 `attempts`）。
7. **分批与内部扫描**（按 `depth`）：`quick` 只用默认档、不升档不分批（超预算报错）；`normal` 允许按 body 预算**分批**（只改请求次数，不改返回结构）；`deep` 额外允许**内部分块扫描**（`planAction` 定；失败隔离、可中断、有 deadline）。调用方看到的永远是 `results[]`，分批/分块是内部实现。
8. **输出与渲染**：写**五键**结果（`results` / `coverage` / `material` / `cost` / `notes`），`render` 生成模型看到的文本（**只呈现概率、不呈现阈值化判定**；阈值比较只在 `tool.js` 一处）；**首次使用**把 skill 正文一并交付。

### 1.4 边界与不变量

- **工具侧**接触 `ctx` 的不止 `tool.js`（还有 `monitor.js` 的采样源适配、`pipe.js` 的委托执行、`monitor-tool.js` 的转交）；`skill.js` 是**独立入口**、只用 `ctx.skills.registerProvider` 注册随包 skill（不碰 fs/tools）；其余模块是纯函数（可独立单测，`wire.js`/`render.js` 零 import）。
- 不注册 prompt 段（ADR-5）；使用指引住在「工具描述 + 随包 skill」两处（前者常驻、后者按需）。
- **两模式互斥**（取代 v2 的「state 与 stateSource 恰有其一」）；`results` 与批次解耦；结果五键的 own value 一律是无损 JSON（宿主会强校验）。
- **工具返回值必须与自己的 `output.schema` 逐键一致（宿主运行时硬校验）**：宿主 `createSuccessResult` 会 `validateJsonSchemaValue(output.schema, value, 'value')`，**有 violation 就 `throw ToolOutputError`** —— 顶层 `additionalProperties:false` 下**少声明一个真会返回的键**就等于**每次成功都失败**。⚠️ **本地测试直呼 `definition.execute` 会绕过这条 dispatch 校验**，所以「返回值键集 == schema 键集」必须由守卫钉住，不能靠「套件全绿」判断。2026-10-17 的真实事故与修法：`monitor` 前台分支返回 `probability` 而 `OUTPUT_SCHEMA` 未声明它 ⇒ 真机每次前台成功返回都会被判失败（当时 343/343 全绿也看不见）；`7a3c104` **补 schema 而不删字段**（render 一直在打印它，且它是与 `hitThreshold` 直接比较的第一性量），并在 monitor 侧加「用宿主 `validateJsonSchemaValue` 钉住两边键集」的守卫；decision 侧的同类守卫随 `b55b942`（task-31）落地。**边界**：真机 `createSuccessResult` 的**整条 dispatch 尚未跑过**（只跑了同一校验函数、同一入参）⇒ 「修后真机前台可用」是**推断**，真机验收归 task-26。
- **Monitor 只记录、不阻断、不持久化**：计数只在内存（每次运行从 0 起算，故**没有重置通道**），`at`/`atIso`/`firstAt`/`lastAt` 毫秒只作记录、不参与命中判定；命中只**通知**，插件绝不 kill/cancel/retry/派发。被设计性删除的参数（`minGapMs` / `countMode` / `persistCount` / `resetCount`）**显式报错**而不是静默忽略 —— 静默忽略会让调用方以为冷却生效了。
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
| 体积归因 | 按 `analyzeBody` 归因（材料 or 问题文本）写入 `notes[]`。**与 `softBodyBytes` 阈值无关**：形状类提示（问题文本占比高 / instructions 逐字重复）**任何体积下都输出**，阈值只管「体积告警」这句本身；`bodyWarning: false` 可整体关闭 | `validate.js`+`tool.js` |
| 随包 skill | `decision-usage`，**首次使用工具时随结果交付一次** | `skill.js` |
| 取消 | `AbortSignal` 贯穿读取与 HTTP | `client.js`/`tool.js` |
| Monitor 探测等待 | 五类采样源（`job`/`file`/`glob`/`command`/`events`）；**按探测结果计数、无冷却窗**；前台自管 deadline、后台注册为宿主作业并可按「合并 + 限频 + 唤醒预算」通知 | `monitor.js`+`monitor-tool.js`+`notify.js` |
| 上游委托材料 | `material:{tool:{name,arguments?}}`：插件内委托执行别的工具、取原始输出、**无条件**转储并回传 `spillPath`/`bytes`/`fullBytes`/`truncated`(/`exitCode`) | `pipe.js`+`tool.js` |

## 3. 接口

### 3.1 模型可见工具面（八键）

| 参数 | 必填 | 形状 | 说明 |
|---|---|---|---|
| `material` | **是** | `string` 或 `{file:{path,startLine?,endLine?}}` 或 `{glob:{pattern,limit?}}` 或 `{tool:{name,arguments?}}` | 共享材料；后三种是引用式形态，**不进上下文**；`tool` 见 §3.6 |
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
| `coverage` | `{requested,answered,batches,truncated,truncatedBy?,failed,aborted}`。`truncated` = **材料自身截断（glob 总量超 `maxSourceBytes`）或扫描截断**；`truncatedBy` 取值 `material` / `chunks` / `totalBytes` / `deadline`（未截断为 null）；`aborted` = 调用方取消（含最后一块因取消失败）；**`batches` 只数单元级分批、不含 deep 的内部分块**（真机实测：12 块时 `batches` 仍为 1 ⇒ 分块只体现在 `notes` 与 `cost`，不要拿 `batches` 当分块信号）；未答项在 `results` 里以 `value:null` **占位**（保持 `results.length === requested`） |
| `material` | `{source,bytes,descriptor?}`（`source` ∈ `inline`/`file`/`glob`）；**上游委托**时为 `{source:'tool',upstreamTool,bytes,fullBytes,truncated,spillPath,exitCode?}`（`exitCode` 仅进程型工具） |
| `cost` | `{model,inputTokens,bodyBytes,wallMs,escalated,attempts[]}`。`inputTokens`/`bodyBytes` = 本次调用**实际发出的全部请求**之和（含分批、deep 内部分块、失败尝试）；`attempts` 只记**选档/升档**尝试（`{model,failureKind}`，成功项 `failureKind=null`），同档内的分批/分块不逐条记 |
| `notes` | `string[]`：**首行是选档结论**（模型选择：<model>（<原因>）），其后是体积归因、低置信点名、扫描提示 |

硬切说明：v2 的 `answers`/`usage`/`state_bytes`/`body_bytes`/`body_warning`/`confidence_warning`/`source`/`escalated`/`plan`/`chunks`/`scan` 与 `strategy`/`aggregate` 参数**全部不再存在**；这是一次性结构升级，不保留兼容层（见两份 README 的「无兼容层」段）。

### 3.3 线格式（上游）与解耦

线格式：`POST /v1/systemone` 的 `{model, state, questions:{<题名>:{type,instructions,criteria}}, keep_alive?}`；`questions` 必须是**对象映射**（数组会被服务端 400 拒）。

- **组装唯一产地**：`lib/wire.js` 的 `toWireRequest`（`state` = 材料 + 两换行 + 判据块；判据只出现一次、且在材料之后 —— 位置是契约，见 §8）。
- **上游词汇仍在**：`noul`/`criteria`/`instructions` 等类型词汇在 `wire.js`（`WIRE_TYPES` 单一来源）与校验层（题型基数规则）出现，这是**业务校验的合法用词**；判据是「body 的构造只有一处」，而不是「字面上不出现上游词」。

### 3.3.1 错误 kind 契约

`DecisionValidationError.kind` 是**契约的一部分**（工具层与调用方按它分支，不能压成一律 `invalid_request`）。口径：

- **模式约束** ⇒ `mode_invalid`：`items`/`questions` 的数量与形态（数组形状、1–64、数量上下限）、模式互斥/缺失、`criteria`/`type` 只属于 batch。
- **字段级格式** ⇒ `invalid_request`：`name`/`type`/`instructions`/`criteria` 的内容错误（键名、值类型、空串、重名、纯数字题名）。
- 其余按域前缀：`material_*`（冲突/非法/过大）、`source_*`（非法/缺失/空/越界）、`upstream_*`（非法/自递归/深度）、`monitor_*`（参数/请求体）、以及传输层的 `timeout`/`transport`/`http_error`/`server_error`/`bad_response`。

**全部 67 处抛出点都显式给 `kind`**（不靠默认值）。守卫 `test/error-kinds.test.mjs`：扫描源码确认「缺显式 kind 的抛出点为 0」、kind 取值必须在登记清单内、且 `items`/`questions` 的数量与形态同口径。

**变更记录（2026-10-18）**：`questions` 数量与形态错误由默认 `invalid_request` 改为 `mode_invalid`（与 batch 模式 `items` 对齐）。这是**有意的契约变更**：依赖该 kind 的调用方需同步。

### 3.4 配置接口（29 键，按行计；modelOverride 在 decision/monitor 各一次）

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama 地址 |
| `defaultModel` | `tev1:0.8b` | 默认档 |
| `timeoutMs` | `120000` | 单请求超时 |
| `toolName` | `decision` | 模型看到的 decision 工具名（注册期） |
| `monitorToolName` | `monitor` | 模型看到的 monitor 工具名（注册期；改后重载 monitor + decision 行） |
| `keepAlive` | 未设（服务端默认 5 min） | 透传上游（只在 wire 层出现） |
| `apiKey` | 未设 | 远程 / System One 兼容接口的 Bearer token |
| `modelsPath` | `/api/tags` | 模型发现路径；OpenAI 兼容接口可改 `/v1/models` |
| `systemOnePath` | `v1/systemone` | 判定接口路径（相对 baseUrl） |
| `modelOrder` | 未设 | 逗号分隔的模型优先级；只重排 ladder 中已有项 |
| `softBodyBytes` | 未设 ⇒ 按窗口×0.6×语言密度算；`LIMITS.softBodyBytes`(4096) 为兜底 | 体积告警阈值 |
| `bodyWarning` | `true` | `false` 关闭体积告警 |
| `defaultDepth` | `normal` | 调用方省略 depth 时使用 |
| `minConfidence` | 未设 ⇒ `LIMITS.minConfidence`(0.25) | 置信度门限 |
| `maxChoiceOptions` | 未设 ⇒ `LIMITS.maxChoiceOptions`(255) | 选项数**宽松默认**；权威是服务端 400 |
| `escalationEnabled` | `true` | 是否自动提升 |
| `ladder` | `[]` ⇒ `DEFAULT_LADDER` | 可覆盖阶梯（`{model,numCtx}`） |

- **模型发现**：`lib/ollama.js` + `scripts/list-models.mjs` 读本机 `/api/tags` 与 `/api/show`，输出 `{models, ladder}`；`numCtx` 取**声明的** context_length（上限），实际 `num_ctx` 可能更小（本机实测 tev1 声明 262144 / 实际 8192）。`model_missing` / `model_broken` 的 hint 也指向这个脚本。
| `escalationMaxAttempts` | `3` | 提升尝试上限 |
| `scanFirstChunkBytes` / `scanMaxChunks` / `scanMaxTotalBytes` / `scanDeadlineMs` | 未设 ⇒ `LIMITS.softBodyBytes` / `LIMITS.scanMaxChunks` / `LIMITS.scanMaxTotalBytes` / `LIMITS.scanDeadlineMs`（**注意 `LIMITS` 里没有 `scanFirstChunkBytes`，它借的是 `softBodyBytes`**） | 扫描三重预算与墙钟 |
| `scanAggregate` | 未设 | 聚合模式（仅内部扫描路径使用） |
| `minProbeIntervalMs` | 未设 ⇒ `MONITOR_LIMITS.minProbeIntervalMs`(1000) | `monitor` 探测间隔的**下限**：模型给的 `intervalMs` 被抬到不小于它（钳制写进 `notes`） |
| `notifyCoalesceWindowMs` | 未设 ⇒ `MONITOR_LIMITS.defaultNotifyCoalesceWindowMs`(5000) | 同类 `monitor` 通知的合并窗口 —— inbox 自身**没有背压** |
| `maxNotificationsPerMinute` | 未设 ⇒ `MONITOR_LIMITS.defaultMaxNotificationsPerMinute`(6) | `monitor` 通知的每分钟上限（硬上限 600） |
| `spillDirCap` | 未设 ⇒ `DEFAULT_SPILL_MAX_BYTES`(16 MiB) | 上游委托转储目录（插件自建）的总量上限 |
| `modelOverride` | 未设 ⇒ 核心 defaultModel | decision / monitor 各自的模型覆盖（两行各一个） |

- **模型发现**：`lib/ollama.js` + `scripts/list-models.mjs` 读本机 `/api/tags` 与 `/api/show`，输出 `{models, ladder}`；`numCtx` 取**声明的** context_length（上限），实际 `num_ctx` 可能更小（本机实测 tev1 声明 262144 / 实际 8192）。`model_missing` / `model_broken` 的 hint 也指向这个脚本。

### 3.5 skill 接口

`{name:'decision-usage', provider:'dsh-decision-tools', source:'bundled', rank:600, invocation:{modelInvocable:true, userInvocable:true}, resourceBase:{kind:'directory', path:<assets 目录>}}`；正文来自 `assets/decision-usage/SKILL.md`（**7102 B**，frontmatter 必须含 `description`（**可路由性硬约束**：两个工具名与主要触发词必须落在**前 200 字符**内 —— 技能目录只展示这段前缀，超出即被截断；长度 ≤400 字符）；正文覆盖**两个工具的全部功能**：`decision` 的八键/四形态/三档 depth/五键读法/confidence/错误 kind，`monitor` 的 14 个参数、五类 source（含 `command` 的 argv 规则与 `events` 的全词表）、空源短路、后台 + `job_output`、通知三件套与输出字段）。

**裁定变更（2026-10-18，用户指令）：Skill 必须把功能写全。** 原 2026-10-17 裁定「不在 skill 里增加 Monitor 用法段」被**取代**：skill 是模型了解本插件能力的唯一按需入口，遗漏功能等于能力未交付。现在正文同时覆盖 `decision` 与 `monitor`，预算上限由 4000 B 提到 **8000 B**（按需加载，不进每轮注入）。约束只剩一条：**参数名必须与工具面同步**（守卫 `test/parameters.test.mjs` 逐个比对 `PARAMETERS` 的键、五类 `source.kind` 与 `EVENT_TYPES` 全词表）。

### 3.6 monitor 工具面（第二个模型可见工具）

`monitor` 由 `lib/monitor-tool.js` 注册（工具名取 `Config.monitorToolName`，缺省 `monitor`；行序由 composition 决定，生产已无 combined apply，不再有「monitor 必须在 decision 之后注册」的实现约束）。它是**探测式等待原语，不是调度器**：判据由调用模型给，插件按间隔反复采样并用同一个判定内核问「事件是否已发生」。

| 参数 | 必填 | 形状 | 说明 |
|---|---|---|---|
| `rubric` | **是** | `string` | **唯一**共享判据：「什么算目标事件已发生」 |
| `source` | **是** | 对象，`kind` ∈ `job`/ `file`/ `glob`/ `command`/ `events` | 每次探测采样的对象。`job`（`id`/`select`/`jobKind`）· `file`（`path`/`startLine`/`endLine`）· `glob`（`pattern`/`limit`）· `command`（`argv`）· `events`（`types`）；**每个 kind 只接受自己那组键**，多给报 `source_invalid` |
| `type` / `criteria` | 否 | `noul`（唯一支持）+ 可选 `{false,true}` 描述 | 单次探测判定用的题型；命中语义要求概率，choice/score 不支持 |
| `hitThreshold` | 否 | `number`（缺省 0.5） | 单次探测 P(true) 达到该值记**一次命中** |
| `tailBytes` | 否 | `number`（缺省 4096，硬上限 65536） | 每次采样读取的窗口（取尾部、不劈开多字节字符） |
| `mode` | 否 | `once`(缺省)/`continuous` | `once` 达成即返回；`continuous` 跑到 deadline |
| `intervalMs` | 否 | `number`（缺省 5000） | 探测间隔；生效值 = `max(intervalMs, Config.minProbeIntervalMs)`，钳制写进 `notes` |
| `timeoutMs` | 否 | `number`（缺省 120000） | **自管** deadline（宿主不抢占阻塞调用），被抬到 `≥ intervalMs` |
| `background` | 否 | `boolean` | `true` ⇒ 注册宿主作业并**立刻**返回 `jobId`（用 `job_output` 读） |
| `countThreshold` | 否 | `number`（缺省 1） | **达成门槛**：`hit = count ≥ countThreshold` |
| `notify` | 否 | `none`(缺省)/`inbox` | 命中时通知 |
| `coalesce` | 否 | `boolean`（缺省 true） | 合并同类通知 |
| `maxNotificationsPerMinute` | 否 | `number`（缺省 6，硬上限 600） | 通知限频 |

- **计数口径**：按**探测结果**累加（电平）—— 每次判定命中就 +1，**没有去抖、没有冷却窗**。⇒ `countThreshold` 等价于「以探测为单位的持续时间」（`countThreshold × intervalMs` 量级）。`minGapMs`/`countMode`/`persistCount`/`resetCount` **不存在**，传了会**显式报错**（静默忽略会让调用方以为冷却生效了）。
- **只记录**：`at`/`atIso`/`firstAt`/`lastAt` 是 epoch 毫秒整数，**不参与任何命中判定**。
- **空样本预检短路**：源返回空文本（或仅空白）⇒ **立即返回**（`samples=1`、`emptySource=true`、`hit=false`、`timedOut=false`），**不调用 Decision、也不进休眠**。「目标事件已发生」对空材料在任何判据下都不成立，空样本也不会自己变非空（file/glob/events 的空都是结构性空）。
- **返回形状**：后台分支 `{background:true, mode, source, jobId, clampNotes, notes}`；前台分支另含 `{hit, count, countThreshold, at, atIso, firstAt, lastAt, elapsedMs, samples, hitSamples, level, probability, confidence, evidence, intervalMs, timeoutMs, aborted, timedOut, errors, cost, coverage}`。`evidence` 是命中那次采样的**有界尾部**（`EVIDENCE_MAX_BYTES` = 1024 B）；采样正文不落盘。
- **通知（仅 `background:true`；前台传 `notify:'inbox'` 会当场报错，不再静默忽略）**（对齐宿主 `dsh-tool-jobs` 的官方范式）：消息用 `createUserMessage` 形状 `{id, role:'user', content:[{type:'text',text}], source:{kind:'decision-monitor', form:'notice', summary}}` —— **`source.kind` 必须是本插件自己的名字**（假托 `kind:'user'` 等于把通知伪装成用户输入，且 `user` 分支本身没有 `form` 字段）；投递：目标空闲**且唤醒预算未耗尽** ⇒ `followup`（入队并唤醒），否则 ⇒ `inject`（不唤醒、下一 step 生效）；**合并 + 限频 + 唤醒预算**三件套同时存在；**绝不调用 `agent.cancel`**（实测它会清空整个 inbox）。
- **file/glob 采样走注入的 `deps.read`**（与 `decision` 同一个 reader）⇒ `monitor-tool.js` 内**没有第二份**文件/glob 读取实现；缺 reader 是**装配错误**，当场报可行动错误，而不是等 deadline 后说「没命中」。
- **`command` 源（真机口径）**：`argv[0]` 选解释器（`pwsh`/`powershell`、`git_bash`/`bash`/`sh`/`zsh`），其余项**按空格拼成命令文本**；解释器自己的前导标志（`-c`/`-lc`/`-Command`/`-NoProfile`/`-ExecutionPolicy`…）会被剥掉，**判定标志不能限长度**（`-lc` 剥得掉而 `-Command` 剥不掉会静默变成低概率）。⇒ **带空格的参数要由调用方自己加引号**（`['bash','-lc','echo "a b"']`），argv 不承诺 shell 级引用解析。委托复用既有 `runUpstream`（整份 `exec`：`agent`+`parent token`），模块自己**绝不 spawn**。
- **`events` 源（真机口径）**：数据源优先级 = `deps.eventLog`（装配层环形缓冲，**有历史**）→ `ctx.monitorEventLog` → **`ctx.jobs.list(sessionId)` 的当前状态投影**（每个作业一条 `{type:'job.<status>', …}`，只反映此刻）。缓冲由 `lib/event-log.js` 通过 **`ctx.jobs.events.subscribe({ owners: 'scope' }, listener)` 两参服务**订阅 `registered/stopping/output/progress/settled/removed` 填充，`settled` 额外派生 `job.completed`/`job.failed`/`job.killed`。
- **⚠️ subscribe 的元数是坑**：服务层是 **`(filter, listener)` 两参**（底层 `JobEventHub` 才是三参、服务层已绑定 ctx）。照三参 `subscribe(ctx, {}, listener)` 调用会「注册成功但**永远收不到事件**」——真机用 onFirstEvent 探针确认监听器从未被调用；改为两参后 `job.registered` 立即可命中。三条数据源都不可用 ⇒ `invalid_request`；空样本 ⇒ P=0 且**不调模型**（不把「没有事件」伪装成错误）。**`types` 由 `EVENT_TYPES`（`lib/event-log.js` 单一来源）在参数阶段校验**：拼错直接 `source_invalid` 并列出合法值（`job.registered`/`stopping`/`output`/`progress`/`settled`/`completed`/`failed`/`killed`/`removed`/`running`/`unknown`）。
- **`output.render` 是全函数**：返回**内容块数组** `[{type:'text',text}]`（宿主拿它直接做 `content.some(block => block.type === 'image')`），任何残缺/异形 value 都退化成占位符、**绝不抛**。

### 3.7 模块导出面（public surface）

- `wire`: `WIRE_TYPES` · `toWireRequest`；`density`: `CJK_BYTES_PER_TOKEN` · `ASCII_BYTES_PER_TOKEN` · `CJK_SHARE_THRESHOLD` · `cjkShare` · `bytesPerToken` · `softBytesFor`
- `client`: `callSystemOne` · `classifyOverflow` · `SystemOneError`
- `validate`: `LIMITS` · `MONITOR_LIMITS` · `UPSTREAM_SELF_TOOLS` · `DEPTHS` · `DecisionValidationError` · `analyzeBody` · `validateQuestions` · `validateMonitorArgs` · `validateUpstream` · `resolveDepth` · `normalizeMaterial` · `resolveMaterial` · `assertModeExclusive` · `assertBatchCriteria`
- `source`: `validateSourceDescriptor` · `isUnsafePath` · `sliceByLines` · `chunk` · `splitGlobPattern` · `globSegmentToRegExp` · `matchGlobSegment` · `isRecursiveGlob` · `DecisionSourceError`
- `escalate`: `DEFAULT_LADDER` · `ESCALATION_MARGIN` · `BYTES_PER_TOKEN` · `selectEscalation` · `demandOf` · `selectByCapacity` · `createSingleFlight` · `describeExhausted` · `describeUnknownCapacity`
- `monitor`: `createSources` · `runMonitor` · `startBackgroundMonitor` · `formatProgressLine` · `tailOf` · `EVIDENCE_MAX_BYTES`(1024) · `MONITOR_JOB_KIND`
- `notify`: `createNotifier` · `DEFAULT_WAKE_BUDGET` · `RATE_WINDOW_MS`
- `pipe`: `runUpstream` · `spillWrite` · `spillRead` · `withDeadline` · `DecisionPipeError` · `DEFAULT_SPILL_MAX_BYTES` · `MAX_DELEGATION_DEPTH` · `SHA256_PREFIX_CHARS`
- `monitor-tool`: `registerMonitorTool` · `createMonitorSources` · `renderMonitor` · `PARAMETERS` · `TOOL_DESCRIPTION` · `OUTPUT_SCHEMA` · `MONITOR_TOOL_DEFAULT_NAME`
- `plan`/`render`/`scan`/`parameters`: `planAction` · `STRATEGIES`；`renderAnswers`；`runScan` · `aggregateNoul` · `MAX_CONCURRENCY`；`PARAMETERS` · `TOOL_DESCRIPTION`；`skill`: `name` · `inject` · `SKILL_NAME` · `PROVIDER` · `BUNDLED_SKILL_RANK` · `skillFileUrl` · `parseSkill` · `apply`
- `tool`: `name` · `inject` · `Config` · `COMPANION_SKILL` · `OUTPUT_SCHEMA` · `apply` · `scanRoundBudget` · `resolveUpstreamMaterial`（+ `resolveSoftBodyBytes` / `resolveMinConfidence` / `collectLowConfidence`）
- `index`: `name` · `inject` · `Config` · `apply`（入口再导出）

### 3.8 常量与阈值（`LIMITS` 及独立的 Monitor/管道常量）

`maxQuestions:64` · `maxItems:64` · `minOptions:2` · `maxChoiceOptions:255` · `maxScoreLevels:10` · `maxBodyBytes:65536` · `maxSourceBytes:61440` · `scanMaxChunks:32` · `scanMaxTotalBytes:4194304` · `scanDeadlineMs:180000` · `scanMaxAdaptRounds:2` · `softBodyBytes:4096` · `minConfidence:0.25`

另有**独立常量对象**（与 `LIMITS` 分开；数值只有一处来源，`Config` 里只放覆盖点、不复制数字）：

- `MONITOR_LIMITS`（`validate.js`）：`defaultProbeIntervalMs:5000` · `minProbeIntervalMs:1000` · `maxProbeIntervalMs:3600000` · `defaultTimeoutMs:120000` · `minTimeoutMs:1000` · `maxTimeoutMs:3600000` · `defaultTailBytes:4096` · `maxTailBytes:65536` · `defaultCountThreshold:1` · `maxCountThreshold:1000000` · `defaultHitThreshold:0.5` · `defaultNotifyCoalesceWindowMs:5000` · `defaultMaxNotificationsPerMinute:6` · `maxNotificationsPerMinute:600` · `sourceKinds`(job/file/glob/command/events) · `modes`(once/continuous) · `notifyModes`(none/inbox) · `removedKeys`(minGapMs/countMode/persistCount/resetCount) · `allowedKeys`(14 键)。
- `UPSTREAM_SELF_TOOLS`（`validate.js`）：`['decision','monitor']` —— 默认禁递归名单；工具层会把**生效的** `Config.toolName`/`monitorToolName` 传进去覆盖它（改名部署下闸才不落空）。
- `DEFAULT_SPILL_MAX_BYTES`（`pipe.js`）：`16 MiB` —— `Config.spillDirCap` 的回落常量。

## 4. 成本与容量口径（真机实测冻结）

- **模型窗口**（`num_ctx`，2026-10-15 重拉后实测）：`tev1:0.8b` 8192 · `tev1:latest` 8192 · `nimble:latest` 8194 · `clef-flash:latest` 16384 · `clef:latest` 16384 · `nimble-v3:latest` 32768。⚠️ 这是**快照**，权威读法是 `/api/show` 的 `parameters`（旧值 2050/2050/8194/16384 已随重拉失效）。
  - 补充（2026-10-16 实测）：`nimble:latest` 的 `modified_at = 2026-10-15T16:10`，其**服务端在 400 里报的可用窗口是 8448 token**（与 `/api/show` 的 num_ctx 8194 略有差异，以服务端报错为准）。
- **溢出判据必须两种文案都认（2026-10-16 真机实测，`fca5d2f`）**：Ollama **0.40.5** 起上游 400 文案为 `request (N tokens) exceeds the available context size (M tokens), try increasing it`；此前是 `prompt 0 has N tokens; expected 1–M … (input is never truncated)`。`lib/client.js` 的 `classifyOverflow` 用「旧 ?? 新」两次匹配，两处都产出同形状 `{numbered, actual, limit}` 直接供 `selectEscalation` 选档，**不打印数字**的分支语义不变。**缺失任一种文案的代价**：自动升档与 `depth: deep` 内部分块在真机**整体失效**，且判据会降级成 `invalid_request`、hint 指向题型/选项数（误导重试）—— 真实发生过，见 §6 #20。
- **模型可用性**：6 个 decision 模型现均可用；但 Ollama 会拒收未重拉的旧格式模型，而**该状态随重拉瞬变** ⇒ 「可用/不可用」必须现测，不得据一次瞬态改配置。
- **测试装置的并发 flake（已定位并修复）**：真根因是 **WHATWG Fetch 的 blocked port** —— 装置曾从临时端口区间抽到规范禁用端口（5060/5061/4190/6666-6669/6679/6697 等），`fetch` 在本地直接拒绝、请求从未发出（服务端 `requests.length = 0`），旧码把它误判为 `unreachable` 并给出误导提示。**证伪了早先的 undici 全局池假设**（规定复现形状 200/200 绿、600 轮翻腾 0 失败、27833 条端口事件 0 条「在听却 ECONNREFUSED」）。修法：装置永不交出禁用端口（`cee0baa`）+ `lib/client.js` 单列 `bad_port` 判据（`4fb1d7a`）。
- **服务端 criteria 硬限**：`choice` **2–255** · `score` **2–10**（两者独立约束）。口径注：2–255 是**本机实测值**、非跨版本契约（官方文档自身不一致：决策指南写 2–26、API 参考写 maxProperties 255 且注明取决于模型）⇒ **运行时能力优先于静态常量**，`Config.maxChoiceOptions` 是覆盖点，权威是服务端 400（本机无机器可读规格：`/openapi.json` 等一律 404）。
- **冷加载**：tev1 约 4.8 s · nimble 约 15.0 s；**warm 单次**：小材料 97 ms vs 865 ms。
- **计费口径（已证实）**：`input_tokens = Σ prompt_k = 题数 ×(该 body 的精确 token 数 + 每问模板常数 38) +（题号≥10 的题数）` ⇒ 请求体被**按题数重复计费**。
- **字节↔token**：英文 3.33 B/token；**中文实测 2.32 B/token**（`density.js` 按 CJK 占比确定性推断，阈值 = 窗口 × 0.6 × 密度）。
- **扫描并发**：只支持 1（实测 c=2/4 在真实形态下仅 1.02–1.07×，代价是单块延迟 1.7–2.6×）。
- **注入预算（v3 + Monitor，常驻 = 两个工具之和；修后实测 `7a3c104`）**：

| 工具 | description（≤1900） | 参数 schema（≤3600） | 输出 schema |
|---|---|---|---|
| `decision` | 1809 B | 3487 B（归一后投影；守卫口径的紧凑串 3465 B） | 841 B |
| `monitor` | 1830 B | 2726 B（紧凑串 2692 B） | 1995 B（P0 修复后；修前 1878 B） |

  合计 **13027 B ≈ 3912 token/轮**（英文 3.33 B/token 折算）；skill 正文 **6758 B（≤8000）**只在首次使用时到达（2026-10-18 用户要求功能写全后由 4000 提到 8000）。⇒ 常驻成本比 v2 末期（5653 B ≈ 1698 token/轮）**涨了**：省的是每次调用的请求体与计费，不是常驻。

## 5. 测试与门禁

- 套件 `node --test --experimental-test-isolation=none "test/*.test.mjs"` = **431 例**（2026-10-18 代码态实跑核对；430 pass / 1 skip / 0 fail）= 顶层 `test(` 声明 **407** 条（`grep -c '^test('` 逐文件相加）+ 循环内生成的表驱动用例 **24** 条；共 **32** 个测试文件（`ls test/*.test.mjs | wc -l` = 32）；另有装置 `test/fake-ollama.mjs`（不匹配 `test/*.test.mjs` 这个 glob，不算例）。
- **墙钟纪律（精确版）**：**不得用真实计时派生判定**（如按 deadline 计数、按耗时决定分支）。deep 的多轮重切预算用可注入时钟 + 纯函数 `scanRoundBudget` 断言（曾有一条用服务端忙等 60 ms 的用例在并行负载下抖红，已重写）。**已登记的例外**：`test/client.test.mjs` 用 `Date.now()` 做 `elapsed < 2000 ms` 的粗上限兜底、`test/escalate.test.mjs` 有一处 10 ms 等待用于让承诺沉降 —— 这两处不派生判定结果，保留并登记（见 §6 #21）。
- 守卫：§4.9 判别性锚点、skill 锚点（十四条 v3 读法 + 词表负例）、README 配置表与 `Config` 投影一致（**29 键，按行计**；两份 README 的三张表键集与顺序 == 三条 `Config.dict`）、注入预算上限（`decision` description ≤1900 / 参数 schema ≤3600 / skill ≤8000；`monitor` description ≤1900 / 参数 schema ≤3600）、`COMPANION_SKILL === SKILL_NAME`、缺 skill 拒服务、首次交付 skill 正文；Monitor/管道新增：**零真实墙钟**（clock/sleep/decide/deliver 全注入）、通知三件套（合并 + 限频 + 唤醒预算）、`material.tool` 双形状对齐（模型面 `{name,arguments}` ↔ 校验层 `{tool,arguments}`）、禁自递归（名单含生效的 `toolName` 与 `monitorToolName`）、模型可见文案词表（v2 参数名负例，含 `stateSource`）、**output schema 与返回值键集一致**（monitor 侧 `7a3c104`、decision 侧 `b55b942`，两边都用宿主的 `valueSchemaSpecToJsonSchema` + `validateJsonSchemaValue` 钉住）。
- 另有：`node --check lib/*.js`、CR 字节 = 0、变异自检（累计 30+ 定点变异全杀）、隔离实例真机冒烟。
- **装置不变量**（`cee0baa` 之后）：假服务永不交出 fetch 禁用端口；并发负载下错误分类不退化为 `unreachable`。
- **冒烟必须真断言**（`fca5d2f`）：`smoke/live.mjs` 必须按**工具的五键形状**组装 value 再渲染，并断言「有 answers / 有 `usage.input_tokens` / 渲染文本非空占位 / 无 `undefined|NaN`」，任一不成立即**非 0 退出**并打印拿到了什么。历史教训：该脚本曾把原始回包（`{model,answers,usage}`）当五键喂 `renderAnswers` ⇒ 永远打印 `(no results returned)` 且 exit 0（假绿，见 §6 #21）。

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
| 19 | 一条新守卫用真实墙钟判据（负载下抖红） | **已修** `2540e30`：改为可注入时钟 + 纯函数 `scanRoundBudget`；纪律见 §5「墙钟纪律（精确版）」 |
| 20 | 上游 0.40.5 换了溢出文案 ⇒ **自动升档与 `depth: deep` 分块在真机整体失效**，判据降级为 `invalid_request` 且 hint 误导 | **已修** `fca5d2f`：判据认两种文案（`旧 ?? 新`，同形状）+ 端到端守门「不得降级为 invalid_request」 |
| 21 | 仓库自带冒烟**假绿**（原始回包当五键喂 render ⇒ 永远空占位 + exit 0 + 不打 usage） | **已修** `fca5d2f`：组装五键 + 真断言；真机成功 exit 0、坏端口/坏模型实测 exit 1 |
| 22 | `monitor` 前台返回值含 `probability`，而 `OUTPUT_SCHEMA`（`additionalProperties:false`）未声明它 ⇒ 宿主 `createSuccessResult` 会判 `ToolOutputError`，**真机每次前台成功返回都失败**；本地测试直呼 `execute` 绕过 dispatch，343/343 全绿看不见 | **已修** `7a3c104`：**补 schema**（+117 B ⇒ 1995 B）而不删字段，并加「用宿主校验器钉住 schema 键集 == 返回值键集」的守卫。⚠️ 真机 `createSuccessResult` 整条 dispatch **尚未跑**（只跑了同一校验函数、同一入参）⇒ 真机前台可用性属**推断**，验收归 task-26。通用不变量见 §1.4 |

## 7. 上游词汇与形状的「账」已收

| 曾经的泄漏 | v3 处置 |
|---|---|
| `state` 单槽（材料/判据/待判项挤在一起） | `material` + `rubric` + `items` 三段式，语义分开 |
| `questions[].instructions` 被迫重复 N 遍判据 | `rubric` 只写一次，wire 层放进 `state`（材料之后） |
| 上游题型词汇散落 6 个模块 | body 构造收进 `lib/wire.js`；`WIRE_TYPES` 单一来源 |
| `answers` 按题型解包 + `chunks` 互斥 | `results[]` 单一读法，分批/分块只进 `coverage` |
| `usage`/`state_bytes`/`body_bytes` 直接暴露上游计量 | 合并进 `cost`（`inputTokens`/`bodyBytes`） |
| `strategy`/`aggregate`（模式中的模式） | `depth` 三档 + 内部自动分批/分块 |
| 计划期的顶层 `upstream: {tool, arguments}` | 落到 **`material.tool`** —— 工具输出与 `file`/`glob` 同属「不进模型上下文的引用式材料」，故不新增顶层键（`selfToolNames` 由工具层把生效的 `toolName`/`monitorToolName` 传进去） |

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

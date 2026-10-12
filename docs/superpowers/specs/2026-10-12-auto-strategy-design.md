# dsh-decision-tools — 自动策略增量规格（2026-10-12）

> 状态：**设计（未实现，待评审）**。本文件是 `2026-10-04-dsh-decision-tools-design.md` 的增量，ADR 编号续用 A7–A9；与正文冲突处以此文件为准，并需回写正文 §10 的对应行。

## 0. 一句话

v1 把「材料怎么进来」「用哪个模型」「一次装多少」三件事都推给调用方；而这三件事恰好都能由插件自己判断。本增量把它们收回来，代价是引入**容量发现**与**进程级状态**两个新问题。

## 1. 范围与非目标

| 编号 | 能力 | 前身 |
|---|---|---|
| A7 | 引用式 `state`：材料按路径读入，不进 agent 上下文 | 正文 §10 的 M1（自标「最高杠杆」） |
| A8 | 自动提升：容量不足时换更大 `num_ctx` 的模型，且不抖动 | 新 |
| A9 | 分块扫描：容量不足且不该换模型时，插件自己循环 | 新 |

**非目标（本增量明确不做）**

- **不改部署**：不写 Modelfile、不重启 Ollama、不改环境变量。抬高 `num_ctx` 属部署侧，只在 README 给配方（见 §7 配方 R1）。
- 不做熔断与指数退避（正文 §10 的 M6 留给下一增量）。
- 不做缓存（沿用正文 §4.11 的判定）。
- 不自动改置信门限策略（τ 是策略，随模型变不是插件该替调用方决定的事）。

### 1.1 v2 范围（**无过渡**声明）

本增量**不做过渡版本**：下面这些契约直接以最终形态发布，**不提供兼容开关、不保留两套行为**。

| 项 | v2 最终形态 | 与 v1 的关系 |
|---|---|---|
| `state` / `stateSource` | **恰有其一**（本地校验强制） | v1 只有 `state`；内联仍是 v2 的常规路径 |
| `answers` / `chunks` | **恰有其一**（扫描走 `chunks`） | v1 恒有 `answers`，故对既有调用方非破坏 |
| `strategy` | 默认 `auto` | v1 无此参数（等价于 `inline`） |
| `escalation` | 默认**开启**，阶梯取 `DEFAULT_LADDER` | v1 无自动提升 |
| Skill `decision-usage` | 随包贡献，装配行**默认启用** | v1 无 skill（第一方惯例是默认 `disabled`，这里**刻意不走**过渡做法） |
| 版本 | `0.1.0 → 0.2.0` | 破坏性契约变更已登记（§5） |

**不做的事**：不加 `legacy`/`compat` 开关；不为「旧调用方」保留双分支；不把 skill 做成可选插件包（它属于同一交付物）。

## 2. 依赖的既有事实与待测项

已确认（本机既有记录，非推断）：

1. 单次调用**唯一**端点 = `POST {baseUrl}/v1/systemone`；`context_overflow` 的 400 **有两条分支**（T1 实测，见 §3.2 分支表）：A 分支带 `actual` 与 `limit` 两个数字（`tev1` 系 / `nimble`），**B 分支两个都不带**（`clef` 系）。
2. 分块必然产生多次 HTTP 调用 —— 块与块是**不同的 `state`**，无法共享一次调用，因此 v1 的「一次 64 题」批量技巧在扫描路径上**不适用**。
3. `confidence` 的分布**随模型变**：0.8B 上实测出现 0.023 / 0.072，4B 及以上恒 ≥ 0.77 ⇒ `τ=0.25` 在 4B+ 上惰性。
4. 体积口径**不是常数**，实测跨度很大（本机 Ollama 0.40.3）：高度可压缩文本 ≈7.2 B/token（`"a"×8000` → 1119 token）、自然英文散文 ≈3.33（仓内既有口径）、随机英文词表 ≈4.95、随机字母数字 ≈1.34–1.36（8000 B → 6042 token）。⇒ 任何「按字节估 token」的写法都必须带最坏比值保护；分块必须自适应（§3.3）。

**T1（已解决，2026-10-12 实测）**：`num_ctx` 是**纯部署态**，且**不改部署无法抬高单次请求的有效上下文**。证据：`.temp/numctx/`（`probe.json` 23 条原始记录 + `load-experiment.json` + `notes.md`）；Lead 已**独立复核** Q4 的决定性对照。

| 模型 | Modelfile `PARAMETER num_ctx` | 架构 `qwen35.context_length` | 实测有效上限 |
|---|---|---|---|
| `tev1:0.8b` / `tev1:latest` | **2050** | 262144 | **2050**（报错里打印） |
| `nimble:latest` | **8194** | 262144 | **8194**（打印） |
| `clef-flash:latest` / `clef:latest` | **16384** | 262144 | 16384（runner `-c` 事实；**报错不打印 N**） |

三条决定性机制：

1. **请求级 `options.num_ctx` 被忽略**：同一 8000 B 高熵 `state`，带 `num_ctx=16384` 与不带，报错**逐字相同**（`expected 1–2050`、6042 token），`/api/ps` 始终 `context_length=2050`（Lead 复核，16 ms / 22 ms）。
2. **`/v1/systemone` 会把已加载的更大实例拉回**：先用 `/api/generate` + `options.num_ctx=8192` 强制加载（`/api/ps` 显示 8192、日志 `-c 8192`），紧接着发一次 systemone ⇒ `/api/ps` **立刻变回 2050**、日志 `-c 2050`。
3. **`OLLAMA_CONTEXT_LENGTH` 覆盖不了 `PARAMETER`**：本机该变量由桌面应用注入为 65536（**非持久环境变量**，三作用域都没有），而 tev1 系照样 `-c 2050` —— 它只是「模型未声明时的默认」。

⇒ 阶梯容量**可以**按声明值写死（§3.2）；R1 配方只能走部署侧。

**待测 T2**：插件取「会话工作区根」的稳定来源 —— `ctx.fs` 后端默认基 vs `ctx.sandboxPolicy` 的 workspace-write 根。二者未必相等，A7 的 containment 必须钉在**调用方的会话工作区**上，故此项必须先确认再实现。

## 3. 架构决策

### 3.1 ADR-7：引用式 `state`

**决策**：新增 `stateSource` 参数，与 `state` **恰有其一**（DSL 表达不了「恰有其一」，落在本地校验，与 V1/V2 同址）。

```
stateSource: { kind: 'file', path: string, startLine?: number, endLine?: number }
           | { kind: 'glob', pattern: string, limit?: number }
```

**读取路径（全部经 `ctx.fs`，不 import `node:fs`）**：

1. `resolve(path, { cwd })` 得到稳定目标；
2. `contains(workspaceRootTarget, target)` 做工作区根 containment；
3. `lstat` 在 follow 前拒绝符号链接（防 symlink 逃逸）；
4. `readBytes(target, signal, maxBytes)` 取字节 —— 它**超限抛 `FS_TOO_LARGE` 而不截断**，正是需要的语义；
5. 解码为 UTF-8 文本后交给 `state` 的现有管线（`state_bytes` 仍按**实际读到的**字节报，保持体积可归因口径）。

**两条语义要分开（同一条声明，两种越限行为）**：

- **单文件**超上限 ⇒ **报错**（`source_too_large`），消息给实际字节、上限，并给可行动建议（改用 `glob`、缩小行范围）。
- **glob 总量**超上限 ⇒ **截断并报告**（`source.truncated = true` + `source.remaining`），不报错 —— 扫描场景需要部分结果。

**行范围**：`startLine`/`endLine` 为 **1-based 闭区间**；越界即报错，不静默截断。

**新增上限**：`LIMITS.maxSourceBytes`（单一出处仍在 `lib/validate.js`）。

**为什么必须与审计绑定**：引用式读取的内容**不在 transcript 里**，因此同一次会话回放**不会复现**当时的 state。⇒ A7 与正文 §10 的 M5（追加型 JSONL 审计）互相成就：审计行记 `path` + 行范围 + 可选内容哈希，否则「这条判定当时基于什么」将永久不可复算。

### 3.2 ADR-8：自动提升

**触发条件（三条同时成立）**：① 调用方**未**传 `model`；② 配置启用 `escalation.enabled`；③ 收到 `kind = context_overflow`。

**容量取值（T1 已解决后的定案）**：容量是**部署态事实**，`escalation.ladder[].numCtx`（配置声明值）是主来源；`observed`（本条 400 里的 `limit`）只作**运行时校正** —— 它更权威，但**不是每个模型都有**。

**★报错分支有两条（本轮实测，直接改写选档算法）**：

| 分支 | 报文 | 带 `actual` / `limit`？ | 模型 |
|---|---|---|---|
| A | `prompt 0 has <actual> tokens; expected 1–<limit> (input is never truncated)` | **都带** | `tev1` 系、`nimble` |
| B | `decision prompt exceeds the model context (input is never truncated)` | **都不带** | `clef-flash`、`clef` |

⇒ 落在分支 B 的目标上**既读不到需求也读不到容量**。故：

- **需求**：优先取触发提升的那条 A 分支报错里的 `actual`（实测 token 数）；触发者本身是 B 分支时，退化为「当前模型的声明容量」作保守估计，并允许一次试探。
- **目标容量**：`observed` 仅在目标属 A 分支时可用；否则用配置声明值。
- **绝不**因读不到数字就跳过提升 —— B 分支的 400 仍可稳定判出 `kind = context_overflow`。

**默认阶梯（本机实测容量 + 一条实测约束）**：`tev1:0.8b` / `tev1:latest` 2050 → `nimble:latest` 8194 → `clef-flash:latest` 16384。**`clef:latest` 不进默认阶梯** —— 27B 在 8 GB 显存上 prefill 21500 B **300 s 未返回**（`clef-flash` 同尺寸首次 201.9 s），放进默认阶梯等于给调用方埋一个超时。

**选档**：取第一个满足 `numCtx_target × 0.6 ≥ 需求` 的候选（0.6 = 留题面与分词差异的余量，与既有 4096/2050 ≈ 60% 同源）。需求来自实测 `actual` 时可一次选档；需求是保守估计时允许一次试探后重选。

**尝试次数**：`escalation.maxAttempts`（默认 3）。用尽后抛**最终错误**，消息列出「阶梯 + 实际需求 token 数 + 各候选上限」——可行动，且绝不静默降级。

**粘滞（防抖动，进程级单例）**：提升后**保持**该模型，直到：① 调用方显式传 `model`（立即切换，含降级）；② 进程重启；③ （可选）探测到实例已卸载（需 `GET /api/ps`）。粘滞状态**不因 `defaultModel` 变化而回退**。

**并发纪律**：决策在**派发前**取一次；同一时刻只允许一个提升决策（单飞 promise），否则并发调用会各自切换、互相拆台（A 要 0.8B → B 提升 → A 再要 0.8B ⇒ 一次 12s 冷加载）。

**回显（强制）**：返回实际模型 `model`，并新增可选键 `escalated: { from, to, sticky: true }`。

**与置信策略的交互（诚实条款）**：`escalated` 出现时，`confidence_warning` 的语义基础已变（提升目标多为 4B+，门限惰性）⇒ 告警文案追加一句「本结果来自提升后的模型 <to>，其 confidence 分布与原模型不同，门限可能不适用」。**不自动改 τ。**

**已验证的成本**：提升目标首次命中含冷加载（实测 0.8B ≈ 12 s、4.2B ≈ 18.5 s），`timeoutMs` 默认 120 s 足够；但**审计必须记录**本次是否吃了冷加载，否则延迟尖峰无法归因。

### 3.3 ADR-9：分块扫描

**触发**：显式 `strategy: scan`，或 `strategy: auto` 且「超限且不可提升 / 提升后仍超限」。

**分块单位：语义边界优先**。按行切，边界尽量落在空行或 Markdown 标题之后；判定不了时退化为固定 token 预算的窗口。**不以字节切** —— 3.33 B/token 只对英文散文成立。

**自适应定块（核心算法）**：

1. 首块按保守预算（`scan.firstChunkBytes`，默认可取 `LIMITS.softBodyBytes`）试发；
2. 若得到 `context_overflow`：**A 分支**（报错带数字）读 `(actual, limit)`，算出**本文档自己的** B/token = 首块字节 ÷ `actual`；**B 分支**（clef 系，见 §3.2 分支表）**读不到比值** ⇒ 退化为二分收缩（按 0.5 / 0.7 逐轮缩小并重发）—— 这正是实测 B/token 跨 1.34–7.2 所要求的保护；
3. 新预算：A 分支 `floor(limit × 0.6 × ratio)` 字节（一步到位，不折半）；B 分支取二分收缩后的可用字节；
4. 若得到 `413`（body 超 64 KiB），按 `maxBodyBytes` 折算；
5. 自适应最多 `scan.maxAdaptRounds`（默认 2；B 分支因二分需要更多轮，单独放宽到 4）；仍失败则报错并附「首块字节 / 实际 token（若可得）/ 声明容量」。

**调用组织**：默认 `scan.concurrency = 1`（逐块串行）。并发收益**未实测**（Ollama 按模型装载，通常串行排队），故不默认开启，且在 README 标注为待测。

**失败隔离**：单块失败只记入 `scan.failed: [{ chunk, kind }]` 并继续；**绝不**因一块 400 丢掉整次扫描。

**题名**：块内题名沿用调用方给的题名；块名用 `c1`…`cN`（**禁纯数字**，正文 V2 已拒 `/^\d+$/`）。

**预算（三重硬限）**：`scan.maxChunks`（默认 32）、`scan.maxTotalBytes`（默认 4 MiB）、`scan.deadlineMs`（默认 180000，**独立于** `timeoutMs` —— 后者是单次上限）。任一触顶 ⇒ **返回部分结果** + `scan.truncated = true` + `scan.remaining`。

**中断**：监听 `exec.signal`；中断即返回已得结果 + `scan.aborted = true`。

**聚合（不得越权）**：默认 `aggregate = none`。可选 `any`（逐块取最大概率）仅作**暂定**输出 —— 跨块概率**未经校准**，必须显式标注「不得作为判定依据」。

**方向警告（写进 description，不硬拒）**：**整体性**问题（整篇属于哪类）**不应**用扫描 —— 逐块答案取 max 不等于整篇概率；这类应走 A8 提升。

### 3.4 ADR-10：随包 Skill（`decision-usage`）

**决策**：同一个 npm 包贡献一个 skill，走**独立插件入口**（`dsh-decision-tools/skill` → `lib/skill.js`）。

- **为什么独立入口**：主插件的 `inject` 是 `['tools','fs']`。若把 `skills` 也写进主 `inject`，在**没有技能注册表**的组合里整个插件**不激活** —— 连 `decision` 工具都会消失。第一方的做法就是独立行（`dsh-skill-badge` 即独立包），或用 `ctx.inject(['skills'], cb)`（`packages/sandbox/sandbox-local/src/index.ts:302` 的范式）。v2 取**独立入口**：可单独启停、可单独打包，且不牵连主插件。
- **注册形态**：`inject = ['skills']`；`apply()` 内 `ctx.skills.registerProvider(() => provider)`，provider 名 `dsh-decision-tools`，候选 `{ name: 'decision-usage', description, source: 'bundled', rank: BUNDLED_SKILL_RANK, resourceBase: { kind: 'directory', path: assets/decision-usage }, locator }`，`get()` 每次从磁盘重读正文（与 `dsh-sandbox-windows-acl` 同取向）。
- **正文来源**：包内 `assets/decision-usage/SKILL.md`，YAML frontmatter 只强制 `description`（缺即**注册失败**，不静默）；name 与产物一致，避免 frontmatter 与文件名互相打架。
- **装配（无过渡）**：`cordis.patch.yml` **插入第二行且默认启用**（第一方惯例是默认 `disabled: true` 让部署显式选择，v2 刻意不走这条过渡路 —— 用法指引在 v2 里是功能件）。
- **打包**：`package.json` 的 `files` 加 `assets`；`exports` 加 `"./skill"`；`peerDependencies` 加**可选** `@deepseek-ai/dsh-skill`（与既有的可选项一致）。`npm pack` 计数会从 12 变多，**必须重核**。
- **正文必须覆盖（缺一条即视为交付不完整）**：
  1. 三型题（`choice` / `noul` / `score`）与「一份共享 `state`、1–64 题」的用法，含「不要一条一调用」的理由；
  2. `stateSource` 的路径约束（工作区根内、拒绝对路径与符号链接）与**两种越限语义**（单文件报错 / glob 截断）；
  3. `confidence_warning` 怎么读：它是分布集中度不是准确率，**τ 只在 0.8B 上有意义**（4B+ 惰性），低置信度必须交回自己的推理；
  4. **提升会换模型因而换基座**：`escalated` 出现时门限语义可能不再适用；
  5. **扫描只适用于可定位问题**；聚合（`any`）是**暂定**，跨块概率未校准；
  6. `plan` / `escalated` / `chunks` / `scan` 的读法；
  7. 硬边界：概率不是证据、**不得**作为 fail-open / fail-closed 的依据（与工具 description 一致）。
- **测试**：`test/skill.test.mjs` 用假 `ctx`（只给 `effect` 与 `skills.registerProvider`）断言：注册恰发生一次；provider 名 / `source` / `rank` / `resourceBase` 正确；`list()` 恰返回一个候选；`get()` 读出的正文**不含 frontmatter**且包含 §3.4 七条要点各自的锚串；frontmatter 缺 `description` 时注册**抛错**。

## 4. 组合：策略规划器

`strategy` 参数（`auto` 默认 / `inline` / `scan`）+ 配置共同决定动作：

| 情形 | 动作 |
|---|---|
| 内联 `state`，体积在软阈值内 | 直发 |
| `stateSource` 给了引用 | 经 `ctx.fs` 读取 → 超限则按 §3.3 分块 |
| `context_overflow`，且可提升（§3.2 三条件） | 提升并**用同一 state 重发** |
| `context_overflow`，已是最大档 / 显式指定了 model | 分块扫描（若问题可定位）→ 否则报最终错误 |
| 显式 `strategy: scan` | 直接分块（不再试整发） |

**必须回显计划**：新增可选键 `plan: { strategy, model, reason, chunks? }`。「自动」只有可审计才敢用。

## 5. 输出契约增量（含一处破坏性变更登记）

`OUTPUT_SCHEMA` 新增**可选**键：`source`、`escalated`、`plan`、`chunks`、`scan`。沿用现有纪律：值为 `undefined` 时**整个键不出现**（宿主对无损 JSON 强校验）。

**契约变更（唯一一处）**：扫描模式下顶层 `answers` **不再出现**，逐块答案落在 `chunks[].answers`。因此 `answers` 由 `required` 放宽为可选，并新增本地不变量：**`answers` 与 `chunks` 恰有其一**。

- 对现有调用方**非破坏**：v1 路径恒产出 `answers`。
- 对宿主强校验**只放宽不加严**：`additionalProperties: false` 与其余 required 列表不动。

**渲染（`lib/render.js`）**：扫描模式逐块一行；失败块单列一行并给出 `kind`；触发预算时打印截断/中断提示；聚合若为 `any` 必须打印「暂定」。

## 6. 模块与分层（依赖方向不变）

| 文件 | 职责 | 依赖 |
|---|---|---|
| `lib/source.js`（新） | 纯函数：描述符形状校验、行范围切分、语义边界切分、字节预算计算 | 零依赖 |
| `lib/escalate.js`（新） | 纯函数 + 状态机：阶梯选档、粘滞、尝试计数（注入 `now` 与 `inspect`） | 零 DSH 依赖 |
| `lib/scan.js`（新） | 纯编排：分块、逐块调用、失败隔离、预算与中断（注入 `callModel`） | 零 DSH 依赖 |
| `lib/plan.js`（新） | 纯函数：§4 决策表 | 零依赖 |
| `lib/tool.js` | 唯一接触 `ctx` 的文件；`inject` 增加 `fs`；把 `readSource` / `inspect` 注入给纯模块（依赖倒置） | ctx |
| `lib/validate.js` | 新增 `LIMITS.maxSourceBytes` 等常量与 `stateSource` 校验（limits 单一出处） | 零依赖 |

⇒ **正文 §5 的边界原则不变**：纯逻辑仍可被 CLI / 评测装置直接复用；A7 的 fs 访问只落在 `tool.js`。

## 7. 失败模式与部署配方

| 情形 | kind | 行为 |
|---|---|---|
| 引用文件不存在 | `source_missing`（新） | 报错，附**解析后**的绝对路径 |
| 目标逃出工作区根 | `source_outside_root`（新） | 拒绝，附根与目标 |
| 单文件超 `maxSourceBytes` | `source_too_large`（新） | 报错 + 建议 glob / 行范围 |
| glob 总量超限 | — | 截断 + `source.truncated = true` |
| 提升目标未下载 | `model_missing`（已有） | 试下一档 |
| 提升目标仍超限 | `context_overflow`（已有） | 试下一档；到顶后转扫描或报最终错误 |
| 扫描中某块超限 | 逐块 `context_overflow` | 隔离进 `scan.failed` |
| 预算触顶 / 被中断 | — | 部分结果 + `truncated` / `aborted` |

**配方 R1（写进 README，不改代码）**：抬高 `num_ctx` **只有部署侧一条路** —— 改该模型 Modelfile 的 `PARAMETER num_ctx`（或重建带新 PARAMETER 的模型）。**已实测无效的两条路**：① 请求体里的 `options.num_ctx` 被 `/v1/systemone` 忽略；② `OLLAMA_CONTEXT_LENGTH` 只是「模型未声明时的默认」，被 `PARAMETER` 覆盖。插件**不自作主张**改部署，但必须让调用方知道这条路存在，否则「提升到最大档仍然超限」会被误读为模型缺陷。

## 8. 测试计划（零新增依赖）

- **纯模块表驱动单测**：`source`（行范围/边界/逃逸/超限四类）、`escalate`（选档、粘滞、并发单飞、尝试上限）、`scan`（自适应、失败隔离、预算、中断）、`plan`（决策表全格）。
- **`test/fake-ollama.mjs` 扩展**：增加三种脚本化响应 —— 按 token 阈值返回 400（带 `actual`/`limit`）、404、以及**慢加载**（用于冷加载路径）。
- **守卫探针（关键不变量，变异必须被杀）**：
  1. 提升**只在** `model` 未传时发生（变异：无条件提升）；
  2. 粘滞状态不被并发击穿（变异：并发各自决策）；
  3. 自适应后每块字节 ≤ `limit × 0.6`（变异：忽略实测比值）；
  4. 引用式读取恒在工作区根内（变异：跳过 containment）；
  5. `answers` 与 `chunks` 恰有其一（变异：两者并存或皆缺）。
- **真机冒烟**：提升一条（构造超 2050 的 state）、扫描一条（构造多段文档），并入既有 `smoke/live.mjs`。

## 9. 未决与待测

| 编号 | 待测 | 影响的决策 |
|---|---|---|
| ~~T1~~ | **已解决（2026-10-12）**：纯部署态；不改部署**不能**抬高。见 §2 | A8 阶梯按声明值写死 + `observed` 校正 |
| T7 | clef 系 400 走 B 分支（不打印数字）的因果 —— 与 `--mmproj` / vision 是相关还是因果 | A8 选档回退、A9 二分收缩 |
| T2 | 会话工作区根的稳定来源（`ctx.fs` 默认基 vs `ctx.sandboxPolicy`） | A7 的 containment 锚点 |
| T3 | `scan.concurrency > 1` 在 Ollama 上是否有吞吐收益 | 默认并发数 |
| T4 | 语义边界分块 vs 行窗口 + 重叠，哪个判定质量更高 | §3.3 切分算法 |
| T5 | 提升前后的答案质量是否可比（同 state 双模型对照） | 是否允许 auto 提升默认开启 |
| T6 | 是否值得引入 `GET /api/ps`（粘滞的卸载检测） | 粘滞条件 ③ |

## 10. 与既有条目的相容性与需要回写的正文

- **A5（不注册 prompt 段）**：不变。新能力全靠参数与 description 承载。
- **A6（线格式对象映射）**：不变，转换仍是 `lib/validate.js` 的单点生产者。
- **§4.11「刻意不做并发闸、重试、缓存」**：**局部修订** —— 单次调用仍不重试；并发只存在于扫描编排内部且默认 1；缓存仍不做。理由必须回写：那条禁令针对「单次调用」，从未针对「一次工具调用内部的多段编排」。
- **§10 的 M1**：由 A7 取代，应从 v2 待办移入本增量。
- **§10 的 M6（熔断/超时口径）**：其触发条件「出现常驻调用方」由 A8 的粘滞状态**实际引入** ⇒ 本增量只做声明，熔断留下一个增量。
- **§4.9 / §8（description 与已知限制）**：需新增三段文案 —— 引用式的路径约束、提升会换模型因而换基座、扫描不适用于整体性判定。

## 11. v2 一次性交付清单（**无切片、无过渡**）

按依赖顺序一次做完，每步都要跑门禁（`npm test` / `node --check` / CR 字节 / 变异自检）：

1. **规格**：本节 + ADR-10（Skill）落盘（已完成）。
2. **纯模块**：`lib/source.js`（描述符校验 + 行范围 + 语义边界切分 + 字节预算）、`lib/scan.js`（编排，注入 `callModel`）、`lib/plan.js`（策略决策表）；三者零依赖、零 I/O。
3. **接线**：`lib/validate.js` 接 `stateSource` 校验与新增 `LIMITS`（**必须同步改冻结守卫用例**）；`lib/parameters.js` 补 `model` / `stateSource` / `strategy` / `aggregate` 与新的 description；`lib/tool.js` 注入 `fs`、接 `createSingleFlight` + 提升 + 扫描 + `plan` 回显；`lib/render.js` 渲染 `chunks` / 失败块 / 截断 / 暂定聚合。
4. **Skill**：`lib/skill.js` + `assets/decision-usage/SKILL.md` + `package.json`（exports / files / 可选 peer）+ `cordis.patch.yml` 第二行（默认启用）。
5. **门禁与收尾**：全量套件、10+ 变异自检、LF/CR 核验、两份 README 与版本号 `0.2.0`、`npm pack` 计数重核。

**验收判据**：`stateSource` 与 `state` 恰有其一；扫描模式产出 `chunks` 且顶层无 `answers`；提升在未显式给 `model` 时才会发生并回显 `escalated`；引用式读取恒在工作区根内；skill 在技能目录里出现且正文可加载。

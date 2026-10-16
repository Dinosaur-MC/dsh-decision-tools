# Monitor 与上游委托管道 — 设计规格

> 状态：**待实现**（本文件只写规格，不含代码）。日期 2026-10-17。
> 依据：本机 DSH `0.2.0-rc.2` 的三轮**整实例真跑**实证（报告在 `tmp/sub-task/`、`tmp/sub-notify/`、`tmp/sub-spill/`），以及本项目既有纪律（概率不作门禁、时间不作判据、守卫必须先证明会红）。

## 0. 一句话

Monitor 是一个**异步探测式等待原语**：判据与参数由调用模型给出，插件按可配置间隔反复采样、用 `decision` 内核给出概率化判定，按探测结果计数，命中后返回毫秒级时间与计数（可设计数器阈值），前台可阻塞等待（带超时）、后台作为作业运行并实时通知（带限频与背压）。

## 1. 目标与非目标

**目标**：把高频、有界、需要持续观察的判定（日志等到某事件、作业等到收敛、输出等到稳定、错误等到重现）变成一次调用；判定用本地概率模型，不用生成式模型读日志。

**非目标（硬）**：

1. **不自动动手**：命中只通知；kill、派发、重试等动作必须由模型显式发起。
2. **不是持久调度器**：存活边界＝前台为工具调用时长、后台为宿主进程寿命；**计数不持久化**，宿主重启即连同作业一起消失，因此也不需要重置通道。
3. **不持久化采样正文**：只把命中那一次的有限证据放进返回值；其余只留长度与哈希。
4. 不做 GUI 面板；不做跨重启的长期监控。

## 2. 地基强度（实现前必须知道哪些是硬的）

| 项 | 强度 | 依据 |
|---|---|---|
| `ctx.jobs` 的 API 与字段 | **硬** | 九方法 + `events.subscribe`；`JobView` 全集已实测 |
| 作业枚举需带 sessionId | **硬** | 不带 caller 只见 unowned，实测对照 |
| 停滞只能自采样 | **硬** | 注册表无 lastOutputAt/心跳；`output.total` 实测递增 |
| 子代理类不建作业 | **硬** | continuable 模式直接返回，源码 + 真跑 |
| inbox 通知可用且模型会反应 | **硬** | 注入后进程输出即被注入内容，时序完整 |
| inbox 无背压 | **硬** | 连投 12 条逐条入队、下个边界一次全领 |
| 前台可长阻塞、超时为协作式 | **硬** | 35 s 不被中断；声明 5 s 也要等函数体结束 |
| 插件内可委托执行别的工具 | **硬** | `tools.execute` 带 agent 真跑通 |
| 完整工具结果只在 value / 转储 | **硬** | 持久事件裁剪、无 getResult |
| 进程型工具的尾部与转储 | **软**（仅源码 + 旁证） | 隔离实例 `spawn EPERM` 触发不了 |
| 运行态宿主版本 | **不确定** | 磁盘存在与新版本结论互斥的旧产物 |

## 3. Monitor 语义

### 3.1 两种运行形态

| 形态 | 机制 | 关键约束 |
|---|---|---|
| 前台 | 工具调用内循环直到命中或自管 deadline | 必须**转发 `exec.signal`**；超时只能自己实现（宿主不抢占） |
| 后台 | `ctx.jobs.start` 起生产者作业 | root 层挂载**开不了作业**，需 `attachController` 或进 preset 作用域 |

### 3.2 计数与时间戳

- 间隔 `intervalMs` 由**调用模型**给出，实际生效值 = `max(intervalMs, Config.minProbeIntervalMs)`。
- **按探测结果计数**：每次探测判定为命中即 `count += 1`（电平口径）。
- **无 CD**：不存在冷却窗或去抖参数。
- 已知语义：电平 + 无 CD ⇒ `countThreshold` 等价于「以探测为单位的持续时间」（`countThreshold × intervalMs` 量级）。
- `hit = count >= countThreshold`；每次更新返回 `at`（epoch 毫秒）与 `atIso`，并带 `firstAt`/`lastAt`/`count`。
- **时间戳只作记录，不参与判定**（沿用「时间不作判据」纪律）。

### 3.3 通知与背压

- 通道：`ctx.agents.get(sessionId)` 上的 `inject`（next-step，不唤醒）／`steer`（唤醒）／`followup`（next-turn，唤醒）。
- 范式照抄官方作业通知：目标空闲 ⇒ `followup`；目标忙 ⇒ `inject`；消息标 `source.form='notice'`；带**唤醒预算**（超预算降级为 inject）。
- **背压必须自建**：inbox 实测无上限、无合并、无丢弃；合并同类通知与限频是生产者的责任。
- 硬防护：`coalesce` 合并 + `maxNotificationsPerMinute` 限频 + 唤醒预算，三者都有硬上限。
- 绝不调用 `agent.cancel`（实测它会清空整个 inbox）。
- 重复 MessageId 会抛错 ⇒ 通知 id 必须唯一（含计数与时序号）。

## 4. 工具面

### 4.1 `decision_monitor` 参数

| 参数 | 必填 | 默认 | 语义 |
|---|---|---|---|
| `rubric` | 是 | — | 「什么算目标事件已发生」的共享判据（由模型给） |
| `type` | 否 | `noul` | `noul` 最自然；`choice`/`score` 时配 `criteria` |
| `criteria` | 否 | — | `type` 为 choice/score 时的选项或档位 |
| `hitThreshold` | 否 | 0.5 | 单次判定 P(true) 达到该值记一次命中 |
| `source` | 是 | — | 采样源，见第 6 节 |
| `tailBytes` | 否 | 4096 | 每次采样读取的窗口（有硬上限） |
| `mode` | 否 | `once` | `once` 命中即返回；`continuous` 持续运行 |
| `intervalMs` | 否 | 5000 | 探测间隔，被钳到不小于配置下限 |
| `timeoutMs` | 否 | 120000 | 前台自管 deadline，被钳到不小于 intervalMs |
| `background` | 否 | false | true ⇒ 注册为作业并立即返回 jobId |
| `countThreshold` | 否 | 1 | 累计命中达到该值才返回或通知 |
| `notify` | 否 | `none` | `inbox` 时按 3.3 送通知 |
| `coalesce` | 否 | true | 合并同类通知 |
| `maxNotificationsPerMinute` | 否 | 6 | 通知限频 |

### 4.2 返回形状

```
{ hit, count, countThreshold, at, atIso, firstAt, lastAt, elapsedMs,
  level, samples, hitSamples, evidence, confidence, cost, coverage, notes }
```

`level` 表示本次探测时判据仍为真；`evidence` 是命中那一次的有限尾部（上限硬编码）。

## 5. 上游委托管道（`decision` 的新入口）

### 5.1 形态

一次 `decision` 调用内部完成：委托执行上游工具 → 取原始输出 → 无条件转储 → 直接喂判定内核 → 返回结果。**全程没有会话模型参与。**

```
decision({ upstream: { tool, arguments }, rubric, type, criteria, depth })
```

### 5.2 原始输出怎么取（按工具类型分三类）

| 工具类型 | 结果形态 | 取全文的方式 |
|---|---|---|
| 普通工具 | 结构化结果含**完整 `value`** | 直接用 `value` |
| 进程型（pwsh/bash） | 内存只留 64000 B 尾部 + 宿主转储路径 | 读宿主交给我们的转储引用 |
| 压缩期改写过的历史 | 旧结果被裁成 head+省略+tail | **不可恢复**，长程监控不得依赖回读会话日志 |

### 5.3 转储与 tee（不吞掉）

- 插件**自己**在系统临时区建目录（`os.tmpdir()` 下），**无条件**把上游输出写一份（哪怕只有几字节）。
- 返回里带 `spillPath`、`bytes`（可选 sha256）⇒ 原始字节随时可取。
- 判定只吃有界窗口，`coverage`/`notes` 必须说明「判了多少 / 全文多少 / 是否截断」。
- 转储写失败 ⇒ 内存兜底 + `notes` 明示，**不 fail-closed**（否则管道不可用）。

### 5.4 防护

1. **禁自递归**：`upstream.tool` 不得是本插件自己的工具（默认黑名单，可选白名单覆盖）。
2. **转发 `exec.signal`**，并自管 deadline（宿主超时不抢占）。
3. **读取器白名单**：只接受「我们自己写的转储目录」与「宿主交给我们的转储路径」（前缀校验 + 拒 `..`）。理由：`contains` 是纯路径谓词（对工作区外文件返回 false），而宿主允许读工作区外文件 ⇒ 闸必须是我们自己的显式规则。
4. **转储生命周期自管**：宿主转储没有 session 级清理（只在插件激活时扫一次、删 30 天前），所以我们的目录必须有总量上限与清扫。

## 6. 采样源

| kind | 机制 | 备注 |
|---|---|---|
| `job` | `ctx.jobs.readAt(id, from, caller)` 非消耗式读 stdout/stderr/log | 必须带 sessionId 才能枚举 |
| `file` | 复用既有 `source.js` 读取层 | 走既有 containment 闸 |
| `glob` | 同上 | 复用截断语义 |
| `command` | 内部委托执行（同第 5 节机制） | 需工具服务可用 |
| `events` | 订阅 `agent/status`、`tools/result`、`jobs.events` 等 | 计划模式 |

子代理类任务**没有作业也没有输出源** ⇒ 只能走 `agent/status` 与 `subagent/start|end` 与 `session/event`。

## 7. 权限与装配

- 观测（订阅事件、读作业）在 **root 层**即可，无需额外权限；
- 驱动（`jobs.start`、`tools.execute`）需要 agent 作用域：root 层 `ctx.jobs.start` 会抛「no job controller serves this agent」，`attachController(name)` 之后可用；
- **装配坑**：root 层插件在 `apply` 时 `ctx.get('tools')` 是 `undefined`（工具服务未就绪），必须声明 `inject` 或延后获取；而 `ctx.on('tools/result')` 在 `apply` 时注册有效。
- 委托执行必须带调用方的 `agent` 与 `signal`。

## 8. 安全边界

1. 只通知、不动手。
2. 模型只能给**工具名与参数**（委托）或**采样源描述**；**路径一律过闸**，唯一例外是我们自己的转储目录与宿主交给我们的引用。
3. 采样正文不落盘（只在命中证据里出现有限尾部）。
4. 按 session id 授权的语义要如实说明：宿主围栏按会话划分，契约是「authorization not secrecy」；默认只监控本会话（用户裁定）。
5. 版本风险：设计不得依赖宿主转储的内部结构，只把它当「宿主交给我们的引用」。

## 9. 分阶段验收（可判）

| 阶段 | 内容 | 判据 |
|---|---|---|
| P1 | 前台一次性 | 三个用例（作业尾部出现关键字 / 文件出现某行 / glob 命中）⇒ `hit=true`、`at` 为毫秒、`count=1` |
| P2 | 计数与阈值 | 抖动序列证明按探测结果计数；`countThreshold=3` 时第 3 次才返回；无 CD 生效（无抑制） |
| P3 | 后台与通知 | `background=true` + `notify=inbox` ⇒ 真机证明模型收到通知并反应；连投 50 次通知不炸 inbox（合并与限频生效） |
| P4 | 委托管道 | `upstream` 跑一个真命令 ⇒ 判定结果 + `spillPath` + `bytes` 齐全；200 KB 输出下全文可从 `spillPath` 取回；`timeoutMs` 到点返回而非挂死；caller abort 时立即返回 |

## 10. 未验清单（不得当事实用）

1. 进程型工具的 64000 B 截断与转储通知：隔离实例 `spawn EPERM` 触发不了（仅源码 + 真机磁盘旁证）。
2. 运行态宿主版本可能早于 `0.2.0-rc.2`（磁盘存在互斥旧产物）⇒ 转储行为结论须按版本钉死。
3. 无 agent 的 `ctx.tools.execute`（root 层）是否可行未测。
4. spill 文件权限在 Windows 的真值（源码 0600，真跑 0666）、`cleanupPeriodDays` 到期真删未验。
5. 给**另一个** agent 注入通知未测（只测过同插件创建的那个）。
6. `keepInbox:true` 分支、单次 await 超过 60 s、进程级 kill 边界未测。
7. `run_code` 后台作业是否进 `ctx.jobs` 未验（影响「能否看见自己的长任务」）。
8. `agent/error` 一次未触发；`remove` 对存活作业与 `cause=teardown` 仅源码依据。

## 11. 关键实测锚点

- 作业服务：`dsh-jobs` 的 `view.d.ts` 与 `index.d.ts`；`dsh-jobs-local/lib/index.js:569-589`（view 唯一来源）、`:493-495`（list 需 caller）。
- 通知：`dsh-agent/lib/types/runtime-types.d.ts:145/186/192/200/209`；实现 `dsh-agent-loop/lib/index.js:800-814`；官方范式 `dsh-tool-jobs/lib/index.js:263-296`。
- 工具调用与结果：`dsh-tools/lib/types/index.d.ts:765`（execute）、`:415-416`（value 不落持久事件）。
- 转储：`dsh-spill/lib/types/index.d.ts:41-49`、`dsh-spill-local/lib/index.js:28-37`、`dsh-spill-policy/lib/index.js:7-27/189/239`；进程型 `dsh-subprocess-local/lib/output.js:141-163`。
- 前台超时：`dsh-tool-call-timeout-policy/lib/index.js:123-131`。
- 沙箱读取：`dsh-fs-sandbox/lib/index.js:125/139/153`（只覆写写入）。

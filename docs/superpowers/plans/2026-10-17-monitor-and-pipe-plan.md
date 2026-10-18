# Monitor 与上游委托管道 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给本插件加两个能力：Monitor（异步探测式等待原语，判据由模型给、前台可阻塞、后台可通知）与上游委托管道（一次 decision 调用内跑上游工具并把输出直接喂判定、无条件转储、不吞掉原始输出）。

**Architecture:** 复用既有 decision 内核（`validate.js` → `wire.js` → `client.js` → `render.js`）作为判据引擎；新增三个纯逻辑模块（`monitor.js` 采样与计数、`notify.js` 通知策略、`pipe.js` 委托与转储），全部通过 `apply(ctx, config, internals)` 注入依赖以保证可测；所有策略判定只做“标记”，不参与任何放行/阻断。

**Tech Stack:** Node.js 22（ESM，`node --test`）、DSH 插件 API（`ctx.jobs` / `ctx.agents` / `ctx.tools` / `ctx.fs`）、本机 Ollama System One（`POST /v1/systemone`）。

**Spec:** `docs/superpowers/specs/2026-10-17-monitor-and-pipe-design.md`（含地基强度表、未验清单与 file:line 锚点；执行者必须同时读规格）

## Global Constraints

- **只标记、绝不阻断**：Monitor 的输出不得进入任何 pass/allow/fail-open 判定（规格 §1、§8）。
- **不持久化**：计数只在内存（每次运行从 0 起算）；采样正文不落盘；只在命中那一次保留有限证据（上限硬编码）。
- **时间只作记录**：`at/atIso/firstAt/lastAt` 不参与命中判定。
- **计数口径固定**：按探测结果计数（电平），**无 CD**，不存在 `minGapMs`。
- **间隔钳制**：生效值 `max(intervalMs, Config.minProbeIntervalMs)`；`timeoutMs` 钳到 `≥ intervalMs`（钳制发生要写进 `notes`）。
- **通知**：空闲 `followup` / 忙 `inject`，消息标 `source.form='notice'`；`coalesce` + `maxNotificationsPerMinute` + 唤醒预算三者必须同时存在；**绝不调用** `agent.cancel`。
- **上游委托**：必须带 `agent` 与 `parent`（`parent` 可避免模型面截断）；必须转发 `exec.signal`；**禁自递归**（上游工具名不得是本插件工具）。
- **转储**：插件自建目录（系统临时区），**无条件**写入；返回 `spillPath` + `bytes`；读取器只接受「自建目录」与「宿主交给我们的转储路径」（前缀校验 + 拒 `..`）。
- **插件契约**：`output.render` 返回内容块数组；`output.schema`/`parameters` 用**原生 JSON Schema**（`required` 为数组）；`description` ≤1900 B、参数 schema ≤3600 B、skill ≤4000 B。
- **仓库门禁**：`npm test` 全绿、`node --check`、CR 字节 0、`npm pack` 白名单不变；**新守卫必须先证明会红**再恢复（恢复后 sha256 与原文一致）。
- **提交**：一律 `git commit -F <文件>`（禁止 `-m`）；每个任务一次提交。
- **环境**：本机 `git_bash` 工具已失效，提交走 `terminal`（unconfined）；受限进程 spawn 子进程一律 `EPERM`，所以涉及真跑 pwsh 的验收必须在能 spawn 的宿主里做（规格 §10）。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `lib/monitor.js` | 新建 | 采样循环、命中判定、计数、超时与取消（纯逻辑 + 注入时钟/休眠/采样器） |
| `lib/notify.js` | 新建 | 通知策略：合并、限频、唤醒预算、投递（注入 deliver） |
| `lib/pipe.js` | 新建 | 上游委托、原始输出提取、无条件转储、白名单读取器 |
| `lib/validate.js` | 修改 | 新增 Config 键与 `monitor` / `upstream` 两套参数校验 |
| `lib/tool.js` | 修改 | 注册 `monitor` 工具；`decision` 增加 `upstream` 入口 |
| `assets/decision-usage/SKILL.md` | 修改 | 增加 Monitor 与管道用法（守 4000 B 预算） |
| `test/monitor.test.mjs` | 新建 | 采样/计数/超时/取消（注入时钟，零墙钟） |
| `test/notify.test.mjs` | 新建 | 合并/限频/唤醒预算（注入 deliver，零真实 inbox） |
| `test/pipe.test.mjs` | 新建 | 委托参数、原始输出提取、转储与白名单读取器、禁自递归 |
| `test/tool.test.mjs` · `test/validate.test.mjs` | 修改 | 新参数校验与输出契约 |
| `docs/architecture.md` · `README.md` · `docs/use-cases.md` | 修改 | as-is 真源、工具清单、用例 |

---

### Task 1: Config 与参数校验

**Files:**
- Modify: `lib/validate.js`（`LIMITS` 附近；新增 `MONITOR_LIMITS` 与校验函数）
- Test: `test/validate.test.mjs`

**Interfaces:**
- Produces: `Config.minProbeIntervalMs`（默认 1000）、`Config.notifyCoalesceWindowMs`（默认 5000）、`Config.maxNotificationsPerMinute`（默认 6）、`Config.spillDirCap`、`validateMonitorArgs(args)`、`validateUpstream(args)`。
- Consumes: 既有 `LIMITS`、错误码风格（`material_invalid` 等）。

**Steps:**
- [ ] 写失败测试：`intervalMs` 低于 `minProbeIntervalMs` 被钳到下限；`timeoutMs < intervalMs` 被钳且 `notes` 含钳制说明；未知 `source.kind` 报错；`upstream.tool` 缺失报错；`upstream.tool` 等于本插件工具名报错（禁自递归）。
- [ ] 跑 `npm test` 确认新用例红（记录红的具体断言）。
- [ ] 实现：`MONITOR_LIMITS` 常量 + 两个校验函数（纯函数，无 IO）。
- [ ] 跑 `npm test` 全绿；`node --check lib/validate.js`。
- [ ] 提交（`git commit -F`）。

### Task 2: 采样源适配器

**Files:**
- Modify: `lib/monitor.js`（新建后先放源适配器）
- Test: `test/monitor.test.mjs`

**Interfaces:**
- Produces: `createSources(ctx)` 返回 `{ read(source, { tailBytes }) }`：`kind='job'` 走 `ctx.jobs.readAt(id, from, caller)`（非消耗式，需 `list(sessionId)` 拿 id）；`kind='file'`/`'glob'` 复用 `lib/source.js` 既有读取与截断语义；`kind='events'` 订阅（计划模式，先只读最近若干条）。
- Consumes: `ctx.jobs`、`ctx.sessions`、`lib/source.js`。

**Steps:**
- [ ] 写失败测试：用假 `ctx.jobs` 断言 `readAt` 被以 `caller=sessionId` 调用、且读取窗口被 `tailBytes` 限制；断言 `list(sid)` 而非 `list()` 被调用。
- [ ] 跑测试确认红。
- [ ] 实现源适配器（全部通过注入的 `ctx` 访问，禁止模块级单例）。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 3: Monitor 核心循环（计数与命中）

**Files:**
- Modify: `lib/monitor.js`
- Test: `test/monitor.test.mjs`

**Interfaces:**
- Produces: `runMonitor({ sources, decide, clock, sleep, signal, args })` → `{ hit, count, countThreshold, at, atIso, firstAt, lastAt, elapsedMs, samples, hitSamples, evidence, confidence }`。`decide(text)` 注入（内部调用既有 decision 内核）。
- Consumes: Task 2 的 `sources.read`。

**Steps:**
- [ ] 写失败测试（注入时钟，零墙钟）：`countThreshold=3` 时第 3 次命中才 `hit=true`；连续命中按电平计数（第 2、3 次采样都 +1，无去抖）；`at` 为毫秒整数且 `firstAt ≤ lastAt`；`signal` abort 时立即返回并保留已累计的 `count`；`timeoutMs` 到点返回 `hit=false` 而非挂死。
- [ ] 跑测试确认红。
- [ ] 实现循环（顺序：采样 → 判定 → 计数 → 判阈值 → 检查 signal/deadline → 休眠）。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 4: 通知策略

**Files:**
- Modify: `lib/notify.js`
- Test: `test/notify.test.mjs`

**Interfaces:**
- Produces: `createNotifier({ deliver, clock, coalesceWindowMs, maxPerMinute, wakeBudget })` → `{ notify(evt) }`；`deliver(mode)` 注入，`mode ∈ {'followup','inject'}`（空闲 wake、忙 quiet，照官方范式）。
- Consumes: 无（纯策略）。

**Steps:**
- [ ] 写失败测试：同窗口内同类事件只投递一次（合并）；超过 `maxPerMinute` 被压制且计数可观测；唤醒预算用尽后 `mode` 从 `followup` 降级为 `inject`；通知 id 唯一（避免宿主 `already pending` 抛错）。
- [ ] 跑测试确认红。
- [ ] 实现策略（不得触碰真实 inbox）。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 5: 后台模式（作业注册与进度）

**Files:**
- Modify: `lib/monitor.js`、`lib/tool.js`
- Test: `test/monitor.test.mjs`

**Interfaces:**
- Produces: `startBackgroundMonitor(ctx, args)` → `{ jobId }`：`ctx.jobs.start` 起生产者；`attachController` 兜底（root 层无控制器时）；`updateProgress('命中 2/3 · P=0.71 · 已监控 45s')` 一行状态。
- Consumes: Task 3 的 `runMonitor`、Task 4 的 notifier。

**Steps:**
- [ ] 写失败测试：假 `ctx.jobs` 断言先试 `start`、抛「no job controller」时调用 `attachController` 再重试；断言 `updateProgress` 被调用且字符串含计数与阈值。
- [ ] 跑测试确认红。
- [ ] 实现后台启动与进度上报。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 6: 注册 `monitor` 工具（含预算与渲染契约）

**Files:**
- Modify: `lib/tool.js`、`assets/decision-usage/SKILL.md`
- Test: `test/tool.test.mjs`

**Interfaces:**
- Produces: 模型可见工具 `monitor`（参数见规格 §4.1）；`output.render` 返回内容块数组；回答体五键风格与 `decision` 一致（前端说明 + 计数 + 命中证据 + cost/coverage/notes）。
- Consumes: 全部前置任务。

**Steps:**
- [ ] 写失败测试：`render` 返回数组且每项含 `type`（守住宿主契约）；描述 ≤1900 B、参数 schema ≤3600 B；`notes[0]` 是选档/钳制结论。
- [ ] 跑测试确认红。
- [ ] 实现注册与渲染；更新 skill 用法段（守 4000 B）。
- [ ] 跑测试全绿 + `node --check`。
- [ ] 提交。

### Task 7: 上游委托与原始输出提取

**Files:**
- Modify: `lib/pipe.js`（新建）、`lib/tool.js`
- Test: `test/pipe.test.mjs`

**Interfaces:**
- Produces: `runUpstream(ctx, exec, upstream, { signal })` → `{ raw, toolName, exitCode?, bytes, isError, error? }`：调用 `ctx.tools.execute({ callId, rootCallId, name, arguments, signal, agent, parent })`；普通工具取 `value`；进程型取 `value.stdout.text` 与 `spillPath`（两层截断）。
- Consumes: Task 1 的 `validateUpstream`。

**Steps:**
- [ ] 写失败测试：断言调用参数**同时**含 `agent` 与 `parent`（缺 `parent` 会被宿主截断）；`isError:true` 时把 `error.info.code` 透传且**不 throw**；`unknown tool` 文案写成「不存在或被禁用」（宿主两情形同形）。
- [ ] 跑测试确认红。
- [ ] 实现委托与提取。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 8: 无条件转储、白名单读取器与 tee 返回

**Files:**
- Modify: `lib/pipe.js`、`lib/tool.js`
- Test: `test/pipe.test.mjs`、`test/tool.test.mjs`

**Interfaces:**
- Produces: `spillWrite(raw, { dir, maxBytes })` → `{ path, bytes, sha256Prefix }`；`spillRead(path, { allowedRoots })`（只接受自建目录与宿主交来的转储路径，拒 `..`）；`decision` 返回里新增 `material.source='upstream'`、`spillPath`、`bytes`、`truncated`。
- Consumes: Task 7 的 `runUpstream`。

**Steps:**
- [ ] 写失败测试：小输出也落盘（无条件）；`spillRead` 拒绝工作区外**任意**路径但接受 `allowedRoots` 内的路径；超上限时截断且返回 `truncated:true` + `fullBytes`；转储写失败时降级为内存并写 `notes`（不 fail-closed）。
- [ ] 跑测试确认红。
- [ ] 实现转储/读取/tee 字段。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 9: 取消、超时与递归防护收口

**Files:**
- Modify: `lib/pipe.js`、`lib/monitor.js`
- Test: `test/pipe.test.mjs`、`test/monitor.test.mjs`

**Interfaces:**
- Produces: 统一 `withDeadline(fn, { signal, timeoutMs })`：把 `exec.signal` 透传给上游与采样，超时自行返回（不等宿主抢占）；递归深度计数上限（默认 1 层）。
- Consumes: Task 7/8。

**Steps:**
- [ ] 写失败测试：上游忽略 signal 时我们仍在 `timeoutMs` 返回；深度 2 的委托被拒且 `notes` 说明；`signal` abort 时上游收到的 signal 真的已 abort（断言同一实例）。
- [ ] 跑测试确认红。
- [ ] 实现统一 deadline 与深度防护。
- [ ] 跑测试全绿。
- [ ] 提交。

### Task 10: 文档与打包门禁

**Files:**
- Modify: `docs/architecture.md`、`README.md`、`docs/use-cases.md`

**Steps:**
- [ ] 更新 as-is 真源：模块数/行数、工具清单（`decision` + `monitor`）、新增 Config 键、`upstream` 入口与 tee 语义、未验清单。
- [ ] 跑 `npm pack --dry-run` 确认白名单未变；`tr -cd '\r'` 计数为 0；injection 预算三项复测。
- [ ] 跑 `npm test` 全绿并记录数字。
- [ ] 提交。

### Task 11: 端到端验收（P1–P4）

**Files:**
- Modify: `smoke/live.mjs`（增加 monitor 与 pipe 两个真机用例）

**Steps:**
- [ ] P1 前台一次性：对作业尾部/文件/glob 三个源各跑一次，断言 `hit=true` 与毫秒 `at`。
- [ ] P2 计数与阈值：构造抖动序列，断言按探测结果计数且 `countThreshold=3` 时第 3 次才命中。
- [ ] P3 后台与通知：`background=true` + `notify='inbox'`，真机证明收到通知且连投 50 次不炸 inbox。
- [ ] P4 委托管道：在**能 spawn 子进程**的宿主里跑真命令，断言判定结果 + `spillPath` + `bytes` 齐全、200 KB 全文可从 `spillPath` 取回、`timeoutMs` 到点返回、caller abort 立即返回。
- [ ] 提交。

## 已知风险与执行提示

1. 受限会话（`workspace-write`）里 pwsh 一律 `spawn EPERM` ⇒ P4 必须在真宿主跑；受限环境下把该条标记为 blocked 而不是改断言。
2. 运行态宿主版本可能早于 `0.2.0-rc.2` ⇒ 不依赖宿主转储内部结构，只当「宿主交给我们的引用」。
3. 压缩期 pruner 会改写历史 ⇒ 长程监控不得回读会话日志中的旧工具结果。
4. 本机 `git_bash` 工具已失效，提交使用 `terminal`（unconfined）；`danger-full-access` 亦可但会弹审批。
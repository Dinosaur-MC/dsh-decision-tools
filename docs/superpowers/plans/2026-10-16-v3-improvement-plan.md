# dsh-decision-tools v3 与正确性改进 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把已知正确性缺陷修完（错误分类、`aggregate`、扫描状态形状、终态、容量估算），再把 `decision` 工具面重建为领域接口（`material` + `rubric` + `items` / `questions` 两模式互斥），配一个独立的线格式适配层，并以真机 `usage.input_tokens` 验收收益。

**Architecture:** 现有 11 个纯模块保持分层不变；新增 `lib/wire.js` 作为**唯一**知道 `/v1/systemone` 线格式的地方（`noul`/`criteria`/`instructions`/`keep_alive` 全部收进来）；`lib/tool.js` 继续是唯一接触 `ctx` 的文件；容量估算按「模型窗口 × 安全余量 × 语言字节密度」计算，语言密度用材料的 CJK 占比确定性推断。

**Tech Stack:** Node ESM（无运行时依赖），`node --test` 测试，Ollama `/v1/systemone`（本机），DSH 插件 API（`ctx.tools` / `ctx.fs` / `ctx.skills`）。

**Spec:**
- `docs/superpowers/specs/2026-10-04-dsh-decision-tools-design.md`（ADR-1..6，基础设计）
- `docs/superpowers/specs/2026-10-12-auto-strategy-design.md`（ADR-7..10，引用式材料/提升/扫描）
- `docs/superpowers/specs/2026-10-16-v3-domain-api-design.md`（**本计划 Task 1 产出**，ADR-11..16）
- `docs/architecture-current.md`（现状事实，含 §8 r6 真机数字）
- `docs/use-cases.md`（五类判定形状 = 本计划的验收用例）
- `.temp/gpt-review.md`（外部评审，P0 清单来源）

## Global Constraints

- 文本文件一律 **LF**（提交前 `tr -cd '\r' | wc -c` 必须为 0）。
- **不加运行时依赖**（`dependencies` 保持为空）；peer 依赖不变。
- 每个任务结束都要 `npm test` 全绿；不得留红树。
- 中间产物写 `.temp/`（已 gitignore），**不入库**；`docs/` 与 `test/` 不在 npm `files` 白名单，打包边界不变。
- 注入预算守卫（`test/parameters.test.mjs`）：工具描述 ≤ 1900 B、参数 schema ≤ 3600 B、skill 正文 ≤ 4000 B。
- 容量与窗口是**运行时属性**：不得把某次 `num_ctx` 实测值写死进断言；断言的是「按窗口与语言密度算出的判定」，不是具体数字。
- 判据在请求体中的位置**固定为「材料之后」**（r6：位置会移动概率，必须固定进契约）。
- 每任务一次提交；提交信息写「变了什么 / 要不要动手 / 验证数字」，不写探索过程。

## 0. 决策（本计划据此展开；执行前可推翻，但需改 Task 1 的 ADR 与受影响任务）

| # | 决策 | 依据 |
|---|---|---|
| D1 | 工具面分**两种互斥模式**：`items`（同判据批量）与 `questions`（一材料多问）。**同时给出即报错**，不引入「谁生效」的歧义 | 外部评审 §4.2；`docs/use-cases.md` 前五类形状 |
| D2 | `items` 的身份契约：**每项是自带完整待判对象的短文本或标识**；材料内的定位由 `material`（内联/文件切片/glob）决定，不让模型临时推断 | 外部评审 §4.2 |
| D3 | 输出统一为 `results[] + coverage + material + cost + notes`，**硬切**旧键（`answers`/`usage`/`state_bytes`/`body_bytes`/`body_warning`/`confidence_warning`/`chunks`/`scan`/`source`/`escalated`/`strategy`/`aggregate`） | v2 已用硬切先例；调用方只需要一种读法 |
| D4 | 旋钮收敛：`depth: quick \| normal \| deep` 取代 `strategy`；删除 `aggregate`（语义并入 depth 与自动分批）；`model` 保留为高级逃生口 | 外部评审 §4.1；`strategy`/`aggregate` 属上游实现细节 |
| D5 | 工具名保留 `decision`；上游词汇解耦靠 `lib/wire.js`，不靠改名 | 改名要动 README/规格/profile/测试，收益低于成本 |
| D6 | 批大小（一次请求装多少 item）是**实现细节**：按 body 预算自动分批并合并，调用方不可见 | r6 §规模：tev1 窗口下 35 项必然溢出，换放置救不了窗口 |
| D7 | 容量估算按语言密度：CJK 占比高 ⇒ 2.32 B/token，否则 3.33；阈值由「窗口 × 0.6 × 密度」算出，不再用全局常量 4096 | r6 的 2.32 B/token 实测；外部评审 §3.2 |

---

## Phase 1 — 决策落纸

### Task 1: 写 v3 规格（ADR-11..16）

**Files:**
- Create: `docs/superpowers/specs/2026-10-16-v3-domain-api-design.md`
- Modify: `docs/superpowers/specs/2026-10-12-auto-strategy-design.md`（末尾加一行指向新规格）

**Interfaces:** 无代码接口；产出是本计划其余任务引用的规格文本。

- [ ] **Step 1:** 按 ADR-11..16 写规格，每条含：决策、依据（引用 `architecture-current.md` §8 / `use-cases.md` / 外部评审节号）、被取代的旧条目、**验收指标**。ADR 编号与内容：ADR-11 两模式互斥（D1+D2）；ADR-12 `material` 抽象与安全边界不变量（保留：工作区内、读取上限、单文件超限报错 vs glob 截断、截断不可当完整）；ADR-13 输出统一与硬切（D3）；ADR-14 `depth` 三档语义（D4；含每档的升档上限与是否允许分批）；ADR-15 线格式适配层与 wire 形状（判据在材料之后；`questions` 为对象映射；`keep_alive` 只在此处）；ADR-16 容量与语言密度（D7）。
- [ ] **Step 2:** 在规格里放一张「旧键 → 新键」迁移表（逐键写「消失 / 改名 / 语义变化」），供 Task 13/14 直接照抄。
- [ ] **Step 3:** 自检：核对 ADR-11..16 各自都能指到本计划的一个任务（互斥 → Task 9/10；material → Task 11；输出 → Task 12；depth → Task 9/11；wire → Task 8；容量 → Task 6）。
- [ ] **Step 4:** Commit

```bash
git add docs/superpowers/specs/2026-10-16-v3-domain-api-design.md docs/superpowers/specs/2026-10-12-auto-strategy-design.md
git commit -m 'docs(spec): v3 领域接口 ADR-11..16（两模式互斥 / material / 输出统一 / depth / wire 层 / 语言密度容量）'
```

---

## Phase 2 — P0 正确性（v3 之前必须全绿）

### Task 2: 升档只对容量类错误触发

**Files:** Modify: `lib/tool.js`（`apply()` 内的提升循环）；Test: `test/tool.test.mjs`

**Interfaces:** Consumes `client.js` 的 `classifyOverflow(err)`；Produces 无新导出，只改控制流。

- [ ] **Step 1: 写失败测试**

```js
test('非容量类错误不换档：服务端 500 必须原样抛出、不得尝试第二个模型', async () => {
  const calls = [];
  const ctx = fakeCtx({ reply: (req) => { calls.push(req.model); return { status: 500, body: 'boom' }; } });
  await assert.rejects(executeTool(ctx, { state: 'x', questions: [q('a')] }), (err) => {
    assert.equal(err.kind, 'server_error');
    return true;
  });
  assert.equal(calls.length, 1, '只发一次请求');
});
```

- [ ] **Step 2: 跑它，确认失败** — `node --test test/tool.test.mjs`，期望 FAIL（当前实现会换档 ⇒ `calls.length > 1`）。
- [ ] **Step 3: 最小实现** — 在提升循环里，只有 `classifyOverflow(err)` 判为容量/溢出类时才进入下一档；否则把原始 `err` 透传。
- [ ] **Step 4: 跑测试** — `npm test` 全绿（含既有的「提升失败不得粘滞」用例）。
- [ ] **Step 5: Commit** — `git commit -m 'fix(escalate): 只有容量类错误才换档，其余保留原始错误'`

### Task 3: `aggregate` 不再空转

**Files:** Modify: `lib/tool.js`、`lib/scan.js`；Test: `test/tool.test.mjs`、`test/scan.test.mjs`

**Interfaces:** Produces `scan.js` 的 `aggregateNoul(chunks, mode)`（已存在，签名不变）。

- [ ] **Step 1: 写失败测试** — 两条：① 非 scan 传 `aggregate` ⇒ 抛结构化错误 `kind=aggregate_requires_scan`；② `strategy=scan` + `aggregate=any` ⇒ 结果里的聚合块确实来自 `aggregateNoul(...)`（用注入的 fake 断言被调用）。

```js
test('aggregate 只在 scan 下有意义：非 scan 传它必须报结构化错误', async () => {
  await assert.rejects(executeTool(ctx, { state: 'x', questions: [q('a')], aggregate: 'any' }),
    (err) => { assert.equal(err.kind, 'aggregate_requires_scan'); return true; });
});
```

- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（当前 `aggregate` 被完全忽略）。
- [ ] **Step 3: 最小实现** — 校验层拒绝「非 scan + aggregate」；scan 分支把 `aggregate` 传给 `aggregateNoul`。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'fix(aggregate): 非 scan 给结构化错误，scan 下真正接线'`

### Task 4: `scan` + 结构化 `state` 给结构化错误

**Files:** Modify: `lib/validate.js`、`lib/plan.js`；Test: `test/validate.test.mjs`、`test/plan.test.mjs`

**Interfaces:** Produces `resolveStrategy(args, state)` 在「扫描 + 非字符串 state」时抛 `DecisionValidationError`，`kind=scan_requires_text_state`，`message` 含可行做法（改传字符串，或不要扫描）。

- [ ] **Step 1: 写失败测试**

```js
test('scan + 结构化 state：给结构化错误而不是裸 TypeError', () => {
  assert.throws(() => resolveStrategy({ strategy: 'scan' }, { a: 1 }), (err) => {
    assert.equal(err.name, 'DecisionValidationError');
    assert.equal(err.kind, 'scan_requires_text_state');
    return true;
  });
});
```

- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（当前抛裸 `TypeError`）。
- [ ] **Step 3: 最小实现** — 在策略解析阶段判断：`scan` 且 `typeof state !== 'string'` ⇒ 抛该结构化错误；`auto` 遇结构化 state 时**不**退化到扫描（走单发）。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'fix(scan): 结构化 state 与扫描的组合改为结构化拒绝'`

### Task 5: 升档耗尽给统一终态

**Files:** Modify: `lib/tool.js`、`lib/escalate.js`；Test: `test/escalate.test.mjs`、`test/tool.test.mjs`

**Interfaces:** Produces `describeExhausted({ attempts, lastError })` → `SystemOneError`（`kind='escalation_exhausted'`，`attempts` 为 `[{model, failureKind}]`）。

- [ ] **Step 1: 写失败测试** — 三档全溢出时，最终错误 `kind === 'escalation_exhausted'`，且 `attempts` 长度 = 实际尝试次数、逐条带 `model` 与 `failureKind`。
- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（`describeExhausted` 当前零调用，抛的是最后一档的原始错误）。
- [ ] **Step 3: 最小实现** — 扫描耗尽时调用 `describeExhausted` 并抛出它的返回值。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'fix(escalate): 升档耗尽统一终态，附带尝试过的模型与失败分类'`

### Task 6: 容量估算按语言密度

**Files:** Create: `lib/density.js`；Modify: `lib/escalate.js`、`lib/tool.js`、`lib/validate.js`；Test: `test/density.test.mjs`、`test/escalate.test.mjs`

**Interfaces:**
- Produces `cjkShare(text)` → `0..1`（按码点统计 CJK 统一表意文字）。
- Produces `bytesPerToken(text)` → `share >= 0.3 ? 2.32 : 3.33`。
- Produces `softBytesFor({ numCtx, margin = 0.6, text })` → `Math.floor(numCtx * margin * bytesPerToken(text))`。
- `selectByCapacity` 增加入参 `softBytes`（由调用方用 `softBytesFor` 算出），`LIMITS.softBodyBytes` 保留为「无窗口信息时的兜底」。

- [ ] **Step 1: 写失败测试**

```js
test('中文材料按 2.32 B/token 估算，英文按 3.33', () => {
  assert.equal(bytesPerToken('这是中文材料'), 2.32);
  assert.equal(bytesPerToken('plain english text'), 3.33);
});
test('阈值由窗口算出：窗口越大阈值越大，且永远是窗口的 60%', () => {
  const t = softBytesFor({ numCtx: 8192, text: 'plain english' });
  assert.equal(t, Math.floor(8192 * 0.6 * 3.33));
  assert.ok(softBytesFor({ numCtx: 16384, text: 'plain english' }) > t);
});
test('同样的字节数，中文判为更吃容量', () => {
  const zh = '中'.repeat(4000);
  assert.ok(softBytesFor({ numCtx: 8192, text: zh }) < softBytesFor({ numCtx: 8192, text: 'a'.repeat(4000) }));
});
```

- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（`lib/density.js` 不存在）。
- [ ] **Step 3: 最小实现** — 新建 `lib/density.js` 三个纯函数；`selectByCapacity` 改吃算好的 `softBytes`；`tool.js` 在选档前算一次。
- [ ] **Step 4: 跑测试** — `npm test`（既有 A 方案四条用例可能需要按新阈值调整期望值 —— 调整时必须写明「因为阈值口径变了」，不得只为让测试变绿而改断言）。
- [ ] **Step 5: Commit** — `git commit -m 'fix(capacity): 阈值由模型窗口与语言密度算出（中文 2.32 / 英文 3.33 B per token）'`

### Task 7: `plan.reason` 表意

**Files:** Modify: `lib/tool.js`；Test: `test/tool.test.mjs`

**Interfaces:** Produces `plan.reason` 为 `selectByCapacity` 返回的 reason（`explicit` / `fits-default` / `fits-ladder` / `largest` / `sticky-fallback` / `default-fallback`），并新增 `plan.model`（最终模型）。

- [ ] **Step 1: 写失败测试** — 小材料 ⇒ `plan.reason === 'fits-default'`；显式 model ⇒ `'explicit'`；容量逼迫跳档 ⇒ `'fits-ladder'`。
- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（当前 `reason` 只描述策略）。
- [ ] **Step 3: 最小实现** — 把 `selectByCapacity` 的 reason 与模型写进 `plan`。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'fix(plan): reason 反映选档原因，并给出最终模型'`

---

## Phase 3 — v3 领域接口

### Task 8: 抽出线格式适配层 `lib/wire.js`

**Files:** Create: `lib/wire.js`；Modify: `lib/validate.js`（删除其中的线格式代码）、`lib/tool.js`、`lib/client.js`；Test: `test/wire.test.mjs`

**Interfaces:**
- Produces `toWireRequest({ material, rubric, items, questions, type, model, keepAlive })` → `{ model, state, questions }`。
  - `state` = `material` 文本 + `'\n\n'` + 判据块（**判据在后**），判据块格式固定为 `'判据：' + rubric`。
  - `items` 模式：`questions` = `{ [String(i + 1)]: { type, instructions: items[i] } }`；`choice`/`score` 的 `criteria` 复制到每个问题上。
  - `questions` 模式：`questions` = `{ [q.name]: { type, instructions, criteria? } }`。
- Consumes 无（纯函数，零 import）。

- [ ] **Step 1: 写失败测试**（断言的是 **wire body**，不只是工具面）

```js
test('判据写在材料之后，且只出现一次', () => {
  const body = toWireRequest({ material: '材料', rubric: '判据X', items: ['甲', '乙'], type: 'noul' });
  assert.equal(body.state, '材料' + String.fromCharCode(10, 10) + '判据：判据X');
  assert.equal(body.state.split('判据X').length - 1, 1);
  assert.deepEqual(Object.keys(body.questions), ['1', '2']);
  assert.equal(body.questions['1'].instructions, '甲');
});
```

- [ ] **Step 2: 跑它，确认失败** — `node --test test/wire.test.mjs`，期望 FAIL（模块不存在）。
- [ ] **Step 3: 最小实现** — 新建 `lib/wire.js`；把 `validate.js` 里的线格式代码搬进来（**只搬不改语义**），`client.js` 只收 `toWireRequest` 的产物。
- [ ] **Step 4: 跑测试** — `npm test` 全绿；再跑一次 `grep -rn 'noul' lib/ | grep -v wire.js` 确认上游词汇已收敛（除 `wire.js` 与测试外应无命中，`scan.js`/`render.js` 里的显示词除外，逐条写明理由）。
- [ ] **Step 5: Commit** — `git commit -m 'refactor(wire): 线格式收进 lib/wire.js，判据固定写在材料之后'`

### Task 9: 参数契约重写（两模式互斥）

**Files:** Modify: `lib/parameters.js`；Test: `test/parameters.test.mjs`

**Interfaces:** Produces `PARAMETERS` = `material` / `rubric` / `items` / `questions` / `type` / `depth` / `model`（顺序即注入顺序；`material` 与 `depth` 必填，其余按模式）。

- [ ] **Step 1: 写失败测试** — 断言：① 六个键名与顺序；② 描述里写明「`items` 与 `questions` 同时给出即报错」；③ 注入预算仍 ≤1900/≤3600 B。
- [ ] **Step 2: 跑它，确认失败** — 期望 FAIL（旧键仍在）。
- [ ] **Step 3: 最小实现** — 重写 `PARAMETERS` 与 `TOOL_DESCRIPTION`（**不写 v1/v2 沿革**，只写用法与硬边界；完整指引留在 skill）。
- [ ] **Step 4: 跑测试** — `npm test`；若预算超限，先量再压缩，**不得先抬阈值**。
- [ ] **Step 5: Commit** — `git commit -m 'feat(api): 工具面改为 material/rubric/items/questions/type/depth/model'`

### Task 10: 校验层重写

**Files:** Modify: `lib/validate.js`；Test: `test/validate.test.mjs`

**Interfaces:**
- Produces `assertModeExclusive(args)` → 恰好一种模式；两者都有或都没有 ⇒ `DecisionValidationError`（`kind='mode_conflict'` / `'mode_missing'`）。
- Produces `resolveMaterial(args, exec)`（内联/文件/glob 三形态归一为 `{text, descriptor}`）。
- Produces `resolveDepth(depth)` → `'quick' \| 'normal' \| 'deep'`，非法值报错。
- `LIMITS` 保留 `maxQuestions`、`maxChoiceOptions`、`maxScoreLevels` 等，新增 `maxItems`（= `maxQuestions`）。

- [ ] **Step 1: 写失败测试** — 四条：两模式同给报错；都不给报错；`depth` 非法值报错；`items` 超过 `maxItems` 报错。
- [ ] **Step 2: 跑它，确认失败**。
- [ ] **Step 3: 最小实现**（保留 `analyzeBody` 的归因逻辑不动 —— 它的口径已被 r6 证实）。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'feat(validate): 两模式互斥 + material 归一 + depth 解析'`

### Task 11: 编排改造（含按预算自动分批）

**Files:** Modify: `lib/tool.js`；Test: `test/tool.test.mjs`

**Interfaces:**
- `items` 模式：按 `softBytesFor` 的预算把 items 切成批次，每批一次请求，结果按顺序合并；`coverage.batches` 记录批数。
- `depth` 语义：`quick` = 只用默认档、不升档、不分批（超预算直接报错并给出可行建议）；`normal` = 容量分派 + 溢出升档 + 允许分批；`deep` = 从更大档起步 + 升档上限提高。

- [ ] **Step 1: 写失败测试** — 三条：① 35 个小 item 在一个大窗口模型下只发 **1** 次请求；② 强制小窗口时发 **多** 次请求且 `coverage.batches` = 批数、结果顺序与 items 一致；③ `depth='quick'` 超预算 ⇒ 报错（不悄悄分批）。
- [ ] **Step 2: 跑它，确认失败**。
- [ ] **Step 3: 最小实现** — 分批只改请求次数，**不改返回结构**（调用方看到的仍是 N 条结果）。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'feat(tool): items 按 body 预算自动分批，depth 三档语义'`

### Task 12: 输出契约与渲染重写

**Files:** Modify: `lib/tool.js`（`OUTPUT_SCHEMA`）、`lib/render.js`；Test: `test/render.test.mjs`、`test/tool.test.mjs`

**Interfaces:**
- `OUTPUT_SCHEMA.properties` = `results` / `coverage` / `material` / `cost` / `notes`。
  - `results[]`：`{ id, type, value, probabilities?, confidence? }`（`noul` 时 `value` 为布尔、`probabilities` 为 `{true,false}`；`choice`/`score` 的 `value` 为所选标签、`probabilities` 为各标签概率）。
  - `coverage`：`{ requested, answered, batches, truncated, truncatedBy?, failed, aborted }`。
  - `cost`：`{ model, inputTokens, bodyBytes, wallMs, escalated, attempts[] }`。
  - `notes[]`：字符串数组（体积归因、低置信、扫描提示都在这里）。
- `renderAnswers(args, value, companionSkillBody)` 改为按 `results`/`coverage`/`cost`/`notes` 渲染。

- [ ] **Step 1: 写失败测试** — 断言五个键、`results` 与请求项一一对应、旧键**不出现**（`assert.equal('answers' in value, false)`）。
- [ ] **Step 2: 跑它，确认失败**。
- [ ] **Step 3: 最小实现**。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'feat(output): 统一 results/coverage/material/cost/notes，旧键硬切'`

### Task 13: skill 与两份 README 词表更新

**Files:** Modify: `assets/decision-usage/SKILL.md`、`README.md`、`README.zh.md`；Test: `test/parameters.test.mjs`（锚点）、`test/skill.test.mjs`

**Interfaces:** skill 正文只讲新词（`material`/`rubric`/`items`/`depth`），**不提** v1/v2 与旧键。

- [ ] **Step 1: 写失败测试** — 断言 skill 正文出现 `items`、`rubric`、`depth`，且**不出现** `v1`/`v2`/`stateSource`。
- [ ] **Step 2: 跑它，确认失败**。
- [ ] **Step 3: 改三份文本**（skill ≤4000 B；README 的配置表必须与 `Config` 投影一致 —— 既有守卫会查）。
- [ ] **Step 4: 跑测试** — `npm test`。
- [ ] **Step 5: Commit** — `git commit -m 'docs+skill: 词表切到 material/rubric/items/depth'`

### Task 14: 破坏性变更说明与规格回写

**Files:** Modify: `README.md`、`README.zh.md`（新增「从旧版迁移」一节）、`docs/superpowers/specs/2026-10-16-v3-domain-api-design.md`（补实测数字回填位）

- [ ] **Step 1:** 按 Task 1 的迁移表写「旧 → 新」逐键对照，标注**破坏性**（旧键不再返回）。
- [ ] **Step 2:** 写明「本次改动对调用方要不要动手」：需要（字段改名 + 单选 `depth`）。
- [ ] **Step 3:** 修正 `docs/use-cases.md` 的反场景措辞：把「图片/视觉判定」写成**当前 DSH 扩展不支持**，不要让人读成整个 System One 不支持（Clef / Clef Flash 支持 `images`）。
- [ ] **Step 4:** 在 `docs/architecture-current.md` 给 `choice 2–255` 加口径注：**本机实测值、非跨版本契约**（官方文档仍写 2–26）；运行时能力优先于静态常量。
- [ ] **Step 5:** Commit — `git commit -m 'docs: 旧→新迁移表（破坏性变更）+ 两处口径修正'`

---

## Phase 4 — 收益验收门（v3 之后立即做，不延后）

### Task 15: 真机收益实测（10 / 35 / 64 三档）

**Files:** Create: `.temp/v3-eval/probe-v3.mjs`（不入库）；Modify: `docs/architecture-current.md` §8（回填数字）

**Interfaces:** 复用 r6 的合成集与探针结构（`.temp/review-v2/probe-r6.mjs`），把 A（旧工具面）与 v3 工具面在同一进程、交替顺序、5 次取中位。

- [ ] **Step 1:** 探针产出每个档位的：请求体字节、`usage.input_tokens`、墙钟、标签一致率、准确率（合成集含 ground truth）。
- [ ] **Step 2:** **形状断言**：把 v3 实际发出的 wire body 与 r6 的 B 形状逐字比对（判据在材料之后、`questions` 为对象映射）——不一致则该任务判失败，不允许用「工具面更简洁」替代。
- [ ] **Step 3:** 判据：`input_tokens` 必须显著低于旧形状（r6 的 35 项基准为 −45.3%）；若达不到，先查 wire 形状，再查分批，最后才改设计。r6 遗留的未解机制（A 与 B 的单 prompt token 数 7230 vs 3940）若在 v3 复现 B 形状后仍拿不到同等降幅，回到该机制查因，**不得靠改设计绕开**。
- [ ] **Step 4:** 把数字写进 `docs/architecture-current.md` §8 与规格（口径：**字节与计费两项收益才算收益，墙钟不作为卖点**）。
- [ ] **Step 5:** Commit — `git commit -m 'docs: v3 真机收益实测回填（10/35/64）'`

---

## Phase 5 — 可靠性与可观测性

### Task 16: 并发测试隔离（消除 undici 全局池 flake）

**Files:** Modify: `test/client.test.mjs`（或新增 `test/helpers/http.js`）；Test: 自身

**Interfaces:** 每个用例用自己的 `Agent`/`Pool` 实例（显式注入），不再共享进程级全局调度器。

- [ ] **Step 1: 写失败测试** — 连续 20 次「服务端立刻 500」在并发 8 下必须 20 次都归类为 `server_error`（当前装置会 flake）。
- [ ] **Step 2: 跑它，确认失败（或先复现 flake）**。
- [ ] **Step 3: 最小实现** — 每用例注入独立调度器；`client.js` 允许注入 `dispatcher`（默认不传，保持产品行为不变）。
- [ ] **Step 4: 跑 20 轮** — `for i in $(seq 20); do npm test || break; done`，必须 20/20 绿。
- [ ] **Step 5:** Commit — `git commit -m 'test: 按用例隔离 HTTP 调度器，消除并发 flake'`

### Task 17: 阈值标定 + 粘滞边界 + 运行时能力发现

**Files:** Create: `docs/threshold-calibration.md`；Modify: `docs/architecture-current.md`、`lib/escalate.js`（注释）

- [ ] **Step 1:** 写清粘滞的三个层级与优先级：**显式 model（本次调用）> 会话/进程粘滞（上次显式或成功升档）> 默认档**，并写明失效条件（模型不存在 / 溢出 / 用户显式指定）。
- [ ] **Step 2:** 写标定方法（不写数字结论）：用带标注的小集，按 `(model, question type, 业务)` 报告错误率与阈值曲线；区分「漏判高风险」与「误选无害」两类成本。
- [ ] **Step 3:** 运行时能力发现：启动时或首次使用时探测所选模型的 `num_ctx` 与题型上限，**优先于静态常量**；探测失败才回退静态值。
- [ ] **Step 4:** 自检：这三项都不改变默认行为，除非探测成功（写明）。
- [ ] **Step 5:** Commit — `git commit -m 'docs: 阈值标定方法、粘滞优先级与运行时能力发现'`

---

## 验收总表（谁来判、判什么）

| 阶段 | 判据 |
|---|---|
| P0（Task 2–7） | 五个结构化错误/终态各有测试；容量阈值由窗口与语言密度算出；`plan.reason` 可解释 |
| v3 接口（Task 8–14） | 两模式互斥可测；wire body 逐字符合 r6 形状；输出只有五个键；skill/README 无旧词 |
| 收益（Task 15） | 10/35/64 三档的真机 `input_tokens` 与字节对照，且**形状断言通过** |
| 可靠性（Task 16–17） | 20/20 连续绿；粘滞优先级成文；能力探测优先于静态常量 |

## 风险与回退

- **Task 8/11 是本计划最险的两处**（搬线格式、自动分批）：都要求「只搬不改语义」或「只改请求次数不改返回结构」，并各有独立测试；任一处不达标就停在那一档，不继续往 Task 12 走。
- **Task 6 会改既有 A 方案用例的期望值**：允许改断言，但必须写明是因为阈值口径变了（不是为变绿而改）。
- **Task 12 是硬切**：若调用方还在用旧键，README 的迁移表是唯一补救；不提供兼容层（延续 v2 先例）。
- 回退单位是任务级：每个任务一次提交，都能单独 revert。
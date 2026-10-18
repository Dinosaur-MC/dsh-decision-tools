# 客户端半、工具行拆分与工具接口增量 — 设计规格

> 状态：**待实现**（本文件只写规格，不含代码）。日期 2026-10-18。
> 依据：本机 DSH 0.2.0-rc.2 的 app.asar 源码（dsh-settings / dsh-client-ui-settings / dsh-client-ui-plugin-manager / dsh-client-modules）、dsh-win-multi-bash 的已上线实现（G:/LAB/202608/dsh-win-multi-bash），以及用户 2026-10-18 的设计确认。
>
> 目标不是“给插件加一个表单”，而是把单行插件拆成 **核心行 + 每个模型工具一行**，让每一行在 Plugins 面板里可独立开关、各自拥有 Configure 页，并让模型配置在 GUI 保存后**下一次调用即生效**。

## 0. 一句话

把 dsh-decision-tools 从「一行注册 decision + monitor」改成「四行：核心/模型、decision、monitor、skill」，新增浏览器半用 plugins.row.config 渲染每行表单；模型配置放核心行、工具行可单独覆盖；所有 GUI 字段用 .volatile() + 活句柄读取，实现保存即生效。

## 1. 目标与非目标

### 1.1 目标

1. **行级独立开关**：decision 与 monitor 各自一行，关掉一行不影响另一行；核心行与 skill 行也独立。
2. **GUI 实时配置**：Plugins 页每行一个 Configure 页；模型相关字段保存后下一次工具调用生效，无需重启/重载行。
3. **模型配置单一来源**：baseUrl / defaultModel / timeoutMs / keepAlive / escalationEnabled 放核心行；工具行只放 modelOverride 与自身行为项。
4. **工具接口更顺手**：在不破坏现有八键契约与概率校准的前提下，接受更自然的简写。
5. **可退化**：核心行关闭时工具仍用内置默认值工作；设置服务缺失时浏览器半不激活，但 host 工具照常。

### 1.2 非目标（硬）

1. **不重设 decision 八键**：material / rubric / items / questions / type / criteria / depth / model 保持，v4 重构另立规格。
2. **不做 Ollama 模型下拉**：第一版模型字段是文本框 + 已知模型提示，不引入 host remote/typert 端点；后续可加。
3. **不做设置自动页（autoGenerate）**：浏览器半自己注册表单；不依赖设置外壳的自动渲染（平台现状也不渲染自动页）。
4. **不持久化 GUI 状态**：表单草稿只在页面生命周期内；保存走 profile 的 Cordis patch。
5. **不引入新工具**：不增加 decision_list_models 之类的辅助工具。

## 2. 已核实的地基（硬契约）

| 事实 | 强度 | 依据 |
|---|---|---|
| 设置命名空间 = profile entry id（行 id） | **硬** | dsh-settings/lib/index.js 的 describe() 用 entry.options.id 作 ns；mutate(ns, …) 按行 id 找 entry |
| 只有 Config 中 .volatile() 字段进入表单并可写 | **硬** | volatileForm(schema) 只保留 volatile 节点；write() 对非 volatile 路径抛错；describe() 跳过无 volatile 字段的行 |
| .volatile() 字段在 apply(ctx, config) 里是活句柄 | **硬** | dsh-win-multi-bash/lib/index.js 注释与实测；typeof value.get === function |
| 浏览器半由裸包名行的 package.json dsh.client + exports["./client"] 发现 | **硬** | dsh-client-modules 的 dsh.client 解析；dsh-win-multi-bash 的 win-mb-plugin 核心行注释 |
| 行配置槽 key = 包名#行 id | **硬** | dsh-client-ui-plugin-manager 的 rowConfigKey() |
| 工具行页在对应设置命名空间被服务时出现；核心行用 bundle 页无条件降级 | **硬** | 工具行 ConfigForms.whileServed；核心行 plugins.bundle.config + fallback scope |
| 表单写入是 revision-fenced 的 staged save | **硬** | ConfigFormController.mutate(ops, expectedRevision)；冲突抛 SettingsConflictError |
| 浏览器半 import 抛错会拖垮 web boot | **硬（本机事故）** | 既有记忆与 dsh-win-multi-bash/lib/client.js 注释；必须可选 require + safely() |
| 词典值必须是字符串 | **硬（本机实测）** | t() 内部 template.replace；函数/数字会抛 |

**结论**：不能只给现有 Config 加字段就期待 GUI 出现；必须 (a) 拆行、(b) 把 GUI 字段声明为 .volatile()、(c) 在读取点解析活句柄、(d) 新增浏览器半注册 plugins.row.config。

## 3. 行结构

### 3.1 四行

| 行 id | 包入口 | 职责 | 默认 |
|---|---|---|---|
| decision-tools-plugin | dsh-decision-tools（裸包名） | 核心：浏览器半、共享模型/运行时配置、插件页说明；不注册模型工具 | 开 |
| decision-tools-decision | dsh-decision-tools/decision | 注册 decision 工具（名字取核心行 toolName） | 开 |
| decision-tools-monitor | dsh-decision-tools/monitor | 注册 monitor 工具（名字取核心行 monitorToolName） | 开 |
| decision-tools-skill | dsh-decision-tools/skill | 随包 decision-usage skill，保持独立 | 开 |

### 3.2 为什么核心行必须是裸包名

DSH 的客户端模块发现按行的 name 解析包 package.json：裸包名（dsh-decision-tools）能解析到 dsh.client 与 exports["./client"]；子路径（dsh-decision-tools/decision）解析不到包清单，因此**不能承载浏览器半**。所有行页都必须由核心行的 lib/browser.js 注册。

### 3.3 关闭语义

- 关 decision-tools-decision：只少 decision 工具；monitor / skill / 核心页照常。
- 关 decision-tools-monitor：只少 monitor 工具；decision 照常。
- 关 decision-tools-plugin：两个工具仍用内置默认值工作，但 Plugins 页的 Configure 页消失，共享模型配置回到内置默认。**不推荐**，会在 plugins.detail.section 与 README 明说。
- 关 decision-tools-skill：decision 工具会因为拿不到配套 skill 而拒绝服务（既有硬要求），这是预期行为。

### 3.4 为什么删除 decisionEnabled / monitorEnabled

行开关已经是独立的启停机制；保留布尔开关会产生「行开着但工具被配置关掉」的双重语义，且在插件页里一个行会显示“已启用”但工具不存在。本次升级直接删除这两个键；行开关是唯一启停机制。

## 4. 配置分层

### 4.1 核心行 decision-tools-plugin

    export const Config = z.object({
      baseUrl: z.string().default('http://localhost:11434').volatile(),
      defaultModel: z.string().default('tev1:0.8b').volatile(),
      timeoutMs: z.number().default(120000).min(1).volatile(),
      keepAlive: z.union([z.string(), z.number()]).required(false).volatile(),
      escalationEnabled: z.boolean().default(true).volatile(),
      // 高级：数组编辑器不进第一版表单；改后需重载核心行（工具行每次执行读取）
      ladder: z.array(z.object({ model: z.string(), numCtx: z.number().min(1) })).required(false),
      // 注册期值：工具行从共享总线读取；改后重载核心行
      toolName: z.string().default('decision'),
      monitorToolName: z.string().default('monitor'),
      // 上游委托转储上限；YAML 高级项
      spillDirCap: z.number().min(1).required(false),
    });

- baseUrl / defaultModel / timeoutMs / keepAlive / escalationEnabled 是 GUI 实时项。
- ladder / spillDirCap 是 YAML 高级项；不声明 volatile。工具行通过共享总线每次执行读取；改后重载核心行。
- toolName / monitorToolName 是注册期项：改后重载对应的工具行；decision 的 selfToolNames 也快照 monitorToolName，故改 monitorToolName 时 decision 行一并重载。
- 核心行 apply 只做一件事：把上述字段（含活句柄）发布到 lib/config-bus.js；不注册工具。

### 4.2 decision 行 decision-tools-decision

    export const Config = z.object({
      modelOverride: z.string().required(false).volatile(),     // 空 = 用核心 defaultModel
      defaultDepth: z.union([
        z.const('quick'), z.const('normal'), z.const('deep'),
      ]).default('normal').volatile(),
      bodyWarning: z.boolean().required(false).volatile(),
      softBodyBytes: z.number().min(0).required(false).volatile(),
      minConfidence: z.number().min(0).required(false).volatile(),
      maxChoiceOptions: z.number().min(2).required(false).volatile(),
      escalationMaxAttempts: z.number().min(1).default(3).volatile(),
      scanFirstChunkBytes: z.number().min(1).required(false).volatile(),
      scanMaxChunks: z.number().min(1).required(false).volatile(),
      scanMaxTotalBytes: z.number().min(1).required(false).volatile(),
      scanDeadlineMs: z.number().min(1).required(false).volatile(),
      scanAggregate: z.string().required(false).volatile(),
    });

- defaultDepth 是新增的便捷项：调用方省略 depth 时用它，显式 depth 仍优先。
- 其余数值项沿用既有「常量单源 + apply 回落」纪律；只是从注册时快照改为每次执行解析。
- 工具名 toolName 属于核心行；decision 行只覆盖模型与判定行为。

### 4.3 monitor 行 decision-tools-monitor

    export const Config = z.object({
      modelOverride: z.string().required(false).volatile(),     // 空 = 用核心 defaultModel
      minProbeIntervalMs: z.number().min(1).required(false).volatile(),
      notifyCoalesceWindowMs: z.number().min(0).required(false).volatile(),
      maxNotificationsPerMinute: z.number().min(1).required(false).volatile(),
    });

- monitorToolName 与 spillDirCap 属于核心行；monitor 行只覆盖模型与探测/通知默认值。

### 4.4 有效值合成

    effective.model          = live(decision.modelOverride) || shared.defaultModel
    effective.baseUrl        = shared.baseUrl
    effective.timeoutMs      = shared.timeoutMs
    effective.keepAlive      = shared.keepAlive
    effective.ladder         = shared.ladder（非 volatile，但每次执行读取）
    effective.escalation     = shared.escalationEnabled
    effective.toolName       = shared.toolName
    effective.monitorToolName = shared.monitorToolName
    effective.spillDirCap    = shared.spillDirCap

monitor 同理，只是没有 ladder/escalation 消费者；它的判据请求用 shared.baseUrl/defaultModel/timeoutMs/keepAlive。

**关键**：工具行**不能**在 apply 时把共享值解构成常量；必须在每次 execute / 每次 monitor 判定时调用 readSharedConfig()。

## 5. 实时生效机制

### 5.1 活句柄

    export function live(value, fallback) {
      const raw = typeof value?.get === 'function' ? value.get() : value;
      return raw === undefined ? fallback : raw;
    }

规则：

1. apply 里凡是 GUI 可改的字段，**只保留引用**，不比较、不取快照、不传给 setTimeout。
2. 每个读取点（工具 execute、monitor 的 resolveConfig、decide）现取现值。
3. 对 NaN/null/负数 的兜底逻辑保持在读取点（沿用 resolveSoftBodyBytes / resolveMinConfidence 等纯函数）。
4. 测试用假句柄 { get: () => value }，在两个 execute 之间改闭包值，断言下一次调用使用新值。

### 5.2 共享总线 lib/config-bus.js

    export const SHARED_DEFAULTS = Object.freeze({
      baseUrl: 'http://localhost:11434',
      defaultModel: 'tev1:0.8b',
      timeoutMs: 120000,
      keepAlive: undefined,
      escalationEnabled: true,
      ladder: DEFAULT_LADDER,
    });

    let handles = SHARED_DEFAULTS;

    export function publishSharedConfig(next) {
      handles = { ...SHARED_DEFAULTS, ...next };  // next 的值可以是活句柄
    }

    export function readSharedConfig() {
      return {
        baseUrl: live(handles.baseUrl, SHARED_DEFAULTS.baseUrl),
        defaultModel: live(handles.defaultModel, SHARED_DEFAULTS.defaultModel),
        timeoutMs: positive(live(handles.timeoutMs, SHARED_DEFAULTS.timeoutMs), SHARED_DEFAULTS.timeoutMs),
        keepAlive: live(handles.keepAlive, undefined),
        escalationEnabled: live(handles.escalationEnabled, true) !== false,
        ladder: live(handles.ladder, SHARED_DEFAULTS.ladder),
      };
    }

- 模块级单例：同一包的所有行共享同一 ESM 模块实例。
- 核心行未加载/已卸载时 readSharedConfig() 返回默认值，工具仍可用。
- 核心行卸载时应把 handles 复位到默认值（ctx.effect 清理），避免陈旧值。

### 5.3 读取时机

| 读取点 | 读取内容 | 时机 |
|---|---|---|
| applyDecision | 本行 Config（活句柄） | 每次 execute 开头 |
| applyMonitor | resolveConfig() | 每次 runMonitor 探测 |
| callSystemOne | baseUrl/timeoutMs | 每次请求 |
| toWireRequest | defaultModel/modelOverride/keepAlive | 每次请求 |
| 上游委托 | timeoutMs/spillDirCap | 每次委托 |
| 通知 | notifyCoalesceWindowMs/maxNotificationsPerMinute | 每次通知 |

### 5.4 不承诺实时的项

- toolName / monitorToolName：注册期值；改 toolName 重载 decision 行，改 monitorToolName 重载 monitor 行并一并重载 decision 行。
- ladder：核心行重载后生效（工具行每次读取，所以不需要重载工具行）。
- 任何影响工具注册结构的字段（未来若加 prompt 段/工具开关）：注册期。

## 6. 浏览器半

### 6.1 发现与入口

package.json 必须新增：

    {
      "exports": {
        ".": "./lib/index.js",
        "./decision": "./lib/decision-entry.js",
        "./monitor": "./lib/monitor-entry.js",
        "./skill": "./lib/skill.js",
        "./client": "./lib/browser.js",
        "./package.json": "./package.json"
      },
      "dsh": {
        "bundle": { "patch": "./cordis.patch.yml" },
        "client": { "platform": "web" }
      }
    }

- license / files 不变；lib/**/*.js 已覆盖新文件。
- dsh.client.platform 必须是 "web"。
- 只有裸包名行（核心行）能携带这个声明；不要给子路径行加 dsh.client。

### 6.2 模块结构

    lib/browser.js          浏览器半（window.__ModuleLoader__.load）
    lib/config-bus.js       host 侧共享活配置
    lib/configs.js          三条行的 Config schema
    lib/decision-entry.js   decision 行入口（Config + applyDecision）
    lib/monitor-entry.js    monitor 行入口（Config + applyMonitor）
    lib/index.js            核心行入口（Config + publish；包 main）
    lib/tool.js             decision/monitor 共用的实现引擎：applyDecision / applyMonitor + 纯逻辑

**一次性到位**：旧 tool.js 的组合 apply 被拆成 applyDecision / applyMonitor；旧能力（source reader、monitor decide、command、event log、deliver）全部并入同一个引擎，不保留生产兼容入口。测试侧用 test/helpers/apply-all.mjs 把两条行组合起来跑既有用例 —— 这是测试组合器，不是生产接口。

### 6.3 浏览器半骨架

    window.__ModuleLoader__.load({
      id: 'dsh-decision-tools',
      factory: (require) => {
        // 可选 import：缺失就安静降级，绝不让 web boot fatal
        let React; try { React = require('react'); } catch { React = undefined; }
        let primitives; try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch { primitives = undefined; }
        if (React === undefined || typeof React.createElement !== 'function') {
          module.exports = {};
          return module.exports;
        }
        // ... locale / CSS / RowConfigForm / RowConfigCard ...
        exports.inject = ['slots', 'locale', 'configForms'];
        exports.apply = (ctx) => { try { apply(ctx); } catch (e) { ctx?.logger?.warn?.(...); } };
        exports.__internals = { ROWS, rowKey, RowConfigForm, planOps, locale, ... }; // 供测试
        return module.exports;
      },
    });

### 6.4 每个行页的注册

    const ROWS = [
      { rowId: 'decision-tools-plugin',  label: ..., fields: [...] },
      { rowId: 'decision-tools-decision', label: ..., fields: [...] },
      { rowId: 'decision-tools-monitor',  label: ..., fields: [...] },
    ];
    const rowKey = (rowId) => PACKAGE_NAME + '#' + rowId;

    for (const row of ROWS) {
      safely(row.rowId + ' page', () => {
        const form = new RowConfigForm(ctx.configForms.get(row.rowId), row);
        ctx.effect(() => () => form.dispose(), ...);
        ctx.effect(() => ctx.configForms.whileServed([row.rowId], () =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({
              name: 'plugins.row.config',
              key: rowKey(row.rowId),
              locale: NS,
              inject: () => form.inject(),
            }, RowConfigCard)
          )
        ), ...);
      });
    }

- 工具行不能无条件注册：行未加载时其命名空间不被服务，whileServed 保证页面只在该行活着时出现。
- **核心行例外**：多部署实测核心行设置命名空间不会被服务；核心表单必须无条件挂 `plugins.bundle.config`（key 同时尝试 core row id 与包名），内部用 fallback scope 显示 unavailable，而不是让整个 Configure 入口消失。
- 槽 key 必须是「包名#行 id」；行 id 与 cordis.patch.yml 完全一致。
- 不注册 conversation.header 等首方单槽；只碰 plugins.row.config、plugins.bundle.config（仅核心行）与 plugins.detail.section。

### 6.5 表单模型（staged save）

照 dsh-win-multi-bash 的已验证模型，保留这些语义：

1. staged Map 保存草稿；discard() 清空。
2. baseline 是草稿批次第一次编辑时读到的 snapshot；save() 用 baseline.revision 做 fence。
3. planOps() 只写实际变化的字段：值等于当前解析值 → 不写；清空且用户层本来没有 → 不写。
4. 保存中不重入；失败保留草稿并显示 saveFailed。
5. 只读（writable !== true）时控件禁用；status !== 'ready' 显示 unavailable。
6. 数字字段：非有限值在浏览器侧警告但仍允许写（平台 A3 语义：用户输入优先）；host 的 effective 解析器负责回落/钳制。
7. 文本字段保存前 trim；空串 = unset（回退继承/默认）。

RowConfigCard 的形态：

    function RowConfigCard(props) {
      if (typeof props?.useRowForm !== 'function') return fallbackSummary;
      const state = props.useRowForm((s) => s);
      if (props.view === 'summary') return t('summary');
      return h(primitives.SettingsForm, {
        labels: { unavailable, readOnly, saveFailed, save, saving },
        state,
        onSave: props.save,
        onDiscard: props.discard,
      }, ...state.fields.map(fieldControl));
    }

### 6.6 GUI 字段表

#### 核心行（模型与运行时）

| 字段 | 控件 | 实时 | 说明 |
|---|---|---|---|
| baseUrl | text | 是 | 空串回落默认；提示保留路径前缀 |
| defaultModel | text | 是 | 空串回落默认；hint 列已知模型（tev1:0.8b / tev1:latest / clef-flash:latest / nimble:latest），提示用 node scripts/list-models.mjs 查本机 |
| timeoutMs | number | 是 | 正整数；空串回落默认 |
| keepAlive | text | 是 | 30m 或秒数；空串 = 不下发该字段 |
| escalationEnabled | boolean | 是 | 关掉后不升档 |
| ladder | 不进表单 | 否 | YAML 高级项；空/未设 ⇒ DEFAULT_LADDER；核心行重载后生效 |
| toolName / monitorToolName / spillDirCap | 不进表单 | 否 | 注册期/高级 YAML；改后重载对应行 |

#### decision 行

| 字段 | 控件 | 实时 | 说明 |
|---|---|---|---|
| modelOverride | text | 是 | 空 = 用核心 defaultModel |
| defaultDepth | segmented quick/normal/deep | 是 | 调用方省略 depth 时使用 |
| bodyWarning | boolean | 是 | 关掉后返回里不出现 body_warning |
| softBodyBytes | number | 是 | 0 = 每次告警；空 = 默认 |
| minConfidence | number | 是 | 0 = 关闭置信度告警 |
| maxChoiceOptions | number | 是 | choice 选项上限 |
| escalationMaxAttempts | number | 是 | 升档尝试上限 |
| scanFirstChunkBytes / scanMaxChunks / scanMaxTotalBytes / scanDeadlineMs | number | 是 | 平铺在 decision 页 |
| scanAggregate | segmented none/any | 是 | 暂定聚合策略 |

#### monitor 行

| 字段 | 控件 | 实时 | 说明 |
|---|---|---|---|
| modelOverride | text | 是 | 空 = 用核心 defaultModel |
| minProbeIntervalMs | number | 是 | 探测间隔下限 |
| notifyCoalesceWindowMs | number | 是 | 同类通知合并窗口 |
| maxNotificationsPerMinute | number | 是 | 通知限频 |

### 6.7 文案、样式与降级

- 词典命名空间 settings.decision-tools；zh / en 的**值全部是字符串**。
- CSS 类前缀 dshdt-；style 标签带 data-plugin="dsh-decision-tools" 与 data-plugin-css="dsh-decision-tools/client.js"，卸载时移除。
- 缺 React：不注册任何贡献；日志 warn；不抛。缺 primitives（或单个导出）：用 honest HTML 控件兜底，照常注册三个 page + core note；日志 warn。真实部署 profile 里没有 `@deepseek-ai/dsh-client-ui-primitives`，这是默认路径。
- 缺 configForms：浏览器半不激活（required inject），host 工具不受影响。
- plugins.detail.section：只在 subject 是本包的 bundle 或 decision-tools-plugin 核心行时渲染一段说明：“核心行承载模型配置与 Configure 页；两个工具行可独立开关；核心行关闭后工具回退默认值”。

## 7. GUI 体验

### 7.1 路径

Plugins 面板 → dsh-decision-tools → 四行：

1. Decision 工具 · 模型与运行时（核心）：模型/baseUrl/timeout/keepAlive/escalation。
2. Decision 工具：判定行为 + 模型覆盖。
3. Monitor 工具：探测/通知/转储 + 模型覆盖。
4. Decision 使用指引 Skill：无表单，保持独立开关。

### 7.2 保存语义

- 编辑 → 草稿（不写盘）；Save → 一次性 mutate(ops, revision)。
- 成功：草稿清空，表单显示服务端新值。
- 冲突：Host 返回 conflict，表单显示失败并保留草稿；用户刷新后重试。
- Reset：单字段 unset，回退继承/默认；直接 Save 生效。
- 只读/不可用：控件禁用，SettingsForm 显示对应文案。

### 7.3 关闭/启用

- 行开关由插件管理页提供（DSH 官方行为）；关掉即不加载该行。
- 关掉 decision 不影响 monitor；反之亦然。
- 关掉核心行：工具仍工作但无 GUI/共享配置；插件页说明这是不推荐状态。

## 8. 工具接口增量（向后兼容）

### 8.1 choice 的 criteria 接受 string[]

现状：schema 写 oneOf [object, array<string>]，但 validateChoice 只认对象，数组会被拒。
目标：criteria: ["yes", "no"] 归一为 { yes: "yes", no: "no" }；对象形态仍可给出描述。
校验：2–255 项；每项非空字符串；重复标签报错。

### 8.2 score 的 criteria 接受 { min, max }

现状：只认 2–10 个字符串的数组。
目标：{ min: 1, max: 5 } 展开为 ["1","2","3","4","5"]；整数、min < max、档数 2–10。
对象形态与数组形态的 score 保持可用。

### 8.3 material 简写

接受：

    { "file": "docs/a.md" }
    { "glob": "docs/*.md" }

等价于 { file: { path: "docs/a.md" } } / { glob: { pattern: "docs/*.md" } }。在 lib/validate.js 的 normalizeMaterial 归一化处处理；校验错误文案仍指向完整形态。

### 8.4 model: "auto"

model 传 "auto" 等价于省略（走容量选档、允许升档），不再被当成模型名。"auto" 之外的非空字符串仍是显式钉模型。

### 8.5 文档与测试

- 更新 parameters.js 的描述与 assets/decision-usage/SKILL.md 示例。
- 新增 test/parameters-convenience.test.mjs：string[] choice、{min,max} score、material 简写、model auto。
- items 传字符串数组本来就是合法形态；补一条文档与测试，避免调用方以为必须写对象。

**不做**：noul 改名、items/questions 合并、type 别名、v4 参数重设。

## 9. 一次性升级（不保留兼容层）

本次不提供旧行 id、旧键别名或兼容读取层。旧能力按职责并入新结构：

- 旧 combined apply 的 decision / monitor 逻辑 → lib/tool.js 的 applyDecision / applyMonitor；它们是唯一实现，不是兼容入口。
- 旧 Config 的模型键 → 核心行 SharedConfig；decision 行为键 → DecisionConfig；monitor 键 → MonitorConfig。没有别名。
- decisionEnabled / monitorEnabled → 删除；行开关是唯一启停机制。
- 旧 decision-tools-tool 行 → 不再存在；cordis.patch.yml 只写四行。
- 旧 profile 覆盖 → 直接按新行 id 写 config；config 整块替换的语义不变。

测试侧 test/helpers/apply-all.mjs 只是把两条行组合起来跑既有用例的测试组合器；生产没有 combined apply。

## 10. 测试与验收

### 10.1 单元测试

1. test/config-bus.test.mjs：默认值、publish 活句柄、核心未加载回退、卸载复位。
2. test/live-config.test.mjs：假句柄在两个 execute 之间变化，断言 cost.model / timeout / 阈值按新值生效；核心行字段变化被工具行读到。
3. test/client-form.test.mjs：planOps（set/unset/无变化）、staged、revision fence、保存失败保留草稿、只读禁用。
4. test/client-boot.test.mjs：缺 React / primitives 时 client 模块不抛；locale 值全字符串；row key 正确。

### 10.2 契约守卫

1. cordis.patch.yml 的行 id 集合 === client ROWS + skill 行。
2. 每个 client 字段路径在对应 host Config 中存在且是 volatile。
3. package.json 同时有 dsh.client.platform === 'web' 与 exports["./client"]。
4. 核心行是裸包名；子路径行不带 dsh.client。
5. README 配置表键集与 Config 投影一致（既有守卫扩展为三张表）。
6. 删除的 decisionEnabled/monitorEnabled 不再出现在 Config/README/测试。

### 10.3 真机验收

1. 起当前 web profile，Plugins 页看到四行与三个 Configure 页。
2. 改核心行 defaultModel → 保存 → 调一次 decision → cost.model 为新值（无需重启）。
3. 改 decision 行 modelOverride → 保存 → decision 用覆盖模型；monitor 仍用核心默认。
4. 关 monitor 行 → 模型工具列表里 monitor 消失，decision 仍在；开回恢复。
5. 关核心行 → 工具仍可调用（默认模型），Configure 页消失；开回恢复。
6. 设置写入冲突：两个页面同时改同一行，后保存者收到冲突且草稿还在。
7. 浏览器刷新/重连后表单值来自 Host，不是本地残留。

### 10.4 回归

- 全量套件（当前 427 例：426 pass / 1 skip / 0 fail）全绿；test/tool.test.mjs / test/monitor-tool.test.mjs 的入口改为 test/helpers/apply-all.mjs 的测试组合器。
- npm test 全量；docs-numbers 守卫更新模块/测试计数（在提交点重新测量）。

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| volatile 活句柄被当普通值快照 | 统一 live()；test/live-config 用假句柄证明两次调用不同值 |
| 浏览器半 import 失败导致 web boot fatal | 可选 require + 每个贡献 safely()；顶层不抛 |
| 跨插件槽位注册导致首方插件崩溃 | 只注册 plugins.row.config / plugins.bundle.config（核心）/ plugins.detail.section；工具行 whileServed 门控；不碰首方 single 槽 |
| 行未加载导致页面不出现 | 工具行预期行为（whileServed）；核心行改用无条件 bundle 页 + fallback scope |
| 核心行被关 | 工具回退默认值；插件页/README 明说 |
| 设置服务缺失 | configForms required inject ⇒ 浏览器半不激活；host 工具不受影响 |
| 旧 profile 覆盖失效 | 一次性切换；README 直接写新行 id，不保留旧键别名 |
| 表单字段与 Config 漂移 | 契约守卫（字段路径 + volatile） |
| 改名/重载语义误导 | 表单只显示 volatile 字段；toolName/ladder 明确写“需重载” |

## 12. 文件清单

### 新增

- lib/config-bus.js — 共享活配置总线。
- lib/configs.js — 三条行 Config schema。
- lib/decision-entry.js — decision 行入口与 Config。
- lib/monitor-entry.js — monitor 行入口与 Config。
- lib/browser.js — 浏览器半。
- test/config-bus.test.mjs、test/live-config.test.mjs、test/client-form.test.mjs、test/client-contract.test.mjs、test/parameters-convenience.test.mjs、test/helpers/apply-all.mjs。
- docs/superpowers/specs/2026-10-18-client-gui-and-row-split-design.md（本文件）。

### 修改

- package.json — exports / dsh.client / version。
- cordis.patch.yml — 四行。
- lib/index.js — 核心入口（Config + publish；不注册工具）。
- lib/tool.js — 拆出 applyDecision / applyMonitor（唯一实现），保留纯逻辑导出。
- lib/parameters.js — 简写描述。
- lib/validate.js — choice string[]、score {min,max}、material 简写。
- lib/monitor-tool.js — 适配 resolveConfig 的活读取。
- README.md / README.zh.md — 三张配置表 + GUI 说明（无迁移段）。
- docs/architecture-current.md — 四行结构、客户端半、模块/用例数字。
- test/tool.test.mjs / test/monitor-tool.test.mjs — 入口改测试组合器。
- test/parameters.test.mjs / test/validate.test.mjs — 新契约。
- test/docs-numbers.test.mjs — 数字守卫（未改断言，只更新文档数字）。

## 13. 实施（一次性完成）

1. **host 最终结构**：新增 configs / config-bus / decision-entry / monitor-entry；lib/tool.js 拆成 applyDecision / applyMonitor；cordis.patch.yml 写四行；package.json 写 exports 与 dsh.client。
2. **实时配置**：三条 Config 的 GUI 字段声明 .volatile()；核心行发布句柄；工具行每次 execute / 探测读取；删除 decisionEnabled / monitorEnabled。
3. **浏览器半**：lib/browser.js 注册两个 plugins.row.config 页面 + 一个核心 plugins.bundle.config 页面；locale / CSS；staged save + revision fence；契约守卫。
4. **工具接口增量**：choice string[]、score {min,max}、material 简写、model auto；文档 + 测试。
5. **收口**：README 三张表；architecture 数字重测；use-cases；全量回归；真机验收。

## 14. 后续（不在本规格）

- Ollama 已装模型下拉：需要 host remote/typert 端点；第一版用文本框 + 已知模型提示。
- v4 工具 API 重构：另立规格，需概率校准回归。
- 真正的“自动生成设置页”：平台尚不渲染 autoGenerate；本插件自己注册表单。

---

**批准记录**：2026-10-18，用户确认“核心行共享模型配置 + 工具行可覆盖”。工具接口档位按“向后兼容的增量”执行；若要 v4 重构需另开规格。

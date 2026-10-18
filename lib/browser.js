/**
 * dsh-decision-tools — browser half.
 *
 * 给核心行、decision 行、monitor 行各注册一个 Plugins 页 Configure 表单：
 *   plugins.row.config，key = 包名#行 id。
 *
 * 表单走平台自己的 settings 服务：ctx.configForms.get(rowId) 读快照，Save 时
 * mutate(ops, revision)。草稿是 staged 的：编辑不写盘，Save 才写；冲突保留草稿。
 *
 * 这个模块在 web boot 时被加载，任何一个 import/render 抛出都可能拖垮整次启动，
 * 因此 React / primitives 都是可选 import，每个贡献都包在 safely() 里。
 */
window.__ModuleLoader__.load({
  id: 'dsh-decision-tools',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    function unavailable(reason) {
      // React 缺失时无法渲染任何东西，只能不注册；primitives 缺失则用下面的 honest HTML 兜底。
      module.exports = {
        inject: [],
        apply: function (ctx) {
          try { ctx?.logger?.warn?.('dsh-decision-tools: client disabled (' + reason + ')'); } catch (ignored) { /* noop */ }
        },
      };
      return module.exports;
    }

    var React;
    try { React = require('react'); } catch (error) { React = undefined; }
    if (React === undefined || React === null || typeof React.createElement !== 'function') {
      return unavailable('react missing');
    }
    var h = React.createElement;
    var loadedPrimitives;
    try { loadedPrimitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (error) { loadedPrimitives = undefined; }
    var REQUIRED_PRIMITIVES = ['SettingsForm', 'SettingsValueField', 'Checkbox', 'Button', 'SegmentedControl'];
    // 真实部署（profile 里没有 @deepseek-ai/dsh-client-ui-primitives）会走 HTML 兜底。
    // 不能因为缺一个导出就整页不注册：那会让 Configure 入口直接消失；也不能把 undefined
    // 交给 React（Element type is invalid）——所以逐个补齐，缺哪个补哪个。
    var stubPrimitives = {
      SettingsForm: function (props) { return h('div', { className: 'dshdt-form' }, props && props.children); },
      SettingsValueField: function (props) {
        return h('input', {
          type: 'text',
          value: props && props.text !== undefined ? props.text : '',
          disabled: props && props.disabled,
          onChange: function (event) { if (props && props.onEdit) props.onEdit(event.target.value); },
        });
      },
      Checkbox: function (props) {
        return h('input', {
          type: 'checkbox',
          checked: props && props.checked === true,
          disabled: props && props.disabled,
          onChange: function (event) { if (props && props.onChange) props.onChange(event.target.checked); },
        });
      },
      Button: function (props) {
        return h('button', {
          type: props && props.type ? props.type : 'button',
          disabled: props && props.disabled,
          onClick: props && props.onClick,
        }, props && props.children);
      },
      SegmentedControl: function (props) {
        return h('div', { className: 'dshdt-segmented' }, (props && props.options ? props.options : []).map(function (option) {
          return h('button', {
            key: option.value,
            type: 'button',
            disabled: props && props.disabled,
            onClick: function () { if (props && props.onChange) props.onChange(option.value); },
          }, option.label);
        }));
      },
    };
    var primitives = Object.assign({}, loadedPrimitives || {});
    var degradedPrimitives = REQUIRED_PRIMITIVES.filter(function (name) { return typeof primitives[name] !== 'function'; });
    degradedPrimitives.forEach(function (name) { primitives[name] = stubPrimitives[name]; });

    var NS = 'settings.decision-tools';
    var PACKAGE_NAME = 'dsh-decision-tools';
    var CORE_ROW_ID = 'decision-tools-plugin';

    var zh = {
      'summary.generic': '在这里配置模型与工具行为；保存后下一次调用生效。',
      'defaultLabel': '默认',
      'modelsTitle': '可用模型',
      'refreshModels': '查询模型',
      'modelsLoading': '查询中…',
      'modelLoadFailed': '查询失败：',
      'useModel': '设为默认',
      'addToOrder': '加入顺序',
      'coreNote': '核心行承载共享模型配置与这些 Configure 页；decision / monitor 两行可独立开关。核心行关闭后两个工具仍用内置默认值工作，但本页的配置入口会消失。',
      'unavailable': '这一行当前没有加载，暂时无法配置。',
      'readOnly': '当前部署以只读方式提供设置。',
      'saveFailed': '保存没有被接受，草稿已保留，请修正后重试。',
      'save': '保存',
      'saving': '保存中…',
      'overridden': '已覆盖',
      'reset': '恢复默认',
      'invalidNumber': '请输入数字，留空表示使用默认值。',
      'invalidNumberFormat': '这个值会按数字保存，而不是按输入的文本保存。',
      'option.quick': '快速',
      'option.normal': '标准',
      'option.deep': '深度',
      'option.none': '不聚合',
      'option.any': '任一命中',
      'baseUrl.label': 'Ollama 地址',
      'baseUrl.hint': '保留路径前缀；留空使用默认地址。',
      'defaultModel.label': '默认 decision 模型',
      'defaultModel.hint': '工具行未设模型覆盖时使用；例如 tev1:0.8b、tev1:latest、clef-flash:latest、nimble:latest；用 node scripts/list-models.mjs 查本机已装模型。',
      'timeoutMs.label': '请求超时（毫秒）',
      'timeoutMs.hint': '正整数；留空使用默认值。',
      'keepAlive.label': '模型驻留时间',
      'keepAlive.hint': '如 30m 或秒数；留空表示不下发 keep_alive。',
      'apiKey.hint': '可选；作为 Authorization: Bearer 发送给模型接口。',
      'modelsPath.hint': '模型列表路径；Ollama 用 /api/tags，OpenAI 兼容接口可用 /v1/models。',
      'systemOnePath.hint': 'System One 判定接口路径，相对 baseUrl；默认 v1/systemone。',
      'modelOrder.hint': '逗号分隔的模型名；按顺序优先。可用 model@numCtx 指定上下文；未知模型按 8192 参与。',
      'escalationEnabled.label': '允许容量溢出升档',
      'escalationEnabled.hint': '关闭后只尝试选中的档，不再因上下文溢出换更大模型。',
      'modelOverride.label': '模型覆盖（本行）',
      'modelOverride.hint': '在这里为这一行选择模型覆盖。',
      'defaultDepth.label': '默认深度',
      'defaultDepth.hint': '调用方省略 depth 时使用。',
      'bodyWarning.label': '体积告警',
      'bodyWarning.hint': '关闭后不再返回体积/文本形状提示。',
      'softBodyBytes.label': '体积告警阈值（字节）',
      'softBodyBytes.hint': '0 表示每次都告警；留空使用默认值。',
      'minConfidence.label': '置信度告警阈值',
      'minConfidence.hint': '0 表示关闭；留空使用默认值。',
      'maxChoiceOptions.label': 'choice 选项上限',
      'maxChoiceOptions.hint': 'choice 选项数上限。',
      'escalationMaxAttempts.label': '升档尝试上限',
      'escalationMaxAttempts.hint': '正整数；留空使用默认值。',
      'scanFirstChunkBytes.label': '扫描首块字节',
      'scanFirstChunkBytes.hint': 'deep 内部分块的首块预算。',
      'scanMaxChunks.label': '扫描最大块数',
      'scanMaxChunks.hint': 'deep 内部分块的块数上限。',
      'scanMaxTotalBytes.label': '扫描总量上限（字节）',
      'scanMaxTotalBytes.hint': 'deep 内部分块读取的总量上限。',
      'scanDeadlineMs.label': '扫描墙钟预算（毫秒）',
      'scanDeadlineMs.hint': 'deep 内部分块的总时间预算。',
      'scanAggregate.label': '扫描聚合',
      'scanAggregate.hint': '分块答案的合并策略。',
      'minProbeIntervalMs.label': '探测间隔下限（毫秒）',
      'minProbeIntervalMs.hint': '模型给的 intervalMs 不得低于此值。',
      'notifyCoalesceWindowMs.label': '通知合并窗口（毫秒）',
      'notifyCoalesceWindowMs.hint': '同类通知在该窗口内合并；0 表示不合并。',
      'maxNotificationsPerMinute.label': '每分钟通知上限',
      'maxNotificationsPerMinute.hint': '正整数；留空使用默认值。',
    };
    var en = {
      'summary.generic': 'Configure the model and tool behaviour here; saved values apply to the next call.',
      'defaultLabel': 'Default',
      'modelsTitle': 'Available models',
      'refreshModels': 'Refresh models',
      'modelsLoading': 'Loading…',
      'modelLoadFailed': 'Model discovery failed:',
      'useModel': 'Use as default',
      'addToOrder': 'Add to order',
      'coreNote': 'The core row carries the shared model configuration and these Configure pages; the decision and monitor rows can be switched independently. With the core row off, both tools still run on built-in defaults, but these configuration pages disappear.',
      'unavailable': 'This row is not loaded, so it cannot be configured right now.',
      'readOnly': 'This deployment serves settings read-only.',
      'saveFailed': 'The deployment did not accept these values; the drafts were kept for you to correct.',
      'save': 'Save',
      'saving': 'Saving…',
      'overridden': 'Overridden',
      'reset': 'Reset to default',
      'invalidNumber': 'Enter a number, or leave it blank to use the default.',
      'invalidNumberFormat': 'This value is saved as the number it names, not as the text you typed.',
      'option.quick': 'Quick',
      'option.normal': 'Normal',
      'option.deep': 'Deep',
      'option.none': 'None',
      'option.any': 'Any',
      'baseUrl.label': 'Ollama endpoint',
      'baseUrl.hint': 'Path prefixes are preserved; blank uses the default address.',
      'defaultModel.label': 'Default decision model',
      'defaultModel.hint': 'Used when a tool row has no model override; e.g. tev1:0.8b, tev1:latest, clef-flash:latest, nimble:latest; run node scripts/list-models.mjs for installed models.',
      'timeoutMs.label': 'Request timeout (ms)',
      'timeoutMs.hint': 'Positive integer; blank uses the default.',
      'keepAlive.label': 'Model keep-alive',
      'keepAlive.hint': 'For example 30m or seconds; blank means keep_alive is not sent.',
      'apiKey.hint': 'Optional; sent as Authorization: Bearer to the model endpoint.',
      'modelsPath.hint': 'Model list path; Ollama uses /api/tags, OpenAI-compatible endpoints may use /v1/models.',
      'systemOnePath.hint': 'System One judgement path relative to baseUrl; default v1/systemone.',
      'modelOrder.hint': 'Comma-separated model priority; use model@numCtx to set context; unknown models use 8192.',
      'escalationEnabled.label': 'Allow overflow escalation',
      'escalationEnabled.hint': 'When off, only the selected model is tried; context overflow does not switch to a larger one.',
      'modelOverride.label': 'Model override (this row)',
      'modelOverride.hint': 'Choose a per-row model override here.',
      'defaultDepth.label': 'Default depth',
      'defaultDepth.hint': 'Used when the caller omits depth.',
      'bodyWarning.label': 'Body warnings',
      'bodyWarning.hint': 'When off, size and text-shape hints are not returned.',
      'softBodyBytes.label': 'Body warning threshold (bytes)',
      'softBodyBytes.hint': '0 warns on every call; blank uses the default.',
      'minConfidence.label': 'Confidence warning threshold',
      'minConfidence.hint': '0 disables the warning; blank uses the default.',
      'maxChoiceOptions.label': 'Maximum choice options',
      'maxChoiceOptions.hint': 'Maximum number of choice options.',
      'escalationMaxAttempts.label': 'Maximum escalation attempts',
      'escalationMaxAttempts.hint': 'Positive integer; blank uses the default.',
      'scanFirstChunkBytes.label': 'Scan first chunk (bytes)',
      'scanFirstChunkBytes.hint': 'Initial budget for deep internal chunking.',
      'scanMaxChunks.label': 'Maximum scan chunks',
      'scanMaxChunks.hint': 'Chunk count limit for deep internal chunking.',
      'scanMaxTotalBytes.label': 'Maximum scan bytes',
      'scanMaxTotalBytes.hint': 'Total bytes read by deep internal chunking.',
      'scanDeadlineMs.label': 'Scan wall-clock budget (ms)',
      'scanDeadlineMs.hint': 'Total time budget for deep internal chunking.',
      'scanAggregate.label': 'Scan aggregation',
      'scanAggregate.hint': 'How chunk answers are combined.',
      'minProbeIntervalMs.label': 'Minimum probe interval (ms)',
      'minProbeIntervalMs.hint': 'The intervalMs supplied by the model cannot go below this.',
      'notifyCoalesceWindowMs.label': 'Notice coalesce window (ms)',
      'notifyCoalesceWindowMs.hint': 'Same-kind notices are merged in this window; 0 disables merging.',
      'maxNotificationsPerMinute.label': 'Maximum notices per minute',
      'maxNotificationsPerMinute.hint': 'Positive integer; blank uses the default.',
    };

    function field(path, kind, options) {
      return { key: path.join('.'), path: path, kind: kind, options: options };
    }

    // 表单里空值并不等于“没有行为”：工具层有大量运行期默认值。这里显式给出每个字段的
    // 生效默认，既用于空值时的控件选中态，也用于字段下方的“默认：…”一行。
    var FIELD_DEFAULTS = {
      baseUrl: { value: 'http://localhost:11434', text: 'http://localhost:11434' },
      defaultModel: { value: 'tev1:0.8b', text: 'tev1:0.8b' },
      timeoutMs: { value: 120000, text: '120000 ms' },
      keepAlive: { text: '未设（服务端默认）' },
      apiKey: { text: '未设' },
      modelsPath: { value: '/api/tags', text: '/api/tags' },
      systemOnePath: { value: 'v1/systemone', text: 'v1/systemone' },
      modelOrder: { text: '默认 ladder 顺序' },
      escalationEnabled: { value: true, text: '开' },
      modelOverride: { text: '跟随核心行 defaultModel' },
      defaultDepth: { value: 'normal', text: 'normal' },
      bodyWarning: { value: true, text: '开' },
      softBodyBytes: { value: 4096, text: '4096 B' },
      minConfidence: { value: 0.25, text: '0.25' },
      maxChoiceOptions: { value: 255, text: '255' },
      escalationMaxAttempts: { value: 3, text: '3' },
      scanFirstChunkBytes: { value: 4096, text: '4096 B' },
      scanMaxChunks: { value: 32, text: '32' },
      scanMaxTotalBytes: { value: 4194304, text: '4194304（4 MiB）' },
      scanDeadlineMs: { value: 180000, text: '180000 ms' },
      scanAggregate: { value: 'none', text: 'none' },
      minProbeIntervalMs: { value: 1000, text: '1000 ms' },
      notifyCoalesceWindowMs: { value: 5000, text: '5000 ms' },
      maxNotificationsPerMinute: { value: 6, text: '6' },
    };
    function defaultOf(key) { return FIELD_DEFAULTS[key]; }
    function defaultTextOf(key) { var entry = FIELD_DEFAULTS[key]; return entry === undefined ? undefined : entry.text; }

    var ROWS = [
      {
        rowId: CORE_ROW_ID,
        summary: 'summary.generic',
        fields: [
          field(['baseUrl'], 'text'),
          field(['defaultModel'], 'text'),
          field(['apiKey'], 'text'),
          field(['modelsPath'], 'text'),
          field(['systemOnePath'], 'text'),
          field(['modelOrder'], 'text'),
          field(['timeoutMs'], 'number'),
          field(['keepAlive'], 'text'),
          field(['escalationEnabled'], 'boolean'),
        ],
      },
      {
        rowId: 'decision-tools-decision',
        summary: 'summary.generic',
        fields: [
          field(['modelOverride'], 'text'),
          field(['defaultDepth'], 'enum', ['quick', 'normal', 'deep']),
          field(['bodyWarning'], 'boolean'),
          field(['softBodyBytes'], 'number'),
          field(['minConfidence'], 'number'),
          field(['maxChoiceOptions'], 'number'),
          field(['escalationMaxAttempts'], 'number'),
          field(['scanFirstChunkBytes'], 'number'),
          field(['scanMaxChunks'], 'number'),
          field(['scanMaxTotalBytes'], 'number'),
          field(['scanDeadlineMs'], 'number'),
          field(['scanAggregate'], 'enum', ['none', 'any']),
        ],
      },
      {
        rowId: 'decision-tools-monitor',
        summary: 'summary.generic',
        fields: [
          field(['modelOverride'], 'text'),
          field(['minProbeIntervalMs'], 'number'),
          field(['notifyCoalesceWindowMs'], 'number'),
          field(['maxNotificationsPerMinute'], 'number'),
        ],
      },
    ];

    function rowKey(rowId) { return PACKAGE_NAME + '#' + rowId; }

    function at(layer, path) {
      var node = layer;
      for (var i = 0; i < path.length; i += 1) {
        if (node === null || typeof node !== 'object') return undefined;
        node = node[path[i]];
      }
      return node;
    }
    function has(layer, path) {
      var node = layer;
      for (var i = 0; i < path.length; i += 1) {
        if (node === null || typeof node !== 'object' || !Object.hasOwn(node, path[i])) return false;
        node = node[path[i]];
      }
      return true;
    }
    function coerce(kind, draft) {
      if (kind === 'number') {
        if (typeof draft === 'number') return Number.isFinite(draft) ? draft : undefined;
        var text = String(draft).trim();
        if (text.length === 0) return undefined;
        var value = Number(text);
        return Number.isFinite(value) ? value : undefined;
      }
      if (kind === 'boolean') return draft === true;
      return String(draft).trim();
    }
    function sameValue(kind, current, next) {
      if (kind === 'number') {
        var left = typeof current === 'number' ? current : Number(current);
        var right = Number(next);
        return Number.isFinite(left) && Number.isFinite(right) ? left === right : Object.is(current, next);
      }
      if (kind === 'boolean') return (current === true) === (next === true);
      return current === next;
    }
    function invalidReason(knob, text) {
      var trimmed = String(text).trim();
      if (trimmed.length === 0) return undefined;
      if (knob.kind !== 'number') return undefined;
      var number = Number(trimmed);
      if (!Number.isFinite(number)) return 'number';
      return String(number) === trimmed ? undefined : 'numberFormat';
    }
    function plannedOp(knob, entry, snapshot) {
      if (entry === undefined) return undefined;
      if (entry.op === 'unset') return has(snapshot.user, knob.path) ? { op: 'unset', path: knob.path } : undefined;
      var value = coerce(knob.kind, entry.draft);
      if (value === undefined) return undefined;
      if (sameValue(knob.kind, at(snapshot.value, knob.path), value)) return undefined;
      return { op: 'set', path: knob.path, value: value };
    }
    function planOps(fields, staged, snapshot) {
      var ops = [];
      for (var i = 0; i < fields.length; i += 1) {
        var op = plannedOp(fields[i], staged.get(fields[i].key), snapshot);
        if (op !== undefined) ops.push(op);
      }
      return ops;
    }
    function fallbackScope() {
      // 核心行的设置命名空间在部分部署里不会被服务；页面仍要出现，卡片内部显示 unavailable。
      var snapshot = { status: 'unavailable', writable: false, revision: 0, value: {}, base: {}, user: {} };
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function () { return function () {}; },
        mutate: function () { return Promise.resolve(false); },
      };
    }

    function storeOf(compute) {
      var snapshot = compute();
      var listeners = new Set();
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () { listeners.delete(listener); };
        },
        publish: function () {
          snapshot = compute();
          listeners.forEach(function (listener) { listener(); });
        },
      };
    }

    class RowConfigForm {
      constructor(scope, row) {
        this.scope = scope;
        this.row = row;
        this.staged = new Map();
        this.baseline = undefined;
        this.saving = false;
        this.failed = false;
        this.store = storeOf(this.project.bind(this));
        this.unsubscribe = scope.subscribe(this.store.publish);
      }
      project() {
        var self = this;
        var snapshot = this.scope.getSnapshot();
        var fields = this.row.fields.map(function (knob) {
          var staged = self.staged.get(knob.key);
          var stored = at(snapshot.value, knob.path);
          var inherited = at(snapshot.base, knob.path);
          var shown = staged === undefined ? stored : staged.op === 'unset' ? inherited : staged.draft;
          var fallback = defaultOf(knob.key);
          var effective = shown === undefined && fallback !== undefined ? fallback.value : shown;
          var text = shown === undefined || shown === null ? '' : String(shown);
          var op = plannedOp(knob, staged, snapshot);
          var reason = invalidReason(knob, text);
          return {
            key: knob.key,
            kind: knob.kind,
            path: knob.path,
            options: knob.options,
            text: text,
            value: effective,
            checked: effective === true,
            defaultText: defaultTextOf(knob.key),
            overridden: op === undefined ? has(snapshot.user, knob.path) : op.op === 'set',
            invalid: reason !== undefined,
            invalidReason: reason,
          };
        });
        var plan = planOps(this.row.fields, this.staged, snapshot);
        return {
          available: snapshot.status === 'ready',
          writable: snapshot.writable === true,
          dirty: plan.length > 0 || fields.some(function (entry) { return entry.invalid && entry.kind === 'number'; }),
          invalid: false,
          saving: this.saving,
          failed: this.failed,
          fields: fields,
        };
      }
      knobOf(key) {
        for (var i = 0; i < this.row.fields.length; i += 1) if (this.row.fields[i].key === key) return this.row.fields[i];
        return undefined;
      }
      stage(key, entry) {
        if (this.baseline === undefined) this.baseline = this.scope.getSnapshot();
        this.staged.set(key, entry);
        this.failed = false;
        this.store.publish();
      }
      edit(key, draft) {
        var knob = this.knobOf(key);
        if (knob === undefined) return;
        var empty = (knob.kind === 'text' || knob.kind === 'number') && String(draft).trim().length === 0;
        this.stage(key, empty ? { op: 'unset' } : { op: 'set', draft: draft });
      }
      resetField(key) {
        if (this.knobOf(key) === undefined) return;
        this.stage(key, { op: 'unset' });
      }
      discard() {
        this.staged.clear();
        this.baseline = undefined;
        this.failed = false;
        this.store.publish();
      }
      async save() {
        var snapshot = this.scope.getSnapshot();
        var ops = planOps(this.row.fields, this.staged, snapshot);
        // 非法数字没有可写的 op；不能静默“保存成功”却不发请求。
        var invalidNumber = this.project().fields.some(function (entry) { return entry.invalid && entry.kind === 'number'; });
        if (invalidNumber) {
          this.failed = true;
          this.store.publish();
          return;
        }
        if (snapshot.writable !== true || this.saving || ops.length === 0) return;
        this.saving = true;
        this.failed = false;
        this.store.publish();
        var accepted = false;
        try {
          accepted = await this.scope.mutate(ops, this.baseline === undefined ? undefined : this.baseline.revision);
        } catch (error) {
          accepted = false;
        }
        this.saving = false;
        if (accepted) {
          this.staged.clear();
          this.baseline = undefined;
        }
        this.failed = !accepted;
        this.store.publish();
      }
      inject() {
        var self = this;
        return {
          hooks: { rowForm: this.store },
          rowId: this.row.rowId,
          edit: function (key, draft) { self.edit(key, draft); },
          resetField: function (key) { self.resetField(key); },
          discard: function () { self.discard(); },
          save: function () { return self.save(); },
        };
      }
      dispose() { this.unsubscribe(); }
    }

    function textOf(props) {
      return typeof props?.t === 'function' ? props.t : function (key) { return en[key] ?? key; };
    }
    function leaf(key) { return key.split('.').pop(); }

    function fieldControl(knob, disabled, props, t) {
      var label = t(leaf(knob.key) + '.label');
      var hint = t(leaf(knob.key) + '.hint');
      var defaultLine = knob.defaultText
        ? h('p', { className: 'dshdt-hint dshdt-default' }, t('defaultLabel') + ': ' + knob.defaultText)
        : null;
      var invalidLabel = knob.invalid
        ? t(knob.invalidReason === 'numberFormat' ? 'invalidNumberFormat' : 'invalidNumber')
        : t('invalidNumber');
      if (knob.kind === 'text' || knob.kind === 'number') {
        return h('div', { key: knob.key, className: 'dshdt-field' },
          h(primitives.SettingsValueField, {
          id: knob.key,
          label: label,
          hint: hint,
          text: knob.text,
          invalid: knob.invalid,
          invalidLabel: invalidLabel,
          numeric: knob.kind === 'number',
          disabled: disabled,
          overridden: knob.overridden,
          overriddenLabel: t('overridden'),
          resetLabel: t('reset'),
          onEdit: function (text) { props.edit(knob.key, text); },
          onReset: function () { props.resetField(knob.key); },
          }),
          defaultLine,
        );
      }
      if (knob.kind === 'boolean') {
        return h('div', { key: knob.key, className: 'dshdt-field' },
          h(primitives.Checkbox, {
            id: knob.key,
            label: label,
            checked: knob.checked,
            disabled: disabled,
            onChange: function (next) { props.edit(knob.key, next); },
          }),
          h('p', { className: 'dshdt-hint' }, hint),
          defaultLine,
          knob.overridden ? h(primitives.Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: disabled, onClick: function () { props.resetField(knob.key); } }, t('reset')) : null,
        );
      }
      return h('div', { key: knob.key, className: 'dshdt-field' },
        h('p', { className: 'dshdt-label' }, label),
        h(primitives.SegmentedControl, {
          id: knob.key,
          value: String(knob.value ?? ''),
          label: label,
          disabled: disabled,
          options: (knob.options || []).map(function (option) { return { value: option, label: t('option.' + option) }; }),
          onChange: function (next) { props.edit(knob.key, next); },
        }),
        h('p', { className: 'dshdt-hint' }, hint),
        defaultLine,
        knob.overridden ? h(primitives.Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: disabled, onClick: function () { props.resetField(knob.key); } }, t('reset')) : null,
      );
    }

    function ModelPicker(props) {
      var useState = React.useState;
      var result = useState({ loading: false, models: [], error: '' });
      var view = result[0];
      var setView = result[1];
      var state = props.state;
      var field = function (key) { return state.fields.find(function (entry) { return entry.key === key; }); };
      var valueOf = function (key, fallback) {
        var entry = field(key);
        if (entry === undefined) return fallback;
        if (entry.text !== undefined && entry.text !== '') return entry.text;
        return entry.value === undefined ? fallback : entry.value;
      };
      var refresh = function () {
        // 同源宿主端点：浏览器直连 Ollama 没有 CORS 头（本机实测 /api/tags 不带
        // Access-Control-Allow-Origin），所以由核心行在 host 侧代查；查询前先保存
        // baseUrl/modelsPath/apiKey，宿主只读已保存的共享配置。
        setView({ loading: true, models: [], error: '' });
        fetch('/decision-tools-models', { headers: { accept: 'application/json' } })
          .then(function (response) {
            return response.json().then(function (payload) {
              if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
              return payload;
            });
          })
          .then(function (payload) {
            var names = payload && Array.isArray(payload.models) ? payload.models : [];
            setView({ loading: false, models: names.filter(function (name) { return typeof name === 'string' && name !== ''; }), error: '' });
          })
          .catch(function (error) {
            setView({ loading: false, models: [], error: String(error && error.message ? error.message : error) });
          });
      };
      var appendOrder = function (name) {
        var entry = field('modelOrder');
        var current = entry === undefined ? '' : entry.text;
        var names = current.split(/[,\s]+/).filter(function (item) { return item !== ''; });
        if (names.indexOf(name) < 0) names.push(name);
        props.edit('modelOrder', names.join(', '));
      };
      var items = view.models.slice(0, 30).map(function (name) {
        return h('div', { key: name, className: 'dshdt-model-item' },
          h('code', null, name),
          h(primitives.Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: props.disabled, onClick: function () { props.edit('defaultModel', name); } }, props.t('useModel')),
          h(primitives.Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: props.disabled, onClick: function () { appendOrder(name); } }, props.t('addToOrder')),
        );
      });
      return h('div', { className: 'dshdt-model-picker' },
        h('p', { className: 'dshdt-label' }, props.t('modelsTitle')),
        h(primitives.Button, { type: 'button', variant: 'secondary', size: 'sm', disabled: props.disabled || view.loading, onClick: refresh }, view.loading ? props.t('modelsLoading') : props.t('refreshModels')),
        view.error === '' ? null : h('p', { className: 'dshdt-hint' }, props.t('modelLoadFailed') + ' ' + view.error),
        view.models.length === 0 ? null : h('div', { className: 'dshdt-model-list' }, items),
      );
    }

    function RowConfigCard(props) {
      var t = textOf(props);
      if (typeof props?.useRowForm !== 'function') return h('p', { className: 'dshdt-hint' }, t('summary.generic'));
      var state = props.useRowForm(function (snapshot) { return snapshot; });
      if (props.view === 'summary') return t('summary.generic');
      var disabled = state.writable !== true;
      return h(primitives.SettingsForm, {
        labels: {
          unavailable: t('unavailable'),
          readOnly: t('readOnly'),
          saveFailed: t('saveFailed'),
          save: t('save'),
          saving: t('saving'),
        },
        state: state,
        onSave: props.save,
        onDiscard: props.discard,
      }, state.fields.map(function (knob) { return fieldControl(knob, disabled, props, t); }).concat(
        props.rowId === CORE_ROW_ID
          ? [h(ModelPicker, { key: 'model-picker', state: state, edit: props.edit, disabled: disabled, t: t })]
          : [],
      ));
    }

    function CoreNote(props) {
      var t = textOf(props);
      var subject = props?.subject;
      if (subject === null || typeof subject !== 'object') return null;
      if (subject.kind === 'bundle') {
        if (subject.pkg?.name !== PACKAGE_NAME) return null;
      } else if (subject.kind === 'row') {
        if (subject.pkg?.name !== PACKAGE_NAME || subject.row?.rowId !== CORE_ROW_ID) return null;
      } else {
        return null;
      }
      return h('section', { className: 'dshdt-note' }, h('p', { className: 'dshdt-hint' }, t('coreNote')));
    }

    var CSS = [
      '.dshdt-field{margin:0 0 14px}',
      '.dshdt-label{margin:0 0 6px;font-size:13px;font-weight:500}',
      '.dshdt-hint{margin:6px 0 0;font-size:12px;opacity:.65;line-height:1.5}',
      '.dshdt-note{margin:14px 0 0}',
      '.dshdt-segmented{display:flex;gap:6px;flex-wrap:wrap}',
      '.dshdt-model-picker{margin:16px 0 0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l3)}',
      '.dshdt-model-list{display:flex;flex-direction:column;gap:4px;margin-top:8px;max-height:220px;overflow:auto}',
      '.dshdt-model-item{display:flex;align-items:center;gap:8px}',
    ].join('');
    var STYLE_ID = PACKAGE_NAME + '/client.js';

    function installStyles() {
      if (typeof document === 'undefined' || document.head === undefined || document.head === null) return function () {};
      if (document.querySelector('style[data-plugin="' + PACKAGE_NAME + '"]') !== null) return function () {};
      var tag = document.createElement('style');
      tag.dataset.plugin = PACKAGE_NAME;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    function apply(ctx) {
      var safely = function (what, run) {
        try { run(); } catch (error) {
          try { ctx?.logger?.warn?.('dsh-decision-tools: ' + what + ' failed: ' + (error?.message ?? error)); } catch (ignored) { /* noop */ }
        }
      };
      if (degradedPrimitives.length > 0) {
        safely('primitives', function () {
          ctx?.logger?.warn?.('dsh-decision-tools: using HTML fallback for missing primitives: ' + degradedPrimitives.join(', '));
        });
      }
      safely('dictionaries', function () {
        var register = function () { return ctx.locale.register(NS, { zh: zh, en: en }); };
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-decision-tools: dictionaries');
        else register();
      });
      safely('stylesheet', function () {
        if (typeof ctx.effect === 'function') ctx.effect(installStyles, 'dsh-decision-tools: stylesheet');
        else installStyles();
      });
      ROWS.filter(function (row) { return row.rowId !== CORE_ROW_ID; }).forEach(function (row) {
        safely(row.rowId + ' page', function () {
          var scope;
          try { scope = ctx.configForms.get(row.rowId); } catch (error) { scope = undefined; }
          var form = new RowConfigForm(scope === undefined || scope === null ? fallbackScope() : scope, row);
          if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { form.dispose(); }; }, 'dsh-decision-tools: ' + row.rowId + ' form');
          // 没有 effect 能力时不要把 form 立刻 dispose：先注册、让它活到页面生命周期。
          var register = function () {
            return ctx.configForms.whileServed([row.rowId], function () {
              return ctx.slots.inject('plugins.row.config', function () {
                return ctx.slots.register({
                  name: 'plugins.row.config',
                  key: rowKey(row.rowId),
                  locale: NS,
                  inject: function () { return form.inject(); },
                }, RowConfigCard);
              });
            });
          };
          if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-decision-tools: ' + row.rowId + ' page');
          else register();
        });
      });
      safely('core bundle config', function () {
        var coreRow = ROWS.find(function (row) { return row.rowId === CORE_ROW_ID; });
        var scope;
        try { scope = ctx.configForms.get(CORE_ROW_ID); } catch (error) { scope = undefined; }
        var form = new RowConfigForm(scope === undefined || scope === null ? fallbackScope() : scope, coreRow);
        if (typeof ctx.effect === 'function') ctx.effect(function () { return function () { form.dispose(); }; }, 'dsh-decision-tools: core form');
        // 核心行不像工具行那样由 row 槽渲染；多部署实测核心行设置命名空间不会被服务，
        // 所以像首方 shell 卡片一样，无条件挂到 bundle 卡片上（两个 key 都挂，兼容两种实现）。
        [CORE_ROW_ID, PACKAGE_NAME].forEach(function (key) {
          var register = function () {
            return ctx.slots.inject('plugins.bundle.config', function () {
              return ctx.slots.register({
                name: 'plugins.bundle.config',
                key: key,
                locale: NS,
                inject: function () { return form.inject(); },
              }, RowConfigCard);
            });
          };
          if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-decision-tools: core bundle config ' + key);
          else register();
        });
      });
      safely('core note', function () {
        var register = function () {
          return ctx.slots.inject('plugins.detail.section', function () {
            return ctx.slots.register({
              name: 'plugins.detail.section',
              id: PACKAGE_NAME + ':core',
              order: 100,
              locale: NS,
            }, CoreNote);
          });
        };
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-decision-tools: core note');
        else register();
      });
    }

    exports.NS = NS;
    exports.apply = function (ctx) {
      try { apply(ctx); } catch (error) {
        try { ctx?.logger?.warn?.('dsh-decision-tools: client apply failed: ' + (error?.message ?? error)); } catch (ignored) { /* noop */ }
      }
    };
    exports.inject = ['slots', 'locale', 'configForms'];
    exports.__internals = { NS: NS, PACKAGE_NAME: PACKAGE_NAME, CORE_ROW_ID: CORE_ROW_ID, ROWS: ROWS, FIELD_DEFAULTS: FIELD_DEFAULTS, rowKey: rowKey, RowConfigForm: RowConfigForm, planOps: planOps, zh: zh, en: en, installStyles: installStyles };
    return module.exports;
  },
});

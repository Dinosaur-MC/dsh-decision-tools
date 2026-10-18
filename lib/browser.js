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
      // 缺依赖时**不注册任何贡献**：spec §6.7 要求安静降级，不能拿 stub 顶替首方控件
      // （stub 在缺单个导出时会渲染出 Element type is invalid，直接炸整棵面板）。
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
    var primitives;
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (error) { primitives = undefined; }
    var REQUIRED_PRIMITIVES = ['SettingsForm', 'SettingsValueField', 'Checkbox', 'Button', 'SegmentedControl'];
    var missingPrimitives = primitives === undefined || primitives === null
      ? REQUIRED_PRIMITIVES.slice()
      : REQUIRED_PRIMITIVES.filter(function (name) { return typeof primitives[name] !== 'function'; });
    if (missingPrimitives.length > 0) {
      return unavailable('primitives missing: ' + missingPrimitives.join(', '));
    }

    var NS = 'settings.decision-tools';
    var PACKAGE_NAME = 'dsh-decision-tools';
    var CORE_ROW_ID = 'decision-tools-plugin';

    var zh = {
      'summary.generic': '在这里配置模型与工具行为；保存后下一次调用生效。',
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
      'baseUrl.hint': '保留路径前缀；留空使用 http://localhost:11434。',
      'defaultModel.label': '默认 decision 模型',
      'defaultModel.hint': '工具行未设模型覆盖时使用；例如 tev1:0.8b、tev1:latest、clef-flash:latest、nimble:latest；用 node scripts/list-models.mjs 查本机已装模型。',
      'timeoutMs.label': '请求超时（毫秒）',
      'timeoutMs.hint': '正整数；留空使用默认 120000。',
      'keepAlive.label': '模型驻留时间',
      'keepAlive.hint': '如 30m 或秒数；留空表示不下发 keep_alive。',
      'escalationEnabled.label': '允许容量溢出升档',
      'escalationEnabled.hint': '关闭后只尝试选中的档，不再因上下文溢出换更大模型。',
      'modelOverride.label': '模型覆盖（本行）',
      'modelOverride.hint': '留空使用核心行的默认模型。',
      'defaultDepth.label': '默认深度',
      'defaultDepth.hint': '调用方省略 depth 时使用。',
      'bodyWarning.label': '体积告警',
      'bodyWarning.hint': '关闭后不再返回体积/文本形状提示。',
      'softBodyBytes.label': '体积告警阈值（字节）',
      'softBodyBytes.hint': '0 表示每次都告警；留空使用默认值。',
      'minConfidence.label': '置信度告警阈值',
      'minConfidence.hint': '0 表示关闭；留空使用默认值。',
      'maxChoiceOptions.label': 'choice 选项上限',
      'maxChoiceOptions.hint': '留空使用默认 255。',
      'escalationMaxAttempts.label': '升档尝试上限',
      'escalationMaxAttempts.hint': '正整数；留空使用默认 3。',
      'scanFirstChunkBytes.label': '扫描首块字节',
      'scanFirstChunkBytes.hint': 'deep 内部分块的首块预算。',
      'scanMaxChunks.label': '扫描最大块数',
      'scanMaxChunks.hint': 'deep 内部分块的块数上限。',
      'scanMaxTotalBytes.label': '扫描总量上限（字节）',
      'scanMaxTotalBytes.hint': 'deep 内部分块读取的总量上限。',
      'scanDeadlineMs.label': '扫描墙钟预算（毫秒）',
      'scanDeadlineMs.hint': 'deep 内部分块的总时间预算。',
      'scanAggregate.label': '扫描聚合',
      'scanAggregate.hint': '分块答案的合并策略；暂定产物，默认不聚合。',
      'minProbeIntervalMs.label': '探测间隔下限（毫秒）',
      'minProbeIntervalMs.hint': '模型给的 intervalMs 不得低于此值。',
      'notifyCoalesceWindowMs.label': '通知合并窗口（毫秒）',
      'notifyCoalesceWindowMs.hint': '同类通知在该窗口内合并；0 表示不合并。',
      'maxNotificationsPerMinute.label': '每分钟通知上限',
      'maxNotificationsPerMinute.hint': '正整数；留空使用默认值。',
    };
    var en = {
      'summary.generic': 'Configure the model and tool behaviour here; saved values apply to the next call.',
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
      'baseUrl.hint': 'Path prefixes are preserved; blank uses http://localhost:11434.',
      'defaultModel.label': 'Default decision model',
      'defaultModel.hint': 'Used when a tool row has no model override; e.g. tev1:0.8b, tev1:latest, clef-flash:latest, nimble:latest; run node scripts/list-models.mjs for installed models.',
      'timeoutMs.label': 'Request timeout (ms)',
      'timeoutMs.hint': 'Positive integer; blank uses 120000.',
      'keepAlive.label': 'Model keep-alive',
      'keepAlive.hint': 'For example 30m or seconds; blank means keep_alive is not sent.',
      'escalationEnabled.label': 'Allow overflow escalation',
      'escalationEnabled.hint': 'When off, only the selected model is tried; context overflow does not switch to a larger one.',
      'modelOverride.label': 'Model override (this row)',
      'modelOverride.hint': 'Blank uses the core row default model.',
      'defaultDepth.label': 'Default depth',
      'defaultDepth.hint': 'Used when the caller omits depth.',
      'bodyWarning.label': 'Body warnings',
      'bodyWarning.hint': 'When off, size and text-shape hints are not returned.',
      'softBodyBytes.label': 'Body warning threshold (bytes)',
      'softBodyBytes.hint': '0 warns on every call; blank uses the default.',
      'minConfidence.label': 'Confidence warning threshold',
      'minConfidence.hint': '0 disables the warning; blank uses the default.',
      'maxChoiceOptions.label': 'Maximum choice options',
      'maxChoiceOptions.hint': 'Blank uses the default 255.',
      'escalationMaxAttempts.label': 'Maximum escalation attempts',
      'escalationMaxAttempts.hint': 'Positive integer; blank uses the default 3.',
      'scanFirstChunkBytes.label': 'Scan first chunk (bytes)',
      'scanFirstChunkBytes.hint': 'Initial budget for deep internal chunking.',
      'scanMaxChunks.label': 'Maximum scan chunks',
      'scanMaxChunks.hint': 'Chunk count limit for deep internal chunking.',
      'scanMaxTotalBytes.label': 'Maximum scan bytes',
      'scanMaxTotalBytes.hint': 'Total bytes read by deep internal chunking.',
      'scanDeadlineMs.label': 'Scan wall-clock budget (ms)',
      'scanDeadlineMs.hint': 'Total time budget for deep internal chunking.',
      'scanAggregate.label': 'Scan aggregation',
      'scanAggregate.hint': 'How chunk answers are combined; provisional, default none.',
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

    var ROWS = [
      {
        rowId: CORE_ROW_ID,
        summary: 'summary.generic',
        fields: [
          field(['baseUrl'], 'text'),
          field(['defaultModel'], 'text'),
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
          var text = shown === undefined || shown === null ? '' : String(shown);
          var op = plannedOp(knob, staged, snapshot);
          var reason = invalidReason(knob, text);
          return {
            key: knob.key,
            kind: knob.kind,
            path: knob.path,
            options: knob.options,
            text: text,
            value: shown,
            checked: shown === true,
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
      var invalidLabel = knob.invalid
        ? t(knob.invalidReason === 'numberFormat' ? 'invalidNumberFormat' : 'invalidNumber')
        : t('invalidNumber');
      if (knob.kind === 'text' || knob.kind === 'number') {
        return h(primitives.SettingsValueField, {
          key: knob.key,
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
        });
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
        knob.overridden ? h(primitives.Button, { variant: 'ghost', size: 'sm', type: 'button', disabled: disabled, onClick: function () { props.resetField(knob.key); } }, t('reset')) : null,
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
      }, state.fields.map(function (knob) { return fieldControl(knob, disabled, props, t); }));
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
      safely('dictionaries', function () {
        var register = function () { return ctx.locale.register(NS, { zh: zh, en: en }); };
        if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-decision-tools: dictionaries');
        else register();
      });
      safely('stylesheet', function () {
        if (typeof ctx.effect === 'function') ctx.effect(installStyles, 'dsh-decision-tools: stylesheet');
        else installStyles();
      });
      ROWS.forEach(function (row) {
        safely(row.rowId + ' page', function () {
          var form = new RowConfigForm(ctx.configForms.get(row.rowId), row);
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
    exports.__internals = { NS: NS, PACKAGE_NAME: PACKAGE_NAME, CORE_ROW_ID: CORE_ROW_ID, ROWS: ROWS, rowKey: rowKey, RowConfigForm: RowConfigForm, planOps: planOps, zh: zh, en: en, installStyles: installStyles };
    return module.exports;
  },
});

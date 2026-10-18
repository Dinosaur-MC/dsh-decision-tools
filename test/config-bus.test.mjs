import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publishSharedConfig, clearSharedConfig, readSharedConfig, live, SHARED_DEFAULTS,
} from '../lib/config-bus.js';
import { resolveDecisionConfig, resolveMonitorConfig } from '../lib/tool.js';

test('共享总线：未发布时回落内置默认；发布后可读普通值与活句柄', () => {
  clearSharedConfig();
  const defaults = readSharedConfig();
  assert.equal(defaults.baseUrl, SHARED_DEFAULTS.baseUrl);
  assert.equal(defaults.defaultModel, SHARED_DEFAULTS.defaultModel);
  assert.equal(defaults.timeoutMs, SHARED_DEFAULTS.timeoutMs);
  assert.equal(defaults.toolName, 'decision');
  assert.equal(defaults.monitorToolName, 'monitor');

  let model = 'm-one';
  publishSharedConfig({ defaultModel: { get: () => model }, timeoutMs: 5000 });
  assert.equal(readSharedConfig().defaultModel, 'm-one');
  assert.equal(readSharedConfig().timeoutMs, 5000);
  model = 'm-two';
  assert.equal(readSharedConfig().defaultModel, 'm-two', '每次读取都必须重新解析活句柄');

  clearSharedConfig();
  assert.equal(readSharedConfig().defaultModel, SHARED_DEFAULTS.defaultModel);
});

test('live() 解析 cosmokit 活句柄；undefined 回落', () => {
  assert.equal(live({ get: () => 42 }, 0), 42);
  assert.equal(live(undefined, 'fallback'), 'fallback');
  assert.equal(live(null, 'fallback'), null);
});

test('decision 解析器：共享值每读现取，工具行可覆盖模型与行为', () => {
  clearSharedConfig();
  let sharedModel = 'shared-a';
  let rowModel = '';
  publishSharedConfig({
    defaultModel: { get: () => sharedModel },
    baseUrl: 'http://example.test',
    timeoutMs: 9000,
  });
  const row = {
    modelOverride: { get: () => rowModel },
    defaultDepth: { get: () => 'deep' },
    softBodyBytes: { get: () => 0 },
    minConfidence: { get: () => 0 },
    maxChoiceOptions: { get: () => 7 },
    escalationMaxAttempts: { get: () => 2 },
    scanMaxChunks: { get: () => 4 },
  };
  let cfg = resolveDecisionConfig(row);
  assert.equal(cfg.defaultModel, 'shared-a');
  assert.equal(cfg.baseUrl, 'http://example.test');
  assert.equal(cfg.timeoutMs, 9000);
  assert.equal(cfg.defaultDepth, 'deep');
  assert.equal(cfg.softBodyBytes, 0);
  assert.equal(cfg.minConfidence, 0);
  assert.equal(cfg.maxChoiceOptions, 7);
  assert.equal(cfg.escalationMaxAttempts, 2);
  assert.equal(cfg.scan.maxChunks, 4);

  sharedModel = 'shared-b';
  assert.equal(resolveDecisionConfig(row).defaultModel, 'shared-b');
  rowModel = 'pinned';
  assert.equal(resolveDecisionConfig(row).defaultModel, 'pinned', '工具行覆盖优先于共享默认');
  clearSharedConfig();
});

test('monitor 解析器：共享连接 + 本行探测/通知默认值', () => {
  clearSharedConfig();
  publishSharedConfig({ baseUrl: 'http://m.test', defaultModel: 'shared-m', timeoutMs: 1234 });
  let floor = 1000;
  const row = {
    minProbeIntervalMs: { get: () => floor },
    notifyCoalesceWindowMs: { get: () => 0 },
    maxNotificationsPerMinute: { get: () => 9 },
  };
  let cfg = resolveMonitorConfig(row);
  assert.equal(cfg.baseUrl, 'http://m.test');
  assert.equal(cfg.defaultModel, 'shared-m');
  assert.equal(cfg.timeoutMs, 1234);
  assert.equal(cfg.minProbeIntervalMs, 1000);
  assert.equal(cfg.notifyCoalesceWindowMs, 0);
  assert.equal(cfg.maxNotificationsPerMinute, 9);
  floor = 2000;
  assert.equal(resolveMonitorConfig(row).minProbeIntervalMs, 2000);
  clearSharedConfig();
});

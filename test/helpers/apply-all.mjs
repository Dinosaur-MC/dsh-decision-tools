/**
 * 测试组合器：把一份混合配置拆到核心/decision/monitor 三条行并依次 apply。
 *
 * 这是**测试侧的组合**，不是生产兼容层：生产入口只有 core / decision / monitor 三个
 * 独立行，各自持有自己的 Config。这里让既有用例继续用「一次 apply 注册两个工具」的
 * 写法跑完整注册路径。
 */
import { SharedConfig, DecisionConfig, MonitorConfig } from '../../lib/configs.js';
import { publishSharedConfig, live } from '../../lib/config-bus.js';
import { applyDecision, applyMonitor } from '../../lib/tool.js';

const SHARED_KEYS = ['baseUrl', 'defaultModel', 'timeoutMs', 'keepAlive', 'escalationEnabled', 'ladder', 'toolName', 'monitorToolName', 'spillDirCap'];
const DECISION_KEYS = ['modelOverride', 'defaultDepth', 'bodyWarning', 'softBodyBytes', 'minConfidence', 'maxChoiceOptions', 'escalationMaxAttempts', 'scanFirstChunkBytes', 'scanMaxChunks', 'scanMaxTotalBytes', 'scanDeadlineMs', 'scanAggregate'];
const MONITOR_KEYS = ['modelOverride', 'minProbeIntervalMs', 'notifyCoalesceWindowMs', 'maxNotificationsPerMinute'];

function pick(input, keys) {
  const out = {};
  for (const key of keys) if (Object.hasOwn(input, key)) out[key] = input[key];
  return out;
}

function flatten(value) {
  const out = {};
  for (const [key, entry] of Object.entries(value ?? {})) out[key] = live(entry);
  return out;
}

/** 兼容旧用例的 Config：按三行 schema 校验/填默认，再把活句柄摊平成普通值。 */
export function Config(input = {}) {
  const shared = flatten(SharedConfig(pick(input, SHARED_KEYS)));
  const decision = flatten(DecisionConfig(pick(input, DECISION_KEYS)));
  const monitor = flatten(MonitorConfig(pick(input, MONITOR_KEYS)));
  return { ...shared, ...decision, ...monitor };
}

/** 一次注册 decision + monitor（测试组合，不是生产入口）。 */
export function applyAll(ctx, config = {}, internals = {}) {
  const resolved = config && Object.keys(config).length > 0 ? config : Config(config);
  const shared = pick(resolved, SHARED_KEYS);
  publishSharedConfig({
    ...shared,
    toolName: shared.toolName ?? 'decision',
    monitorToolName: shared.monitorToolName ?? 'monitor',
  });
  applyDecision(ctx, pick(resolved, DECISION_KEYS), internals);
  applyMonitor(ctx, pick(resolved, MONITOR_KEYS), internals);
}

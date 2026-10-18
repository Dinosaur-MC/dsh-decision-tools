/**
 * 共享运行时配置总线：核心行发布活句柄，工具行每次执行时解析。
 *
 * 为什么需要它：DSH 的设置命名空间是「行 id」，两个工具行不能直接读核心行的 Config。
 * 同一包的所有行共享同一 ESM 模块实例，因此核心行把 baseUrl/defaultModel/timeoutMs/
 * keepAlive/escalationEnabled/ladder/toolName/monitorToolName/spillDirCap 发布到这里，
 * 工具行在每次 execute / 每次 monitor 判定时调用 readSharedConfig() 现取。
 *
 * 核心行未加载或已卸载时返回 SHARED_DEFAULTS，工具仍可用。
 * @module dsh-decision-tools/config-bus
 */
import { DEFAULT_LADDER } from './escalate.js';
import { DEFAULT_SPILL_MAX_BYTES } from './pipe.js';

/** 内置默认值。数值默认的唯一来源仍是 escalate/pipe 里的常量。 */
export const SHARED_DEFAULTS = Object.freeze({
  baseUrl: 'http://localhost:11434',
  defaultModel: 'tev1:0.8b',
  timeoutMs: 120000,
  keepAlive: undefined,
  escalationEnabled: true,
  ladder: DEFAULT_LADDER,
  toolName: 'decision',
  monitorToolName: 'monitor',
  spillDirCap: DEFAULT_SPILL_MAX_BYTES,
});

/** 当前核心行发布的句柄；null 表示核心行未加载。 */
let published = null;

/**
 * 发布核心行的配置引用。值可以是普通值，也可以是 .volatile() 活句柄。
 * @param {object} next
 */
export function publishSharedConfig(next = {}) {
  published = { ...next };
}

/** 核心行卸载时复位，避免陈旧值继续生效。 */
export function clearSharedConfig() {
  published = null;
}

/**
 * 解析一个可能是 cosmokit 活句柄的值。
 * @param {unknown} value
 * @param {unknown} fallback
 * @returns {unknown}
 */
export function live(value, fallback) {
  const raw = typeof value?.get === 'function' ? value.get() : value;
  return raw === undefined ? fallback : raw;
}

/** 正整数回落（NaN/null/0/负数一律回落）。 */
export function positiveInteger(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

/**
 * 现取共享配置。每次调用都解析活句柄，绝不缓存快照。
 * @returns {typeof SHARED_DEFAULTS}
 */
export function readSharedConfig() {
  const h = published === null ? {} : published;
  return {
    baseUrl: nonEmptyString(live(h.baseUrl, SHARED_DEFAULTS.baseUrl), SHARED_DEFAULTS.baseUrl),
    defaultModel: nonEmptyString(live(h.defaultModel, SHARED_DEFAULTS.defaultModel), SHARED_DEFAULTS.defaultModel),
    timeoutMs: positiveInteger(live(h.timeoutMs, SHARED_DEFAULTS.timeoutMs), SHARED_DEFAULTS.timeoutMs),
    keepAlive: live(h.keepAlive, undefined),
    escalationEnabled: live(h.escalationEnabled, true) !== false,
    ladder: Array.isArray(live(h.ladder, SHARED_DEFAULTS.ladder)) && live(h.ladder, SHARED_DEFAULTS.ladder).length > 0
      ? live(h.ladder, SHARED_DEFAULTS.ladder)
      : SHARED_DEFAULTS.ladder,
    toolName: nonEmptyString(live(h.toolName, SHARED_DEFAULTS.toolName), SHARED_DEFAULTS.toolName),
    monitorToolName: nonEmptyString(live(h.monitorToolName, SHARED_DEFAULTS.monitorToolName), SHARED_DEFAULTS.monitorToolName),
    spillDirCap: positiveInteger(live(h.spillDirCap, SHARED_DEFAULTS.spillDirCap), SHARED_DEFAULTS.spillDirCap),
  };
}

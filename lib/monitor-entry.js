/**
 * monitor 行入口：只注册 monitor 工具。
 * 模型连接/默认模型来自核心行的共享总线；本行只持有探测/通知默认值与 modelOverride。
 * @module dsh-decision-tools/monitor
 */
import { MonitorConfig } from './configs.js';
import { applyMonitor } from './tool.js';

export const name = 'decision-tools-monitor';
export const inject = ['tools', 'fs', 'jobs', 'agents'];
export const Config = MonitorConfig;

export function apply(ctx, config = {}) {
  applyMonitor(ctx, config);
}

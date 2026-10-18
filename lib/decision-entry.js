/**
 * decision 行入口：只注册 decision 工具。
 * 模型连接/默认模型来自核心行的共享总线；本行只持有判定行为与 modelOverride。
 * @module dsh-decision-tools/decision
 */
import { DecisionConfig } from './configs.js';
import { applyDecision } from './tool.js';

export const name = 'decision-tools-decision';
export const inject = ['tools', 'fs', 'skills'];
export const Config = DecisionConfig;

export function apply(ctx, config = {}) {
  applyDecision(ctx, config);
}

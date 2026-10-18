/**
 * 包入口：核心行。
 *
 * 核心行不注册模型工具；它只做两件事：
 * 1. 把共享模型/运行时配置（活句柄）发布到 lib/config-bus.js，供两个工具行每次执行时读取；
 * 2. 作为裸包名行，让 Web 客户端发现 package.json 的 dsh.client 与 ./client 浏览器半。
 *
 * 工具行分别由 ./decision 与 ./monitor 入口注册，行开关互相独立。
 * @module dsh-decision-tools
 */
import { SharedConfig } from './configs.js';
import { publishSharedConfig, clearSharedConfig, live } from './config-bus.js';

/** 核心行身份名。 */
export const name = 'decision-tools';

/** 核心行不需要宿主服务；它只发布配置引用。 */
export const inject = [];

export const Config = SharedConfig;

/**
 * 发布共享配置。值可以是 .volatile() 活句柄，工具行每次读取时解析。
 * @param {any} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  publishSharedConfig({
    baseUrl: config.baseUrl,
    defaultModel: config.defaultModel,
    timeoutMs: config.timeoutMs,
    keepAlive: config.keepAlive,
    escalationEnabled: config.escalationEnabled,
    ladder: config.ladder,
    toolName: live(config.toolName, 'decision'),
    monitorToolName: live(config.monitorToolName, 'monitor'),
    spillDirCap: live(config.spillDirCap, undefined),
  });
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => clearSharedConfig());
  }
}

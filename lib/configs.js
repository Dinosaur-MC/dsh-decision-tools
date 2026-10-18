/**
 * 三条行的 Config schema。GUI 可改的字段一律 .volatile()，否则 dsh-settings 不会服务它们。
 *
 * - SharedConfig：核心行，模型连接、默认模型、超时、keepAlive、升档开关、阶梯、工具名、转储上限。
 * - DecisionConfig：decision 行，模型覆盖 + 判定行为 + 扫描边界。
 * - MonitorConfig：monitor 行，模型覆盖 + 探测/通知默认值。
 *
 * @module dsh-decision-tools/configs
 */
import z from '@deepseek-ai/schemastery';

/** 核心行：共享模型/运行时配置。 */
export const SharedConfig = z.object({
  baseUrl: z.string().default('http://localhost:11434').volatile(),
  defaultModel: z.string().default('tev1:0.8b').volatile(),
  timeoutMs: z.number().default(120000).min(1).volatile(),
  keepAlive: z.union([z.string(), z.number()]).required(false).volatile(),
  escalationEnabled: z.boolean().default(true).volatile(),
  // 数组编辑器不进第一版表单；核心行重载后工具行按每次执行读取。
  ladder: z.array(z.object({ model: z.string(), numCtx: z.number().min(1) })).required(false),
  // 注册期值：改后重载核心行；工具行从共享总线读取。
  toolName: z.string().default('decision'),
  monitorToolName: z.string().default('monitor'),
  // 上游委托转储的总量上限（字节）；非 GUI 项，YAML 高级口。
  spillDirCap: z.number().min(1).required(false),
});

/** decision 行：模型覆盖 + 判定行为。 */
export const DecisionConfig = z.object({
  modelOverride: z.string().required(false).volatile(),
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

/** monitor 行：模型覆盖 + 探测/通知默认值。 */
export const MonitorConfig = z.object({
  modelOverride: z.string().required(false).volatile(),
  minProbeIntervalMs: z.number().min(1).required(false).volatile(),
  notifyCoalesceWindowMs: z.number().min(0).required(false).volatile(),
  maxNotificationsPerMinute: z.number().min(1).required(false).volatile(),
});

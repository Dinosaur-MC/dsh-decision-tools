/**
 * decision 工具的装配：把纯逻辑模块接到 DSH 的 tools 服务上。
 * 本文件是唯一接触 `ctx` 的地方。
 * @module dsh-decision-tools/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { PARAMETERS, TOOL_DESCRIPTION } from './parameters.js';
import { prepareRequest, LIMITS } from './validate.js';
import { renderAnswers } from './render.js';
import { callSystemOne } from './client.js';

/**
 * 插件身份名。
 * 注意：这**不是**模型看到的工具名 —— 工具名取自配置 `toolName`（默认 `decision`）。
 */
export const name = 'decision-tools';

/** 只需要 tools：使用指引全部在工具 description 里，不注册 prompt 段（ADR-5）。 */
export const inject = ['tools'];

export const Config = z.object({
  baseUrl: z.string().default('http://localhost:11434'),
  defaultModel: z.string().default('tev1:0.8b'),
  timeoutMs: z.number().default(120000),
  toolName: z.string().default('decision'),
  // 可以是 "5m" 这类时长串或秒数；未设则不下发该字段，用服务端默认。
  keepAlive: z.union([z.string(), z.number()]).required(false),
  // 体积告警阈值（字节）。**刻意不设默认值** —— 未设时回落到 LIMITS.softBodyBytes，
  // 让那个常量的实测依据保持单一来源（不得把 4096 复制到这里）。
  softBodyBytes: z.number().required(false),
  // 体积告警开关。**刻意不设默认值** —— 未设或 true 都表示启用，只有显式 false 才关闭；
  // 关闭时返回里**连 body_warning 这个键都不出现**（不写 false、不写空串）。
  bodyWarning: z.boolean().required(false),
});

/**
 * 解析生效的体积告警阈值（字节）。默认值的**唯一来源是 `LIMITS.softBodyBytes`** ——
 * 这里不复制那个数字，改常量即改默认。
 *
 * **钳制**：配置值高于硬上限 `LIMITS.maxBodyBytes` 时**静默**取上限（请求照常成功，
 * 不报错、不改拒绝行为）。它把生效值界定在插件**确知**的字节上限内 —— 插件无从得知模型
 * 真实的 `num_ctx`（它也不是架构声明的 context length：`tev1:0.8b` 声明 262144，
 * 实际 `num_ctx = 2050`）。
 *
 * **诚实边界（钳制目前是行为惰性的）**：被接受的 body 恒 `≤ LIMITS.maxBodyBytes`
 * （`prepareRequest` 在**严格大于**上限时抛错），而告警条件是**严格大于**阈值 ——
 * 两条严格不等式首尾相接，于是任何 `≥ 上限` 的阈值（钳到 65536 的，和没钳的 `1e9`）
 * 在 `execute` 层行为**完全相同**：永不告警。所以真正防止 `16384` 那类「阈值落在
 * 拒绝区、告警永不可达」的 bug 的是**校准过的默认值** `LIMITS.softBodyBytes`（4096 ≈ 1230
 * token ≈ 2050 上限的 60%），不是这道钳制 —— 钳制是**刻意的意图声明**：一旦将来拒绝点
 * 挪动（例如不再由本地 64 KiB 守卫、而由更宽的边界决定），生效值仍已被夹在力所能及的
 * 上限内。另：把阈值设到模型**真实**容量之上，告警仍会**静默失效**，插件内部无法检测
 * （没有读取服务端 `num_ctx` 的通路）—— 权威守卫始终是**服务端的 token 检查**：
 * 超限回 HTTP 400，映射为 `kind: 'context_overflow'`（输入不被截断）。
 *
 * @param {number|undefined} configured 配置里的 `softBodyBytes`；undefined 表示未设
 * @returns {number} 生效阈值（恒 ≤ `LIMITS.maxBodyBytes`）
 */
export function resolveSoftBodyBytes(configured) {
  const requested = configured === undefined ? LIMITS.softBodyBytes : configured;
  return Math.min(requested, LIMITS.maxBodyBytes);
}

/**
 * 返回值 schema。宿主会用它对**每一个成功返回值**做强校验，
 * 因此这里的字段必须与 `execute` 的返回严格对应；
 * 用 `additionalProperties: true` 容忍 Ollama 新增字段。
 */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model: { type: 'string', required: true },
    answers: { type: 'object', additionalProperties: true, required: true },
    usage: { type: 'object', additionalProperties: true },
    // 体积可归因（需求 M2，见 Task 7 与规格 §4.8）。这三个字段**由本插件自己产出**，
    // 不是 Ollama 的回包字段，故必须显式声明 —— schema 是 additionalProperties:false。
    state_bytes: { type: 'number' },
    body_bytes: { type: 'number' },
    body_warning: { type: 'string' },
  },
};

export function apply(ctx, config = {}) {
  const { baseUrl, defaultModel, timeoutMs, toolName, keepAlive, softBodyBytes, bodyWarning } = config;

  // 配置是静态的，阈值在注册时解析一次（含上文的钳制），execute 里只做比较。
  const effectiveSoftBodyBytes = resolveSoftBodyBytes(softBodyBytes);

  ctx.tools.register(defineTool({
    name: toolName,
    description: TOOL_DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: renderAnswers,
    },
    async execute(args, exec) {
      const body = prepareRequest({
        state: args.state,
        questions: args.questions,
        model: args.model,
        defaultModel,
        keepAlive,
      });
      const result = await callSystemOne({ baseUrl, body, timeoutMs, signal: exec?.signal });

      // 体积可归因（需求 M2）。body_bytes 必须按**已转换的线格式**度量 —— 与 V8 的硬守卫
      // 同一口径，否则模型看到的数与真正的上限余量对不上。
      // state 可能是字符串，也可能是对象/数组（CONTENT_SPEC），故按序列化后的字节数报。
      const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
      const stateBytes = Buffer.byteLength(stateText, 'utf8');
      const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
      // 体积告警可配置（需求 delta）：阈值见 effectiveSoftBodyBytes，开关见 bodyWarning。
      // bodyWarning 未设或 true ⇒ 启用；**显式 false ⇒ 产出 undefined**，于是下面整个键缺席。
      const warning = bodyWarning === false || bodyBytes <= effectiveSoftBodyBytes
        ? undefined
        : `请求体 ${bodyBytes} 字节，已超过建议的 ${effectiveSoftBodyBytes} 字节：`
          + '可考虑拆成多次调用，或缩小 state。';

      // 注意：宿主要求返回的是 JSON 值（否则 snapshotToolValue 会拒绝），
      // 所以 warning 为 undefined 时**整个键都不能出现**，不能写成 body_warning: undefined。
      // 宿主用 snapshotJsonValue 逐层检查返回值是否为**无损 JSON**：任何值为 `undefined`
      // 的 own key 都会让整次调用被判非法并抛 ToolOutputError —— 即「成功调用变成工具失败」。
      // 所以返回值必须**逐字段显式构造**，凡可能为 undefined 的键都要**整个不出现**。
      // 同一函数里 body_warning 已按此处理；usage 同样必须 —— 它来自服务端回包，可能缺席。
      return {
        model: result.model,
        answers: result.answers,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        state_bytes: stateBytes,
        body_bytes: bodyBytes,
        ...(warning === undefined ? {} : { body_warning: warning }),
      };
    },
  }));
}

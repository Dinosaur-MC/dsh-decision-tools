/**
 * 策略规划（§4 决策表）的**纯函数**：给定「请求的策略 / 有没有引用式材料 / 刚发生的失败 /
 * 提升是否可用 / 扫描是否可用」，返回下一个动作。
 *
 * 刻意只回一个记号，不做任何 I/O —— 真正的派发在 `lib/tool.js`。这样「什么时候换模型、
 * 什么时候分块」这套语义可以在没有网络的情况下钉死。
 *
 * @module dsh-decision-tools/plan
 */

/** 允许的策略值。`scan` 是唯一**主动**分块的策略；`inline` 明确禁止分块。 */
export const STRATEGIES = Object.freeze(['auto', 'inline', 'scan']);

/**
 * 决策表：
 *
 * | 情形 | 动作 |
 * |---|---|
 * | 无失败，显式 `scan` | `scan`（不再试整发） |
 * | 无失败，其余 | `send`（引用式材料标 `source`） |
 * | 溢出，可用提升，且不是显式 `scan` | `escalate` |
 * | 溢出，提升用尽/不可用，`auto` 且可扫描 | `scan` |
 * | 溢出，`inline` | `fail`（`scan-not-allowed`） |
 * | 溢出，不可扫描 | `fail`（`scan-unavailable`） |
 * | 任何非溢出的失败 | `fail`（`passthrough:<kind>`，原样上抛不套近乎） |
 *
 * @param {object} [input]
 * @param {'auto'|'inline'|'scan'} [input.requested] 调用方要的策略
 * @param {boolean} [input.hasSource] 材料是否来自 `stateSource`（仅影响 reason 文案）
 * @param {{ kind?: string }|undefined} [input.failure] 刚刚发生的失败；`undefined` 表示还没发过
 * @param {boolean} [input.escalationEnabled] 配置是否开启自动提升
 * @param {{ ok?: boolean }|undefined} [input.escalation] `selectEscalation` 的结果
 * @param {boolean} [input.scanAvailable] 扫描是否可用
 * @returns {{ action: 'send'|'escalate'|'scan'|'fail', reason: string, strategy: string }}
 * @throws {Error} `requested` 不是允许的策略（这是编程错误，不是模型错误）
 */
export function planAction({
  requested = 'auto',
  hasSource = false,
  failure = undefined,
  escalationEnabled = false,
  escalation = undefined,
  scanAvailable = true,
} = {}) {
  if (!STRATEGIES.includes(requested)) {
    throw new Error(`strategy 只允许 auto / inline / scan（收到 ${JSON.stringify(requested)}）。`);
  }
  if (failure === undefined) {
    if (requested === 'scan') return { action: 'scan', reason: 'scan-explicit', strategy: requested };
    return { action: 'send', reason: hasSource ? 'source' : 'inline', strategy: requested };
  }
  if (failure?.kind !== 'context_overflow') {
    return { action: 'fail', reason: `passthrough:${failure?.kind ?? 'unknown'}`, strategy: requested };
  }
  if (requested !== 'scan' && escalationEnabled && escalation?.ok === true) {
    return { action: 'escalate', reason: 'escalate', strategy: requested };
  }
  if (requested === 'scan') return { action: 'scan', reason: 'scan-explicit', strategy: requested };
  if (requested === 'auto' && scanAvailable) {
    return { action: 'scan', reason: 'scan-exhausted-escalation', strategy: requested };
  }
  return {
    action: 'fail',
    reason: requested === 'inline' ? 'scan-not-allowed' : 'scan-unavailable',
    strategy: requested,
  };
}

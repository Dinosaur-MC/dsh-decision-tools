/**
 * 通知的**最后一跳**：把 payload.message 交给目标 agent（`followup` 唤醒 / `inject` 静默）。
 *
 * 为什么单独成模块：审查 `verifier` 的变异证明过 —— 把这一层改成「恒 inject」，全套件仍绿。
 * 之前它写在 `tool.js` 的 apply 闭包里，无法单测；抽出来后这里的行为（哪个方法、失败是否吞、
 * 无目标时静默返回）全部可被单测钉住。
 *
 * 硬边界：
 * - **绝不抛**：通知失败不能影响被监控的作业本体；
 * - **绝不调用 `agent.cancel`**（实测它会清空整个 inbox）；
 * - 拿不到目标（既没有 info.agent，也没有可解析的 sessionId）⇒ 静默返回 false。
 * @module dsh-decision-tools/deliver
 */

/**
 * @param {any} agents 宿主 `ctx.agents`（可缺：缺了就只能靠 `info.agent`）
 * @param {'followup'|'inject'} mode 投递方式
 * @param {{ message?: object }} payload 通知负载（取 `payload.message`）
 * @param {{ agent?: any, sessionId?: string }} [info]
 * @returns {boolean} 是否真的投递出去了
 */
export function deliverNotice(agents, mode, payload, info = {}) {
  try {
    const message = payload === null || payload === undefined ? undefined : payload.message;
    if (message === undefined || message === null) return false;
    let target = info.agent;
    if (target === undefined || target === null) {
      const sid = typeof info.sessionId === 'string' && info.sessionId !== '' ? info.sessionId : undefined;
      target = sid === undefined || typeof agents?.get !== 'function' ? undefined : agents.get(sid);
    }
    if (target === undefined || target === null) return false;
    if (mode === 'followup' && typeof target.followup === 'function') {
      target.followup(message);
      return true;
    }
    if (typeof target.inject === 'function') {
      target.inject(message);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
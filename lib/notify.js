/**
 * Monitor 的通知策略（规格 docs/superpowers/specs/2026-10-17-monitor-and-pipe-design.md §3.3）：
 * **合并 + 限频 + 唤醒预算**，三件套缺一不可。
 *
 * 为什么三件套必须都在（本机真跑实测，证据 tmp/sub-notify/REPORT.md §②）：
 * - inbox **没有容量上限、没有合并、没有背压** —— 连投 12 条全部原样排队，下一个步骤边界一次全领；
 * - 唯一的硬约束是 **MessageId 不能重复**（重复会抛 already pending）；
 * - agent.cancel() 会**清空并丢弃整个 inbox**（实测 5 条 agent/inbox/discarded）⇒ 本模块**永不**
 *   触碰它，也从不持有 agent（只通过注入的 deliver 出站）。
 *
 * 投递范式照抄官方作业通知：目标空闲 ⇒ followup（唤醒）；目标忙 ⇒ inject（静默等下一次输入）。
 * 本模块零 import、零宿主依赖：deliver / clock 全部注入；守卫见 test/notify.test.mjs。
 *
 * @module dsh-decision-tools/notify
 */

/** 限频窗口：一分钟（滑动窗口，按注入时钟计）。 */
export const RATE_WINDOW_MS = 60000;

/** 默认唤醒预算：连续唤醒这么多次后就降级为 inject（打断「唤醒→起作业→完成→再唤醒」的自激链）。 */
export const DEFAULT_WAKE_BUDGET = 5;

/** 每个 notifier 实例占一个序号：消息 id 里带上它，跨实例也不会撞（宿主对重复 MessageId 会抛）。 */
let instanceSeq = 0;

/** 把合并键收敛成 id 安全的短串（合并键可能来自模型给的事件名）。 */
function sanitizeKey(key) {
  const raw = String(key === undefined || key === null ? 'notice' : key);
  const cleaned = raw.replace(/[^A-Za-z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return cleaned === '' ? 'notice' : cleaned;
}

/** 取一个有限整数，非法就回落到兜底值（策略参数不做隐式猜测）。 */
function intOr(value, fallback, min) {
  if (!Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n < min ? min : n;
}

/**
 * 造一个通知器。**策略只做标记与节流，从不放行/阻断任何业务判定**。
 *
 * @param {object} options 策略参数
 * @param {(mode: string, payload: object) => void} options.deliver 投递函数（注入）。
 *   mode 只有两个取值：followup（唤醒，next-turn）与 inject（静默，next-step）。
 *   payload = { id, text, at, event, message }；message 是可直接交给 agent.followup/inject 的
 *   UserMessage 形状：{ id, role:'user', content:[{type:'text',text}], source:{kind:'decision-monitor',form:'notice',summary?} }。
 *   **source.kind 必须是本插件自己的名字**（与宿主 `dsh-tool-jobs` 的 `kind:'tool-jobs'` 同构）：
 *   写成 `kind:'user'` 是**假托用户消息**，且 `{kind:'user', form:'notice'}` 并不在宿主 `MessageSourceMap` 的
 *   `user` 分支里（该分支只有 `kind`）—— 那是把通知伪装成用户输入，GUI 与后续统计都会认错来源。
 * @param {() => number} [options.clock] 注入时钟（epoch 毫秒）。缺省 Date.now；测试必须注入。
 * @param {number} [options.coalesceWindowMs=5000] 同类事件的合并窗口；0 关闭合并。
 * @param {number} [options.maxPerMinute=6] 滑动一分钟内的投递上限（被压制的那次不占额度）。
 * @param {number} [options.wakeBudget=5] 连续唤醒预算；用尽后 followup 降级为 inject。
 * @returns {{ notify: (evt: object) => object, stats: () => object }}
 */
export function createNotifier(options = {}) {
  const deliver = options.deliver;
  if (typeof deliver !== 'function') {
    throw new TypeError('createNotifier 需要注入 deliver(mode, payload)：mode 属于 {followup, inject}。');
  }
  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const coalesceWindowMs = intOr(options.coalesceWindowMs, 5000, 0);
  const maxPerMinute = intOr(options.maxPerMinute, 6, 1);
  const wakeBudget = intOr(options.wakeBudget, DEFAULT_WAKE_BUDGET, 0);
  const instance = (instanceSeq += 1);

  /** 每个合并键上一次**成功投递**的时刻（失败不记，好让下一次重试）。 */
  const lastDeliveredAt = new Map();
  /** 滑动一分钟窗内成功投递的时刻（FIFO，够用就够）。 */
  const deliveredAt = [];
  const counters = { delivered: 0, suppressed: 0, coalesced: 0, rateLimited: 0, wakeDegraded: 0, failed: 0 };
  let seq = 0;
  let wakesUsed = 0;

  function snap() {
    return {
      deliveredCount: counters.delivered,
      suppressedCount: counters.suppressed,
      coalescedCount: counters.coalesced,
      rateLimitedCount: counters.rateLimited,
      wakeDegradedCount: counters.wakeDegraded,
      failedCount: counters.failed,
      wakesUsed,
    };
  }

  function pruneRateWindow(now) {
    while (deliveredAt.length > 0 && deliveredAt[0] <= now - RATE_WINDOW_MS) deliveredAt.shift();
  }

  /**
   * 投递一条通知。
   *
   * evt 的读法：
   * - text（必填）：通知正文；
   * - key / kind：合并键（缺省 notice）；同键在 coalesceWindowMs 内只投递一次；
   * - idle === true 或 status === 'idle'：目标空闲 ⇒ followup（唤醒）；否则 inject（不唤醒）；
   * - mode：显式覆盖上面的推断；wake === false：本事件永不唤醒；
   * - coalesce === false：本次跳过合并检查；
   * - at：注入时刻（缺省 clock()）。**它不是「只作记录」的字段**：合并窗与限频窗都按它算，消息 id 里
   *   也含它 —— 与 monitor 的 at（只作记录、不参与判定）语义不同。传注入时钟即得到确定性的窗口行为。
   *
   * @param {object} evt 事件
   * @returns {{ delivered: boolean, mode: string, id: string|null, reason: string, key: string, at: number,
   *   wakeDegraded: boolean, deliveredCount: number, suppressedCount: number }}
   */
  function notify(evt = {}) {
    const text = evt.text;
    if (typeof text !== 'string' || text === '') {
      throw new TypeError('notify(evt) 需要 evt.text（通知正文，非空字符串）。');
    }
    const at = Number.isFinite(evt.at) ? Math.trunc(evt.at) : Math.trunc(clock());
    const key = sanitizeKey(evt.key === undefined ? (evt.kind === undefined ? evt.type : evt.kind) : evt.key);
    const base = { delivered: false, mode: 'inject', id: null, reason: 'delivered', key, at, wakeDegraded: false };

    // ① 合并：同窗口内同类事件只投递一次（inbox 自己不合并）。
    if (evt.coalesce !== false && coalesceWindowMs > 0) {
      const last = lastDeliveredAt.get(key);
      if (last !== undefined && at - last < coalesceWindowMs) {
        counters.suppressed += 1;
        counters.coalesced += 1;
        return { ...base, reason: 'coalesced', ...snap() };
      }
    }

    // ② 限频：滑动一分钟窗，超了就地压制（被压制的那次不占额度）。
    pruneRateWindow(at);
    if (deliveredAt.length >= maxPerMinute) {
      counters.suppressed += 1;
      counters.rateLimited += 1;
      return { ...base, reason: 'rate_limited', ...snap() };
    }

    // ③ 唤醒预算：空闲才唤醒；预算用尽后降级为 inject（消息仍送达，只是不唤醒）。
    const wantsWake = evt.wake !== false && (evt.mode !== undefined
      ? evt.mode === 'followup'
      : (evt.idle === true || evt.status === 'idle'));
    let mode = wantsWake ? 'followup' : 'inject';
    let wakeDegraded = false;
    if (wantsWake && wakesUsed >= wakeBudget) {
      mode = 'inject';
      wakeDegraded = true;
      counters.wakeDegraded += 1;
    }

    seq += 1;
    const id = 'notice-' + instance + '-' + at + '-' + seq;
    const message = {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'decision-monitor',
        form: 'notice',
        ...(typeof evt.summary === 'string' && evt.summary !== '' ? { summary: evt.summary } : {}),
      },
    };
    const payload = { id, text, at, event: evt, message };

    try {
      deliver(mode, payload);
    } catch (error) {
      counters.failed += 1;
      return { ...base, mode, id: null, reason: 'deliver_failed', error: String(error && error.message ? error.message : error), ...snap() };
    }

    if (mode === 'followup') wakesUsed += 1;
    else if (!wantsWake) wakesUsed = 0; // 只有「真的不唤醒」才打断连续计数；降级本身不算
    deliveredAt.push(at);
    lastDeliveredAt.set(key, at);
    counters.delivered += 1;
    return { ...base, delivered: true, mode, id, reason: 'delivered', wakeDegraded, ...snap() };
  }

  return { notify, stats: snap };
}

/**
 * 事件环形缓冲（`monitor` 的 `source.kind='events'` 的生产者）。
 *
 * 为什么需要它：`readEventsSample`（lib/monitor.js）只读**装配层注入的**缓冲，自己从不订阅任何东西；
 * 而本 profile 里 `deps.eventLog` / `ctx.monitorEventLog` 都不存在 ⇒ `events` 源此前不可用。
 * 本模块把宿主 `ctx.jobs` 的事件流（`registered/stopping/output/progress/settled/removed`）
 * 收进一个定长环形缓冲，并按**可等待的语义**重命名：
 *   `job.registered` / `job.settled` / `job.completed` / `job.failed` / `job.killed` / `job.removed`
 * 其中 `settled` 会**额外**派生一条按 `job.status` 命名的条目，于是模型可以直接写
 * `types: ['job.failed']` 来表达「等某个作业失败」。
 *
 * 三条硬边界：
 * 1. **只读不写**：本模块只记录，绝不 cancel/kill/retry 任何作业；
 * 2. **环形有界**：容量固定，超出丢最旧；条目字段做截断（`detail` ≤ 120 字符），避免把输出正文塞进样本；
 * 3. **故障隔离**：订阅回调抛错只记 warn，绝不影响宿主作业本体。
 * @module dsh-decision-tools/event-log
 */

export const EVENT_LOG_DEFAULT_CAPACITY = 200;
export const EVENT_LOG_DEFAULT_TAIL = 64;
export const EVENT_DETAIL_MAX_CHARS = 120;

const clip = (value, max) => (typeof value === 'string' && value.length > max ? value.slice(0, max) : value);

/**
 * 造一个定长环形缓冲。`tail(n)` 返回最近 n 条（按时间正序），`push` 超过容量丢最旧。
 * @param {{ capacity?: number, now?: () => number }} [options]
 */
export function createEventLog(options = {}) {
  const capacity = Number.isInteger(options.capacity) && options.capacity > 0 ? options.capacity : EVENT_LOG_DEFAULT_CAPACITY;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ring = [];
  return {
    capacity,
    /** 追加一条（自动补 `at`）。返回实际落盘的条目。 */
    push(entry) {
      const record = { at: now(), ...entry };
      ring.push(record);
      while (ring.length > capacity) ring.shift();
      return record;
    },
    /** 最近 n 条（默认 EVENT_LOG_DEFAULT_TAIL），时间正序。 */
    tail(n = EVENT_LOG_DEFAULT_TAIL) {
      const count = Number.isInteger(n) && n > 0 ? Math.min(n, capacity) : EVENT_LOG_DEFAULT_TAIL;
      return ring.slice(-count);
    },
    size() { return ring.length; },
    clear() { ring.length = 0; },
  };
}

/**
 * 把一条宿主 job 事件映射成 1–2 条缓冲条目（`settled` 会派生按状态命名的条目）。
 * 纯函数：不读时钟、不碰 ctx，便于单测。
 * @param {any} event 宿主事件 `{ type, job?, id?, cause?, awaited?, total? }`
 * @param {{ at?: number }} [options]
 * @returns {object[]}
 */
export function mapJobEvent(event, options = {}) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return [];
  const job = event.job !== null && typeof event.job === 'object' ? event.job : undefined;
  // 注意：`output` 事件**没有** `job`（只有 `{type,id,owner,total}`）⇒ 这里必须先解析出 id，
  // 不能写 `job.id ?? event.id` 的短路形式（job 为 undefined 时 `job.id` 会直接抛）。
  const jobId = job !== undefined && job.id !== undefined ? job.id : event.id;
  const base = {
    id: typeof jobId === 'string' ? jobId : undefined,
    kind: typeof job?.kind === 'string' ? job.kind : undefined,
    label: clip(job?.label, 80),
    status: typeof job?.status === 'string' ? job.status : undefined,
    detail: clip(job?.detail, EVENT_DETAIL_MAX_CHARS),
    ...(Number.isFinite(event.total) ? { total: event.total } : {}),
  };
  const clean = Object.fromEntries(Object.entries(base).filter(([, v]) => v !== undefined));
  const at = options.at;
  const stamp = Number.isFinite(at) ? { at } : {};
  const make = (type) => ({ type, ...stamp, ...clean });
  switch (event.type) {
    case 'registered': return [make('job.registered')];
    case 'stopping': return [make('job.stopping')];
    case 'removed': return [make('job.removed')];
    case 'progress': return [make('job.progress')];
    case 'output': return [make('job.output')];
    case 'settled': {
      const out = [make('job.settled')];
      const status = clean.status;
      if (status === 'completed') out.push(make('job.completed'));
      else if (status === 'failed') out.push(make('job.failed'));
      else if (status === 'killed') out.push(make('job.killed'));
      return out;
    }
    default: return [];
  }
}

/**
 * 订阅宿主 `ctx.jobs` 的事件流并写进缓冲。
 * - `jobs` 服务缺失、或 `events.subscribe` 不可用 ⇒ **返回 null 且不抛**（`events` 源会照常给出可行动错误）；
 * - 订阅回调包 try/catch：观测者绝不能影响被观测的作业（宿主侧同样是这个口径）；
 * - 返回 disposer（宿主通常用它登记 effect）；拿不到订阅也返回一个空 disposer，调用方不必分支。
 * @param {any} ctx 宿主上下文（需要 `jobs.events.subscribe`）
 * @param {ReturnType<typeof createEventLog>} log
 * @param {{ warn?: (message: string) => void, now?: () => number }} [options]
 * @returns {(() => void) | null}
 */
export function attachJobEvents(ctx, log, options = {}) {
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let hub;
  try {
    hub = ctx?.jobs?.events;
  } catch {
    return null;
  }
  if (hub === undefined || typeof hub.subscribe !== 'function') return null;
  const filter = options.filter !== undefined && options.filter !== null ? options.filter : {};
  const onFirstEvent = typeof options.onFirstEvent === 'function' ? options.onFirstEvent : null;
  let sawAnyEvent = false;
  const listener = (event) => {
    try {
      // 「第一次到达」只回调给装配层（诊断用）：本模块保持纯粹，不往缓冲里塞自己的条目。
      if (!sawAnyEvent) {
        sawAnyEvent = true;
        if (onFirstEvent !== null) { try { onFirstEvent(event); } catch { /* 诊断失败不影响记录 */ } }
      }
      for (const entry of mapJobEvent(event, { at: now() })) log.push(entry);
    } catch (error) {
      warn('event-log: 映射事件失败（已忽略，不影响作业本体）：' + String(error?.message ?? error));
    }
  };
  try {
    // **服务层 `ctx.jobs.events.subscribe` 是两参** `(filter, listener)`（底层 JobEventHub 才是三参，
    // 服务层已经绑定了 ctx）。真机踩过：照三参调用会把 ctx 当 filter、把 {} 当 listener ⇒
    // 订阅「注册成功」但**永远收不到事件**。这里按函数元数自适应，两种形状都对。
    const subscribe = typeof hub.subscribe === 'function' ? hub.subscribe.bind(hub) : null;
    const disposer = subscribe.length >= 3 ? subscribe(ctx, filter, listener) : subscribe(filter, listener);
    return typeof disposer === 'function' ? disposer : () => {};
  } catch (error) {
    warn('event-log: 订阅 job 事件失败（events 源将不可用）：' + String(error?.message ?? error));
    return null;
  }
}
/**
 * 自动提升（ADR-8）的**纯策略**：需求判定、阶梯选档、粘滞、单飞与失败文案。
 *
 * 零依赖、零 I/O、不接触 `ctx`、不发起请求 —— 阶梯与失败对象都由调用方注入。
 * 这样策略可以独立测试，也便于将来被 CLI 或评测装置直接复用（规格 §5 的边界原则）。
 *
 * **本模块只做策略，不做编排**：真正「重发一次请求」的循环在 `lib/tool.js`。
 *
 * `clef` 系走的那条**不打印数字**的溢出分支在这里不构成特例：分支差异只表现为
 * 「失败对象上有没有 `actual`」，于是 A/B 分支的差别在 `demandOf` 一处收敛。
 *
 * @module dsh-decision-tools/escalate
 */

/**
 * 选档余量（**策略值，不是实测值**）：候选容量必须满足 `numCtx × 本值 ≥ 需求`。
 *
 * 取 0.6 与 `LIMITS.softBodyBytes / 2050 ≈ 60%` 同源：留出题面（questions）、
 * 模型自身 system prompt、分词器差异的余量。**唯一出处在本文件** —— 分块扫描（A9）
 * 若需要同一个比值，必须从这里 import，不得复制这个数字。
 */
export const ESCALATION_MARGIN = 0.6;

/**
 * 默认阶梯：容量取本机实测值（`.temp/numctx/notes.md`，Ollama 0.40.3）。
 *
 * **刻意不含 `clef:latest`**：27B 在 8 GB 显存上 prefill 21500 B 300 s 未返回，
 * 把它放进默认阶梯等于给调用方埋一个超时。要用的部署自己往 `ladder` 里加。
 */
export const DEFAULT_LADDER = Object.freeze([
  Object.freeze({ model: 'tev1:0.8b', numCtx: 2050 }),
  Object.freeze({ model: 'tev1:latest', numCtx: 2050 }),
  Object.freeze({ model: 'nimble:latest', numCtx: 8194 }),
  Object.freeze({ model: 'clef-flash:latest', numCtx: 16384 }),
]);

/**
 * 判定本次请求的「需求」（token 数）及其来源。
 *
 * **带数字就用数字**：`actual` 是服务端自己算出来的真实 token 数，比任何按字节
 * 的估算都准（实测 B/token 跨 1.32–7.15，估算根本不可靠）。`clef` 系那一支不给数字，
 * 于是回落到**当前模型的声明容量**作保守估计 —— 保守方向是安全的：容量选小了会被
 * 下一次同分支的失败再推一档，选大了则可能白付一次冷加载。
 *
 * @param {{ actual?: number }|undefined} failure 失败信息（`SystemOneError` 即可直接传入）
 * @param {number} currentNumCtx 当前模型的有效容量（声明值或 `observed` 值）
 * @returns {{ demand: number, source: 'observed'|'conservative' }}
 */
export function demandOf(failure, currentNumCtx) {
  const actual = failure?.actual;
  if (Number.isFinite(actual) && actual > 0) return { demand: actual, source: 'observed' };
  return { demand: currentNumCtx, source: 'conservative' };
}

/**
 * 从阶梯里选一档能容纳本次请求的模型。
 *
 * 两条硬规则：
 * ① **只看比当前更大的档**（`numCtx > currentNumCtx`）—— 同容量换模型只是付一次冷加载，
 *    换到更小的档更毫无意义；
 * ② 余量满足 `numCtx × margin ≥ 需求`（取 `>=`，边界上宁可选中）。
 *
 * @param {object} params
 * @param {{ model: string, numCtx: number }[]} params.ladder 有序阶梯
 * @param {string} params.from 当前模型（仅用于失败文案）
 * @param {{ actual?: number }|undefined} params.failure 触发本次提升的失败
 * @param {number} params.currentNumCtx 当前模型的有效容量
 * @param {number} [params.margin] 余量，缺省 `ESCALATION_MARGIN`
 * @returns {{ ok: true, entry: object, demand: number, demandSource: string }
 *   | { ok: false, reason: 'no-larger-entry'|'exceeds-largest', from: string,
 *       demand: number, demandSource: string, considered: { model: string, numCtx: number }[] }}
 */
export function selectEscalation({ ladder, from, failure, currentNumCtx, margin = ESCALATION_MARGIN }) {
  const { demand, source } = demandOf(failure, currentNumCtx);
  const larger = ladder.filter((entry) => entry.numCtx > currentNumCtx);
  const fits = larger.find((entry) => entry.numCtx * margin >= demand);
  if (fits !== undefined) return { ok: true, entry: fits, demand, demandSource: source };
  return {
    ok: false,
    reason: larger.length === 0 ? 'no-larger-entry' : 'exceeds-largest',
    from,
    demand,
    demandSource: source,
    considered: larger.map((entry) => ({ model: entry.model, numCtx: entry.numCtx })),
  };
}

/**
 * 粘滞策略（防抖动的全部规则都在这里，状态由调用方持有）。
 *
 * 优先级：**显式 `model` > 本次提升 > 既有粘滞 > `defaultModel`**。
 *
 * 三条不变量：
 * ① 调用方显式传 `model` 时**一律赢**（含向下降级），并且不算一次提升（不回显 `escalated`）；
 * ② 粘滞状态**不因 `defaultModel` 变化而回退** —— 这是防抖动的核心：只要没人显式指定，
 *    就继续用已加载的那一档，避免 A 要 0.8B / B 提升 / A 又要 0.8B 式的反复冷加载；
 * ③ `escalated` 只在**本次**由提升改变了模型时给出，供上层如实回显。
 *
 * @param {{ model: string, reason?: string }|null} state 现有粘滞状态（null = 无）
 * @param {{ explicitModel?: string, escalatedTo?: string, defaultModel?: string }} [intent]
 * @returns {{ next: { model: string, reason: string }, switchTo: string,
 *   escalated: { to: string, sticky: true }|undefined }}
 */
export function resolveSticky(state, intent = {}) {
  const { explicitModel, escalatedTo, defaultModel } = intent;
  if (explicitModel !== undefined) {
    return {
      next: { model: explicitModel, reason: 'explicit' },
      switchTo: explicitModel,
      escalated: undefined,
    };
  }
  if (escalatedTo !== undefined) {
    return {
      next: { model: escalatedTo, reason: 'escalated' },
      switchTo: escalatedTo,
      escalated: { to: escalatedTo, sticky: true },
    };
  }
  if (state !== null && state !== undefined && typeof state.model === 'string') {
    return { next: state, switchTo: state.model, escalated: undefined };
  }
  return {
    next: { model: defaultModel, reason: 'default' },
    switchTo: defaultModel,
    escalated: undefined,
  };
}

/**
 * 单飞闸：同一时刻只允许一趟在飞，后来的调用搭同一趟。
 *
 * 为什么必须有：提升决策会**换掉进程内已加载的模型**。两个并发调用各自决策就会互相
 * 拆台（A 要 0.8B → B 提升到 clef → A 再要 0.8B ⇒ 又一次 12 s 冷加载）。
 *
 * `fn` 是**同步调用**的（不是丢进微任务）：两次 `run` 之间不留空隙，否则两个调用可能
 * 都看到空槽位而各开一趟。结算（成功或失败）后立即释放，下一波可以重新跑。
 *
 * @returns {{ run: (fn: () => unknown) => Promise<unknown>, readonly pending: boolean }}
 */
export function createSingleFlight() {
  let inFlight;
  return {
    run(fn) {
      if (inFlight !== undefined) return inFlight;
      let started;
      try {
        started = Promise.resolve(fn());
      } catch (error) {
        started = Promise.reject(error);
      }
      inFlight = started.finally(() => { inFlight = undefined; });
      return inFlight;
    },
    get pending() {
      return inFlight !== undefined;
    },
  };
}

/**
 * 阶梯用尽时的失败文案。**可行动**是硬要求：必须说清需求多少、为什么没选中、以及有哪几条
 * 路（缩减 state / 部署侧抬高 num_ctx / 改用分块扫描），并且**不得**把调用方引向
 * 「题型、选项数、题名」那类与溢出无关的形状问题。
 *
 * @param {object} params
 * @param {string} params.from 当前模型
 * @param {number} params.demand 需求 token 数
 * @param {string} params.demandSource `observed` 或 `conservative`
 * @param {{ model: string, numCtx: number }[]} params.ladder 阶梯
 * @param {string} params.reason `selectEscalation` 给出的原因码
 * @returns {string} 面向模型的一句话（含三条可行动项）
 */
export function describeExhausted({ from, demand, demandSource, ladder, reason }) {
  const top = ladder.reduce(
    (best, entry) => (best === null || entry.numCtx > best.numCtx ? entry : best),
    null,
  );
  const capacity = top === null ? '（阶梯为空）' : `${top.model} 的 ${top.numCtx} token`;
  const cause = reason === 'no-larger-entry'
    ? `当前模型 ${from} 已经是阶梯里容量最大的一档`
    : `阶梯里没有一档的余量能容纳本次请求（上限 ${capacity}）`;
  const source = demandSource === 'observed'
    ? '服务端报错实测'
    : '当前模型的声明容量（服务端未给出数字）';
  return `提升失败：${cause}。需求 ${demand} token（来源：${source}）。`
    + '可行动项：① 缩减 state；'
    + '② 把该模型的 Modelfile PARAMETER num_ctx 调大后重启（属部署侧，插件不改部署）；'
    + '③ 改用分块扫描（strategy: scan）。';
}

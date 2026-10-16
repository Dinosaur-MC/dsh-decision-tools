/**
 * 自动提升（ADR-8）的**纯策略**：需求判定、阶梯选档、粘滞、单飞与失败文案。
 *
 * 零 I/O、不接触 `ctx`、不发起请求 —— 阶梯与失败对象都由调用方注入。
 * 这样策略可以独立测试，也便于将来被 CLI 或评测装置直接复用（规格 §5 的边界原则）。
 * 唯一的 import 是 `SystemOneError`：升档耗尽时要产出与其它失败同族的终态对象。
 *
 * **本模块只做策略，不做编排**：真正「重发一次请求」的循环在 `lib/tool.js`。
 *
 * `clef` 系走的那条**不打印数字**的溢出分支在这里不构成特例：分支差异只表现为
 * 「失败对象上有没有 `actual`」，于是 A/B 分支的差别在 `demandOf` 一处收敛。
 *
 * @module dsh-decision-tools/escalate
 */
import { SystemOneError } from './client.js';

/**
 * 选档余量（**策略值，不是实测值**）：候选容量必须满足 `numCtx × 本值 ≥ 需求`。
 *
 * 取 0.6 与「`LIMITS.softBodyBytes` 曾约为某模型窗口的 60%」同源：留出题面（questions）、
 * 模型自身 system prompt、分词器差异的余量。**它是一个比例而非某个窗口的快照**，
 * 故模型重拉、`num_ctx` 变化时本值仍然成立（与 `softBodyBytes` 的固定字节数不同 ——
 * 那个刻意不跟随窗口）。**唯一出处在本文件** —— 分块扫描（A9）若需要同一个比值，
 * 必须从这里 import，不得复制这个数字。
 */
export const ESCALATION_MARGIN = 0.6;

/**
 * 默认阶梯：容量取本机实测值（2026-10-15 16:34 复测，Ollama **0.40.4**，`/api/show` 的 `num_ctx`）。
 *
 * ⚠️ **这些数字会随模型重拉而变，且今天变过两次**：2026-10-12 时 tev1 系 `num_ctx = 2050`；
 * 2026-10-15 重拉后 tev1 系变 **8192**，新增 `nimble-v3`（**32768**），`clef-flash` 为
 * **16384**。⇒ **本阶梯是快照，不是事实来源**；换模型/重拉后应重新读 `/api/show` 的
 * `num_ctx`，并用 `Config.ladder` 覆盖。
 *
 * **刻意不含 `clef:latest`**：27B 在 8 GB 显存上 prefill 21500 B 300 s 未返回，
 * 把它放进默认阶梯等于给调用方埋一个超时。要用的部署自己往 `ladder` 里加。
 *
 * **刻意不含 `nimble:latest`**：它**可用**（2026-10-15 16:10 重拉后三型全 200），但
 * `num_ctx = 8194` 只比 tev1 系的 **8192** 大 **2 个 token** ⇒ 从 tev1 溢出时
 * 需求恒 `> 8192`，而本档要满足 `8194 × 0.6 = 4916 ≥ 需求` **永远不成立**，
 * 即它是一档**选不中的死档**（`selectByCapacity` 里它的可用区间只有 4 字节宽）。
 * ⚠️ 排除它的理由**是容量无增益**，不是「不可用」—— 后者曾是 10-15 早间的临时状态，
 * 现已不成立。**重拉会改 `num_ctx`；若某天它被改成明显更大的值，应重新纳入。**
 *
 * **静态快照 vs 运行时探测**：`num_ctx` 的权威读法是 `POST /api/show`（本机实测约 125 ms，读
 * `parameters` 段）⇒ **运行时能力优先于本文件里的静态常量**：探测成功就用探测值，探测失败才
 * 回退到这里的快照（或 `Config.ladder`）。⚠️ **题型上限（`choice` 选项数 / `score` 档位数）
 * 本地探测不到** —— `/openapi.json` / `/swagger.json` / `/docs` 一律 404（2026-10-16 实测），
 * 权威是**服务端 400**；`LIMITS.maxChoiceOptions = 255` 只是宽松默认 + `Config.maxChoiceOptions`
 * 覆盖点。详见 `docs/threshold-calibration.md` §4。
 */
export const DEFAULT_LADDER = Object.freeze([
  Object.freeze({ model: 'tev1:0.8b', numCtx: 8192 }),
  Object.freeze({ model: 'tev1:latest', numCtx: 8192 }),
  Object.freeze({ model: 'clef-flash:latest', numCtx: 16384 }),
  Object.freeze({ model: 'nimble-v3:latest', numCtx: 32768 }),
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
 * **三层优先级（高 → 低）**：
 * ① **显式 `model`（本次调用）** —— 一律赢（含向下降级）；按用户裁定 **R1**，显式值**写进粘滞**；
 * ② **进程粘滞** —— 上一次显式指定、或上一次**成功**升档后的模型；**一个进程内所有调用共享**
 *    （长任务或一次大档调用会把后续轻量调用也拖到大档 —— 实测大档对小材料慢 7–9 倍；这是刻意的
 *    防抖：只要没人显式指定就不退档）；
 * ③ **默认档**（`defaultModel`）。
 *
 * **失效条件**：显式指定（立即覆盖）/ 模型不存在或不被端点支持（该档不得粘滞）/ 本次溢出
 * （**只有确认成功**升档才写粘滞，失败不得毒化后续调用）。
 *
 * ⚠️ **日常选档不在这里**：A 方案（用户 2026-10-13 裁定）之后由 `selectByCapacity` 按本次材料
 * 估算需求取「容量够用的最小档」，粘滞只作为它给不出答案时的兜底（`sticky-fallback`）。本函数
 * 目前**无生产调用者**（只有测试直接用），见 `docs/architecture-current.md` §6 已知偏差 #7；
 * 口径与调用点以 `selectByCapacity` + `lib/tool.js` 的写入点为准。详见 `docs/threshold-calibration.md` §3。
 *
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
  /**
   * 串行闸：并发调用**各自执行**，但同一时刻只有一个在跑。
   *
   * 旧实现缓存并共享 settled 结果 ⇒ 两条并发调用里后来者拿到**前一条的 answers**
   * （r3 审查 P0：B 应为 0.999 却收到 A 的 0.111，且只发了 3 次请求）。「防并发切换模型」
   * 要的是**互斥**，不是**结果共享**；旧实现的 4 条单测恰好把「共享同一次执行」写成了
   * 正确性标准 ⇒ bug 与同源断言是同一个东西，修 bug 必须同时重写那 4 条断言。
   *
   * @returns {{ run: <T>(fn: () => Promise<T>) => Promise<T>, readonly pending: boolean }} 串行执行器
   */
  let tail = Promise.resolve();
  let active = 0;
  return {
    run(fn) {
      const start = tail.then(() => {
        active += 1;
        let started;
        try {
          started = Promise.resolve(fn());
        } catch (error) {
          started = Promise.reject(error);
        }
        return started.finally(() => { active -= 1; });
      });
      // 队尾只关心「前一个跑完了」，不关心成败（失败已由 start 传播给**它自己的**调用者）。
      tail = start.then(() => {}, () => {});
      return start;
    },
    get pending() {
      return active > 0;
    },
  };
}
/**
 * 升档耗尽的**统一终态**（r7 P0）。
 *
 * 旧签名（`from`/`demand`/`ladder`/`reason`）只能描述「为什么选不中」，调用方**看不到
 * 试过哪些档**；出现「三档全溢出」时最终抛出的还是最后一档的原始 `context_overflow`，
 * 与「压根没换过档」在判据上无法区分。新签名以**实际尝试序列**为准，逐条附
 * `model` 与 `failureKind`（含最初那一档），并把它们挂在 error 上供上层读。
 *
 * @param {{ attempts?: { model: string, failureKind: string }[], lastError?: { message?: string } }} [input]
 *   `attempts` 按发生顺序记录每一次**失败**的请求；`lastError` 只用于把最后一次的
 *   服务端原文附进消息（可选）。
 * @returns {SystemOneError} `kind='escalation_exhausted'`，`attempts` 逐条 `{model, failureKind}`
 */
export function describeExhausted({ attempts, lastError } = {}) {
  const tried = Array.isArray(attempts) ? attempts : [];
  const listed = tried.length === 0
    ? '（没有记录到任何尝试）'
    : tried.map((attempt) => `${attempt?.model ?? '?'}（${attempt?.failureKind ?? 'unknown'}）`).join(' → ');
  const tail = typeof lastError?.message === 'string' && lastError.message !== ''
    ? `最后一次失败：${lastError.message}`
    : '';
  const error = new SystemOneError(
    `提升失败：换档 ${tried.length} 次仍无法容纳本次请求。尝试过的档：${listed}。${tail}`
    + '可行动项：① 缩减材料（或改用行范围 / glob）；'
    + '② 把该模型的 Modelfile PARAMETER num_ctx 调大后重启（属部署侧，插件不改部署）；'
    + "③ 改用 depth: 'deep'（允许内部分块扫描）。",
    { kind: 'escalation_exhausted' },
  );
  error.attempts = tried.map((attempt) => ({
    model: typeof attempt?.model === 'string' ? attempt.model : 'unknown',
    failureKind: typeof attempt?.failureKind === 'string' ? attempt.failureKind : 'unknown',
  }));
  return error;
}

/** 估算需求用的换算比（字节/token）。取值偏乐观（宁可选小档、靠溢出兜底），依据见 selectByCapacity。 */
export const BYTES_PER_TOKEN = 3.33;

/**
 * A 方案（用户 2026-10-13 裁定）：按**本次材料**的估算需求选**容量足够的最小档**，
 * 而不是无条件继承上一次用过的档。
 *
 * **偏乐观**是刻意的：估算说装得下而实际溢出时，代价只是多一轮约 80 ms 的往返
 * （这次调用无论如何都要加载大档）；反过来，估算说装不下而其实装得下时，代价是
 * 每次 0.77–1.12 s（r5 S1 实测：小材料打大档是默认档的 7–9 倍慢）。
 *
 * 粘滞只在这个规则给不出答案时兜底（阶梯为空或容量未知）——它不再决定每次调用的模型。
 * 三层优先级（显式 `model` > 进程粘滞 > 默认档）与失效条件见 `docs/threshold-calibration.md` §3。
 *
 * @param {object} params
 * @param {string|undefined} params.explicitModel 显式指定优先（R1：显式必写粘滞，由调用方负责）
 * @param {string} params.defaultModel 默认档
 * @param {{ model: string, numCtx: number }[]} params.ladder 有序阶梯（容量未知的条目会被忽略）
 * @param {number} params.stateBytes 本次材料的字节数
 * @param {number} params.defaultFitBytes 默认档的字节阈值（调用方传 LIMITS.softBodyBytes，数值只留一处来源）
 * @param {string|undefined} [params.stickyModel] 兜底用的上次成功档
 * @param {number} [params.softBytes] **默认档**的软字节阈值 —— 由调用方用
 *   `density.softBytesFor({ numCtx: 默认档容量, text: 材料 })` 算出（含语言密度）；
 *   窗口未知时调用方传 `LIMITS.softBodyBytes` 这个固定兜底常量。
 * @param {number} [params.bytesPerToken] 阶梯各档的换算比（`density.bytesPerToken(材料)`）；
 *   缺省 `BYTES_PER_TOKEN`（英文散文口径，仅供不关心密度的调用方使用）。
 * @param {number} [params.margin] 容量余量，缺省 ESCALATION_MARGIN
 * @returns {{ model: string, reason: string, capacityBytes: number|null }} 选中的模型、原因码与容量
 */
export function selectByCapacity({
  explicitModel, defaultModel, ladder, stateBytes, softBytes, stickyModel,
  bytesPerToken = BYTES_PER_TOKEN, margin = ESCALATION_MARGIN,
}) {
  if (explicitModel !== undefined) return { model: explicitModel, reason: 'explicit', capacityBytes: null };
  const bytes = Number.isFinite(stateBytes) ? stateBytes : Number.POSITIVE_INFINITY;
  // 非有限的 softBytes 一律当「没有阈值信息」：否则 `bytes <= NaN` 恒为 false，会把小材料
  // 直接推进阶梯（与 resolveSoftBodyBytes 对非有限值的处理同一取向）。
  const fit = Number.isFinite(softBytes) ? softBytes : Number.NaN;
  if (Number.isFinite(fit) && bytes <= fit) return { model: defaultModel, reason: 'fits-default', capacityBytes: fit };
  const rows = (Array.isArray(ladder) ? ladder : [])
    .filter((entry) => Number.isFinite(entry?.numCtx) && typeof entry?.model === 'string')
    .map((entry) => ({ model: entry.model, capacityBytes: entry.numCtx * bytesPerToken * margin }))
    .sort((left, right) => left.capacityBytes - right.capacityBytes);
  const fits = rows.find((row) => row.capacityBytes >= bytes);
  if (fits !== undefined) return { model: fits.model, reason: 'fits-ladder', capacityBytes: fits.capacityBytes };
  if (rows.length > 0) {
    const largest = rows[rows.length - 1];
    return { model: largest.model, reason: 'largest', capacityBytes: largest.capacityBytes };
  }
  if (typeof stickyModel === 'string') return { model: stickyModel, reason: 'sticky-fallback', capacityBytes: null };
  return { model: defaultModel, reason: 'default-fallback', capacityBytes: Number.isFinite(fit) ? fit : null };
}

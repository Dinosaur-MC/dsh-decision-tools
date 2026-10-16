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
import { ASCII_BYTES_PER_TOKEN } from './density.js';

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
  // **阶梯顺序不参与决策**：先按容量升序，再取「能容纳需求的最小档」（契约：最小可用档）。
  // 旧实现用原序 `find` ⇒ 配置里阶梯乱序时（无任何地方校验顺序）会白跳到远大于所需的档，
  // 付一次冷加载（8 GB 显存上大档可到数百秒）—— task-14 复审 P2-5。
  const larger = ladder
    .filter((entry) => entry.numCtx > currentNumCtx)
    .sort((left, right) => left.numCtx - right.numCtx);
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
 * 单飞闸：**互斥，不共享结果**。同一时刻只有一趟在跑；后来的调用**各自执行**、在队尾排队，
 * 绝不拿前一条的返回值。
 *
 * ⚠️ **不要把这里的语义改回「后来者搭同一趟」**：v2 的旧实现缓存并共享 settled 结果，
 * 于是并发调用里后来者拿到的是**前一条的 answers**（r3 审查 P0：B 应为 0.999 却收到 A 的
 * 0.111，且只发了 3 次请求）。要防的是「并发切换进程内模型」，不是「重复执行」⇒ 正确性
 * 标准是**互斥**、不是**复用结果**；旧实现那批单测恰好把「共享同一次执行」写成了正确性标准
 * —— bug 与断言同源，修它必须同时重写那 4 条断言（本文件 :123-131 记着这段历史）。
 *
 * 为什么必须有：提升决策会**换掉进程内已加载的模型**。两个并发调用各自决策就会互相
 * 拆台（A 要 0.8B → B 提升到 clef → A 再要 0.8B ⇒ 又一次 12 s 冷加载）。
 *
 * 实现：`fn` 在 `tail.then(...)`（微任务）里启动，两次 `run` 之间不留空隙**靠 Promise 链**
 * 而不是同步调用；因此 `pending` 表示「此刻是否真有一趟在跑」—— **`run()` 返回后的同一 tick
 * 内它仍是 `false`**（内层微任务还没起飞），等一个微任务才为 `true`。结算（成功或失败）后立即
 * 释放，下一波可以重新跑；失败只传给**它自己的**调用者，不毒化队列。
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

/**
 * 估算需求用的换算比（字节/token）。取值偏乐观（宁可选小档、靠溢出兜底），依据见 selectByCapacity。
 *
 * **它是遗留兜底，不是主路径**：`lib/tool.js` 每次都传 `density.bytesPerToken(材料)`（英文 3.33 /
 * 中文 2.32），本常量只在「不关心语言密度」的直接调用方缺省时生效。
 *
 * **数值不在这里定义** —— 直接取 `density.js` 的 `ASCII_BYTES_PER_TOKEN`，避免两处各写一个
 * 3.33 而漂移（task-14 复审 P2：density 自称「数值只有这一处来源」）。`test/escalate.test.mjs`
 * 有一条绑定断言：两处不等即红。
 */
export const BYTES_PER_TOKEN = ASCII_BYTES_PER_TOKEN;

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
  // ① 材料字节数**未知**（非有限）⇒ 显式走最大档：保守方向（宁可多付一次冷加载，也不先发小档
  //    再靠溢出重试）。这条从前是「Infinity 恰好让所有比较为假」的副产品，现在写明。
  if (!Number.isFinite(stateBytes)) {
    const ranked = rankLadder({ ladder, bytesPerToken, margin });
    const top = ranked[ranked.length - 1];
    if (top !== undefined) return { model: top.model, reason: 'largest', capacityBytes: top.capacityBytes };
    if (typeof stickyModel === 'string') return { model: stickyModel, reason: 'sticky-fallback', capacityBytes: null };
    return { model: defaultModel, reason: 'default-fallback', capacityBytes: null };
  }
  const bytes = stateBytes;
  // ② 默认档阈值**未知**（非有限 softBytes）⇒ 当「没有阈值信息」：不拿 NaN 去比（`bytes <= NaN`
  //    恒假会把小材料直接推进阶梯），而是**留在默认档**，真装不下时由溢出升档兜底 —— 这正是
  //    A 方案的偏乐观取向。旧实现与这段注释相反（NaN 反而走阶梯）—— task-14 复审 P2-6。
  if (!Number.isFinite(softBytes)) return { model: defaultModel, reason: 'no-threshold-default', capacityBytes: null };
  if (bytes <= softBytes) return { model: defaultModel, reason: 'fits-default', capacityBytes: softBytes };
  // ③ 换算比**未知/非正** ⇒ 阶梯容量不可比（capacityBytes 会是 NaN，排序与比较都失去意义），
  //    故不用阶梯做决策，走粘滞/默认兜底，由真实溢出驱动升档。
  const rows = Number.isFinite(bytesPerToken) && bytesPerToken > 0
    ? rankLadder({ ladder, bytesPerToken, margin })
    : [];
  const fits = rows.find((row) => row.capacityBytes >= bytes);
  if (fits !== undefined) return { model: fits.model, reason: 'fits-ladder', capacityBytes: fits.capacityBytes };
  if (rows.length > 0) {
    const largest = rows[rows.length - 1];
    return { model: largest.model, reason: 'largest', capacityBytes: largest.capacityBytes };
  }
  if (typeof stickyModel === 'string') return { model: stickyModel, reason: 'sticky-fallback', capacityBytes: null };
  return { model: defaultModel, reason: 'default-fallback', capacityBytes: Number.isFinite(softBytes) ? softBytes : null };
}

/** 阶梯 → **容量升序**的可用条目（`numCtx` 非有限、或 `model` 不是字符串的条目一律忽略）。
 *  `bytesPerToken` 必须由调用方保证有限且为正（未知换算比时调用方应传空阶梯）。 */
function rankLadder({ ladder, bytesPerToken, margin }) {
  return (Array.isArray(ladder) ? ladder : [])
    .filter((entry) => Number.isFinite(entry?.numCtx) && typeof entry?.model === 'string')
    .map((entry) => ({ model: entry.model, capacityBytes: entry.numCtx * bytesPerToken * margin }))
    .sort((left, right) => left.capacityBytes - right.capacityBytes);
}

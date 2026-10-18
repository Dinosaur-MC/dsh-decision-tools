import {
  test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ESCALATION_MARGIN,
  DEFAULT_LADDER,
  demandOf,
  selectEscalation,
  createSingleFlight,
  describeExhausted,
  selectByCapacity,
} from '../lib/escalate.js';
// 绑定断言用：与 density 的 ASCII 口径必须逐字相等（复审 P2-4）。
import { BYTES_PER_TOKEN } from '../lib/escalate.js';
import { ASCII_BYTES_PER_TOKEN, softBytesFor } from '../lib/density.js';

/**
 * 测试夹具阶梯（**不是** DEFAULT_LADDER）。用本机 2026-10-15 实测的容量，
 * 另加一档合成的更大容量用于测「越过最大档」与「换下一档」两条分支 ——
 * 现实阶梯只有三档，没有比 32768 更大的真实模型。
 */
const LADDER = [
  { model: 'tev1:0.8b', numCtx: 8192 },
  { model: 'tev1:latest', numCtx: 8192 },
  { model: 'nimble-v3:latest', numCtx: 32768 },
  { model: 'synthetic-wide:latest', numCtx: 65536 },
];

/** 手动可控的 promise，用来把『执行中』这一刻钉住。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('ESCALATION_MARGIN 冻结为 0.6（策略值）', () => {
  assert.equal(ESCALATION_MARGIN, 0.6);
});

test('DEFAULT_LADDER 只含本机实测容量；clef:latest 因超时、nimble:latest 因容量无增益而不入', () => {
  assert.deepEqual(DEFAULT_LADDER.map((entry) => entry.model),
    ['tev1:0.8b', 'tev1:latest', 'clef-flash:latest', 'nimble-v3:latest']);
  assert.equal(DEFAULT_LADDER.find((e) => e.model === 'tev1:0.8b').numCtx, 8192);
  assert.equal(DEFAULT_LADDER.find((e) => e.model === 'clef-flash:latest').numCtx, 16384);
  assert.equal(DEFAULT_LADDER.find((e) => e.model === 'nimble-v3:latest').numCtx, 32768);
  assert.equal(DEFAULT_LADDER.some((e) => e.model === 'clef:latest'), false,
    '27B 在 8 GB 显存上 prefill 21500 B 300 s 未返回，不得进默认阶梯');
  assert.equal(DEFAULT_LADDER.some((e) => e.model === 'nimble:latest'), false,
    'nimble 的 8194 只比 tev1 的 8192 大 2 token ⇒ 溢出时永远选不中（死档），与「是否可用」无关');
});

test('阶梯里每一档都必须真正「比前一档大」——排除 8194 这种 2-token 假提升', () => {
  // 这是上面那条排除规则的**可执行判据**：相邻档位必须能被真的选中。
  // 从 tev1(8192) 溢出 ⇒ 需求 > 8192；选档要求 numCtx × 0.6 ≥ 需求。
  // 8194 × 0.6 = 4916 < 8192 ⇒ nimble:latest 永远不可能被选中。
  const demandJustOver = 8193;
  const nimblePick = selectEscalation({
    ladder: [{ model: 'nimble:latest', numCtx: 8194 }],
    from: 'tev1:0.8b', failure: { actual: demandJustOver }, currentNumCtx: 8192,
  });
  assert.equal(nimblePick.ok, false, '8194 这条 2-token 提升必须选不中（否则它就是个假档）');
  assert.equal(nimblePick.reason, 'exceeds-largest');
  // 而 clef-flash 同条件下必须选得中，证明它是有效档。
  const flashPick = selectEscalation({
    ladder: [{ model: 'clef-flash:latest', numCtx: 16384 }],
    from: 'tev1:0.8b', failure: { actual: demandJustOver }, currentNumCtx: 8192,
  });
  assert.equal(flashPick.ok, true);
  assert.equal(flashPick.entry.model, 'clef-flash:latest');
});

test('demandOf：带数字用实测 actual；缺席或不可用一律回落到当前模型声明容量', () => {
  assert.deepEqual(demandOf({ actual: 47168, limit: 2050 }, 2050), { demand: 47168, source: 'observed' });
  assert.deepEqual(demandOf({ actual: undefined, limit: undefined }, 16384),
    { demand: 16384, source: 'conservative' }, 'B 分支（clef 系）两者都缺席');
  assert.deepEqual(demandOf({ actual: Number.NaN }, 2050), { demand: 2050, source: 'conservative' });
  assert.deepEqual(demandOf({ actual: 0 }, 2050), { demand: 2050, source: 'conservative' });
  assert.deepEqual(demandOf(undefined, 2050), { demand: 2050, source: 'conservative' });
});

test('selectEscalation：跳过不比当前更大的一档（同容量换模型无意义）', () => {
  const picked = selectEscalation({ ladder: LADDER, from: 'tev1:0.8b',
    failure: { actual: 10000, limit: 8192 }, currentNumCtx: 8192 });
  assert.equal(picked.ok, true);
  assert.equal(picked.entry.model, 'nimble-v3:latest', 'tev1:latest 同为 8192，必须被跳过');
  assert.equal(picked.demand, 10000);
  assert.equal(picked.demandSource, 'observed');
});

test('selectEscalation：余量边界取 >=（恰好等于需求时仍选中）', () => {
  const atBoundary = 32768 * ESCALATION_MARGIN;
  const hit = selectEscalation({ ladder: LADDER, from: 'tev1:0.8b',
    failure: { actual: atBoundary }, currentNumCtx: 8192 });
  assert.equal(hit.entry.model, 'nimble-v3:latest');
  const over = selectEscalation({ ladder: LADDER, from: 'tev1:0.8b',
    failure: { actual: atBoundary + 0.1 }, currentNumCtx: 8192 });
  assert.equal(over.entry.model, 'synthetic-wide:latest', '越过 nimble-v3 的余量后必须换下一档');
});

test('selectEscalation：超过最大档 → exceeds-largest，并列出考虑过的档', () => {
  const r = selectEscalation({ ladder: LADDER, from: 'tev1:0.8b',
    failure: { actual: 200000, limit: 8192 }, currentNumCtx: 8192 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exceeds-largest');
  assert.equal(r.demand, 200000);
  assert.deepEqual(r.considered.map((e) => e.model),
    ['nimble-v3:latest', 'synthetic-wide:latest']);
});

test('selectEscalation：已在最大档 → no-larger-entry', () => {
  const r = selectEscalation({ ladder: LADDER, from: 'synthetic-wide:latest',
    failure: { actual: 200000 }, currentNumCtx: 65536 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-larger-entry');
});

test('selectEscalation：阶梯里更小的档即便余量够也不得被选中', () => {
  const shuffled = [
    { model: 'nimble-v3:latest', numCtx: 32768 },
    { model: 'tev1:0.8b', numCtx: 8192 },
    { model: 'synthetic-wide:latest', numCtx: 65536 },
  ];
  // demand 4000：tev1（8192×0.6=4915）本身『够用』，但它比当前 32768 小，必须被排除。
  const r = selectEscalation({ ladder: shuffled, from: 'nimble-v3:latest',
    failure: { actual: 4000 }, currentNumCtx: 32768 });
  assert.equal(r.entry.model, 'synthetic-wide:latest');
  const none = selectEscalation({ ladder: shuffled, from: 'nimble-v3:latest',
    failure: { actual: 50000 }, currentNumCtx: 32768 });
  assert.equal(none.ok, false, '65536×0.6=39321 < 50000，应当失败');
  assert.deepEqual(none.considered.map((e) => e.model), ['synthetic-wide:latest']);
});

test('createSingleFlight：并发调用各自执行，但同一时刻只有一个在跑', async () => {
  const gate = createSingleFlight();
  let running = 0;
  let peak = 0;
  const seen = [];
  const make = (id) => gate.run(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    seen.push(id);
    running -= 1;
    return id;
  });
  const [first, second] = await Promise.all([make('a'), make('b')]);
  assert.deepEqual([first, second], ['a', 'b'],
    '★ 每个调用者必须拿到**自己的**结果（旧实现会共享同一次执行的结果）');
  assert.equal(peak, 1, '互斥：任何时刻只允许一个在跑');
  assert.deepEqual(seen, ['a', 'b'], '顺序与提交顺序一致');
  assert.equal(gate.pending, false, '全部结算后必须释放');
});

test('createSingleFlight：结算后释放，下一波重新执行', async () => {
  const gate = createSingleFlight();
  let calls = 0;
  const run = async () => gate.run(async () => { calls += 1; return calls; });
  assert.equal(await run(), 1);
  assert.equal(await run(), 2, '上一趟结算后必须能重新执行');
  assert.equal(calls, 2);
});

test('createSingleFlight：同步抛错走同一失败路径并释放槽位', async () => {
  const gate = createSingleFlight();
  await assert.rejects(gate.run(() => { throw new Error('sync boom'); }), /sync boom/);
  assert.equal(gate.pending, false, '同步抛错也必须释放槽位');
  assert.equal(await gate.run(async () => 'ok'), 'ok', '释放后仍能执行');
});

test('createSingleFlight：前一个失败只影响它自己，等待者照常执行', async () => {
  const gate = createSingleFlight();
  const boom = gate.run(async () => { throw new Error('boom'); });
  const ok = gate.run(async () => 'second');
  await assert.rejects(boom, /boom/);
  assert.equal(await ok, 'second', '★ 不得把失败传播给等待者（旧实现里第二个任务根本不执行）');
});

test('describeExhausted：统一终态带尝试过的档与失败分类、三条可行动项，且不得指向请求形状', () => {
  // v2 的签名（from/demand/ladder/reason）只描述「为什么选不中」，调用方拿不到「试过哪些档」。
  // 新签名以**实际尝试序列**为准：终态里逐条附上 model 与 failureKind（r7 P0）。
  const attempts = [
    { model: 'tev1:0.8b', failureKind: 'context_overflow' },
    { model: 'clef-flash:latest', failureKind: 'context_overflow' },
  ];
  const err = describeExhausted({ attempts, lastError: { message: '请求超出模型上下文：3000 token，上限 16384。' } });
  assert.equal(err.name, 'SystemOneError');
  assert.equal(err.kind, 'escalation_exhausted');
  assert.deepEqual(err.attempts, attempts, 'attempts 必须逐条带 model 与 failureKind');
  assert.match(err.message, /tev1:0\.8b/);
  assert.match(err.message, /clef-flash:latest/);
  assert.match(err.message, /缩减材料/);
  assert.match(err.message, /Modelfile PARAMETER num_ctx/, '抬高容量只有部署侧一条路');
  assert.match(err.message, /分块扫描/);
  assert.doesNotMatch(err.message, /choice|noul|score|选项数|对象映射/,
    '溢出与请求形状无关，文案不得回落到形状类建议');
  // 空尝试列表也必须能出话（消息里不得出现 undefined）。
  const empty = describeExhausted({ attempts: [] });
  assert.equal(empty.kind, 'escalation_exhausted');
  assert.deepEqual(empty.attempts, []);
  assert.doesNotMatch(empty.message, /undefined/);
});

/** 测试夹具阶梯（**不是** DEFAULT_LADDER）：用本机 2026-10-15 16:34 实测容量。 */
const LADDER3 = [
  { model: 'tev1:0.8b', numCtx: 8192 },
  { model: 'clef-flash:latest', numCtx: 16384 },
  { model: 'nimble-v3:latest', numCtx: 32768 },
];

test('selectByCapacity：显式指定优先（R1）', () => {
  const out = selectByCapacity({ explicitModel: 'x:latest', defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 10, softBytes: 4096 });
  assert.deepEqual(out, { model: 'x:latest', reason: 'explicit', capacityBytes: null });
});

test('selectByCapacity：小材料走默认档（每次省 0.77–1.12 s 的那一支）', () => {
  const out = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 400, softBytes: 4096 });
  assert.equal(out.model, 'tev1:0.8b');
  assert.equal(out.reason, 'fits-default');
  assert.equal(selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 4096, softBytes: 4096 }).reason, 'fits-default', '边界含等号');
});

test('selectByCapacity：大材料直发容量足够的最小档（省掉先吃 400 那一轮）', () => {
  // 可用字节上限 = numCtx × BYTES_PER_TOKEN × margin：
  //   tev1(8192) → 16368 B · clef-flash(16384) → 32735 B · nimble-v3(32768) → 65470 B
  const flash = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 20000, softBytes: 4096 });
  assert.equal(flash.model, 'clef-flash:latest');
  assert.equal(flash.reason, 'fits-ladder');
  // 20000 已越过 tev1 的 16368 B ⇒ 落到 clef-flash；再往上越过 32735 B 才到 nimble-v3
  const v3 = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 40000, softBytes: 4096 });
  assert.equal(v3.model, 'nimble-v3:latest');
  assert.equal(v3.reason, 'fits-ladder');
});

test('selectByCapacity：谁都不够就走最大档；阶梯为空才用粘滞兜底', () => {
  const huge = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 10_000_000, softBytes: 4096 });
  assert.equal(huge.model, 'nimble-v3:latest');
  assert.equal(huge.reason, 'largest');
  const empty = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: [], stateBytes: 5000, softBytes: 4096, stickyModel: 'nimble:latest' });
  assert.equal(empty.model, 'nimble:latest');
  assert.equal(empty.reason, 'sticky-fallback');
  const noSticky = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: [], stateBytes: 5000, softBytes: 4096 });
  assert.equal(noSticky.model, 'tev1:0.8b');
  assert.equal(noSticky.reason, 'default-fallback');
});

test('selectByCapacity：softBytes 由语言密度算出，阶梯各档也用同一密度（ADR-16 / D7）', () => {
  // 中文材料：8192 × 0.6 × 2.32 = 11401 B ⇒ 12000 B 的同类材料越过默认档。
  const softBytes = softBytesFor({ numCtx: 8192, text: '中' });
  assert.equal(softBytes, Math.floor(8192 * 0.6 * 2.32));
  const out = selectByCapacity({
    defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 12000, softBytes, bytesPerToken: 2.32,
  });
  assert.equal(out.reason, 'fits-ladder');
  assert.equal(out.model, 'clef-flash:latest', 'tev1 档按 2.32 只有 11401 B，装不下 12000 B');
  // 同一字节数按英文口径（3.33）默认档就装得下 ⇒ 密度确实改变了判决。
  assert.equal(selectByCapacity({
    defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 12000,
    softBytes: Math.floor(8192 * 0.6 * 3.33), bytesPerToken: 3.33,
  }).model, 'tev1:0.8b');
  // 窗口未知（softBytes 非有限）时不得崩，也不得把「没有阈值信息」当成别的东西。
  assert.equal(selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: 10, softBytes: undefined }).model, 'tev1:0.8b');
});

test('selectByCapacity：容量未知的阶梯条目被忽略；字节数未知按无穷处理', () => {
  const odd = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: [{ model: 'a:latest' }, { model: 'nimble:latest', numCtx: 8194 }], stateBytes: 5000, softBytes: 4096 });
  assert.equal(odd.model, 'nimble:latest', '缺 numCtx 的条目不得被当成候选');
  const nan = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: Number.NaN, softBytes: 4096 });
  assert.equal(nan.reason, 'largest', '字节数未知时保守地走最大档');
});

// ---- task-14 复审 P2 修复的守卫（2026-10-16）----

test('BYTES_PER_TOKEN 只有一个来源：它就是 density 的 ASCII 口径（两处不等即红）', () => {
  // 复审 P2-4：density.js 自称「数值只有这一处来源」，而 escalate 里曾另写一个 3.33。
  // 现在 escalate 直接转发 density 的常量 ⇒ 这条断言就是那条绑定。
  assert.equal(BYTES_PER_TOKEN, ASCII_BYTES_PER_TOKEN);
  assert.equal(BYTES_PER_TOKEN, 3.33);
});

test('selectEscalation：阶梯乱序也必须取**能容纳需求的最小档**（契约：最小可用档）', () => {
  // 复审 P2-5：旧实现用原序 find ⇒ 乱序 [big, mid] 会白跳到大档。
  const big = { model: 'big:latest', numCtx: 16000 };
  const mid = { model: 'mid:latest', numCtx: 4000 };
  const picked = selectEscalation({ ladder: [big, mid], from: 'small:latest',
    failure: { actual: 2000 }, currentNumCtx: 1000, margin: 1 });
  assert.equal(picked.ok, true);
  assert.equal(picked.entry.model, 'mid:latest', '两种顺序必须给同一个答案');
  const flipped = selectEscalation({ ladder: [mid, big], from: 'small:latest',
    failure: { actual: 2000 }, currentNumCtx: 1000, margin: 1 });
  assert.equal(flipped.entry.model, picked.entry.model);
});

test('selectByCapacity：softBytes 非有限 = 没有阈值信息 ⇒ 留在默认档（而不是被 NaN 推进阶梯）', () => {
  // 复审 P2-6：旧实现里 `bytes <= NaN` 恒假 ⇒ 小材料被推进阶梯；注释却说要当「没有阈值信息」。
  // 阶梯里最小的档也**大于**默认档名：旧实现在这里会返回 mid:latest，从而与断言不符。
  const ladder = [{ model: 'mid:latest', numCtx: 4000 }, { model: 'big:latest', numCtx: 16000 }];
  const out = selectByCapacity({ defaultModel: 'small:latest', ladder, stateBytes: 10, softBytes: Number.NaN });
  assert.equal(out.model, 'small:latest');
  assert.equal(out.reason, 'no-threshold-default');
  assert.equal(selectByCapacity({ defaultModel: 'small:latest', ladder, stateBytes: 10, softBytes: undefined }).model, 'small:latest');
});

test('selectByCapacity：换算比非有限 ⇒ 阶梯容量不可比，不得产出 NaN，走粘滞/默认兜底', () => {
  // 复审 P2-6 的另一半：旧实现返回 {reason:'largest', capacityBytes: NaN}（排序也失去意义）。
  const ladder = [{ model: 'mid:latest', numCtx: 4000 }, { model: 'big:latest', numCtx: 16000 }];
  const noSticky = selectByCapacity({ defaultModel: 'small:latest', ladder, stateBytes: 999999, softBytes: 1, bytesPerToken: Number.NaN });
  assert.equal(noSticky.reason, 'default-fallback');
  assert.equal(noSticky.model, 'small:latest');
  assert.ok(noSticky.capacityBytes === null || Number.isFinite(noSticky.capacityBytes), 'NaN 不得泄进 capacityBytes（允许 null 或默认档阈值）');
  const sticky = selectByCapacity({ defaultModel: 'small:latest', ladder, stateBytes: 999999, softBytes: 1, bytesPerToken: Number.NaN, stickyModel: 'sticky:latest' });
  assert.equal(sticky.model, 'sticky:latest');
  assert.equal(sticky.reason, 'sticky-fallback');
});

test('selectByCapacity：字节数未知仍走最大档，但 capacityBytes 必须是有限数（不再是 NaN）', () => {
  const nan = selectByCapacity({ defaultModel: 'tev1:0.8b', ladder: LADDER3, stateBytes: Number.NaN, softBytes: 4096 });
  assert.equal(nan.reason, 'largest');
  assert.ok(Number.isFinite(nan.capacityBytes), 'NaN 不得泄进 capacityBytes');
});

test('createSingleFlight 的公开 JSDoc 必须是「互斥、不共享结果」语义（防止照旧注释复活 r3 P0）', async () => {
  // 复审 P1/任务 task-16 必修 1：注释曾经写「后来者搭同一趟」「fn 同步调用、不丢进微任务」，
  // 与实现（微任务串行互斥）和真源 architecture.md §1.3 第 6 步相反。照那种注释去「修」
  // 就会把并发调用者拿到**别人的 answers** 的 r3 P0 复活 ⇒ 这条守卫读源码把话说死。
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/escalate.js', import.meta.url), 'utf8');
  const head = src.slice(0, src.indexOf('export function createSingleFlight'));
  const doc = head.slice(head.lastIndexOf('/**'));
  assert.match(doc, /互斥，不共享结果/);
  assert.match(doc, /不要.*改回「后来者搭同一趟」/);
  assert.doesNotMatch(doc, /后来的调用搭同一趟/);
  assert.doesNotMatch(doc, /`fn` 是\*\*同步调用\*\*的/);
});

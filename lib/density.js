/**
 * 容量估算的**语言密度**层（ADR-16 / D7）。纯函数、零 import、零 I/O。
 *
 * 为什么单列一层：字节→token 的换算比**不是常数**。r6 实测（本机 2026-10-15，
 * ollama 0.40.4）同长度输入的换算比跨 **1.32–7.15 B/token**，而固定用英文散文口径
 * 3.33 B/token 估算中文/密排文字会**系统性高估**可用容量 —— 中文实测约 **2.32 B/token**。
 *
 * 这里的判据是**确定性推断**（按码点统计 CJK 占比），不做采样、不发请求：
 * 占比 ≥ `CJK_SHARE_THRESHOLD` 时按 2.32 算，否则按 3.33。两个数字都来自实测口径，
 * 数值只有这一处来源。
 *
 * @module dsh-decision-tools/density
 */

/** 中文（密排文字）的实测换算比：字节/token。 */
export const CJK_BYTES_PER_TOKEN = 2.32;
/** 英文散文的实测换算比：字节/token（与 `escalate.BYTES_PER_TOKEN` 同一口径）。 */
export const ASCII_BYTES_PER_TOKEN = 3.33;
/** CJK 占比达到这个值即按密排估算（取 `>=`）。 */
export const CJK_SHARE_THRESHOLD = 0.3;

/**
 * 一个码点是否属于**密排文字**（CJK 统一表意文字及其扩展、CJK 标点、全角形态）。
 *
 * 收标点与全角形态的理由：中文材料里 `，。：；（）` 与全角字母和汉字一样是**多字节单 token**，
 * 只数汉字会让「汉字不多、标点很多」的文本被低估。hiragana/katakana 等日文假名同为密排，
 * 一并纳入（它们的字节密度与汉字同量级）。
 *
 * @param {number} cp 码点
 * @returns {boolean}
 */
function isDenseCodepoint(cp) {
  return (cp >= 0x3000 && cp <= 0x303F)   // CJK 标点
    || (cp >= 0x3040 && cp <= 0x30FF)     // 平假名 / 片假名
    || (cp >= 0x3400 && cp <= 0x4DBF)     // 表意文字扩展 A
    || (cp >= 0x4E00 && cp <= 0x9FFF)     // 表意文字（基本区）
    || (cp >= 0xF900 && cp <= 0xFAFF)     // 兼容表意文字
    || (cp >= 0xFF00 && cp <= 0xFFEF)     // 全角形态
    || (cp >= 0x20000 && cp <= 0x2EBEF)   // 扩展 B–F
    || (cp >= 0x30000 && cp <= 0x3134F);  // 扩展 G
}

/**
 * 密排码点占比。按**码点**统计（`for...of` 迭代，代理对算一个）。
 *
 * 非字符串输入一律按空串处理（调用方对结构化材料没有可估的密度，交给字节数的无穷大分支）。
 *
 * @param {unknown} text 材料
 * @returns {number} 0..1；空串为 0
 */
export function cjkShare(text) {
  if (typeof text !== 'string' || text === '') return 0;
  let dense = 0;
  let total = 0;
  for (const character of text) {
    total += 1;
    if (isDenseCodepoint(character.codePointAt(0))) dense += 1;
  }
  return total === 0 ? 0 : dense / total;
}

/**
 * 本次材料的换算比（字节/token）。
 * @param {unknown} text 材料
 * @returns {number} 2.32（密排）或 3.33（英文散文口径）
 */
export function bytesPerToken(text) {
  return cjkShare(text) >= CJK_SHARE_THRESHOLD ? CJK_BYTES_PER_TOKEN : ASCII_BYTES_PER_TOKEN;
}

/**
 * 「按窗口算出的软字节阈值」：`窗口 × 余量 × 密度`，向下取整。
 *
 * **返回 undefined 是刻意信号**：窗口未知（阶梯里没有默认档、或调用方没给数字）时，
 * 调用方应回落到 `LIMITS.softBodyBytes` 这个固定常量，而不是拿 NaN 去比较
 * （与 `resolveSoftBodyBytes` 对非有限值的处理同一取向）。
 *
 * @param {object} input
 * @param {number|undefined} input.numCtx 生效窗口（token）
 * @param {number} [input.margin] 余量，缺省与 `ESCALATION_MARGIN` 同值 0.6
 * @param {unknown} input.text 材料（用于判密度）
 * @returns {number|undefined} 阈值（字节）；窗口未知时为 undefined
 */
export function softBytesFor({ numCtx, margin = 0.6, text } = {}) {
  if (!Number.isFinite(numCtx) || numCtx <= 0) return undefined;
  if (!Number.isFinite(margin) || margin <= 0) return undefined;
  return Math.floor(numCtx * margin * bytesPerToken(text));
}

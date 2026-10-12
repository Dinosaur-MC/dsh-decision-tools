/**
 * 引用式 `state`（ADR-7）的**纯逻辑**：描述符校验、行范围切片、语义边界分块。
 *
 * 零依赖、零 I/O：**读盘在 `lib/tool.js`**（经 `ctx.fs`）。这样路径安全策略（工作区根
 * containment、符号链接拒绝、字节上限）留在唯一接触 `ctx` 的那一层，而切分算法可以
 * 独立测试，也便于将来被 CLI 或评测装置直接复用（规格 §5 的边界原则）。
 *
 * @module dsh-decision-tools/source
 */

/**
 * 引用式 state 的形状/越界错误。`kind` 是稳定判据：
 *   `invalid_request`     —— 描述符本身不合法（本地、发请求前）
 *   `source_missing`      —— 目标不存在（由 tool 层的 fs 阶段抛出）
 *   `source_outside_root` —— 逃出工作区根（由 tool 层的 containment 抛出）
 *   `source_too_large`    —— 单份材料超过字节上限（由 tool 层抛出）
 *
 * 后三种在 `lib/tool.js` 里构造（那里才有 `ctx.fs`），本文件只保证类与判据的唯一出处。
 */
export class DecisionSourceError extends Error {
  /**
   * @param {string} message 面向模型的可行动信息
   * @param {{ kind?: string }} [info] 判据
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DecisionSourceError';
    this.kind = info.kind ?? 'invalid_request';
  }
}

const KINDS = new Set(['file', 'glob']);
const FILE_KEYS = new Set(['kind', 'path', 'startLine', 'endLine']);
const GLOB_KEYS = new Set(['kind', 'pattern', 'limit']);

/** @param {string} message @returns {never} */
function fail(message) {
  throw new DecisionSourceError(message);
}

/**
 * 判定一个路径是否**不安全**：绝对路径（POSIX `/`、Windows 盘符、UNC `\\`）或含 `..` 段。
 *
 * 这是**第一道**闸（纯字符串，发请求前）；第二道闸是 tool 层用 `ctx.fs.contains` 做的工作区根
 * containment，第三道是 `lstat` 在 follow 之前拒绝符号链接。三道都必要：字符串检查挡不住
 * 符号链接，containment 挡不住 `..` 造成的语义歧义。
 *
 * @param {string} path 待判定路径
 * @returns {boolean} 是否不安全
 */
export function isUnsafePath(path) {
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

/**
 * 取一个可选的 ≥ 1 整数；未设返回 undefined，非法即报错。
 * @param {unknown} value 待校验值
 * @param {string} at 报错时用的字段路径
 * @returns {number|undefined}
 */
function positiveInt(value, at) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) {
    fail(`${at} 必须是 ≥ 1 的整数（收到 ${JSON.stringify(value)}）。`);
  }
  return value;
}

/**
 * 校验并规范化 `stateSource` 描述符。**只接受工作区根内的相对路径**，未知键一律拒绝
 * （纵深防御：宿主的 DSL 已经拒了未知键，但本模块也会被直接调用）。
 *
 * @param {unknown} descriptor 模型给的 `stateSource`
 * @returns {{ kind: 'file', path: string, startLine?: number, endLine?: number }
 *   | { kind: 'glob', pattern: string, limit?: number }} 规范化后的描述符
 * @throws {DecisionSourceError} 形状或路径不安全
 */
export function validateSourceDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fail('stateSource 必须是对象（file{path,startLine?,endLine?} 或 glob{pattern,limit?}）。');
  }
  const kind = descriptor.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    fail(`stateSource.kind 只允许 file 或 glob（收到 ${JSON.stringify(kind)}）。`);
  }
  const allowed = kind === 'file' ? FILE_KEYS : GLOB_KEYS;
  for (const key of Object.keys(descriptor)) {
    if (!allowed.has(key)) fail(`stateSource（${kind}）不认识键 ${key}。`);
  }
  if (kind === 'file') {
    const path = descriptor.path;
    if (typeof path !== 'string' || path.trim() === '') fail('stateSource.path 必须是非空字符串。');
    if (isUnsafePath(path)) {
      fail(`stateSource.path 必须是工作区根内的相对路径（拒绝绝对路径与 .. 段）：${path}`);
    }
    const startLine = positiveInt(descriptor.startLine, 'stateSource.startLine');
    const endLine = positiveInt(descriptor.endLine, 'stateSource.endLine');
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      fail(`stateSource.endLine（${endLine}）不得小于 startLine（${startLine}）。`);
    }
    return {
      kind,
      path,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    };
  }
  const pattern = descriptor.pattern;
  if (typeof pattern !== 'string' || pattern.trim() === '') fail('stateSource.pattern 必须是非空字符串。');
  if (isUnsafePath(pattern)) {
    fail(`stateSource.pattern 必须是工作区根内的相对 glob（拒绝绝对路径与 .. 段）：${pattern}`);
  }
  const limit = positiveInt(descriptor.limit, 'stateSource.limit');
  return { kind, pattern, ...(limit === undefined ? {} : { limit }) };
}

/**
 * 按 **1-based 闭区间**切行。越界**报错**，绝不静默截断 —— 静默截断会让调用方以为
 * 「整段都看过了」，那是比报错坏得多的失败模式。
 *
 * @param {string} text 完整文本
 * @param {number} [startLine] 起始行（含），缺省 1
 * @param {number} [endLine] 结束行（含），缺省末行
 * @returns {{ text: string, startLine: number, endLine: number, lines: number }}
 * @throws {DecisionSourceError} 区间越界或反向
 */
export function sliceByLines(text, startLine, endLine) {
  const lines = text.split('\n');
  const total = lines.length;
  const from = startLine === undefined ? 1 : startLine;
  const to = endLine === undefined ? total : endLine;
  if (!Number.isInteger(from) || from < 1 || from > total) {
    fail(`startLine ${from} 越界：该文件共 ${total} 行。`);
  }
  if (!Number.isInteger(to) || to < from || to > total) {
    fail(`endLine ${to} 越界：该文件共 ${total} 行（startLine = ${from}）。`);
  }
  return { text: lines.slice(from - 1, to).join('\n'), startLine: from, endLine: to, lines: total };
}

const HEADING_RE = /^ {0,3}#{1,6}\s/;

/**
 * 一行是否是可用的**语义边界**：空行或 Markdown 标题。分块优先停在这里，
 * 因为「按字节切」会把一个句子劈成两半，判定质量会跟着掉。
 * @param {string} line 单行
 * @returns {boolean}
 */
function isBoundaryLine(line) {
  return line.trim() === '' || HEADING_RE.test(line);
}

/**
 * 单行本身超预算时的字节硬切：二分找最长前缀，保证每片都不超预算且**不丢字符**。
 * @param {string} text 超预算文本
 * @param {number} budgetBytes 预算（字节）
 * @returns {string[]} 片段
 */
function hardSplit(text, budgetBytes) {
  const pieces = [];
  let rest = text;
  while (Buffer.byteLength(rest, 'utf8') > budgetBytes) {
    let lo = 1;
    let hi = rest.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(rest.slice(0, mid), 'utf8') <= budgetBytes) lo = mid;
      else hi = mid - 1;
    }
    pieces.push(rest.slice(0, lo));
    rest = rest.slice(lo);
  }
  if (rest !== '') pieces.push(rest);
  return pieces;
}

/**
 * 把文本切成若干块。**顺序保证**：块按原文顺序、块名 `c1..cN`（不是纯数字 —— 题名/键名
 * 为纯数字会被 JS 对象重排，本仓 V2 已拒），块内行区间互不重叠、并集覆盖已发出的部分。
 *
 * 三条预算是**硬限**：`budgetBytes`（单块）、`maxChunks`（块数）、`maxTotalBytes`（累计字节）。
 * 触顶不报错，而是**返回部分结果**并置 `truncated = true`、给出 `remaining`（未发出的行数）——
 * 扫描场景需要「拿到多少算多少」，这与单文件超限必须报错是两种不同的越限语义（§3.1）。
 *
 * @param {string} text 完整文本
 * @param {{ budgetBytes: number, maxChunks?: number, maxTotalBytes?: number }} options 预算
 * @returns {{ chunks: { name: string, text: string, startLine: number, endLine: number, bytes: number }[],
 *   truncated: boolean, remaining: number, totalBytes: number }}
 * @throws {DecisionSourceError} `budgetBytes` 非法（不猜默认值）
 */
export function chunk(text, options = {}) {
  const budgetBytes = options.budgetBytes;
  if (!Number.isInteger(budgetBytes) || budgetBytes < 1) {
    fail(`budgetBytes 必须是 ≥ 1 的整数（收到 ${JSON.stringify(budgetBytes)}）。`);
  }
  const maxChunks = options.maxChunks === undefined ? Number.POSITIVE_INFINITY : options.maxChunks;
  const maxTotalBytes = options.maxTotalBytes === undefined ? Number.POSITIVE_INFINITY : options.maxTotalBytes;
  const chunks = [];
  let totalBytes = 0;
  /** 截断原因：`chunks`（块数触顶）/ `totalBytes`（累计字节触顶）/ null（未截断）。 */
  let truncatedBy = null;
  if (text === '') return { chunks, truncated: false, remaining: 0, totalBytes, truncatedBy };
  const lines = text.split('\n');
  let i = 0;
  let truncated = false;
  while (i < lines.length) {
    if (chunks.length >= maxChunks) {
      truncated = true;
      truncatedBy = 'chunks';
      break;
    }
    let j = i;
    let bytes = 0;
    while (j < lines.length) {
      const cost = Buffer.byteLength(lines[j], 'utf8') + (j > i ? 1 : 0);
      if (j > i && bytes + cost > budgetBytes) break;
      bytes += cost;
      j += 1;
    }
    if (j < lines.length) {
      let cut = -1;
      for (let k = i; k < j; k += 1) if (isBoundaryLine(lines[k])) cut = k + 1;
      if (cut > i && cut < j) j = cut;
    }
    const block = lines.slice(i, j).join('\n');
    const blockBytes = Buffer.byteLength(block, 'utf8');
    const name = `c${chunks.length + 1}`;
    if (blockBytes > budgetBytes) {
      for (const piece of hardSplit(block, budgetBytes)) {
        const pieceBytes = Buffer.byteLength(piece, 'utf8');
        if (totalBytes + pieceBytes > maxTotalBytes) {
          truncated = true;
          truncatedBy = 'totalBytes';
          break;
        }
        totalBytes += pieceBytes;
        chunks.push({ name: `c${chunks.length + 1}`, text: piece, startLine: i + 1, endLine: j, bytes: pieceBytes });
      }
      if (truncated) break;
      i = j;
      continue;
    }
    if (totalBytes + blockBytes > maxTotalBytes) {
      truncated = true;
      truncatedBy = 'totalBytes';
      break;
    }
    totalBytes += blockBytes;
    chunks.push({ name, text: block, startLine: i + 1, endLine: j, bytes: blockBytes });
    i = j;
  }
  return { chunks, truncated, remaining: lines.length - i, totalBytes, truncatedBy };
}

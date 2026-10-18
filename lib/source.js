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
  // 含 NUL 的路径会让后端抛裸 TypeError（r2 审查 P2），在本地先当不安全拒掉。
  if (typeof path !== 'string' || path.includes('\u0000')) return true;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.startsWith('/')) return true;
  if (/^[a-zA-Z]:/.test(normalized)) return true;
  return normalized.split('/').some((segment) => segment === '..');
}

/** 上游 System One 支持的图片扩展名（大小写不敏感；magic 仍是最终判据）。 */
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);

/**
 * 路径是否看起来是图片。**只用于文案与提前分流**：真正的格式判定在 tool.js
 * 读盘后按 magic bytes 做（扩展名可以撒谎）。
 * @param {unknown} path 路径
 * @returns {boolean}
 */
export function isImagePath(path) {
  if (typeof path !== 'string') return false;
  const match = /\.([A-Za-z0-9]+)$/.exec(path.trim());
  return match !== null && IMAGE_EXTENSIONS.includes(match[1].toLowerCase());
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
 * 校验并规范化**引用式 `material`** 的描述符。**只接受工作区根内的相对路径**，未知键一律拒绝
 * （纵深防御：宿主的 DSL 已经拒了未知键，但本模块也会被直接调用）。
 *
 * **文案纪律（2026-10-16 task-18）**：本文件所有 `fail(...)` 文案都是**模型可见**的（会进
 * `DecisionSourceError.message`），必须只称 v3 的公开参数路径 `material.file.*` / `material.glob.*`；
 * v2 的 `stateSource` 参数**已不存在**，文案里再出现它，模型照报错去改参只会再失败一次。
 * 守卫见 `test/source.test.mjs` 的「模型可见文案不得出现 stateSource」。
 *
 * @param {unknown} descriptor 归一后的描述符（由 `validate.normalizeMaterial` 从模型给的
 *   `material:{file:{...}}` / `material:{glob:{...}}` 转成 `{kind, ...fields}`）
 * @returns {{ kind: 'file', path: string, startLine?: number, endLine?: number }
 *   | { kind: 'glob', pattern: string, limit?: number }} 规范化后的描述符
 * @throws {DecisionSourceError} 形状或路径不安全
 */
export function validateSourceDescriptor(descriptor) {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    fail('material 必须是字符串（内联材料），或 {file:{path,startLine?,endLine?}} / {glob:{pattern,limit?}} 对象（收到非对象）。');
  }
  const kind = descriptor.kind;
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    fail(`引用式 material 只能给 file 或 glob 之一（收到 kind=${JSON.stringify(kind)}）。`);
  }
  const allowed = kind === 'file' ? FILE_KEYS : GLOB_KEYS;
  for (const key of Object.keys(descriptor)) {
    if (!allowed.has(key)) fail(`material.${kind} 不认识键 ${key}。`);
  }
  if (kind === 'file') {
    const path = descriptor.path;
    if (typeof path !== 'string' || path.trim() === '') fail('material.file.path 必须是非空字符串（工作区相对路径）。');
    if (isUnsafePath(path)) {
      fail(`material.file.path 必须是工作区根内的相对路径（拒绝绝对路径与 .. 段）：${path}`);
    }
    const startLine = positiveInt(descriptor.startLine, 'material.file.startLine');
    const endLine = positiveInt(descriptor.endLine, 'material.file.endLine');
    if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
      fail(`material.file.endLine（${endLine}）不得小于 startLine（${startLine}）。`);
    }
    return {
      kind,
      path,
      ...(startLine === undefined ? {} : { startLine }),
      ...(endLine === undefined ? {} : { endLine }),
    };
  }
  const pattern = descriptor.pattern;
  if (typeof pattern !== 'string' || pattern.trim() === '') fail('material.glob.pattern 必须是非空字符串（如 docs/*.md）。');
  if (isUnsafePath(pattern)) {
    fail(`material.glob.pattern 必须是工作区根内的相对 glob（拒绝绝对路径与 .. 段）：${pattern}`);
  }
  const limit = positiveInt(descriptor.limit, 'material.glob.limit');
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
 * 把文本切成若干块。**顺序保证**：块按原文顺序、块名 `c1..cN`（不是纯数字 —— 题名/键名为纯数字
 * 会被 JS 对象重排，本仓 V2 已拒）。
 *
 * **行区间与字节区间（2026-10-16 复审 P2-2 澄清：旧注释笼统地说「不重叠」是不准的）**：
 * - 正常路径：每块 `startLine..endLine` **互不重叠**、并集覆盖已发出的行；
 * - 单行超预算时走 `hardSplit`：**同一行**被切成若干**字节碎片**，它们的 `startLine/endLine` 相同
 *   （同一行内的不同字节段，这一行没有更细的行粒度）⇒ 此时按行区间**无法区分碎片**；
 *   要精确定位必须用每块的 `byteStart/byteEnd`（在入参 `text` 里的字节区间，碎片间不重叠、无空隙），
 *   并用 `part = { index, total }` 得知这是第几个碎片。
 *
 * 三条预算是**硬限**：`budgetBytes`（单块）、`maxChunks`（块数）、`maxTotalBytes`（累计字节）。
 * 触顶不报错，而是**返回部分结果**并置 `truncated = true`、`truncatedBy`（`chunks` / `totalBytes` / null）
 * 与 `remaining`（**未完整发出的行数**：正常路径 = 剩余行；被硬切的整行**算 1 行**，不按碎片数计）——
 * 扫描场景需要「拿到多少算多少」，这与单文件超限必须报错是两种不同的越限语义（§3.1）。
 * ⚠️ 消费方若用 `Σ(endLine - startLine + 1)` 估「还剩多少行」，在 `hardSplit` 路径上会**高估**
 * （每个碎片都算 1 行）：`lib/scan.js` 的 remaining 累加正是这一种，需按碎片去重或改用字节区间。
 *
 * @param {string} text 完整文本
 * @param {{ budgetBytes: number, maxChunks?: number, maxTotalBytes?: number }} options 预算
 * @returns {{ chunks: { name: string, text: string, startLine: number, endLine: number,
 *     byteStart: number, byteEnd: number, bytes: number, part?: { index: number, total: number } }[],
 *   truncated: boolean, truncatedBy: string|null, remaining: number, totalBytes: number }}
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
  /** 每行在 `text` 里的**字节起点**：给块/碎片标注精确字节区间（硬切时行粒度不够用）。 */
  const lineByteStart = new Array(lines.length);
  { let acc = 0; for (let k = 0; k < lines.length; k += 1) { lineByteStart[k] = acc; acc += Buffer.byteLength(lines[k], 'utf8') + 1; } }
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
      // 硬切只在「首行本身超预算」时发生 ⇒ 该块恒为 1 行（j === i + 1），碎石间的行区间相同，
      // 故**用字节区间区分**（见函数文档）。
      const pieces = hardSplit(block, budgetBytes);
      let cursor = 0;
      for (const [pieceIndex, piece] of pieces.entries()) {
        // **hardSplit 分支也必须守 maxChunks**：外层 while 只在每块开头检查一次，单行超 budget 的
        // 块会在这一支里一次推入 hardSplit 的全部碎片 ⇒ 旧实现让 maxChunks 完全失效
        // （r3 审查 P0#2：单行 200 KB + budget 4096 + maxChunks 32 实得 49 块 / 49 次请求，
        // 且 truncated=false 让调用方以为材料是完整的）。
        if (chunks.length >= maxChunks) {
          truncated = true;
          truncatedBy = 'chunks';
          break;
        }
        const pieceBytes = Buffer.byteLength(piece, 'utf8');
        if (totalBytes + pieceBytes > maxTotalBytes) {
          truncated = true;
          truncatedBy = 'totalBytes';
          break;
        }
        totalBytes += pieceBytes;
        chunks.push({
          name: `c${chunks.length + 1}`,
          text: piece,
          startLine: i + 1,
          endLine: j,
          byteStart: lineByteStart[i] + cursor,
          byteEnd: lineByteStart[i] + cursor + pieceBytes,
          part: { index: pieceIndex + 1, total: pieces.length },
          bytes: pieceBytes,
        });
        cursor += pieceBytes;
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
    chunks.push({
      name, text: block, startLine: i + 1, endLine: j,
      byteStart: lineByteStart[i], byteEnd: lineByteStart[i] + blockBytes,
      bytes: blockBytes,
    });
    i = j;
  }
  return { chunks, truncated, remaining: lines.length - i, totalBytes, truncatedBy };
}

/**
 * 把一个**相对 glob 模式**拆成「起始目录 + 逐段模式」。
 *
 * 规则：按 `/` 分段；从首段起，**连续不含通配符**的段并入起始目录（它们就是路径前缀）；`**` 表示
 * 任意深度（含零层）。整条模式都没有通配符时 `segments` 为空 —— 那是**纯字面路径**，调用方
 * 应当直接按 file 读，而不是当 glob 走目录遍历。
 *
 * @param {string} pattern 工作区根内的相对 glob（`isUnsafePath` 已在描述符校验里把关）
 * @returns {{ base: string, segments: string[] }} 起始目录（相对，可能为空串）与剩余段
 */
export function splitGlobPattern(pattern) {
  const parts = pattern.split('/').filter((segment) => segment !== '');
  const base = [];
  let index = 0;
  while (index < parts.length && !/[*?]/.test(parts[index])) {
    base.push(parts[index]);
    index += 1;
  }
  return { base: base.join('/'), segments: parts.slice(index) };
}

/**
 * 单段 glob → 正则：`*` 匹配**段内**任意字符（**不跨 `/`**，因为段已经被 `/` 切开），`?` 匹配单个
 * 段内字符，其余字符一律转义（`.`、`(`、`+` 等在文件名里合法，不能当正则元字符）。
 *
 * @param {string} segment 单段模式
 * @returns {RegExp} 锚定的整段匹配
 */
export function globSegmentToRegExp(segment) {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${escaped}$`);
}

/**
 * 段级匹配（大小写敏感，与 Windows 之外的直觉一致；工作区里同时存在 `README.md` 与 `readme.md`
 * 时不做大小写折叠，宁可少匹配也不错匹配）。
 *
 * @param {string} segment 单段模式
 * @param {string} name 目录项 basename
 * @returns {boolean}
 */
export function matchGlobSegment(segment, name) {
  return globSegmentToRegExp(segment).test(name);
}

/**
 * 该模式是否需要递归下降（含 `**`）。
 * @param {string[]} segments `splitGlobPattern` 的 `segments`
 * @returns {boolean}
 */
export function isRecursiveGlob(segments) {
  return segments.includes('**');
}
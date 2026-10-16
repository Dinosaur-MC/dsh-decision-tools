/**
 * 上游委托管道（规格 §5）：委托执行上游工具 → 取原始输出 → 无条件转储 → 交给判定内核。
 *
 * 本模块**只碰 `ctx.tools`**（其余是纯函数 + 同步 fs）。三条硬约束都是本机整实例真跑踩出来的：
 *
 * 1. **委托必须同时带 `agent` 与 `parent`**（`agent: exec.agent` / `parent: exec.token`）。
 *    不带 `agent` 时，插件 apply 拿到的是无 scope 的全局视图 ⇒ 只注册在 agent/预设作用域里的
 *    工具名报 `unknown tool`（`UNKNOWN_TOOL`）；不带 `parent` 时模型面 `content` 会被
 *    spill-policy 截断（200 KB 实测 49931 B vs 带 parent 的 199994 B），而 `value` 始终完整。
 * 2. **`isError:true` 不 throw**：`ctx.tools.execute` 返回判别联合；宿主对「名字不存在」与
 *    「被禁用」返回**同形**结果（都是 `unknown tool` + `UNKNOWN_TOOL`）⇒ 文案必须写成
 *    「不存在或被禁用」，否则模型会照报错去改一个不存在的工具名。
 * 3. **`exec.signal` 原样转发**：宿主超时是**协作式**的（不抢占函数体），上游忽略 signal 时
 *    必须由我们自己在 `timeoutMs` 返回，否则工具调用会挂死。
 * 4. **对宿主对象的属性探测必须 probe-safe**：真实 `ctx` 是 Cordis 代理，读**没有 inject 的服务
 *    属性会抛**（`cannot get property "X" without inject`）而不是返回 undefined ⇒ 见 `probeProperty`。
 *
 * 禁递归由两层负责：静态层在 `lib/validate.js` 的 `validateUpstream`（自递归 + `arguments`
 * 里再塞 `upstream`），**运行期深度计数**在本文件（上游工具自己又委托回本插件）。
 *
 * @module dsh-decision-tools/pipe
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DecisionValidationError, UPSTREAM_SELF_TOOLS } from './validate.js';

/** 委托嵌套深度上限（层）。1 层 = 一次 `decision` 调用最多委托执行一个上游工具。 */
export const MAX_DELEGATION_DEPTH = 1;

/** 转储文件的 sha256 前缀长度（十六进制字符）。 */
export const SHA256_PREFIX_CHARS = 16;

/** 单文件转储上限的默认值（字节）。调用方可用 `maxBytes` 覆盖；目录总量上限由调用方（Config）管。 */
export const DEFAULT_SPILL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * 管道自身的错误（转储、读取器、取不到工具服务）。`kind` 是稳定判据。
 * 调用方给错参数（上游工具名、深度、arguments 形状）抛的是 `DecisionValidationError`
 * —— 与 `validateUpstream` 同一类，免得上一层要分两处接。
 */
export class DecisionPipeError extends Error {
  /**
   * @param {string} message 面向模型或运维的可行动信息
   * @param {{ kind?: string }} [info] 判据
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'DecisionPipeError';
    this.kind = typeof info.kind === 'string' && info.kind !== '' ? info.kind : 'pipe_error';
  }
}

const NUL = String.fromCharCode(0);
const BACKSLASH = String.fromCharCode(92);
const LF = String.fromCharCode(10);

/**
 * 正在进行的委托（`callId` 前缀链 + `rootCallId`）。进程级状态，进出成对，结束后删除。
 * @type {Set<{ callId: string, rootCallId: string, level: number }>}
 */
const activeDelegations = new Set();
let delegationSeq = 0;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

function errorText(error) {
  if (isPlainObject(error) && typeof error.code === 'string' && error.code !== '') return error.code;
  if (isPlainObject(error) && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * 安全读一个**宿主对象**的属性。**这不是防御脏数据，是平台语义**：
 *
 * 真实宿主的 `ctx` 是 Cordis 的 reflect 代理，而**没有 `inject` 的服务属性在读的时候就抛**
 * （`cannot get property "X" without inject`），**不返回 undefined**。实测事故：
 * `decision({material:{tool:…}})` 在真机上直接失败在这条路径 —— 旧 `resolveTools` 先探
 * `ctx.execute`（本插件没 inject `execute`），一进入就抛，连下面 `ctx.tools` 那条合法分支都
 * 走不到。⇒ 任何对未知宿主对象的属性探测都必须包在这里；**优先读自己 inject 过的服务**，
 * 拿不到才退到「ctx 本身即服务」的兜底，且兜底同样 probe-safe。
 */
function probeProperty(target, key) {
  if (target === null || typeof target !== 'object') return undefined;
  try {
    return target[key];
  } catch {
    return undefined;
  }
}

/**
 * 取工具服务。插件 `apply` 时 `ctx.get('tools')` 可能是 undefined（工具服务未就绪），
 * 所以这里在**执行期**取，并且同时接受「插件 ctx」与「工具服务本身」两种形态（后者便于单测）。
 *
 * **分支顺序是有意的**：先 `ctx.tools`（`tools` 在本插件 `inject` 里，是合法访问），再兜底
 * 「`ctx` 本身即工具服务」。两处探测一律经 `probeProperty`（Cordis 代理会抛，见其注释）。
 *
 * @throws {DecisionPipeError} kind `pipe_unavailable`
 */
function resolveTools(ctx) {
  const injected = probeProperty(ctx, 'tools');
  if (injected !== null && injected !== undefined && typeof probeProperty(injected, 'execute') === 'function') {
    return injected;
  }
  if (typeof probeProperty(ctx, 'execute') === 'function') return ctx;
  throw new DecisionPipeError(
    '取不到工具服务（ctx.tools.execute 不是函数）：上游委托管道不可用。本插件应在 inject 里声明 tools。',
    { kind: 'pipe_unavailable' },
  );
}

/**
 * 这次工具调用处在委托链的第几层（顶层模型直呼 = 0）。
 *
 * 宿主允许调用方自定 `callId`，而实测的约定是**父调用的 callId 作为子调用 callId 的前缀**
 * （`call_X` → `call_X:dlg:1` → `call_X:dlg:1:dlg:2`）。前缀链是精确判据；
 * 另加一条**保守兜底**：本次派发带 `parent`（说明它是嵌套子派发）且同一 `rootCallId` 上有活跃
 * 委托时，按更深一层处理 —— fail-closed，宁可拒绝也不冒无限递归的风险。
 */
function delegationLevel(exec) {
  const callId = typeof exec.callId === 'string' ? exec.callId : '';
  let level = 0;
  for (const entry of activeDelegations) {
    if (callId === '') continue;
    if (callId === entry.callId) level = Math.max(level, entry.level);
    else if (callId.startsWith(entry.callId + ':')) level = Math.max(level, entry.level + 1);
  }
  if (level === 0 && exec.parent !== undefined) {
    const rootCallId = stringOr(exec.rootCallId, stringOr(exec.callId, ''));
    for (const entry of activeDelegations) {
      if (entry.rootCallId === rootCallId) level = Math.max(level, entry.level + 1);
    }
  }
  return level;
}

/** @throws {DecisionValidationError} kind `upstream_invalid` / `upstream_self_recursion` */
function requireUpstreamTool(upstream, options) {
  const tool = isPlainObject(upstream) ? upstream.tool : undefined;
  if (typeof tool !== 'string' || tool.trim() === '') {
    throw new DecisionValidationError(
      'upstream.tool 必须是非空字符串（要委托执行的工具名，与模型可见的工具同名）。',
      { kind: 'upstream_invalid' },
    );
  }
  const name = tool.trim();
  const selfToolNames = Array.isArray(options.selfToolNames) ? options.selfToolNames : UPSTREAM_SELF_TOOLS;
  if (selfToolNames.includes(name)) {
    throw new DecisionValidationError(
      '不能把 ' + name + ' 委托给 ' + name + '：自递归没有宿主护栏（实测会一路递归到进程被杀），要链式判定请分两次调用。',
      { kind: 'upstream_self_recursion' },
    );
  }
  return name;
}

/** @throws {DecisionValidationError} kind `upstream_invalid` */
function upstreamArguments(upstream) {
  const args = isPlainObject(upstream) ? upstream.arguments : undefined;
  if (args === undefined) return {};
  if (!isPlainObject(args)) {
    throw new DecisionValidationError('upstream.arguments 必须是对象（宿主只把工具参数交给上游）。', { kind: 'upstream_invalid' });
  }
  return { ...args };
}

/** 进程型工具的规范值形状：`{ kind, exitCode, stdout:{text,truncated,spillPath?}, stderr:{...} }`。 */
function isProcessValue(value) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') return false;
  return isPlainObject(value.stdout) || isPlainObject(value.stderr);
}

/** 流被 executor 层截断时宿主会给转储路径（只在这时才有全文可取）。 */
function pickSpillPath(stream) {
  if (!isPlainObject(stream) || stream.truncated !== true) return undefined;
  const spillPath = stream.spillPath;
  return typeof spillPath === 'string' && spillPath.trim() !== '' ? spillPath : undefined;
}

function serializeValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    const text = JSON.stringify(value, null, 2);
    return typeof text === 'string' ? text : String(value);
  } catch {
    return String(value);
  }
}

/**
 * 取上游工具的原始输出。**普通工具取 `value`**（规范值，永远完整）；**进程型**取
 * `value.stdout.text`（+ stderr），并把宿主的转储路径与截断标记一并带出来。
 */
function extractOutput(value) {
  if (isProcessValue(value)) {
    const stdout = isPlainObject(value.stdout) ? value.stdout : {};
    const stderr = isPlainObject(value.stderr) ? value.stderr : {};
    const outText = typeof stdout.text === 'string' ? stdout.text : '';
    const errText = typeof stderr.text === 'string' ? stderr.text : '';
    const raw = errText === '' ? outText : (outText === '' ? errText : outText + LF + errText);
    const extracted = { raw, truncated: stdout.truncated === true || stderr.truncated === true };
    if (Number.isInteger(value.exitCode)) extracted.exitCode = value.exitCode;
    const spillPath = pickSpillPath(stdout) === undefined ? pickSpillPath(stderr) : pickSpillPath(stdout);
    if (spillPath !== undefined) extracted.spillPath = spillPath;
    return extracted;
  }
  return { raw: serializeValue(value) };
}

function upstreamErrorCode(error) {
  const info = isPlainObject(error) ? error.info : undefined;
  if (isPlainObject(info) && typeof info.code === 'string' && info.code !== '') return info.code;
  if (isPlainObject(error) && typeof error.code === 'string' && error.code !== '') return error.code;
  return 'TOOL_ERROR';
}

/** 把宿主的失败结果翻成可行动的 `{ code, message }`；未知与被禁用**必须同形描述**。 */
function describeUpstreamError(error, tool) {
  const code = upstreamErrorCode(error);
  switch (code) {
    case 'UNKNOWN_TOOL':
      return { code, message: '上游工具 "' + tool + '" 不存在或被禁用（宿主对「未注册」与「被禁用」返回同形结果：unknown tool）。' };
    case 'ABORTED':
    case 'ABORTED_BEFORE_DISPATCH':
      return { code, message: '上游工具 "' + tool + '" 的调用被取消（' + code + '）。' };
    case 'TOOL_TIMEOUT':
      return { code, message: '上游工具 "' + tool + '" 在它自己的 timeoutMs 内没有完成（TOOL_TIMEOUT）。' };
    default: {
      const detail = isPlainObject(error) && typeof error.message === 'string' ? error.message : '';
      return {
        code,
        message: detail === ''
          ? '上游工具 "' + tool + '" 执行失败（' + code + '）。'
          : '上游工具 "' + tool + '" 执行失败（' + code + '）：' + detail,
      };
    }
  }
}

function upstreamFailure(tool, error) {
  return { raw: '', toolName: tool, bytes: 0, isError: true, error: describeUpstreamError(error, tool) };
}

function extractRunResult(tool, result) {
  if (!isPlainObject(result)) {
    return upstreamFailure(tool, { info: { code: 'TOOL_ERROR' }, message: '宿主返回了非对象结果（' + typeof result + '）' });
  }
  if (result.isError === true) return upstreamFailure(tool, result.error);
  const extracted = extractOutput(result.value);
  const out = { raw: extracted.raw, toolName: tool, bytes: Buffer.byteLength(extracted.raw, 'utf8'), isError: false };
  if (extracted.exitCode !== undefined) out.exitCode = extracted.exitCode;
  if (extracted.spillPath !== undefined) out.spillPath = extracted.spillPath;
  if (extracted.truncated !== undefined) out.truncated = extracted.truncated;
  return out;
}

/**
 * 委托执行一个上游工具并取回原始输出。
 *
 * **失败不 throw**：`isError:true` 时返回 `{ raw:'', bytes:0, isError:true, error:{code,message} }`，
 * `code` 取自 `error.info.code`（`UNKNOWN_TOOL` / `ABORTED` / `TOOL_TIMEOUT` / …）。
 * 只有「调用方自己给错」（工具名、深度、arguments 形状）才抛 `DecisionValidationError`，
 * 且都在**派发之前**拒绝。
 *
 * 超时是协作式的：上游忽略 signal 时，我们到 `timeoutMs` 自己返回 `TOOL_TIMEOUT`（不抢占、
 * 也不伪造成功）。被派发出去的调用不会被我们单方面掐死。
 *
 * @param {object} ctx 插件 ctx（`ctx.tools`）或工具服务本身
 * @param {object} exec 宿主给的执行上下文（用 `callId` / `rootCallId` / `agent` / `token` / `signal`）
 * @param {{ tool: string, arguments?: object }} upstream 已归一的上游描述（见 `validate.validateUpstream`）
 * @param {{ signal?: AbortSignal, timeoutMs?: number, maxDepth?: number, selfToolNames?: string[],
 *   setTimeout?: Function, clearTimeout?: Function }} [options] `signal` 缺省用 `exec.signal`
 * @returns {Promise<{ raw: string, toolName: string, bytes: number, isError: boolean,
 *   exitCode?: number, error?: { code: string, message: string },
 *   spillPath?: string, truncated?: boolean }>} `spillPath`/`truncated` 只在进程型时有
 */
export async function runUpstream(ctx, exec, upstream, options = {}) {
  const tools = resolveTools(ctx);
  const caller = isPlainObject(exec) ? exec : {};
  const tool = requireUpstreamTool(upstream, options);
  const maxDepth = Number.isInteger(options.maxDepth) && options.maxDepth >= 1 ? options.maxDepth : MAX_DELEGATION_DEPTH;
  const level = delegationLevel(caller);
  if (level >= maxDepth) {
    throw new DecisionValidationError(
      '不能再委托一层：本插件只允许 ' + maxDepth + ' 层委托，而这次调用已经在第 ' + level + ' 层'
        + '（上游工具自己又委托回本插件会被拒）。要链式判定请在顶层分两次调用。',
      { kind: 'upstream_depth_exceeded' },
    );
  }
  const args = upstreamArguments(upstream);
  const signal = options.signal === undefined ? caller.signal : options.signal;
  delegationSeq += 1;
  const callId = stringOr(caller.callId, 'call') + ':up:' + delegationSeq;
  const rootCallId = stringOr(caller.rootCallId, stringOr(caller.callId, callId));
  const entry = { callId, rootCallId, level: level + 1 };
  activeDelegations.add(entry);
  let delegated;
  try {
    delegated = Promise.resolve(tools.execute({
      callId,
      rootCallId,
      name: tool,
      arguments: args,
      signal,
      agent: caller.agent,
      parent: caller.token,
    }));
  } catch (error) {
    activeDelegations.delete(entry);
    return upstreamFailure(tool, error);
  }
  // 条目要活到「真正被派发出去的那个调用」结束：超时后上游可能仍在跑，此时它若再委托回来，
  // 深度计数必须仍然生效（否则超时窗口就是一个递归后门）。
  const settled = delegated.then(() => {}, () => {});
  try {
    const outcome = await withDeadline(() => delegated, {
      signal,
      timeoutMs: options.timeoutMs,
      setTimeout: options.setTimeout,
      clearTimeout: options.clearTimeout,
    });
    if (outcome.timedOut) {
      return upstreamFailure(tool, {
        info: { code: 'TOOL_TIMEOUT' },
        message: '上游工具没有在 ' + options.timeoutMs + 'ms 内返回（宿主超时是协作式的，我们自行返回）',
      });
    }
    if (outcome.aborted) {
      return upstreamFailure(tool, { info: { code: 'ABORTED' }, message: '上游工具调用被取消' });
    }
    if (outcome.error !== undefined) return upstreamFailure(tool, outcome.error);
    return extractRunResult(tool, outcome.value);
  } finally {
    settled.finally(() => { activeDelegations.delete(entry); });
  }
}

function toBuffer(raw) {
  if (Buffer.isBuffer(raw)) return Buffer.from(raw);
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (raw === undefined || raw === null) return Buffer.alloc(0);
  return Buffer.from(String(raw), 'utf8');
}

/** 回退到 UTF-8 字符边界（续字节形如 10xxxxxx）：截断不切断多字节字符。 */
function charBoundary(buffer, cap) {
  let end = cap;
  while (end > 0 && (buffer[end] & 0xC0) === 0x80) end -= 1;
  return end;
}

function spillFileName(label) {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(4).toString('hex');
  const safe = typeof label === 'string'
    ? label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    : '';
  return 'spill-' + stamp + '-' + rand + (safe === '' ? '' : '-' + safe) + '.txt';
}

/**
 * **无条件**把原始输出落盘（输出再小也写，这是「不吞掉上游输出」的兜底）。
 *
 * `sha256Prefix` 是**落盘内容**（可能被 `maxBytes` 截断）的 sha256 前 `SHA256_PREFIX_CHARS` 位 ⇒
 * 读回文件后可自行复算校验。目录总量上限与清扫是调用方的事（Config `spillDirCap`）。
 *
 * @param {string|Buffer|null|undefined} raw 原始输出
 * @param {{ dir: string, maxBytes?: number, label?: string }} options `dir` 必填（插件自建目录）
 * @returns {{ path: string, bytes: number, fullBytes: number, truncated: boolean, sha256Prefix: string }}
 *   `bytes` = 实际落盘字节数，`fullBytes` = 原始字节数
 * @throws {DecisionPipeError} kind `spill_dir_missing` / `spill_write_failed`
 */
export function spillWrite(raw, options = {}) {
  const dir = options.dir;
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new DecisionPipeError('spillWrite 需要 dir（插件自建的转储目录）。', { kind: 'spill_dir_missing' });
  }
  const full = toBuffer(raw);
  const cap = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.trunc(options.maxBytes)
    : DEFAULT_SPILL_MAX_BYTES;
  const truncated = full.length > cap;
  const written = truncated ? full.subarray(0, charBoundary(full, cap)) : full;
  const target = path.resolve(path.join(dir, spillFileName(options.label)));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, written);
  } catch (error) {
    throw new DecisionPipeError('转储写失败：' + target + '（' + errorText(error) + '）。', { kind: 'spill_write_failed' });
  }
  return {
    path: target,
    bytes: written.length,
    fullBytes: full.length,
    truncated,
    sha256Prefix: createHash('sha256').update(written).digest('hex').slice(0, SHA256_PREFIX_CHARS),
  };
}

/** 解析后的规范路径（realpath 收紧符号链接逃逸；解析不了就用 resolve 的结果）。 */
function canonicalPath(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function containsPath(root, target) {
  const fold = process.platform === 'win32';
  const r = fold ? root.toLowerCase() : root;
  const t = fold ? target.toLowerCase() : target;
  if (t === r) return true;
  return t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function rejectSpillPath(reason) {
  throw new DecisionPipeError(reason, { kind: 'spill_path_rejected' });
}

/**
 * 转储路径白名单：**只接受 `allowedRoots` 之内的路径，且拒 `..` 段**。
 *
 * 为什么闸必须是我们自己的：`ctx.fs.contains` 只是纯路径谓词（工作区外一律 false），
 * 而宿主允许读工作区外文件 ⇒ 谁都能被指着一张白纸去读转储。`allowedRoots` 只应放两样东西：
 * **我们自建的转储目录**与**宿主交来的转储路径**（后者指那份文件所在目录附近的引用）。
 * 这里**只会收紧，绝不放宽**：先拒 `..`，再做 realpath + 前缀包含判定（符号链接指向根外也拒）。
 *
 * @throws {DecisionPipeError} kind `spill_path_rejected`
 */
function resolveSpillPath(file, allowedRoots) {
  if (typeof file !== 'string' || file.trim() === '' || file.includes(NUL)) {
    rejectSpillPath('转储路径必须是非空字符串且不含 NUL。');
  }
  if (file.split(BACKSLASH).join('/').split('/').includes('..')) {
    rejectSpillPath('转储路径不得含 .. 段（读取器只接受自建转储目录与宿主交来的转储路径内的文件）。');
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    rejectSpillPath('读取转储必须显式给出 allowedRoots（缺失或为空一律拒绝，不默认放行）。');
  }
  const roots = [];
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || root.trim() === '') {
      rejectSpillPath('allowedRoots 里不能出现非字符串或空串。');
    }
    roots.push(canonicalPath(root));
  }
  const target = canonicalPath(file);
  if (!roots.some((root) => containsPath(root, target))) {
    rejectSpillPath('拒绝读取 allowedRoots 之外的路径：' + target + '（允许的根：' + roots.join('、') + '）。');
  }
  return target;
}

/**
 * 读回转储全文（只接受白名单内的路径，见 `resolveSpillPath`）。
 * @param {string} file 转储路径（绝对或相对都行，最终必须落在 `allowedRoots` 内）
 * @param {{ allowedRoots: string[] }} options 白名单根目录列表（必填，空即拒）
 * @returns {string} UTF-8 文本
 * @throws {DecisionPipeError} kind `spill_path_rejected` / `spill_read_failed`
 */
export function spillRead(file, options = {}) {
  const target = resolveSpillPath(file, options.allowedRoots);
  try {
    return fs.readFileSync(target, 'utf8');
  } catch (error) {
    throw new DecisionPipeError('读取转储失败：' + target + '（' + errorText(error) + '）。', { kind: 'spill_read_failed' });
  }
}

/**
 * 给 `fn` 加自管 deadline 与取消。**不抢占**：到点我们只是自己返回，`fn` 仍在跑（协作式取消）。
 *
 * 结果恰好命中一种情形：`{ value }` / `{ error }` / `{ timedOut: true }` / `{ aborted: true }`。
 * `setTimeout`/`clearTimeout` 可注入 ⇒ 单测用假定时器，零真实墙钟。
 *
 * @param {() => Promise<any>|any} fn 被包裹的函数
 * @param {{ signal?: AbortSignal, timeoutMs?: number, setTimeout?: Function, clearTimeout?: Function }} [options]
 * @returns {Promise<{ timedOut: boolean, aborted: boolean, value: any, error: any }>}
 */
export function withDeadline(fn, options = {}) {
  const signal = options.signal;
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const cancel = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
  const outcome = (fields) => ({ timedOut: false, aborted: false, value: undefined, error: undefined, ...fields });
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) cancel(timer);
      if (onAbort !== null) signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted === true) {
        settled = true;
        resolve(outcome({ aborted: true }));
        return;
      }
      onAbort = () => finish(outcome({ aborted: true }));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (timeoutMs > 0) {
      timer = schedule(() => finish(outcome({ timedOut: true })), timeoutMs);
    }
    Promise.resolve().then(fn).then(
      (value) => finish(outcome({ value })),
      (error) => finish(outcome({ error })),
    );
  });
}

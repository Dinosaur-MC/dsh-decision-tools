/**
 * Monitor 的采样源与计数内核（规格 docs/superpowers/specs/2026-10-17-monitor-and-pipe-design.md §3/§6）。
 *
 * 三条硬契约（用户裁定，不是实现细节）：
 * 1. **按探测结果计数（电平口径）**：每次判定命中就 +1，**没有去抖、没有冷却窗、没有 minGapMs**；
 *    countThreshold 是「达成门槛」，hit = count >= countThreshold。所以 countThreshold 等价于
 *    「以探测为单位的持续时间」（countThreshold × intervalMs 量级）。
 * 2. **时间只作记录**：at / atIso / firstAt / lastAt 是 epoch 毫秒整数，**不参与任何命中判定**。
 * 3. **零真实墙钟**：clock / sleep / decide / deliver 全部注入；本模块不 import 任何计时 API。
 *    守卫见 test/monitor.test.mjs（注入假时钟与假休眠，绝不 sleep 真实时间）。
 *
 * 本模块只在 createSources 里经注入的 ctx 接触宿主（jobs / sessions / fs），其余是纯逻辑。
 *
 * 采样源的实测事实（本机真跑，证据 tmp/sub-task/REPORT.md）：
 * - ctx.jobs.readAt(id, from, caller) 是**非消耗式**读（read 才消耗游标）；
 * - 枚举**必须带 sessionId**：list() 不带 caller 只回 unowned 作业（实测 2 条 vs 0 条）；
 * - kind = 'subagent' 的作业没有输出源（output.total 恒为 0），对它采样只能拿到空文本。
 *
 * @module dsh-decision-tools/monitor
 */

import {
  DecisionSourceError,
  validateSourceDescriptor,
  sliceByLines,
  splitGlobPattern,
  matchGlobSegment,
} from './source.js';
import { LIMITS, MONITOR_LIMITS } from './validate.js';
import { createNotifier, DEFAULT_WAKE_BUDGET } from './notify.js';

/** 命中证据的硬上限（字节）：采样正文不落盘，只在命中那一次保留有限尾部。 */
export const EVIDENCE_MAX_BYTES = 1024;

/** 后台作业的 kind（JobKindMap 可通过声明合并扩展，这是本插件自己的种类）。 */
export const MONITOR_JOB_KIND = 'monitor';

const NL = String.fromCharCode(10);

/**
 * 取文本的**尾部**最多 maxBytes 字节，且**不劈开多字节字符**（被劈开的 UTF-8 会变成 U+FFFD，
 * 那会让判定读到假字节）。落在续字节上时向后对到下一个字符起点（UTF-8 最多 3 个续字节）。
 *
 * @param {unknown} text 原文本
 * @param {number} maxBytes 字节上限
 * @returns {string}
 */
export function tailOf(text, maxBytes) {
  const buf = Buffer.from(String(text === undefined || text === null ? '' : text), 'utf8');
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.trunc(maxBytes) : 0;
  if (buf.byteLength <= limit) return buf.toString('utf8');
  let start = buf.byteLength - limit;
  let guard = 0;
  while (start < buf.byteLength && guard < 3 && (buf[start] & 0xc0) === 0x80) {
    start += 1;
    guard += 1;
  }
  return buf.subarray(start).toString('utf8');
}

/** 采样窗口的字节上限（硬限，别让模型传 1 GiB 把内存打满）。 */
function normalizeTailBytes(value) {
  if (!Number.isFinite(value) || value < 1) return MONITOR_LIMITS.defaultTailBytes;
  return Math.min(Math.trunc(value), MONITOR_LIMITS.maxTailBytes);
}

/** 采样源对象的形状检查（kind 必须是规格 §6 的取值之一）。 */
function normalizeSource(source) {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new DecisionSourceError('source 必须是对象，例如 { kind: "file", path: "notes.txt" }。', { kind: 'invalid_request' });
  }
  const kind = source.kind;
  if (!MONITOR_LIMITS.sourceKinds.includes(kind)) {
    throw new DecisionSourceError('未知采样源 kind=' + JSON.stringify(kind) + '；合法值：' + MONITOR_LIMITS.sourceKinds.join('、') + '。', { kind: 'invalid_request' });
  }
  return { ...source };
}

/** 把 monitor 的 source 描述折成 source.js 认识的描述符（描述符校验的唯一产地仍是 source.js）。 */
function toDescriptor(source) {
  if (source.kind === 'file') {
    return {
      kind: 'file',
      path: source.path,
      ...(source.startLine === undefined ? {} : { startLine: source.startLine }),
      ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
    };
  }
  return {
    kind: 'glob',
    pattern: source.pattern,
    ...(source.limit === undefined ? {} : { limit: source.limit }),
  };
}

/**
 * 安全读一个**宿主对象**的属性。**这不是防御脏数据，是平台语义**（与 lib/pipe.js 的同名工具同因）：
 * 真宿主的 `ctx` 是 Cordis 的 reflect 代理，**没有写进 `inject` 的服务属性在读的时候就抛**
 * （`cannot get property "X" without inject`），**不返回 undefined**。
 *
 * 实测事故（verifier 真机复验 + pipe-dev 同类清扫）：`resolveSessionId` 里裸读 `ctx.sessions`
 * —— `sessions` 不在本插件 inject 里 ⇒ 在真机上这一读直接抛，**整条 job 采样路径不可用**。
 *
 * 两条纪律：① 凡读**没写进 inject 的**属性必须经本函数；② 即使是 inject 过的服务，探测也建议走它
 * （inject 表由装配层维护，本模块无从假设它今天写了什么）。
 *
 * **为什么 `sessions` 不加进 inject**（Lead 留的二选一，此处裁定）：
 * `inject` 是**硬依赖**——声明了而某个 profile 没注册该服务，整条插件行解析失败；而 `sessions`
 * 只服务**一条可选采样路径**（`kind=job` 且调用方没给 sessionId），`resolveSessionId` 前面还有
 * `source.sessionId` / `deps.sessionId` 两条兜底。拿「插件整体不可用」的风险去换「少一次兜底」不划算。
 * （`jobs`/`agents` 不同：后台注册与 inbox 通知没有兜底，缺了就是功能不可用，所以它们进 inject。）
 */
export function probeProperty(target, key) {
  if (target === null || typeof target !== 'object') return undefined;
  try {
    return target[key];
  } catch {
    return undefined;
  }
}

/**
 * 取本会话 id。**权威来源是宿主自己的服务**：source.sessionId（装配层显式给）→ deps.sessionId
 * → ctx.sessions.list()。job 采样源**必须**带它才能枚举到 agent 拥有的作业。
 *
 * `sessions` **不在本插件 inject 里** ⇒ 这一读必须 probe-safe（见 `probeProperty`），
 * 拿不到就退到「不带 caller 的枚举」，绝不把 Cordis 代理的异常透给调用方。
 */
async function resolveSessionId(ctx, deps, source) {
  if (typeof source.sessionId === 'string' && source.sessionId !== '') return source.sessionId;
  if (typeof deps.sessionId === 'string' && deps.sessionId !== '') return deps.sessionId;
  const sessions = probeProperty(ctx, 'sessions');
  if (sessions && typeof probeProperty(sessions, 'list') === 'function') {
    let all;
    try {
      all = await sessions.list();
    } catch (error) {
      all = undefined;
    }
    const arr = Array.isArray(all) ? all : (all && Array.isArray(all.sessions) ? all.sessions : []);
    const first = arr[0];
    if (typeof first === 'string' && first !== '') return first;
    if (first && typeof first.id === 'string' && first.id !== '') return first.id;
  }
  return undefined;
}

/** 从枚举结果里挑一个作业视图：默认「本会话最新的作业」，可退到 oldest 或按 jobKind 过滤。 */
function selectJobView(views, source) {
  const list = Array.isArray(views) ? views : [];
  const jobKind = typeof source.jobKind === 'string' && source.jobKind !== '' ? source.jobKind : undefined;
  const filtered = jobKind === undefined ? list : list.filter((view) => view && view.kind === jobKind);
  if (filtered.length === 0) return undefined;
  return source.select === 'oldest' ? filtered[0] : filtered[filtered.length - 1];
}

/** job 采样源：读尾部窗口。readAt 非消耗式，可以反复读同一作业。 */
async function readJobSample(ctx, deps, source, tailBytes) {
  const jobs = probeProperty(ctx, 'jobs');
  if (!jobs || typeof jobs.list !== 'function' || typeof jobs.readAt !== 'function') {
    throw new DecisionSourceError('当前上下文没有 jobs 服务：job 采样源不可用。', { kind: 'invalid_request' });
  }
  const caller = await resolveSessionId(ctx, deps, source);
  // 枚举必须带 sessionId：list() 不带 caller 只回 unowned 作业（实测 2 条 vs 0 条）。
  const views = await jobs.list(caller);
  let view;
  if (typeof source.id === 'string' && source.id !== '') {
    view = (Array.isArray(views) ? views : []).find((item) => item && String(item.id) === source.id);
    if (!view) {
      throw new DecisionSourceError('作业 ' + source.id + ' 不存在或不属于本会话，无法采样。', { kind: 'source_missing' });
    }
  } else {
    view = selectJobView(views, source);
    if (!view) {
      throw new DecisionSourceError('本会话没有可采样的作业（job 采样源缺省监视最新作业）。', { kind: 'source_missing' });
    }
  }
  const total = view.output && Number.isFinite(view.output.total) ? view.output.total : 0;
  const from = Math.max(0, total - tailBytes);
  const read = jobs.readAt(view.id, from, caller);
  const chunks = read && Array.isArray(read.chunks) ? read.chunks : [];
  const text = chunks.map((chunk) => String(chunk && chunk.text ? chunk.text : '')).join('');
  return {
    text,
    totalBytes: total,
    truncated: read && read.lossy === true,
    lossy: read && read.lossy === true,
    from,
    next: read && Number.isFinite(read.next) ? read.next : total,
    jobId: String(view.id),
    jobKind: view.kind === undefined ? null : view.kind,
    owner: view.owner === undefined ? null : view.owner,
    status: view.status === undefined ? null : view.status,
    label: view.label === undefined ? null : view.label,
  };
}

/**
 * file/glob 采样源。**复用 lib/source.js 的读取与截断语义**（同一套三道闸与「单文件报错 /
 * glob 总量截断」的越限语义）：读盘只能经 ctx.fs，闸必须留在这里。
 *
 * 与 lib/tool.js 的 createSourceReader 是**同语义的两份实现**：那边服务于 material（读进来当材料），
 * 这边服务于 monitor（读进来当采样窗口）。刻意不共用代码（tool.js 不导出它、且属于另一条任务的写域），
 * 但两处都只依赖 source.js 的纯函数，语义以 source.js 为准。
 */
function createFsReader(ctx, deps) {
  const cap = LIMITS.maxSourceBytes;
  const maxDepth = 8;
  const maxEntries = 2000;

  return async function readDescriptor(source, options) {
    const fs = probeProperty(ctx, 'fs');
    if (!fs || typeof fs.readBytes !== 'function' || typeof fs.resolve !== 'function' || typeof fs.contains !== 'function') {
      throw new DecisionSourceError('当前上下文没有 fs 服务：file/glob 采样源不可用。', { kind: 'invalid_request' });
    }
    const signal = options && options.signal;
    const descriptor = validateSourceDescriptor(toDescriptor(source));
    const anchored = deps.cwd === undefined ? {} : { cwd: deps.cwd };
    const rootTarget = await fs.resolve('.', anchored);

    /** 把读取失败翻译成可行动的 kind（文案里只出现 monitor 的公开参数路径 source.*）。 */
    const toReadError = (label, error) => {
      const message = String(error && error.message ? error.message : error);
      if (/not found|ENOENT|NOT_FOUND|no such file/i.test(message)) {
        return new DecisionSourceError('source 指向的文件不存在：' + label, { kind: 'source_missing' });
      }
      if (/too large|TOO_LARGE/i.test(message)) {
        return new DecisionSourceError(
          'source 读取失败（单份上限 ' + cap + ' 字节，超限不截断，与 material.file 同语义）：' + label
            + ' —— ' + message + '；建议改用 source.kind=glob 分批，或缩小行范围。',
          { kind: 'source_too_large' },
        );
      }
      return new DecisionSourceError('source 读不动（不是可读的常规文件？）：' + label + ' —— ' + message, { kind: 'invalid_request' });
    };

    const readInside = async (label, target, extraction) => {
      let bytes;
      try {
        bytes = await fs.readBytes(target, signal, cap);
      } catch (error) {
        throw toReadError(label, error);
      }
      const full = Buffer.from(bytes).toString('utf8');
      const sliced = sliceByLines(full, extraction.startLine, extraction.endLine);
      return { text: sliced.text, lines: sliced.lines, startLine: sliced.startLine, endLine: sliced.endLine };
    };

    // ---- kind: file ----
    if (descriptor.kind === 'file') {
      const target = await fs.resolve(descriptor.path, { ...anchored, signal });
      if (!fs.contains(rootTarget, target)) {
        throw new DecisionSourceError('source.path 解析后落在工作区根之外，已拒绝：' + descriptor.path, { kind: 'source_outside_root' });
      }
      const read = await readInside(descriptor.path, target, descriptor);
      return {
        text: read.text,
        totalBytes: Buffer.byteLength(read.text, 'utf8'),
        truncated: false,
        files: [descriptor.path],
        descriptor,
        lines: read.lines,
        startLine: read.startLine,
        endLine: read.endLine,
      };
    }

    // ---- kind: glob ----
    const split = splitGlobPattern(descriptor.pattern);
    const base = split.base;
    const segments = split.segments;
    const limit = descriptor.limit === undefined ? Number.POSITIVE_INFINITY : descriptor.limit;
    if (segments.length === 0) {
      const target = await fs.resolve(base, { ...anchored, signal });
      if (!fs.contains(rootTarget, target)) {
        throw new DecisionSourceError('source.pattern 解析后落在工作区根之外，已拒绝：' + base, { kind: 'source_outside_root' });
      }
      const read = await readInside(base, target, descriptor);
      return {
        text: read.text,
        totalBytes: Buffer.byteLength(read.text, 'utf8'),
        truncated: false,
        files: [base],
        remaining: 0,
        descriptor,
      };
    }
    const startTarget = await fs.resolve(base === '' ? '.' : base, { ...anchored, signal });
    if (!fs.contains(rootTarget, startTarget)) {
      throw new DecisionSourceError('source.pattern 的起始目录落在工作区根之外，已拒绝：' + base, { kind: 'source_outside_root' });
    }
    const collected = [];
    const seen = new Set();
    let bytes = 0;
    let remaining = 0;
    let visited = 0;
    let truncated = false;
    const overhead = (path) => Buffer.byteLength('===== ' + path + ' =====' + NL, 'utf8') + (collected.length === 0 ? 0 : 2);

    const take = async (path, entry) => {
      if (truncated || seen.has(path)) return;
      if (!fs.contains(rootTarget, entry.target)) return; // 根外命中项静默跳过
      if (seen.size >= limit) {
        truncated = true;
        remaining += 1;
        return;
      }
      const cost = overhead(path);
      const budget = cap - bytes - cost;
      if (budget <= 0) {
        truncated = true;
        remaining += 1;
        return;
      }
      let raw;
      try {
        raw = await fs.readBytes(entry.target, signal, budget);
      } catch (error) {
        const message = String(error && error.message ? error.message : error);
        // glob 总量不足就截断，不报错（单文件超限报错 / glob 总量超限截断，与 material 同语义）。
        if (/too large|TOO_LARGE/i.test(message)) {
          truncated = true;
          remaining += 1;
          return;
        }
        throw toReadError(path, error);
      }
      const text = Buffer.from(raw).toString('utf8');
      const textBytes = Buffer.byteLength(text, 'utf8');
      if (bytes + cost + textBytes > cap) {
        truncated = true;
        remaining += 1;
        return;
      }
      bytes += cost + textBytes;
      seen.add(path);
      collected.push({ path, text });
    };

    const walk = async (target, rest, prefix, depth) => {
      if (truncated) return;
      if (depth > maxDepth) {
        truncated = true;
        return;
      }
      if (rest.length === 0) return;
      let entries;
      try {
        entries = await fs.listDir(target, signal);
      } catch (error) {
        throw toReadError(prefix === '' ? (base === '' ? '.' : base) : prefix, error);
      }
      for (const entry of entries) {
        if (truncated) return;
        visited += 1;
        if (visited > maxEntries) {
          truncated = true;
          return;
        }
        const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
        if (rest[0] === '**') {
          if (rest.length === 1) {
            if (entry.type === 'file') await take(path, entry);
            else if (entry.type === 'directory') await walk(entry.target, rest, path, depth + 1);
            continue;
          }
          // ** 吃零层：** 与 rest[1] 两段都在这一步消耗。
          if (matchGlobSegment(rest[1], entry.name)) {
            const rest2 = rest.slice(2);
            if (entry.type === 'file') {
              if (rest2.length === 0) await take(path, entry);
            } else if (entry.type === 'directory') {
              await walk(entry.target, rest2, path, depth + 1);
            }
          }
          // ** 吃一层：子目录保持同一模式继续下降。
          if (entry.type === 'directory') await walk(entry.target, rest, path, depth + 1);
          continue;
        }
        if (entry.type === 'file') {
          if (rest.length === 1 && matchGlobSegment(rest[0], entry.name)) await take(path, entry);
          continue;
        }
        if (entry.type === 'directory' && rest.length > 1 && matchGlobSegment(rest[0], entry.name)) {
          await walk(entry.target, rest.slice(1), path, depth + 1);
        }
      }
    };

    await walk(startTarget, segments, base, 0);
    const text = collected.map((file) => '===== ' + file.path + ' =====' + NL + file.text).join(NL + NL);
    return {
      text,
      totalBytes: Buffer.byteLength(text, 'utf8'),
      truncated,
      remaining,
      files: collected.map((file) => file.path),
      descriptor,
    };
  };
}

/** command 采样源：不自行 spawn 子进程，只在装配层注入 runCommand 时才可用（管道那条线实现它）。 */
async function readCommandSample(deps, source, tailBytes, signal) {
  const run = deps.runCommand;
  if (typeof run !== 'function') {
    throw new DecisionSourceError(
      'command 采样源需要在装配层注入 deps.runCommand(source, { tailBytes, signal })：本模块不自行 spawn 子进程。',
      { kind: 'invalid_request' },
    );
  }
  const out = await run(source, { tailBytes, signal });
  const text = typeof out === 'string' ? out : String(out && out.text !== undefined ? out.text : '');
  return {
    text,
    totalBytes: out && Number.isFinite(out.totalBytes) ? out.totalBytes : Buffer.byteLength(text, 'utf8'),
    truncated: out && out.truncated === true,
    exitCode: out && out.exitCode !== undefined ? out.exitCode : null,
  };
}


/**
 * `events` 源的**内置投影**：从 `ctx.jobs.list(sessionId)` 读当前作业，每个作业投影成一条
 * `{ type: 'job.<status>', id, kind, label, status, startedAt?, finishedAt? }`。
 *
 * 为什么不用 `jobs.events.subscribe`：真机实测（2026-10-18）插件 ctx 上两种 filter（`{}` 与
 * `{ owners: 'scope' }`）都**注册成功但一条事件都收不到**（用 onFirstEvent 探针确认监听器从未被调用）。
 * 而 `jobs.list(sessionId)` 是确定性调用，且 `deps.sessionId` 每次调用都有 —— 于是「等到某个作业失败」
 * 这类诉求可以靠**当前状态投影**满足（`types: ['job.failed']`），代价是看不到历史（只反映此刻）。
 * @returns {Promise<object[] | null>} 无法投影时返回 null（调用方给出可行动错误）
 */
async function listJobEntries(ctx, deps) {
  const sessionId = typeof deps.sessionId === 'string' && deps.sessionId !== '' ? deps.sessionId : undefined;
  if (sessionId === undefined) return null;
  const jobs = probeProperty(ctx, 'jobs');
  if (jobs === undefined || jobs === null || typeof jobs.list !== 'function') return null;
  let rows;
  try {
    rows = await jobs.list(sessionId);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows
    .filter((job) => job !== null && typeof job === 'object' && typeof job.id === 'string')
    .map((job) => ({
      type: 'job.' + String(job.status ?? 'unknown'),
      id: job.id,
      ...(typeof job.kind === 'string' ? { kind: job.kind } : {}),
      ...(typeof job.label === 'string' ? { label: job.label } : {}),
      ...(typeof job.status === 'string' ? { status: job.status } : {}),
      ...(Number.isFinite(job.startedAt) ? { startedAt: job.startedAt } : {}),
      ...(Number.isFinite(job.finishedAt) ? { finishedAt: job.finishedAt } : {}),
    }));
}
/** events 采样源：优先读装配层注入的环形缓冲；没有缓冲时退到 `ctx.jobs.list()` 的**当前状态投影**。 */
async function readEventsSample(ctx, deps, source) {
  // monitorEventLog 不是已注册服务（宿主装配层挂的普通键或干脆没有）⇒ 同样 probe-safe。
  const log = deps.eventLog === undefined ? probeProperty(ctx, 'monitorEventLog') : deps.eventLog;
  const types = Array.isArray(source.types) ? source.types : [];
  // 先取足够大的窗口 ⇒ **再按 types 过滤** ⇒ 最后才截到 limit。
  // 反例（真机踩到）：`events` 带 `limit:1` 时若先截断再过滤，缓冲最后一条恰好不是目标类型 ⇒ 样本为空，
  // 看起来像「事件没发生」，实际上更早的匹配事件是存在的。
  const limit = Number.isInteger(source.limit) && source.limit > 0 ? Math.min(source.limit, 200) : 64;
  let entries;
  if (Array.isArray(log)) {
    entries = log;
  } else if (log && typeof log.tail === 'function') {
    const window = Number.isInteger(log.capacity) && log.capacity > 0 ? Math.max(log.capacity, limit) : Math.max(200, limit);
    entries = await log.tail(window);
  } else {
    entries = await listJobEntries(ctx, deps);
    if (entries === null) {
      throw new DecisionSourceError(
        'events 采样源需要一个数据源：deps.eventLog（环形缓冲）、ctx.monitorEventLog，'
        + '或可用的 ctx.jobs.list(sessionId) 投影。当前三者都不可用。',
        { kind: 'invalid_request' },
      );
    }
  }
  const pick = (rows) => (types.length === 0
    ? rows
    : rows.filter((entry) => types.includes(entry && (entry.type !== undefined ? entry.type : entry.event))));
  let matched = pick(entries);
  // P1（审查 task-35）：装配层恒注入一个**空**缓冲时，旧实现会永远走缓冲分支 ⇒ 投影兜底被遮蔽
  // （同一个 `job.failed`：注入空缓冲 hit=false，不注入 hit=true）。这里在「缓冲一条都没匹配上」时
  // 再试一次投影 —— 两者都空才算真的没有。
  if (matched.length === 0) {
    const projected = await listJobEntries(ctx, deps);
    if (projected !== null) matched = pick(projected);
  }
  const filtered = matched.slice(-limit);
  const text = filtered.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join(NL);
  return { text, totalBytes: Buffer.byteLength(text, 'utf8'), truncated: false, events: filtered.length };
}

/**
 * 造采样源读取器。
 *
 * @param {any} ctx 宿主上下文（按 kind 需要 jobs / sessions / fs）
 * @param {object} [deps] 装配层注入：sessionId / cwd / runCommand / eventLog
 * @returns {{ read: (source: object, options?: { tailBytes?: number, signal?: AbortSignal }) => Promise<object> }}
 *   读取结果：{ kind, text, bytes, totalBytes, truncated, ... }；text 恒不超过 tailBytes 字节。
 */
export function createSources(ctx, deps = {}) {
  const readFs = createFsReader(ctx, deps);

  return {
    async read(source, options = {}) {
      const spec = normalizeSource(source);
      const tailBytes = normalizeTailBytes(options.tailBytes);
      const signal = options.signal;
      let raw;
      if (spec.kind === 'job') raw = await readJobSample(ctx, deps, spec, tailBytes);
      else if (spec.kind === 'file' || spec.kind === 'glob') raw = await readFs(spec, { signal });
      else if (spec.kind === 'command') raw = await readCommandSample(deps, spec, tailBytes, signal);
      else raw = await readEventsSample(ctx, deps, spec);

      // 读取窗口统一由 tailBytes 限制：file/glob 是全量读（守 source.js 的 cap 语义）后再取尾。
      const fullText = typeof raw.text === 'string' ? raw.text : '';
      const windowText = tailOf(fullText, tailBytes);
      const fullBytes = Buffer.byteLength(fullText, 'utf8');
      const windowBytes = Buffer.byteLength(windowText, 'utf8');
      // truncated 的口径是「返回的文本不是整个源」：比对对象必须是**源总量**
      // （job 的 output.total / file 的全文字节 / glob 的拼接字节），不是已经窗口化的全文。
      const totalBytes = Number.isFinite(raw.totalBytes) ? raw.totalBytes : fullBytes;
      return {
        ...raw,
        kind: spec.kind,
        text: windowText,
        bytes: windowBytes,
        totalBytes,
        truncated: raw.truncated === true || windowBytes < totalBytes,
      };
    },
  };
}

/**
 * 把 decide 的返回值折成 { recognized, level, probability, confidence, evidence }。
 *
 * `recognized` 是**诊断用**的一半：形状写错（裸 boolean、没有 probability/hit/value 的对象、字符串、
 * 数组）与「判据说否」在方向上都 fail-safe（一律按未命中），但**必须在返回值里可区分** —— 否则
 * 「目标没出现」与「判定器接线写错了」看起来一模一样。调用方据此把它记进 errors。
 */
function parseVerdict(verdict, hitThreshold) {
  if (typeof verdict === 'number' && Number.isFinite(verdict)) {
    return { recognized: true, level: verdict >= hitThreshold, probability: verdict, confidence: null, evidence: undefined };
  }
  if (verdict && typeof verdict === 'object' && !Array.isArray(verdict)) {
    const probability = Number.isFinite(verdict.probability)
      ? verdict.probability
      : (Number.isFinite(verdict.noul) ? verdict.noul : null);
    const confidence = Number.isFinite(verdict.confidence) ? verdict.confidence : null;
    const evidence = typeof verdict.evidence === 'string' ? verdict.evidence : undefined;
    if (typeof verdict.hit === 'boolean') return { recognized: true, level: verdict.hit, probability, confidence, evidence };
    if (probability !== null) return { recognized: true, level: probability >= hitThreshold, probability, confidence, evidence };
    if (typeof verdict.value === 'boolean') return { recognized: true, level: verdict.value, probability, confidence, evidence };
    return { recognized: false, level: false, probability: null, confidence, evidence };
  }
  return { recognized: false, level: false, probability: null, confidence: null, evidence: undefined };
}

/**
 * 探测循环。顺序固定为：**采样 → 判定 → 计数 → 判阈值 → 检查 signal/deadline → 休眠**
 * （规格 §3.2；计数按探测结果、无冷却窗）。
 *
 * @param {object} input
 * @param {{ read: Function }} input.sources createSources 的产物
 * @param {(text: string, meta: object) => any} input.decide 判定器（内部调用既有 decision 内核）
 * @param {() => number} input.clock 注入时钟（epoch 毫秒）—— 必填，本模块不 import 计时 API
 * @param {(ms: number) => Promise<void>} input.sleep 注入休眠 —— 必填
 * @param {AbortSignal} [input.signal] 调用方取消信号
 * @param {object} input.args 已**由 validate.js 钳制**的 monitor 参数（本模块不再钳一遍）；
 *   另可带 onHit / onProgress / maxProbes 三个装配层钩子
 * @returns {Promise<object>} { hit, count, countThreshold, at, atIso, firstAt, lastAt, elapsedMs, samples,
 *   hitSamples, level, evidence, confidence, probability, intervalMs, timeoutMs, mode, aborted, timedOut, errors }
 *   `intervalMs` / `timeoutMs` 是**实际生效值**（钳制由 validate.js 完成，工具层据此拼 notes）。
 */
export async function runMonitor(input) {
  const { sources, decide, clock, sleep, signal, args } = input === undefined ? {} : input;
  if (!sources || typeof sources.read !== 'function') {
    throw new TypeError('runMonitor 需要 sources.read(source, { tailBytes })。');
  }
  if (typeof decide !== 'function') {
    throw new TypeError('runMonitor 需要注入 decide(text)（内部调用既有 decision 内核）。');
  }
  if (typeof clock !== 'function' || typeof sleep !== 'function') {
    throw new TypeError('runMonitor 需要注入 clock() 与 sleep(ms)：本模块不 import 任何计时 API（零真实墙钟守卫）。');
  }
  const cfg = args === undefined ? {} : args;
  const source = cfg.source;
  if (source === undefined || source === null) throw new TypeError('runMonitor 需要 args.source（采样源）。');

  const tailBytes = normalizeTailBytes(cfg.tailBytes);
  const intervalMs = Number.isFinite(cfg.intervalMs) && cfg.intervalMs > 0
    ? Math.trunc(cfg.intervalMs)
    : MONITOR_LIMITS.defaultProbeIntervalMs;
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? Math.trunc(cfg.timeoutMs)
    : MONITOR_LIMITS.defaultTimeoutMs;
  const countThreshold = Number.isInteger(cfg.countThreshold) && cfg.countThreshold >= 1
    ? Math.min(cfg.countThreshold, MONITOR_LIMITS.maxCountThreshold)
    : MONITOR_LIMITS.defaultCountThreshold;
  const hitThreshold = Number.isFinite(cfg.hitThreshold)
    ? Math.min(Math.max(cfg.hitThreshold, 0), 1)
    : MONITOR_LIMITS.defaultHitThreshold;
  const mode = cfg.mode === 'continuous' ? 'continuous' : 'once';
  const onHit = typeof cfg.onHit === 'function' ? cfg.onHit : null;
  const onProgress = typeof cfg.onProgress === 'function' ? cfg.onProgress : null;
  // 探测次数上限：即使注入的时钟/休眠不前进，循环也**可证终止**（零墙钟守卫的另一半）。
  const maxProbes = Number.isInteger(cfg.maxProbes) && cfg.maxProbes > 0
    ? cfg.maxProbes
    : Math.ceil(timeoutMs / intervalMs) + 1;

  const startedAt = Math.trunc(clock());
  let probes = 0;
  let count = 0;
  let errors = 0;
  let firstAt = null;
  let lastAt = null;
  let hitAt = null;
  let lastLevel = false;
  let lastProbability = null;
  let lastConfidence = null;
  let hitConfidence = null;
  let evidence = null;

  function finish(extra) {
    const endedAt = Math.trunc(clock());
    const hit = count >= countThreshold;
    // at 只作记录：命中时是**那一次探测**的时刻，否则是最后一次探测的时刻；没有探测过就是 null。
    const recordedAt = hit ? hitAt : lastAt;
    return {
      hit,
      count,
      countThreshold,
      at: recordedAt,
      atIso: recordedAt === null ? null : new Date(recordedAt).toISOString(),
      firstAt,
      lastAt,
      elapsedMs: Math.max(0, endedAt - startedAt),
      samples: probes,
      hitSamples: count,
      level: lastLevel,
      evidence: hit ? evidence : null,
      confidence: hit ? hitConfidence : lastConfidence,
      probability: lastProbability,
      intervalMs,
      timeoutMs,
      mode,
      aborted: Boolean(extra && extra.aborted),
      timedOut: Boolean(extra && extra.timedOut),
      errors,
    };
  }

  for (;;) {
    if (signal && signal.aborted === true) return finish({ aborted: true });
    if (probes >= maxProbes) return finish({ timedOut: true });
    const before = Math.trunc(clock());
    if (before - startedAt >= timeoutMs) return finish({ timedOut: true });

    // ① 采样
    let sample = null;
    let failed = false;
    try {
      sample = await sources.read(source, { tailBytes, signal });
    } catch (error) {
      failed = true;
    }
    const probedAt = Math.trunc(clock());
    probes += 1;
    lastAt = probedAt;
    if (firstAt === null) firstAt = probedAt;

    // ② 判定 + ③ 计数（电平：命中就 +1，没有去抖、没有冷却窗）
    let level = false;
    let probability = null;
    let confidence = null;
    let evidenceText = null;
    if (failed) {
      errors += 1;
    } else {
      const text = sample && typeof sample.text === 'string' ? sample.text : '';
      evidenceText = text;
      let verdict = null;
      let decideFailed = false;
      try {
        verdict = await decide(text, { index: probes - 1, at: probedAt, source, sample });
      } catch (error) {
        decideFailed = true;
      }
      if (decideFailed) {
        errors += 1;
      } else {
        const parsed = parseVerdict(verdict, hitThreshold);
        // 形状不识别**记账而不静默**（方向仍 fail-safe：按未命中处理）：见 parseVerdict 的说明。
        if (!parsed.recognized) errors += 1;
        level = parsed.level;
        probability = parsed.probability;
        confidence = parsed.confidence;
        if (parsed.evidence !== undefined) evidenceText = parsed.evidence;
      }
    }
    lastLevel = level;
    lastProbability = probability;
    lastConfidence = confidence;
    if (level) {
      count += 1;
      hitAt = probedAt;
      hitConfidence = confidence;
      evidence = tailOf(evidenceText === null ? '' : evidenceText, EVIDENCE_MAX_BYTES);
    }

    const summary = {
      count,
      countThreshold,
      hit: count >= countThreshold,
      probability,
      confidence,
      level,
      at: probedAt,
      elapsedMs: Math.max(0, probedAt - startedAt),
      samples: probes,
    };
    if (onProgress) await onProgress(summary);
    // ④ 判阈值：达成门槛才通知；once 模式达成即返回
    const reached = count >= countThreshold;
    if (level && reached && onHit) await onHit(summary);
    if (mode === 'once' && reached) return finish({});

    // ⑤ 检查 signal / deadline
    if (signal && signal.aborted === true) return finish({ aborted: true });
    const after = Math.trunc(clock());
    if (after - startedAt >= timeoutMs) return finish({ timedOut: true });

    // ⑥ 休眠：最多睡到 deadline，绝不睡过头（自管 deadline，宿主不抢占）
    await sleep(Math.max(1, Math.min(intervalMs, startedAt + timeoutMs - after)));
  }
}

/**
 * 后台作业的一行进度（模型与 GUI 都只拿到这一个字符串，见 tmp/sub-notify/REPORT.md §⑤）。
 * 契约：字符串里必须含 count/countThreshold 与已监控时长。
 */
export function formatProgressLine(summary) {
  const src = summary === undefined || summary === null ? {} : summary;
  const count = Number.isFinite(src.count) ? src.count : 0;
  const threshold = Number.isFinite(src.countThreshold) ? src.countThreshold : 1;
  const seconds = Math.max(0, Math.round((Number.isFinite(src.elapsedMs) ? src.elapsedMs : 0) / 1000));
  const probability = Number.isFinite(src.probability) ? 'P=' + src.probability.toFixed(2) : 'P=-';
  const verb = src.hit === true ? '命中' : '待命中';
  return verb + ' ' + count + '/' + threshold + ' · ' + probability + ' · 已监控 ' + seconds + 's';
}

/** 后台作业的终态 detail：复用进度行格式，让 job_output 里一眼能读。 */
function jobDetail(result) {
  return formatProgressLine({
    count: result.count,
    countThreshold: result.countThreshold,
    probability: result.probability,
    elapsedMs: result.elapsedMs,
    hit: result.hit,
  });
}

/** 交给宿主作业记录的结果字符串（背景模式拿不到结构化返回值，只能从这里取）。 */
function jobResultText(result) {
  return JSON.stringify({
    hit: result.hit,
    count: result.count,
    countThreshold: result.countThreshold,
    at: result.at,
    atIso: result.atIso,
    firstAt: result.firstAt,
    lastAt: result.lastAt,
    elapsedMs: result.elapsedMs,
    samples: result.samples,
    hitSamples: result.hitSamples,
    confidence: result.confidence,
    aborted: result.aborted,
    timedOut: result.timedOut,
    errors: result.errors,
    evidence: result.evidence,
  });
}

/** 命中通知的正文：**只通知、不动手**，并告诉模型去哪里取证据。 */
function hitNoticeText(summary, threshold) {
  const probability = Number.isFinite(summary.probability) ? summary.probability.toFixed(2) : '-';
  const seconds = Math.max(0, Math.round((Number.isFinite(summary.elapsedMs) ? summary.elapsedMs : 0) / 1000));
  return 'Monitor 命中：' + summary.count + '/' + threshold + '（P=' + probability + '，已监控 ' + seconds
    + 's）。用 job_output 取证据与计数；本通知不执行任何动作。';
}

/** 取 agent（只为读 status 决定唤醒还是静默；**绝不调用 cancel**）。 */
function resolveAgent(ctx, deps) {
  if (deps.agent) return deps.agent;
  const agents = probeProperty(ctx, 'agents');
  const sessionId = deps.sessionId;
  if (sessionId && agents && typeof probeProperty(agents, 'get') === 'function') {
    try {
      return agents.get(sessionId);
    } catch (error) {
      return undefined;
    }
  }
  return undefined;
}

/**
 * 起一个**后台** Monitor：注册为宿主作业，命中时按通知三件套送 inbox 通知。
 *
 * root 层挂载开不了作业（实测报 "no job controller serves this agent"）⇒ 先试 start，
 * 命中该错误才 attachController 再重试一次（规格 §7、tmp/sub-task/REPORT.md §④-5）。
 *
 * @param {any} ctx 宿主上下文（需要 jobs；可选 agents / sessions / fs）
 * @param {object} args 已由 validate.js 归一的 monitor 参数
 * @param {object} deps 装配层注入：decide（必填）、sources/clock/sleep/deliver/notify/agent/sessionId/owner/
 *   kind/label/controllerName/coalesceWindowMs/maxPerMinute/wakeBudget/onProgress/onHit
 * @returns {{ jobId: string, done: Promise<any> }} done 在 run 被执行时解析为该次运行的终态记录
 */
export function startBackgroundMonitor(ctx, args = {}, deps = {}) {
  const jobs = probeProperty(ctx, 'jobs');
  if (!jobs || typeof jobs.start !== 'function') {
    throw new TypeError('startBackgroundMonitor 需要 ctx.jobs（宿主 jobs 服务）。');
  }
  const decide = deps.decide;
  if (typeof decide !== 'function') {
    throw new TypeError('startBackgroundMonitor 需要注入 deps.decide（内部调用既有 decision 内核）。');
  }
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const sleep = typeof deps.sleep === 'function'
    ? deps.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sources = deps.sources === undefined ? createSources(ctx, deps) : deps.sources;
  const agent = resolveAgent(ctx, deps);

  let notifier = null;
  if (deps.notify && typeof deps.notify.notify === 'function') {
    notifier = deps.notify;
  } else if (typeof deps.deliver === 'function') {
    notifier = createNotifier({
      deliver: deps.deliver,
      clock,
      coalesceWindowMs: deps.coalesceWindowMs,
      maxPerMinute: deps.maxPerMinute,
      wakeBudget: deps.wakeBudget === undefined ? DEFAULT_WAKE_BUDGET : deps.wakeBudget,
    });
  }
  if (args.notify === 'inbox' && notifier === null) {
    throw new TypeError('args.notify=inbox 需要注入 deps.notify 或 deps.deliver（生产者的责任是节流）。');
  }

  const updateProgress = (job, summary) => {
    if (!job || typeof job.updateProgress !== 'function') return;
    try {
      job.updateProgress(formatProgressLine(summary));
    } catch (error) {
      // 进度上报失败不能影响监控本体（jobs 是旁路，不是判据）。
    }
  };

  const deliverHit = (summary) => {
    if (notifier === null) return;
    const idle = agent && typeof agent.status === 'string' ? agent.status === 'idle' : undefined;
    notifier.notify({
      key: 'monitor-hit',
      kind: 'hit',
      text: hitNoticeText(summary, summary.countThreshold),
      summary: summary.count + '/' + summary.countThreshold,
      idle,
      at: summary.at,
    });
  };

  const runArgs = {
    source: args.source,
    tailBytes: args.tailBytes,
    intervalMs: args.intervalMs,
    timeoutMs: args.timeoutMs,
    countThreshold: args.countThreshold,
    hitThreshold: args.hitThreshold,
    mode: args.mode === 'continuous' ? 'continuous' : 'once',
  };
  const owner = deps.owner === undefined ? deps.sessionId : deps.owner;
  const label = typeof deps.label === 'string' && deps.label !== ''
    ? deps.label
    : 'monitor ' + (args.source && args.source.kind ? args.source.kind : 'source');
  const kind = typeof deps.kind === 'string' && deps.kind !== '' ? deps.kind : MONITOR_JOB_KIND;

  let resolveRun;
  const done = new Promise((resolve) => { resolveRun = resolve; });
  let started = false;

  const spec = {
    kind,
    label,
    ...(owner === undefined || owner === null ? {} : { owner }),
    run(job) {
      if (started) {
        // start 只该成功一次；装配层重试若让 run 被调用第二次，第二次必须是空操作。
        return { cancel() {}, done: Promise.resolve({ status: 'killed', detail: 'duplicate start ignored' }) };
      }
      started = true;
      const controller = new AbortController();
      const settled = (async () => {
        try {
          const result = await runMonitor({
            sources,
            decide,
            clock,
            sleep,
            signal: controller.signal,
            args: {
              ...runArgs,
              onProgress: (summary) => {
                updateProgress(job, summary);
                if (typeof deps.onProgress === 'function') return deps.onProgress(summary);
                return undefined;
              },
              onHit: (summary) => {
                deliverHit(summary);
                if (typeof deps.onHit === 'function') return deps.onHit(summary);
                return undefined;
              },
            },
          });
          return { status: 'completed', detail: jobDetail(result), result: jobResultText(result) };
        } catch (error) {
          return { status: 'failed', detail: String(error && error.message ? error.message : error) };
        }
      })();
      resolveRun(settled);
      return {
        cancel(reason) {
          try {
            controller.abort(reason);
          } catch (error) {
            // 已经 abort 过就算了：取消是尽力而为，绝不因此抛出。
          }
        },
        done: settled,
      };
    },
  };

  let jobId;
  try {
    jobId = jobs.start(spec);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    if (!/no job controller serves this agent/i.test(message) || typeof jobs.attachController !== 'function') throw error;
    jobs.attachController(typeof deps.controllerName === 'string' && deps.controllerName !== ''
      ? deps.controllerName
      : 'dsh-decision-tools-monitor');
    jobId = jobs.start(spec);
  }
  return { jobId, done };
}




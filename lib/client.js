/**
 * Ollama System One HTTP 客户端。
 *
 * 只负责四件事：拼 URL、发请求、把超时/取消/HTTP 失败映射成可行动的 SystemOneError、
 * 原样返回 `{ model, answers, usage }`。
 * 它**不认识 DSH** —— 便于将来被 CLI 或评测装置直接复用。
 *
 * @module dsh-decision-tools/client
 */

/** Clef 系模型在 Ollama 0.35.1 上的已知缺陷标记（本机实测：任何请求都触发）。 */
const BROKEN_MODEL_MARKER = 'non-finite logit';

/** 一次决策调用失败。`kind` 是稳定判据，`hint` 是给模型的下一步建议。 */
export class SystemOneError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: string, status?: number, hint?: string, actual?: number, limit?: number }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'SystemOneError';
    this.kind = info.kind;
    this.status = info.status;
    this.hint = info.hint;
    // 只有**带数字**的溢出分支（A 分支）才有这两个字段，供自动提升（ADR-8）一次选档。
    // B 分支（clef 系）两者都保持 undefined —— 上层必须回落到声明容量（规格 §3.2 分支表）。
    this.actual = info.actual;
    this.limit = info.limit;
  }
}

/**
 * 服务端的上下文溢出报错。本机实测原文（当时的探测产物**已随 v3 交付清理**；原文形状如下）：
 * `prompt 0 has 2359 tokens; expected 1–2050 (input is never truncated)` ——
 * `1` 与上限之间是 **en dash U+2013**。这里按 `-` / `–` 双写容忍并允许数字两侧空白，
 * 两个数字分别捕获（实际 token 数、上限）。
 */
const CONTEXT_OVERFLOW_RE = /prompt\s+\d+\s+has\s+(\d+)\s+tokens?;\s*expected\s+1\s*[-\u2013]\s*(\d+)/i;

/**
 * 服务端**不打印数字**的溢出报错。本机实测（当时三条记录；产物已随 v3 交付清理）：
 * `clef-flash` / `clef` 两个带 vision 的模型走这一支，而 `tev1` 系 / `nimble` 走带数字那一支。
 * 它与上面那条是**同一个失败**，只是服务端不给 `actual` / `limit` —— 判据必须仍是 `context_overflow`：
 * 否则调用方会拿到「题型/选项数」那条**错误**的 hint，而自动提升（ADR-8）也永远不会被触发。
 * （「因 vision 而走不同分支」这一因果**未验证**，只登记相关关系。）
 */
const CONTEXT_OVERFLOW_OPAQUE_RE = /decision prompt exceeds the model context/i;

/**
 * **Ollama 0.40.5 起**的溢出报错 —— 厂商换了措辞，判据必须**两种都认**（旧文案仍可能出现在别的
 * 模型/版本上）。本机实测原文（2026-10-16 实测，43341 B 真实技术文档切片 → HTTP 400；
 * 可复跑 `node .temp/task-21/probe-overflow.mjs`）：
 *
 * `request (13900 tokens) exceeds the available context size (8192 tokens), try increasing it`
 *
 * 两个数字仍是「实际 token 数」与「有效上限」，与旧文案**同形状** ⇒ 汇入同一个 `numbered` 分支，
 * 供 `selectEscalation` 一次选档。换文案曾让本函数返 `null` ⇒ 真机**自动升档与 deep 内部分块
 * 整体失效**，且 400 降级成 `invalid_request`、hint 指向「题型/选项数」（P0，2026-10-16 修）。
 */
const CONTEXT_OVERFLOW_CURRENT_RE = /request\s*\(\s*(\d+)\s*tokens?\s*\)\s*exceeds the available context size\s*\(\s*(\d+)\s*tokens?\s*\)/i;

/**
 * 判定一条服务端错误文本是否属于上下文溢出，并取出**可得**的数字。
 *
 * **三种文案都要认**（厂商换过措辞，少认一种就会让真机上的升档/分块静默失效）：
 * ① 旧文案 `prompt 0 has … expected 1–M …` → 带数字；
 * ② **0.40.5 起** `request (N tokens) exceeds the available context size (M tokens)…` → 带数字；
 * ③ `decision prompt exceeds the model context…` → 不带数字。
 *
 * 返回值三分：`{ numbered: true, actual, limit }`（A 分支）、`{ numbered: false }`（B 分支，
 * 两者都没有）、`null`（压根不是溢出 —— 交给 400 兜底分支，保持原行为）。
 *
 * @param {string} detail 服务端错误文本
 * @returns {{ numbered: true, actual: number, limit: number }|{ numbered: false }|null}
 */
export function classifyOverflow(detail) {
  const matched = CONTEXT_OVERFLOW_RE.exec(detail) ?? CONTEXT_OVERFLOW_CURRENT_RE.exec(detail);
  if (matched !== null) {
    return { numbered: true, actual: Number(matched[1]), limit: Number(matched[2]) };
  }
  if (CONTEXT_OVERFLOW_OPAQUE_RE.test(detail)) return { numbered: false };
  return null;
}

/** 从响应体里取出服务端错误文本（Ollama 的 `error` 可能是字符串或对象）。 */
function extractErrorDetail(text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.error === 'string') return parsed.error;
    if (parsed?.error !== undefined) return JSON.stringify(parsed.error);
  } catch {
    // 不是 JSON，退回原文
  }
  return text.trim() || '(空响应体)';
}

/**
 * 把服务端的上下文溢出报错映射成 `context_overflow`；形状不匹配时返回 `null`
 * （交给调用方的 400 兜底分支）。
 */
function toContextOverflowError(detail, status) {
  const classified = classifyOverflow(detail);
  if (classified === null) return null;
  // A 分支的文案**逐字节保持不变**（既有用例钉住了它）。
  const numbers = classified.numbered
    ? `${classified.actual} token，上限 ${classified.limit}。`
    : '服务端未给出具体 token 数（该模型走不打印数字的分支）。';
  return new SystemOneError(
    `请求超出模型上下文：${numbers}服务端原文：${detail}`,
    {
      kind: 'context_overflow', status,
      actual: classified.actual, limit: classified.limit,
      // 三条可行动项。必须明说「未被截断」：这不是截断后的降级回答，服务端是整条拒绝的，
      // 调用方不能把任何部分结果当成答案 —— 这一点正是原 hint 完全没提的。
      hint: '输入未被截断（服务端直接拒绝，不会给出部分答案）。三条可行动项：'
        + '① 缩小 material；'
        + '② 调高该模型的 num_ctx（ollama 模型参数 / Modelfile 的 PARAMETER num_ctx）后重启；'
        + '③ 换一个有效 num_ctx 更大的模型。',
    },
  );
}

function toTransportError(error, { baseUrl, model, timeoutMs, signal }) {
  // fetch 的 **blocked port**（WHATWG Fetch 的"坏端口"）必须最先分流：请求在**本地**就被拒，
  // 服务端一条都收不到（本机实测 2026-10-16：5060/5061/4190/6666-6669/6679/6697 全部
  // 服务端 requests.length=0，而紧邻的非表内端口 5062/6670 正常）。若不在这里分流，
  // 它会落进下面的 `name === 'TypeError'` 兜底被判成 unreachable —— 调用方拿到
  // 「确认 Ollama 已在运行（ollama serve）」，一个与本故障完全无关的原因，并会反复重试。
  // 旧测试装置就撞过这个坑：listen(0) 偶尔给到禁用端口，用例看到 unreachable。
  if (error?.name === 'TypeError' && /bad port/i.test(error?.cause?.message ?? '')) {
    return new SystemOneError(
      `端口被 fetch 在本地拒绝：${baseUrl} 的端口在 WHATWG Fetch 的 blocked port 列表里，请求从未发出（服务端收不到任何请求）。`,
      {
        kind: 'bad_port',
        hint: '这个端口永远发不出请求：换一个端口，或改 baseUrl 指向 Ollama 实际监听的端口'
          + '（禁用端口如 5060/5061/6666-6669 由 fetch 固定拒绝）。这与「Ollama 是否在运行」无关。',
      },
    );
  }
  const name = error?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    if (signal?.aborted) {
      return new SystemOneError('调用被取消。', { kind: 'aborted' });
    }
    return new SystemOneError(
      `${model} 在 ${timeoutMs} ms 内没有返回。`,
      {
        kind: 'timeout',
        hint: '首次调用含模型加载（本机实测 0.8B 约 12s、4.2B 约 18.5s）；可调大 timeoutMs。',
      },
    );
  }
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND' || name === 'TypeError') {
    return new SystemOneError(
      `无法连接 Ollama：${baseUrl}`,
      { kind: 'unreachable', hint: '确认 Ollama 已在运行（ollama serve）。' },
    );
  }
  return new SystemOneError(`请求失败：${error?.message ?? String(error)}`, { kind: 'transport' });
}

function toHttpError(status, text, model) {
  const detail = extractErrorDetail(text);
  if (status === 404) {
    return new SystemOneError(`模型 ${model} 未下载。`, {
      kind: 'model_missing', status, hint: `先运行：ollama pull ${model}；再用 node scripts/list-models.mjs 看本机已装模型`,
    });
  }
  if (status === 413) {
    return new SystemOneError('请求体超过服务端上限。', {
      kind: 'too_large', status, hint: '无图请求上限 64 KiB；请缩小 material，或减少本次项数 / 问题数。',
    });
  }
  if (status === 400) {
    // 上下文溢出优先分流：ADR-15 之后线格式只有一个产地（lib/wire.js），产不出形状有问题的 400
    // （数组→对象只有 wire.js 一个产者，模型直接给对象又被本地校验拒掉），所以真机上
    // **会发生的** 400 是这一种。有效上限是模型的 num_ctx（2026-10-15 实测 tev1:0.8b = 8192；
    // 该值随模型重拉而变，此前是 2050），不是架构声明的 context length（262144）——
    // 报错里给的正是服务端算出的真实数字。
    const overflow = toContextOverflowError(detail, status);
    if (overflow !== null) return overflow;
    // 兜底：形状/题型类的 400 在 ADR-6 之后属非预期（本地套件的线格式守卫仍会走到这里）。
    // 不提 questions 的线格式：本层只收线格式层（lib/wire.js）产出的对象映射，而工具对模型
    // 公布的契约是 items / questions 数组（本地校验还会拒绝模型直接给对象）—— 让模型去改
    // 形状等于派一次注定失败的重试。
    return new SystemOneError(`Ollama 拒绝了请求：${detail}`, {
      kind: 'invalid_request', status,
      hint: '问题类型只允许 choice、noul、score；choice 选项数需在 2–255、score 等级数需在 2–10；同一调用内题名必须唯一。',
    });
  }
  if (status === 500 && detail.includes(BROKEN_MODEL_MARKER)) {
    return new SystemOneError(`模型 ${model} 在本机 Ollama 上有已知缺陷：${detail}`, {
      kind: 'model_broken', status, hint: '换一个 decision 模型重试（如 tev1:0.8b / nimble:latest）；node scripts/list-models.mjs 会列出本机已装模型并给出 ladder 片段。',
    });
  }
  if (status >= 500) {
    return new SystemOneError(`Ollama 服务端错误：${detail}`, { kind: 'server_error', status });
  }
  return new SystemOneError(`Ollama 返回 HTTP ${status}：${detail}`, { kind: 'http_error', status });
}

/** 端点路径。**相对** baseUrl 解析 —— 前导斜杠会丢弃 baseUrl 的路径前缀。 */
const ENDPOINT_PATH = 'v1/systemone';

/** 配置类错误：请求还没成形，与服务端无关，故单列 `bad_config`。 */
function toConfigError(message, hint) {
  return new SystemOneError(message, { kind: 'bad_config', hint });
}

/**
 * 解析端点 URL。baseUrl 非法时抛 `bad_config`，而不是裸 `TypeError: Invalid URL`
 * （那会逃出本模块 `@throws {SystemOneError}` 的契约，让按 `kind` 分派的上层拿到
 * 一个没有判据的异常）。
 */
function resolveEndpointUrl(baseUrl, endpointPath = ENDPOINT_PATH) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw toConfigError(
      `baseUrl 必须是非空字符串（收到 ${JSON.stringify(baseUrl)}）。`,
      '例如 http://localhost:11434；若 Ollama 挂在子路径下，写成 http://host:port/<前缀>。',
    );
  }
  try {
    // 末尾补斜杠后再拼**相对**路径：写成 '/v1/systemone' 是根相对引用，会把
    // baseUrl 的路径前缀**静默丢弃**（实测 http://host/ollama → http://host/v1/systemone）。
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const path = typeof endpointPath === 'string' && endpointPath.trim() !== ''
      ? endpointPath.trim().replace(/^\/+/, '')
      : ENDPOINT_PATH;
    return new URL(path, base).toString();
  } catch {
    throw toConfigError(
      `baseUrl 不是合法 URL：${JSON.stringify(baseUrl)}。`,
      '它必须是含协议的绝对 URL，例如 http://localhost:11434。',
    );
  }
}

/**
 * 造超时信号。0 / 负数会让 `AbortSignal.timeout` 抛 `RangeError`（逃出 SystemOneError
 * 契约），NaN 会被静默当成立即中止，而 schemastery 又会把 NaN 折成 `null`（`.min()`
 * 拦不住）—— 故这里显式把关。
 */
function toTimeoutSignal(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw toConfigError(
      `timeoutMs 必须是正的有限数（收到 ${JSON.stringify(timeoutMs)}）。`,
      '它是一次请求的毫秒预算（含冷加载），默认 120000。',
    );
  }
  return AbortSignal.timeout(timeoutMs);
}

/** 非数组的普通对象 —— answers / usage 的线格式判据。 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 上游回包形状不对时一律判 `bad_response`（与「非 JSON」「缺 answers」同一支）。 */
function badShape(message, status) {
  return new SystemOneError(message, {
    kind: 'bad_response', status,
    hint: '这是服务端/代理返回了非 Ollama 契约的响应体；确认 baseUrl 指向 Ollama 本体，并检查中间是否有反向代理改写响应。',
  });
}

/**
 * 调用 `POST {baseUrl}/v1/systemone`。
 * @param {{ baseUrl: string, body: object, timeoutMs: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ model: string, answers: Record<string, unknown>, usage?: object }>}
 * @throws {SystemOneError}
 */
export async function callSystemOne({
  baseUrl, body, timeoutMs, signal, apiKey, path, fetchImpl = fetch,
}) {
  const url = resolveEndpointUrl(baseUrl, path);
  const timeoutSignal = toTimeoutSignal(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(typeof apiKey === 'string' && apiKey.trim() !== '' ? { authorization: 'Bearer ' + apiKey.trim() } : {}),
      },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    throw toTransportError(error, { baseUrl, model: body.model, timeoutMs, signal });
  }

  // 读 body 也必须守卫：socket 在响应头到达之后、body 读完之前断掉（undici 抛
  // TypeError: terminated），或信号在读取途中触发，都会从这里逃出去 —— 那会绕过
  // 本函数 @throws {SystemOneError} 的契约，而 Task 4 的工具正是按 kind 分派的，
  // 一个没有 kind 的裸错误会变成工具失败而不是可行动的报错。
  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw toTransportError(error, { baseUrl, model: body.model, timeoutMs, signal });
  }
  if (!response.ok) throw toHttpError(response.status, text, body.model);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SystemOneError(`Ollama 返回了无法解析的响应（HTTP ${response.status}）。`, {
      kind: 'bad_response', status: response.status,
    });
  }
  // 成功路径的形状必须在这里收口。宿主对每个成功返回值依次做三件事
  // （dsh-tools/lib/index.js:3541-3551）：无损 JSON 快照 → output.schema 校验 → render。
  // 三者各自会把越界形状判成 ToolOutputError（INVALID_TOOL_OUTPUT）—— 即**一次成功
  // 调用变成工具失败**，且给不出可行动的判据。所以：
  //   · 缺 model ⇒ 不可无损序列化（值为 undefined 的键）；
  //   · answers 是数组 ⇒ 过了旧的 typeof 判定，却过不了 schema 的 type: object；
  //   · usage 不是对象 ⇒ 同上。
  // 三种都在这里变成带 kind 的 SystemOneError。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badShape('Ollama 响应不是一个 JSON 对象。', response.status);
  }
  const { model, answers, usage } = parsed;
  if (typeof model !== 'string' || model.trim() === '') {
    throw badShape(
      `Ollama 响应里没有 model 字段（收到 ${JSON.stringify(model)}）。`,
      response.status,
    );
  }
  if (!isPlainRecord(answers)) {
    throw badShape(
      answers === undefined
        ? 'Ollama 响应里没有 answers 字段。'
        : `Ollama 响应里的 answers 不是「题名 → 答案」的对象（收到 ${Array.isArray(answers) ? '数组' : JSON.stringify(answers)}）。`,
      response.status,
    );
  }
  if (usage !== undefined && !isPlainRecord(usage)) {
    throw badShape(
      `Ollama 响应里的 usage 不是对象（收到 ${JSON.stringify(usage)}）。`,
      response.status,
    );
  }
  // usage 缺席时该键整个不出现（值为 undefined 的 own key 会被宿主的无损 JSON 判定拒绝）。
  return usage === undefined
    ? { model, answers }
    : { model, answers, usage };
}

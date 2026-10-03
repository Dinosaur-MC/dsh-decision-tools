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
   * @param {{ kind: string, status?: number, hint?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'SystemOneError';
    this.kind = info.kind;
    this.status = info.status;
    this.hint = info.hint;
  }
}

/**
 * 服务端的上下文溢出报错。本机实测原文（`.temp/ctx-probe/probe.out`）：
 * `prompt 0 has 2359 tokens; expected 1–2050 (input is never truncated)` ——
 * `1` 与上限之间是 **en dash U+2013**。这里按 `-` / `–` 双写容忍并允许数字两侧空白，
 * 两个数字分别捕获（实际 token 数、上限）。
 */
const CONTEXT_OVERFLOW_RE = /prompt\s+\d+\s+has\s+(\d+)\s+tokens?;\s*expected\s+1\s*[-\u2013]\s*(\d+)/i;

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
  const matched = CONTEXT_OVERFLOW_RE.exec(detail);
  if (matched === null) return null;
  const actual = matched[1];
  const limit = matched[2];
  return new SystemOneError(
    `请求超出模型上下文：${actual} token，上限 ${limit}。服务端原文：${detail}`,
    {
      kind: 'context_overflow', status,
      // 三条可行动项。必须明说「未被截断」：这不是截断后的降级回答，服务端是整条拒绝的，
      // 调用方不能把任何部分结果当成答案 —— 这一点正是原 hint 完全没提的。
      hint: '输入未被截断（服务端直接拒绝，不会给出部分答案）。三条可行动项：'
        + '① 缩减 state；'
        + '② 调高该模型的 num_ctx（ollama 模型参数 / Modelfile 的 PARAMETER num_ctx）后重启；'
        + '③ 换一个有效 num_ctx 更大的模型。',
    },
  );
}

function toTransportError(error, { baseUrl, model, timeoutMs, signal }) {
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
      kind: 'model_missing', status, hint: `先运行：ollama pull ${model}`,
    });
  }
  if (status === 413) {
    return new SystemOneError('请求体超过服务端上限。', {
      kind: 'too_large', status, hint: '无图请求上限 64 KiB；请缩减 state 或拆分 questions。',
    });
  }
  if (status === 400) {
    // 上下文溢出优先分流：ADR-6 之后 prepareRequest 产不出形状有问题的 400（数组→对象
    // 只有 lib/validate.js:195 一个产者，模型直接给对象又被 V1 本地拒掉），所以真机上
    // **会发生的** 400 是这一种。有效上限是模型的 num_ctx（本机 tev1:0.8b = 2050），
    // 不是架构声明的 context length（262144）—— 报错里给的正是服务端算出的真实数字。
    const overflow = toContextOverflowError(detail, status);
    if (overflow !== null) return overflow;
    // 兜底：形状/题型类的 400 在 ADR-6 之后属非预期（本地套件的线格式守卫仍会走到这里）。
    // 不提 questions 的线格式：本层只收 prepareRequest 产出的对象映射，而工具对模型
    // 公布的契约是数组（lib/validate.js 的 V1 还会拒绝模型直接给对象）—— 让模型去改
    // 形状等于派一次注定失败的重试。
    return new SystemOneError(`Ollama 拒绝了请求：${detail}`, {
      kind: 'invalid_request', status,
      hint: '问题类型只允许 choice、noul、score；choice 的选项数与 score 的等级数需在 2–26；同一调用内题名必须唯一。',
    });
  }
  if (status === 500 && detail.includes(BROKEN_MODEL_MARKER)) {
    return new SystemOneError(`模型 ${model} 在本机 Ollama 上有已知缺陷：${detail}`, {
      kind: 'model_broken', status, hint: '改用 tev1 系模型（如 tev1:0.8b）；clef 系当前不可用。',
    });
  }
  if (status >= 500) {
    return new SystemOneError(`Ollama 服务端错误：${detail}`, { kind: 'server_error', status });
  }
  return new SystemOneError(`Ollama 返回 HTTP ${status}：${detail}`, { kind: 'http_error', status });
}

/**
 * 调用 `POST {baseUrl}/v1/systemone`。
 * @param {{ baseUrl: string, body: object, timeoutMs: number, signal?: AbortSignal, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ model: string, answers: Record<string, unknown>, usage?: object }>}
 * @throws {SystemOneError}
 */
export async function callSystemOne({
  baseUrl, body, timeoutMs, signal, fetchImpl = fetch,
}) {
  const url = new URL('/v1/systemone', baseUrl).toString();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.answers !== 'object' || parsed.answers === null) {
    throw new SystemOneError('Ollama 响应里没有 answers 字段。', {
      kind: 'bad_response', status: response.status,
    });
  }
  return { model: parsed.model, answers: parsed.answers, usage: parsed.usage };
}

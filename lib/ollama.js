/**
 * 本地 Ollama 的模型发现（`/api/tags` + `/api/show`）。
 *
 * 为什么需要：插件默认 `tev1:0.8b`、升档阶梯也写死了四个型号与 numCtx，但本机实际装了哪些
 * decision 模型、每个模型真实上下文多长，只能问 Ollama。没有这层，用户换模型就得靠猜；
 * 升档时踩到「模型没装」也只会得到一条 model_missing。
 *
 * 本模块**不决定用哪个模型**：只把事实读出来（名称 / 参数量 / 上下文长度），让用户与装配层去选。
 * 网络与解析都可注入，便于单测；纯读，不写任何状态。
 * @module dsh-decision-tools/ollama
 */

export const DEFAULT_OLLAMA_BASE = 'http://localhost:11434';

export class OllamaDiscoveryError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'OllamaDiscoveryError';
    this.kind = typeof info.kind === 'string' && info.kind !== '' ? info.kind : 'transport';
    if (typeof info.hint === 'string' && info.hint !== '') this.hint = info.hint;
  }
}

/** 规范化 baseUrl：去尾斜杠、要求绝对 URL；非法时抛可行动错误（不裸 TypeError）。 */
export function normalizeBase(baseUrl = DEFAULT_OLLAMA_BASE) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new OllamaDiscoveryError('baseUrl 必须是非空字符串（例如 http://localhost:11434）。', { kind: 'bad_config' });
  }
  let url;
  try { url = new URL(baseUrl); } catch {
    throw new OllamaDiscoveryError('baseUrl 不是合法 URL：' + JSON.stringify(baseUrl) + '。', {
      kind: 'bad_config',
      hint: '它必须是含协议的绝对地址，例如 http://localhost:11434。',
    });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // `new URL('localhost:11434')` 会把 `localhost:` 当协议解析成功 —— 必须显式认协议，
    // 否则「忘了写 http://」会被当成合法配置，直到 fetch 阶段才炸。
    throw new OllamaDiscoveryError('baseUrl 必须是 http(s) 地址：' + JSON.stringify(baseUrl) + '。', {
      kind: 'bad_config',
      hint: '补上协议，例如 http://localhost:11434。',
    });
  }
  return url.toString().replace(/\/$/, '');
}

const asNumber = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * 列出已安装模型（`GET /api/tags`）。
 * @returns {Promise<Array<{name: string, sizeBytes?: number, family?: string, parameters?: string, modifiedAt?: string}>>}
 */
export async function listModels(options = {}) {
  const base = normalizeBase(options.baseUrl === undefined ? DEFAULT_OLLAMA_BASE : options.baseUrl);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs) : 10000;
  if (typeof fetchImpl !== 'function') throw new OllamaDiscoveryError('当前环境没有 fetch。', { kind: 'bad_config' });
  const path = typeof options.modelsPath === 'string' && options.modelsPath.trim() !== ''
    ? options.modelsPath.trim().replace(/^\/+/, '')
    : 'api/tags';
  const headers = {
    accept: 'application/json',
    ...(typeof options.apiKey === 'string' && options.apiKey.trim() !== ''
      ? { authorization: 'Bearer ' + options.apiKey.trim() }
      : {}),
  };
  let response;
  try {
    response = await fetchImpl(base + '/' + path, { signal: options.signal, headers });
  } catch (error) {
    throw new OllamaDiscoveryError('无法连接 Ollama：' + base + '（' + String(error && error.message ? error.message : error) + '）。', {
      kind: 'transport',
      hint: '确认 Ollama 正在运行、baseUrl 端口正确。',
    });
  }
  if (response === null || typeof response !== 'object') throw new OllamaDiscoveryError('Ollama 返回了非响应对象。', { kind: 'bad_response' });
  if (response.ok === false) {
    throw new OllamaDiscoveryError('GET ' + base + '/' + path + ' 失败（HTTP ' + response.status + '）。', { kind: 'http_error' });
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new OllamaDiscoveryError('模型列表接口的响应不是合法 JSON。', { kind: 'bad_response' });
  }
  const rows = payload && Array.isArray(payload.models)
    ? payload.models
    : (payload && Array.isArray(payload.data) ? payload.data : []);
  return rows
    .filter((row) => row && (typeof row.name === 'string' || typeof row.id === 'string'))
    .map((row) => {
      const name = typeof row.name === 'string' ? row.name : row.id;
      return {
        name,
        ...(asNumber(row.size) === undefined ? {} : { sizeBytes: row.size }),
        ...(typeof row.details?.family === 'string' ? { family: row.details.family } : {}),
        ...(typeof row.details?.parameter_size === 'string' ? { parameters: row.details.parameter_size } : {}),
        ...(typeof row.modified_at === 'string' ? { modifiedAt: row.modified_at } : {}),
      };
    });
}

/**
 * 读单个模型的元数据（`POST /api/show`），从中取上下文长度。
 * Ollama 把上下文放在 `model_info` 里，键名随架构变化（如 `llama.context_length`）⇒ 取所有 `*.context_length` 的最大值。
 * @returns {Promise<{contextLength?: number, family?: string, parameters?: string, capabilities?: string[]}>}
 */
export async function describeModel(name, options = {}) {
  if (typeof name !== 'string' || name === '') throw new OllamaDiscoveryError('describeModel 需要模型名。', { kind: 'bad_config' });
  const base = normalizeBase(options.baseUrl === undefined ? DEFAULT_OLLAMA_BASE : options.baseUrl);
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  let response;
  try {
    response = await fetchImpl(base + '/api/show', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(typeof options.apiKey === 'string' && options.apiKey.trim() !== ''
          ? { authorization: 'Bearer ' + options.apiKey.trim() }
          : {}),
      },
      body: JSON.stringify({ model: name }),
      signal: options.signal,
    });
  } catch (error) {
    throw new OllamaDiscoveryError('无法连接 Ollama：' + base + '（' + String(error && error.message ? error.message : error) + '）。', { kind: 'transport' });
  }
  if (response === null || typeof response !== 'object') throw new OllamaDiscoveryError('Ollama 返回了非响应对象。', { kind: 'bad_response' });
  if (response.ok === false) {
    throw new OllamaDiscoveryError('模型 ' + name + ' 的 /api/show 失败（HTTP ' + response.status + '）。', {
      kind: 'http_error',
      hint: '确认模型名拼写与 ollama list 一致。',
    });
  }
  let payload;
  try { payload = await response.json(); } catch {
    throw new OllamaDiscoveryError('模型 ' + name + ' 的 /api/show 响应不是合法 JSON。', { kind: 'bad_response' });
  }
  const info = payload && typeof payload.model_info === 'object' && payload.model_info !== null ? payload.model_info : {};
  let contextLength;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue;
    const n = asNumber(value);
    if (n !== undefined && (contextLength === undefined || n > contextLength)) contextLength = n;
  }
  return {
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(typeof payload?.details?.family === 'string' ? { family: payload.details.family } : {}),
    ...(typeof payload?.details?.parameter_size === 'string' ? { parameters: payload.details.parameter_size } : {}),
    ...(Array.isArray(payload?.capabilities) ? { capabilities: payload.capabilities.filter((c) => typeof c === 'string') } : {}),
  };
}

/**
 * 发现 = `/api/tags` + 逐个 `/api/show`。任一 show 失败**不整体失败**（模型可能正在加载/已损坏），
 * 该条只剩名称，`contextLength` 缺省 —— 调用方可据此决定是否收进 ladder。
 */
export async function discoverModels(options = {}) {
  const models = await listModels(options);
  const out = [];
  for (const model of models) {
    try {
      const meta = await describeModel(model.name, options);
      out.push({ ...model, ...meta });
    } catch (error) {
      out.push({ ...model, ...(error && error.kind ? { metaError: error.kind } : {}) });
    }
  }
  return out;
}

/**
 * 并行版：列表 + 每个模型的 /api/show 详情。单个 show 失败只丢该模型的详情，
 * 不影响整张列表；远端 OpenAI 兼容接口通常没有 /api/show，会自然退化为名称+size。
 */
export async function listModelsWithDetails(options = {}) {
  const models = await listModels(options);
  return Promise.all(models.map(async (model) => {
    try {
      return { ...model, ...(await describeModel(model.name, options)) };
    } catch (error) {
      return { ...model, ...(error && error.kind ? { metaError: error.kind } : {}) };
    }
  }));
}

/**
 * 把发现结果转成可直接粘进 `Config.ladder` 的数组（按上下文长度升序，只收有数字的）。
 * `numCtx` 用**声明的** context_length：它是上限，实际 num_ctx 可能更小（本机实测 tev1 声明 262144 / 实际 8192），
 * 所以这里只作为阶梯的保守上限，不是运行时保证。
 */
export function formatLadder(models) {
  const rows = (Array.isArray(models) ? models : [])
    .filter((m) => m && typeof m.name === 'string' && Number.isFinite(m.contextLength) && m.contextLength > 0)
    .map((m) => ({ model: m.name, numCtx: Math.trunc(m.contextLength) }));
  const seen = new Set();
  return rows
    .filter((row) => (seen.has(row.model) ? false : (seen.add(row.model), true)))
    .sort((a, b) => a.numCtx - b.numCtx);
}
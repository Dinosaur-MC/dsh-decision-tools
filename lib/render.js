/**
 * 把 v3 的 `results` / `coverage` / `material` / `cost` / `notes` 渲染成模型可读的紧凑文本。
 *
 * 为什么不做成 JSON：模型读逐行文本比读嵌套 JSON 更省 token 也更不易误读；概率按降序
 * 排列，让「次优选项」可见 —— 低 confidence 时的决策依据正是分布本身，而不是那个被选中的
 * 结论。完整原始值仍可通过 output.schema 取到。
 *
 * **本层只呈现，不做任何策略判断**（ADR-13 / 规格 §4.8）：超限归因、低置信点名、分批与
 * 分块提示都由工具层拼成 `notes[]` 字符串，这里**原样逐行打印**。凡是在 render 里比较阈值
 * 或自行拼一句告警的实现，都会被 `test/render.test.mjs` 的逐字全文断言打红。
 *
 * **必须是全函数（绝不抛错）**：宿主把 render 的异常包成
 * `ToolOutputError: output.render failed: …`，于是一次**成功**的调用会变成工具失败。
 * 残缺 / 异形 value 一律退化成占位符 `—`，不是异常。
 *
 * 纯函数，零 import，只产出 `{ type: 'text', text }` 形状，无 DSH 依赖。
 * @module dsh-decision-tools/render
 */

/** 数值缺失或非有限时的占位符：既不写 `undefined`，也不抛错。 */
const DASH = '—';

/** 题型列的宽度（choice/score/noul 都放进 6 列，让后面的结论对齐）。 */
const TYPE_WIDTH = 6;

/** 非数组的普通对象判据（本模块零 import，故自带一份）。 */
function isPlainRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 有限数原样成串；否则退化占位。 */
function formatInteger(value) {
  return Number.isFinite(value) ? String(value) : DASH;
}

/** 有限数按固定小数位格式化；否则退化占位。 */
function formatNumber(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : DASH;
}

/** 三态布尔：只有字面 true/false 才算，其余退化占位（`undefined` 与 `false` 不是一回事）。 */
function formatBoolean(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return DASH;
}

/** 只接受非空字符串，其余退化占位（避免 `[object Object]` 之类漏进输出）。 */
function formatText(value) {
  return typeof value === 'string' && value !== '' ? value : DASH;
}

/** JSON 化的兜底：`undefined`/函数/循环引用都不得抛错。 */
function stringify(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 排序键：非数值项一律排到最后，避免比较器返回 NaN 造成乱序。 */
function orderKey(value) {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/** 概率按降序排成 `k=0.1234`，四位小数足够分辨；非数值项退化占位而非抛错。 */
function formatProbabilities(probabilities) {
  if (!isPlainRecord(probabilities)) return DASH;
  return Object.entries(probabilities)
    .sort(([, left], [, right]) => orderKey(right) - orderKey(left))
    .map(([key, value]) => `${key}=${formatNumber(value, 4)}`)
    .join(', ');
}

/**
 * 每个结果一行。`noul` **只打 P(true)**（取自 `probabilities.true`），不打那个布尔 `value`：
 * 布尔是阈值化的产物，而低置信时决策依据是概率本身（写出来会让模型把概率读成判定）。
 * `choice`/`score` 的 `value` 是所选标签（`score` 不是 0..N-1 的数字），概率按降序列在右边。
 * 未答项（`value` 为 null/undefined）逐项占位，**绝不错位、绝不吞掉**。
 */
function formatResult(result, width) {
  const label = String(result?.id ?? DASH).padEnd(width);
  const type = typeof result?.type === 'string' && result.type !== '' ? result.type : 'unknown';
  if (!isPlainRecord(result)) return `${label}  ${type}  ${stringify(result)}`;
  const head = `${label}  ${type.padEnd(TYPE_WIDTH)}  `;
  const answered = result.value !== null && result.value !== undefined;
  if (!answered) return `${head}(no answer)`;
  if (type === 'noul') return `${head}P(true)=${formatNumber(result.probabilities?.true, 4)}`;
  // choice / score 的读法相同（value 都是标签）；未知题型走 JSON 兜底而不是抛错。
  if (type === 'choice' || type === 'score') {
    return `${head}${String(result.value)}  p={${formatProbabilities(result.probabilities)}}`
      + `  conf=${formatNumber(result.confidence, 3)}`;
  }
  return `${head}${stringify(result)}`;
}

/**
 * `coverage` 的一行：对内部路径（分批 / 截断 / 失败 / 取消）的**如实报告**，不是旋钮回执。
 * `truncatedBy` 只在真的截断时出现 —— 未截断还打 `(by=null)` 只会制造噪音。
 */
function formatCoverage(coverage) {
  const by = coverage.truncated === true && coverage.truncatedBy !== null && coverage.truncatedBy !== undefined
    ? `(by=${coverage.truncatedBy})`
    : '';
  return `覆盖: requested=${formatInteger(coverage.requested)} answered=${formatInteger(coverage.answered)}`
    + ` batches=${formatInteger(coverage.batches)} truncated=${formatBoolean(coverage.truncated)}${by}`
    + ` failed=${formatInteger(coverage.failed)} aborted=${formatBoolean(coverage.aborted)}`;
}

/**
 * `material` 的一行。**形状分派必须按 `descriptor.kind`**：glob 没有 `path`/行区间，
 * 按 file 形状渲染会打出 `L—-—` 这种看起来像真数据的假值（v2 起就是用例钉住的点）。
 * 未知 `kind` 一律按 file 形状尽力渲染 —— 本层不得为未知形状抛错。
 */
function formatMaterial(material) {
  const bytes = formatInteger(material.bytes);
  const descriptor = material.descriptor;
  if (!isPlainRecord(descriptor)) return `材料: ${formatText(material.source)}（${bytes}B，不进上下文）`;
  if (descriptor.kind === 'glob') {
    const count = Array.isArray(descriptor.files) ? String(descriptor.files.length) : DASH;
    const cut = descriptor.truncated === true ? '，已截断' : '';
    return `材料: glob ${formatText(descriptor.pattern)}（${count} 个文件${cut}）（${bytes}B，不进上下文）`;
  }
  return `材料: file ${formatText(descriptor.path)} L${descriptor.startLine ?? DASH}-${descriptor.endLine ?? DASH}`
    + `（${bytes}B，不进上下文）`;
}

/** `cost` 的一行：模型、计费 token、请求体字节、墙钟、是否升档、尝试次数。 */
function formatCost(cost) {
  const attempts = Array.isArray(cost.attempts) ? String(cost.attempts.length) : DASH;
  return `cost: model=${formatText(cost.model)} input_tokens=${formatInteger(cost.inputTokens)}`
    + ` body=${formatInteger(cost.bodyBytes)}B wall=${formatInteger(cost.wallMs)}ms`
    + ` escalated=${formatBoolean(cost.escalated)} attempts=${attempts}`;
}

/**
 * 尝试序列**只在真的换过档（> 1 次）时**才展开：单次尝试已由 cost 行的 `attempts=1` 说明。
 * 成功项的 `failureKind` 是 `null`，渲染成 `ok` —— 否则会打出一个看不出是成功的名字。
 */
function formatAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length <= 1) return null;
  return `尝试: ${attempts.map((attempt) => {
    const model = formatText(attempt?.model);
    const kind = typeof attempt?.failureKind === 'string' && attempt.failureKind !== ''
      ? attempt.failureKind
      : 'ok';
    return `${model}(${kind})`;
  }).join(' → ')}`;
}

/**
 * `output.render` 的实现。
 * @param {unknown} _args 调用参数（不参与渲染）
 * @param {unknown} value 已校验的规范返回值（ADR-13 的五键）
 * @param {string} [companionSkillBody] 首次使用时一并交付的配套 skill 正文
 * @returns {{ type: 'text', text: string }[]}
 */
export function renderAnswers(_args, value, companionSkillBody) {
  const results = Array.isArray(value?.results) ? value.results : [];
  const width = results.reduce((max, result) => Math.max(max, String(result?.id ?? DASH).length), 0);
  const lines = results.map((result) => formatResult(result, width));
  // 零结果时给一行明确占位：空文本与「真的没有结果」无法区分，模型会读到一个没有任何内容的
  // 工具结果。占位行之后仍照常输出 coverage / material / cost / notes（部分完成才是常态）。
  if (lines.length === 0) lines.push('(no results returned)');

  if (isPlainRecord(value?.coverage)) lines.push(formatCoverage(value.coverage));
  if (isPlainRecord(value?.material)) lines.push(formatMaterial(value.material));
  if (isPlainRecord(value?.cost)) {
    lines.push(formatCost(value.cost));
    const detail = formatAttempts(value.cost.attempts);
    if (detail !== null) lines.push(detail);
  }

  // notes 是**工具层拼好的字符串**（体积归因 / 低置信点名 / 分批与分块提示），本层原样逐行
  // 输出、保持顺序；空串与缺键同义（否则模型会读到一行空白）。
  if (Array.isArray(value?.notes)) {
    for (const note of value.notes) {
      if (typeof note === 'string') {
        if (note !== '') lines.push(note);
      } else if (note !== null && note !== undefined) {
        lines.push(String(note));
      }
    }
  }

  // 首次使用本工具时把配套 skill 的正文一并交付 —— 「用工具 = 拿到指引」是构造性成立的。
  if (typeof companionSkillBody === 'string' && companionSkillBody.trim() !== '') {
    lines.push('', '=== companion skill: how to read these values ===', companionSkillBody);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * decision 工具的模型可见契约：描述与参数 schema。
 *
 * 纯数据模块，**不 import 任何东西** —— 这样 `test/parameters.test.mjs` 可以直接
 * 断言契约结构，不依赖宿主包解析。
 *
 * 用的是 DSH 的紧凑方言（ParameterSchemaSpec），不是裸 JSON Schema：
 *   - `required: true` 是逐属性注解（不是对象根上的数组）
 *   - 联合类型用 `oneOf`，至少 2 个分支
 *   - `object` 节点**必须**显式写 `additionalProperties`
 *   - 无约束节点是 `{ type: 'json' }`
 *
 * 这里只表达 DSL 能表达的东西（类型、枚举）。数量上限（1–64 题、2–26 选项）
 * 和体积上限由 lib/validate.js 在运行时检查。
 * @module dsh-decision-tools/parameters
 */

/** state 与 instructions 共用的「字符串或结构化内容」联合。 */
const CONTENT_SPEC = {
  oneOf: [
    { type: 'string', description: '纯文本。' },
    { type: 'object', additionalProperties: true, description: '对象；按 JSON 文本发给模型。' },
    { type: 'array', items: { type: 'json' }, description: '数组；按 JSON 文本发给模型。' },
  ],
};

export const TOOL_DESCRIPTION = [
  'Answer bounded decision questions about one shared piece of `state` with a local System One model:',
  'routing, classification, filtering, relevance judgement and scoring — where the candidate set is known',
  'up front and the useful answer is a probability, not prose.',
  'Not for open-ended generation or problems needing a chain of reasoning.',
  '',
  'Usage',
  '- Ask every question about the same material in ONE call. Never loop one call per item: each call re-sends the whole `state`.',
  '- Question types and their limits are in the parameter schema.',
  '',
  'Reading the answers',
  '- `noul` returns a NUMBER, not a boolean: 0.475 does not mean "no", it means a 47.5% chance of yes.',
  '- `score` is reported on the 0..N-1 level scale, not normalised to 0-1.',
  '- `confidence` measures how concentrated the distribution is (1 - H/ln N); it is NOT accuracy. Low confidence',
  '  means the model is torn between options: read `probabilities` instead of the chosen answer, and escalate that',
  '  question to your own reasoning rather than trusting it.',
  '- A `confidence_warning` line names the questions whose confidence fell below the configured threshold (or was',
  '  missing). Those are exactly the ones to escalate: do not use their labels as answers. It is a FLAG, not a',
  '  filter — every answer is still returned, and a question absent from the line is NOT thereby endorsed.',
  '',
  'Hard boundaries',
  '- These answers are PROBABILITIES, not proof. Never treat a result as correctness evidence, and never let it be',
  '  the sole basis for a pass/allow decision — that requires artifact-level evidence. Use it for triage only.',
  '- This tool must NOT decide routing, and must NOT be the basis of any fail-open or fail-closed policy: that',
  '  belongs to deterministic rules, otherwise a broken decision model would break routing entirely.',
  '- The tev1 family returns only probabilities and never text, so when a human-readable rationale must be',
  '  preserved as evidence, use a generative model instead.',
  '',
  'v2 additions',
  '- `state` and `stateSource` are MUTUALLY EXCLUSIVE: give exactly one. With `stateSource` the material is read',
  '  from a workspace-relative path (optionally a line range, or a single-level glob) and never enters your',
  '  context — prefer it for anything large.',
  '- `strategy`: auto (default) = send, then escalate, then scan; inline = never scan; scan = always scan.',
  '- In scan mode the result carries `chunks` (one entry per chunk with its line range) and NO top-level',
  '  `answers`; `scan.truncated` / `scan.aborted` mean the scan is partial, and `aggregate` is provisional.',
  '- Scanning answers PER-CHUNK questions. It does not answer a question about the whole document — for those,',
  '  let the plugin escalate instead (a bigger-context model sees the whole thing).',
  '- `escalated` means a DIFFERENT model answered than the one you named; the actual one is echoed in `model`,',
  '  and thresholds calibrated for one model may not apply to another.',
  '- `plan` echoes what the plugin decided (strategy / model / reason) — read it when you need to know what',
  '  actually happened rather than what you asked for.',
].join('\n');

export const PARAMETERS = {
  state: {
    ...CONTENT_SPEC,
    description:
      'The material every question is asked about: a ticket, an email, a document, a JSON record, '
      + 'or a list of candidates. Sent once and shared by all questions.',
  },
  questions: {
    required: true,
    type: 'array',
    description:
      '1-64 questions about `state`, answered in one request. Each question carries its own `name` '
      + '(the key its answer comes back under) and `type`.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          required: true,
          description: 'Identifier for this question; the answer is returned under this key. Must be unique.',
        },
        type: {
          type: 'string',
          required: true,
          enum: ['choice', 'noul', 'score'],
          description:
            'choice = pick one option; noul = probability that something is true; '
            + 'score = rate against ordered levels. Note the spelling: `noul`, not `boolean`.',
        },
        instructions: {
          required: true,
          ...CONTENT_SPEC,
          description: 'What to decide, phrased as a question.',
        },
        criteria: {
          description:
            'choice: an object mapping option name to description (2-26 options). '
            + 'score: an array of level descriptions ordered from lowest to highest (2-26 levels). '
            + 'noul: optional {"false": "...", "true": "..."} descriptions; omit to use No/Yes.',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
    },
    examples: [
      [
        {
          name: 'label',
          type: 'choice',
          instructions: 'Which label fits this ticket?',
          criteria: { billing: 'Payments and refunds', bug: 'Software errors' },
        },
        { name: 'refund', type: 'noul', instructions: 'Is the customer requesting a refund?' },
        {
          name: 'urgency',
          type: 'score',
          instructions: 'How urgently does this need a response?',
          criteria: ['Routine: no time pressure', 'Soon: a customer is inconvenienced', 'Immediate: a critical service is unavailable'],
        },
      ],
    ],
  },
  stateSource: {
    type: 'object',
    additionalProperties: false,
    description:
      'Reference material read by the plugin instead of inline `state` (exactly one of the two). '
      + 'Workspace-relative path only. `file{path,startLine?,endLine?}` reads a path or a 1-based inclusive '
      + 'line range; `glob{pattern,limit?}` reads one level of one directory (no `**`). '
      + 'The material never enters your context — prefer it for anything large.',
    properties: {
      kind: { type: 'string', required: true, enum: ['file', 'glob'] },
      path: { type: 'string', description: 'kind=file: workspace-relative path.' },
      startLine: { type: 'number', description: 'kind=file: 1-based first line (inclusive).' },
      endLine: { type: 'number', description: 'kind=file: 1-based last line (inclusive).' },
      pattern: { type: 'string', description: 'kind=glob: single-level pattern, e.g. docs/*.md.' },
      limit: { type: 'number', description: 'kind=glob: maximum number of files to read.' },
    },
  },
  model: {
    type: 'string',
    description:
      'Override the configured default model for this call; when omitted, the plugin uses its '
      + 'configured default model. '
      + 'Bigger is not necessarily more correct — pick per task and verify. '
      + 'Passing `model` also DISABLES automatic escalation for this call.',
  },
  strategy: {
    type: 'string',
    enum: ['auto', 'inline', 'scan'],
    description:
      'auto (default): send, escalate to a bigger-context decision model on overflow, then fall back to '
      + 'scanning. inline: never scan. scan: always scan (skip the single-shot attempt).',
  },
  aggregate: {
    type: 'string',
    enum: ['none', 'any'],
    description:
      'scan only. none (default): per-chunk answers only. any: adds a PROVISIONAL max probability per noul '
      + 'question — cross-chunk probabilities are not calibrated, never treat it as a decision.',
  },
};

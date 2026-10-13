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
  'routing, classification, filtering, relevance judgement and scoring — the candidate set is known up',
  'front and the answer is a probability, not prose.',
  'Not for open-ended generation or problems needing a chain of reasoning.',
  '',
  'Usage',
  '- Ask every question about the same material in ONE call. Never loop one call per item: each call',
  '  re-sends the whole `state`.',
  '- Give exactly one of `state` (inline material) or `stateSource` (a workspace-relative path, an optional',
  '  1-based inclusive line range, or a glob pattern). Referenced material never enters your context —',
  '  prefer it for anything large.',
  '- `strategy`: auto (default) = send, then escalate, then scan; inline = never scan; scan = always scan.',
  '- In scan mode the result carries `chunks` (per-chunk answers) and NO top-level `answers`; `plan` echoes',
  '  what was decided: strategy, action, model, reason.',
  '',
  'Hard boundaries',
  '- These answers are PROBABILITIES, not proof. Never treat a result as correctness evidence and never let it be',
  '  the sole basis for a pass/allow decision — that needs artifact-level evidence; use it for triage only.',
  '- This tool must NOT decide routing and must NOT be the basis of any fail-open or fail-closed policy:',
  '  that belongs to deterministic rules, or a broken decision model would break routing entirely.',
  '- The tev1 family returns only probabilities and never text, so when a human-readable rationale must be',
  '  preserved as evidence, use a generative model instead.',
  '',
  'Reading the answers, escalation and scanning details live in the `decision-usage` skill.',
].join('\n');

export const PARAMETERS = {
  state: {
    ...CONTENT_SPEC,
    description:
      'The material every question is asked about; sent once and shared by all of them.',
  },
  questions: {
    required: true,
    type: 'array',
    description:
      '1-64 questions about `state`, answered in one request. Each carries `name` (the key its answer comes back under) and `type`.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          required: true,
          description: 'Answer key for this question; must be unique.',
        },
        type: {
          type: 'string',
          required: true,
          enum: ['choice', 'noul', 'score'],
          description:
            'choice | noul | score. `noul` is a probability, not a boolean (note the spelling). See the `decision-usage` skill.',
        },
        instructions: {
          required: true,
          ...CONTENT_SPEC,
          description: 'What to decide, phrased as a question.',
        },
        criteria: {
          description:
            'choice: option name → description (2-26). score: level descriptions, lowest to highest (2-26). noul: optional false/true descriptions; omit for No/Yes.',
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
      'Reference material instead of inline `state` (exactly one of the two); it never enters your context. Use `file{path,startLine?,endLine?}` or `glob{pattern,limit?}` — workspace-root-relative only. See the `decision-usage` skill.',
    properties: {
      kind: { type: 'string', required: true, enum: ['file', 'glob'] },
      path: { type: 'string', description: 'kind=file: workspace-relative path.' },
      startLine: { type: 'number', description: 'kind=file: 1-based first line (inclusive).' },
      endLine: { type: 'number', description: 'kind=file: 1-based last line (inclusive).' },
      pattern: { type: 'string', description: 'kind=glob: pattern, e.g. docs/*.md or docs/**/*.md (`**` = any depth).' },
      limit: { type: 'number', description: 'kind=glob: maximum number of files to read.' },
    },
  },
  model: {
    type: 'string',
    description:
      'Override the model for this call; when omitted the plugin picks one by the size of the material. Passing `model` also disables automatic escalation.',
  },
  strategy: {
    type: 'string',
    enum: ['auto', 'inline', 'scan'],
    description:
      'auto (default): send, then escalate, then scan. inline: never scan. scan: always scan.',
  },
  aggregate: {
    type: 'string',
    enum: ['none', 'any'],
    description:
      'scan only. none (default): per-chunk answers. any: adds a provisional per-question max — not calibrated.',
  },
};
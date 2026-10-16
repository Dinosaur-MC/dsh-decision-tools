/**
 * decision 工具的模型可见契约：描述与参数 schema（v3 领域接口，ADR-11..15）。
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
 * 这里只表达 DSL 能表达的东西（类型、枚举）。**模式互斥**（`items` 与 `questions` 恰有其一）
 * 与数量上限（1–64 项、choice 2–255 / score 2–10）由 `lib/validate.js` 在运行时检查 ——
 * 用 `oneOf` 写模式分支会把常驻 schema 的注入预算**翻倍**，不划算（ADR-14）。
 * @module dsh-decision-tools/parameters
 */

/** instructions 用的「字符串或结构化内容」联合。 */
const CONTENT_SPEC = {
  oneOf: [
    { type: 'string', description: 'Plain text.' },
    { type: 'object', additionalProperties: true, description: 'Object; sent to the model as JSON.' },
    { type: 'array', items: { type: 'json' }, description: 'Array; sent to the model as JSON.' },
  ],
};

export const TOOL_DESCRIPTION = [
  'Answer bounded decision questions about one shared `material` with a local System One model:',
  'routing, classification, filtering, relevance judgement and scoring — the candidate set is known up',
  'front and the answer is a probability, not prose.',
  'Not for open-ended generation or problems needing a chain of reasoning.',
  '',
  'Usage',
  '- Two mutually exclusive modes. Batch: `material` + `rubric` + `items` + `type` (+ `criteria` for',
  '  choice/score) — one shared criterion, judged independently per item. Mixed: `material` +',
  '  `questions`. Giving both, or neither, is an error.',
  '- `material` is inline text or a reference that never enters your context (`file` / `glob`,',
  '  workspace-root-relative). Write `rubric` ONCE — the wire layer repeats it for the model.',
  '- `depth`: normal (default) picks the smallest model that fits, escalates on overflow, splits into',
  '  batches. quick: default model only, no escalation, no batching (over budget fails). deep: starts',
  '  larger and may chunk the material internally.',
  '- Ask every judgement in ONE call. Never loop one call per item: every call re-sends the whole',
  '  `material`.',
  '',
  'Hard boundaries',
  '- These answers are PROBABILITIES, not proof. Never treat a result as correctness evidence and never let it be',
  '  the sole basis for a pass/allow decision — that needs artifact-level evidence; use it for triage only.',
  '- This tool must NOT decide routing and must NOT be the basis of any fail-open or fail-closed policy:',
  '  that belongs to deterministic rules, or a broken decision model would break routing entirely.',
  '- The tev1 family returns only probabilities and never text, so when a human-readable rationale must be',
  '  preserved as evidence, use a generative model instead.',
  '',
  'Reading `results`/`coverage`/`cost`/`notes` and the per-type semantics live in the `decision-usage` skill.',
].join('\n');

export const PARAMETERS = {
  material: {
    required: true,
    description:
      'The material every judgement is about, sent once and shared by all of them. Inline text, or a reference that never enters your context.',
    oneOf: [
      { type: 'string', description: 'Inline material text.' },
      {
        type: 'object',
        additionalProperties: false,
        description: 'Reference: `{file:{path,startLine?,endLine?}}` or `{glob:{pattern,limit?}}`, workspace-root-relative only.',
        properties: {
          file: {
            type: 'object',
            additionalProperties: false,
            description: 'Read one workspace file (single file: whole file or a 1-based inclusive line range).',
            properties: {
              path: { type: 'string', required: true, description: 'Workspace-relative path.' },
              startLine: { type: 'number', description: '1-based first line (inclusive).' },
              endLine: { type: 'number', description: '1-based last line (inclusive).' },
            },
          },
          glob: {
            type: 'object',
            additionalProperties: false,
            description: 'Collect workspace files by pattern; each file is prefixed with its path.',
            properties: {
              pattern: { type: 'string', required: true, description: 'e.g. docs/*.md or docs/**/*.md (`**` = any depth).' },
              limit: { type: 'number', description: 'Maximum number of files to read.' },
            },
          },
        },
      },
    ],
  },
  rubric: {
    type: 'string',
    description:
      'Batch mode: the ONE shared criterion for every item, written once (a sentence or a short paragraph). The wire layer repeats it for the model.',
  },
  items: {
    type: 'array',
    description:
      'Batch mode: 1-64 self-contained items (short text or id), each judged independently against `rubric`. Mutually exclusive with `questions`.',
    items: { type: 'json' },
  },
  questions: {
    type: 'array',
    description:
      'Mixed mode: 1-64 distinct questions about `material`, answered in one request. Mutually exclusive with `items`.',
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
            'choice: option name → description (2-255). score: level descriptions, lowest to highest (2-10). noul: optional false/true descriptions; omit for No/Yes.',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'array', items: { type: 'string' } },
          ],
        },
      },
    },
  },
  type: {
    type: 'string',
    enum: ['choice', 'noul', 'score'],
    description: 'Batch mode: the question type applied to every item.',
  },
  criteria: {
    description:
      'Batch mode: choice → option name → description (2-255); score → level descriptions, lowest to highest (2-10). Written once; the wire layer copies it to every item.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  depth: {
    type: 'string',
    enum: ['quick', 'normal', 'deep'],
    description:
      'normal (default): pick the smallest model that fits, escalate on overflow, split into batches. quick: default model only, no escalation, no batching (over budget fails). deep: start on a larger model, may chunk internally.',
  },
  model: {
    type: 'string',
    description:
      'Advanced escape hatch: pin the model for this call; disables capacity picking and escalation.',
  },
};

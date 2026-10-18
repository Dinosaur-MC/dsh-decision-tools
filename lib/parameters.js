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
  '  workspace-root-relative). Images: `{images:["a.png"]}` (vision model required). Write `rubric` ONCE — the wire layer repeats it for the model.',
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
      'Shared material: text, text+images, a reference, or a tool. References never enter your context.',
    oneOf: [
      { type: 'string', description: 'Inline material text.' },
      {
        type: 'object',
        additionalProperties: false,
        description: 'Reference: `{file}` / `{glob}` / `{images}`, or `{tool}`. text/file/glob may combine with images.',
        properties: {
          text: {
            type: 'string',
            description: 'Inline text; combine with images only.',
          },
          images: {
            type: 'json',
            description: 'PNG/JPEG/WebP paths (1-8), read and encoded by the plugin. Needs a vision model: pass `model` or set row `modelOverride`.',
          },
          file: {
            oneOf: [
              { type: 'string', description: 'Shorthand text path.' },
              {
                type: 'object',
                additionalProperties: false,
                description: 'Text file with optional line range.',
                properties: {
                  path: { type: 'string', required: true, description: 'Workspace-relative path.' },
                  startLine: { type: 'number', description: '1-based first line.' },
                  endLine: { type: 'number', description: '1-based last line.' },
                },
              },
            ],
          },
          glob: {
            oneOf: [
              { type: 'string', description: 'Shorthand text pattern.' },
              {
                type: 'object',
                additionalProperties: false,
                description: 'Text files by pattern.',
                properties: {
                  pattern: { type: 'string', required: true, description: 'e.g. docs/*.md (`**` = any depth).' },
                  limit: { type: 'number', description: 'Max files to read.' },
                },
              },
            ],
          },
          tool: {
            type: 'object',
            additionalProperties: false,
            description: 'Run a tool and judge its raw output (spilled to `material.spillPath`).',
            properties: {
              name: { type: 'string', required: true },
              arguments: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    ],
  },
  rubric: {
    type: 'string',
    description:
      'Batch mode: the ONE shared criterion for every item. The wire layer repeats it for the model.'
      + ' Mixed mode: appended as a trailing 判据 line (optional).',
  },
  items: {
    type: 'array',
    description:
      'Batch mode: 1-64 self-contained items (strings are valid), each judged against `rubric`. Mutually exclusive with `questions`.',
    items: { type: 'json' },
  },
  questions: {
    type: 'array',
    description:
      'Mixed mode: 1-64 distinct questions about `material`. Mutually exclusive with `items`.',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          required: true,
          description: 'Unique answer key.',
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
            'choice: option→description or string[] (2-255). score: 2-10 levels or {min,max}. noul: optional false/true descriptions.',
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
      'Batch mode: choice→option→description or string[] (2-255); score→2-10 levels or {min,max}. Copied to every item.',
    oneOf: [
      { type: 'object', additionalProperties: true },
      { type: 'array', items: { type: 'string' } },
    ],
  },
  depth: {
    type: 'string',
    enum: ['quick', 'normal', 'deep'],
    description:
      'normal (default): smallest model that fits, escalate on overflow, split into batches. quick: default model only, no escalation or batching. deep: larger model, may chunk internally.',
  },
  model: {
    type: 'string',
    description:
      'Pin the model; disables picking/escalation. "auto" = omit.',
  },
};

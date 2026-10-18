# dsh-decision-tools

**Ask a local model for probabilities, not prose.** Two DSH tools turn bounded judgements into cheap, repeatable calls:

| Tool | What it answers | Typical use |
|---|---|---|
| `decision` | One criterion over 1–64 items, or up to 64 different questions — in **one** call | Filter a list, classify tickets, route requests, rank candidates, "does this log mean failure?" |
| `monitor` | Re-samples one source until your criterion holds | Wait for a build to finish, a line to appear, a job to fail |

Judgements run on **your own Ollama** (`/v1/systemone`). Nothing goes to a cloud provider, and the material never has to enter your conversation.

## Why

- **Cheap by design** — the rubric is sent **once**, and one call judges up to 64 items. Looping one call per item is the expensive anti-pattern.
- **Material stays out of your context** — pass a workspace file, a glob, or another tool's raw output; you only read back the answers.
- **Honest output** — every answer is a probability plus `confidence`, partial work is reported in `coverage`, and `notes` says what the plugin did.

## Requirements

- DSH desktop with this plugin enabled (see Install).
- A local Ollama serving the decision model — default `tev1:0.8b`, override per call with `model`.
- No API key; the judgement itself makes no outbound call.

## Install

Link the workspace into your profile (development) or enable the published bundle, then confirm the tools are visible:

```
cordis_inspect_query(platform="host", provider="Tool", method="listTools")
```

The companion skill `decision-usage` is registered with the tools and documents every parameter; it loads on demand.

### Using a different local model

The shipped defaults (`baseUrl` = `http://localhost:11434`, `defaultModel` = `tev1:0.8b`, and the four-rung `ladder`) are a **snapshot**. Any Ollama model that answers the System One endpoint works:

- pin one for a call — `model: "<name>"` (disables capacity picking and escalation);
- change the session default — `defaultModel`;
- point at another host/port — `baseUrl`;
- control escalation — `ladder: [{ model, numCtx }]` (see Configuration).

To see what is actually installed, and get a paste-ready ladder:

```
node scripts/list-models.mjs          # name · context · parameters · size
node scripts/list-models.mjs --json   # { models, ladder }
```

`numCtx` comes from `/api/show`'s declared context length — an upper bound; the runtime `num_ctx` can be smaller.

## Quick start

```jsonc
// 1) Filter a list: one rubric, N items
{ "material": "<the list or its context>", "rubric": "Is this a bug report?",
  "items": ["app crashes on save", "please add dark mode"], "type": "noul" }

// 2) Ask different questions about one file
{ "material": { "file": { "path": "build.log", "startLine": 1, "endLine": 200 } },
  "questions": [
    { "name": "ok", "type": "noul", "instructions": "Did the build succeed?" },
    { "name": "why", "type": "choice", "instructions": "What failed?",
      "criteria": { "compile": "compile error", "test": "a test failed", "env": "missing dependency" } }
  ] }

// 3) Judge another tool's output without reading it
{ "material": { "tool": { "name": "git_bash", "arguments": { "command": "npm test" } } },
  "rubric": "Did the test suite pass?", "items": ["the test suite output"], "type": "noul" }

// 4) Wait for a background job, and get a notice on a hit
{ "source": { "kind": "job", "id": "<jobId>" },
  "rubric": "Did the job finish successfully?", "background": true, "notify": "inbox" }
```

## `decision`: one call, one mode

Give `material` plus **exactly one** mode:

| Mode | Shape | Meaning |
|---|---|---|
| Batch | `rubric` + `items` + `type` (+ `criteria`) | One shared criterion, judged independently per item |
| Mixed | `questions` | Up to 64 different questions about the same material |

| Parameter | Required | Notes |
|---|---|---|
| `material` | yes | Inline string, `{file}`, `{glob}`, or `{tool}` |
| `rubric` | batch | The one shared criterion; the wire layer repeats it for the model |
| `items` | batch | 1–64 self-contained items; plain strings are valid |
| `questions` | mixed | 1–64 `{name, type, instructions, criteria?}` |
| `type` | batch | `choice` / `noul` / `score` (mixed: per question) |
| `criteria` | choice/score | Labels once: top-level in batch, per question in mixed |
| `depth` | no | `quick` (no escalation/batching), `normal` (default), `deep` (may chunk) |
| `model` | no | Pin a model; disables capacity choice and escalation |

**Material forms**: inline text · `{ file: { path, startLine?, endLine? } }` · `{ glob: { pattern, limit? } }` · `{ tool: { name, arguments? } }`. A tool's raw output never enters your context; the full text is spilled and returned as `material.spillPath`. `tool` cannot be combined with `file`/`glob`, and the plugin's own tools are refused.

**Read the result**: `results[]` (`id`, `type`, `value`, `probabilities?`, `confidence?`) · `coverage` (`requested`/`answered`/`batches`/`truncated`/`truncatedBy`/`failed`/`aborted`) · `cost` (`model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts`) · `notes` (first line = model-selection decision).

`noul` returns a **boolean** `value`; its P(true) is in `probabilities.true` (0.475 = 47.5% yes). `score` is on the 0..N-1 scale; `choice` returns the chosen label. `confidence` is concentration, **not accuracy** — when `notes` flags low-confidence items, read `probabilities` instead of the label.

## `monitor`: wait for an event

Samples one source on an interval, asks the same rubric each time, and counts hits. `once` returns when `countThreshold` is reached (or the deadline expires); `continuous` runs to the deadline and returns the accumulated `count`. It **never** kills, retries, or cancels anything.

| Source | Keys | Reads |
|---|---|---|
| `job` | `id?`, `select?` (`newest`/`oldest`), `jobKind?` | A background job's output (default: newest of this session) |
| `file` | `path`, `startLine?`, `endLine?` | Workspace-relative file |
| `glob` | `pattern`, `limit?` | Matched files, concatenated |
| `command` | `argv` | Re-runs a host command through the plugin's upstream pipe |
| `events` | `types`, `limit?` | Job-event ring buffer (falls back to the session's current job list) |

Parameters: `description` (required; job description; label = source.kind + description) · `source` (required) · `rubric` (required) · `type` (`noul` only) · `criteria` (`noul` optional false/true descriptions) · `hitThreshold` (0.5) · `tailBytes` (4096, max 65536) · `mode` (`once`|`continuous`) · `countMode` (`cumulative`|`consecutive`, default cumulative) · `notifyEvery` (continuous, default 1) · `intervalMs` (5000) · `timeoutMs` (120000) · `countThreshold` (1; once only) · `background` · `notify` · `coalesce` · `maxNotificationsPerMinute` (6).

- **Empty samples**: `file`/`glob` with empty content return immediately (`samples: 1`, `emptySource: true`, no model call); `job`/`events`/`command` empty samples count as P=0 and keep waiting for the event.
- **Details**: the host `finished [...]` shows `hit/P|EP/dur` (once) or `trigger_num/EP/dur` (continuous); the job label is `source.kind + description`. For once, `EP = Σ(hit P)/countThreshold` (missing hits count as 0) and a failed once shows `1-EP`; for continuous, EP is the mean of per-trigger P (a trigger P = Σ(window hit P)/notifyEvery; 0 triggers ⇒ 0). Durations are ms. A boolean-only verdict (`{hit:true}` without P) counts as 0.00, so detail/notice/stream never show `-` for a hit. `description` is folded to one line before it becomes the job label. Permanent source errors (invalid descriptor, outside root, explicit job id missing, file too large) fail fast; transient read errors are retried.
- **Background**: `background: true` returns a `jobId`; `job_output` streams progress lines (config/hit/trigger/summary) and is consumed on read. `notify: "inbox"` posts a one-line notice **only at a trigger** (once: threshold; continuous: every `notifyEvery` hits) and **requires** background. Job status: abort ⇒ `killed`; all probes errored (no valid verdict) ⇒ `failed`; timeout / valid verdict ⇒ `completed`. Abort interrupts an in-flight `decide` and `sleep`, so `killed` is prompt.
- **`command` argv**: `argv[0]` picks the interpreter (`pwsh`, `git_bash`/`bash`/`sh`/`zsh`); interpreter flags are stripped; **quote arguments containing spaces yourself**.
- **`events.types`** is validated against a fixed vocabulary (`job.registered`, `job.stopping`, `job.output`, `job.progress`, `job.settled`, `job.completed`, `job.failed`, `job.killed`, `job.removed`, `job.running`, `job.unknown`); a typo fails as `source_invalid`.

## Configuration

The plugin is four rows: a core row, a decision row, a monitor row and a skill row. Each row has its own switch in the Plugins page; the core/decision/monitor rows also have their own Configure page. GUI-editable fields are declared .volatile() and apply to the next call without reloading the row. toolName / monitorToolName / ladder / spillDirCap are registration-time or advanced YAML fields: edit them in cordis.patch.yml and reload that row.

### Core row — decision-tools-plugin (shared model & runtime)

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | http://localhost:11434 | Ollama endpoint; path prefixes are preserved; GUI-editable. |
| `defaultModel` | tev1:0.8b | Model used when a tool row has no modelOverride; GUI-editable. |
| `timeoutMs` | 120000 | Per-request budget, including cold model load; GUI-editable. |
| `keepAlive` | unset | Passed as keep_alive; unset uses the server default; GUI-editable. |
| `apiKey` | unset | Optional Bearer token for remote / System One-compatible endpoints; GUI-editable. |
| `modelsPath` | /api/tags | Model discovery path; use `/v1/models` for OpenAI-compatible endpoints; GUI-editable. |
| `systemOnePath` | v1/systemone | Judgement endpoint path relative to baseUrl; GUI-editable. |
| `modelOrder` | unset | Comma-separated model priority; `model@numCtx` sets context; unknown models use 8192; GUI-editable. |
| `escalationEnabled` | true | Allow automatic escalation on context overflow; GUI-editable. |
| `ladder` | unset (DEFAULT_LADDER) | Ordered {model,numCtx}[]; YAML only; reload the core row after editing. |
| `toolName` | decision | Model-visible decision tool name; reload the decision row after editing. |
| `monitorToolName` | monitor | Model-visible monitor tool name; reload the monitor row and the decision row after editing (both snapshot the name). |
| `spillDirCap` | unset (16 MiB) | Byte cap for the plugin's spill directory; YAML only. |

### decision row — decision-tools-decision

| Key | Default | Meaning |
|---|---|---|
| `modelOverride` | unset (core default) | Blank uses the core defaultModel; GUI-editable. |
| `defaultDepth` | normal | quick / normal / deep; used when the call omits depth; GUI-editable. |
| `bodyWarning` | true | false suppresses size/text-shape notes; GUI-editable. |
| `softBodyBytes` | unset (4096) | Body size above which notes[] carries a size note; 0 warns every call; GUI-editable. |
| `minConfidence` | unset (0.25) | choice/score confidence below this (or missing) is named in notes[]; 0 disables; GUI-editable. |
| `maxChoiceOptions` | unset (255) | Upper bound on choice options; GUI-editable. |
| `escalationMaxAttempts` | 3 | Extra escalation attempts after the first call; `deep` adds 2; blank = 3; GUI-editable. |
| `scanFirstChunkBytes` | unset (4096) | First scan chunk byte budget; GUI-editable. |
| `scanMaxChunks` | unset (32) | Maximum chunks per scan; GUI-editable. |
| `scanMaxTotalBytes` | unset (4 MiB) | Cumulative byte cap per scan; GUI-editable. |
| `scanDeadlineMs` | unset (180000) | Wall-clock budget per scan; GUI-editable. |
| `scanAggregate` | none | none / any; any adds a provisional cross-chunk max probability; GUI-editable. |

### monitor row — decision-tools-monitor

| Key | Default | Meaning |
|---|---|---|
| `modelOverride` | unset (core default) | Blank uses the core defaultModel; GUI-editable. |
| `minProbeIntervalMs` | unset (1000) | Lower bound for the monitor probe interval; GUI-editable. |
| `notifyCoalesceWindowMs` | unset (5000) | Same-kind notice coalescing window; 0 disables coalescing; GUI-editable. |
| `maxNotificationsPerMinute` | unset (6) | Per-minute notice cap; GUI-editable. |

Override an existing row with a bare id and no insert; fields go under config. config is replaced wholesale, never deep-merged, so restate every field the row needs.

    - id: decision-tools-plugin
      config:
        baseUrl: 'http://localhost:11434'
        defaultModel: 'tev1:0.8b'
        timeoutMs: 180000
        keepAlive: '30m'
    - id: decision-tools-decision
      config:
        modelOverride: 'tev1:0.8b'
        defaultDepth: normal
    - id: decision-tools-monitor
      config:
        modelOverride: 'nimble:latest'

The three Config schemas live in lib/configs.js.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `context_overflow` | Material + questions exceed the model's window | Use `depth: "deep"` (chunking), smaller material, or fewer questions |
| Tool not listed | Plugin not enabled in the profile | Link it into the profile and reload |
| `ERR_MODULE_NOT_FOUND` after a DSH upgrade | Workspace `node_modules` still points at the old install | Run `scripts/rebuild-node-modules.mjs` inside DSH, then re-run the tests |
| `monitor` gives `hit:false` with `errors: 0` | Source was empty, or `types` matched nothing | Check `emptySource`; `notes` states the reason |
| `monitor` gives `errors: N > 0` | Reads or judgements failed | Inspect the error text; failed probes are also rendered |
| `source.kind=events` fails | Event source unavailable in this composition | Falls back to the session's current job list when possible |
| `invalid_request` / `mode_invalid` | Malformed arguments | The message lists legal values; `mode_invalid` = mode/count/shape, `invalid_request` = a field |

## Limits and safety

- These are **probabilities, not proof**. Never treat one as correctness evidence, and never let it be the sole basis for a pass/allow decision — that needs artifact-level evidence.
- The tool must **not** decide routing, and must **not** be the basis of any **fail-open or fail-closed** policy; those belong to deterministic rules.
- `tev1` returns only probabilities and no text — use a generative model when you need a human-readable rationale.
- Raw tool output is spilled to a plugin-owned temp directory (16 MiB cap, `spillDirCap`); the path is returned in the result.
- Judgements are local; the plugin makes no cloud calls of its own.

## Development

```
node --test test/*.test.mjs     # full suite
node --check lib/*.js          # syntax gate
```

After editing `lib/`, reload the plugin in DSH before drawing conclusions from real calls: the host runs the last loaded snapshot.

## Licence

MIT — see [LICENSE](./LICENSE).

## No compatibility layer

This is a one-time structural upgrade, not a version transition. Old row ids (`decision-tools-tool`) and old config keys (`decisionEnabled` / `monitorEnabled`) are not accepted; use the four rows and three Config tables above. See [docs/architecture-current.md](./docs/architecture-current.md) for the as-is contract and [docs/use-cases.md](./docs/use-cases.md) for worked examples.

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
  "rubric": "Did the test suite pass?" }

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
| `items` | batch | 1–64 self-contained short objects |
| `questions` | mixed | 1–64 `{name, type, instructions, criteria?}` |
| `type` | batch | `choice` / `noul` / `score` (mixed: per question) |
| `criteria` | choice/score | Labels once: top-level in batch, per question in mixed |
| `depth` | no | `quick` (no escalation/batching), `normal` (default), `deep` (may chunk) |
| `model` | no | Pin a model; disables capacity choice and escalation |

**Material forms**: inline text · `{ file: { path, startLine?, endLine? } }` · `{ glob: { pattern, limit? } }` · `{ tool: { name, arguments? } }`. A tool's raw output never enters your context; the full text is spilled and returned as `material.spillPath`. `tool` cannot be combined with `file`/`glob`, and the plugin's own tools are refused.

**Read the result**: `results[]` (`id`, `type`, `value`, `probabilities?`, `confidence?`) · `coverage` (`requested`/`answered`/`batches`/`truncated`/`truncatedBy`/`failed`/`aborted`) · `cost` (`model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts`) · `notes` (first line = model-selection decision).

`noul` returns a **number** (0.475 = 47.5% yes); `score` is on the 0..N-1 scale; `choice` returns the chosen label. `confidence` is concentration, **not accuracy** — when `notes` flags low-confidence items, read `probabilities` instead of the label.

## `monitor`: wait for an event

Samples one source on an interval, asks the same rubric each time, counts hits, and returns when `countThreshold` is reached (or the deadline expires). It **never** kills, retries, or cancels anything.

| Source | Keys | Reads |
|---|---|---|
| `job` | `id?`, `select?` (`newest`/`oldest`), `jobKind?` | A background job's output (default: newest of this session) |
| `file` | `path`, `startLine?`, `endLine?` | Workspace-relative file |
| `glob` | `pattern`, `limit?` | Matched files, concatenated |
| `command` | `argv` | Re-runs a host command through the plugin's upstream pipe |
| `events` | `types`, `limit?` | Job-event ring buffer (falls back to the session's current job list) |

Parameters: `rubric` (required) · `source` (required) · `type` (`noul` only) · `hitThreshold` (0.5) · `tailBytes` (4096, max 65536) · `mode` (`once`|`continuous`) · `intervalMs` (5000) · `timeoutMs` (120000) · `countThreshold` (1) · `background` · `notify` · `coalesce` · `maxNotificationsPerMinute` (6).

- **An empty source returns immediately**: `samples: 1`, `emptySource: true`, `hit: false` — no model call, no waiting.
- **Background**: `background: true` returns a `jobId` at once; read it with `job_output` (output is consumed on read). `notify: "inbox"` posts a notice on a hit and **requires** background.
- **`command` argv**: `argv[0]` picks the interpreter (`pwsh`, `git_bash`/`bash`/`sh`/`zsh`); interpreter flags are stripped; **quote arguments containing spaces yourself**.
- **`events.types`** is validated against a fixed vocabulary (`job.registered`, `job.stopping`, `job.output`, `job.progress`, `job.settled`, `job.completed`, `job.failed`, `job.killed`, `job.removed`, `job.running`, `job.unknown`); a typo fails as `source_invalid`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama endpoint; a path prefix is preserved (`http://host/ollama` → `http://host/ollama/v1/systemone`) |
| `defaultModel` | `tev1:0.8b` | model when a call omits `model` |
| `timeoutMs` | `120000` | per-request budget, including cold model load |
| `toolName` | `decision` | the name the model sees |
| `keepAlive` | unset | passed through as `keep_alive`; unset uses the server default |
| `softBodyBytes` | unset (falls back to `LIMITS.softBodyBytes`, 4096) | body size in bytes above which the result carries a size note in `notes[]` |
| `bodyWarning` | unset (on) | `false` never emits the size note; unset or `true` keeps it on |
| `minConfidence` | unset (falls back to `LIMITS.minConfidence`, 0.25) | `choice`/`score` entries whose `confidence` is below this — or missing — are named in a `notes[]` line; `0` disables the gate |
| `maxChoiceOptions` | unset (falls back to `LIMITS.maxChoiceOptions`, 255) | Upper bound on `choice` option count. The OpenAPI spec notes *"The option limit depends on the model"*, so raise or lower this if your model differs. `score` is a separate, spec-fixed 2–10 and is **not** configurable. |
| `escalationEnabled` | `true` | Automatic escalation to a bigger-context decision model on context overflow. Passing `model` on a call disables it for that call. |
| `ladder` | unset (uses `DEFAULT_LADDER`) | Ordered `{ model, numCtx }[]` escalation candidates. Two deliberate exclusions: `clef:latest` (27B on 8 GB never returned within 300 s) and `nimble:latest` (its `num_ctx` 8194 is only 2 tokens above tev1's 8192, so it can never satisfy the capacity margin — a rung that is never selectable). Re-read `/api/show` after re-pulling; these are snapshots. |
| `escalationMaxAttempts` | `3` | Maximum escalation attempts before failing with an actionable error instead of silently degrading. |
| `scanFirstChunkBytes` | unset (uses `LIMITS.softBodyBytes`) | Byte budget for the first scan chunk; later chunks are re-cut from the server's own token numbers. |
| `scanMaxChunks` | unset (uses `LIMITS.scanMaxChunks`) | Maximum chunks per scan; exceeding it returns a partial scan rather than failing. |
| `scanMaxTotalBytes` | unset (uses `LIMITS.scanMaxTotalBytes`) | Cumulative byte cap per scan. |
| `scanDeadlineMs` | unset (uses `LIMITS.scanDeadlineMs`) | Wall-clock budget per scan, independent of `timeoutMs`. |
| `scanAggregate` | `none` | `any` adds a provisional max probability per `noul` question. Cross-chunk probabilities are not calibrated — never treat it as a decision. |
| `minProbeIntervalMs` | unset (uses `MONITOR_LIMITS.minProbeIntervalMs`, 1000) | Lower bound for the `monitor` tool's probe interval: the model's `intervalMs` is raised to at least this. |
| `notifyCoalesceWindowMs` | unset (uses `MONITOR_LIMITS.defaultNotifyCoalesceWindowMs`, 5000) | Window in which same-kind `monitor` notifications are coalesced — the inbox has no backpressure of its own. |
| `maxNotificationsPerMinute` | unset (uses `MONITOR_LIMITS.defaultMaxNotificationsPerMinute`, 6) | Per-minute cap on `monitor` notifications. |
| `spillDirCap` | unset (uses `DEFAULT_SPILL_MAX_BYTES`, 16 MiB) | Total byte cap for the pipe's own spill directory under the system temp area. |
| `monitorToolName` | `monitor` | Model-visible name of the second tool (`monitor`). Set it if that name collides with another tool in your composition. |

`softBodyBytes` is silently clamped to `LIMITS.maxBodyBytes` (65536) — a threshold above
that byte cap could never fire — and a threshold set above the model's **real** capacity
(its `num_ctx`) silently makes the note useless; nothing inside the plugin can detect
that, so the server's token check stays the authoritative guard. Since this release the
**model-selection** thresholds are computed per call from the chosen window, the 0.6
margin and the material's language density (Chinese 2.32, English 3.33 bytes/token — see
`lib/density.js`); this constant is only the fallback used when no window is known.

`minConfidence` only ever **adds a flag**: every answer is returned unchanged, and the
plugin never drops, rewrites or rejects one for being uncertain. `0` disables the gate
(note the opposite reading of `softBodyBytes: 0`, which warns on every call), and values
above `1` clamp to `1`. The 0.25 default was calibrated on one small local sample
(`tev1:0.8b`, 4 questions × 6 candidate orderings); confidence scales differ by roughly an
order of magnitude between models (measured 0.04–0.62 for `tev1:0.8b` against 0.77–0.99 for
every 4B-and-above model on the same questions), so **re-calibrate per model** — and note
that on those larger models the gate is **inert**: their confidence never falls below 0.25.
It is not a safety guarantee: the single order-induced flip seen in cross-session research
landed at `confidence = 0.357`, above this threshold, and `confidence` is a concentration
measure, not calibrated accuracy. Related: the order effect itself turned out to be an
**0.8B-only phenomenon** — across 6 candidate orderings, `tev1:latest` (4B), `clef-flash`
(9.1B), `nimble` (9B) and `clef` (27B) returned identical labels on all 4 questions.

Override in `cordis.patch.yml` by nesting the fields under the row's `config:` key. To
**override the existing row**, use a bare `id` and **no `insert`**. Fields written
**flat on the row** are silently ignored, and no warning is printed — the plugin just
runs on its defaults.

    - id: decision-tools-tool
      config:
        baseUrl: 'http://localhost:11434'
        defaultModel: 'tev1:0.8b'
        timeoutMs: 180000
        toolName: 'decision'
        keepAlive: '30m'

`config` is replaced wholesale, never deep-merged, so an override must restate every
field the row needs — the whole block above is the shape to copy, and the row's own
keys are only `id`, `name`, `config`, `disabled`, `inject`, `intercept` and `isolate`.
`insert:` is for adding a new row (this bundle's own patch does that); overriding an
existing row uses a bare `id` with no `insert`.
The defaults above are the ones declared in `lib/tool.js` (`Config`).

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

## Migrating from the earlier API

The v2 top-level keys (`state`, `answers`, `usage`, `strategy`, `aggregate`, …) are gone; `material` plus one mode replaces them. See [docs/architecture-current.md](./docs/architecture-current.md) for the as-is contract and [docs/use-cases.md](./docs/use-cases.md) for worked examples.

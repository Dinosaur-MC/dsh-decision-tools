# dsh-decision-tools

A DSH agent tool that puts a local [Ollama System One](https://docs.ollama.com/capabilities/decision)
model behind one tool call: classify, answer yes/no, and score against a rubric —
all in a single request that shares one piece of state.

## Why

Routing, filtering, relevance judgement and scoring are bounded decisions whose
useful answer is a probability, not prose. Sending them to a generative model is
slow and expensive. A System One decision model answers in one forward pass.

## Requirements

- Ollama >= 0.35.0 running locally
- At least one decision model: `ollama pull tev1:0.8b` (recommended default)
- DSH with `@deepseek-ai/dsh-tools` >= 0.2.0-rc.2

## Install

    plugin_manager(action="install_bundle", target="<absolute path to this package>")

Then confirm the tool is visible with
`cordis_inspect_query(platform="host", provider="Tool", method="listTools")`.

## Tools

This bundle registers **two** model-visible tools:

| Tool | What it is |
|---|---|
| `decision` | One shared `material` + one shared `rubric`, judged in a single request: 1–64 items (batch) or a handful of distinct questions (mixed). Answers are probabilities, not prose. |
| `monitor` | A **probing wait primitive**: sample a `source` on an interval, ask the same decision model "has the event happened yet" against your `rubric`, count the probes that count as hits, and return once the count reaches `countThreshold` (or the deadline expires). It never kills, retries or dispatches anything — see [Monitor](#monitor). |

## Usage

One call, one `material`, and **one of two mutually exclusive modes** (giving both, or neither, is an error).

`material` has **four forms**; the last three are references that never enter your context:

| Form | Use when |
|---|---|
| a plain string | the text is small and already in your context |
| `{ file: { path, startLine?, endLine? } }` | the material is a workspace file (1-based inclusive range). A single file over the cap is an **error**, never truncated |
| `{ glob: { pattern, limit? } }` | a set of files. Total over the cap is **truncated**, reported in `coverage.truncated` / `coverage.truncatedBy` — a truncated material must never be used as if it were complete |
| `{ tool: { name, arguments? } }` | run **another** tool and judge its **raw output** without pulling it into your context. The plugin delegates it in-process (**always** with `agent` and `parent`), spills the raw output to a file **unconditionally**, and returns `material.spillPath` / `bytes` / `fullBytes` / `truncated` (plus `exitCode` for process-style tools). Delegating to this plugin's own tools (`decision`, `monitor`) is rejected — the host has no recursion guard of its own |

**Batch** — one shared rubric judging N items independently; the rubric is written **once**:

```json
{
  "material": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
  "rubric": "Is this ticket a payment failure that needs a refund?",
  "type": "noul",
  "items": ["ticket 12", "ticket 13", "ticket 14"]
}
```

**Mixed** — several distinct questions about the same material; here each question carries its own `criteria`:

```json
{
  "material": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
  "questions": [
    { "name": "label", "type": "choice",
      "instructions": "Which label fits this ticket?",
      "criteria": { "billing": "Payments and refunds", "bug": "Software errors",
                    "account": "Login and account access" } },
    { "name": "refund", "type": "noul",
      "instructions": "Is the customer requesting a refund?" },
    { "name": "urgency", "type": "score",
      "instructions": "How urgently does this ticket need a response?",
      "criteria": ["Routine: no time pressure",
                   "Soon: a customer is inconvenienced",
                   "Immediate: a critical service is unavailable"] }
  ]
}
```

`rubric` is written once and the wire layer repeats it for the model, so you never repeat it per item. A
`choice`/`score` label set is written once too: in batch mode in the **top-level** `criteria`, in mixed mode in
each question. `noul` takes no `criteria` at all, and a top-level `criteria` in mixed mode is an error.

The mixed request above renders as one line per result, then `coverage`, `material`, `cost` and `notes`:

    label    choice  bug  p={bug=0.9648, account=0.0293, billing=0.0059}  conf=0.847
    refund   noul    P(true)=0.5045
    urgency  score   Soon  p={1=0.7369, 2=0.1933, 0=0.0698}  conf=0.337
    覆盖: requested=3 answered=3 batches=1 truncated=false failed=0 aborted=false
    cost: model=tev1:0.8b input_tokens=796 body=682B wall=97ms escalated=false attempts=1
    模型选择：tev1:0.8b（fits-default）。

The **shape** of those lines is fixed by the renderer (`lib/render.js`); `noul` deliberately prints only
`P(true)` — the boolean in `results[].value` is a thresholded product, and printing it would invite reading a
probability as a decision. The distributions and labels above are the ones measured earlier on `tev1:0.8b`
for this ticket; the `coverage` / `cost` numbers are representative — the wire shape changed in this release,
so re-measure bytes and `input_tokens` on your own machine.

## Question types

| Type | Criteria | `results[]` entry |
|---|---|---|
| `choice` | 2–255 named options with descriptions (`criteria` object) | `value` = the most likely option; `probabilities` = option → probability; `confidence` |
| `noul` | optional `{"false": ..., "true": ...}` descriptions; **no `criteria`** (batch mode rejects one) | `value` = boolean (`P(true) >= 0.5`); `probabilities` = `{ true, false }`; no `confidence` (the server returns none) |
| `score` | 2–10 descriptions ordered lowest → highest (`criteria` array) | `value` = the chosen level label; `probabilities` = level index (0..N-1) → probability; `confidence` |

`score`'s probability-weighted mean is not returned as a number, but you can recompute it as `Σ index × p`
over `probabilities`. `confidence` is distribution concentration, `1 - H(p)/ln N`. It is **not** calibrated
accuracy. Entries whose `confidence` is below `minConfidence` (or missing) are named in a `notes[]` line —
a flag, not a filter: nothing is dropped, rewritten or rejected.

When rendered, `noul` prints `P(true)` only, while `choice` / `score` print the label plus the probabilities in
descending order.

## Monitor

`monitor` is a **probing wait primitive, not a scheduler**. You give it a `source` and one `rubric` ("what counts as the event having happened"); it samples on an interval, asks the decision model each time, and counts every probe that answers a hit.

```json
{
  "source": { "kind": "file", "path": "build.log" },
  "rubric": "Does the log already contain the line BUILD SUCCEEDED?",
  "intervalMs": 5000,
  "timeoutMs": 120000
}
```

- **Counting is level-based**: every probe that answers a hit increments the counter. **There is no debounce and no cooldown window** — `countThreshold: 3` means roughly "hit on three probes" (order of `3 × intervalMs`). `minGapMs`, `countMode`, `persistCount` and `resetCount` do not exist and are **rejected explicitly** rather than silently ignored.
- **Timestamps are recorded only** (`at`, `atIso`, `firstAt`, `lastAt`) — they never take part in the hit decision.
- `intervalMs` is raised to the deployment floor (`Config.minProbeIntervalMs`); `timeoutMs` is a **self-managed** deadline (the host does not preempt a blocking call), raised to at least `intervalMs`. Both clamps are written into `notes`.
- `background: true` registers a host job and returns a `jobId` immediately (read it later with `job_output`). `notify: "inbox"` sends a notice when the threshold is reached (**`background: true` only** — a foreground call with `notify: "inbox"` is rejected), with coalescing + a per-minute cap + a wake budget — the inbox has no backpressure of its own.
- `source.kind` is one of `job` / `file` / `glob` / `command` / `events`. `file` and `glob` go through the **same reader as `decision`** (workspace-relative, same containment gate).
- `command` re-runs a host command through the plugin's own upstream pipe (the same one behind `decision`'s `material.tool`): `argv[0]` picks the interpreter (`pwsh`/`powershell`, `git_bash`/`bash`/`sh`/`zsh`), the rest are **joined by spaces**, and the interpreter's own leading flags (`-c`/`-lc`/`-Command`/`-NoProfile`…) are stripped — **quote any argument that contains spaces yourself** (`['bash','-lc','echo "a b"']`).
- An **empty source** returns immediately: `samples: 1`, `emptySource: true`, `hit: false` — no model call, no waiting for the deadline.
- `events` reads the plugin's job-event ring buffer (`job.registered` / `job.settled` / `job.completed` / `job.failed` / `job.killed` / …); with no buffer available it falls back to the session's **current** job list (`types: ['job.failed']` then means “some job is failed right now”). `types` is validated against a fixed vocabulary; a typo fails as `source_invalid`.
- **On a hit the plugin NOTIFIES only.** It never kills, retries, dispatches or cancels anything — that stays your call. The counter lives in memory only: it starts at 0 on every call and is lost when the host restarts.
- **Not for** goals that need multi-turn reasoning or candidates discovered while thinking — it only answers a bounded question you can already state.

A foreground call returns `hit` / `count` / `countThreshold`, the timestamps, a bounded tail of the hitting sample (`evidence`, cap 1024 B), and `cost` / `coverage` / `notes`.

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

## Known limitations

1. **The `clef` defect is gone as of 2026-10-12.** It used to fail on every request with
   `Clef: non-finite logit` under Ollama 0.35.1; re-tested on **0.40.3** (and with the model
   files re-pulled), `clef-flash:latest`, `clef:latest` and `nimble:latest` all return 200 for
   all three question types, and the two `clef` models now advertise `vision`. The fix cannot be
   attributed to a single cause (Ollama version *and* model files both changed).
   ⚠️ **State changed again on 2026-10-15**: under Ollama **0.40.4** old-format models are
   rejected (`was downloaded in a format that is no longer supported`). After re-pulling
   `nimble:latest`, `clef-flash:latest` and `clef:latest` in turn (16:08–18:0x that day),
   **all six decision models are available again**. ⇒ Availability flips with re-pulls;
   any "works / doesn't work" claim must be re-measured. **Image input is not exposed by this
   extension**: there is no `images` parameter and no path-based image loading — the upstream
   `/v1/systemone` endpoint does accept `images` (base64 PNG/JPEG/WebP, shared by every question in
   that request; local body cap 32 MiB including base64) and the `clef` / `clef-flash` models can
   judge them, so this is a gap in this plugin, not an upstream limit — see ADR-3. The `model_broken`
   mapping is kept as a guard against an upstream regression.
2. **Bigger is not necessarily more correct.** On the same ticket, `tev1:0.8b`
   answered `bug` (p=0.9648) while `tev1:latest` (4.2B) answered `billing`
   (p=0.5710, `bug` only 0.3212) — and `billing` is the weaker answer given the
   text. Verify per task.
3. First call includes model load (measured on this machine: 14.3 s cold and
   11.1 s warm for `tev1:0.8b`; 15.7 s cold and 8.0 s warm for `tev1:latest`).
4. No streaming, no tool calling, one request one response.
5. Server limits: 64 KiB request without images, 64 questions, **2–255 `choice` options**
   (the OpenAPI spec notes the option limit is model-dependent) and **2–10 `score` levels** —
   two independent limits, not one. The binding limit is usually smaller: the effective
   context is the model's own `num_ctx`, not the architecture's context length. On this machine
   `ollama show tev1:0.8b` reports `context length 262144` but `num_ctx = 8192` (re-pulled
   2026-10-15; it was 2050 before), and measured on real English technical prose that ceiling
   is roughly `num_ctx / 3.33` bytes of body (~3.33 bytes/token), so an over-sized body returns
   HTTP 400 `prompt 0 has <N> tokens; expected 1–<M> (input is never truncated)`, mapped to
   `context_overflow` — the input is **not** truncated and no partial answer is returned.
   The plugin's **default** advisory size threshold is a fixed byte count
   (`LIMITS.softBodyBytes = 4096` B), deliberately independent of any model's `num_ctx`: it can
   warn **before** the server rejects, and crossing it only adds a note to `notes[]` and changes no
   rejection behaviour — model *selection*, by contrast, now computes its own per-call threshold
   from the window, the 0.6 margin and the material's language density. The authoritative guard
   stays the server's token check. Byte count is a crude proxy, though: dense scripts (CJK) and
   ID-heavy text tokenize worse than 3.33 B/token and this threshold under-protects on such input.
6. **Bounded decisions only.** This plugin answers bounded questions whose candidate set is known up front. Open-ended generation, reasoning chains, and candidates that must be discovered while thinking still belong to a generative model.
7. **The confidence gate is a flag, not a guarantee.** Answers below the configured `minConfidence` — or with a missing `confidence` — are named in a `notes[]` line; nothing is dropped, rewritten or rejected. The 0.25 default was calibrated on one small local sample (`tev1:0.8b`, 4 questions × 6 candidate orderings) and confidence scales differ by roughly an order of magnitude between models, so **re-calibrate per model**. A cross-session probe recorded an order-induced label flip at `confidence = 0.357`, above this threshold, and `confidence` measures concentration rather than accuracy — a question absent from the warning is **not** thereby endorsed.

## Development

    npm run link-peers     # symlink the host's peer packages (no network)
    npm test               # node --test "test/*.test.mjs"
    node smoke/live.mjs    # optional: hit the real local Ollama

`node --test test/` does **not** work on Node 22 — the directory form is treated as
a module path. Use the quoted glob.

`smoke/live.mjs` needs a live Ollama and is not part of CI. It is a development
fixture and is deliberately excluded from the published package.

## Licence

MIT. See LICENSE and THIRD_PARTY_NOTICES.

## Migrating from the earlier API (breaking)

This release replaces the tool surface. There is **no compatibility layer** — the old keys below are no
longer accepted as arguments or returned in a result. What to change:

| Old | New | Action needed |
|---|---|---|
| `state` | `material` (a plain string is still a valid form) | rename |
| `stateSource` | `material: { file: … }` / `{ glob: … }` | rename + reshape |
| `strategy` | `depth: 'quick' \| 'normal' \| 'deep'` | rename + pick a level |
| `aggregate` | removed (its semantics moved into `depth` and automatic batching) | delete it |
| the shared rubric repeated in every `questions[].instructions` | `rubric` (written once) + `items` + `type` | use the batch mode |
| the option set repeated per question | top-level `criteria` (batch mode); per-question only in mixed mode | move it once, to the top level |
| `questions[].instructions` | meaning unchanged, but in batch mode it is no longer where the shared criterion lives | depends on the mode |
| `answers[name]` | `results[]` — `{ id, type, value, probabilities?, confidence? }` | read differently |
| `chunks` | removed (every result lives in `results`, one entry per item) | read differently |
| `usage` / `state_bytes` / `body_bytes` | `cost` (`inputTokens` / `bodyBytes`) | read `cost` |
| `body_warning` / `confidence_warning` | `notes[]` (strings, printed verbatim) | read `notes` |
| `source` | `material` (`{ source, bytes, descriptor? }`) | read `material` |
| `plan` | `notes[]` (its first line states the model and the selection reason) | read `notes` |
| `escalated: { from, to, sticky }` | `cost.escalated` (boolean) + `cost.attempts[]` | read `cost` |
| `scan` (`failed` / `truncated` / `aborted` / `remaining`) | `coverage` (`requested` / `answered` / `batches` / `truncated` / `truncatedBy` / `failed` / `aborted`) | read `coverage` |

Also:

- `items` and `questions` are **mutually exclusive**: giving both (`mode_conflict`) or neither
  (`mode_missing`) is an error.
- Scanning is no longer a parameter: it is an internal behaviour available only with `depth: 'deep'`.
  `coverage` reports truthfully whether it ran, and a per-chunk maximum is a **locator, not a
  document-level probability**.
- Unchanged: the `model` escape hatch, escalation-sticky behaviour, the materials-never-enter-your-context
  rule and the workspace guard, and every `Config` key in the table above.
- The package also ships a **skill**: enabling the `dsh-decision-tools/skill` row puts `decision-usage` in
  the session skill catalog (the shipped `cordis.patch.yml` enables both rows).

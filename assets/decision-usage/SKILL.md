---
name: decision-usage
description: Use for probability judgements on local material — `decision` (routing, classify/filter/rank, relevance, yes-no, 1–N scoring; inline/file/glob/tool input) and `monitor` (wait for a background job, file, command output or job event; polling, not a scheduler). Both return probabilities, not prose.
---

# Using the local decision model (`decision`) and `monitor`

A **local** System One model returns probabilities for a bounded question — routing, classification, filtering, relevance scoring. The plugin registers two tools: `decision` (one-shot judgement) and `monitor` (repeated probing until an event happens).

## 1. `decision`: one call, one mode

Give `material` plus exactly one mode; **giving both is an error**:

- `rubric` + `items` + `type` — one shared rubric judges N items independently. Write the rubric **once**.
- `questions` — M different questions on the same material: `{ name, type, instructions, criteria? }`.

Ask up to 64 items/questions in ONE call. **NEVER loop one call per item** — every call re-sends all `material` (cost ≈ count × body). `type` is `choice`, `noul` or `score`. `noul` returns a NUMBER, not a boolean: 0.475 means a 47.5% chance of yes. `score` is reported on the 0..N-1 level scale, not normalised to 0-1. For `choice`/`score` write the label set **once**: top-level `criteria` in batch mode, per-question in mixed mode. `noul` takes only optional `{ false, true }` string descriptions.

Each `item` is the complete short object to judge; the plugin never infers what it refers to in `material`.

Other parameters: `depth`, `model` (see §3). Invalid calls fail with a stable `kind` (`mode_invalid` for mode/count/shape problems, `invalid_request` for field-level ones, `material_*`/`source_*`/`upstream_*` for the rest) — read the message, it lists the legal values.

## 2. `material`: inline, file, glob, or tool

- a string (inline material);
- `{ file: { path, startLine?, endLine? } }` — `path` is workspace-root-relative (absolute, `..`, escaping symlinks refused); ranges are 1-based inclusive;
- `{ glob: { pattern, limit? } }`;
- `{ tool: { name, arguments? } }` — judge a host tool's **raw output**: it never enters your context, full text at `material.spillPath`; not with `file`/`glob` (`material_conflict`); the plugin's own tools are refused (`upstream_self_recursion`).

A file over the cap **fails**; a glob over the total cap is **truncated** (never complete). `material` reports the source, byte counts and `truncated`; `coverage.truncated`/`truncatedBy` mirror it.

## 3. `depth`: how much work the plugin may do

- `quick` — default model only; over budget it **fails**. `normal` (default) — smallest fitting model, escalates on overflow. Batching never changes `results[]`: one entry per item. `deep` — starts bigger, may chunk the material.

An explicit `model` disables capacity choice and escalation. Escalation switches to a bigger-context model and stays there (`cost.escalated`) — a different base model, so thresholds calibrated for one may not carry over. Any Ollama model that answers the plugin's System One endpoint works: `model` pins one for a call, `defaultModel` changes the session default, `ladder` (`[{ model, numCtx }]`) controls escalation, and `node scripts/list-models.mjs` lists installed models with a paste-ready ladder.

## 4. Read `results`, `coverage`, `cost`, `notes`

- `results[]` — `{ id, type, value, probabilities?, confidence? }`, one entry per item/question in order; `value` = chosen label (`choice`/`score`) or boolean (`noul`).
- `coverage` — `requested`/`answered`/`batches`/`truncated`/`truncatedBy?`/`failed`/`aborted`: partial results are data, not failure.
- `cost` — `model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts[]`. `notes[]` — the plugin's observations verbatim (size, batching, low-confidence names).

`confidence` is the concentration of the distribution (1 - H/ln N); it is NOT accuracy. A `notes[]` line that names low-confidence items is a FLAG, not a filter: an item not named is NOT thereby endorsed; every answer is unchanged, and when it fires read `probabilities` instead of the chosen label and escalate that question to your own reasoning.

In `deep` the material may be chunked: a per-chunk maximum is a locator, not a document-level probability.

## 5. `monitor`: wait for an event

`monitor` samples one source on an interval, asks the same `rubric` each time, counts hits, and returns when `countThreshold` is reached (or the deadline expires). It is a probing primitive — it **never kills, retries, dispatches or cancels** anything.

Parameters: `source` (required) · `rubric` (required) · `type` (`noul` only) · `hitThreshold` (default 0.5) · `tailBytes` (default 4096, max 65536) · `mode` (`once` ⇔ returns at threshold; `continuous` ⇔ runs to the deadline) · `intervalMs` (default 5000, raised to the deployment floor) · `timeoutMs` (default 120000, self-managed deadline) · `countThreshold` (default 1; `hit = count ≥ threshold`) · `background` · `notify` · `coalesce` · `maxNotificationsPerMinute` (default 6).

`source.kind` (each kind accepts only its own keys):

- `job` — `{ id?, select?, jobKind? }`: tail a background job (default: newest of this session);
- `file` — `{ path, startLine?, endLine? }`; `glob` — `{ pattern, limit? }`;
- `command` — `{ argv }`: re-runs a host command through the plugin's upstream pipe; `argv[0]` picks the interpreter (`pwsh`/`git_bash`/`bash`/`sh`/`zsh`), interpreter flags are stripped, **quote arguments containing spaces yourself**;
- `events` — `{ types, limit? }`: reads the job-event ring buffer (`job.registered`/`job.stopping`/`job.output`/`job.progress`/`job.settled`/`job.completed`/`job.failed`/`job.killed`/`job.removed`/`job.running`/`job.unknown`; typos fail as `source_invalid`), falling back to the session's current job list.

**An empty source returns immediately** — `samples: 1`, `emptySource: true`, `hit: false` — without calling the model and without waiting for the deadline. When `types` matches nothing, `notes` says why.

`background: true` registers a host job, returns `jobId` at once, and you read it later with `job_output` (its output is consumed on read). `notify: 'inbox'` posts a notice on a hit — only with `background: true`; `coalesce` (default true) merges same-kind notices, `maxNotificationsPerMinute` caps them.

Output: `hit`/`count`/`countThreshold`/`probability`/`evidence` (bounded tail of the hitting sample) plus `samples`/`hitSamples`/`errors`/`timedOut`/`elapsedMs`/`mode`/`source`/`clampNotes`/`notes`. Failed probes count in `errors` and never abort the loop; a hit is a probability, not proof.

## 6. Hard boundaries

Probabilities, not proof: never correctness evidence, never the sole basis for a pass/allow (that needs artifact-level evidence), never the basis of any **fail-open or fail-closed** policy (deterministic rules own that). tev1 returns only probabilities and no text — for a human-readable rationale use a generative model.

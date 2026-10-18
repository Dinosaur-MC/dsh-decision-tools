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

Ask up to 64 items/questions in ONE call; **NEVER loop one call per item** (cost ≈ count × body). `type` is `choice`/`noul`/`score`. `noul` returns a BOOLEAN `value`; its P(true) is in `probabilities.true` (0.475 = 47.5% chance of yes). `score` is on the 0..N-1 level scale, not normalised. For `choice`/`score` write the label set **once**: top-level `criteria` in batch mode, per-question in mixed mode. `noul` takes optional `{ false, true }` strings.

Each `item` is the complete short string or object to judge; the plugin never infers what it refers to in `material`.

Other parameters: `depth`, `model` (see §3). Invalid calls fail with a stable `kind` (`mode_invalid` for mode/count/shape problems, `invalid_request` for field-level ones, `material_*`/`source_*`/`upstream_*` for the rest) — read the message, it lists the legal values.

## 2. `material`: inline, file, glob, or tool

- a string (inline material);
- `{ file: { path, startLine?, endLine? } }` — `path` is workspace-root-relative (absolute, `..`, escaping symlinks refused); ranges are 1-based inclusive;
- `{ glob: { pattern, limit? } }`;
- `{ tool: { name, arguments? } }` — judge a host tool's **raw output**: it never enters your context, full text at `material.spillPath`; not with `file`/`glob` (`material_conflict`); the plugin's own tools are refused (`upstream_self_recursion`).

A file over the cap **fails**; a glob over the total cap is **truncated** (never complete). `material` reports the source, byte counts and `truncated`; `coverage.truncated`/`truncatedBy` mirror it.

## 3. `depth`: how much work the plugin may do

- `quick` — default model only; over budget it **fails**. `normal` (default) — smallest fitting model, escalates on overflow. Batching never changes `results[]`: one entry per item. `deep` — starts bigger, may chunk the material.

An explicit `model` disables capacity choice/escalation. Escalation switches to a different base model, so thresholds calibrated for one may not carry over (`cost.escalated`). Any Ollama model answering System One works: `model` pins a call, `defaultModel` changes the session default, `ladder` controls escalation, `node scripts/list-models.mjs` lists installed models.

## 4. Read `results`, `coverage`, `cost`, `notes`

- `results[]` — `{ id, type, value, probabilities?, confidence? }`, one entry per item/question in order; `value` = chosen label (`choice`/`score`) or boolean (`noul`).
- `coverage` — `requested`/`answered`/`batches`/`truncated`/`truncatedBy?`/`failed`/`aborted`: partial results are data, not failure.
- `cost` — `model`/`inputTokens`/`bodyBytes`/`wallMs`/`escalated`/`attempts[]`. `notes[]` — the plugin's observations verbatim (size, batching, low-confidence names).

`confidence` is the concentration of the distribution (1 - H/ln N); it is NOT accuracy. A `notes[]` line naming low-confidence items is a FLAG, not a filter: unnamed items are NOT thereby endorsed; read `probabilities` and escalate that question to your own reasoning.

In `deep` the material may be chunked: a per-chunk maximum is a locator, not a document-level probability.

## 5. `monitor`: wait for an event

`monitor` samples one source on an interval, asks the same `rubric`, counts hits. `once` returns at `countThreshold` (or deadline); `continuous` runs to deadline/cancel and returns accumulated `count` (no `hit`). Notices only at a **trigger** (once: threshold; continuous: every `notifyEvery` hits).

`description`=job description (folded to one line); label=source.kind+description. `job_output` streams ISO lines: `config …`, `hit=true P=…` per hit (consecutive miss only on hit→miss edge), `trigger_num=…` (N>1), `summary …`. `finished [...]`: once `hit/P|EP/dur` (or `hit/EP/dur` if threshold>1), continuous `trigger_num/EP/dur`; hit bool; ms; once EP=Σ(hit P)/N (pad 0); continuous EP=mean(trigger P), trigger P=Σ(window hit P)/notifyEvery, 0 trigger⇒0; once failure 1-EP. Boolean-only verdict has no P ⇒ 0.00 (detail/notice/stream).

Parameters: `description` (required; job label) · `source` (required) · `rubric` (required) · `type` (`noul` only) · `criteria` · `hitThreshold` (default 0.5) · `tailBytes` (default 4096, max 65536) · `mode` (`once`/`continuous`) · `countMode` (`cumulative`/`consecutive`; default cumulative) · `notifyEvery` (continuous, default 1) · `intervalMs` (5000) · `timeoutMs` (120000) · `countThreshold` (`once` return threshold, default 1; `continuous` ignores it) · `background` · `notify` · `coalesce` · `maxNotificationsPerMinute` (default 6).

`source.kind` (each kind accepts only its own keys):

- `job` — `{ id?, select?, jobKind? }`: tail a background job (default: newest of this session);
- `file` — `{ path, startLine?, endLine? }`; `glob` — `{ pattern, limit? }`;
- `command` — `{ argv }`: re-runs a host command through the plugin's upstream pipe; `argv[0]` picks the interpreter (`pwsh`/`git_bash`/`bash`/`sh`/`zsh`), interpreter flags are stripped, **quote arguments containing spaces yourself**;
- `events` — `{ types, limit? }`: reads the job-event ring buffer (`job.registered`/`job.stopping`/`job.output`/`job.progress`/`job.settled`/`job.completed`/`job.failed`/`job.killed`/`job.removed`/`job.running`/`job.unknown`; typos fail as `source_invalid`), falling back to the session's current job list.

Empty: `file`/`glob` ⇒ immediate (`samples:1`, `emptySource:true`, no model call); `job`/`events`/`command` ⇒ P=0, keep waiting. Permanent source errors (bad descriptor/outside root/explicit missing job id/file too large) fail fast; transient errors retry.

`background:true` returns `jobId`; `job_output` streams progress (consumed on read); abort=>killed, all-error=>failed; abort interrupts in-flight decide/sleep. `notify:'inbox'` posts a one-line notice only at a trigger, only with `background:true`; `coalesce`/`maxNotificationsPerMinute` bound them.

Output: `once` returns `hit`; `continuous` returns `count` (accumulated hits) and `streak` instead of `hit`. Both carry `description`/`ep`/`triggers`/`hitProbability`/`countThreshold`/`countMode`/`notifyEvery`/`probability`/`evidence` plus `samples`/`hitSamples`/`errors`/`timedOut`/`elapsedMs`/`mode`/`source`/`clampNotes`/`notes`. Failed probes count in `errors`; a hit is a probability, not proof.

## 6. Hard boundaries

Probabilities, not proof: never correctness evidence, never the sole basis for a pass/allow (that needs artifact-level evidence), never the basis of any **fail-open or fail-closed** policy (deterministic rules own that). tev1 returns only probabilities and no text — for a human-readable rationale use a generative model.

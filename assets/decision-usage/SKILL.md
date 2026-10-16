---
name: decision-usage
description: Use when a bounded judgment on local material is needed — routing, classification, filtering, relevance scoring — or with the `decision` tool's `material`/`rubric`/`items`/`depth`.
---

# Using the local decision model (`decision`)

A **local** System One model returns probabilities for a bounded question — routing, classification, filtering, relevance scoring.

## 1. One call, one mode

Give `material` plus exactly one mode; **giving both is an error**:

- `rubric` + `items` + `type` — one shared rubric judges N items independently. Write the rubric **once**.
- `questions` — M different questions on the same material: `{ name, type, instructions, criteria? }`.

Ask up to 64 items/questions in ONE call. **NEVER loop one call per item** — every call re-sends the whole `material` and costs roughly **count × body**. `type` is `choice`, `noul` or `score`. `noul` returns a NUMBER, not a boolean: 0.475 means a 47.5% chance of yes. `score` is reported on the 0..N-1 level scale, not normalised to 0-1. For `choice`/`score` write the label set **once**: top-level `criteria` in batch mode, per-question in mixed mode (`noul` takes none).

Each `item` is the complete short object to judge; the plugin never infers what it refers to in `material`.

## 2. `material`: inline, file, or glob

- a string (inline material);
- `{ file: { path, startLine?, endLine? } }` — `path` must be workspace-root-relative; absolute paths, `..` and escaping symlinks are refused; ranges are 1-based inclusive;
- `{ glob: { pattern, limit? } }`.

A single file over the cap **fails**; a glob over the total cap is **truncated** — truncated material is never complete.

## 3. `depth`: how much work the plugin may do

- `quick` — default model only, no escalation, no batching; over budget it **fails**.
- `normal` (default) — smallest model that fits, escalation on overflow, items batched across requests if needed. Batching never changes `results[]`: one entry per item.
- `deep` — starts bigger, escalates further, and may split large material into chunks.

An explicit `model` disables capacity choice and escalation for that call. Escalation switches to a bigger-context model and stays there (`cost.escalated`) — a different base model, so thresholds calibrated for one may not carry over.

## 4. Read `results`, `coverage`, `cost`, `notes`

- `results[]` — `{ id, type, value, probabilities?, confidence? }`, one entry per item/question in order; `value` = chosen label (`choice`/`score`) or boolean (`noul`).
- `coverage` — `requested`/`answered`/`batches`/`truncated`/`truncatedBy?`/`failed`/`aborted`: what actually happened; partial results are data, not failure.
- `cost` — `model`, `inputTokens`, `bodyBytes`, `wallMs`, `escalated`, `attempts[]`.
- `notes[]` — the plugin's own observations verbatim (size attribution, batching hints, low-confidence item names).

`confidence` is the concentration of the distribution (1 - H/ln N); it is NOT accuracy. A `notes[]` line that names low-confidence items is a FLAG, not a filter: an item not named is NOT thereby endorsed; every answer is unchanged, and when it fires read `probabilities` instead of the chosen label and escalate that question to your own reasoning.

In `deep` the material may also be split into chunks; a per-chunk maximum is a **locator, not a document-level probability** — never read a per-chunk maximum as the document's probability.

## 5. Hard boundaries

These answers are probabilities, not proof. Never treat them as correctness evidence, and never let one be the sole basis for a pass/allow decision — that needs artifact-level evidence. The tool must NOT decide routing and must NOT be the basis of any **fail-open or fail-closed** policy: those belong to deterministic rules. The tev1 family returns only probabilities and never text, so for a human-readable rationale use a generative model.

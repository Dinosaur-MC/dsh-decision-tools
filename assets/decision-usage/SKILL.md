---
name: decision-usage
description: Use when a bounded judgment on local material is needed — routing, classification, filtering, relevance, rubric scoring — or when the `decision` tool, `stateSource`, escalation (`escalated`), or scanning (`chunks`) is involved.
---

# Using the local decision model (`decision`)

A **local** System One model returns probabilities for a bounded question — routing, classification, filtering, relevance, rubric scoring. It never writes prose and never reasons step by step.

## 1. Everything in one call

Ask 1–64 questions about one shared `state` in a single call; the types are `choice`, `noul` and `score`. **NEVER loop one call per item** — every call re-sends the whole `state`. Put a candidate list in `state` and ask one question per candidate instead.

- `noul` returns a NUMBER, not a boolean: 0.475 means a 47.5% chance of yes.
- `score` is reported on the 0..N-1 level scale, not normalised to 0-1.

## 2. Reference material instead of inlining it

`state` and `stateSource` are mutually exclusive. With `stateSource` the plugin reads the file itself, and the material never enters your context.

- `{ kind: 'file', path: 'docs/spec.md', startLine?: 10, endLine?: 40 }` — `path` must be workspace-root-relative; absolute paths, `..` and escaping symlinks are refused; the range is 1-based inclusive and an out-of-range range fails loudly instead of truncating.
- `{ kind: 'glob', pattern: 'docs/one-level/*.md', limit?: 5 }` joins matches with `===== path =====` headers, so each part stays attributable.
- A single file over the byte cap **fails**; a glob over the total cap is **truncated** (`source.truncated`, `source.remaining`).

## 3. Read `confidence` and `confidence_warning` correctly

`confidence` is the concentration of the distribution (1 - H/ln N); it is NOT accuracy. A `confidence_warning` line names the questions below the threshold and leaves every answer unchanged — it is a FLAG, not a filter, and a question absent from it is NOT thereby endorsed. When it fires, read `probabilities` instead of the chosen label and escalate that question to your own reasoning.

## 4. Escalation means a different base model

On overflow, and only when you did not pass `model`, the plugin escalates to a bigger-context model and stays on it. The result then carries `escalated: { from, to, sticky }` — a different base model, not just more room, so thresholds calibrated for one model may not apply to another.

## 5. Scanning answers localizable questions only

`strategy: 'scan'` splits the material at semantic boundaries and asks per chunk: right for localizable questions (which chunks mention X), wrong for whole-document ones (a per-chunk maximum is not the document-level probability). `aggregate: 'any'` adds a per-`noul` maximum marked provisional — cross-chunk probabilities are not calibrated.

## 6. Read what actually happened

`model` is the model that answered; `plan` is what the plugin decided; `source` is the reference that was read; in scan mode `chunks` holds the per-chunk answers with no top-level `answers`, and `scan` reports `{ failed, truncated, truncatedBy, aborted, remaining, bytesPerChunk, aggregate? }` — a partial scan is data, not a failure.

## 7. Hard boundaries

These answers are probabilities, not proof. Never treat them as correctness evidence and never let one be the sole basis for a pass/allow decision — that needs artifact-level evidence. The tool must not decide routing and must not be the basis of any **fail-open or fail-closed** policy: those belong to deterministic rules. `tev1` returns only probabilities and never text, so for a human-readable rationale use a generative model.

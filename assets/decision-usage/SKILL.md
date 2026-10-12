---
name: decision-usage
description: Use when a bounded judgment on local material is needed — routing, classification, filtering, relevance, rubric scoring — or when the `decision` tool, `stateSource`, escalation (`escalated`), or scanning (`chunks`) is involved.
---

# Using the local decision model (`decision`)

What the `decision` tool is for: a **local** System One model returns probabilities for a bounded question — intent routing, classification, filtering, relevance judgement, rubric scoring. It never writes prose, and it is not a reasoning chain.

## 1. Ask everything in one call

Ask 1–64 questions about **one shared `state`** in a single call. The three question types are `choice` (pick one option), `noul` (probability that something is true), and `score` (rate against ordered levels).

**Never loop one call per item.** Every call re-sends the whole `state`, so N calls cost N copies. Put a candidate list in `state` and ask one question per candidate instead.

## 2. Reference material instead of inlining it

`state` (inline) and `stateSource` (reference) are **mutually exclusive**: give exactly one. With `stateSource` the plugin reads the file itself and the material **never enters your context** — use it for anything large.

- `{ kind: 'file', path: 'docs/spec.md', startLine?: 10, endLine?: 40 }` — `path` must be a **workspace-root-relative** path; absolute paths, `..` and symlinks that escape the root are refused. Line ranges are 1-based and inclusive, and an out-of-range range **fails loudly** rather than silently truncating.
- `{ kind: 'glob', pattern: 'docs/**/*.md', limit?: 5 }` reads every matching file under the workspace root (`*` does not cross `/`, `**` means any depth) and joins them with `===== <path> =====` headers, so you can still attribute each part.
- Two different overflow semantics: a **single file** over the byte cap **fails loudly** (shrink the range or the glob), while a **glob over the total cap** is truncated with `source.truncated = true` and `source.remaining` — read those before concluding the glob was complete.

## 3. Read `confidence_warning` correctly

`confidence` is the concentration of the distribution (`1 - H/ln N`), **not accuracy**. The tool appends a `confidence_warning` line naming the questions below the threshold and **keeps every answer unchanged** — it is a FLAG, not a filter.

When it fires: read `probabilities` instead of the chosen label, and escalate those questions to your own reasoning. Be aware of the model you are on: `τ = 0.25` was calibrated on `tev1:0.8b`; on 4B-and-larger models confidence is effectively always ≥ 0.77, so the warning is **inert** there.

## 4. Escalation changes the model, therefore the base

On a context overflow, and only when you did **not** pass `model`, the plugin escalates to a bigger-context model and keeps using it (sticky) until you pass `model` explicitly. When that happens the result carries `escalated: { from, to, sticky }`.

A different model means a **different base model**, not just more room: confidence distributions differ and thresholds calibrated for one model may not apply to another. Treat `escalated` as a change of instrument, not a retry.

## 5. Scanning only answers localizable questions

`strategy: 'scan'` (or the automatic fallback) splits the material at semantic boundaries and asks per chunk. It is right for **localizable** questions — which chunks mention X, which are relevant.

It is **wrong** for whole-document questions (is this entire document a complaint?): a per-chunk maximum is not the document-level probability. For those, let the plugin escalate so one model sees the whole thing.

`aggregate` is `none` by default. With `any` you get a per-`noul` maximum marked **provisional** — cross-chunk probabilities are not calibrated, so it is a locating hint at best.

## 6. Read what actually happened

- `model` — the model that actually answered (may differ from the one you named).
- `plan` — `{ strategy, action, model, reason }`: what the plugin decided.
- `source` — the reference that was read (path, line range, bytes) when you used `stateSource`.
- `chunks` — in scan mode the per-chunk answers; the top level then has **no `answers`**.
- `scan` — `{ failed, truncated, truncatedBy, aborted, remaining, bytesPerChunk, aggregate? }`. A partial scan is data, not a failure: check `truncated`/`aborted`/`remaining` before concluding.

## 7. Hard boundaries

These answers are **probabilities, not proof**. Never treat them as correctness evidence, and never let one be the sole basis for a pass/allow decision — that requires artifact-level evidence. The tool must not decide routing, and must not be the basis of any **fail-open or fail-closed** policy; those belong to deterministic rules, otherwise a broken decision model breaks routing entirely.

`tev1` family returns only probabilities and never text, so when a human-readable rationale must be preserved, use a generative model instead.

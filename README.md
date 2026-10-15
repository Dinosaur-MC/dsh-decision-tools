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

## Usage

One call, three question types, one shared state:

```json
{
  "state": "Our checkout has returned 500 errors since 9am. The payments page shows a generic error and no orders go through.",
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

The answer to *that* request — one line per question, then the usage and byte-size
lines. A real `tev1:0.8b` run on this machine: `node smoke/live.mjs` sends the same
request and prints the four lines above (the byte-size line is added by the tool
layer, not by the smoke script).

    label    choice  bug  p={bug=0.9648, account=0.0293, billing=0.0059}  conf=0.847
    refund   noul    P(true)=0.5045
    urgency  score   1.1235 / 2  p={1=0.7369, 2=0.1933, 0=0.0698}  conf=0.337
    (usage: input_tokens=796 output_tokens=4)
    体积: state=113B body=682B

The probabilities, the score and the token counts are model output and change with
the model or the machine; the two byte counts describe the request above, so they
stay put.

## Question types

| Type | Criteria | Answer |
|---|---|---|
| `choice` | 2–255 named options with descriptions | the most likely option plus each option's probability |
| `noul` | optional `{"false": ..., "true": ...}` descriptions | `noul`: the probability of true (a number, not a boolean) |
| `score` | 2–10 descriptions ordered lowest → highest | `score`: probability-weighted mean of the zero-based levels, on the 0..N-1 scale |

`confidence` is distribution concentration, `1 - H(p)/ln N`. It is **not** calibrated accuracy.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama endpoint; a path prefix is preserved (`http://host/ollama` → `http://host/ollama/v1/systemone`) |
| `defaultModel` | `tev1:0.8b` | model when a call omits `model` |
| `timeoutMs` | `120000` | per-request budget, including cold model load |
| `toolName` | `decision` | the name the model sees |
| `keepAlive` | unset | passed through as `keep_alive`; unset uses the server default |
| `softBodyBytes` | unset (falls back to `LIMITS.softBodyBytes`, 4096) | body size in bytes above which the result carries a `body_warning` |
| `bodyWarning` | unset (on) | `false` never emits `body_warning`; unset or `true` keeps it on |
| `minConfidence` | unset (falls back to `LIMITS.minConfidence`, 0.25) | `choice`/`score` answers whose `confidence` is below this — or missing — are named in a `confidence_warning`; `0` disables the gate |
| `maxChoiceOptions` | unset (falls back to `LIMITS.maxChoiceOptions`, 255) | Upper bound on `choice` option count. The OpenAPI spec notes *"The option limit depends on the model"*, so raise or lower this if your model differs. `score` is a separate, spec-fixed 2–10 and is **not** configurable. |
| `escalationEnabled` | `true` | Automatic escalation to a bigger-context decision model on context overflow. Passing `model` on a call disables it for that call. |
| `ladder` | unset (uses `DEFAULT_LADDER`) | Ordered `{ model, numCtx }[]` escalation candidates. The built-in ladder deliberately excludes `clef:latest` (27B on 8 GB never returned within 300 s). |
| `escalationMaxAttempts` | `3` | Maximum escalation attempts before failing with an actionable error instead of silently degrading. |
| `scanFirstChunkBytes` | unset (uses `LIMITS.softBodyBytes`) | Byte budget for the first scan chunk; later chunks are re-cut from the server's own token numbers. |
| `scanMaxChunks` | unset (uses `LIMITS.scanMaxChunks`) | Maximum chunks per scan; exceeding it returns a partial scan rather than failing. |
| `scanMaxTotalBytes` | unset (uses `LIMITS.scanMaxTotalBytes`) | Cumulative byte cap per scan. |
| `scanDeadlineMs` | unset (uses `LIMITS.scanDeadlineMs`) | Wall-clock budget per scan, independent of `timeoutMs`. |
| `scanAggregate` | `none` | `any` adds a provisional max probability per `noul` question. Cross-chunk probabilities are not calibrated — never treat it as a decision. |

`softBodyBytes` is silently clamped to `LIMITS.maxBodyBytes` (65536) — a threshold above
that byte cap could never fire — and a threshold set above the model's **real** capacity
(its `num_ctx`) silently makes the warning useless; nothing inside the plugin can detect
that, so the server's token check stays the authoritative guard.

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
   attributed to a single cause (Ollama version *and* model files both changed). **Vision is
   still not supported**: there is no `images` parameter and no path-based image loading — see
   ADR-3. The `model_broken` mapping is kept as a guard against an upstream regression.
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
   warn **before** the server rejects, and crossing it only adds a `body_warning` to the result
   and changes no rejection behaviour. The authoritative guard stays the server's token check.
   Byte count is a crude proxy, though: dense scripts (CJK) and ID-heavy text tokenize
   worse than 3.33 B/token and this threshold under-protects on such input.
6. **Bounded decisions only.** This plugin answers bounded questions whose candidate set is known up front. Open-ended generation, reasoning chains, and candidates that must be discovered while thinking still belong to a generative model.
7. **The confidence gate is a flag, not a guarantee.** Answers below the configured `minConfidence` — or with a missing `confidence` — are named in a `confidence_warning`; nothing is dropped, rewritten or rejected. The 0.25 default was calibrated on one small local sample (`tev1:0.8b`, 4 questions × 6 candidate orderings) and confidence scales differ by roughly an order of magnitude between models, so **re-calibrate per model**. A cross-session probe recorded an order-induced label flip at `confidence = 0.357`, above this threshold, and `confidence` measures concentration rather than accuracy — a question absent from the warning is **not** thereby endorsed.

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

## v2 (0.2.0)

The contract is final — there are no compatibility switches.

- `state` and `stateSource` are **mutually exclusive**: give exactly one. With `stateSource` the plugin reads the material itself and it **never enters your context**.
- `stateSource: { kind: 'file', path, startLine?, endLine? }` or `{ kind: 'glob', pattern, limit? }`. Glob: `*` does not cross `/`, `**` is any depth. A **single file** over the byte cap fails loudly; a **glob over the total cap** is truncated (`source.truncated` / `source.remaining`).
- `strategy`: `auto` (default) sends, then **escalates** to a bigger-context decision model on overflow, then falls back to **scanning**; `inline` never scans; `scan` always scans.
- Escalation is sticky per process and only fires when you did **not** pass `model`; when it fires the result carries `escalated: { from, to, sticky }`.
- Scanning returns `chunks` (per-chunk answers with line ranges) and **no top-level `answers`**. `scan.failed` / `truncated` / `aborted` / `remaining` tell you how complete the scan is; `aggregate` is provisional and must not be treated as a decision.
- `plan` echoes what the plugin decided (`strategy` / `action` / `model` / `reason`).
- The package also ships a **skill**: enabling the `dsh-decision-tools/skill` row puts `decision-usage` in the session skill catalog (the shipped `cordis.patch.yml` enables both rows).

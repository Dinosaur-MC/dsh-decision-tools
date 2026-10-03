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
| `choice` | 2–26 named options with descriptions | the most likely option plus each option's probability |
| `noul` | optional `{"false": ..., "true": ...}` descriptions | `noul`: the probability of true (a number, not a boolean) |
| `score` | 2–26 descriptions ordered lowest → highest | `score`: probability-weighted mean of the zero-based levels, on the 0..N-1 scale |

`confidence` is distribution concentration, `1 - H(p)/ln N`. It is **not** calibrated accuracy.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://localhost:11434` | Ollama endpoint |
| `defaultModel` | `tev1:0.8b` | model when a call omits `model` |
| `timeoutMs` | `120000` | per-request budget, including cold model load |
| `toolName` | `decision` | the name the model sees |
| `keepAlive` | unset | passed through as `keep_alive`; unset uses the server default |

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

1. **`clef` / `clef-flash` are broken on Ollama 0.35.1.** Every request — plain text,
   with an image, or a single minimal `noul` — returns a 500 whose body is
   `{"error":"{\"error\":{\"code\":500,\"message\":\"Clef: non-finite logit\",\"type\":\"server_error\"}}"}`.
   Vision is therefore not supported.
2. **Bigger is not necessarily more correct.** On the same ticket, `tev1:0.8b`
   answered `bug` (p=0.9648) while `tev1:latest` (4.2B) answered `billing`
   (p=0.5710, `bug` only 0.3212) — and `billing` is the weaker answer given the
   text. Verify per task.
3. First call includes model load (measured on this machine: 14.3 s cold and
   11.1 s warm for `tev1:0.8b`; 15.7 s cold and 8.0 s warm for `tev1:latest`).
4. No streaming, no tool calling, one request one response.
5. Server limits: 64 KiB request without images, 64 questions, 2–26 options per question.
6. **Bounded decisions only.** This plugin answers bounded questions whose candidate set is known up front. Open-ended generation, reasoning chains, and candidates that must be discovered while thinking still belong to a generative model.

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

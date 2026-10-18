# Changelog

## 0.4.0 — 2026-10-19

- Image material: `material.images` accepts 1–8 workspace-relative PNG/JPEG/WebP paths; `material.text` combines inline text with images; images are magic-checked, base64-encoded, and never enter the agent context.
- Image calls use a vision model (`clef` / `clef-flash`, passed via `model` or the decision row `modelOverride`), a 32 MiB body limit, and a single request (no escalation/batching/scanning; `depth` ignored).
- Output `material.images` reports count/bytes/encodedBytes/formats.
- Renamed `docs/architecture-current.md` to `docs/architecture.md` and updated references.
- CI test dependencies are devDependencies; `npm install --ignore-scripts` now installs them on both Node 22.19 and 24.

## 0.3.0 — 2026-10-19

First public release.

- `decision`: batch and mixed typed judgements (1–64 items or questions), inline/file/glob/tool material, a shared rubric sent once, model ladder and escalation, coverage/cost/notes.
- `monitor`: probability-conditioned polling over job/file/glob/command/events, `once`/`continuous` modes, `countMode`, `notifyEvery`, EP, and streaming job output.
- Four-row plugin layout (core / decision / monitor / skill) with GUI Configure pages and the bundled `decision-usage` skill.
- Release packaging: repository/homepage/bugs metadata, docs and scripts in the npm tarball, npm and link install instructions, CI workflow.

# Changelog

## 0.3.0 — 2026-10-19

First public release.

- `decision`: batch and mixed typed judgements (1–64 items or questions), inline/file/glob/tool material, a shared rubric sent once, model ladder and escalation, coverage/cost/notes.
- `monitor`: probability-conditioned polling over job/file/glob/command/events, `once`/`continuous` modes, `countMode`, `notifyEvery`, EP, and streaming job output.
- Four-row plugin layout (core / decision / monitor / skill) with GUI Configure pages and the bundled `decision-usage` skill.
- Release packaging: repository/homepage/bugs metadata, docs and scripts in the npm tarball, npm and link install instructions, CI workflow.

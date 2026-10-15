# model-eval-blueprint

A small blueprint for testing several models on the same text-processing job and scoring them fairly. You give it real inputs, an answer key per input, and a shell command per model. It runs every model on every input, has a judge model grade each output against the key, re-checks every "made-up" flag against the source, and prints a results table.

The worked example condenses an agent session transcript into a brief a fresh agent can resume from. Swap in your own job prompt and inputs; nothing in `eval.mjs` is specific to condensing.

One Node 20+ script, no dependencies. It's a blueprint to read and adapt, not a product.

## Quickstart

1. `node eval.mjs` runs the bundled example (needs `claude` on your PATH for the judge and the `haiku` model; the `baseline` model needs nothing).
2. Point `eval.config.json` at your own job prompt and inputs, and write an answer key per input with `prompts/answer-key-writer.md`, reviewed by a different model with `prompts/answer-key-reviewer.md`.
3. Add each model you want to compare as one shell command under `models` (prompt on stdin, answer on stdout), and run again.

**[AGENTS.md](AGENTS.md)** is the full adoption guide, written so a coding agent can take "test job X with models A, B, C" to a results table on its own. It also lists the traps we hit and which scoring fits which kind of job.

## Scoring

`overall = 0.5·recall + 0.5·QA − 0.1·min(made-up, 3)`, floored at 0. Recall is the weighted share of must-keep facts in the output; QA is the share of key questions answerable from the output alone; made-up counts only claims the source does not support.

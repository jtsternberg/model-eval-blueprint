# Adopting this eval: "test job X with models A, B, C"

You are adapting this blueprint to a new job. The goal is a results table that says which model does the job best, scored the same way for every model. Work through the steps in order; each one produces a file the next step needs.

`eval.mjs` reads `eval.config.json`, runs every model on every input, judges each output against that input's answer key, re-checks the judge's made-up flags against the source, and prints `runs/results.md`. Read its comments before changing it; the variations are documented there.

## 1. Collect real inputs (3-10)

Get them from the user's own work: real documents, transcripts, tickets, emails, whatever the job will actually see. Invented inputs flatter every model. Cover the range: short and long, clean and messy. Save each as a text file, e.g. `inputs/<name>.txt`. **Private data stays out of git**: add `inputs/` and `runs/` to `.gitignore` before anything else, and keep the repo unpublished unless the user says otherwise.

## 2. Write the job prompt

One file, `prompts/jobs/<job>.md`. Say who reads the output and what they must be able to do with it, what to keep, what to drop, and a length limit. Put `{{input}}` where the input goes (it is appended if absent). `prompts/jobs/condense-transcript.md` is a worked example.

## 3. Write an answer key per input, then have a different model attack it

Writer, ideally your strongest model:

```sh
{ cat prompts/answer-key-writer.md; printf '\n\nJOB:\n'; cat prompts/jobs/<job>.md; printf '\n\nSOURCE:\n'; cat inputs/<name>.txt; } \
  | claude -p --model opus > inputs/<name>.key.draft.json
```

Reviewer, a model from a **different** vendor or family than the writer (a key that one model wrote and the same model checked shares its blind spots):

```sh
{ cat prompts/answer-key-reviewer.md; printf '\n\nJOB:\n'; cat prompts/jobs/<job>.md; printf '\n\nSOURCE:\n'; cat inputs/<name>.txt; printf '\n\nKEY:\n'; cat inputs/<name>.key.draft.json; } \
  | sh -c 'H=$(mktemp -d) && mkdir $H/c && ln -s ~/.codex/auth.json $H/c/ && HOME=$H CODEX_HOME=$H/c codex exec --skip-git-repo-check --ephemeral -s read-only -C $H -o $H/out - >/dev/null && cat $H/out; rm -rf $H' \
  > inputs/<name>.key.review.json
```

(That wrapper isolates Codex from your global config; see Traps.) Strip any prose or code fences, drop the `changes` array, save as `inputs/<name>.key.json` (same basename as the input; the script finds it by name). Show the user the `changes` list and the weight-3 facts: they know the material, and a wrong key wrongs every model equally. Key shape: `examples/csv-export-session.key.json`.

## 4. Add each model as one config line

Each model is a shell command: the prompt arrives on stdin, the answer is read from stdout. The model's name is its key under `models`.

```json
"models": {
  "baseline": "tail -n 40 \"$EVAL_INPUT\"",
  "haiku":  "cd /tmp && claude -p --model haiku --setting-sources '' --tools '' --strict-mcp-config --no-session-persistence --system-prompt 'Follow the instructions in the user message exactly.'",
  "qwen":   "ollama run --think=false --hidethinking qwen3.5:9b-32k",
  "codex":  "H=$(mktemp -d) && mkdir $H/c && ln -s ~/.codex/auth.json $H/c/ && HOME=$H CODEX_HOME=$H/c codex exec --skip-git-repo-check --ephemeral -s read-only -C $H -o $H/out - >/dev/null && cat $H/out; rm -rf $H"
}
```

`qwen3.5:9b-32k` is a local alias with a bigger context window; make it with a two-line Modelfile (see the Ollama context trap). Set `"judge"` (and optionally `"grounder"`) the same way. Use a capable model for both. Add your inputs to `"inputs"` and set `"job"`.

## 5. Run the baseline first

`baseline` is a command with no model, here the last 40 lines of the input. Pick the dumbest plausible no-model answer for your job (first N lines, a regex extract, "always answer the majority class"). Run `node eval.mjs --models=baseline`. Every model must beat this number; one that doesn't is not worth its cost. Keep `"baseline": "<name>"` in the config so the table shows a "vs baseline" column.

## 6. Run the matrix

`node eval.mjs`. Every stage caches under `runs/<model>/<input>.*`, so an interrupted run resumes and adding a model only runs that model. After editing a key or the judge prompt: `--rejudge`. After editing the job prompt or a model command: `--force` (or delete that model's `runs/` folder). Read `runs/<model>/<input>.out.md` for a few outputs yourself; numbers alone hide failure modes.

## 7. Replicate anything that looks good

A single great run at temperature 0 can be luck. Before you tell the user a model wins, re-run the leaders with sampling on and several replicates (see the replicates comment in `eval.mjs`) and check the spread. A different judge model on the same outputs (`--rejudge` with `"judge"` changed) checks for self-preference.

## 8. Read the results

| column | meaning |
|---|---|
| recall | weighted share of key facts present (partial = half) |
| QA | share of key questions the judge could answer correctly from the output alone (partial = half) |
| made-up | judge-flagged claims the source does NOT support (grounded) |
| flagged | everything the judge flagged, before grounding |
| noise | key noise items that leaked into the output |
| empty | runs that returned no output; each scored 0 and counted in the means |
| overall | 0.5·recall + 0.5·QA − 0.1·min(made-up, 3), floored at 0 |

Report the table plus what you saw reading outputs. `runs/results.json` has per-input rows.

## Which scoring fits which job

- **Preserve-information jobs** (summarize, condense, extract notes, rewrite for an audience): use the judge as shipped. Recall measures coverage, QA measures whether the output is usable, made-up penalizes invention.
- **Classification / single-answer jobs** (label, route, yes/no, pick-one): no judge. Put `"expected"` in each key and compare exactly; see the exact-match comment in `eval.mjs`. Cheaper, deterministic, no judge bias.
- **Generation with no single right answer** (drafting, tone): the judge's facts/QA still apply if you can state what must be in the output; otherwise this harness is the wrong tool.

## Traps (each one bit us)

- **`codex exec` injects your global `~/.codex/AGENTS.md` and skills list (~35KB) into every call**, even with `--ignore-user-config`. The codex line above runs it with a throwaway `HOME` and a `CODEX_HOME` holding only a symlinked `auth.json`. Verify with `codex debug prompt-input` under the same env.
- **`claude -p` still injects an environment block** (cwd, git status, platform, date) even with `--setting-sources '' --system-prompt …`. It's small, but outputs echo it ("Is a git repository: false" showed up as an open item). Run it from a neutral directory (`cd /tmp &&`) so your project's details don't leak in. `--bare` drops more but needs an API key, not a subscription login.
- **Terminal wrappers can shim `codex`/`claude`** and add hooks that run inside every call (seen with cmux's shim, even under the throwaway `HOME`). Check `command -v codex`; point the config at the real binary if it's a shim.
- **A local model's thinking can eat the whole output budget** and return empty output (gemma4 on Ollama needed `--think=false`). Empty output scores 0 and is counted in the table's `empty` column; a non-zero there usually means a config fix, not a bad model.
- **Ollama silently truncates input past its context window (`num_ctx`)**, and the default is often far smaller than a long input. `ollama run` has no flag for it; create an alias with a Modelfile:
  ```sh
  printf 'FROM qwen3.5:9b\nPARAMETER num_ctx 32768\n' > Modelfile && ollama create qwen3.5:9b-32k -f Modelfile
  ```
  Confirm with `ollama ps` (CONTEXT column) after one call. (API callers can pass `options.num_ctx` instead.) Before trusting a local model's score, compare each input's token count (roughly chars / 4) plus the job prompt and expected output against that context; if it doesn't fit, the model graded on a cut-down input.
- **A great temperature-0 run can be luck.** Replicate with sampling before believing it.
- **A judge that only sees the key flags true details as made-up** (44% of flags in our run). That's why grounding exists; never report the `flagged` column as hallucinations.
- **Truncating input to fit a small context window destroyed quality**, even for the best model (0.80 → 0.16). Use a model that fits, or a chunking variation, never a silent cut.
- **Large local models pin the machine for hours** in a matrix run. Run local models serially, one at a time, and budget wall time before starting.
- **Self-preference**: a judge favors its own family. Sonnet-as-judge doubled Sonnet's lead vs Opus/Codex judges in our run.

## Adding a variation

The comments in `eval.mjs` list each variation at the place it plugs in (chunk-and-merge, rolling refine, pre-filter, chunk gates in `doJob`; different judge in `judge`; exact match in `score`; replicates in the main loop), with what building it takes. Build one only when the plain single call fails on your inputs, add a branch for it in `doJob`, give the variant its own entry under `models` so it lands in the same table as the plain call, and compare it against the plain call on the same inputs. Our run found chunking and gates hurt more often than they helped.

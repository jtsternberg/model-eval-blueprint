#!/usr/bin/env node
// Run every model on every input, judge each output against its answer key,
// ground the judge's made-up flags against the source, print a results table.
//
//   node eval.mjs [--config=eval.config.json] [--models=a,b] [--rejudge] [--force]
//
// --rejudge  keep model outputs, redo judge + grounding (after editing a key or judge prompt)
// --force    redo everything (after editing the job prompt or a model command)
// Every stage caches under runs/<model>/<input>.*, so a re-run only does missing work.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
	const [k, ...v] = a.replace(/^--/, '').split('=');
	return [k, v.length ? v.join('=') : true];
}));
const HERE = dirname(fileURLToPath(import.meta.url));
const cfgPath = resolve(args.config || 'eval.config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const at = (p) => resolve(dirname(cfgPath), p);
const read = (p) => readFileSync(p, 'utf8');
const OUT = at(cfg.out || 'runs');
const only = typeof args.models === 'string' ? args.models.split(',') : null;
const JUDGE = cfg.judge;
const GROUNDER = cfg.grounder || cfg.judge;
const jobPrompt = read(at(cfg.job));
const prompt = (name) => read(join(HERE, 'prompts', `${name}.md`));

// Models are shell commands: prompt on stdin, answer on stdout. $EVAL_INPUT is the
// input's path, for no-model baselines that read the source directly.
function run(cmd, stdin, env = {}) {
	const t = Date.now();
	const r = spawnSync('sh', ['-c', cmd], {
		input: stdin, encoding: 'utf8', maxBuffer: 64 << 20,
		timeout: (cfg.timeoutSec || 900) * 1000, env: { ...process.env, ...env },
	});
	if (r.error || r.status !== 0) {
		throw new Error(`\`${cmd}\` failed (${r.error?.code ?? 'exit ' + r.status}): ${(r.stderr || '').trim().slice(0, 300)}`);
	}
	return { text: r.stdout.trim(), secs: (Date.now() - t) / 1000 };
}

// Judges wrap JSON in fences or prose; take the outermost {...} if a plain parse fails.
function parseJson(text) {
	const s = text.replace(/```(?:json)?/g, '');
	try { return JSON.parse(s); } catch {}
	const a = s.indexOf('{'), b = s.lastIndexOf('}');
	if (a < 0 || b <= a) return null;
	try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

function askJson(cmd, stdin, valid) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		const j = parseJson(run(cmd, stdin).text);
		if (j && valid(j)) return j;
	}
	throw new Error(`unparseable JSON from \`${cmd}\` (2 attempts)`);
}

function cached(file, redo, make) {
	if (!redo && existsSync(file)) return JSON.parse(read(file));
	const v = make();
	writeFileSync(file, JSON.stringify(v, null, 2));
	return v;
}

// --- the job --------------------------------------------------------------
// VARIATIONS plug in here, replacing the single call with a pipeline:
// - Chunk-and-merge (long inputs): split the source on natural boundaries (turns,
//   paragraphs), run the job per chunk, then run a merge prompt over the notes. Needs
//   a chunker + a merge prompt. In our run it DOUBLED made-up claims vs one call on the
//   whole input; prefer a model whose context fits the whole input.
// - Rolling refine: chunk, then loop `brief = model(refinePrompt + brief + nextChunk)`.
//   Needs a refine prompt; costs one call per chunk, serial.
// - No-model pre-filter: strip boilerplate/repeated pastes/huge tool output from `src`
//   before the call. A pure function; measure what it removes against the key's facts.
// - Decision-model chunk gate: before each chunk, ask a cheap model "anything worth
//   keeping? yes/no" and skip the no's. Needs chunking + a gate prompt; log which
//   weight-3 facts lived in skipped chunks. In our run no gate helped.
// To compare a variation against the plain call, add a branch here (e.g. on the model
// name) and give the variant its own entry under "models" so both land in one table.
// Do NOT truncate to fit a small context: in our run it took the best model 0.80 -> 0.16.
function doJob(cmd, src, inputPath) {
	const p = jobPrompt.includes('{{input}}') ? jobPrompt.replace('{{input}}', () => src) : `${jobPrompt}\n\n${src}`;
	const r = run(cmd, p, { EVAL_INPUT: inputPath });
	// Empty output (often a local model's thinking ate the output budget) is a real
	// result: it scores 0 and stays in the table. Dropping it would bias means upward.
	return { output: r.text, secs: r.secs, empty: !r.text };
}

// --- judging ----------------------------------------------------------------
// VARIATION: self-preference check. Set "judge" to a model from a different vendor than
// the leaders, or re-run with --rejudge under two judges and compare. In our run
// Sonnet-as-judge doubled Sonnet's own lead vs Opus/Codex judges.
function judge(key, output) {
	const visible = { facts: key.facts.map(({ id, fact }) => ({ id, fact })), noise: key.noise || [], qa: key.qa };
	// "judgeNote": job-specific grading rule (e.g. a timestamp tolerance) without forking judge.md.
	const note = cfg.judgeNote ? `\n\nJOB-SPECIFIC RULE: ${cfg.judgeNote}` : '';
	const stdin = `${prompt('judge')}${note}\n\nANSWER KEY:\n${JSON.stringify(visible, null, 2)}\n\nOUTPUT TO GRADE:\n<output>\n${output}\n</output>`;
	return askJson(JUDGE, stdin, (j) => j.facts && j.qa);
}

// The judge only sees the key, so it flags true details the key omitted (44% of flags
// in our run). Only claims the SOURCE does not support count as made-up.
function ground(src, claims) {
	if (!claims.length) return { claims, verdicts: {} };
	const list = claims.map((c, i) => `${i + 1}. ${c}`).join('\n');
	const stdin = `${prompt('grounding')}\n\nSOURCE:\n<source>\n${src}\n</source>\n\nCLAIMS:\n${list}`;
	return { claims, verdicts: askJson(GROUNDER, stdin, (j) => typeof j === 'object') };
}

// --- scoring --------------------------------------------------------------
// VARIATION: classification / extraction jobs with one right answer per input need no
// judge. Put {"expected": "..."} in the key, compare normalized output === expected here,
// skip judge() and ground(), and report accuracy instead of recall/QA.
const CREDIT = { yes: 1, partial: 0.5, correct: 1 };
function score(key, v, g) {
	let total = 0, got = 0;
	for (const f of key.facts) {
		const w = f.weight ?? 1;
		total += w;
		got += w * (CREDIT[v.facts[f.id]] ?? 0);
	}
	const grade = (x) => (typeof x === 'string' ? x : x?.grade);
	const qa = key.qa.reduce((s, q) => s + (CREDIT[grade(v.qa[q.id])] ?? 0), 0) / key.qa.length;
	const recall = total ? got / total : 0;
	// A claim with no grounding verdict stays made-up: never forgive by default.
	const madeup = g.claims.filter((_, i) => g.verdicts[String(i + 1)] !== 'supported').length;
	const noiseIds = new Set((key.noise || []).map((n) => n.id));
	return {
		recall, qa, madeup, flagged: g.claims.length,
		noise: (v.noise || []).filter((id) => noiseIds.has(id)).length,
		overall: Math.max(0, 0.5 * recall + 0.5 * qa - 0.1 * Math.min(madeup, 3)),
	};
}

// --- main -----------------------------------------------------------------
// VARIATION: replicates. A great temperature-0 run can be luck. Add "replicates": N and
// loop r = 1..N here with the cache file suffixed `~r${r}` and sampling enabled in the
// model command (e.g. a temperature option); report mean and spread per model.
const rows = [], errors = [];
for (const input of cfg.inputs) {
	const inputPath = at(input);
	const name = basename(input).replace(/\.[^.]+$/, '');
	const src = read(inputPath);
	const key = JSON.parse(read(inputPath.replace(/\.[^.]+$/, '.key.json')));
	for (const [model, cmd] of Object.entries(cfg.models)) {
		if (only && !only.includes(model)) continue;
		const dir = join(OUT, model);
		mkdirSync(dir, { recursive: true });
		const base = join(dir, name);
		try {
			process.stderr.write(`${model} x ${name}: job`);
			const out = cached(`${base}.out.json`, args.force, () => doJob(cmd, src, inputPath));
			writeFileSync(`${base}.out.md`, out.output);
			if (out.empty) {
				process.stderr.write(' EMPTY output, scored 0\n');
				rows.push({ model, input: name, secs: out.secs, recall: 0, qa: 0, madeup: 0, flagged: 0, noise: 0, overall: 0, empty: 1 });
				continue;
			}
			process.stderr.write(' judge');
			const v = cached(`${base}.judge.json`, args.force || args.rejudge, () => judge(key, out.output));
			process.stderr.write(' ground\n');
			const g = cached(`${base}.ground.json`, args.force || args.rejudge, () => ground(src, v.madeup || []));
			rows.push({ model, input: name, secs: out.secs, empty: 0, ...score(key, v, g) });
		} catch (e) {
			process.stderr.write(` ERROR\n  ${e.message}\n`);
			errors.push(`${model} x ${name}: ${e.message}`);
		}
	}
}

const models = [...new Set(rows.map((r) => r.model))];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const stats = models.map((m) => {
	const rs = rows.filter((r) => r.model === m);
	const s = { model: m, n: rs.length, empty: rs.filter((r) => r.empty).length };
	for (const k of ['recall', 'qa', 'madeup', 'flagged', 'noise', 'overall', 'secs']) s[k] = mean(rs.map((r) => r[k]));
	return s;
}).sort((a, b) => b.overall - a.overall);
const bar = stats.find((s) => s.model === cfg.baseline)?.overall;
const f = (x, d = 2) => x.toFixed(d);
const lines = [
	'| model | n | recall | QA | made-up | flagged | noise | overall | vs baseline | empty | sec |',
	'|---|---|---|---|---|---|---|---|---|---|---|',
	...stats.map((s) => `| ${s.model} | ${s.n} | ${f(s.recall)} | ${f(s.qa)} | ${f(s.madeup, 1)} | ${f(s.flagged, 1)} | ${f(s.noise, 1)} | **${f(s.overall)}** | ${bar === undefined || s.model === cfg.baseline ? '-' : (s.overall >= bar ? '+' : '') + f(s.overall - bar)} | ${s.empty} | ${f(s.secs, 0)} |`),
];
const table = lines.join('\n');
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'results.md'), `${table}\n`);
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ rows, errors }, null, 2));
console.log(table);
if (errors.length) console.log(`\n${errors.length} cell(s) failed:\n- ${errors.join('\n- ')}`);

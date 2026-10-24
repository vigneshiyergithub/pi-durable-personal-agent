#!/usr/bin/env node
// negative-control-probe-timeout.mjs — the falsifiability gate for the /health responsiveness fix
// (ELR M2 hygiene, PR #20's deferred reconcile).
//
// It runs scripts/probe-health-window.mjs (the continuous-probe measurement harness, which reads the
// production observer probe's own per-request timeout from src/orchestra.ts at run time) twice:
//
//   1. HEAD (default boot): the reconcile is deferred to after listen, chunked with yields. The
//      criterion dir: every measurement must sit BELOW the production probe timeout
//      (worstGapExceedsProbeTimeout=false AND first200ExceedsProbeTimeout=false).
//   2. block (negative control): PHW_RECONCILE_BEFORE_LISTEN=1 restores the pre-#20 ordering — the
//      whole real reconcile awaited inside Agent.open() before the listener starts (the test-only
//      AgentOptions.reconcileBeforeListen hook, src/agent.ts:51). No delay is injected: the work is
//      genuine reconcile work over PHW_EVENTS_BLOCK events (default 400000), and the harness must
//      report a first-200 time ABOVE the production probe timeout.
//
// It exits 0 exactly when the control fails for the right reason — HEAD below the timeout AND the
// forced pre-fix ordering above it — and non-zero otherwise (including when the forced run passes,
// which would mean the harness could not detect the regression).
//
// Run:  node scripts/negative-control-probe-timeout.mjs                      (~2 min)
//   PHW_NEG_HEAD_EVENTS=80000 / PHW_NEG_BLOCK_EVENTS=400000 size the two runs
//   PHW_NEG_HEAD_REPEATS=2   repeats for the HEAD run (default 2)
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, "scripts/probe-health-window.mjs");

const HEAD_EVENTS = Number(process.env.PHW_NEG_HEAD_EVENTS ?? "80000");
const HEAD_REPEATS = Math.max(1, Math.round(Number(process.env.PHW_NEG_HEAD_REPEATS ?? "2")));
const BLOCK_EVENTS = Number(process.env.PHW_NEG_BLOCK_EVENTS ?? "400000");
const HEAD_DEADLINE_MS = Math.max(Number(process.env.PHW_NEG_HEAD_DEADLINE_MS ?? "120000"), 60_000);
const BLOCK_DEADLINE_MS = Math.max(Number(process.env.PHW_NEG_BLOCK_DEADLINE_MS ?? "120000"), 60_000);

if (!Number.isInteger(HEAD_EVENTS) || HEAD_EVENTS < 1) throw new Error(`PHW_NEG_HEAD_EVENTS must be a positive integer, got ${process.env.PHW_NEG_HEAD_EVENTS}`);
if (!Number.isInteger(BLOCK_EVENTS) || BLOCK_EVENTS < 1) throw new Error(`PHW_NEG_BLOCK_EVENTS must be a positive integer, got ${process.env.PHW_NEG_BLOCK_EVENTS}`);

function failure(message) {
	console.error(`negative-control-probe-timeout: FAIL: ${message}`);
	process.exit(1);
}

/** Run the measurement harness once; return its output for verdict parsing. */
function runHarness(env) {
	const result = spawnSync(process.execPath, [HARNESS], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, ...env, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "unused" },
		timeout: 170_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error) failure(`the harness could not run: ${result.error.message}`);
	const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
	if (result.status !== 0) failure(`the measurement harness exited ${result.status}:\n${output.slice(-4000)}`);
	return output;
}

/** Pull one field out of the harness's "PHW verdict: config=..." line. */
function verdictField(output, config, field) {
	const line = output.split("\n").find((l) => l.startsWith(`PHW verdict: config=${config} `));
	if (line === undefined) failure(`the harness printed no "PHW verdict: config=${config}" line:\n${output.slice(-2000)}`);
	const match = new RegExp(`(?:^| )${field}=([^ ]+)`).exec(line);
	if (match === null) failure(`the verdict line for ${config} does not contain ${field}: ${line}`);
	return match[1];
}

/** Pull the boot reconcile's real row count out of the "PHW reconcount" line. */
function reconCount(output, config) {
	const line = output.split("\n").find((l) => l.startsWith(`PHW reconcount: config=${config} `));
	if (line === undefined) failure(`the harness printed no "PHW reconcount: config=${config}" line`);
	if (line.includes("n/a")) failure(`no reconcile row count in the reconcount line: ${line}`);
	const match = /bootReconcileInserted\(min-max\)=(\d+)-(\d+)/.exec(line);
	if (match === null) failure(`could not parse the reconcount line: ${line}`);
	const lo = Number(match[1]);
	const hi = Number(match[2]);
	if (!Number.isInteger(lo) || !Number.isInteger(hi)) failure(`could not parse the reconcount line: ${line}`);
	return { lo, hi, line };
}

console.log("=== negative control: /health responsiveness gate — the fix fails exactly when the pre-fix blocking order is forced ===");
const hook = execFileSync("git", ["grep", "-n", "reconcileBeforeListen", "--", "src/agent.ts"], { cwd: ROOT, encoding: "utf8" }).trim();
console.log(`control switch (the forced pre-fix code path, test-only hook in the protected src/agent.ts):`);
for (const line of hook.split("\n")) console.log(`  ${line}`);

console.log(`\n--- HEAD run (deferred reconcile, ${HEAD_EVENTS} events, ${HEAD_REPEATS} repeats) — must sit BELOW the production probe timeout ---`);
const headEnv = { PHW_CONFIGS: "xlarge", PHW_REPEATS: String(HEAD_REPEATS), PHW_EVENTS_XLARGE: String(HEAD_EVENTS), PHW_RUN_DEADLINE_MS: String(HEAD_DEADLINE_MS) };
const head = runHarness(headEnv);
for (const line of head.split("\n")) if (/^PHW (summary|verdict|reconcount|line): config=xlarge/.test(line)) console.log(`  ${line}`);
const headGap = verdictField(head, "xlarge", "worstGapExceedsProbeTimeout");
const headFirst = verdictField(head, "xlarge", "first200ExceedsProbeTimeout");
if (headGap !== "false" || headFirst !== "false") {
	failure(`the HEAD run itself exceeded the probe timeout (worstGapExceedsProbeTimeout=${headGap}, first200ExceedsProbeTimeout=${headFirst}); the baseline is broken, the control is meaningless`);
}
const headCount = reconCount(head, "xlarge");
if (headCount.lo !== HEAD_EVENTS) failure(`the HEAD run's reconcile processed ${headCount.lo}..${headCount.hi} rows, expected ${HEAD_EVENTS} (the measurement must be of real reconcile work)`);

console.log(`\n--- block run (pre-#20 ordering forced, ${BLOCK_EVENTS} events) — the control: must exceed the production probe timeout ---`);
const blockEnv = { PHW_CONFIGS: "block", PHW_REPEATS: "1", PHW_EVENTS_BLOCK: String(BLOCK_EVENTS), PHW_RUN_DEADLINE_MS: String(BLOCK_DEADLINE_MS) };
const block = runHarness(blockEnv);
for (const line of block.split("\n")) if (/^PHW (summary|verdict|reconcount|line): config=block/.test(line)) console.log(`  ${line}`);
const blockFirst = verdictField(block, "block", "first200ExceedsProbeTimeout");
const blockGap = verdictField(block, "block", "worstGapExceedsProbeTimeout");
const blockFirst200 = verdictField(block, "block", "first200Ms");
const blockCount = reconCount(block, "block");
if (blockCount.hi !== BLOCK_EVENTS) failure(`the block run's reconcile processed ${blockCount.lo}..${blockCount.hi} rows, expected ${BLOCK_EVENTS}: the control must fail on real reconcile work`);
if (blockFirst !== "true") {
	failure(
		`regression NOT caught: the forced pre-fix ordering stayed inside the probe timeout ` +
			`(first200Ms=${blockFirst200}, first200ExceedsProbeTimeout=${blockFirst}, worstGapExceedsProbeTimeout=${blockGap}); ` +
			`raise PHW_NEG_BLOCK_EVENTS so the pre-fix ordering genuinely breaches the timeout`,
	);
}

console.log(`\ngate summary: HEAD (deferred, ${HEAD_EVENTS} events): worstGapExceedsProbeTimeout=false, first200ExceedsProbeTimeout=false` +
	` (reconcile processed ${headCount.lo}-${headCount.hi} rows)`);
console.log(`gate summary: block (pre-#20 ordering, ${BLOCK_EVENTS} events): first200Ms=${blockFirst200} → first200ExceedsProbeTimeout=true` +
	` (reconcile processed ${blockCount.lo}-${blockCount.hi} rows of real work, no injected delay)`);
console.log("PASS negative-control-probe-timeout: the harness reports the production-probe-timeout breach exactly when the pre-fix blocking order is forced, and stays below it at HEAD");

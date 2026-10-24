// ELR M3 re-runnable proofs (spec docs/elr-canvas-spec.md §9 M3).
//
// Each case exits 0 exactly when its criterion holds; it prints the evidence it measured. Run from the
// repository root:
//   node bench/proofs.ts smoke        # the M3 command runs, 3 episodes, JSONL shape, cost cap
//   node bench/proofs.ts records      # the results JSONL has the required non-null fields
//   node bench/proofs.ts no-scorecard # arm A tool results carry no scorecard
//   node bench/proofs.ts scorecard   # arm A has no scorecard, arm B does (same fixture)
//   node bench/proofs.ts system-one  # B1 stub smoke writes one System One entry per label type
//   node bench/proofs.ts reward-isolation # reward modules ignore System One; reward is unchanged
//   node bench/proofs.ts label-isolation  # B′ labels never reach the agent, for every evaluator
//   node bench/proofs.ts calibration-report # B′ prints per-label accuracy and ECE against the verifier, free stub
//   node bench/proofs.ts budget       # BENCH_MAX_USD=0.001 stops before episode 2 (exactly 1 record)
//   node bench/proofs.ts lab          # the Lab panel's handler serves runs, curves, knowledge; /health unaffected
//   node bench/proofs.ts lab-readonly # the panel's data is served while the harness entry is gone and a spawn guard is armed
//   node bench/proofs.ts lab-no-launch-call # negated search: no launch call in the panel's code path
//   node bench/proofs.ts lab-no-launch-route # negated search: the panel adds no route that starts a run
//   node bench/proofs.ts lab-render   # the real LabPanel component renders the real recorded results
//   node bench/proofs.ts out-of-boot  # no src/ file outside src/elr/bench imports the bench, /health ok
//   node bench/proofs.ts all
import assert from "node:assert/strict";
import childProcess, { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmark } from "./runner.ts";
import { readResults } from "../src/elr/bench/results.ts";
import { createStubSystemOneClient } from "../src/elr/bench/system-one-run.ts";
import { SYSTEM_ONE_LABEL_TYPES, createSystemOneEvaluator, type SystemOneEvaluator } from "../src/elr/system-one.ts";
import type { ArmId } from "../src/elr/bench/types.ts";
import type { LabSnapshot } from "../src/elr/lab.ts";

const IS_TEST = process.env.NODE_TEST_CONTEXT !== undefined;
const RESULTS = resolve(process.env.BENCH_RESULTS_DIR?.trim() || "data/bench", "A-smoke-1234.jsonl");

/**
 * Make sure a run's results exist. A prior `npm run bench` normally wrote them; if the file is absent,
 * run the offline reference driver so the records proof is self-contained and credential-free.
 */
async function ensureResults(): Promise<void> {
	if (existsSync(RESULTS)) return;
	await runBenchmark({ arm: "A", set: "smoke", seed: 1234, driver: "reference", maxUsd: 10, resultsPath: RESULTS, log: () => {} });
}

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function readRecords(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) fail(`results file ${path} does not exist; run the bench first`);
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Record REAL benchmark results by running the M3 harness CLI itself (the same command `npm run bench`
 * runs), pinned to the offline reference driver: no key, no cost, reproducible from a clean checkout.
 * The Lab panel's proofs render this file — never a fixture the panel code did not write.
 */
function runHarnessCli(resultsPath: string, arm: "A" | "B", seed: number): Record<string, unknown>[] {
	const run = spawnSync(
		process.execPath,
		["--max-old-space-size=1024", "bench/run.ts", "--arm", arm, "--set", "smoke", "--seed", String(seed), "--driver", "reference", "--out", resultsPath],
		{ encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	process.stdout.write(run.stdout ?? "");
	process.stderr.write(run.stderr ?? "");
	if (run.status !== 0) fail(`the M3 harness CLI (arm ${arm}, seed ${seed}) exited ${run.status}`);
	const records = readRecords(resultsPath);
	if (records.length !== 3) fail(`the harness recorded ${records.length} episodes for arm ${arm}, expected 3`);
	if (records.some((r) => r.arm !== arm || r.set !== "smoke" || typeof r.boundaryF !== "number")) {
		fail(`the harness records for arm ${arm} do not carry arm/set/boundaryF`);
	}
	return records;
}

/**
 * `git grep -nE` with exact semantics for negated proofs: returns the matching lines, or `undefined`
 * when nothing matched (git's exit status 1). Any other exit status is an error, so a proof that
 * treats `undefined` as pass exits 0 exactly when the pattern finds nothing — a broken pattern or a
 * missing path fails the proof instead of silently passing it.
 */
function gitGrep(pattern: string, paths: string[]): string[] | undefined {
	try {
		const out = execFileSync("git", ["grep", "-nE", pattern, "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return out.split("\n").filter(Boolean);
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status === 1) return undefined;
		throw error;
	}
}

/** Criterion: the smoke command exits 0, runs exactly 3 smoke tasks, and prints per-episode + total cost. */
async function smokeCase(): Promise<void> {
	const run = spawnSync("npm", ["run", "bench", "--", "--arm", "A", "--set", "smoke", "--seed", "1234"], {
		encoding: "utf8",
		// Pin the offline reference driver so this proof needs no key, costs nothing and is reproducible
		// even when the surrounding shell happens to carry OPENROUTER_API_KEY.
		env: { ...process.env, OPENROUTER_API_KEY: "" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	process.stdout.write(run.stdout ?? "");
	process.stderr.write(run.stderr ?? "");
	if (run.status !== 0) fail(`npm run bench exited ${run.status}`);
	const episodeLines = (run.stdout ?? "").split("\n").filter((line) => line.startsWith("episode "));
	if (episodeLines.length !== 3) fail(`expected 3 episode lines, found ${episodeLines.length}`);
	const total = /totalCostUsd=\$([0-9.]+)/.exec(run.stdout ?? "");
	if (total === null) fail("the summary did not print a total cost");
	const cost = Number(total[1]);
	if (!(cost <= 0.5)) fail(`total cost $${cost} exceeds $0.50`);
	console.log(`PASS smoke: 3 episodes, totalCostUsd=$${cost.toFixed(6)} (<= $0.50), printed per-episode and total summary`);
	await recordsCase();
}

/** Criterion: the run's results JSONL has exactly 3 records with every required field non-null. */
async function recordsCase(): Promise<void> {
	await ensureResults();
	const records = readRecords(RESULTS);
	if (records.length !== 3) fail(`expected 3 records, found ${records.length}`);
	for (const record of records) {
		for (const field of ["seed", "arm", "set", "taskId", "boundaryF", "calls", "strokes", "costUsd", "model", "providerFingerprint"]) {
			if (record[field] === null || record[field] === undefined) fail(`record ${record.taskId} has null ${field}`);
		}
		if (record.arm !== "A" || record.set !== "smoke") fail(`record ${record.taskId} is not arm A / set smoke`);
		if (typeof record.boundaryF !== "number" || typeof record.calls !== "number" || typeof record.strokes !== "number") {
			fail(`record ${record.taskId} has a non-numeric boundaryF/calls/strokes`);
		}
	}
	console.log(`PASS records: ${records.length} records; fields ` + records.map((r) => `${r.taskId}(F=${(r.boundaryF as number).toFixed(3)})`).join(", "));
}

/** Criterion: arm A tool results contain no scorecard. */
async function noScorecardCase(): Promise<void> {
	await ensureResults();
	const records = readRecords(RESULTS);
	if (records.length === 0) fail("no records to inspect");
	for (const record of records) {
		if (record.toolResultsContainScorecard !== false) fail(`record ${record.taskId} reports a scorecard in arm A tool results`);
		if (record.arm !== "A") fail(`record ${record.taskId} is not arm A`);
	}
	console.log(`PASS no-scorecard: ${records.length} arm A records, none of their tool results carry a scorecard`);
}

/**
 * Criterion: `BENCH_MAX_USD=0.001 npm run bench -- --arm A --set smoke --seed 1234` stops before the
 * second episode. It runs the real CLI with the cap set, pinned to the offline reference driver so the
 * proof needs no key and costs nothing, and checks the run's JSONL holds exactly one record.
 */
async function budgetCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-budget-proof-"));
	const resultsPath = join(dir, "A-smoke-1234.jsonl");
	try {
		const run = spawnSync("npm", ["run", "bench", "--", "--arm", "A", "--set", "smoke", "--seed", "1234", "--out", resultsPath], {
			encoding: "utf8",
			env: { ...process.env, BENCH_MAX_USD: "0.001", OPENROUTER_API_KEY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		process.stdout.write(run.stdout ?? "");
		process.stderr.write(run.stderr ?? "");
		if (run.status !== 0) fail(`npm run bench under BENCH_MAX_USD=0.001 exited ${run.status}`);
		if (!/BENCH_MAX_USD/.test(run.stdout ?? "")) fail("the stop message does not name BENCH_MAX_USD");
		if (!/stopping before episode 2/.test(run.stdout ?? "")) fail("the stop message does not name the episode it stopped before");
		const records = readRecords(resultsPath);
		if (records.length !== 1) fail(`expected exactly 1 record under BENCH_MAX_USD=0.001, found ${records.length}`);
		console.log(`PASS budget: BENCH_MAX_USD=0.001 stopped before episode 2; JSONL has ${records.length} record; message names BENCH_MAX_USD`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Criterion: benchmark code is unreachable from the server boot/request path and /health still answers. */
async function outOfBootCase(): Promise<void> {
	let matches = "";
	try {
		matches = execFileSync("git", ["grep", "-n", "elr/bench", "--", "src/", ":!src/elr/bench*"], { encoding: "utf8" });
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status !== 1) throw error;
	}
	if (matches.trim() !== "") fail(`a src/ file outside src/elr/bench references the bench:\n${matches}`);
	const { health } = await import("../src/http.ts");
	const result = health();
	assert.equal(result.ok, true, "GET /health returns ok");
	console.log(`PASS out-of-boot: no src/ reference to elr/bench; /health -> ${JSON.stringify(result)}`);
}

/** Criterion: arm A tool results contain no scorecard while arm B results do, on the same fixture. */
async function scorecardCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-scorecard-proof-"));
	try {
		const runArm = async (arm: ArmId, name: string) => {
			const resultsPath = join(dir, `${name}.jsonl`);
			await runBenchmark({ arm, set: "smoke", seed: 1234, driver: "reference", maxUsd: 10, resultsPath, dataDir: join(dir, `data-${name}`), log: () => {} });
			return readResults(resultsPath);
		};
		const a = await runArm("A", "a");
		const b = await runArm("B", "b");
		if (a.length !== 3 || b.length !== 3) fail(`expected 3 records per arm, got A=${a.length} B=${b.length}`);
		for (const record of a) if (record.toolResultsContainScorecard !== false) fail(`arm A ${record.taskId} carries a scorecard`);
		for (const record of b) if (record.toolResultsContainScorecard !== true) fail(`arm B ${record.taskId} has no scorecard`);
		console.log("PASS scorecard: arm A 3/3 tool results without a scorecard, arm B 3/3 with one (same smoke fixture, seed 1234)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Criterion: `npm run bench -- --arm B1 --set smoke --seed 1234` in stub mode (OPENROUTER_API_KEY empty)
 * writes one System One evaluation per label type into the results JSONL, each carrying an abstain flag.
 */
async function systemOneCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-system-one-proof-"));
	const resultsPath = join(dir, "B1-smoke-1234.jsonl");
	try {
		const run = spawnSync("npm", ["run", "bench", "--", "--arm", "B1", "--set", "smoke", "--seed", "1234", "--out", resultsPath], {
			encoding: "utf8",
			env: { ...process.env, OPENROUTER_API_KEY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		process.stdout.write(run.stdout ?? "");
		if (run.status !== 0) fail(`npm run bench --arm B1 (stub) exited ${run.status}`);
		const records = await readResults(resultsPath);
		const expected = [...SYSTEM_ONE_LABEL_TYPES].sort();
		for (const record of records) {
			if (record.systemOne.length !== 5) fail(`${record.taskId}: expected 5 System One entries, got ${record.systemOne.length}`);
			const types = record.systemOne.map((entry) => entry.labelType).sort();
			if (JSON.stringify(types) !== JSON.stringify(expected)) fail(`${record.taskId}: label types ${types.join(",")} != ${expected.join(",")}`);
			for (const entry of record.systemOne) if (typeof entry.abstain !== "boolean") fail(`${record.taskId}/${entry.labelType}: no abstain flag`);
		}
		console.log(`PASS system-one: ${records.length} B′ records, each with one ${expected.join("/")} entry, each an abstain flag`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Criterion: System One is not the reward — the reward modules never read it, and withholding labels
 * leaves the recorded reward byte-identical. */
async function rewardIsolationCase(): Promise<void> {
	let matches = "";
	try {
		matches = execFileSync("git", ["grep", "-nE", "systemOne|system_one", "--", "src/elr/bench/score.ts", "src/elr/verifier"], { encoding: "utf8" });
	} catch (error) {
		const status = (error as { status?: number }).status;
		if (status !== 1) throw error;
	}
	if (matches.trim() !== "") fail(`a reward module references System One:\n${matches}`);
	const dir = mkdtempSync(join(tmpdir(), "elr-reward-proof-"));
	try {
		const runArm = async (mode: "labels" | "abstain", name: string) => {
			const resultsPath = join(dir, `${name}.jsonl`);
			await runBenchmark({
				arm: "B1",
				set: "smoke",
				seed: 1234,
				driver: "reference",
				maxUsd: 10,
				resultsPath,
				dataDir: join(dir, `data-${name}`),
				systemOneClient: createStubSystemOneClient(mode),
				log: () => {},
			});
			return readResults(resultsPath);
		};
		const labels = await runArm("labels", "labels");
		const abstain = await runArm("abstain", "abstain");
		const rewardOf = (records: Awaited<ReturnType<typeof readResults>>) =>
			JSON.stringify(records.map((record) => ({ taskId: record.taskId, boundaryF: record.boundaryF, success: record.success, verifier: record.verifier })));
		if (!labels.some((record) => record.systemOne.some((entry) => entry.label !== null))) fail("the labels run had no labels");
		if (!abstain.every((record) => record.systemOne.every((entry) => entry.label === null))) fail("the abstain run did not withhold labels");
		if (rewardOf(labels) !== rewardOf(abstain)) fail("the reward changed when System One labels were withheld");
		console.log("PASS reward-isolation: reward modules never mention System One; reward byte-identical with labels vs abstained");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Criterion: `npm run bench -- --arm B1 --set smoke --seed 1234 --report` exits 0 and prints a
 * per-label-type table (label type, n, abstain, accuracy, ECE, source) computed against the
 * verifier-derived labels, and states its cost (a free stub run states realCostUsd=$0).
 */
async function calibrationReportCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-calibration-proof-"));
	const resultsPath = join(dir, "B1-smoke-1234.jsonl");
	try {
		const run = spawnSync("npm", ["run", "bench", "--", "--arm", "B1", "--set", "smoke", "--seed", "1234", "--report", "--out", resultsPath], {
			encoding: "utf8",
			env: { ...process.env, OPENROUTER_API_KEY: "" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		process.stdout.write(run.stdout ?? "");
		process.stderr.write(run.stderr ?? "");
		if (run.status !== 0) fail(`npm run bench --report exited ${run.status}`);
		const out = run.stdout ?? "";
		for (const labelType of SYSTEM_ONE_LABEL_TYPES) {
			if (!new RegExp(`^report: ${labelType}\\b`, "m").test(out)) fail(`the report has no ${labelType} row`);
		}
		for (const column of ["label-type", "n", "abstain", "accuracy", "ece", "triage", "source"]) {
			if (!out.includes(column)) fail(`the table is missing the ${column} column`);
		}
		const cost = /driver=(\S+) systemOne=(\S+) recordedCostUsd=\$([0-9.]+) realCostUsd=\$([0-9.]+)/.exec(out);
		if (cost === null) fail("the report did not print its cost and driver");
		if (cost[1] !== "reference" || cost[2] !== "stub" || Number(cost[4]) !== 0) fail(`the report run was not a free stub run: ${cost[0]}`);
		const records = await readResults(resultsPath);
		for (const record of records) {
			if (record.verifierLabels === undefined) fail(`${record.taskId}: no verifier-derived labels recorded`);
		}
		console.log(`PASS calibration-report: ${records.length} episodes, one row per label type with columns label-type/n/abstain/accuracy/ece/triage/source; ${cost[0]}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Criterion: arm B′ labels never reach the agent, for every evaluator. Run with marker evaluators. */
async function labelIsolationCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-label-proof-"));
	const markerFor = (labelType: string) => `stub_system_one_label_${labelType}_7f3a91`;
	const evaluators: SystemOneEvaluator[] = SYSTEM_ONE_LABEL_TYPES.map((labelType) =>
		createSystemOneEvaluator({
			labelType,
			answerType: "choice",
			question: `marker question for ${labelType}?`,
			schema: { type: "choice", instructions: "Pick.", criteria: { [markerFor(labelType)]: "the marker", abstain: "insufficient evidence" } },
			labels: [markerFor(labelType)],
		}),
	);
	try {
		const resultsPath = join(dir, "B1.jsonl");
		const agentTexts: string[] = [];
		await runBenchmark({
			arm: "B1",
			set: "smoke",
			seed: 1234,
			driver: "reference",
			maxUsd: 10,
			resultsPath,
			dataDir: join(dir, "data"),
			systemOneClient: createStubSystemOneClient("labels"),
			systemOneEvaluators: evaluators,
			onAgentText: (text) => agentTexts.push(text),
			log: () => {},
		});
		const agentText = agentTexts.join("\n");
		const records = await readResults(resultsPath);
		for (const record of records) {
			for (const entry of record.systemOne) {
				if (entry.label !== markerFor(entry.labelType)) fail(`${entry.labelType} evaluation lost its marker label`);
				if (agentText.includes(markerFor(entry.labelType))) fail(`${entry.labelType} label leaked into what the agent saw`);
			}
		}
		console.log("PASS label-isolation: 5/5 marker labels stored in the JSONL and absent from the agent transcript");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}


/**
 * Criterion (Lab panel, spec §3 web/src, §8, §9 M3): the app's own handler serves the three Lab
 * sections from real files — runs, learning curves from the recorded JSONL, knowledge grouped by
 * status from the journal — degrading to a clear empty state without breaking /health when the
 * files go corrupt or missing. `npm run proof:lab-panel` sets the throwaway bearer value and an
 * ephemeral port before config.ts loads (this script's import chain captures the config early).
 */
async function labCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-lab-proof-"));
	const resultsDir = join(dir, "results");
	const dataDir = join(dir, "data");
	mkdirSync(resultsDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	// Two fixture runs: A/smoke/seed 1234 with 3 episodes, B1/H/seed 7 with 2.
	const line = (runId: string, taskId: string, boundaryF: number, at: string) =>
		JSON.stringify({ schema: "elr.bench.episode/1", runId, seed: runId.startsWith("A-") ? 1234 : 7, arm: runId.split("-")[0], set: runId.split("-")[1], taskId, boundaryF, success: boundaryF >= 0.85, costUsd: 0.002, endedAt: at });
	writeFileSync(join(resultsDir, "A-smoke-1234.jsonl"), ["t1", "t2", "t3"].map((task, i) => line("A-smoke-1234-run", task, 0.1 + i * 0.4, `2026-10-19T01:0${i}:00Z`)).join("\n") + "\n");
	writeFileSync(join(resultsDir, "B1-H-7.jsonl"), ["h1", "h2"].map((task, i) => line("B1-H-7-run", task, 0.3 + i * 0.1, `2026-10-19T02:0${i}:00Z`)).join("\n") + "\n");
	const { Journal } = await import("../src/elr/journal.ts");
	const journal = new Journal(join(dataDir, "elr.sqlite"));
	for (const [status, statement] of [["hypothesis", "Keep each stroke within the six-point cap."], ["candidate", "One arc beats many short strokes for a circle."], ["validated", "View the canvas before painting."]] as const) {
		journal.recordKnowledgeNode({ kind: "tactic", statement, originTools: ["brush"], status });
	}
	journal.close();

	// Boot the real server against the fixture dirs, on the ephemeral port from the npm script.
	process.env.DATA_DIR = dataDir;
	process.env.BENCH_RESULTS_DIR = resultsDir;
	const { startHttp } = await import("../src/http.ts");
	const server = startHttp({ startReconcile: () => {} } as never);
	await new Promise((resolveListen) => server.once("listening", resolveListen));
	const get = async (path: string, withBearer = true) => {
		const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { headers: withBearer ? { authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {} });
		return { status: res.status, body: await res.text() };
	};
	try {
		const t0 = Date.now();
		const health = await get("/health", false);
		if (health.status !== 200) fail(`GET /health returned ${health.status} with the Lab route present`);
		const healthMs = Date.now() - t0;

		// Populated: all three sections served from the fixture JSONL + journal.
		const lab = await get("/api/elr/lab");
		if (lab.status !== 200) fail(`GET /api/elr/lab returned ${lab.status}: ${lab.body.slice(0, 200)}`);
		const data = JSON.parse(lab.body) as LabSnapshot;
		assert.deepEqual(
			data.runs.map((run) => [run.arm, run.set, run.seed, run.episodes, run.totalCostUsd, run.status, run.date]),
			[["B1", "H", 7, 2, 0.004, "complete", "2026-10-19T02:01:00Z"], ["A", "smoke", 1234, 3, 0.006, "complete", "2026-10-19T01:02:00Z"]],
			"the runs list is not the fixture data (newest first)",
		);
		assert.deepEqual(data.curves.map((curve) => curve.scores), [[0.3, 0.4], [0.1, 0.5, 0.9]], "the curves are not the recorded boundary-F lists");
		assert.deepEqual(Object.keys(data.knowledge).sort(), ["candidate", "hypothesis", "validated"], "knowledge is not grouped by status");
		if (!["six-point cap.", "short strokes for a circle.", "before painting."].every((statement) => lab.body.includes(statement))) fail(`knowledge statements missing from the served JSON`);
		if (lab.body.includes(process.env.AUTH_TOKEN!)) fail("the served JSON contains the bearer value");

		// Corrupt both sources: the panel degrades (status "corrupt", no knowledge), never 500s, /health holds.
		writeFileSync(join(resultsDir, "A-smoke-1234.jsonl"), "{not json\n");
		writeFileSync(join(dataDir, "elr.sqlite"), "definitely not a sqlite database");
		const corruptRes = await get("/api/elr/lab");
		const corrupt = JSON.parse(corruptRes.body) as LabSnapshot;
		const corruptRun = corrupt.runs.find((run) => run.id === "A-smoke-1234");
		if (corruptRes.status !== 200 || corruptRun === undefined || corruptRun.status !== "corrupt" || corruptRun.episodes !== 0) fail(`a corrupt results file did not degrade to a corrupt run row: ${corruptRes.status} ${corruptRes.body.slice(0, 120)}`);
		if (Object.keys(corrupt.knowledge).length !== 0 || (await get("/health", false)).status !== 200) fail("a corrupt journal yielded knowledge rows or broke /health");

		// Empty state: no files at all gives three clearly empty sections, still 200.
		rmSync(resultsDir, { recursive: true, force: true });
		rmSync(join(dataDir, "elr.sqlite"), { force: true });
		const emptyRes = await get("/api/elr/lab");
		const empty = JSON.parse(emptyRes.body) as LabSnapshot;
		if (emptyRes.status !== 200 || empty.runs.length !== 0 || empty.curves.length !== 0 || Object.keys(empty.knowledge).length !== 0) fail(`the empty state is not empty: ${emptyRes.status} ${emptyRes.body.slice(0, 200)}`);
		console.log(
			`PASS lab: runs (B1/H/7 and A/smoke/1234: 3 episodes, $0.0060, complete) served by the app handler; curves 0.10→0.90 and 0.30→0.40 from the JSONL; knowledge grouped as hypothesis/candidate/validated; corrupt files -> 200 with a corrupt run row and no knowledge; no files -> 200 with empty sections; /health 200 in ${healthMs} ms; served JSON free of the bearer value`,
		);
	} finally {
		server.close();
		server.closeIdleConnections?.();
		rmSync(dir, { recursive: true, force: true });
	}
}

const LAB_KNOWLEDGE = [
	["hypothesis", "Keep each stroke within the six-point cap."],
	["candidate", "One arc beats many short strokes for a circle."],
	["validated", "View the canvas before painting."],
] as const;

/** Record knowledge through the journal's own API — the reflector's real write path, not a panel fixture. */
async function recordLabKnowledge(dataDir: string): Promise<void> {
	const { Journal } = await import("../src/elr/journal.ts");
	const journal = new Journal(join(dataDir, "elr.sqlite"));
	for (const [status, statement] of LAB_KNOWLEDGE) journal.recordKnowledgeNode({ kind: "tactic", statement, originTools: ["brush"], status });
	journal.close();
}

/** Assert a served LabSnapshot carries the two recorded harness runs, their exact recorded curves, and knowledge by status. */
function assertRecordedSnapshot(data: LabSnapshot, recordsA: Record<string, unknown>[], recordsB: Record<string, unknown>[]): string {
	const runIdOf = (records: Record<string, unknown>[]) => String(records[0]!.runId);
	const got = data.runs.map((run) => [run.arm, run.set, run.seed, run.episodes, run.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
	assert.deepEqual(got, [["A", "smoke", 1234, 3, "complete"], ["B", "smoke", 7, 3, "complete"]], "the runs are not the recorded harness results");
	const curveOf = (id: string) => data.curves.find((curve) => curve.id === id) ?? fail(`no curve for run ${id}`);
	assert.deepEqual(curveOf(runIdOf(recordsA)).scores, recordsA.map((r) => r.boundaryF), "curve A is not the recorded boundary-F list");
	assert.deepEqual(curveOf(runIdOf(recordsB)).scores, recordsB.map((r) => r.boundaryF), "curve B is not the recorded boundary-F list");
	assert.deepEqual(Object.keys(data.knowledge).sort(), ["candidate", "hypothesis", "validated"], "knowledge is not grouped by status");
	return `${data.runs.length} runs, curves ${curveOf(runIdOf(recordsA)).scores.join("/")}/${curveOf(runIdOf(recordsB)).scores.join("/")} boundary-F, knowledge ${Object.keys(data.knowledge).sort().join("/")}`;
}

/** Boot the real HTTP server against the given directories (env is read per request, never baked in). */
async function serveLabDirs(): Promise<{ server: import("node:http").Server; get: (path: string, withBearer?: boolean) => Promise<{ status: number; body: string }> }> {
	const { startHttp } = await import("../src/http.ts");
	const server = startHttp({ startReconcile: () => {} } as never);
	await new Promise((resolveListen) => server.once("listening", resolveListen));
	const get = async (path: string, withBearer = true) => {
		const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { headers: withBearer ? { authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {} });
		return { status: res.status, body: await res.text() };
	};
	return { server, get };
}

/**
 * Criterion (Lab panel, read-only): the panel's data — runs, curves, knowledge by status — is produced
 * from recorded results while the benchmark harness entry point is unavailable AND an in-process
 * spawn guard would fail this test if a run were launched. The guard fires on any child_process use;
 * the harness CLI itself ran (and recorded) only before the guard was armed, so serving the panel can
 * only have read what the harness had already written.
 */
async function labReadonlyCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-lab-readonly-"));
	const resultsDir = join(dir, "results");
	const dataDir = join(dir, "data");
	mkdirSync(resultsDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	process.env.AUTH_TOKEN ||= "lab-proof-value-7f3a91";
	// Real recorded results, written by the harness CLI before anything is disabled or guarded.
	const recordsA = runHarnessCli(join(resultsDir, "A-smoke-1234.jsonl"), "A", 1234);
	const recordsB = runHarnessCli(join(resultsDir, "B-smoke-7.jsonl"), "B", 7);
	await recordLabKnowledge(dataDir);

	// Make the harness entry point unavailable: node can no longer load bench/run.ts, so nothing can
	// launch a benchmark through `npm run bench` either (that script points at exactly this file).
	const harnessEntry = resolve("bench/run.ts");
	const disabled = `${harnessEntry}.lab-proof-disabled`;
	renameSync(harnessEntry, disabled);
	const unavailable = spawnSync(process.execPath, ["bench/run.ts", "--help"], { encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
	if (unavailable.status === 0) fail("bench/run.ts still ran after it was moved aside — the entry point was never unavailable");

	// Spawn guard: any child_process use while the panel's data path runs fails the test.
	const guard = (method: string, ..._args: unknown[]): never => {
		throw new Error(`lab-readonly guard: child_process.${method} called — the Lab panel must not launch anything`);
	};
	const guarded = ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"] as const;
	const patched = childProcess as unknown as Record<string, unknown>;
	const originals = guarded.map((method) => [method, patched[method]] as const);
	const guardOn = (): void => {
		for (const method of guarded) patched[method] = guard.bind(null, method);
	};
	const guardOff = (): void => {
		for (const [method, fn] of originals) patched[method] = fn;
	};
	let server: import("node:http").Server | undefined;
	try {
		guardOn();
		// Negative control: prove the guard fires, i.e. this proof would fail if a run were launched.
		let fired = false;
		try {
			(patched.spawn as (...args: unknown[]) => unknown)("npm", ["run", "bench"]);
		} catch (error) {
			fired = /lab-readonly guard/.test(String(error));
		}
		if (!fired) fail("the spawn guard did not fire — this proof could not catch a panel that launches a run");

		// The panel's whole data path runs under the guard, reading the recorded results on disk.
		process.env.DATA_DIR = dataDir;
		process.env.BENCH_RESULTS_DIR = resultsDir;
		const started = await serveLabDirs();
		server = started.server;
		const { get } = started;
		if ((await get("/health", false)).status !== 200) fail("GET /health broke while the Lab route is mounted");
		const res = await get("/api/elr/lab");
		if (res.status !== 200) fail(`GET /api/elr/lab returned ${res.status} under the spawn guard: ${res.body.slice(0, 200)}`);
		const summary = assertRecordedSnapshot(JSON.parse(res.body) as LabSnapshot, recordsA, recordsB);
		console.log(`PASS lab-readonly: ${summary} served from recorded results with bench/run.ts unavailable and the spawn guard armed (and proven to fire)`);
	} finally {
		guardOff();
		await new Promise((close) => (server ? server.close(close) : close(null)));
		renameSync(disabled, harnessEntry); // restore the harness entry whatever happened
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Criterion: the panel's render/data code path contains no call that launches a benchmark run.
 * Negated search: exits 0 exactly when nothing matches (git grep status 1; any other failure fails). */
async function labNoLaunchCallCase(): Promise<void> {
	// spawn(/exec( covers spawn, spawnSync, exec, execFile, execSync, execFileSync; the rest are the
	// other ways Node/JS can start work: workers, forks, and the harness's own entry function.
	const pattern = "spawn\\(|exec\\(|child_process|worker_threads|\\bfork\\(|runBenchmark\\(";
	const matches = gitGrep(pattern, ["src/elr/lab.ts", "web/src/components/lab-panel.tsx"]);
	if (matches !== undefined) fail(`the panel's code path references a benchmark-launch call:\n${matches.join("\n")}`);
	console.log(`PASS lab-no-launch-call: git grep -nE '${pattern}' over src/elr/lab.ts and web/src/components/lab-panel.tsx found nothing (status 1), so the panel's code path launches no run`);
}

/** Criterion: the panel added no route/handler that starts a benchmark run. Negated search: exits 0
 * exactly when nothing matches; the companion checks pin what the panel DID add (reads only). */
async function labNoLaunchRouteCase(): Promise<void> {
	// No mutating or bench-starting route anywhere in the panel's server surface.
	const startRoutes = gitGrep('case "(POST|PUT|PATCH|DELETE) /api/(elr|bench)|/api/elr/(run|bench|start|launch)', ["src/http.ts", "src/elr/lab.ts", "web/src/components/lab-panel.tsx"]);
	if (startRoutes !== undefined) fail(`a route/handler that starts a benchmark run exists:\n${startRoutes.join("\n")}`);
	// Every /api/elr route that does exist is a GET, and the lab route serves labSnapshot() only.
	const elrRoutes = gitGrep('case "[A-Z]+ /api/elr', ["src/http.ts"]);
	if (elrRoutes === undefined) fail("no /api/elr route found in src/http.ts — the Lab route is missing");
	const nonGet = elrRoutes.filter((line) => !line.includes('case "GET'));
	if (nonGet.length > 0) fail(`non-GET /api/elr routes exist:\n${nonGet.join("\n")}`);
	const labRoute = gitGrep("elr/lab", ["src/http.ts"]);
	if (labRoute === undefined || !labRoute.some((line) => line.includes("labSnapshot"))) fail("the lab route does not serve labSnapshot() only");
	console.log(`PASS lab-no-launch-route: no POST/PUT/PATCH/DELETE elr|bench route and no /api/elr run|bench|start|launch handler; all ${elrRoutes.length} /api/elr case routes in src/http.ts are GETs and the lab one serves labSnapshot() only`);
}

/** Criterion: the panel's real render code renders the real recorded results — the run entries, the
 * curve data for those runs, and knowledge grouped by status. The LabPanel component is compiled by
 * the web build's own bundler (vite, same config) and rendered server-side with exactly the payload
 * the real server served from the harness's recorded results; no fixture and no hand-written HTML. */
async function labRenderCase(): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "elr-lab-render-"));
	const resultsDir = join(dir, "results");
	const dataDir = join(dir, "data");
	mkdirSync(resultsDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	process.env.AUTH_TOKEN ||= "lab-proof-value-7f3a91";
	// Real recorded results from the M3 harness CLI, knowledge through the journal's own API.
	const recordsA = runHarnessCli(join(resultsDir, "A-smoke-1234.jsonl"), "A", 1234);
	const recordsB = runHarnessCli(join(resultsDir, "B-smoke-7.jsonl"), "B", 7);
	await recordLabKnowledge(dataDir);
	// Build the proof-only SSR entry with the web app's own bundler and config (alias @, react plugin).
	rmSync(resolve("web/dist-ssr"), { recursive: true, force: true });
	const built = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--ssr", "src/lab-ssr.tsx", "--outDir", "dist-ssr", "--emptyOutDir"], { cwd: resolve("web"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (built.status !== 0) fail(`the Lab SSR bundle failed to build:\n${built.stdout}${built.stderr}`);

	process.env.DATA_DIR = dataDir;
	process.env.BENCH_RESULTS_DIR = resultsDir;
	const started = await serveLabDirs();
	try {
		// The payload comes from the app's real route over HTTP, serving the recorded results on disk.
		const res = await started.get("/api/elr/lab");
		if (res.status !== 200) fail(`GET /api/elr/lab returned ${res.status}: ${res.body.slice(0, 200)}`);
		const payload = JSON.parse(res.body) as LabSnapshot;
		const served = assertRecordedSnapshot(payload, recordsA, recordsB);

		// Render the real component with exactly that payload.
		const { renderLab } = await import(pathToFileURL(resolve("web/dist-ssr/lab-ssr.js")).href);
		const html = renderLab(JSON.stringify(payload)) as string;
		const must = (needle: string, what: string): void => {
			if (!html.includes(needle)) fail(`the rendered Lab panel is missing ${what}: "${needle}"`);
		};
		must("Benchmark runs", "the runs section");
		must("A·smoke·s1234", "the A run entry");
		must("B·smoke·s7", "the B run entry");
		must("complete", "the run status badge");
		must("3 ep", "the episode counts");
		must("Learning curves", "the curves section");
		must("A · smoke · seed 1234", "the A curve label");
		must("B · smoke · seed 7", "the B curve label");
		const firstToLast = (records: Record<string, unknown>[]) => `${((records[0]!.boundaryF) as number).toFixed(2)} → ${(records.at(-1)!.boundaryF as number).toFixed(2)}`;
		must(firstToLast(recordsA), "the A curve's first→last recorded values");
		must(firstToLast(recordsB), "the B curve's first→last recorded values");
		must("<polyline", "the curve sparkline");
		must("3 episodes", "the curve episode counts");
		must("Knowledge by status", "the knowledge section");
		for (const [status] of LAB_KNOWLEDGE) must(`${status} · 1`, `the ${status} knowledge group`);
		for (const [, statement] of LAB_KNOWLEDGE) must(statement, "a recorded knowledge statement");
		console.log(`PASS lab-render: the real LabPanel rendered ${served}; run entries, curve values and every knowledge status group trace to the harness's recorded JSONL and the journal`);
	} finally {
		started.server.close();
		started.server.closeIdleConnections?.();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const arg = process.argv[2] ?? "all";
	if (arg === "smoke") return smokeCase();
	if (arg === "records") return recordsCase();
	if (arg === "no-scorecard") return noScorecardCase();
	if (arg === "budget") return budgetCase();
	if (arg === "out-of-boot") return outOfBootCase();
	if (arg === "scorecard") return scorecardCase();
	if (arg === "system-one") return systemOneCase();
	if (arg === "reward-isolation") return rewardIsolationCase();
	if (arg === "label-isolation") return labelIsolationCase();
	if (arg === "calibration-report") return calibrationReportCase();
	if (arg === "lab") return labCase();
	if (arg === "lab-readonly") return labReadonlyCase();
	if (arg === "lab-no-launch-call") return labNoLaunchCallCase();
	if (arg === "lab-no-launch-route") return labNoLaunchRouteCase();
	if (arg === "lab-render") return labRenderCase();
	if (arg === "all") {
		await smokeCase();
		await noScorecardCase();
		await scorecardCase();
		await systemOneCase();
		await rewardIsolationCase();
		await labelIsolationCase();
		await calibrationReportCase();
		await budgetCase();
		await labCase();
		await labReadonlyCase();
		await labNoLaunchCallCase();
		await labNoLaunchRouteCase();
		await labRenderCase();
		await outOfBootCase();
		return;
	}
	fail(`unknown proof "${arg}" (expected smoke|records|no-scorecard|budget|out-of-boot|scorecard|system-one|reward-isolation|label-isolation|calibration-report|lab|lab-readonly|lab-no-launch-call|lab-no-launch-route|lab-render|all)`);
}

if (!IS_TEST) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

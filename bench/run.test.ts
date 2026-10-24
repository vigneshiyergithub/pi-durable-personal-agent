// ELR M3 benchmark tests (spec docs/elr-canvas-spec.md §9 M3). Run with `node --test bench/run.test.ts`.
// They use the offline reference driver, so they need no credentials and cost nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildTaskSet } from "./tasks/generators.ts";
import { runBenchmark } from "./runner.ts";
import { armExtensions, containsScorecard } from "../src/elr/bench/arm.ts";
import { decideEpisodeStart } from "../src/elr/bench/budget.ts";
import { createStubSystemOneClient, STUB_SYSTEM_ONE_COST_USD, type StubSystemOneMode } from "../src/elr/bench/system-one-run.ts";
import { createSystemOneEvaluator, SYSTEM_ONE_LABEL_TYPES, type SystemOneClient, type SystemOneEvaluator } from "../src/elr/system-one.ts";
import { type ArmId } from "../src/elr/bench/types.ts";
import { readResults } from "../src/elr/bench/results.ts";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

async function referenceRun(resultsPath: string, dataDir: string, arm: ArmId = "A", extra: Partial<Parameters<typeof runBenchmark>[0]> = {}) {
	return runBenchmark({ arm, set: "smoke", seed: 1234, driver: "reference", maxUsd: 10, resultsPath, dataDir, log: () => {}, ...extra });
}

test("the smoke set is exactly 3 tasks", () => {
	assert.equal(buildTaskSet("smoke", 1234).tasks.length, 3);
});

test("containsScorecard detects a scorecard and ignores a plain result", () => {
	assert.equal(containsScorecard("stroke recorded (seq=1, ops=1)"), false);
	assert.equal(containsScorecard("scorecard: boundaryF=0.7"), true);
});

test("arm A gives exactly the canvas tools and no scorecard tool", () => {
	const names = armExtensions("A").flatMap((extension) => (extension.tools ?? []).map((tool) => (tool as { name: string }).name));
	assert.deepEqual([...names].sort(), ["done", "paint", "reset_canvas", "view_canvas"]);
});

test("arm B gives the same canvas tools as A (the scorecard is tool-result text, not a tool)", () => {
	const names = armExtensions("B").flatMap((extension) => (extension.tools ?? []).map((tool) => (tool as { name: string }).name));
	assert.deepEqual([...names].sort(), ["done", "paint", "reset_canvas", "view_canvas"]);
});

test("arm A tool results contain no micro scorecard while arm B results do (same fixture)", async () => {
	const dir = tempDir("elr-bench-scorecard-");
	try {
		const aPath = join(dir, "A.jsonl");
		const bPath = join(dir, "B.jsonl");
		await referenceRun(aPath, join(dir, "data-a"), "A");
		await referenceRun(bPath, join(dir, "data-b"), "B");
		const aRecords = await readResults(aPath);
		const bRecords = await readResults(bPath);
		assert.equal(aRecords.length, 3);
		assert.equal(bRecords.length, 3);
		assert.deepEqual(aRecords.map((r) => r.taskId), bRecords.map((r) => r.taskId), "same fixture, same task ids");
		for (const record of aRecords) assert.equal(record.toolResultsContainScorecard, false, `arm A ${record.taskId} carried a scorecard`);
		for (const record of bRecords) assert.equal(record.toolResultsContainScorecard, true, `arm B ${record.taskId} carried no scorecard`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("arm B′ writes one System One evaluation per label type, each with an abstain flag", async () => {
	const dir = tempDir("elr-bench-b1-");
	try {
		const resultsPath = join(dir, "results.jsonl");
		await referenceRun(resultsPath, join(dir, "data"), "B1", { systemOneClient: createStubSystemOneClient("labels") });
		const records = await readResults(resultsPath);
		assert.equal(records.length, 3);
		for (const record of records) {
			assert.equal(record.systemOne.length, 5, `${record.taskId} must record all five label types`);
			assert.deepEqual(record.systemOne.map((entry) => entry.labelType).sort(), [...SYSTEM_ONE_LABEL_TYPES].sort());
			for (const entry of record.systemOne) {
				assert.equal(typeof entry.abstain, "boolean", `${record.taskId}/${entry.labelType} must carry an abstain flag`);
				assert.equal(entry.abstain, false, `${record.taskId}/${entry.labelType} stub labelled a value`);
				assert.ok(entry.label !== null, `${record.taskId}/${entry.labelType} must carry a label`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("arm B′ System One cost is counted in the episode costUsd", async () => {
	const dir = tempDir("elr-bench-b1-cost-");
	try {
		const resultsPath = join(dir, "results.jsonl");
		await referenceRun(resultsPath, join(dir, "data"), "B1", { systemOneClient: createStubSystemOneClient("labels") });
		const records = await readResults(resultsPath);
		const expected = 5 * STUB_SYSTEM_ONE_COST_USD;
		for (const record of records) {
			assert.ok(Math.abs(record.costUsd - expected) < 1e-12, `${record.taskId} costUsd ${record.costUsd} != System One cost ${expected}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("arm B′ labels are absent from everything the agent sees, for every evaluator", async () => {
	const dir = tempDir("elr-bench-isolation-");
	const markerFor = (labelType: string) => `stub_system_one_label_${labelType}_7f3a91`;
	// One marker evaluator per label type; the stub answers the first label it sees, so the marker is
	// carried as the label. If those labels reached the transcript, this would catch it.
	const markerEvaluators: SystemOneEvaluator[] = SYSTEM_ONE_LABEL_TYPES.map((labelType) =>
		createSystemOneEvaluator({
			labelType,
			answerType: "choice",
			question: `marker question for ${labelType}?`,
			schema: { type: "choice", instructions: "Pick.", criteria: { [markerFor(labelType)]: "the marker", abstain: "insufficient evidence" } },
			labels: [markerFor(labelType)],
		}),
	);
	try {
		const resultsPath = join(dir, "results.jsonl");
		const agentTexts: string[] = [];
		await referenceRun(resultsPath, join(dir, "data"), "B1", {
			systemOneClient: createStubSystemOneClient("labels"),
			systemOneEvaluators: markerEvaluators,
			onAgentText: (text: string) => agentTexts.push(text),
		});
		const records = await readResults(resultsPath);
		const agentText = agentTexts.join("\n");
		assert.ok(agentText.length > 0, "the agent transcript was captured");
		for (const record of records) {
			for (const entry of record.systemOne) {
				const marker = markerFor(entry.labelType);
				assert.equal(entry.label, marker, `${entry.labelType} evaluation must carry the marker label`);
				assert.ok(!agentText.includes(marker), `${entry.labelType} label leaked into what the agent saw`);
			}
		}
		assert.equal(records[0]!.systemOne.length, 5);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the verifier outcome is byte-identical across arms A, B and B′ when every System One label abstains", async () => {
	const dir = tempDir("elr-bench-abstain-");
	try {
		const runArm = async (arm: ArmId) => {
			const resultsPath = join(dir, `${arm}.jsonl`);
			await referenceRun(resultsPath, join(dir, `data-${arm}`), arm, { systemOneClient: createStubSystemOneClient("abstain") });
			return readResults(resultsPath);
		};
		const [a, b, b1] = await Promise.all([runArm("A"), runArm("B"), runArm("B1")]);
		const byTask = (records: Awaited<ReturnType<typeof readResults>>) =>
			new Map(records.map((record) => [record.taskId, JSON.stringify({ verifier: record.verifier, boundaryF: record.boundaryF, success: record.success })]));
		const aMap = byTask(a);
		const bMap = byTask(b);
		const b1Map = byTask(b1);
		assert.equal(aMap.size, 3);
		for (const [taskId, outcome] of aMap) {
			assert.equal(bMap.get(taskId), outcome, `${taskId}: B differs from A`);
			assert.equal(b1Map.get(taskId), outcome, `${taskId}: B′ differs from A`);
		}
		// And the B′ labels really were abstentions (the run exercised the abstain path).
		for (const record of b1) for (const entry of record.systemOne) assert.equal(entry.abstain, true, `${entry.labelType} should have abstained`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("System One is not the reward: withholding or flipping labels leaves the reward unchanged", async () => {
	const dir = tempDir("elr-bench-not-reward-");
	try {
		const labelsRun = join(dir, "labels.jsonl");
		const abstainRun = join(dir, "abstain.jsonl");
		await referenceRun(labelsRun, join(dir, "data-labels"), "B1", { systemOneClient: createStubSystemOneClient("labels") });
		await referenceRun(abstainRun, join(dir, "data-abstain"), "B1", { systemOneClient: createStubSystemOneClient("abstain") });
		const labels = await readResults(labelsRun);
		const abstain = await readResults(abstainRun);
		const reward = (records: Awaited<ReturnType<typeof readResults>>) =>
			new Map(records.map((record) => [record.taskId, JSON.stringify({ boundaryF: record.boundaryF, success: record.success, verifier: record.verifier })]));
		const labelled = reward(labels);
		const withheld = reward(abstain);
		assert.ok(labels.some((record) => record.systemOne.some((entry) => entry.label !== null)), "the labels run really had labels");
		assert.ok(abstain.every((record) => record.systemOne.every((entry) => entry.label === null)), "the abstain run really withheld labels");
		for (const [taskId, value] of labelled) assert.equal(withheld.get(taskId), value, `${taskId}: reward moved when labels were withheld`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("arm A tool results contain no scorecard (reference episode)", async () => {
	const dir = tempDir("elr-bench-test-");
	try {
		const resultsPath = join(dir, "results.jsonl");
		const dataDir = join(dir, "data");
		await referenceRun(resultsPath, dataDir);
		const records = await readResults(resultsPath);
		assert.equal(records.length, 3);
		for (const record of records) {
			assert.equal(record.arm, "A");
			assert.equal(record.toolResultsContainScorecard, false, `${record.taskId}: arm A tool result carried a scorecard`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a reference run writes 3 records with every required field non-null", async () => {
	const dir = tempDir("elr-bench-test-");
	try {
		const resultsPath = join(dir, "results.jsonl");
		await referenceRun(resultsPath, join(dir, "data"));
		const records = await readResults(resultsPath);
		assert.equal(records.length, 3);
		for (const record of records) {
			for (const field of ["seed", "arm", "set", "taskId", "boundaryF", "calls", "strokes", "costUsd", "model", "providerFingerprint"] as const) {
				assert.notEqual(record[field], null, `${record.taskId}.${field} is null`);
				assert.notEqual(record[field], undefined, `${record.taskId}.${field} is undefined`);
			}
			assert.equal(typeof record.boundaryF, "number");
			assert.equal(typeof record.calls, "number");
			assert.equal(typeof record.strokes, "number");
			assert.equal(typeof record.costUsd, "number");
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("BENCH_MAX_USD stops the run before the second episode and says so", async () => {
	const dir = tempDir("elr-bench-test-");
	try {
		const resultsPath = join(dir, "results.jsonl");
		const lines: string[] = [];
		const summary = await runBenchmark({
			arm: "A",
			set: "smoke",
			seed: 1234,
			driver: "reference",
			maxUsd: 0.001,
			resultsPath,
			dataDir: join(dir, "data"),
			log: (line) => lines.push(line),
		});
		assert.equal(summary.completed, 1, "exactly one episode runs under a tiny cap");
		assert.equal(summary.stopped, true);
		assert.match(summary.stoppedReason ?? "", /before episode 2/);
		assert.ok(lines.some((line) => /BENCH_MAX_USD/.test(line)), "the stop is announced in the output");
		assert.equal((await readResults(resultsPath)).length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("decideEpisodeStart: below cap starts, at/over cap stops (offline, no money)", () => {
	assert.equal(decideEpisodeStart(0, 1, 0.002).start, true, "a fresh run may start");
	assert.equal(decideEpisodeStart(0.5, 1, 0.1).start, true, "spent below cap with room for the estimate may start");
	const atCap = decideEpisodeStart(1, 1, 0.002);
	assert.equal(atCap.start, false, "spent at the cap must stop");
	assert.match(atCap.reason, /BENCH_MAX_USD=\$1\b/, "the stop names BENCH_MAX_USD");
	assert.match(atCap.reason, /spent \$1\.000000/, "the stop names the amount spent");
	assert.equal(decideEpisodeStart(2, 1, 0).start, false, "spent over the cap must stop");
	const reserve = decideEpisodeStart(0, 0.001, 0.002);
	assert.equal(reserve.start, false, "the reserve stops a run that is under the cap but cannot afford another episode");
	assert.match(reserve.reason, /BENCH_MAX_USD=\$0\.001\b/, "the reserve stop names BENCH_MAX_USD");
});

test("BENCH_MAX_USD and MAX_SPEND_USD are independent", async () => {
	const prior = process.env.MAX_SPEND_USD;
	const dir = tempDir("elr-bench-budget-");
	try {
		// A tiny MAX_SPEND_USD must not cap the bench run, and the bench must not rewrite it.
		process.env.MAX_SPEND_USD = "0";
		assert.equal(decideEpisodeStart(0, 10, 0.002).start, true, "the budget function ignores MAX_SPEND_USD");
		const resultsPath = join(dir, "wide.jsonl");
		const wide = await runBenchmark({ arm: "A", set: "smoke", seed: 1234, driver: "reference", maxUsd: 10, resultsPath, dataDir: join(dir, "data-wide"), log: () => {} });
		assert.equal(wide.completed, 3, "MAX_SPEND_USD=0 must not cap a bench run with a $10 BENCH_MAX_USD");
		assert.equal(process.env.MAX_SPEND_USD, "0", "the bench run must not mutate MAX_SPEND_USD");
		// The bench cap lives in its own code path and never reads MAX_SPEND_USD bookkeeping (comments may
		// name the variable, so strip comments before checking for a real reference).
		for (const file of ["bench/run.ts", "bench/runner.ts", "src/elr/bench/budget.ts"]) {
			const code = readFileSync(resolve(file), "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/\/\/.*$/gm, "");
			assert.doesNotMatch(code, /MAX_SPEND_USD/, `${file} must not reference MAX_SPEND_USD in code`);
		}
	} finally {
		if (prior === undefined) delete process.env.MAX_SPEND_USD;
		else process.env.MAX_SPEND_USD = prior;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the CLI rejects an unknown arm and an unknown set with a clear message", () => {
	const run = (args: string[]) => {
		try {
			execFileSync(process.execPath, [resolve("bench/run.ts"), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			return { code: 0, stderr: "" };
		} catch (error) {
			const failure = error as { status: number; stderr: string };
			return { code: failure.status, stderr: failure.stderr };
		}
	};
	const badArm = run(["--arm", "Z", "--set", "smoke"]);
	assert.equal(badArm.code, 1);
	assert.match(badArm.stderr, /unknown arm "Z"/);
	assert.doesNotMatch(badArm.stderr, /\n\s+at /, "no stack trace for a bad arm");
	const badSet = run(["--arm", "A", "--set", "nope"]);
	assert.equal(badSet.code, 1);
	assert.match(badSet.stderr, /unknown set "nope"/);
	assert.doesNotMatch(badSet.stderr, /\n\s+at /, "no stack trace for a bad set");
});

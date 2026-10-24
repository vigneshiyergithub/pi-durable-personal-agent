// ELR benchmark task-generator proofs and tests (spec §7, §8, §9 M2). Run directly for the
// re-runnable proofs, under `node --test` for the unit tests. Each proof case exits 0 exactly when
// its criterion holds, non-zero otherwise. No network, no credentials, no native image dependency.
//
//   node bench/tasks/checks.ts determinism|seed|sets|targets|quirks|disjoint|heldout|sizes|all
//   node --test bench/tasks/checks.ts

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { opsToCoverage } from "../../src/elr/raster.ts";
import { checkElements, createBoundaryScorer, maskFromCoverage } from "../../src/elr/verifier/index.ts";
import { HELDOUT_FAMILIES, NAMED_CONFIGS, PEN_NO_QUIRKS, PEN_QUIRKS, SET_IDS, buildTaskSet, configHash, type SetId } from "./generators.ts";

type Case = "determinism" | "seed" | "sets" | "targets" | "quirks" | "disjoint" | "heldout" | "sizes" | "all";
const CASES: readonly Case[] = ["determinism", "seed", "sets", "targets", "quirks", "disjoint", "heldout", "sizes", "all"];

const GENERATE = fileURLToPath(new URL("./cli.ts", import.meta.url));
const EXPECTED_COUNTS: Record<SetId, number> = { T: 24, H: 36, X: 36, X0: 6, smoke: 3 };

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function runGenerate(set: SetId, seed: number | string, out: string): void {
	execFileSync(process.execPath, [GENERATE, "--set", set, "--seed", String(seed), "--out", out], { stdio: ["ignore", "ignore", "inherit"] });
}

function printHash(set: SetId, seed: number | string): string {
	return execFileSync(process.execPath, [GENERATE, "--set", set, "--seed", String(seed), "--print-hash"], { encoding: "utf8" }).trim();
}

function listFiles(root: string, prefix = ""): string[] {
	const dir = prefix === "" ? root : join(root, prefix);
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...listFiles(root, rel));
		else out.push(rel);
	}
	return out.sort();
}

function determinismCase(): void {
	for (const set of SET_IDS) {
		const a = mkdtempSync(join(tmpdir(), `elr-tasks-a-${set}-`));
		const b = mkdtempSync(join(tmpdir(), `elr-tasks-b-${set}-`));
		try {
			runGenerate(set, 42, a);
			runGenerate(set, 42, b);
			const filesA = listFiles(a);
			const filesB = listFiles(b);
			assert.deepEqual(filesA, filesB, `${set}: file lists differ`);
			assert.ok(filesA.length > 0, `${set}: generated no files`);
			for (const rel of filesA) {
				const bytesA = readFileSync(join(a, rel));
				const bytesB = readFileSync(join(b, rel));
				if (!bytesA.equals(bytesB)) fail(`${set}: ${rel} differs between two runs with seed 42`);
			}
			const hashA = printHash(set, 42);
			const hashB = printHash(set, 42);
			if (hashA !== hashB) fail(`${set}: printed setHash differs between runs (${hashA} != ${hashB})`);
			const targetCount = filesA.filter((f) => f.endsWith(".png")).length;
			console.log(`determinism ${set}: ${filesA.length} files (${targetCount} targets) byte-identical, setHash=${hashA}`);
		} finally {
			rmSync(a, { recursive: true, force: true });
			rmSync(b, { recursive: true, force: true });
		}
	}
	console.log("PASS determinism: every set is byte-identical across two runs of the same seed");
}

function seedCase(): void {
	for (const set of SET_IDS) {
		const h1 = printHash(set, 1);
		const h2 = printHash(set, 2);
		if (h1 === h2) fail(`${set}: seed 1 and seed 2 produced the same setHash (${h1})`);
		const a = buildTaskSet(set, 1);
		const b = buildTaskSet(set, 2);
		const changed = a.tasks.some((task, i) => task.targetHash !== b.tasks[i]!.targetHash);
		if (!changed) fail(`${set}: no target hash changed between seed 1 and seed 2`);
		console.log(`seed ${set}: setHash seed1=${h1.slice(0, 12)} seed2=${h2.slice(0, 12)} and target hashes differ`);
	}
	console.log("PASS seed: a different seed changes the set hash and the target hashes");
}

function setsCase(): void {
	assert.deepEqual([...SET_IDS].sort(), ["H", "T", "X", "X0", "smoke"], "set identifiers must match spec §9");
	for (const set of SET_IDS) {
		const built = buildTaskSet(set, 0);
		assert.equal(built.tasks.length, EXPECTED_COUNTS[set], `${set}: unexpected task count`);
		for (const task of built.tasks) {
			assert.equal(task.configHash, configHash(task.config), `${task.id}: per-task configHash mismatch`);
			assert.match(task.targetHash, /^[0-9a-f]{64}$/, `${task.id}: targetHash must be a sha256 hex`);
		}
		assert.match(built.manifest.configHash, /^[0-9a-f]{16}$/, `${set}: configHash must be 16 hex chars`);
		console.log(`set ${set}: tool=${built.manifest.tool} tasks=${built.tasks.length} configHash=${built.manifest.configHash} setHash=${built.manifest.setHash.slice(0, 12)}`);
	}
	console.log("PASS sets: T, H, X, X0 and smoke all generate with a configHash");
}

function targetsCase(): void {
	let checked = 0;
	for (const set of SET_IDS) {
		const built = buildTaskSet(set, 3);
		for (const task of built.tasks) {
			const mask = maskFromCoverage(opsToCoverage(task.targetOps, 256), 256, 256);
			const f = createBoundaryScorer(mask).score(mask).boundaryF;
			const result = checkElements(mask, { elements: task.elements, totalInkBudget: task.totalInkBudget });
			if (!(f >= 0.999)) fail(`${task.id}: target scored ${f} against itself`);
			if (!result.passed) {
				const failing = result.elements.filter((e) => !e.passed).map((e) => e.element);
				fail(`${task.id}: target fails its own element checks (${failing.join(", ") || "totalInk"})`);
			}
			checked++;
		}
	}
	console.log(`PASS targets: ${checked} targets verify against their own boundary-F and element checks`);
}

function quirksCase(): void {
	const brush = NAMED_CONFIGS.find((c) => c.name === "brush-quirks")!;
	const penQuirks = NAMED_CONFIGS.find((c) => c.name === "pen-quirks")!;
	const penNone = NAMED_CONFIGS.find((c) => c.name === "pen-no-quirks")!;

	// Spec §3 brush quirks: 6 points per stroke, Chaikin smoothing, 10 strokes.
	assert.equal(brush.config.tool, "brush");
	assert.deepEqual(Object.keys(brush.config).sort(), ["chaikinIterations", "maxPointsPerStroke", "maxStrokes", "tool"]);
	assert.equal(brush.config.maxPointsPerStroke, 6);
	assert.equal(brush.config.chaikinIterations, 1);
	assert.equal(brush.config.maxStrokes, 10);

	// Spec §3 pen quirks: y axis up, degrees vs radians, arc direction.
	assert.equal(penQuirks.config.tool, "pen");
	assert.deepEqual(Object.keys(penQuirks.config).sort(), ["angleUnit", "arcDirection", "tool", "yAxisUp"]);
	assert.equal(penQuirks.config.yAxisUp, true);
	assert.equal(penQuirks.config.angleUnit, "degrees");
	assert.equal(penQuirks.config.arcDirection, "clockwise");
	assert.equal(penNone.config.tool, "pen");
	assert.deepEqual(penNone.quirks, []);

	// A changed field changes the hash.
	assert.notEqual(configHash({ ...brush.config, maxPointsPerStroke: 7 }), brush.configHash);
	assert.notEqual(configHash({ ...brush.config, maxStrokes: 9 }), brush.configHash);
	assert.notEqual(configHash({ ...penQuirks.config, angleUnit: "radians" }), penQuirks.configHash);
	assert.notEqual(penQuirks.configHash, penNone.configHash);

	// Rule: configHash ignores property insertion order (canonical key order).
	const reordered = { arcDirection: "clockwise", angleUnit: "degrees", yAxisUp: true, tool: "pen" } as const;
	assert.equal(configHash({ ...reordered }), configHash(PEN_QUIRKS));
	assert.equal(configHash({ ...PEN_NO_QUIRKS }), penNone.configHash);

	console.log(`quirks brush=${brush.configHash} pen=${penQuirks.configHash} pen-no-quirks=${penNone.configHash}`);
	console.log("PASS quirks: configs match spec §3 and configHash tracks field changes");
}

/** Distinct family names used by a generated set, from the tasks themselves (not source constants). */
function familyNames(set: SetId, seed: number | string): string[] {
	return [...new Set(buildTaskSet(set, seed).tasks.map((task) => task.family))].sort();
}

function disjointCase(): void {
	const trainFamilies = familyNames("T", 42);
	const heldoutFamilies = familyNames("H", 42);
	const shared = trainFamilies.filter((name) => heldoutFamilies.includes(name));
	console.log(`T families (${trainFamilies.length}): ${trainFamilies.join(", ")}`);
	console.log(`H families (${heldoutFamilies.length}): ${heldoutFamilies.join(", ")}`);
	console.log(`intersection: ${shared.length ? shared.join(", ") : "(empty)"}`);
	for (const heldout of HELDOUT_FAMILIES) if (!heldoutFamilies.includes(heldout.name)) fail(`H is missing held-out family "${heldout.name}"`);
	if (shared.length) fail(`T and H share family/families: ${shared.join(", ")}`);
	console.log(`PASS disjoint: T trains on ${trainFamilies.length} families; H uses all ${HELDOUT_FAMILIES.length} held-out families; intersection empty`);
}

function heldoutCase(): void {
	const heldout = new Set(HELDOUT_FAMILIES.map((builder) => builder.name));
	const out = mkdtempSync(join(tmpdir(), "elr-heldout-"));
	try {
		runGenerate("T", 42, out);
		const manifest = JSON.parse(readFileSync(join(out, "T", "manifest.json"), "utf8")) as { tasks: { family: string }[] };
		const manifestFamilies = [...new Set(manifest.tasks.map((task) => task.family))].sort();
		const inManifest = manifestFamilies.filter((name) => heldout.has(name));

		const taskDir = join(out, "T", "tasks");
		const inTaskFiles: string[] = [];
		for (const file of readdirSync(taskDir).sort()) {
			const record = JSON.parse(readFileSync(join(taskDir, file), "utf8")) as { family: string };
			if (heldout.has(record.family)) inTaskFiles.push(`${file}:${record.family}`);
		}
		console.log(`held-out families: ${[...heldout].sort().join(", ")}`);
		console.log(`T generated families from manifest (${manifestFamilies.length}): ${manifestFamilies.join(", ")}`);
		console.log(`held-out names in T manifest: ${inManifest.length ? inManifest.join(", ") : "(none)"}`);
		console.log(`held-out names in T task files: ${inTaskFiles.length ? inTaskFiles.join(", ") : "(none)"}`);
		if (inManifest.length) fail(`T manifest contains held-out family/families: ${inManifest.join(", ")}`);
		if (inTaskFiles.length) fail(`T task records contain held-out family/families: ${inTaskFiles.join(", ")}`);
		console.log("PASS heldout: no held-out family name appears in T's generated manifest or task files");
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
}

function sizesCase(): void {
	const t = buildTaskSet("T", 42);
	const h = buildTaskSet("H", 42);
	if (t.tasks.length !== 24) fail(`T has ${t.tasks.length} tasks, expected 24`);
	if (h.tasks.length !== 36) fail(`H has ${h.tasks.length} tasks, expected 36`);
	const replicates = h.manifest.replicates;
	if (replicates !== 3) fail(`H replicate count is ${replicates}, expected 3`);
	const baseTasks = new Set<number>();
	const perBase = new Map<number, number>();
	for (const task of h.manifest.tasks) {
		const base = Math.floor(task.index / replicates);
		baseTasks.add(base);
		perBase.set(base, (perBase.get(base) ?? 0) + 1);
	}
	if (baseTasks.size !== 12) fail(`H has ${baseTasks.size} base tasks, expected 12`);
	if ([...perBase.values()].some((count) => count !== replicates)) fail(`H base tasks are not each replicated ${replicates} times`);
	const tPrimitives = t.tasks.filter((task) => task.index < 12).length;
	console.log(`sizes T: tasks=${t.tasks.length} (${tPrimitives} primitives + ${t.tasks.length - tPrimitives} compositions)`);
	console.log(`sizes H: ${baseTasks.size} base tasks x ${replicates} replicates = ${h.tasks.length} ("12 x 3 seeds")`);
	console.log("PASS sizes: T=24, H=36 (12 base tasks x 3 replicates, manifest-backed)");
}

function main(): void {
	const arg = (process.argv[2] ?? "all") as Case;
	if (!CASES.includes(arg)) fail(`unknown case "${arg}" (expected ${CASES.join("|")})`);
	if (arg === "determinism" || arg === "all") determinismCase();
	if (arg === "seed" || arg === "all") seedCase();
	if (arg === "sets" || arg === "all") setsCase();
	if (arg === "targets" || arg === "all") targetsCase();
	if (arg === "quirks" || arg === "all") quirksCase();
	if (arg === "disjoint" || arg === "all") disjointCase();
	if (arg === "heldout" || arg === "all") heldoutCase();
	if (arg === "sizes" || arg === "all") sizesCase();
	const cases = arg === "all" ? CASES.filter((c) => c !== "all") : [arg];
	console.log(`PASS (${arg}): ${cases.length} case(s) held (${cases.join(", ")})`);
}

// ── Unit tests (spec §9 M2) ──────────────────────────────────────────────────────────────────────

const SEEDED_SETS: readonly SetId[] = ["T", "H", "X", "X0", "smoke"];

function registerTests(): void {
	test("set identifiers are exactly the spec's T, H, X, X0 and smoke", () => {
		assert.deepEqual([...SET_IDS].sort(), ["H", "T", "X", "X0", "smoke"]);
	});

	test("the same seed gives byte-identical targets and set hashes", () => {
		for (const set of SEEDED_SETS) {
			const a = buildTaskSet(set, 1234);
			const b = buildTaskSet(set, 1234);
			assert.equal(a.manifest.setHash, b.manifest.setHash, `${set}: setHash differs`);
			assert.equal(a.tasks.length, b.tasks.length, `${set}: task count differs`);
			for (let i = 0; i < a.tasks.length; i++) {
				assert.equal(a.tasks[i]!.targetHash, b.tasks[i]!.targetHash, `${set}: task ${i} target differs`);
				assert.ok(Buffer.from(a.tasks[i]!.targetPng).equals(Buffer.from(b.tasks[i]!.targetPng)), `${set}: task ${i} PNG bytes differ`);
			}
		}
	});

	test("a different seed gives a different set hash and target", () => {
		for (const set of SEEDED_SETS) {
			const a = buildTaskSet(set, 1);
			const b = buildTaskSet(set, 2);
			assert.notEqual(a.manifest.setHash, b.manifest.setHash, `${set}: setHash collided across seeds`);
			assert.ok(a.tasks.some((task, i) => task.targetHash !== b.tasks[i]!.targetHash), `${set}: no target changed`);
		}
	});

	test("each task carries the configHash of its quirk config", () => {
		for (const set of SEEDED_SETS) {
			const built = buildTaskSet(set, 0);
			for (const task of built.tasks) assert.equal(task.configHash, configHash(task.config), `${task.id}: configHash mismatch`);
			assert.equal(built.manifest.configHash, configHash(built.plan.config));
		}
	});

	test("brush and pen configs match the spec's quirk list", () => {
		const brush = NAMED_CONFIGS.find((c) => c.name === "brush-quirks")!;
		assert.equal(brush.config.tool, "brush");
		assert.deepEqual(Object.keys(brush.config).sort(), ["chaikinIterations", "maxPointsPerStroke", "maxStrokes", "tool"]);
		if (brush.config.tool !== "brush") throw new Error("brush config must be a brush config");
		assert.equal(brush.config.maxPointsPerStroke, 6);
		assert.equal(brush.config.maxStrokes, 10);
		const pen = NAMED_CONFIGS.find((c) => c.name === "pen-quirks")!;
		assert.equal(pen.config.tool, "pen");
		assert.deepEqual(Object.keys(pen.config).sort(), ["angleUnit", "arcDirection", "tool", "yAxisUp"]);
		assert.notEqual(pen.configHash, NAMED_CONFIGS.find((c) => c.name === "pen-no-quirks")!.configHash);
	});

	test("configHash is canonical and changes when a field changes", () => {
		const reordered = { arcDirection: "clockwise", angleUnit: "degrees", yAxisUp: true, tool: "pen" } as const;
		assert.equal(configHash({ ...reordered }), configHash(PEN_QUIRKS));
		assert.notEqual(configHash({ ...PEN_QUIRKS, yAxisUp: false }), configHash(PEN_QUIRKS));
		assert.notEqual(configHash({ ...PEN_NO_QUIRKS, angleUnit: "degrees" }), configHash(PEN_NO_QUIRKS));
	});

	function familyNames(set: SetId): Set<string> {
		return new Set(buildTaskSet(set, 42).tasks.map((task) => task.family));
	}

	test("T and H use disjoint family-name sets (spec §7 held-out)", () => {
		const train = familyNames("T");
		const heldout = familyNames("H");
		for (const heldoutName of HELDOUT_FAMILIES) assert.ok(heldout.has(heldoutName.name), `H must use held-out family ${heldoutName.name}`);
		for (const name of heldout) assert.ok(!train.has(name), `T must not train on held-out family ${name}`);
	});

	test("no held-out family appears anywhere in T's generated manifest", () => {
		const heldout = new Set(HELDOUT_FAMILIES.map((builder) => builder.name));
		for (const task of buildTaskSet("T", 42).manifest.tasks) assert.ok(!heldout.has(task.family), `T manifest contains held-out family ${task.family}`);
	});

	test("T is 24 tasks and H is 36 (12 base tasks x 3 replicates)", () => {
		const t = buildTaskSet("T", 42);
		const h = buildTaskSet("H", 42);
		assert.equal(t.tasks.length, 24);
		assert.equal(h.tasks.length, 36);
		assert.equal(h.manifest.replicates, 3);
		assert.equal(new Set(h.manifest.tasks.map((task) => Math.floor(task.index / h.manifest.replicates))).size, 12);
	});
}

if (process.env.NODE_TEST_CONTEXT !== undefined) registerTests();
else main();

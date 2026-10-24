// ELR verifier proofs and tests (spec §2 D4, §8, §9 M2). Run directly for the re-runnable proofs,
// under `node --test` for the unit tests. Every proof case exits 0 exactly when its criterion holds.
//
//   node bench/verifier/checks.ts fixtures     # Bézier circle + 8 strokes >= 0.9; fat ring + all-inked < 0.5; blank == 0
//   node bench/verifier/checks.ts good|hack|blank
//   node bench/verifier/checks.ts elements     # closure, connected components, ink budgets, determinism
//   node bench/verifier/checks.ts closure|components|budget|determinism|emit
//   node bench/verifier/checks.ts perf         # rasterisation + score p95 < 20 ms at 256² (spec §8)
//   node bench/verifier/checks.ts all
//   ELR_TEST_GROUP=distance node --test bench/verifier/checks.ts   # EDT vs brute force
//   ELR_TEST_GROUP=elements node --test bench/verifier/checks.ts   # element-check unit tests
//
// No network, no credentials, no native image dependency, no model in the loop.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { encodePng, opsToCoverage, type Op } from "../../src/elr/raster.ts";
import {
	angularCoverage,
	checkElements,
	countComponents,
	createBoundaryScorer,
	maskFromCoverage,
	squaredDistanceTransform,
	type BinaryMask,
	type BoundaryFResult,
	type ElementChecksResult,
} from "../../src/elr/verifier/index.ts";
import {
	allInked,
	allInkedOps,
	bezierCircle,
	bezierCircleOps,
	blank,
	blankOps,
	CLOSURE_SPEC,
	closedContour,
	compliantRing,
	eightStrokes,
	eightStrokesOps,
	fatRing,
	fatRingOps,
	INK_BUDGET_SPEC,
	ONE_COMPONENT_SPEC,
	oneDisc,
	openContour,
	overInkedRing,
	SIZE,
	targetCircle,
	TWO_COMPONENT_SPEC,
	twoDisjointDiscs,
} from "./fixtures.ts";

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

// ── Scorer fixtures (spec §9 M2) ────────────────────────────────────────────────────────────────

function reportFixture(name: string, result: BoundaryFResult, verdict: string): void {
	console.log(
		`${name}: boundaryF=${result.boundaryF.toFixed(4)} precision=${result.precision.toFixed(4)} ` +
			`recall=${result.recall.toFixed(4)} (predicted=${result.predictedPixels}, targetOutline=${result.targetBoundaryPixels}) -> ${verdict}`,
	);
}

function fixturesCases(which: "good" | "hack" | "blank" | "all"): void {
	const scorer = createBoundaryScorer(targetCircle());
	if (which === "good" || which === "all") {
		for (const [name, mask] of [
			["bezier-circle", bezierCircle()],
			["eight-strokes", eightStrokes()],
		] as const) {
			const result = scorer.score(mask);
			reportFixture(name, result, result.boundaryF >= 0.9 ? ">= 0.9 OK" : "< 0.9 FAIL");
			if (!(result.boundaryF >= 0.9)) fail(`${name} scored ${result.boundaryF}, expected >= 0.9`);
		}
	}
	if (which === "hack" || which === "all") {
		for (const [name, mask] of [
			["fat-ring-40px", fatRing()],
			["all-inked", allInked()],
		] as const) {
			const result = scorer.score(mask);
			reportFixture(name, result, result.boundaryF < 0.5 ? "< 0.5 OK" : ">= 0.5 FAIL");
			if (!(result.boundaryF < 0.5)) fail(`${name} scored ${result.boundaryF}, expected < 0.5`);
		}
	}
	if (which === "blank" || which === "all") {
		const result = scorer.score(blank());
		reportFixture("blank", result, result.boundaryF === 0 ? "== 0 OK" : "!= 0 FAIL");
		if (result.boundaryF !== 0) fail(`blank canvas scored ${result.boundaryF}, expected exactly 0`);
	}
}

// ── Element checks (spec §2 D4, §9 M2) ──────────────────────────────────────────────────────────

function fmt(value: number | null): string {
	return value === null ? "n/a" : value.toString();
}

function describe(result: ElementChecksResult): string {
	return result.elements
		.map((e) => {
			const parts: string[] = [];
			if (e.closure) parts.push(`closure=${e.closure.measured.toFixed(3)}/${e.closure.threshold}${e.closure.passed ? " ok" : " FAIL"}`);
			if (e.connectedComponents)
				parts.push(`components=${e.connectedComponents.measured}/${e.connectedComponents.threshold}${e.connectedComponents.passed ? " ok" : " FAIL"}`);
			if (e.inkBudget) parts.push(`ink=${e.inkBudget.measured}/${e.inkBudget.threshold}${e.inkBudget.passed ? " ok" : " FAIL"}`);
			return `${e.element}[${parts.join(" ")}]`;
		})
		.join(" ");
}

function closureCase(): void {
	const open = checkElements(openContour(), CLOSURE_SPEC);
	const closed = checkElements(closedContour(), CLOSURE_SPEC);
	console.log(`open-contour:   ${describe(open)} -> ${open.passed ? "pass" : "flagged"}`);
	console.log(`closed-contour: ${describe(closed)} -> ${closed.passed ? "pass" : "flagged"}`);

	const openCheck = open.elements[0]?.closure;
	const closedCheck = closed.elements[0]?.closure;
	if (!openCheck || !closedCheck) fail("closure checks were not configured");
	if (openCheck.passed) fail(`open contour was not flagged (coverage ${openCheck.measured} >= ${openCheck.threshold})`);
	if (open.passed) fail("open contour overall result should fail");
	if (!closedCheck.passed) fail(`closed contour was flagged (coverage ${closedCheck.measured} < ${closedCheck.threshold})`);
	if (!closed.passed) fail("closed contour overall result should pass");
}

function componentsCase(): void {
	const one = checkElements(oneDisc(), ONE_COMPONENT_SPEC);
	const twoExpected = checkElements(twoDisjointDiscs(), TWO_COMPONENT_SPEC);
	const twoWrong = checkElements(twoDisjointDiscs(), ONE_COMPONENT_SPEC);
	console.log(`one-disc (want 1):       ${describe(one)} -> ${one.passed ? "pass" : "flagged"}`);
	console.log(`two-discs (want 2):      ${describe(twoExpected)} -> ${twoExpected.passed ? "pass" : "flagged"}`);
	console.log(`two-discs (want 1):      ${describe(twoWrong)} -> ${twoWrong.passed ? "pass" : "flagged"}`);

	const oneCount = one.elements[0]?.connectedComponents?.measured;
	const twoCount = twoExpected.elements[0]?.connectedComponents?.measured;
	if (oneCount !== 1) fail(`one-disc component count was ${fmt(oneCount ?? null)}, expected 1`);
	if (twoCount !== 2) fail(`two-disc component count was ${fmt(twoCount ?? null)}, expected 2`);
	if (!one.passed || !twoExpected.passed) fail("satisfied component counts should pass");
	if (twoWrong.passed) fail("a 2-component drawing against an expected 1 should be flagged");
}

function budgetCase(): void {
	const over = checkElements(overInkedRing(), INK_BUDGET_SPEC);
	const ok = checkElements(compliantRing(), INK_BUDGET_SPEC);
	console.log(`over-inked: ${describe(over)} -> ${over.passed ? "pass" : "flagged"}`);
	console.log(`compliant:  ${describe(ok)} -> ${ok.passed ? "pass" : "flagged"}`);

	const overCheck = over.elements[0]?.inkBudget;
	const okCheck = ok.elements[0]?.inkBudget;
	if (!overCheck || !okCheck) fail("ink budget checks were not configured");
	if (overCheck.passed) fail(`over-inked element was not flagged (ink ${overCheck.measured} <= ${overCheck.threshold})`);
	if (!(overCheck.measured > overCheck.threshold)) fail(`measured ${overCheck.measured} should exceed threshold ${overCheck.threshold}`);
	if (over.passed) fail("over-inked element overall result should fail");
	if (!okCheck.passed) fail(`compliant element was flagged (ink ${okCheck.measured} > ${okCheck.threshold})`);
	if (!ok.passed) fail("compliant element overall result should pass");
}

function emit(): string {
	return JSON.stringify({
		closureOpen: checkElements(openContour(), CLOSURE_SPEC),
		closureClosed: checkElements(closedContour(), CLOSURE_SPEC),
		componentsOne: checkElements(oneDisc(), ONE_COMPONENT_SPEC),
		componentsTwo: checkElements(twoDisjointDiscs(), TWO_COMPONENT_SPEC),
		componentsWrong: checkElements(twoDisjointDiscs(), ONE_COMPONENT_SPEC),
		budgetOver: checkElements(overInkedRing(), INK_BUDGET_SPEC),
		budgetOk: checkElements(compliantRing(), INK_BUDGET_SPEC),
	});
}

function determinismCase(): void {
	const self = fileURLToPath(import.meta.url);
	const run = (): string => execFileSync(process.execPath, [self, "emit"], { encoding: "utf8" }).trim();
	const a = run();
	const b = run();
	const summary = emit();
	console.log(`run 1: ${a.slice(0, 96)}...`);
	console.log(`run 2: ${b.slice(0, 96)}...`);
	if (a.length === 0) fail("emit produced no output");
	if (a !== b) fail("two runs of the same fixtures produced different results");
	if (summary !== a) fail("in-process result differs from a fresh-process result");
}

function elementsCases(which: "closure" | "components" | "budget" | "determinism" | "all" | "emit"): void {
	if (which === "emit") {
		process.stdout.write(`${emit()}\n`);
		return;
	}
	if (which === "closure" || which === "all") closureCase();
	if (which === "components" || which === "all") componentsCase();
	if (which === "budget" || which === "all") budgetCase();
	if (which === "determinism" || which === "all") determinismCase();
}

// ── Performance (spec §8: raster plus score p95 under 20 ms at 256²) ─────────────────────────────

const ITERATIONS = 250;
const WARMUP = 50;
const DEFAULT_P95_BUDGET_MS = 20;

function percentile(sorted: readonly number[], q: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

function stats(times: readonly number[]): { p50: number; p95: number; min: number; max: number } {
	const sorted = [...times].sort((a, b) => a - b);
	return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), min: sorted[0]!, max: sorted[sorted.length - 1]! };
}

function fmtStats(s: { p50: number; p95: number; min: number; max: number }): string {
	return `min=${s.min.toFixed(3)} ms  p50=${s.p50.toFixed(3)} ms  p95=${s.p95.toFixed(3)} ms  max=${s.max.toFixed(3)} ms`;
}

// The gate is non-vacuous, shown by two commands (the negative one is negated so it exits 0 exactly
// when the script rejects, as required for "finds nothing" checks):
//   node bench/verifier/checks.ts perf                          # exit 0 under the budget
//   ! PERF_P95_BUDGET_MS=0 node bench/verifier/checks.ts perf   # exit 0 when the gate rejects
function perfCase(): void {
	const budget = Number(process.env.PERF_P95_BUDGET_MS ?? DEFAULT_P95_BUDGET_MS);
	if (!Number.isFinite(budget) || budget < 0) {
		console.error(`FAIL: PERF_P95_BUDGET_MS must be a finite number >= 0, got ${process.env.PERF_P95_BUDGET_MS}`);
		process.exit(1);
	}

	// Everything here is outside the timed section: target, scorer, and candidate op lists.
	const scorer = createBoundaryScorer(targetCircle());
	const candidateOps: Op[][] = [bezierCircleOps(), eightStrokesOps(), fatRingOps(), allInkedOps(), blankOps()];
	const prebuiltMasks: BinaryMask[] = candidateOps.map((ops) => maskFromCoverage(opsToCoverage(ops, SIZE), SIZE, SIZE));
	const rasterise = (ops: readonly Op[]): BinaryMask => maskFromCoverage(opsToCoverage(ops, SIZE), SIZE, SIZE);

	for (let i = 0; i < WARMUP; i++) {
		const idx = i % candidateOps.length;
		scorer.score(rasterise(candidateOps[idx]!));
		scorer.score(prebuiltMasks[idx]!);
	}

	const combined: number[] = [];
	const rasterOnly: number[] = [];
	const scoreOnly: number[] = [];
	const pngCombined: number[] = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const idx = i % candidateOps.length;
		const ops = candidateOps[idx]!;
		const start = performance.now();
		const coverage = opsToCoverage(ops, SIZE);
		const mask = maskFromCoverage(coverage, SIZE, SIZE);
		const afterRaster = performance.now();
		encodePng(SIZE, SIZE, coverage);
		const afterPng = performance.now();
		scorer.score(mask);
		const end = performance.now();
		combined.push(afterRaster - start + (end - afterPng));
		rasterOnly.push(afterRaster - start);
		scoreOnly.push(end - afterPng);
		pngCombined.push(end - start);
	}

	const scoreOnlyPrebuilt: number[] = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const mask = prebuiltMasks[i % prebuiltMasks.length]!;
		const start = performance.now();
		scorer.score(mask);
		scoreOnlyPrebuilt.push(performance.now() - start);
	}

	const c = stats(combined);
	const r = stats(rasterOnly);
	const s = stats(scoreOnly);
	const p = stats(pngCombined);
	const so = stats(scoreOnlyPrebuilt);

	console.log(`boundary-F raster+score at ${SIZE}x${SIZE}`);
	console.log(`loop: ${ITERATIONS} timed iterations (>= 200), ${WARMUP} warm-up discarded, ${candidateOps.length} pre-built candidate op lists cycled; p50/p95 nearest-rank`);
	console.log(`inside timer: opsToCoverage(ops) -> maskFromCoverage -> scorer.score  (candidate rasterisation INCLUDED; built before timer: target, scorer, op lists, score-only masks)`);
	console.log(`raster+score (GATED): ${fmtStats(c)}`);
	console.log(`  split raster: ${fmtStats(r)}`);
	console.log(`  split score:  ${fmtStats(s)}`);
	console.log(`score only (raster excluded, NOT gated): ${fmtStats(so)}`);
	console.log(`raster(png)+score (display path, NOT gated): ${fmtStats(p)}`);
	console.log(`GATED figure: raster+score p95 = ${c.p95.toFixed(3)} ms against budget ${budget} ms`);

	if (ITERATIONS < 200) {
		console.error(`FAIL: only ${ITERATIONS} iterations, need >= 200`);
		process.exit(1);
	}
	if (!(c.p95 < budget)) {
		console.error(`FAIL: raster+score p95 ${c.p95.toFixed(3)} ms >= ${budget} ms (split: raster ${r.p95.toFixed(3)} ms, score ${s.p95.toFixed(3)} ms)`);
		process.exit(1);
	}
	console.log(`PASS: raster+score p95 ${c.p95.toFixed(3)} ms < ${budget} ms over ${ITERATIONS} iterations`);
}

// ── Dispatch ────────────────────────────────────────────────────────────────────────────────────

const PROOF_CASES = ["good", "hack", "blank", "fixtures", "closure", "components", "budget", "determinism", "emit", "elements", "perf", "all"] as const;
type Case = (typeof PROOF_CASES)[number];

const FIXTURE_CASES = ["good", "hack", "blank"] as const;
const ELEMENT_CASES = ["closure", "components", "budget", "determinism"] as const;

function selectedCases(arg: Case): readonly string[] {
	if (arg === "fixtures") return FIXTURE_CASES;
	if (arg === "elements") return ELEMENT_CASES;
	if (arg === "all") return [...FIXTURE_CASES, ...ELEMENT_CASES, "perf"];
	return [arg];
}

function main(): void {
	const arg = (process.argv[2] ?? "all") as Case;
	if (!PROOF_CASES.includes(arg)) fail(`unknown case "${arg}" (expected ${PROOF_CASES.join("|")})`);

	if (arg === "good" || arg === "hack" || arg === "blank" || arg === "all" || arg === "fixtures")
		fixturesCases(arg === "fixtures" ? "all" : arg);
	if (arg === "closure" || arg === "components" || arg === "budget" || arg === "determinism" || arg === "all" || arg === "elements" || arg === "emit")
		elementsCases(arg === "elements" ? "all" : arg);
	if (arg === "perf" || arg === "all") perfCase();
	if (arg !== "emit") {
		const cases = selectedCases(arg);
		console.log(`PASS (${arg}): ${cases.length} case(s) held (${cases.join(", ")})`);
	}
}

// ── Unit tests (spec §8, §9 M2) ─────────────────────────────────────────────────────────────────

function bruteForce(mask: Uint8Array, width: number, height: number): Float64Array {
	const out = new Float64Array(width * height).fill(Infinity);
	const features: [number, number][] = [];
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) features.push([x, y]);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let best = Infinity;
			for (const [fx, fy] of features) {
				const dx = x - fx;
				const dy = y - fy;
				const d = dx * dx + dy * dy;
				if (d < best) best = d;
			}
			out[y * width + x] = best;
		}
	}
	return out;
}

function checkDistance(mask: Uint8Array, width: number, height: number): void {
	const fast = squaredDistanceTransform(mask, width, height);
	const slow = bruteForce(mask, width, height);
	for (let i = 0; i < fast.length; i++) {
		assert.equal(fast[i], slow[i], `pixel ${i} (${i % width},${Math.floor(i / width)}): ${fast[i]} != ${slow[i]}`);
	}
}

function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

function registerDistanceTests(): void {
	test("matches brute force on structured masks", () => {
		const w = 37;
		const h = 23;
		const single = new Uint8Array(w * h);
		single[5 * w + 10] = 1;
		checkDistance(single, w, h);
		const full = new Uint8Array(w * h).fill(1);
		checkDistance(full, w, h);
		checkDistance(new Uint8Array(w * h), w, h);
		const row = new Uint8Array(w * h);
		for (let x = 0; x < w; x++) row[10 * w + x] = 1;
		checkDistance(row, w, h);
	});

	test("matches brute force on random masks", () => {
		const rand = lcg(0x1234abcd);
		for (let trial = 0; trial < 20; trial++) {
			const w = 1 + Math.floor(rand() * 24);
			const h = 1 + Math.floor(rand() * 24);
			const mask = new Uint8Array(w * h);
			for (let i = 0; i < mask.length; i++) mask[i] = rand() < 0.25 ? 1 : 0;
			checkDistance(mask, w, h);
		}
	});
}

function mask(width: number, height: number, points: readonly [number, number][]): BinaryMask {
	const data = new Uint8Array(width * height);
	for (const [x, y] of points) data[y * width + x] = 1;
	return { width, height, data };
}

function registerElementTests(): void {
	test("countComponents handles empty, one, disjoint and diagonal-touching ink", () => {
		assert.equal(countComponents(mask(10, 10, [])), 0);
		assert.equal(countComponents(mask(10, 10, [[1, 1], [1, 2], [2, 2]])), 1);
		assert.equal(countComponents(mask(10, 10, [[1, 1], [5, 5]])), 2);
		// Two pixels touching only at a corner are one 8-connected component, two 4-connected ones.
		assert.equal(countComponents(mask(10, 10, [[1, 1], [2, 2]]), 8), 1);
		assert.equal(countComponents(mask(10, 10, [[1, 1], [2, 2]]), 4), 2);
	});

	test("angularCoverage is full for a closed contour and partial for an open one", () => {
		const closed = angularCoverage(closedContour(), 128, 128, 80, 8, 72);
		const open = angularCoverage(openContour(), 128, 128, 80, 8, 72);
		assert.ok(closed >= 0.99, `closed coverage ${closed}`);
		assert.ok(open < 0.9, `open coverage ${open}`);
		assert.ok(open > 0.7, `open coverage ${open}`);
	});

	test("closure is flagged on the open contour and not on the closed one", () => {
		const open = checkElements(openContour(), CLOSURE_SPEC);
		const closed = checkElements(closedContour(), CLOSURE_SPEC);
		assert.equal(open.passed, false);
		assert.equal(open.elements[0]?.closure?.passed, false);
		assert.equal(closed.passed, true);
		assert.equal(closed.elements[0]?.closure?.passed, true);
	});

	test("connected-component counts are reported correctly", () => {
		assert.equal(checkElements(oneDisc(), ONE_COMPONENT_SPEC).elements[0]?.connectedComponents?.measured, 1);
		assert.equal(checkElements(twoDisjointDiscs(), TWO_COMPONENT_SPEC).elements[0]?.connectedComponents?.measured, 2);
		const wrong = checkElements(twoDisjointDiscs(), ONE_COMPONENT_SPEC);
		assert.equal(wrong.passed, false);
		assert.equal(wrong.elements[0]?.connectedComponents?.measured, 2);
	});

	test("ink budget fails for over-inked ink and passes for compliant ink", () => {
		const over = checkElements(overInkedRing(), INK_BUDGET_SPEC);
		const ok = checkElements(compliantRing(), INK_BUDGET_SPEC);
		assert.equal(over.passed, false);
		const overBudget = over.elements[0]?.inkBudget;
		assert.ok(overBudget && overBudget.measured > overBudget.threshold);
		assert.equal(ok.passed, true);
		const okBudget = ok.elements[0]?.inkBudget;
		assert.ok(okBudget && okBudget.measured <= okBudget.threshold);
	});

	test("the same fixture yields an identical result across repeated runs", () => {
		const a = JSON.stringify(checkElements(overInkedRing(), INK_BUDGET_SPEC));
		const b = JSON.stringify(checkElements(overInkedRing(), INK_BUDGET_SPEC));
		assert.equal(a, b);
	});
}

if (process.env.NODE_TEST_CONTEXT !== undefined) {
	const group = process.env.ELR_TEST_GROUP ?? "all";
	if (group === "all" || group === "distance") registerDistanceTests();
	if (group === "all" || group === "elements") registerElementTests();
} else {
	main();
}

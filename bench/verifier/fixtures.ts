// Fixtures for the ELR verifier proofs (spec §2 D4, §8, §9 M2; docs/elr-canvas-proposal.md experiment 1).
// Pure JS masks at 256² built with the repo's own rasterizer (src/elr/raster.ts); no native image
// dependency. The reference element is a circle outline at c=(128,128), r=80.

import { opsToCoverage, type Op } from "../../src/elr/raster.ts";
import { maskFromCoverage, type BinaryMask, type ElementSpec, type TaskElementSpec } from "../../src/elr/verifier/index.ts";

export const SIZE = 256;
export const CENTER = 128;
export const RADIUS = 80;
export const RING_CENTER = 128;
export const RING_RADIUS = 80;

function coverageToMask(ops: readonly Op[], size = SIZE): BinaryMask {
	return maskFromCoverage(opsToCoverage(ops, size), size, size);
}

/** The task's target: a thin circle outline. */
export function targetCircle(): BinaryMask {
	return coverageToMask(targetCircleOps());
}

function circleArc(cx: number, cy: number, r: number, width: number): Op[] {
	return [{ kind: "arc", cx, cy, r, a0: 0, a1: 2 * Math.PI, width }];
}

/** The target's op list. Exposed so perf proofs can build candidates before timing. */
export function targetCircleOps(): Op[] {
	return circleArc(SIZE / 2, SIZE / 2, RADIUS, 4);
}

// One cubic Bézier quarter of a circle, sampled into points.
function sampleCubic(
	p0: readonly [number, number],
	p1: readonly [number, number],
	p2: readonly [number, number],
	p3: readonly [number, number],
	steps: number,
): [number, number][] {
	const out: [number, number][] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const u = 1 - t;
		const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
		const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
		out.push([x, y]);
	}
	return out;
}

/** A Bézier circle: the four-cubic approximation of the target circle (kappa = 0.5523), drawn in one stroke. */
export function bezierCircle(): BinaryMask {
	return coverageToMask(bezierCircleOps());
}

/** The Bézier circle's op list. */
export function bezierCircleOps(): Op[] {
	const cx = SIZE / 2;
	const cy = SIZE / 2;
	const r = RADIUS;
	const k = 0.5522847498307936 * r;
	const points: [number, number][] = [];
	const segments: [[number, number], [number, number], [number, number], [number, number]][] = [
		[[cx + r, cy], [cx + r, cy + k], [cx + k, cy + r], [cx, cy + r]],
		[[cx, cy + r], [cx - k, cy + r], [cx - r, cy + k], [cx - r, cy]],
		[[cx - r, cy], [cx - r, cy - k], [cx - k, cy - r], [cx, cy - r]],
		[[cx, cy - r], [cx + k, cy - r], [cx + r, cy - k], [cx + r, cy]],
	];
	for (const segment of segments) {
		const sampled = sampleCubic(segment[0], segment[1], segment[2], segment[3], 16);
		// Drop the first point of later segments: it duplicates the previous segment's last point.
		for (let i = points.length === 0 ? 0 : 1; i < sampled.length; i++) points.push(sampled[i]!);
	}
	return [{ kind: "stroke", points, width: 4 }];
}

/** Eight short brush strokes tracing the target circle, 45 degrees each. */
export function eightStrokes(): BinaryMask {
	return coverageToMask(eightStrokesOps());
}

/** The eight-strokes op list. */
export function eightStrokesOps(): Op[] {
	const ops: Op[] = [];
	const cx = SIZE / 2;
	const cy = SIZE / 2;
	for (let i = 0; i < 8; i++) {
		const a0 = (i * Math.PI) / 4;
		const a1 = ((i + 1) * Math.PI) / 4;
		const points: [number, number][] = [];
		for (let j = 0; j <= 6; j++) {
			const a = a0 + ((a1 - a0) * j) / 6;
			points.push([cx + RADIUS * Math.cos(a), cy + RADIUS * Math.sin(a)]);
		}
		ops.push({ kind: "stroke", points, width: 4 });
	}
	return ops;
}

/** HACK: a 40 px thick ring instead of a thin outline. Over-inks the target. */
export function fatRing(): BinaryMask {
	return coverageToMask(fatRingOps());
}

/** The fat-ring op list. */
export function fatRingOps(): Op[] {
	return circleArc(SIZE / 2, SIZE / 2, RADIUS, 40);
}

/** HACK: ink the whole canvas. */
export function allInked(): BinaryMask {
	return { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE).fill(1) };
}

/** The all-inked op list: a very wide disc, so the perf proof times its rasterisation too (spec §8). */
export function allInkedOps(): Op[] {
	return [{ kind: "stroke", points: [[SIZE / 2, SIZE / 2]], width: SIZE * 4 }];
}

/** A blank canvas: no ink at all. */
export function blank(): BinaryMask {
	return { width: SIZE, height: SIZE, data: new Uint8Array(SIZE * SIZE) };
}

/** A blank canvas's op list: no ops, so rasterisation still runs but produces no ink. */
export function blankOps(): Op[] {
	return [];
}

// ── Element-check fixtures (spec §2 D4, §9 M2) ──────────────────────────────────────────────────

/** A 270-degree arc: 3/4 of the outline, so closure coverage is about 0.75. */
export function openContour(): BinaryMask {
	return coverageToMask([{ kind: "arc", cx: RING_CENTER, cy: RING_CENTER, r: RING_RADIUS, a0: 0, a1: 1.5 * Math.PI, width: 4 }]);
}

/** A closed Bézier circle: the satisfied case for closure. */
export function closedContour(): BinaryMask {
	return bezierCircle();
}

/** A thin, budget-compliant ring (same closed circle). */
export function compliantRing(): BinaryMask {
	return bezierCircle();
}

/** A 40 px fat ring: over-inks the element without opening the outline or adding components. */
export function overInkedRing(): BinaryMask {
	return fatRing();
}

/** One solid disc: a single connected component. */
export function oneDisc(): BinaryMask {
	return coverageToMask([{ kind: "stroke", points: [[RING_CENTER, RING_CENTER]], width: 60 }]);
}

/** Two disjoint solid discs: two connected components, in one wide region. */
export function twoDisjointDiscs(): BinaryMask {
	return coverageToMask([
		{ kind: "stroke", points: [[64, 64]], width: 48 },
		{ kind: "stroke", points: [[192, 192]], width: 48 },
	]);
}

/** The ring element used by the closure and ink-budget fixtures. */
export const RING_ELEMENT: ElementSpec = { name: "ring", cx: RING_CENTER, cy: RING_CENTER, radius: RING_RADIUS, tolerance: 8 };

export const CLOSURE_SPEC: TaskElementSpec = { elements: [{ ...RING_ELEMENT, minClosure: 0.95 }] };

/** A budget of 4000 px: comfortably above a thin 4 px ring, far below the 40 px fat ring. */
export const INK_BUDGET = 4000;

export const INK_BUDGET_SPEC: TaskElementSpec = { elements: [{ ...RING_ELEMENT, inkBudget: INK_BUDGET }] };

/** A whole-canvas region so both discs fall inside one element. */
function wideRegion(components: number): TaskElementSpec {
	return { elements: [{ name: "shapes", cx: RING_CENTER, cy: RING_CENTER, radius: 200, components }] };
}

export const ONE_COMPONENT_SPEC = wideRegion(1);
export const TWO_COMPONENT_SPEC = wideRegion(2);

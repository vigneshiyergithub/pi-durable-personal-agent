// §9 M2 proof: the distance transform is linear-time, shown by a scaling series (it is the evidence
// form chosen: measured ratios, not a structural assertion alone).
//
// squaredDistanceTransform (src/elr/verifier/distance.ts) is the Felzenszwalb-Huttenlocher two-pass
// exact Euclidean distance transform: one 1D lower-envelope pass along every row, then the same along
// every column. Each 1D transform is amortised O(n), so the whole transform is O(width*height) and a
// doubling of the side (4x the pixels) should cost about 4x, never about the 16x a per-pixel O(n^2)
// brute force would give.
//
// This proof measures that. For each square side it builds a ring mask, takes the MEDIAN of several
// repetitions, and prints the median, the nanoseconds per pixel and the ratio against the previous
// size. It exits 0 only when every doubling ratio is below TOLERANCE_MULTIPLE (default 8.0x). A
// quadratic transform (16x per doubling) fails; a linear one passes with wide margin.
//
//   node --max-old-space-size=1024 bench/verifier/scaling.ts
//   ! SCALING_TOLERANCE=2 node --max-old-space-size=1024 bench/verifier/scaling.ts   # negated: rejects
//
// No network, no credentials, no native image dependency, no model in the loop.

import { squaredDistanceTransform } from "../../src/elr/verifier/distance.ts";

const SIDES = [128, 256, 512, 1024];
const REPS = Number(process.env.SCALING_REPS ?? 33);
const WARMUP = Number(process.env.SCALING_WARMUP ?? 5);
// Linear = ~4x per doubling; quadratic brute force = ~16x. Anything below 8x is at most linear-ish.
const TOLERANCE_MULTIPLE = Number(process.env.SCALING_TOLERANCE ?? 8.0);

function ringMask(side: number): Uint8Array {
	const m = new Uint8Array(side * side);
	const c = side / 2;
	const r = side * 0.35;
	for (let y = 0; y < side; y++) {
		for (let x = 0; x < side; x++) {
			const dx = x - c;
			const dy = y - c;
			const d = Math.sqrt(dx * dx + dy * dy);
			m[y * side + x] = Math.abs(d - r) <= 1.5 ? 1 : 0;
		}
	}
	return m;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

function main(): void {
	if (!Number.isFinite(TOLERANCE_MULTIPLE) || TOLERANCE_MULTIPLE <= 0) {
		console.error(`FAIL: SCALING_TOLERANCE must be a finite number > 0, got ${process.env.SCALING_TOLERANCE}`);
		process.exit(1);
	}
	console.log("ELR §9 distance-transform scaling series (ring masks, medians)");
	console.log(`reps=${REPS} warmup=${WARMUP} tolerance=${TOLERANCE_MULTIPLE}x per side-doubling (linear ~4x, quadratic ~16x)`);

	let previous = 0;
	let failed = false;
	for (const side of SIDES) {
		const mask = ringMask(side);
		for (let i = 0; i < WARMUP; i++) squaredDistanceTransform(mask, side, side);
		const times: number[] = [];
		for (let i = 0; i < REPS; i++) {
			const start = performance.now();
			squaredDistanceTransform(mask, side, side);
			times.push(performance.now() - start);
		}
		const med = median(times);
		const ratio = previous === 0 ? NaN : med / previous;
		console.log(
			`${side}x${side}: median=${med.toFixed(3)} ms  ns/px=${((med * 1e6) / (side * side)).toFixed(2)}  ` +
				`ratio=${Number.isNaN(ratio) ? "-" : ratio.toFixed(2) + "x"}`,
		);
		if (previous > 0 && !(ratio < TOLERANCE_MULTIPLE)) failed = true;
		previous = med;
	}

	if (failed) {
		console.error(`FAIL: at least one side-doubling grew by >= ${TOLERANCE_MULTIPLE}x (expected ~4x; quadratic would be ~16x)`);
		process.exit(1);
	}
	console.log(`PASS: every side-doubling (4x pixels) grew by < ${TOLERANCE_MULTIPLE}x, consistent with O(width*height)`);
}

main();

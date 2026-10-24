// Boundary-F scorer: the deterministic, model-free reward of the ELR canvas runtime (spec §2 D4,
// §5). It reproduces docs/elr-canvas-proposal.md experiment 1.
//
// For a target mask and a candidate (predicted) mask:
//   T = boundary pixels of the target ink (its outline)
//   P = inked pixels of the candidate
//   precision = |{p in P : dist(p, T) <= tolerance}| / |P|   ("ink near the target outline")
//   recall    = |{t in T : dist(t, P) <= tolerance}| / |T|   ("target outline covered by ink")
//   F         = 2*P*R / (P + R)
//
// Tolerance is 4 px per spec §2 D4 and §7. Precision collapses when extra ink is added (the fat-ring
// hack) and recall collapses when ink is omitted (the open-arc case), which is what makes boundary-F
// resist the two reward hacks in experiment 1. A blank candidate scores exactly 0.
//
// The target boundary and its distance transform are computed once per scorer, so scoring many
// candidate actions against a fixed target costs a single distance transform each (spec §8: p95
// under 20 ms at 256²).

import { boundaryOf, countSet, type BinaryMask } from "./mask.ts";
import { squaredDistanceTransform } from "./distance.ts";

export const BOUNDARY_TOLERANCE_PX = 4;
/** Spec §7 success rule: boundary-F@4 >= 0.85 and every element check passes. */
export const SUCCESS_BOUNDARY_F = 0.85;

export type BoundaryFResult = {
	/** Harmonic mean of precision and recall, in [0, 1]. */
	boundaryF: number;
	precision: number;
	recall: number;
	tolerancePx: number;
	/** Number of candidate ink pixels. */
	predictedPixels: number;
	/** Number of target outline pixels. */
	targetBoundaryPixels: number;
	matchedPredicted: number;
	matchedTarget: number;
};

export type BoundaryScorerOptions = {
	tolerancePx?: number;
};

export type BoundaryScorer = {
	readonly target: BinaryMask;
	readonly tolerancePx: number;
	readonly targetBoundaryPixels: number;
	score(predicted: BinaryMask): BoundaryFResult;
};

function zeroResult(tolerancePx: number, predictedPixels: number, targetBoundaryPixels: number): BoundaryFResult {
	return {
		boundaryF: 0,
		precision: 0,
		recall: 0,
		tolerancePx,
		predictedPixels,
		targetBoundaryPixels,
		matchedPredicted: 0,
		matchedTarget: 0,
	};
}

export function createBoundaryScorer(target: BinaryMask, options: BoundaryScorerOptions = {}): BoundaryScorer {
	const tolerancePx = options.tolerancePx ?? BOUNDARY_TOLERANCE_PX;
	if (!(tolerancePx >= 0)) throw new Error(`tolerancePx must be >= 0, got ${tolerancePx}`);
	const tol2 = tolerancePx * tolerancePx;

	const targetBoundary = boundaryOf(target);
	const targetBoundaryPixels = countSet(targetBoundary);
	// Distance from any pixel to the nearest target outline pixel: queried at candidate ink pixels.
	const targetOutlineDt = squaredDistanceTransform(targetBoundary, target.width, target.height);

	return {
		target,
		tolerancePx,
		targetBoundaryPixels,
		score(predicted: BinaryMask): BoundaryFResult {
			if (predicted.width !== target.width || predicted.height !== target.height) {
				throw new Error(
					`predicted mask ${predicted.width}x${predicted.height} does not match target ${target.width}x${target.height}`,
				);
			}
			const predictedPixels = countSet(predicted.data);
			if (predictedPixels === 0 || targetBoundaryPixels === 0) {
				return zeroResult(tolerancePx, predictedPixels, targetBoundaryPixels);
			}

			// Distance from any pixel to the nearest candidate ink pixel: queried at target outline pixels.
			const predictedInkDt = squaredDistanceTransform(predicted.data, predicted.width, predicted.height);

			let matchedPredicted = 0;
			const p = predicted.data;
			for (let i = 0; i < p.length; i++) {
				if (p[i] !== 0 && targetOutlineDt[i]! <= tol2) matchedPredicted++;
			}

			let matchedTarget = 0;
			for (let i = 0; i < targetBoundary.length; i++) {
				if (targetBoundary[i] !== 0 && predictedInkDt[i]! <= tol2) matchedTarget++;
			}

			const precision = matchedPredicted / predictedPixels;
			const recall = matchedTarget / targetBoundaryPixels;
			const boundaryF = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
			return {
				boundaryF,
				precision,
				recall,
				tolerancePx,
				predictedPixels,
				targetBoundaryPixels,
				matchedPredicted,
				matchedTarget,
			};
		},
	};
}

/** One-shot convenience: build a scorer for the target and score a single candidate. */
export function boundaryF(predicted: BinaryMask, target: BinaryMask, options: BoundaryScorerOptions = {}): BoundaryFResult {
	return createBoundaryScorer(target, options).score(predicted);
}

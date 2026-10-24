// ELR M3 episode scoring (spec docs/elr-canvas-spec.md §2 D4, §7, §9 M3).
//
// The reward is the M2 deterministic verifier, not a copy of it: boundary-F@4 against the task's
// target mask plus the task's element checks. An episode's canvas is a pure function of its ops, so
// the runner rasterises the final op list and hands it to the same scorer the M2 fixtures use.
import { opsToCoverage, type Op } from "../raster.ts";
import {
	checkElements,
	createBoundaryScorer,
	maskFromCoverage,
	type BinaryMask,
	type BoundaryFResult,
	type ElementChecksResult,
} from "../verifier/index.ts";
import type { Task } from "../../../bench/tasks/generators.ts";

export const CANVAS_SIZE = 256;
/** Spec §7 success rule: boundary-F@4 >= 0.85 and every element check passes. */
export const SUCCESS_BOUNDARY_F = 0.85;

export type EpisodeOutcome = {
	/** boundary-F@4, as the verifier defines it. */
	boundaryF: number;
	precision: number;
	recall: number;
	tolerancePx: number;
	/** boundary-F@4 >= SUCCESS_BOUNDARY_F and every element check passes. */
	success: boolean;
	elements: ElementChecksResult;
};

/** The target's ink mask, derived exactly as the M2 task proofs derive it. */
export function targetMask(task: Pick<Task, "targetOps">): BinaryMask {
	return maskFromCoverage(opsToCoverage(task.targetOps, CANVAS_SIZE), CANVAS_SIZE, CANVAS_SIZE);
}

/** The canvas's ink mask from its ordered op list. */
export function canvasMask(ops: readonly Op[]): BinaryMask {
	return maskFromCoverage(opsToCoverage(ops, CANVAS_SIZE), CANVAS_SIZE, CANVAS_SIZE);
}

/** Score a final canvas op list against a task. Deterministic; no model, no network. */
export function verifyCanvas(task: Pick<Task, "targetOps" | "elements" | "totalInkBudget">, ops: readonly Op[]): EpisodeOutcome {
	const boundary: BoundaryFResult = createBoundaryScorer(targetMask(task)).score(canvasMask(ops));
	const elements = checkElements(canvasMask(ops), { elements: task.elements, totalInkBudget: task.totalInkBudget });
	return {
		boundaryF: boundary.boundaryF,
		precision: boundary.precision,
		recall: boundary.recall,
		tolerancePx: boundary.tolerancePx,
		success: boundary.boundaryF >= SUCCESS_BOUNDARY_F && elements.passed,
		elements,
	};
}

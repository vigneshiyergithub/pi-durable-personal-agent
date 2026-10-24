// ELR M3 micro scorecard (spec docs/elr-canvas-spec.md §5, §7 arm B).
//
// The micro loop is a deterministic scorecard appended to a tool result, every canvas action. It is
// computed from the canvas ops and the task target with the SAME M2 verifier the reward uses, but it
// is only text: it never enters the reward, the budget or any verifier decision. Arm A installs no
// scorecard provider; arms B and B′ install the one this module builds.
//
// The scorecard carries ΔF (the boundary-F change this operation caused), coverage, the stroke count
// and a deterministic error class, which is exactly the micro-loop payload §5 names.
import { opsToCoverage, type Op } from "../raster.ts";
import type { Task } from "../../../bench/tasks/generators.ts";
import { CANVAS_SIZE, verifyCanvas } from "./score.ts";

/** Fraction of the canvas that carries ink, in [0, 1]. Deterministic, dependency-free. */
export function canvasCoverage(ops: readonly Op[]): number {
	const coverage = opsToCoverage(ops, CANVAS_SIZE);
	let inked = 0;
	for (const value of coverage) if (value > 0) inked++;
	return inked / (CANVAS_SIZE * CANVAS_SIZE);
}

/** A deterministic error class from the tool's own validation message (spec §6 error_class labels). */
export function errorClassOf(error: string | undefined): string {
	if (error === undefined || error === "") return "none";
	if (/point|width|stroke|argument|outside|not \[x, y\]|cap reached/i.test(error)) return "arguments";
	return "tool";
}

/** The scorecard text for one action on `task`, from the ops that action left on the canvas. */
export function microScorecardText(task: Task, input: { tool: string; ops: readonly Op[]; error?: string }): string {
	const after = verifyCanvas(task, input.ops);
	let deltaF = 0;
	if (input.tool === "paint" && input.ops.length > 0) {
		deltaF = after.boundaryF - verifyCanvas(task, input.ops.slice(0, -1)).boundaryF;
	}
	return [
		`scorecard: boundaryF=${after.boundaryF.toFixed(4)} deltaF=${deltaF.toFixed(4)}`,
		`coverage=${canvasCoverage(input.ops).toFixed(4)} strokes=${input.ops.length} errorClass=${errorClassOf(input.error)}`,
	].join("\n");
}

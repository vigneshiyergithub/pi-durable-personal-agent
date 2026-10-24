// Element-level checks for the ELR verifier: closure, connected components and ink budgets
// (spec §2 D4, §3, §5, §9 M2). Together with the boundary-F scorer these are the only reward; the
// checks are deterministic, pure JS and have no model or network in the loop (D4, §8).
//
// The spec asks for "element checks (closure, connected components, budgets)" and the proposal
// (docs/elr-canvas-proposal.md, experiment 1) names them: "closure via angular coverage, connected
// components per element, and the stroke and call budget". This module implements the mask-level
// half of that:
//
//   * closure       - angular coverage of ink in the annulus around the element's nominal outline.
//                     An open contour leaves sectors with no ink (a 270 deg arc covers 0.75).
//   * components    - number of 8-connected ink components attributed to the element's region.
//   * ink budget    - inked pixels attributed to the element, and the whole-canvas total, each
//                     compared against a maximum ("over-inked" elements are rejected).
//
// Geometry is expressed per element as a centre and a nominal radius; `tolerance` is the radial
// half-width used both for "on the outline" and for attributing ink to the element. Every check
// carries its measured value and its threshold in the result.

import { countSet, type BinaryMask } from "./mask.ts";
import { countComponents } from "./components.ts";

export const DEFAULT_TOLERANCE_PX = 6;
export const DEFAULT_CLOSURE_SECTORS = 72;
export const DEFAULT_MIN_CLOSURE = 0.95;

/** One required element of a task, in canvas pixel coordinates. */
export type ElementSpec = {
	name: string;
	cx: number;
	cy: number;
	/** Nominal outline radius of the element in px. */
	radius: number;
	/** Radial half-width for on-outline ink and for attributing ink to this element (default 6 px). */
	tolerance?: number;
	/** Expected number of connected ink components in the element region (omit to skip the check). */
	components?: number;
	/** Maximum inked pixels attributed to the element (omit to skip the check). */
	inkBudget?: number;
	/** Minimum angular coverage for the outline to count as closed, in [0, 1] (omit to skip). */
	minClosure?: number;
	/** Number of angular sectors for the closure sweep (default 72, i.e. 5 degrees each). */
	sectors?: number;
};

/** A whole task: its elements plus an optional whole-canvas ink budget. */
export type TaskElementSpec = {
	elements: readonly ElementSpec[];
	totalInkBudget?: number;
};

/** A measured quantity and the threshold it is compared against. */
export type Check = {
	measured: number;
	threshold: number;
	passed: boolean;
};

export type ElementCheckResult = {
	element: string;
	/** Angular coverage (fraction of sectors with outline ink); null when no closure threshold was given. */
	closure: Check | null;
	/** Connected ink components in the element region; null when no expected count was given. */
	connectedComponents: Check | null;
	/** Inked pixels in the element region; null when no budget was given. */
	inkBudget: Check | null;
	passed: boolean;
};

export type ElementChecksResult = {
	passed: boolean;
	elements: ElementCheckResult[];
	/** Whole-canvas inked pixels against `totalInkBudget`; null when no total budget was given. */
	totalInk: Check | null;
};

/**
 * Fraction of `sectors` angular sectors around (cx, cy) that contain ink lying within
 * `tolerance` px of the nominal radius. 1 means the outline is closed; an open contour leaves gaps.
 */
export function angularCoverage(
	mask: BinaryMask,
	cx: number,
	cy: number,
	radius: number,
	tolerance: number,
	sectors: number = DEFAULT_CLOSURE_SECTORS,
): number {
	if (!(sectors > 0) || !Number.isInteger(sectors)) {
		throw new Error(`sectors must be a positive integer, got ${sectors}`);
	}
	const inner = radius - tolerance;
	const outer = radius + tolerance;
	const inner2 = inner * inner;
	const outer2 = outer * outer;
	const covered = new Uint8Array(sectors);
	const { width, height, data } = mask;
	let found = 0;

	for (let y = 0; y < height; y++) {
		const row = y * width;
		const dy = y + 0.5 - cy;
		for (let x = 0; x < width; x++) {
			if (data[row + x] === 0) continue;
			const dx = x + 0.5 - cx;
			const d2 = dx * dx + dy * dy;
			if (d2 < inner2 || d2 > outer2) continue;
			let idx = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * sectors);
			if (idx >= sectors) idx = sectors - 1;
			else if (idx < 0) idx = 0;
			if (covered[idx] === 0) {
				covered[idx] = 1;
				found++;
			}
		}
	}
	return found / sectors;
}

/** Copy of the mask keeping only ink within `radius` px of (cx, cy); used for attribution. */
function regionMask(mask: BinaryMask, cx: number, cy: number, radius: number): BinaryMask {
	const { width, height, data } = mask;
	const out = new Uint8Array(data.length);
	const r2 = radius * radius;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		const dy = y + 0.5 - cy;
		for (let x = 0; x < width; x++) {
			const i = row + x;
			if (data[i] === 0) continue;
			const dx = x + 0.5 - cx;
			if (dx * dx + dy * dy <= r2) out[i] = 1;
		}
	}
	return { width, height, data: out };
}

/**
 * Run every configured element check for a candidate mask against a task spec. A check is skipped
 * when its threshold is absent. The overall result passes only when every configured check passes.
 */
export function checkElements(candidate: BinaryMask, spec: TaskElementSpec): ElementChecksResult {
	const elements: ElementCheckResult[] = [];

	for (const element of spec.elements) {
		const tolerance = element.tolerance ?? DEFAULT_TOLERANCE_PX;
		const region = regionMask(candidate, element.cx, element.cy, element.radius + tolerance);
		let passed = true;

		let closure: Check | null = null;
		if (element.minClosure !== undefined) {
			const sectors = element.sectors ?? DEFAULT_CLOSURE_SECTORS;
			const measured = angularCoverage(candidate, element.cx, element.cy, element.radius, tolerance, sectors);
			const ok = measured >= element.minClosure;
			closure = { measured, threshold: element.minClosure, passed: ok };
			if (!ok) passed = false;
		}

		let connectedComponents: Check | null = null;
		if (element.components !== undefined) {
			const measured = countComponents(region);
			const ok = measured === element.components;
			connectedComponents = { measured, threshold: element.components, passed: ok };
			if (!ok) passed = false;
		}

		let inkBudget: Check | null = null;
		if (element.inkBudget !== undefined) {
			const measured = countSet(region.data);
			const ok = measured <= element.inkBudget;
			inkBudget = { measured, threshold: element.inkBudget, passed: ok };
			if (!ok) passed = false;
		}

		elements.push({ element: element.name, closure, connectedComponents, inkBudget, passed });
	}

	let totalInk: Check | null = null;
	if (spec.totalInkBudget !== undefined) {
		const measured = countSet(candidate.data);
		totalInk = { measured, threshold: spec.totalInkBudget, passed: measured <= spec.totalInkBudget };
	}

	const passed = elements.every((e) => e.passed) && (totalInk === null || totalInk.passed);
	return { passed, elements, totalInk };
}

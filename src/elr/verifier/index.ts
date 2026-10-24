// ELR verifier (spec §3, §5). Owner-merge-only referee code (D9). The boundary-F scorer is the only
// reward (D4): deterministic, no model in the loop.
export {
	BOUNDARY_TOLERANCE_PX,
	SUCCESS_BOUNDARY_F,
	boundaryF,
	createBoundaryScorer,
	type BoundaryFResult,
	type BoundaryScorer,
	type BoundaryScorerOptions,
} from "./score.ts";
export { maskFromCoverage, boundaryOf, countSet, type BinaryMask } from "./mask.ts";
export { squaredDistanceTransform } from "./distance.ts";
export { countComponents, type Connectivity } from "./components.ts";
export {
	DEFAULT_CLOSURE_SECTORS,
	DEFAULT_MIN_CLOSURE,
	DEFAULT_TOLERANCE_PX,
	angularCoverage,
	checkElements,
	type Check,
	type ElementCheckResult,
	type ElementChecksResult,
	type ElementSpec,
	type TaskElementSpec,
} from "./elements.ts";

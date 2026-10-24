// ELR M3 System One calibration (spec docs/elr-canvas-spec.md §5, §6, §7, §9 M3).
//
// Arm B′ labels every action with System One (system-one.ts) but those labels are NEVER the reward
// (§6). Before a label type may be used for triage it must be calibrated: its agreement with the
// verifier-derived label must reach accuracy ≥ 0.75 and ECE ≤ 0.10 on held-out labels. This module is
// the pure arithmetic behind that report:
//
//   - accuracy and expected calibration error (ECE) with fixed confidence buckets, over the
//     non-abstained evaluations only;
//   - abstentions are respected: every abstained evaluation counts as abstain=1 and its label is not
//     used, so it never enters n, accuracy or ECE;
//   - the verifier-derived label for each label type comes from the deterministic verifier, never from
//     System One, so withholding or flipping labels leaves it unchanged.
//
// It has no runtime dependency beyond types; the report formatting is pure string work.
import { errorClassOf } from "./micro.ts";
import { SYSTEM_ONE_LABEL_TYPES, type SystemOneLabelType } from "../system-one.ts";
import type { EpisodeRecord } from "./episode.ts";
import type { SystemOneEvaluationRecord } from "./system-one-run.ts";

/** Fixed ECE buckets: [0.5,0.6) … [0.9,1.0]. Non-abstained labels always exceed DEFAULT_MIN_CONFIDENCE. */
export const CONFIDENCE_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0] as const;

/**
 * The ΔF magnitude that distinguishes a real move from noise, for the verifier-derived action_effect
 * label. §6 names "the ΔF sign, with a threshold"; 0.005 boundary-F is well below the success step and
 * above rasterisation jitter, so a stroke that barely touches the canvas bins as redundant.
 */
export const ACTION_EFFECT_DELTA_F_THRESHOLD = 0.005;

/** The verifier-derived label for one label type, plus the deterministic source it came from. */
export type VerifierDerivedLabel = Readonly<{ label: string | null; source: string }>;

/** The deterministic signals the verifier exposes for calibration. No System One value is an input. */
export type VerifierLabelInputs = Readonly<{
	/** Boundary-F change caused by the last operation (the action_effect evaluator's subject). */
	lastDeltaF: number;
	/** The last tool error text, if the last operation failed. */
	lastError: string;
	/** Whether the deterministic verifier marked the episode a success. */
	success: boolean;
}>;

const NO_NODE_SOURCE = "no verifier-derived label yet (knowledge nodes arrive in M4)";

/**
 * Derive the verifier's own label for every §6 label type. Pure: it reads only its scalar inputs and
 * never mutates them, so the caller can prove the labels are unchanged by the calibration math.
 *
 * - action_effect: ΔF sign with a threshold (progress / redundant / regress).
 * - error_class: the deterministic tool-error class that the micro scorecard also uses.
 * - worth_reflecting: the verifier's episode outcome — a failed drawing is the one worth reflecting on.
 * - evidence_vs_node / node_applies: there is no verifier-derived label until M4 adds knowledge nodes.
 */
export function deriveVerifierLabels(input: VerifierLabelInputs): Record<SystemOneLabelType, VerifierDerivedLabel> {
	const threshold = ACTION_EFFECT_DELTA_F_THRESHOLD;
	const actionEffect = input.lastDeltaF > threshold ? "progress" : input.lastDeltaF < -threshold ? "regress" : "redundant";
	return {
		action_effect: { label: actionEffect, source: `verifier ΔF sign (threshold ±${threshold})` },
		error_class: { label: errorClassOf(input.lastError), source: "verifier deterministic tool-error class" },
		worth_reflecting: { label: input.success ? "no" : "yes", source: "verifier episode outcome (success=false → yes)" },
		evidence_vs_node: { label: null, source: NO_NODE_SOURCE },
		node_applies: { label: null, source: NO_NODE_SOURCE },
	};
}

/** One non-abstained evaluation paired with the verifier's label for the same event. */
export type LabelObservation = Readonly<{
	/** The verifier-derived label, or null when the verifier cannot supply one. */
	verifierLabel: string | null;
	/** The System One label; null exactly when the evaluator abstained. */
	label: string | null;
	confidence: number;
	abstain: boolean;
}>;

export type LabelMetrics = {
	/** Evaluations scored: non-abstained, with a verifier-derived label. */
	n: number;
	/** Abstained evaluations; each was counted as abstain=1 and its label was not used. */
	abstain: number;
	/** Non-abstained evaluations the verifier could not label (e.g. no knowledge nodes in M3). */
	unscored: number;
	/** correct / n, or null when n = 0. */
	accuracy: number | null;
	/** Expected calibration error with fixed buckets, or null when n = 0. */
	ece: number | null;
};

/** The fixed bucket a confidence falls in: 0 is [0.5,0.6), … 4 is [0.9,1.0]. */
export function bucketIndex(confidence: number): number {
	const clamped = Math.min(1, Math.max(CONFIDENCE_BUCKETS[0]!, confidence));
	const last = CONFIDENCE_BUCKETS.length - 2;
	if (clamped >= 1) return last;
	return Math.min(last, Math.floor((clamped - CONFIDENCE_BUCKETS[0]!) / 0.1));
}

/**
 * Accuracy and ECE over the non-abstained, verifier-labelled evaluations. Witnesses are pure: the
 * function never writes to an observation, so a caller's verifier-derived labels come out unchanged.
 */
export function computeLabelMetrics(observations: readonly LabelObservation[]): LabelMetrics {
	type Bucket = { count: number; confidence: number; correct: number };
	const buckets: Bucket[] = CONFIDENCE_BUCKETS.slice(0, -1).map(() => ({ count: 0, confidence: 0, correct: 0 }));
	let n = 0;
	let abstain = 0;
	let unscored = 0;
	let correct = 0;

	for (const observation of observations) {
		if (observation.abstain) {
			abstain += 1;
			continue;
		}
		if (observation.verifierLabel === null) {
			unscored += 1;
			continue;
		}
		const hit = observation.label === observation.verifierLabel;
		n += 1;
		if (hit) correct += 1;
		const bucket = buckets[bucketIndex(observation.confidence)]!;
		bucket.count += 1;
		bucket.confidence += observation.confidence;
		if (hit) bucket.correct += 1;
	}

	if (n === 0) return { n: 0, abstain, unscored, accuracy: null, ece: null };

	let ece = 0;
	for (const bucket of buckets) {
		if (bucket.count === 0) continue;
		const bucketAccuracy = bucket.correct / bucket.count;
		const bucketConfidence = bucket.confidence / bucket.count;
		ece += (bucket.count / n) * Math.abs(bucketAccuracy - bucketConfidence);
	}
	return { n, abstain, unscored, accuracy: correct / n, ece };
}

/** §6 triage gate: a label type is usable only when it clears both thresholds on held-out labels. */
export const TRIAGE_MIN_ACCURACY = 0.75;
export const TRIAGE_MAX_ECE = 0.1;

/** Whether a label type may be used for triage; "n/a" when there is nothing to calibrate on. */
export type TriageVerdict = "pass" | "fallback" | "n/a";

export function triageVerdict(metrics: LabelMetrics): TriageVerdict {
	if (metrics.accuracy === null || metrics.ece === null) return "n/a";
	return metrics.accuracy >= TRIAGE_MIN_ACCURACY && metrics.ece <= TRIAGE_MAX_ECE ? "pass" : "fallback";
}

/** A per-label-type calibration row: the §6 columns plus the verifier-derived source used. */
export type CalibrationRow = LabelMetrics & {
	labelType: SystemOneLabelType;
	source: string;
	/** §6 verdict: pass, fall back to deterministic signals, or nothing to calibrate. */
	triage: TriageVerdict;
};

function observationsFor(records: readonly EpisodeRecord[], labelType: SystemOneLabelType): LabelObservation[] {
	const observations: LabelObservation[] = [];
	for (const record of records) {
		const evaluation: SystemOneEvaluationRecord | undefined = record.systemOne.find((entry) => entry.labelType === labelType);
		if (evaluation === undefined) continue;
		const verifier = record.verifierLabels?.[labelType];
		observations.push({
			verifierLabel: verifier?.label ?? null,
			label: evaluation.label,
			confidence: evaluation.confidence,
			abstain: evaluation.abstain,
		});
	}
	return observations;
}

function sourceFor(records: readonly EpisodeRecord[], labelType: SystemOneLabelType): string {
	for (const record of records) {
		const verifier = record.verifierLabels?.[labelType];
		if (verifier !== undefined) return verifier.source;
	}
	return "verifier (no episodes recorded)";
}

/** Build one row per §6 label type, aggregating every episode's B′ evaluations. Pure aggregation. */
export function buildCalibrationRows(records: readonly EpisodeRecord[]): CalibrationRow[] {
	return SYSTEM_ONE_LABEL_TYPES.map((labelType) => {
		const metrics = computeLabelMetrics(observationsFor(records, labelType));
		return { labelType, source: sourceFor(records, labelType), ...metrics, triage: triageVerdict(metrics) };
	});
}

/** How much of a run's recorded cost was real money (stub System One and the reference driver are free). */
export function realCostUsd(records: readonly EpisodeRecord[], systemOneMode: SystemOneMode): number {
	let agent = 0;
	let systemOne = 0;
	for (const record of records) {
		const evaluatorCost = record.systemOne.reduce((total, entry) => total + entry.costUsd, 0);
		systemOne += evaluatorCost;
		agent += record.costUsd - evaluatorCost;
	}
	const driver = records[0]?.driver ?? "reference";
	return (driver === "model" ? agent : 0) + (systemOneMode === "real" ? systemOne : 0);
}

export type SystemOneMode = "real" | "stub" | "off";

export type CalibrationReport = {
	rows: CalibrationRow[];
	episodes: number;
	driver: string;
	systemOneMode: SystemOneMode;
	recordedCostUsd: number;
	realCostUsd: number;
};

/** The report the CLI prints: the per-label-type table plus the run's cost and provenance. */
export function buildCalibrationReport(records: readonly EpisodeRecord[], systemOneMode: SystemOneMode): CalibrationReport {
	const recordedCostUsd = records.reduce((total, record) => total + record.costUsd, 0);
	return {
		rows: buildCalibrationRows(records),
		episodes: records.length,
		driver: records[0]?.driver ?? "reference",
		systemOneMode,
		recordedCostUsd,
		realCostUsd: realCostUsd(records, systemOneMode),
	};
}

function numberOrNa(value: number | null, digits: number): string {
	return value === null ? "n/a" : value.toFixed(digits);
}

/** Render the report as lines: a per-label-type table, then a cost/provenance footer. */
export function formatCalibrationReport(report: CalibrationReport): string[] {
	const header = ["label-type", "n", "abstain", "accuracy", "ece", "triage", "source"];
	const rows = report.rows.map((row) => [
		row.labelType,
		String(row.n),
		String(row.abstain),
		numberOrNa(row.accuracy, 3),
		numberOrNa(row.ece, 3),
		row.triage,
		row.source,
	]);
	const widths = header.map((cell, column) => Math.max(cell.length, ...rows.map((row) => row[column]!.length)));
	const line = (cells: string[]) => `report: ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()}`;
	const lines = [
		`report: B′ System One calibration against verifier-derived labels (${report.episodes} episodes)`,
		line(header),
		...rows.map(line),
		`report: driver=${report.driver} systemOne=${report.systemOneMode} recordedCostUsd=$${report.recordedCostUsd.toFixed(6)} realCostUsd=$${report.realCostUsd.toFixed(6)}`,
	];
	return lines;
}

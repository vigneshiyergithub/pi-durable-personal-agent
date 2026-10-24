// ELR M3 System One calibration tests (spec docs/elr-canvas-spec.md §6, §9 M3).
// Run: node --test bench/calibration.test.ts
//
// Pure arithmetic — no network, no credentials, no money. The hand-computed case fixes the expected
// accuracy and ECE so a regression cannot hide, and the all-abstain case proves abstentions are
// respected (abstain=1, label unused) and that no verifier-derived label is ever mutated.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTION_EFFECT_DELTA_F_THRESHOLD,
	buildCalibrationRows,
	computeLabelMetrics,
	deriveVerifierLabels,
	formatCalibrationReport,
	triageVerdict,
	type LabelObservation,
	type VerifierLabelInputs,
} from "../src/elr/bench/calibration.ts";
import type { EpisodeRecord } from "../src/elr/bench/episode.ts";
import { SYSTEM_ONE_LABEL_TYPES } from "../src/elr/system-one.ts";

function close(actual: number | null, expected: number, message: string): void {
	assert.ok(actual !== null, `${message}: got null`);
	assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: got ${actual}, expected ${expected}`);
}

test("accuracy and ECE match a hand-computed example on a fixed synthetic input", () => {
	// Three non-abstained evaluations against the verifier's "progress" label; the third is wrong.
	// accuracy = 2/3. Buckets: [0.9,1.0): conf 0.95, acc 1; [0.8,0.9): conf 0.85, acc 1;
	// [0.5,0.6): conf 0.55, acc 0. ECE = (|1-0.95| + |1-0.85| + |0-0.55|) / 3 = 0.25.
	const observations: LabelObservation[] = [
		{ verifierLabel: "progress", label: "progress", confidence: 0.95, abstain: false },
		{ verifierLabel: "progress", label: "progress", confidence: 0.85, abstain: false },
		{ verifierLabel: "progress", label: "regress", confidence: 0.55, abstain: false },
	];
	const metrics = computeLabelMetrics(observations);
	assert.equal(metrics.n, 3);
	assert.equal(metrics.abstain, 0);
	assert.equal(metrics.unscored, 0);
	close(metrics.accuracy, 2 / 3, "accuracy");
	close(metrics.ece, 0.25, "ECE");
});

test("all-abstain input gives n=0 with accuracy/ECE undefined and counts every abstention", () => {
	const observations: LabelObservation[] = [
		{ verifierLabel: "progress", label: null, confidence: 0.6, abstain: true },
		{ verifierLabel: "regress", label: null, confidence: 0.7, abstain: true },
		{ verifierLabel: "redundant", label: null, confidence: 0.5, abstain: true },
	];
	const before = JSON.stringify(observations);
	const metrics = computeLabelMetrics(observations);
	assert.equal(metrics.n, 0, "no labels were used");
	assert.equal(metrics.abstain, 3, "every abstention is counted, one each");
	assert.equal(metrics.accuracy, null, "accuracy is undefined with n = 0");
	assert.equal(metrics.ece, null, "ECE is undefined with n = 0");
	assert.equal(JSON.stringify(observations), before, "verifier-derived labels are left unchanged");
});

test("a non-abstained evaluation the verifier cannot label is counted as unscored, never wrong", () => {
	const observations: LabelObservation[] = [
		{ verifierLabel: null, label: "yes", confidence: 0.9, abstain: false },
		{ verifierLabel: "progress", label: "progress", confidence: 0.9, abstain: false },
	];
	const metrics = computeLabelMetrics(observations);
	assert.equal(metrics.n, 1, "only the verifier-labelled evaluation is scored");
	assert.equal(metrics.unscored, 1);
	close(metrics.accuracy, 1, "accuracy over the one scored label");
});

test("deriveVerifierLabels maps ΔF sign, error class and outcome deterministically and never mutates inputs", () => {
	const inputs: VerifierLabelInputs = { lastDeltaF: 0.02, lastError: "", success: true };
	const before = JSON.stringify(inputs);
	const labels = deriveVerifierLabels(inputs);
	assert.equal(JSON.stringify(inputs), before, "the verifier inputs are unchanged");
	assert.equal(labels.action_effect.label, "progress");
	assert.equal(labels.error_class.label, "none");
	assert.equal(labels.worth_reflecting.label, "no");
	assert.equal(labels.evidence_vs_node.label, null, "no node label until M4");
	assert.equal(labels.node_applies.label, null, "no node label until M4");
	for (const labelType of SYSTEM_ONE_LABEL_TYPES) assert.ok(labels[labelType].source.length > 0, `${labelType} names a source`);

	assert.equal(deriveVerifierLabels({ lastDeltaF: -0.02, lastError: "", success: false }).action_effect.label, "regress");
	assert.equal(deriveVerifierLabels({ lastDeltaF: 0.001, lastError: "", success: true }).action_effect.label, "redundant");
	assert.ok(Math.abs(ACTION_EFFECT_DELTA_F_THRESHOLD - 0.005) < 1e-12, "the threshold is fixed");
	assert.equal(deriveVerifierLabels({ lastDeltaF: 0, lastError: "stroke has 9 points, max 6", success: false }).error_class.label, "arguments");
	assert.equal(deriveVerifierLabels({ lastDeltaF: 0, lastError: "", success: false }).worth_reflecting.label, "yes");
});

test("buildCalibrationRows reports one row per label type with n, abstain and source from the verifier", () => {
	const record = {
		systemOne: [
			{ labelType: "action_effect", label: "progress", confidence: 0.9, abstain: false },
			{ labelType: "worth_reflecting", label: null, confidence: 0.6, abstain: true },
		],
		verifierLabels: deriveVerifierLabels({ lastDeltaF: 0.05, lastError: "", success: true }),
	} as unknown as EpisodeRecord;
	const rows = buildCalibrationRows([record]);
	assert.deepEqual(rows.map((row) => row.labelType).sort(), [...SYSTEM_ONE_LABEL_TYPES].sort());
	const actionEffect = rows.find((row) => row.labelType === "action_effect")!;
	assert.equal(actionEffect.n, 1);
	assert.equal(actionEffect.abstain, 0);
	close(actionEffect.accuracy, 1, "action_effect accuracy");
	assert.match(actionEffect.source, /verifier ΔF sign/);
	assert.equal(actionEffect.triage, "pass");
	const worth = rows.find((row) => row.labelType === "worth_reflecting")!;
	assert.equal(worth.n, 0);
	assert.equal(worth.abstain, 1, "the abstention is counted separately");
	assert.equal(worth.triage, "n/a");
});

test("formatCalibrationReport prints the label-type/n/abstain/accuracy/ece/source columns", () => {
	const record = {
		driver: "reference",
		costUsd: 0.0003,
		systemOne: [{ labelType: "action_effect", label: "progress", confidence: 0.9, abstain: false, costUsd: 0 }],
		verifierLabels: deriveVerifierLabels({ lastDeltaF: 0.05, lastError: "", success: true }),
	} as unknown as EpisodeRecord;
	const lines = formatCalibrationReport({
		rows: buildCalibrationRows([record]),
		episodes: 1,
		driver: "reference",
		systemOneMode: "stub",
		recordedCostUsd: 0.0003,
		realCostUsd: 0,
	});
	const text = lines.join("\n");
	for (const column of ["label-type", "n", "abstain", "accuracy", "ece", "triage", "source"]) assert.ok(text.includes(column), `table has a ${column} column`);
	assert.match(text, /driver=reference systemOne=stub recordedCostUsd=\$0\.000300 realCostUsd=\$0\.000000/);
});

test("the §6 triage gate passes only when accuracy >= 0.75 and ECE <= 0.10", () => {
	assert.equal(triageVerdict({ n: 4, abstain: 0, unscored: 0, accuracy: 0.8, ece: 0.1 }), "pass");
	assert.equal(triageVerdict({ n: 4, abstain: 0, unscored: 0, accuracy: 0.74, ece: 0.1 }), "fallback");
	assert.equal(triageVerdict({ n: 4, abstain: 0, unscored: 0, accuracy: 0.8, ece: 0.11 }), "fallback");
	assert.equal(triageVerdict({ n: 0, abstain: 4, unscored: 0, accuracy: null, ece: null }), "n/a");
});

// ELR System One evaluator tests (spec docs/elr-canvas-spec.md §6, §9 M3).
// Run: node --test bench/system-one.test.ts
//
// Everything here uses an injected stub client, so the suite runs with OPENROUTER_API_KEY unset, makes
// no network calls and costs nothing. The env-resolution test shells out to a fresh Node process
// because src/config.ts reads the environment once at import time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ClassifierAnswer, ClassifierContext } from "@earendil-works/pi-ai";
import { config } from "../src/config.ts";
import {
	ABSTAIN_CHOICE,
	SYSTEM_ONE_EVALUATOR_BY_LABEL,
	SYSTEM_ONE_EVALUATORS,
	SYSTEM_ONE_LABEL_TYPES,
	action_effect,
	createSystemOneEvaluator,
	error_class,
	evidence_vs_node,
	node_applies,
	systemOneModels,
	worth_reflecting,
	type SystemOneClient,
	type SystemOneEvaluator,
	type SystemOneReply,
} from "../src/elr/system-one.ts";

const STUB_MODEL = "stub/model-1";
const STUB_COST_USD = 0.00002;

/** A client that answers the evaluator's one question with `answer`, whatever the question is. */
function stubClient(answer: ClassifierAnswer | undefined, overrides: Partial<SystemOneReply> = {}): SystemOneClient {
	return {
		async classify(model, context: ClassifierContext): Promise<SystemOneReply> {
			const questionId = Object.keys(context.questions)[0]!;
			return {
				stopReason: "stop",
				model,
				provider: "openrouter",
				answers: answer === undefined ? {} : { [questionId]: answer },
				costUsd: STUB_COST_USD,
				...overrides,
			};
		},
	};
}

/** A valid answer for this evaluator: its first label (choice) or a confident yes (bool). */
function validAnswer(evaluator: SystemOneEvaluator): ClassifierAnswer {
	if (evaluator.answerType === "choice") {
		const choice = evaluator.labels[0]!;
		return { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
	}
	return { type: "bool", probability: 0.9 };
}

test("the module exports exactly the five named evaluators", () => {
	assert.deepEqual([...SYSTEM_ONE_LABEL_TYPES], ["action_effect", "error_class", "worth_reflecting", "evidence_vs_node", "node_applies"]);
	for (const labelType of SYSTEM_ONE_LABEL_TYPES) {
		assert.equal(SYSTEM_ONE_EVALUATOR_BY_LABEL[labelType].labelType, labelType);
	}
	for (const evaluator of [action_effect, error_class, worth_reflecting, evidence_vs_node, node_applies]) {
		assert.ok(SYSTEM_ONE_EVALUATORS.includes(evaluator));
	}
});

test("each evaluator asks its own typed question with a strict schema", () => {
	const questions = new Set<string>();
	for (const evaluator of SYSTEM_ONE_EVALUATORS) {
		assert.ok(evaluator.question.length > 0, `${evaluator.labelType} has no question text`);
		assert.ok(!questions.has(evaluator.question), `${evaluator.labelType} reuses another evaluator's question`);
		questions.add(evaluator.question);
		assert.equal(evaluator.schema.type, evaluator.answerType, `${evaluator.labelType} schema type`);
		if (evaluator.answerType === "choice") {
			assert.equal(evaluator.schema.type, "choice");
			const criteria = evaluator.schema.criteria;
			for (const label of evaluator.labels) assert.ok(label in criteria, `${evaluator.labelType} schema is missing label "${label}"`);
			assert.ok(ABSTAIN_CHOICE in criteria, `${evaluator.labelType} schema is missing the abstain sentinel`);
		} else {
			assert.equal(evaluator.schema.type, "bool");
			assert.deepEqual(Object.keys(evaluator.schema.criteria).sort(), ["false", "true"]);
			assert.equal(evaluator.labels.length, 0, `${evaluator.labelType} bool evaluator must have no choice labels`);
		}
	}
	assert.equal(questions.size, 5, "every evaluator asks a distinct question");
});

test("every evaluator returns label, confidence, abstain, question, model and cost", async () => {
	for (const evaluator of SYSTEM_ONE_EVALUATORS) {
		const evaluation = await evaluator.ask({ state: "text" }, { client: stubClient(validAnswer(evaluator)), model: STUB_MODEL });
		assert.equal(evaluation.labelType, evaluator.labelType);
		assert.equal(evaluation.abstain, false, `${evaluator.labelType} should not abstain on a valid reply`);
		assert.equal(evaluation.question, evaluator.question);
		assert.equal(evaluation.model, STUB_MODEL);
		assert.equal(evaluation.provider, "openrouter");
		assert.equal(evaluation.costUsd, STUB_COST_USD);
		assert.ok(evaluation.confidence > 0.5, `${evaluator.labelType} confidence`);
		assert.equal(typeof evaluation.label, "string");
		if (evaluator.answerType === "choice") assert.equal(evaluation.label, evaluator.labels[0]);
		else assert.equal(evaluation.label, "yes");
	}
});

test("an explicit abstain reply yields abstain=true and no label", async () => {
	for (const evaluator of SYSTEM_ONE_EVALUATORS.filter((entry) => entry.answerType === "choice")) {
		const evaluation = await evaluator.ask(
			{ state: "text" },
			{ client: stubClient({ type: "choice", choice: ABSTAIN_CHOICE, probabilities: { [ABSTAIN_CHOICE]: 0.8 }, confidence: 0.8 }), model: STUB_MODEL },
		);
		assert.equal(evaluation.abstain, true, `${evaluator.labelType} must abstain`);
		assert.equal(evaluation.label, null, `${evaluator.labelType} must have no label when abstaining`);
		assert.equal(evaluation.question, evaluator.question);
	}
});

test("a bool answer at chance abstains (low probability is respected)", async () => {
	for (const evaluator of SYSTEM_ONE_EVALUATORS.filter((entry) => entry.answerType === "bool")) {
		const evaluation = await evaluator.ask({ state: "text" }, { client: stubClient({ type: "bool", probability: 0.5 }), model: STUB_MODEL });
		assert.equal(evaluation.abstain, true, `${evaluator.labelType} must abstain at chance`);
		assert.equal(evaluation.label, null);
	}
});

test("malformed and failed replies become abstain and never throw", async () => {
	const cases: { name: string; client: SystemOneClient }[] = [
		{ name: "provider error", client: stubClient(undefined, { stopReason: "error", errorMessage: "boom" }) },
		{ name: "no answer", client: stubClient(undefined) },
		{ name: "wrong answer type", client: stubClient({ type: "bool", probability: 0.9 }) },
		{ name: "unknown label", client: stubClient({ type: "choice", choice: "banana", probabilities: { banana: 0.9 }, confidence: 0.9 }) },
		{ name: "low confidence", client: stubClient({ type: "choice", choice: "progress", probabilities: { progress: 0.4 }, confidence: 0.4 }) },
		{
			name: "client throws",
			client: {
				async classify() {
					throw new Error("network down");
				},
			},
		},
	];
	for (const scenario of cases) {
		const evaluation = await action_effect.ask({ goal: "g", op: "o", before: "b", after: "a" }, { client: scenario.client, model: STUB_MODEL });
		assert.equal(evaluation.abstain, true, `${scenario.name} must abstain`);
		assert.equal(evaluation.label, null, `${scenario.name} must have no label`);
		assert.ok(evaluation.abstainReason !== undefined, `${scenario.name} should record why it abstained`);
	}
});

test("ELR_SYSTEM_ONE_MODEL / ELR_SYSTEM_ONE_SECOND defaults and env overrides", () => {
	const probe = (env: NodeJS.ProcessEnv) => {
		const script = "import('./src/config.ts').then(({config}) => console.log(JSON.stringify({primary: config.systemOneModel, second: config.systemOneSecond})))";
		const out = execFileSync(process.execPath, ["-e", script], { cwd: resolve("."), encoding: "utf8", env });
		return JSON.parse(out.trim()) as { primary: string; second: string };
	};

	const clean = { ...process.env };
	delete clean.ELR_SYSTEM_ONE_MODEL;
	delete clean.ELR_SYSTEM_ONE_SECOND;
	const defaults = probe(clean);
	assert.equal(defaults.primary, "perplexity/pplx-decider-v1.1-27b", "default primary model");
	assert.equal(defaults.second, "inception/mercury-decide", "default second model");

	const overridden = probe({ ...clean, ELR_SYSTEM_ONE_MODEL: "vendor/primary-x", ELR_SYSTEM_ONE_SECOND: "vendor/second-y" });
	assert.equal(overridden.primary, "vendor/primary-x", "ELR_SYSTEM_ONE_MODEL override");
	assert.equal(overridden.second, "vendor/second-y", "ELR_SYSTEM_ONE_SECOND override");

	// The second-opinion switch routes to the second model, the primary is the default.
	assert.deepEqual(systemOneModels(), { primary: config.systemOneModel, second: config.systemOneSecond });
});

test("the second opinion uses the second model", async () => {
	let seenModel = "";
	const client: SystemOneClient = {
		async classify(model) {
			seenModel = model;
			return { stopReason: "stop", model, provider: "openrouter", answers: {}, costUsd: 0 };
		},
	};
	await worth_reflecting.ask({ summary: "s" }, { client, second: true });
	assert.equal(seenModel, systemOneModels().second);
});

test("a distinctive stub label never appears in the agent transcript", async () => {
	const MARKER = "stub_system_one_label_7f3a91";
	// A distinctive label proves the marker is really carried by the evaluation and not filtered out.
	const markerEvaluator = createSystemOneEvaluator({
		labelType: "action_effect",
		answerType: "choice",
		question: "Which way did the operation move the drawing?",
		schema: { type: "choice", instructions: "Pick the effect.", criteria: { [MARKER]: "the stub marker label", abstain: "insufficient evidence" } },
		labels: [MARKER],
	});
	const client = stubClient({ type: "choice", choice: MARKER, probabilities: { [MARKER]: 0.99 }, confidence: 0.99 });
	const state = { goal: "draw a circle", op: "paint({points:[[0,0],[1,1]],width:3})", before: "blank", after: "one stroke" };
	// What the agent sees: the system prompt, the goal and op, and the tool result. The System One label
	// is produced on the side and handed to the caller only.
	const transcript = JSON.stringify([
		{ role: "system", content: "You paint on a canvas." },
		{ role: "user", content: [state.goal, state.op] },
		{ role: "toolResult", content: [state.after] },
	]);
	const before = JSON.stringify(state);

	const evaluation = await markerEvaluator.ask(state, { client, model: STUB_MODEL });

	assert.equal(evaluation.label, MARKER, "the stub label must be surfaced in the evaluation");
	assert.ok(!transcript.includes(MARKER), "the label must never appear in the agent transcript");
	assert.equal(JSON.stringify(state), before, "the evaluator must not write its label back into the state it was given");
	assert.ok(!evaluation.question.includes(MARKER), "the label must not leak into the question text");
});

test("the module is text-only (no image fields in source)", () => {
	const source = readFileSync(resolve("src/elr/system-one.ts"), "utf8");
	assert.doesNotMatch(source, /image_url|input_image|attachment/i);
});

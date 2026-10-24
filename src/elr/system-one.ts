// ELR System One evaluators (spec docs/elr-canvas-spec.md §2 D6, §3, §6).
//
// Five typed evaluators ask ONE decision model, through pi-ai's `classify()`, a single question about
// one piece of canvas state and return a label, its confidence, an abstain flag and the question that
// was actually asked. The models are the OpenRouter System One classifiers named by
// ELR_SYSTEM_ONE_MODEL (primary) and ELR_SYSTEM_ONE_SECOND (second opinion), read from src/config.ts.
//
// Rules this module enforces (spec §6):
//   - Never the reward. Nothing here is imported by the verifier or the score path, and the label is
//     returned to the caller only; it is never written into the state it was given.
//   - Abstain is respected. The model's explicit abstain answer, a low-confidence answer, an error and
//     a malformed/unparseable reply all become `abstain: true` with no label, and never throw.
//   - Text input only. The classifier context carries `state` and `questions`; no images are attached.
//   - Calibration (arm B′) consumes the raw label and confidence; this module makes no reward decision.
//
// The client is injectable: tests pass a stub so the suite runs offline, with OPENROUTER_API_KEY unset,
// and costs nothing. Without a stub, calls go to the real OpenRouter classifier via pi-ai.
import type { ClassifierAnswer, ClassifierContext, ClassifierQuestion, MutableModels } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { config } from "../config.ts";
import { benchPinForModel, pinnedClassifyOptions } from "./pinning.ts";

/** The five label types §6 defines. Each maps to exactly one evaluator and one question. */
export const SYSTEM_ONE_LABEL_TYPES = ["action_effect", "error_class", "worth_reflecting", "evidence_vs_node", "node_applies"] as const;
export type SystemOneLabelType = (typeof SYSTEM_ONE_LABEL_TYPES)[number];

/** The sentinel choice a decision model returns when it cannot label the state. */
export const ABSTAIN_CHOICE = "abstain";

/** A System One label below this confidence (or a bool answer at chance) is an abstention. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

/** The state one evaluator is asked about: plain text fields derived from the episode, never images. */
export type SystemOneState = Record<string, string>;

/** §6 inputs, one shape per evaluator. All fields are text. */
export type ActionEffectInput = { goal: string; op: string; before: string; after: string };
export type ErrorClassInput = { op: string; error: string; scorecard: string };
export type WorthReflectingInput = { summary: string };
export type EvidenceVsNodeInput = { node: string; outcome: string };
export type NodeAppliesInput = { node: string; goal: string; tool: string };

/** The shape pi-ai's `classify()` yields, narrowed to what this module needs. */
export type SystemOneReply = {
	stopReason: "stop" | "error" | "aborted";
	errorMessage?: string;
	model: string;
	provider: string;
	answers: Record<string, ClassifierAnswer>;
	/** Cost of this call in USD, from the model catalog price and the reported token usage. */
	costUsd: number;
};

/** A decision-model client. The default talks to OpenRouter through pi-ai; tests inject a stub. */
export interface SystemOneClient {
	classify(model: string, context: ClassifierContext, options?: { signal?: AbortSignal }): Promise<SystemOneReply>;
}

/** One System One answer. `label` is null exactly when `abstain` is true. */
export type SystemOneEvaluation = {
	labelType: SystemOneLabelType;
	label: string | null;
	confidence: number;
	abstain: boolean;
	/** The fixed question text that was asked. */
	question: string;
	model: string;
	provider: string;
	costUsd: number;
	/** Why the evaluator abstained; absent when it did not. */
	abstainReason?: string;
};

export type SystemOneAskOptions = {
	/** Inject a client (tests use a stub). Defaults to the real OpenRouter classifier. */
	client?: SystemOneClient;
	/** Explicit model id; defaults to config.systemOneModel. */
	model?: string;
	/** Use config.systemOneSecond as the second opinion instead of the primary model. */
	second?: boolean;
	minConfidence?: number;
	signal?: AbortSignal;
};

export interface SystemOneEvaluator {
	readonly labelType: SystemOneLabelType;
	readonly answerType: "choice" | "bool";
	/** The fixed question text; the same text is returned in every evaluation. */
	readonly question: string;
	/** The strict answer schema for this label type, handed to the decision model verbatim. */
	readonly schema: ClassifierQuestion;
	/** Valid labels for a choice question (empty for a bool question). `abstain` is never a label. */
	readonly labels: readonly string[];
	ask(input: SystemOneState, options?: SystemOneAskOptions): Promise<SystemOneEvaluation>;
}

/** The primary and second-opinion model ids as resolved from the environment by config. */
export function systemOneModels(): { primary: string; second: string } {
	return { primary: config.systemOneModel, second: config.systemOneSecond };
}

let defaultClientInstance: SystemOneClient | undefined;

function defaultClient(): SystemOneClient {
	return (defaultClientInstance ??= createPiSystemOneClient());
}

/**
 * The real client: pi-ai's OpenRouter provider and its `classify()`, which never rejects — provider and
 * parse failures come back as an error reply with no answers. Constructed lazily so importing this
 * module reads no keys and makes no network calls. Every classify request carries the §7 provider
 * pin (src/elr/pinning.ts) in the options handed to the pi-ai call path; tests may inject a models
 * store whose provider captures them.
 */
export function createPiSystemOneClient(injected?: { models?: MutableModels }): SystemOneClient {
	let models: MutableModels | undefined;
	return {
		async classify(model, context, options) {
			const store = (models ??= injected?.models ?? createModels());
			if (store.getProvider("openrouter") === undefined) store.setProvider(openrouterProvider());
			const classifier = store.getModelOfType("classifier", "openrouter", model);
			if (classifier === undefined) {
				return { stopReason: "error", errorMessage: `unknown System One classifier model "${model}"`, model, provider: "openrouter", answers: {}, costUsd: 0 };
			}
			const result = await store.classify(classifier, context, {
				...(options?.signal === undefined ? {} : { signal: options.signal }),
				// §7 pin on the System One classify path: the same helper the bench agent driver uses.
				...pinnedClassifyOptions(benchPinForModel(model)),
			});
			return {
				stopReason: result.stopReason,
				...(result.errorMessage === undefined ? {} : { errorMessage: result.errorMessage }),
				model: result.model,
				provider: result.provider,
				answers: result.answers,
				costUsd: result.usage?.cost.total ?? 0,
			};
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function resolveModel(options: SystemOneAskOptions): string {
	const explicit = options.model?.trim();
	if (explicit !== undefined && explicit !== "") return explicit;
	return options.second === true ? config.systemOneSecond : config.systemOneModel;
}

/** Turn any non-answer into a respected abstention. Never throws. */
function abstain(base: Omit<SystemOneEvaluation, "abstain" | "label" | "confidence">, reason: string, confidence = 0): SystemOneEvaluation {
	return { ...base, label: null, confidence, abstain: true, abstainReason: reason };
}

function interpret(evaluator: SystemOneEvaluator, reply: SystemOneReply, minConfidence: number): SystemOneEvaluation {
	const base = {
		labelType: evaluator.labelType,
		question: evaluator.question,
		model: reply.model,
		provider: reply.provider,
		costUsd: reply.costUsd,
	};
	if (reply.stopReason !== "stop") return abstain(base, reply.errorMessage ?? reply.stopReason);

	const answer = reply.answers[evaluator.labelType];
	if (answer === undefined) return abstain(base, "no answer");

	if (evaluator.answerType === "choice") {
		if (answer.type !== "choice") return abstain(base, "unexpected answer type");
		const choice = answer.choice.trim().toLowerCase();
		const confidence = clamp01(answer.confidence);
		if (choice === ABSTAIN_CHOICE) return abstain(base, "model abstained", confidence);
		if (!evaluator.labels.includes(choice)) return abstain(base, `unknown label "${choice}"`, confidence);
		if (confidence <= minConfidence) return abstain(base, "low confidence", confidence);
		return { ...base, label: choice, confidence, abstain: false };
	}

	if (answer.type !== "bool") return abstain(base, "unexpected answer type");
	const probability = clamp01(answer.probability);
	const confidence = Math.max(probability, 1 - probability);
	if (confidence <= minConfidence) return abstain(base, "low confidence", confidence);
	return { ...base, label: probability >= 0.5 ? "yes" : "no", confidence, abstain: false };
}

async function askEvaluator(evaluator: SystemOneEvaluator, input: SystemOneState, options: SystemOneAskOptions = {}): Promise<SystemOneEvaluation> {
	const client = options.client ?? defaultClient();
	const model = resolveModel(options);
	const base = { labelType: evaluator.labelType, question: evaluator.question, model, provider: "openrouter", costUsd: 0 };
	const context: ClassifierContext = { state: { ...input }, questions: { [evaluator.labelType]: evaluator.schema } };
	try {
		const reply = await client.classify(model, context, options.signal === undefined ? {} : { signal: options.signal });
		return interpret(evaluator, reply, options.minConfidence ?? DEFAULT_MIN_CONFIDENCE);
	} catch (error) {
		return abstain(base, `client error: ${messageOf(error)}`);
	}
}

/**
 * Build an evaluator from a fixed question and its strict answer schema. Exported so callers and tests
 * can add a typed evaluator without changing this module; the five §6 evaluators are built with it.
 */
export function createSystemOneEvaluator(spec: {
	labelType: SystemOneLabelType;
	answerType: "choice" | "bool";
	question: string;
	schema: ClassifierQuestion;
	labels: readonly string[];
}): SystemOneEvaluator {
	const evaluator: SystemOneEvaluator = {
		labelType: spec.labelType,
		answerType: spec.answerType,
		question: spec.question,
		schema: spec.schema,
		labels: spec.labels,
		ask: (input, options) => askEvaluator(evaluator, input, options),
	};
	return evaluator;
}

/** Did one operation move the drawing toward the goal? */
export const action_effect = createSystemOneEvaluator({
	labelType: "action_effect",
	answerType: "choice",
	question:
		"Given the goal, the operation, and the scorecard before and after it, judge the operation's effect: progress if it moves the drawing measurably toward the goal, redundant if it changes little or repeats existing ink, regress if it moves the drawing away or destroys progress. If the evidence is insufficient, answer abstain.",
	schema: {
		type: "choice",
		instructions:
			"Judge one canvas operation by its effect on the goal. Use only the scorecard and operation given. If the evidence is insufficient, choose abstain.",
		criteria: {
			progress: "the operation moves the drawing measurably toward the goal",
			redundant: "the operation changes little or repeats ink that is already there",
			regress: "the operation moves the drawing away from the goal or destroys progress",
			abstain: "the evidence is insufficient to judge the effect",
		},
	},
	labels: ["progress", "redundant", "regress"],
});

/** What kind of failure was this operation? */
export const error_class = createSystemOneEvaluator({
	labelType: "error_class",
	answerType: "choice",
	question:
		"Classify the failure mode of this canvas operation: tool if the tool itself failed, arguments if the arguments were invalid or out of range, environment if the sandbox or its resources failed, timing if a budget or timeout was hit, strategy if the operation was valid but a poor choice, none if it did not fail. If the evidence is insufficient, answer abstain.",
	schema: {
		type: "choice",
		instructions: "Classify the failure mode of one canvas operation using only the operation, the tool error and the scorecard given.",
		criteria: {
			tool: "the tool itself failed",
			arguments: "the arguments were invalid or out of range",
			environment: "the sandbox or its resources failed",
			timing: "a budget or timeout was hit",
			strategy: "the operation was valid but a poor choice",
			none: "the operation did not fail",
			abstain: "the evidence is insufficient to classify the failure",
		},
	},
	labels: ["tool", "arguments", "environment", "timing", "strategy", "none"],
});

/** Is this attempt worth an expensive reflection pass? */
export const worth_reflecting = createSystemOneEvaluator({
	labelType: "worth_reflecting",
	answerType: "bool",
	question:
		"Decide whether this attempt deserves a full reflection pass: true if it shows a reusable lesson such as a new failure mode, a clear improvement, or a surprising result; false if it is routine or uninformative.",
	schema: {
		type: "bool",
		instructions: "Decide whether this attempt deserves a full reflection pass, using only the attempt summary given.",
		criteria: {
			true: "the attempt shows a reusable lesson (new failure mode, clear improvement, or surprising result)",
			false: "the attempt is routine or uninformative",
		},
	},
	labels: [],
});

/** Does this session outcome support or contradict a knowledge node? */
export const evidence_vs_node = createSystemOneEvaluator({
	labelType: "evidence_vs_node",
	answerType: "choice",
	question:
		"Given a knowledge node and a session outcome, say whether the outcome supports the node, contradicts it, or is unrelated to it. If the evidence is insufficient, answer abstain.",
	schema: {
		type: "choice",
		instructions: "Relate one session outcome to one knowledge node using only the node statement and the outcome summary given.",
		criteria: {
			supports: "the outcome is evidence for the node",
			contradicts: "the outcome is evidence against the node",
			unrelated: "the outcome says nothing about the node",
			abstain: "the evidence is insufficient to relate the outcome to the node",
		},
	},
	labels: ["supports", "contradicts", "unrelated"],
});

/** Does this knowledge node apply to this goal and tool? */
export const node_applies = createSystemOneEvaluator({
	labelType: "node_applies",
	answerType: "bool",
	question:
		"Decide whether this knowledge node applies to the given goal and tool identity: true if the node is relevant to painting this goal with this tool, false if it is not.",
	schema: {
		type: "bool",
		instructions: "Decide whether one knowledge node applies to the goal and tool identity given.",
		criteria: {
			true: "the node is relevant to this goal and this tool",
			false: "the node is not relevant to this goal or this tool",
		},
	},
	labels: [],
});

export const SYSTEM_ONE_EVALUATORS: readonly SystemOneEvaluator[] = [
	action_effect,
	error_class,
	worth_reflecting,
	evidence_vs_node,
	node_applies,
];

export const SYSTEM_ONE_EVALUATOR_BY_LABEL: Readonly<Record<SystemOneLabelType, SystemOneEvaluator>> = {
	action_effect,
	error_class,
	worth_reflecting,
	evidence_vs_node,
	node_applies,
};

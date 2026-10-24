// ELR M3 System One in the benchmark (spec docs/elr-canvas-spec.md §6, §7, §9 M3).
//
// Arm B′ runs the five typed evaluators once per episode, AFTER the episode's conversation has settled,
// and writes their labels into the results JSONL. Because they run after the model has finished, their
// labels cannot reach the agent's context: no prompt, tool result or assistant message ever carries
// them. The labels are calibration data; the reward stays the deterministic verifier (§6 "never the
// reward"). Their cost is added to the episode's `costUsd` so BENCH_MAX_USD accounts for it.
//
// A stub client keeps offline runs (no OPENROUTER_API_KEY) free: `resolveSystemOneClient` returns the
// real pi-ai client only when a key is present and ELR_SYSTEM_ONE_STUB is not set.
import type { ClassifierAnswer, ClassifierContext } from "@earendil-works/pi-ai";
import {
	createPiSystemOneClient,
	SYSTEM_ONE_EVALUATORS,
	type SystemOneClient,
	type SystemOneEvaluation,
	type SystemOneEvaluator,
	type SystemOneLabelType,
	type SystemOneReply,
	type SystemOneState,
} from "../system-one.ts";
import type { Task } from "../../../bench/tasks/generators.ts";
import { CANVAS_SIZE, type EpisodeOutcome } from "./score.ts";
import type { Op } from "../raster.ts";

/** Cost the offline stub reports, so tests can prove System One spend is counted even without a model. */
export const STUB_SYSTEM_ONE_COST_USD = 0.00002;

export type StubSystemOneMode = "labels" | "abstain";

function isTruthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * An offline decision-model client. "labels": every choice question gets its evaluator's label (the one
 * whose schema/answer the stub sees first), bool questions answer true, at high confidence. "abstain":
 * choice questions answer the abstain sentinel and bool questions answer at chance, so `interpret()`
 * respects the abstention. Same fixed cost either way, so no money is spent.
 */
export function createStubSystemOneClient(mode: StubSystemOneMode = "labels"): SystemOneClient {
	return {
		async classify(model, context: ClassifierContext): Promise<SystemOneReply> {
			const questionId = Object.keys(context.questions)[0]!;
			const schema = context.questions[questionId]!;
			let answer: ClassifierAnswer;
			if (schema.type === "choice") {
				const choices = Object.keys(schema.criteria).filter((choice) => choice !== "abstain");
				const choice = mode === "abstain" ? "abstain" : choices[0] ?? "abstain";
				answer = { type: "choice", choice, probabilities: { [choice]: mode === "abstain" ? 0.6 : 0.95 }, confidence: mode === "abstain" ? 0.6 : 0.95 };
			} else {
				answer = { type: "bool", probability: mode === "abstain" ? 0.5 : 0.95 };
			}
			return { stopReason: "stop", model, provider: "openrouter", answers: { [questionId]: answer }, costUsd: STUB_SYSTEM_ONE_COST_USD };
		},
	};
}

/** True when a System One run would spend real money: a key is present and the stub is not forced. */
export function systemOneUsesRealClient(env: NodeJS.ProcessEnv = process.env): boolean {
	const key = env.OPENROUTER_API_KEY?.trim();
	return key !== undefined && key !== "" && !isTruthy(env.ELR_SYSTEM_ONE_STUB);
}

/** The real client only when a key is present and the stub is not forced; the free stub otherwise. */
export function resolveSystemOneClient(env: NodeJS.ProcessEnv = process.env): SystemOneClient {
	if (systemOneUsesRealClient(env)) return createPiSystemOneClient();
	return createStubSystemOneClient("labels");
}

/** The text state each evaluator is asked about, built from the finished episode. Never contains images. */
export function systemOneInputs(task: Task, ops: readonly Op[], outcome: EpisodeOutcome): Record<SystemOneLabelType, SystemOneState> {
	const goal = `paint the ${task.family} on a ${CANVAS_SIZE}x${CANVAS_SIZE} canvas (task ${task.id})`;
	const lastOp = ops.length > 0 ? JSON.stringify(ops[ops.length - 1]) : "none";
	const scorecard = `boundaryF=${outcome.boundaryF.toFixed(4)} strokes=${ops.length} success=${outcome.success}`;
	const noNode = "no knowledge node yet (M4 adds nodes)";
	return {
		action_effect: { goal, op: lastOp, before: `strokes=${Math.max(0, ops.length - 1)}`, after: scorecard },
		error_class: { op: lastOp, error: "", scorecard },
		worth_reflecting: { summary: `${goal}; ${scorecard}` },
		evidence_vs_node: { node: noNode, outcome: scorecard },
		node_applies: { node: noNode, goal, tool: `painting/brush/configHash=${task.configHash}` },
	};
}

/** The serializable subset of a System One evaluation stored per episode. */
export type SystemOneEvaluationRecord = {
	labelType: SystemOneLabelType;
	label: string | null;
	confidence: number;
	abstain: boolean;
	abstainReason?: string;
	question: string;
	model: string;
	provider: string;
	costUsd: number;
};

export function systemOneRecord(evaluation: SystemOneEvaluation): SystemOneEvaluationRecord {
	return {
		labelType: evaluation.labelType,
		label: evaluation.label,
		confidence: evaluation.confidence,
		abstain: evaluation.abstain,
		...(evaluation.abstainReason === undefined ? {} : { abstainReason: evaluation.abstainReason }),
		question: evaluation.question,
		model: evaluation.model,
		provider: evaluation.provider,
		costUsd: evaluation.costUsd,
	};
}

export type EvaluateEpisodeOptions = {
	task: Task;
	ops: readonly Op[];
	outcome: EpisodeOutcome;
	client: SystemOneClient;
	/** Override the evaluators (tests inject marker evaluators); defaults to the five §6 evaluators. */
	evaluators?: readonly SystemOneEvaluator[];
	second?: boolean;
	minConfidence?: number;
	/** Bounds a real-model call so an episode can never hang on System One; an abort abstains. */
	signal?: AbortSignal;
};

/** Run every evaluator once, sequentially, and return their labels. Never throws: a failure abstains. */
export async function evaluateEpisode(options: EvaluateEpisodeOptions): Promise<SystemOneEvaluation[]> {
	const evaluators = options.evaluators ?? SYSTEM_ONE_EVALUATORS;
	const states = systemOneInputs(options.task, options.ops, options.outcome);
	const results: SystemOneEvaluation[] = [];
	for (const evaluator of evaluators) {
		const ask = {
			client: options.client,
			...(options.second === undefined ? {} : { second: options.second }),
			...(options.minConfidence === undefined ? {} : { minConfidence: options.minConfidence }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
		};
		results.push(await evaluator.ask(states[evaluator.labelType] ?? {}, ask));
	}
	return results;
}

/** Total System One cost of one episode's evaluations, added to the episode cost (BENCH_MAX_USD). */
export function systemOneCost(evaluations: readonly SystemOneEvaluation[]): number {
	return evaluations.reduce((total, evaluation) => total + evaluation.costUsd, 0);
}

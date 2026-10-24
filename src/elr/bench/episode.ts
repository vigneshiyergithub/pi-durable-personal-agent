// ELR M3 episode runner (spec docs/elr-canvas-spec.md §3, §7, §9 M3).
//
// One episode is one ownerless conversation configured with one arm's tools, run against one M2 task
// in the existing canvas sandbox. The model implements the policy (driver "model"); the "reference"
// driver replays the target's own ops through the same real tools, so the harness, verifier and
// journal can be exercised offline and deterministically. The episode ends when the model stops
// calling tools, or after a wall-clock cap (the conversation is then aborted). Either way the runner
// reads the final canvas ops, scores them with the M2 verifier, and records one result.
//
// This module imports only src/elr/** at runtime; the M2 Task type is a type-only import, so nothing
// here reaches the server's boot or request path.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import {
	createRegistry,
	Harness,
	type Conversation,
	type ConversationCreateOptions,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Task } from "../../../bench/tasks/generators.ts";
import { CanvasDoc } from "../canvas.ts";
import { readConversationTranscript } from "../journal.ts";
import type { Op } from "../raster.ts";
import { verifyCanvas } from "./score.ts";
import { armExtensions, containsScorecard } from "./arm.ts";
import { deriveVerifierLabels, type VerifierDerivedLabel } from "./calibration.ts";
import { evaluateEpisode, systemOneCost, systemOneRecord, type SystemOneEvaluationRecord } from "./system-one-run.ts";
import { BENCH_REASONING_EFFORT, benchPinForModel, pinnedOpenRouterProvider, SYSTEM_ONE_UNPINNED, type ProviderRouting } from "../pinning.ts";
import type { SystemOneClient, SystemOneEvaluator, SystemOneLabelType } from "../system-one.ts";
import type { ArmId } from "./types.ts";

export type BenchDriver = "model" | "reference";

export type BenchHarness = {
	readonly harness: Harness;
	readonly faux?: FauxProviderHandle;
	/** Point the (arm B/B′) micro scorecard at the task this episode runs. */
	setTask(task: Task): void;
	close(): Promise<void>;
};

export type EpisodeOptions = {
	task: Task;
	arm: ArmId;
	seed: number;
	driver: BenchDriver;
	/** The provider model id. For the reference driver this is the faux model id. */
	modelId: string;
	runId: string;
	timeoutMs: number;
	/** Arm B′ only: the System One client and evaluators run AFTER the episode (labels stay isolated). */
	systemOne?: { client: SystemOneClient; evaluators?: readonly SystemOneEvaluator[]; second?: boolean };
	/** Test hook: receives every text the agent saw (instructions, prompt, tool results, replies). */
	onAgentText?: (text: string) => void;
	now?: () => number;
};

/**
 * Which provider actually served the episode (§7), with the exchange's proof. All fields are
 * non-empty (the reference driver stamps a deterministic response id). pi-ai 1.3.0 captures only
 * chunk.id/chunk.model (dist/api/openai-completions.js:359-362) — not OpenRouter's serving-
 * `provider` field — so the serving provider is pinned by construction (see `pinning`).
 */
export type ProviderFingerprint = {
	provider: string;
	model: string;
	responseId: string;
};

/** The §7 pinning in force, and what pi-ai 1.3.0 could not express (never silently unpinned). */
export type PinningRecord = {
	routing: ProviderRouting;
	temperature: number;
	reasoningEffort: typeof BENCH_REASONING_EFFORT;
	/** Settings §7 names the pi-ai call path could not express; empty when fully pinned. */
	unpinned: string[];
};

/** One result row. Field names are the §7 comparability fields the results JSONL guarantees. */
export type EpisodeRecord = {
	schema: "elr.bench.episode/2";
	runId: string;
	seed: number;
	arm: ArmId;
	set: string;
	taskId: string;
	taskFamily: string;
	replicate: number;
	boundaryF: number;
	success: boolean;
	calls: number;
	strokes: number;
	costUsd: number;
	model: string;
	providerFingerprint: ProviderFingerprint;
	pinning: PinningRecord;
	driver: BenchDriver;
	startedAt: string;
	endedAt: string;
	durationMs: number;
	toolResultsContainScorecard: boolean;
	/** Arm B′ only: every System One evaluation for this episode, one per label type (arms A/B: `[]`). */
	systemOne: SystemOneEvaluationRecord[];
	/** The verifier's own label for every §6 label type, paired with its deterministic source. Never System One. */
	verifierLabels: Record<SystemOneLabelType, VerifierDerivedLabel>;
	verifier: {
		boundaryF: number;
		precision: number;
		recall: number;
		tolerancePx: number;
		success: boolean;
		elements: ReturnType<typeof verifyCanvas>["elements"];
	};
};

/** A real System One call is bounded so an episode can never hang on the evaluators; an abort abstains. */
const SYSTEM_ONE_TIMEOUT_MS = 30_000;

const EPISODE_INSTRUCTIONS = [
	"You paint on a 256x256 canvas that starts blank.",
	"The user message carries the target image; the canvas coordinates are absolute [x, y] with the origin at the top-left.",
	"Call view_canvas any time to see the canvas. Paint with paint({points, width}) where points is an ordered list of [x, y].",
	"When the drawing is as good as you can make it, call done. Then reply with one short sentence.",
].join(" ");

export async function openBenchHarness(options: { arm: ArmId; driver: BenchDriver; dataDir: string; modelId: string }): Promise<BenchHarness> {
	await mkdir(options.dataDir, { recursive: true });
	const registry = createRegistry();
	// The scorecard is a pure function of the task and the canvas, so the runner-side wrap extension
	// (arm.ts) reads the current task through this box; runEpisode points it at each episode's task
	// before the conversation starts. Arm A installs no wrap extension, so nothing appends a scorecard.
	const taskBox: { current?: Task } = {};
	for (const extension of armExtensions(options.arm, { currentTask: () => taskBox.current })) registry.install(extension);
	const models = createModels();
	let faux: FauxProviderHandle | undefined;
	if (options.driver === "reference") {
		faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Reference painter" }] });
		models.setProvider(faux.provider);
	} else {
		// §7: the real chat model is registered pinned — provider.order, no fallbacks, fixed temperature.
		models.setProvider(pinnedOpenRouterProvider(options.modelId));
	}
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(options.dataDir, "agent.sqlite")),
		{ models, registry, onReport: (report: unknown) => console.error("[bench harness]", report) },
		CTX,
	);
	harness.resume();
	return { harness, faux, setTask: (task: Task) => void (taskBox.current = task), close: async () => void (await harness.close(CTX)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
		.join(" ");
}

/** Calls, strokes and provider/model identities read from the transcript, plus tool-result texts. */
type TranscriptScan = {
	calls: number;
	strokes: number;
	providers: string[];
	models: string[];
	/** The provider's response id on the episode's last reply ("" when it gave none). */
	responseId: string;
	toolTexts: string[];
	/** Every text the agent model saw: its assistant replies plus tool-result texts. */
	agentTexts: string[];
	/** The text of the last failed tool result, if any; the verifier's error_class signal. */
	lastError: string;
};

async function scanTranscript(conversation: Conversation): Promise<TranscriptScan> {
	const entries = await readConversationTranscript(conversation, CTX);
	const providers = new Set<string>();
	const models = new Set<string>();
	const toolTexts: string[] = [];
	const agentTexts: string[] = [];
	let calls = 0;
	let strokes = 0;
	let lastError = "";
	let responseId = "";
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			if (!isRecord(message)) continue;
			if (message.role === "assistant") {
				if (typeof message.provider === "string") providers.add(message.provider);
				if (typeof message.model === "string") models.add(message.model);
				if (typeof message.responseId === "string" && message.responseId !== "") responseId = message.responseId;
				if (Array.isArray(message.content)) {
					for (const item of message.content) {
						if (isRecord(item) && item.type === "toolCall") calls++;
						else if (isRecord(item) && item.type === "text" && typeof item.text === "string") agentTexts.push(item.text);
					}
				}
			} else if (message.role === "toolResult") {
				const text = textOfContent(message.content);
				toolTexts.push(text);
				agentTexts.push(text);
				if (message.isError === true) lastError = text;
				if (message.toolName === "paint" && message.isError !== true) strokes++;
			}
		}
	}
	return { calls, strokes, providers: [...providers].sort(), models: [...models].sort(), responseId, toolTexts, agentTexts, lastError };
}

async function totalCost(harness: Harness): Promise<number> {
	const usage = await harness.usage(CTX);
	let total = 0;
	for (const group of [usage.models, usage.tools] as const) {
		for (const value of Object.values(group ?? {})) {
			total += (value as { cost?: { total?: number } }).cost?.total ?? 0;
		}
	}
	return total;
}

/** Sample an arc op into an ordered polyline (used only by the offline reference driver). */
function sampleArc(op: Extract<Op, { kind: "arc" }>): [number, number][] {
	const sweep = Math.abs(op.a1 - op.a0);
	const steps = Math.max(6, Math.ceil(sweep / (Math.PI / 12)));
	const points: [number, number][] = [];
	for (let i = 0; i <= steps; i++) {
		const a = op.a0 + ((op.a1 - op.a0) * i) / steps;
		points.push([op.cx + Math.cos(a) * op.r, op.cy + Math.sin(a) * op.r]);
	}
	return points;
}

function paintArgs(op: Op): ToolCall["arguments"] {
	if (op.kind === "arc") return { points: sampleArc(op), width: op.width } as unknown as ToolCall["arguments"];
	return { points: op.points, width: op.width } as unknown as ToolCall["arguments"];
}

/**
 * The offline reference policy: view the blank canvas, replay the target's own shape ops through the
 * real paint tool, then finish. It makes the harness deterministic for tests; it is not a model and
 * its result is never a benchmark measurement.
 */
function referenceResponses(task: Task): AssistantMessage[] {
	// Deterministic response ids, so even offline reference episodes carry the fingerprint's fields.
	const toolCalls: ToolCall[] = [fauxToolCall("view_canvas", {})];
	for (const op of task.targetOps) toolCalls.push(fauxToolCall("paint", paintArgs(op)));
	toolCalls.push(fauxToolCall("done", {}));
	const id = (reply: number) => `faux-ref-${task.id}-${reply}`;
	return [
		fauxAssistantMessage(toolCalls, { stopReason: "toolUse", responseId: id(1) }),
		fauxAssistantMessage([fauxText("reference episode complete")], { responseId: id(2) }),
	];
}

function delay(ms: number): Promise<"timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), ms);
		timer.unref?.();
	});
}

export async function runEpisode(bench: BenchHarness, options: EpisodeOptions): Promise<EpisodeRecord> {
	const now = options.now ?? (() => Date.now());
	const startedMs = now();
	const createOptions: ConversationCreateOptions = { ownership: { kind: "ownerless" } };
	bench.setTask(options.task);
	const conversation = await bench.harness.createConversation(createOptions, CTX);
	const provider = options.driver === "reference" ? "faux" : "openrouter";
	// §7: fixed temperature and reasoning effort come from the same pin every arm shares.
	const pin = benchPinForModel(options.modelId);
	await conversation.configure({ model: { provider, modelId: options.modelId }, thinkingLevel: pin.reasoningEffort, instructions: EPISODE_INSTRUCTIONS }, CTX);
	if (options.driver === "reference") bench.faux!.setResponses(referenceResponses(options.task));

	const prompt = [
		{ type: "text" as const, text: `Repaint the target shape shown in the image on the canvas. Coordinates: [x, y] in 0..256, origin top-left. Then call done.` },
		{ type: "image" as const, data: Buffer.from(options.task.targetPng).toString("base64"), mimeType: "image/png" },
	];
	const costBefore = await totalCost(bench.harness);
	const submission = await conversation.submit(
		{ type: "input", content: prompt, requestId: `bench:${options.runId}:${options.task.id}` },
		CTX,
	);
	const outcome = await Promise.race([submission.wait(CTX).then(() => "settled" as const), delay(options.timeoutMs)]);
	if (outcome === "timeout") await conversation.abort(CTX);
	const costAfter = await totalCost(bench.harness);

	const doc = await bench.harness.snapshot(CanvasDoc, String(conversation.id), CTX);
	const ops = (doc?.ops ?? []) as Op[];
	const scan = await scanTranscript(conversation);
	const verified = verifyCanvas(options.task, ops);
	// The verifier's own labels for calibration. ΔF is the last op's contribution (what the
	// action_effect evaluator was asked about); the deterministic error class comes from the last
	// failed tool result. Computed here, from the verifier only, before any System One label exists.
	const previousF = ops.length > 0 ? verifyCanvas(options.task, ops.slice(0, -1)).boundaryF : 0;
	const verifierLabels = deriveVerifierLabels({
		lastDeltaF: ops.length > 0 ? verified.boundaryF - previousF : 0,
		lastError: scan.lastError,
		success: verified.success,
	});
	// Everything the agent saw: the fixed instructions, the prompt text, and its replies/tool results.
	options.onAgentText?.([EPISODE_INSTRUCTIONS, prompt[0].text, ...scan.agentTexts].join("\n"));
	// Arm B′: run System One AFTER the conversation has settled, so no label can reach the agent. Its
	// cost joins the episode cost, and its labels go to the caller only (results JSONL).
	const evaluations =
		options.systemOne === undefined
			? []
			: await evaluateEpisode({
					task: options.task,
					ops,
					outcome: verified,
					client: options.systemOne.client,
					...(options.systemOne.evaluators === undefined ? {} : { evaluators: options.systemOne.evaluators }),
					...(options.systemOne.second === undefined ? {} : { second: options.systemOne.second }),
					signal: AbortSignal.timeout(SYSTEM_ONE_TIMEOUT_MS),
				});
	const systemOneCostUsd = systemOneCost(evaluations);
	const ended = new Date(now()).toISOString();
	// §7 fingerprint: which provider actually served the episode. The pin in force, and (arm B′
	// only) what pi-ai 1.3.0 could not express on the classify path.
	const fingerprint = {
		provider: scan.providers.at(-1) ?? provider,
		model: options.modelId,
		responseId: scan.responseId,
	};
	const pinning = {
		routing: pin.routing,
		temperature: pin.temperature,
		reasoningEffort: pin.reasoningEffort,
		unpinned: options.systemOne === undefined ? [] : SYSTEM_ONE_UNPINNED,
	};

	return {
		schema: "elr.bench.episode/2",
		runId: options.runId,
		seed: options.seed,
		arm: options.arm,
		set: options.task.set,
		taskId: options.task.id,
		taskFamily: options.task.family,
		replicate: options.task.replicate,
		boundaryF: verified.boundaryF,
		success: verified.success,
		calls: scan.calls,
		strokes: scan.strokes,
		costUsd: Math.max(0, costAfter - costBefore) + systemOneCostUsd,
		model: options.modelId,
		providerFingerprint: fingerprint,
		pinning,
		driver: options.driver,
		startedAt: new Date(startedMs).toISOString(),
		endedAt: ended,
		durationMs: now() - startedMs,
		toolResultsContainScorecard: scan.toolTexts.some(containsScorecard),
		systemOne: evaluations.map(systemOneRecord),
		verifierLabels,
		verifier: {
			boundaryF: verified.boundaryF,
			precision: verified.precision,
			recall: verified.recall,
			tolerancePx: verified.tolerancePx,
			success: verified.success,
			elements: verified.elements,
		},
	};
}

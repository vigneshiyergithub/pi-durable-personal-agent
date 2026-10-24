// Shared harness driver for the M2 journal/episode/reconcile/boot proofs and tests
// (spec docs/elr-canvas-spec.md §3, §4, §9 M2).
//
// Every proof drives the *real* canvas tools through the *production* entry point — the tools
// registered by `createCanvasExtension()` — and hands them the same `ToolExecutionApi` shape the
// harness does, so the write path cannot drift:
//   src/elr/canvas.ts recordAction() -> src/elr/journal.ts journalFor().recordCanvasAction()
//     -> src/elr/journal.ts Journal.recordEvent()  (INSERT OR IGNORE, keyed by toolCallId)
// The pi-durable transcript (`entries` table of `agent.sqlite`) is the source of truth a boot
// reconciler reads. No network and no credentials: the provider is only registered, never called.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { AssistantEntry, createRegistry, Harness, ToolResultEntry } from "@earendil-works/pi-durable";
import type { Conversation, Registry, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCanvasExtension, type CanvasToolDetails } from "../../src/elr/canvas.ts";
import { journalFor, resetJournalCache, sha256Hex, type JournalEvent } from "../../src/elr/journal.ts";

/** The pi-durable storage file (holds the `entries` transcript table). */
export const AGENT_DB_FILE = "agent.sqlite";
/** The evidence-journal file (spec D7: `/data/elr.sqlite`). */
export const JOURNAL_DB_FILE = "elr.sqlite";

/**
 * The caveat the crash proofs print next to their PASS line: the missing journal writes are modelled
 * by redirecting `DATA_DIR`, not by losing real in-flight writes. The SIGKILL and the pi-durable
 * transcript are real; only the journal loss is synthetic.
 */
export const SYNTHETIC_LOSS_CAVEAT =
	"CAVEAT (synthetic journal loss): the missing journal writes are modelled by redirecting DATA_DIR to a " +
	"throwaway journal that does not survive, NOT by losing real in-flight writes to the persistent journal. " +
	"The SIGKILL and the pi-durable transcript are real; the loss is simulated, so this proof shows the " +
	"reconciler repairs a journal that is missing events, not that it survives torn or partial writes.";

export function makeApi(harness: Harness, registry: Registry, conversationId: string, callId: string): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId,
		registry: registry.snapshot(),
		models: {} as never,
		env: undefined,
		commit: (change: (tx: Tx) => unknown | Promise<unknown>, ctx: Context) => harness.commit(change, ctx),
		snapshot: (...args: unknown[]) => (harness.snapshot as (...a: unknown[]) => unknown)(...args),
		watchDoc: (...args: unknown[]) => (harness.watchDoc as (...a: unknown[]) => unknown)(...args),
		diagnostic: () => {},
		output: () => {},
		retainedOutput: () => ({ text: "", truncated: false }),
		outputWindow: undefined,
		agent: async () => {
			throw new Error("not implemented");
		},
		executeTool: async () => {
			throw new Error("not implemented");
		},
		getTask: async () => undefined,
		waitForTask: async () => {
			throw new Error("not implemented");
		},
		conversation: async () => undefined,
		createTask: async () => {
			throw new Error("not implemented");
		},
		memo: async (...args: unknown[]) => (args.length === 2 ? args[1] : undefined),
	} as unknown as ToolExecutionApi;
}

export type RegisteredTool = {
	readonly name: string;
	execute(
		args: unknown,
		api: ToolExecutionApi,
		ctx: Context,
	): Promise<{ isError?: boolean; output?: readonly unknown[]; details?: unknown }>;
};

type ContentItem = { readonly type?: string; readonly data?: string; readonly text?: string };

function textOf(result: { output?: readonly unknown[] }): string {
	return (result.output ?? [])
		.map((item) => (item as ContentItem).text ?? "")
		.join(" ")
		.trim();
}


// ── Scripted episode (spec §3, §4, §9 M2) ────────────────────────────────────────────────────────

/** One action of the scripted episode. `attempt` is the canvas attempt index the tool must record. */
export type ScriptedAction = { readonly tool: "paint" | "reset_canvas" | "done"; readonly args: Record<string, unknown>; readonly attempt: number };

/**
 * The six actions: the attempt link changes midway (reset_canvas starts attempt 1) and the two
 * no-op-ish actions still carry before/after raster hashes. Invariant: for event i, `beforeHash ==
 * hash(rasterFiles[i])` and `afterHash == hash(rasterFiles[i + 1])` (rasterFiles[0] is the blank).
 */
export const SCRIPTED_EPISODE: readonly ScriptedAction[] = [
	{ tool: "paint", args: { points: [[20, 20], [80, 80], [140, 20]], width: 4 }, attempt: 0 },
	{ tool: "paint", args: { points: [[160, 200], [220, 200]], width: 6 }, attempt: 0 },
	{ tool: "reset_canvas", args: {}, attempt: 1 },
	{ tool: "paint", args: { points: [[40, 128], [216, 128]], width: 8 }, attempt: 1 },
	{ tool: "paint", args: { points: [[128, 40], [128, 216]], width: 8 }, attempt: 1 },
	{ tool: "done", args: {}, attempt: 1 },
];

/**
 * Six actions in ONE attempt, so all six events share the running attempt id: `reset_canvas` bumps the attempt
 * to 1 first, then four `paint`s and `done` stay on it. The reset-first ordering is deliberate.
 */
export const SIX_ACTION_EPISODE: readonly ScriptedAction[] = [
	{ tool: "reset_canvas", args: {}, attempt: 1 },
	{ tool: "paint", args: { points: [[20, 20], [80, 80], [140, 20]], width: 4 }, attempt: 1 },
	{ tool: "paint", args: { points: [[160, 200], [220, 200]], width: 6 }, attempt: 1 },
	{ tool: "paint", args: { points: [[40, 128], [216, 128]], width: 8 }, attempt: 1 },
	{ tool: "paint", args: { points: [[128, 40], [128, 216]], width: 8 }, attempt: 1 },
	{ tool: "done", args: {}, attempt: 1 },
];

/** The production file/function chain the canvas tools write through, quoted in the evidence. */
export const PRODUCTION_WRITE_PATH = [
	"src/elr/canvas.ts recordAction()",
	"src/elr/journal.ts journalFor().recordCanvasAction()",
	"src/elr/journal.ts Journal.recordEvent()",
] as const;

export function scriptedCallIds(): string[] {
	return SCRIPTED_EPISODE.map((_, i) => `rec-${i + 1}`);
}

/**
 * Seed `count` canvas actions (an assistant toolCall entry followed by a tool-result entry) into
 * `dir/agent.sqlite`, the exact shape `deriveCanvasCalls()` reads. Unlike the scripts/ seeder this
 * stamps every event with a deterministic timestamp (`baseTimestamp + i`), so two throwaway stores
 * seeded this way reconcile to byte-identical event rows — the convergence proof compares full
 * per-key payloads across scenarios.
 */
export async function seedSyntheticCanvasTranscript(dir: string, count: number, baseTimestamp: number): Promise<void> {
	await mkdir(dir, { recursive: true });
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, AGENT_DB_FILE)),
		{ models, registry: createRegistry(), onReport: () => {} },
		BACKGROUND_CONTEXT,
	);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT);
		const batch = 250;
		for (let start = 0; start < count; start += batch) {
			const end = Math.min(start + batch, count);
			await conversation.commit(async (tx) => {
				for (let i = start; i < end; i++) {
					const toolCallId = `converge-${i}`;
					await tx.appendEntry(conversation.id, {
						kind: "pi.assistant",
						model: [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: toolCallId, name: "paint", arguments: { points: [[i % 256, 0], [0, i % 256]], width: 3 } }],
							},
						],
					} as never);
					await tx.appendEntry(conversation.id, {
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolCallId,
								toolName: "paint",
								isError: false,
								timestamp: baseTimestamp + i,
								content: [{ type: "text", text: "painted" }],
								details: {
									namespace: "painting",
									version: 1,
									configHash: `seed-${i}`,
									tool: "paint",
									attempt: 0,
									opHash: `op-${i}`,
									beforeHash: `before-${i}`,
									afterHash: `after-${i}`,
								},
							},
						],
					} as never);
				}
			}, BACKGROUND_CONTEXT);
		}
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

export type HarnessBundle = {
	readonly harness: Harness;
	readonly registry: Registry;
	readonly conversation: Conversation;
	readonly conversationId: string;
	readonly dataDir: string;
};

export async function openHarness(dataDir: string): Promise<HarnessBundle> {
	await mkdir(dataDir, { recursive: true });
	const registry = createRegistry();
	registry.install(createCanvasExtension());
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, AGENT_DB_FILE)), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);
	const conversation = await harness.root(BACKGROUND_CONTEXT);
	return { harness, registry, conversation, conversationId: String(conversation.id), dataDir };
}

export function canvasTools(registry: Registry): Map<string, RegisteredTool> {
	const tools = new Map<string, RegisteredTool>();
	for (const entry of registry.snapshot().tools()) {
		const tool = entry.tool as unknown as RegisteredTool;
		tools.set(tool.name, tool);
	}
	return tools;
}

export async function runAction(
	tools: Map<string, RegisteredTool>,
	action: ScriptedAction,
	harness: Harness,
	registry: Registry,
	conversationId: string,
	callId: string,
): Promise<{ isError?: boolean; output?: readonly unknown[]; details?: CanvasToolDetails }> {
	const tool = tools.get(action.tool);
	if (tool === undefined) throw new Error(`tool "${action.tool}" is not registered in the canvas extension`);
	const result = await tool.execute(action.args, makeApi(harness, registry, conversationId, callId), BACKGROUND_CONTEXT);
	return result as { isError?: boolean; output?: readonly unknown[]; details?: CanvasToolDetails };
}

function assistantMessage(call: { id: string; name: string; arguments: unknown }, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.arguments }],
		api: "openrouter" as const,
		provider: "openrouter",
		model: "scripted",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "toolUse" as const,
		timestamp,
	};
}

export async function appendTranscript(
	conversation: Conversation,
	call: { id: string; name: string; arguments: unknown },
	result: { isError?: boolean; output?: readonly unknown[]; details?: unknown },
	timestamp: number,
): Promise<void> {
	await conversation.commit(async (tx) => {
		await tx.appendEntry(AssistantEntry, conversation.id, { model: [assistantMessage(call, timestamp) as never] });
	}, BACKGROUND_CONTEXT);
	await conversation.commit(async (tx) => {
		await tx.appendEntry(ToolResultEntry, conversation.id, {
			model: [
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: (result.output ?? []) as never,
					details: result.details as never,
					isError: result.isError ?? false,
					timestamp,
				} as never,
			],
			data: { diagnostics: [] },
		});
	}, BACKGROUND_CONTEXT);
}


export type EpisodeResult = {
	readonly conversationId: string;
	readonly actions: readonly ScriptedAction[];
	readonly events: readonly JournalEvent[];
	readonly toolCallIds: readonly string[];
	readonly rasterFiles: readonly string[];
	cleanup(): Promise<void>;
};

export async function runToolEpisode(): Promise<EpisodeResult> {
	return runScriptedEpisode(SCRIPTED_EPISODE);
}

export async function runScriptedEpisode(actions: readonly ScriptedAction[], callPrefix = "ep"): Promise<EpisodeResult> {
	const dataDir = await mkdtemp(join(tmpdir(), "elr-episode-"));
	process.env.DATA_DIR = dataDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();

	const registry = createRegistry();
	registry.install(createCanvasExtension());
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(await openNodeSqliteStorage(join(dataDir, "agent.sqlite")), { models, registry, onReport: () => {} }, BACKGROUND_CONTEXT);

	const conversationId = "episode-conversation";
	const rasterDir = join(dataDir, "rasters");
	await mkdir(rasterDir, { recursive: true });

	const installed = registry.snapshot().tools();
	const find = (name: string): RegisteredTool => {
		const entry = installed.find((t) => (t.tool as { name?: string }).name === name);
		if (entry === undefined) throw new Error(`tool "${name}" is not registered in the canvas extension`);
		return entry.tool as unknown as RegisteredTool;
	};
	const view = find("view_canvas");

	const snapshotPng = async (label: string): Promise<{ file: string; hash: string }> => {
		const result = await view.execute({}, makeApi(harness, registry, conversationId, `view-${label}`), BACKGROUND_CONTEXT);
		if (result.isError === true) throw new Error(`view_canvas failed for ${label}: ${textOf(result)}`);
		const image = (result.output ?? []).find((item) => (item as ContentItem).type === "image") as ContentItem | undefined;
		if (image === undefined || typeof image.data !== "string") throw new Error(`view_canvas returned no image for ${label}`);
		const png = Buffer.from(image.data, "base64");
		const file = join(rasterDir, `${label}.png`);
		await writeFile(file, png);
		return { file, hash: sha256Hex(png) };
	};

	const toolCallIds: string[] = [];
	const rasterFiles: string[] = [];

	const closeAll = async (): Promise<void> => {
		try {
			journalFor(join(dataDir, "elr.sqlite")).close();
		} catch {
		}
		resetJournalCache();
		await harness.close(BACKGROUND_CONTEXT);
	};

	try {
		const blank = await snapshotPng("raster-0");
		rasterFiles.push(blank.file);

		for (let i = 0; i < actions.length; i++) {
			const action = actions[i]!;
			const callId = `${callPrefix}-${i + 1}`;
			toolCallIds.push(callId);
			const result = await find(action.tool).execute(action.args, makeApi(harness, registry, conversationId, callId), BACKGROUND_CONTEXT);
			if (result.isError === true) throw new Error(`action ${i + 1} (${action.tool}) failed: ${textOf(result)}`);
			const after = await snapshotPng(`raster-${i + 1}`);
			rasterFiles.push(after.file);
		}

		const journalPath = join(dataDir, "elr.sqlite");
		const events = journalFor(journalPath).listEvents(conversationId);
		return {
			conversationId,
			actions,
			events,
			toolCallIds,
			rasterFiles,
			cleanup: async () => {
				await closeAll();
				await rm(dataDir, { recursive: true, force: true });
			},
		};
	} catch (error) {
		await closeAll();
		await rm(dataDir, { recursive: true, force: true });
		throw error;
	}
}

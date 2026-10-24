// ELR M1 CanvasStep data-path proof.
//
// Proves that a view_canvas tool result actually becomes a `{kind:'canvas'}` step in the web turn
// builder, end to end: the tool mirrors its ordered op list as a fenced `elr-canvas-ops` JSON block,
// and toTurns parses and validates it into a canvas step. No network, no credentials.
//
//   1. Synthetic AG-UI turn: a view_canvas call + result with the ops payload yields a canvas step
//      whose ops deep-equal the payload.
//   2. End-to-end: paint through the real registry, call view_canvas, feed its real result through
//      toTurns, and assert the canvas step's ops equal the doc's ops (hash printed from both sides).
//   3. 128 KB guard: an oversized op list omits the third item, the scorecard says so, and toTurns
//      emits no canvas step and does not throw.
//   4. Malformed payloads (bad JSON / null coordinates / width 0 / over the op cap) emit no canvas
//      step and do not throw.
//   5. STEP_DISPATCH covers every Step kind (the map is printed).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Tx, ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCanvasExtension, CanvasDoc } from "../../src/elr/canvas.ts";
import type { Op } from "../../src/elr/raster.ts";
import { STEP_DISPATCH, toTurns, type AguiMessage, type Step, type Turn } from "../../web/src/lib/turns.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = await mkdtemp(join(tmpdir(), "canvas-step-data-check-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ||= "unused";

const OPS_OMITTED_NOTE = "Ops omitted (canvas too large); see image.";
const OPS_BLOCK_TAG = "elr-canvas-ops";
const MAX_OPS_PAYLOAD_BYTES = 128 * 1024;

const registry = createRegistry();
registry.install(createCanvasExtension());

const models = createModels();
models.setProvider(openrouterProvider());

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function makeApi(harness: Harness, conversationId: number): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId: "canvas-step-data-check",
		registry: registry.snapshot(),
		models,
		env: undefined,
		commit: (change: (tx: Tx) => unknown | Promise<unknown>, ctx: Context) => harness.commit(change, ctx),
		snapshot: (...args: unknown[]) => (harness.snapshot as (...args: unknown[]) => unknown)(...args),
		watchDoc: (...args: unknown[]) => (harness.watchDoc as (...args: unknown[]) => unknown)(...args),
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
		memo: async (...args: unknown[]) => {
			if (args.length === 2) return args[1];
			return undefined;
		},
	} as unknown as ToolExecutionApi;
}

type ToolResult = { output?: readonly { type: string; text?: string }[]; isError?: boolean };

/** Matches agui.ts: the AG-UI tool message carries the concatenation of the result's text items. */
function resultText(result: ToolResult): string {
	return (result.output ?? []).map((item) => (item.type === "text" ? (item.text ?? "") : "")).join("");
}

function canvasSteps(steps: readonly Step[]): Extract<Step, { kind: "canvas" }>[] {
	return steps.filter((step): step is Extract<Step, { kind: "canvas" }> => step.kind === "canvas");
}

/** The agent turn's steps, for the single-agent-turn fixtures this script builds. */
function agentSteps(turns: readonly Turn[]): Step[] {
	const agent = turns.find((turn): turn is Extract<Turn, { kind: "agent" }> => turn.kind === "agent");
	assert.ok(agent, "an agent turn exists");
	return agent.steps;
}

async function openHarness(): Promise<Harness> {
	const storage = await openNodeSqliteStorage(join(dataDir, "canvas.sqlite"));
	return Harness.open(
		storage,
		{ models, registry, onReport: (report: unknown) => console.error("[harness]", report) },
		context,
	);
}

// ── 1. Synthetic turn ───────────────────────────────────────────────────────────────────────────

function checkSyntheticTurn(): void {
	console.log("1. Synthetic AG-UI turn: view_canvas result -> canvas step");
	const payload = {
		canvasId: "synthetic-canvas",
		ops: [
			{ kind: "stroke", points: [[10.12, 20.34], [30.56, 40.78]], width: 6 },
			{ kind: "arc", cx: 128, cy: 128, r: 60, a0: 0, a1: 3.14, width: 4 },
		],
	};
	const result = `Canvas ID: synthetic-canvas\nStrokes: 2\n\n\`\`\`json ${OPS_BLOCK_TAG}\n${JSON.stringify(payload)}\n\`\`\``;
	const messages: AguiMessage[] = [
		{ id: "u1", role: "user", content: "look at the canvas" },
		{ id: "a1", role: "assistant", content: "", toolCalls: [{ id: "call-1", function: { name: "view_canvas", arguments: "{}" } }] },
		{ id: "t1", role: "tool", toolCallId: "call-1", content: result },
	];

	const turns = toTurns(messages);
	assert.equal(turns.length, 2, "one user turn and one agent turn");
	assert.equal(turns[1].kind, "agent", "second turn is the agent's");
	const steps = agentSteps(turns);
	assert.equal(steps.length, 2, "a tool step immediately followed by a canvas step");
	assert.equal(steps[0].kind, "tool", "tool step comes first");
	assert.equal(steps[1].kind, "canvas", "canvas step comes second");
	const canvas = steps[1] as Extract<Step, { kind: "canvas" }>;
	assert.equal(canvas.canvasId, payload.canvasId, "canvasId parsed");
	assert.deepEqual(canvas.ops, payload.ops, "canvas ops deep-equal the payload ops");
	console.log(`   canvasId=${canvas.canvasId}, ops=${canvas.ops.length}, ops hash=${sha256(JSON.stringify(canvas.ops))}`);
	console.log("   PASS: synthetic view_canvas result produced a canvas step with matching ops\n");
}

// ── 2. End-to-end through the registry ─────────────────────────────────────────────────────────

async function checkEndToEnd(): Promise<void> {
	console.log("2. End-to-end: real view_canvas result -> toTurns -> ops equal the doc's ops");
	const harness = await openHarness();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await conversation.configure({ extensions: [createCanvasExtension()] }, context);
		const agent = await conversation.agent(context);
		const tools = agent.tools;
		const canvasId = String(conversation.id);

		const paint = tools.find((t) => t.name === "paint");
		const view = tools.find((t) => t.name === "view_canvas");
		assert.ok(paint && view, "paint and view_canvas are registered");

		const stroke = { points: [[10, 10], [50, 50], [90, 20]] as [number, number][], width: 6 };
		const painted = await paint.execute(stroke as never, makeApi(harness, conversation.id), context);
		assert.ok(!painted.isError, "paint succeeds");

		const viewed = await view.execute({} as never, makeApi(harness, conversation.id), context);
		assert.ok(!viewed.isError, "view_canvas succeeds");
		const items = (viewed.output ?? []) as { type: string; text?: string }[];
		assert.equal(items.length, 3, "view_canvas returns image + scorecard + ops items");
		assert.equal(items[0].type, "image", "first item is the image");
		assert.equal(items[1].type, "text", "second item is the scorecard");
		assert.equal(items[2].type, "text", "third item mirrors the ops");

		const doc = await harness.snapshot(CanvasDoc, canvasId, context);
		assert.ok(doc, "canvas doc exists");
		const docOps = doc.ops as Op[];

		const messages: AguiMessage[] = [
			{ id: "u2", role: "user", content: "view" },
			{ id: "a2", role: "assistant", content: "", toolCalls: [{ id: "call-2", function: { name: "view_canvas", arguments: "{}" } }] },
			{ id: "t2", role: "tool", toolCallId: "call-2", content: resultText(viewed) },
		];
		const turns = toTurns(messages);
		const emitted = canvasSteps(agentSteps(turns));
		assert.equal(emitted.length, 1, "exactly one canvas step emitted");
		assert.equal(emitted[0].canvasId, canvasId, "emitted canvasId matches the doc id");
		assert.deepEqual(emitted[0].ops, docOps, "emitted ops deep-equal the doc's ops");

		const docHash = sha256(JSON.stringify(docOps));
		const emittedHash = sha256(JSON.stringify(emitted[0].ops));
		console.log(`   doc ops hash:     ${docHash}`);
		console.log(`   emitted ops hash: ${emittedHash}`);
		assert.equal(emittedHash, docHash, "the two ops hashes match");
		console.log(`   PASS: real view_canvas result replayed to a canvas step (${emitted[0].ops.length} ops, hash ${docHash})\n`);
	} finally {
		await harness.close(context);
	}
}

// ── 3. The 128 KB guard ───────────────────────────────────────────────────────────────────────

async function checkOversizedGuard(): Promise<void> {
	console.log("3. 128 KB guard: oversized op list omits the ops item and emits no canvas step");
	const harness = await openHarness();
	try {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
		await conversation.configure({ extensions: [createCanvasExtension()] }, context);
		const agent = await conversation.agent(context);
		const paint = agent.tools.find((t) => t.name === "paint");
		const view = agent.tools.find((t) => t.name === "view_canvas");
		assert.ok(paint && view, "paint and view_canvas are registered");

		let totalPoints = 0;
		for (let stroke = 0; stroke < 24; stroke++) {
			const points: [number, number][] = [];
			for (let i = 0; i < 512; i++) {
				points.push([((i * 3 + stroke) % 256) + 0.25, ((i * 7 + stroke) % 256) + 0.75]);
			}
			const result = await paint.execute({ points, width: 4 } as never, makeApi(harness, conversation.id), context);
			assert.ok(!result.isError, `paint ${stroke} succeeds`);
			totalPoints += points.length;
		}

		const viewed = await view.execute({} as never, makeApi(harness, conversation.id), context);
		assert.ok(!viewed.isError, "view_canvas succeeds");
		const items = (viewed.output ?? []) as { type: string; text?: string }[];
		assert.equal(items.length, 2, "oversized canvas returns only image + scorecard (no ops item)");
		const scorecard = items[1].text ?? "";
		assert.ok(scorecard.includes(OPS_OMITTED_NOTE), "scorecard notes the omitted ops");
		const payloadBytes = Buffer.byteLength(
			JSON.stringify({ canvasId: String(conversation.id), ops: (await harness.snapshot(CanvasDoc, String(conversation.id), context))?.ops ?? [] }),
			"utf8",
		);
		assert.ok(payloadBytes > MAX_OPS_PAYLOAD_BYTES, `payload really exceeds the guard (${payloadBytes} bytes)`);
		console.log(`   ${totalPoints} points over 24 strokes; op payload ${payloadBytes} bytes > ${MAX_OPS_PAYLOAD_BYTES}`);

		const messages: AguiMessage[] = [
			{ id: "u3", role: "user", content: "view" },
			{ id: "a3", role: "assistant", content: "", toolCalls: [{ id: "call-3", function: { name: "view_canvas", arguments: "{}" } }] },
			{ id: "t3", role: "tool", toolCallId: "call-3", content: resultText(viewed) },
		];
		let turns: ReturnType<typeof toTurns> | undefined;
		assert.doesNotThrow(() => {
			turns = toTurns(messages);
		}, "toTurns does not throw on an omitted-ops result");
		const emitted = canvasSteps(agentSteps(turns!));
		assert.equal(emitted.length, 0, "no canvas step is emitted when the ops item is omitted");
		console.log(`   scorecard tail: ${JSON.stringify(scorecard.trim().split("\n").at(-1))}`);
		console.log("   PASS: oversized payload omitted, noted, and produced no canvas step\n");
	} finally {
		await harness.close(context);
	}
}

// ── 4. Malformed payloads ─────────────────────────────────────────────────────────────────────

function checkMalformed(): void {
	console.log("4. Malformed payloads emit no canvas step and never throw");
	const fence = (body: string) => `scorecard\n\`\`\`json ${OPS_BLOCK_TAG}\n${body}\n\`\`\``;
	const cases: { label: string; result: string }[] = [
		{ label: "bad JSON", result: fence("{ this is not json") },
		{ label: "null coordinates", result: fence(JSON.stringify({ canvasId: "c", ops: [{ kind: "stroke", points: [[10, 10], [null, null]], width: 6 }] })) },
		{ label: "zero width", result: fence(JSON.stringify({ canvasId: "c", ops: [{ kind: "stroke", points: [[10, 10], [20, 20]], width: 0 }] })) },
		{ label: "non-string canvasId", result: fence(JSON.stringify({ canvasId: 7, ops: [] })) },
		{ label: "ops not an array", result: fence(JSON.stringify({ canvasId: "c", ops: "nope" })) },
		{
			label: "over the 1000-op cap",
			result: fence(JSON.stringify({ canvasId: "c", ops: Array.from({ length: 1001 }, () => ({ kind: "stroke", points: [[1, 1], [2, 2]], width: 2 })) })),
		},
		{ label: "no ops block at all", result: "just a scorecard with no ops" },
	];

	for (const testCase of cases) {
		const messages: AguiMessage[] = [
			{ id: "u", role: "user", content: "view" },
			{ id: "a", role: "assistant", content: "", toolCalls: [{ id: "call", function: { name: "view_canvas", arguments: "{}" } }] },
			{ id: "t", role: "tool", toolCallId: "call", content: testCase.result },
		];
		let turns: ReturnType<typeof toTurns> | undefined;
		assert.doesNotThrow(() => {
			turns = toTurns(messages);
		}, `toTurns must not throw for ${testCase.label}`);
		const steps = agentSteps(turns!);
		assert.equal(canvasSteps(steps).length, 0, `no canvas step for ${testCase.label}`);
		assert.equal(steps.length, 1, `only the tool step for ${testCase.label}`);
		console.log(`   ${testCase.label}: no canvas step, no throw`);
	}
	console.log("   PASS: all malformed payloads ignored safely\n");
}

// ── 5. STEP_DISPATCH coverage ────────────────────────────────────────────────────────────────

function checkDispatch(): void {
	console.log("5. STEP_DISPATCH covers every Step kind");
	const kinds = ["reasoning", "tool", "text", "canvas"] as const;
	for (const kind of kinds) {
		assert.ok(kind in STEP_DISPATCH, `STEP_DISPATCH must wire the "${kind}" step kind`);
		assert.equal(typeof STEP_DISPATCH[kind], "string", `STEP_DISPATCH.${kind} is a component name`);
	}
	assert.deepEqual(Object.keys(STEP_DISPATCH).sort(), [...kinds].sort(), "STEP_DISPATCH has exactly the wired step kinds");
	console.log("   STEP_DISPATCH =", JSON.stringify(STEP_DISPATCH, null, 2).split("\n").join("\n   "));
	console.log("   PASS: every Step kind is dispatched\n");
}

async function main(): Promise<void> {
	console.log("ELR M1 CanvasStep data path\n");
	checkSyntheticTurn();
	await checkEndToEnd();
	await checkOversizedGuard();
	checkMalformed();
	checkDispatch();
	console.log("All canvas step data checks passed.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

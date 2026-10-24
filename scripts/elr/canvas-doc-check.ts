// ELR M1 canvas durable-doc proof script.
// Calls the canvas tools through the registry, reads the doc back from SQLite, and asserts
// replay-safety, atomicity, reset, done, and persistence across a process restart.
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
import { rasterizePng, type Op } from "../../src/elr/raster.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = await mkdtemp(join(tmpdir(), "canvas-doc-check-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ||= "unused";

const registry = createRegistry();
registry.install(createCanvasExtension());

const models = createModels();
models.setProvider(openrouterProvider());

function makeApi(harness: Harness, conversationId: number): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId: "check",
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

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
	const first = result.output?.[0];
	return first?.type === "text" ? first.text ?? "" : "";
}

function hashOps(ops: Op[]): string {
	return createHash("sha256").update(JSON.stringify(ops)).digest("hex").slice(0, 16);
}

function hashPng(ops: Op[]): string {
	return createHash("sha256").update(rasterizePng(ops)).digest("hex").slice(0, 16);
}

type CommitPublication = {
	readonly seq: number;
	readonly changes: readonly unknown[];
};

function documentCommits(publication: CommitPublication): number[] {
	const seqs: number[] = [];
	for (const change of publication.changes as { type?: string; record?: { kind?: string } }[]) {
		if (change.type === "document" && change.record?.kind === "elr.canvas") {
			seqs.push(publication.seq);
			break;
		}
	}
	return seqs;
}

async function openHarness(): Promise<Harness> {
	const storage = await openNodeSqliteStorage(join(dataDir, "canvas.sqlite"));
	return Harness.open(
		storage,
		{
			models,
			registry,
			onReport: (report: unknown) => console.error("[harness]", report),
		},
		context,
	);
}

async function main() {
	console.log(`data dir: ${dataDir}\n`);

	let harness = await openHarness();
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await conversation.configure({ extensions: [createCanvasExtension()] }, context);

	const agent = await conversation.agent(context);
	const tools = agent.tools;

	console.log("Tool definitions (canvas extension via registry):");
	for (const name of ["paint", "reset_canvas", "done"]) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} is registered`);
		console.log(`- ${tool.name}: ${tool.description}`);
		console.log(`  parameters: ${JSON.stringify(tool.parameters)}`);
	}

	const canvasId = String(conversation.id);

	const commitSeqs: number[] = [];
	const unsubscribe = harness.subscribeCommits((publication) => {
		commitSeqs.push(...documentCommits(publication as CommitPublication));
	});

	async function call(name: string, args: unknown) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool);
		return tool.execute(args as never, makeApi(harness, conversation.id), context);
	}

	console.log("\n1. Two valid paints");
	const r1 = await call("paint", {
		points: [
			[10, 10],
			[50, 50],
		],
		width: 8,
	});
	assert.ok(!r1.isError, `paint 1 should succeed: ${textOf(r1)}`);
	console.log(`  paint 1: ${textOf(r1)}`);

	const r2 = await call("paint", {
		points: [
			[100, 100],
			[150, 120],
			[200, 100],
		],
		width: 4,
	});
	assert.ok(!r2.isError, `paint 2 should succeed: ${textOf(r2)}`);
	console.log(`  paint 2: ${textOf(r2)}`);

	let doc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc, "doc exists");
	assert.equal(doc.seq, 2, "seq is 2 after two paints");
	assert.equal(doc.ops.length, 2, "two ops stored");
	console.log(`  -> seq=${doc.seq}, ops=${doc.ops.length}`);
	console.log(`  document commits observed: ${commitSeqs.length} (seqs: ${commitSeqs.join(", ")})`);
	assert.equal(commitSeqs.length, 2, "one durable commit per paint");

	console.log("\n2. Invalid paints leave seq/ops/commits unchanged");
	const beforeSeq = doc.seq;
	const beforeOps = doc.ops.length;
	const beforeCommits = commitSeqs.length;

	for (const bad of [
		{ points: [[10, 10], [NaN, 50]], width: 8 },
		{ points: [[10, 10], [300, 50]], width: 8 },
		{ points: [[10, 10]], width: 8 },
		{ points: [[10, 10], [50, 50]], width: 128 },
	]) {
		const res = await call("paint", bad);
		assert.equal(res.isError, true, `expected error for ${JSON.stringify(bad)}`);
		console.log(`  rejected: ${textOf(res)}`);
	}

	doc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc);
	assert.equal(doc.seq, beforeSeq, "seq unchanged after invalid paints");
	assert.equal(doc.ops.length, beforeOps, "ops unchanged after invalid paints");
	assert.equal(commitSeqs.length, beforeCommits, "no durable commits for invalid paints");
	console.log("  -> seq/ops/commits unchanged, no writes");

	console.log("\n3. Replay hashes before closing the store");
	const opsHashBefore = hashOps(doc.ops);
	const pngHashBefore = hashPng(doc.ops);
	console.log(`  ops hash: ${opsHashBefore}`);
	console.log(`  replay (PNG) hash: ${pngHashBefore}`);

	console.log("\n4. Re-instantiate the store from SQLite");
	unsubscribe();
	await harness.close(context);
	harness = await openHarness();
	const conversation2 = await harness.conversation(conversation.id, context);
	assert.ok(conversation2, "conversation survives restart");
	doc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc, "doc survives restart");
	assert.equal(doc.seq, 2, "seq still 2 after restart");
	assert.equal(doc.ops.length, 2, "ops still 2 after restart");
	const opsHashAfter = hashOps(doc.ops);
	const pngHashAfter = hashPng(doc.ops);
	console.log(`  reopened ops hash: ${opsHashAfter}`);
	console.log(`  reopened replay (PNG) hash: ${pngHashAfter}`);
	assert.equal(opsHashBefore, opsHashAfter, "ops hash matches after restart");
	assert.equal(pngHashBefore, pngHashAfter, "replay PNG hash matches after restart");

	const commitSeqs2: number[] = [];
	const unsubscribe2 = harness.subscribeCommits((publication) => {
		commitSeqs2.push(...documentCommits(publication as CommitPublication));
	});

	console.log("\n5. reset_canvas clears ops and bumps attempt");
	const rReset = await call("reset_canvas", {});
	assert.ok(!rReset.isError, `reset should succeed: ${textOf(rReset)}`);
	console.log(`  reset: ${textOf(rReset)}`);
	doc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc);
	assert.deepEqual(doc.ops, [], "ops are empty after reset");
	assert.equal(doc.attempt, 1, "attempt incremented after reset");
	assert.equal(doc.closed, false, "canvas reopened after reset");
	console.log(`  -> ops=${doc.ops.length}, attempt=${doc.attempt}, closed=${doc.closed}`);
	console.log(`  document commits observed: ${commitSeqs2.length}`);
	assert.equal(commitSeqs2.length, 1, "reset performs one durable commit");

	console.log("\n6. done closes the episode");
	const rDone = await call("done", {});
	assert.ok(!rDone.isError, `done should succeed: ${textOf(rDone)}`);
	console.log(`  done: ${textOf(rDone)}`);
	doc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc);
	assert.equal(doc.closed, true, "episode is closed");
	console.log(`  -> closed=${doc.closed}`);
	assert.equal(commitSeqs2.length, 2, "done performs one durable commit");

	console.log("\n7. Paint rejected after done");
	const rAfterDone = await call("paint", {
		points: [
			[1, 1],
			[2, 2],
		],
		width: 2,
	});
	assert.equal(rAfterDone.isError, true, "paint after done is rejected");
	console.log(`  rejected: ${textOf(rAfterDone)}`);

	unsubscribe2();
	await harness.close(context);

	console.log("\nAll canvas doc checks passed.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

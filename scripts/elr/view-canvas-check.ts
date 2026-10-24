// ELR M1 view_canvas proof script.
// Calls view_canvas through the tool registry (via an ownerless conversation configured with the canvas
// extension), asserts the returned content array contains a real PNG image item and a neutral text
// scorecard, and verifies the advertised bytes hash to the direct rasterisation of the doc ops.
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

function deltaSince(start: number, seqs: number[]): number {
	return seqs.length - start;
}
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCanvasExtension, CanvasDoc } from "../../src/elr/canvas.ts";
import { rasterizePng } from "../../src/elr/raster.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = await mkdtemp(join(tmpdir(), "view-canvas-check-"));
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
	return first?.type === "text" ? (first.text ?? "") : "";
}

function hashBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

const FORBIDDEN_RE = /score|reward|points|passed|success|percent/gi;
const ALLOWED_SENTENCE = "Scoring and deterministic verification arrive in M2.";

function assertNeutralScorecard(content: unknown, scorecardText: string) {
	assert.ok(scorecardText.includes(ALLOWED_SENTENCE), `scorecard must state "${ALLOWED_SENTENCE}"`);

	// Sanitise the serialised result by replacing image base64 payloads so that random
	// base64 substrings (e.g. "score") are not mistaken for forbidden words. The mirrored
	// elr-canvas-ops block is machine data (it carries an op's "points" key), not scorecard
	// prose, so it is blanked the same way before the neutral-vocabulary scan.
	const sanitised = JSON.stringify(content, (_key, value) => {
		if (value && typeof value === "object" && "type" in value) {
			const item = value as { type: string; data?: unknown; text?: string };
			if (item.type === "image" && "data" in item) {
				return { ...(value as object), data: "<image-data>" };
			}
			if (item.type === "text" && typeof item.text === "string" && item.text.includes("elr-canvas-ops")) {
				return { ...(value as object), text: "<elr-canvas-ops>" };
			}
		}
		return value;
	});

	const matches: { index: number; text: string }[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(FORBIDDEN_RE.source, FORBIDDEN_RE.flags);
	while ((match = re.exec(sanitised)) !== null) {
		matches.push({ index: match.index, text: match[0] });
	}

	for (const m of matches) {
		const start = Math.max(0, m.index - 40);
		const end = Math.min(sanitised.length, m.index + m.text.length + 40);
		const contextSlice = sanitised.slice(start, end);
		assert.ok(
			contextSlice.toLowerCase().includes(ALLOWED_SENTENCE.toLowerCase()),
			`forbidden word "${m.text}" found outside the allowed M2 sentence: ...${contextSlice}...`,
		);
	}
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

	const harness = await openHarness();
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	await conversation.configure({ extensions: [createCanvasExtension()] }, context);

	const agent = await conversation.agent(context);
	const tools = agent.tools;

	console.log("Tool definitions (canvas extension via registry):");
	for (const name of ["paint", "view_canvas", "reset_canvas", "done"]) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} is registered`);
		console.log(`- ${tool.name}: ${tool.description.slice(0, 120)}`);
	}

	async function call(name: string, args: unknown) {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `tool ${name} exists in registry`);
		return tool.execute(args as never, makeApi(harness, conversation.id), context);
	}

	const canvasId = String(conversation.id);

	const commitSeqs: number[] = [];
	const unsubscribe = harness.subscribeCommits((publication) => {
		commitSeqs.push(...documentCommits(publication as CommitPublication));
	});
	let viewCommits = 0;
	let paintCommits = 0;
	let resetCommits = 0;

	console.log("\n1. view_canvas on an empty canvas");
	let before = commitSeqs.length;
	const emptyView = await call("view_canvas", {});
	viewCommits += deltaSince(before, commitSeqs);
	assert.ok(!emptyView.isError, `view_canvas failed: ${textOf(emptyView)}`);
	console.log("   view_canvas result (content array):");
	console.log(JSON.stringify(emptyView.output, null, 2));

	assert.ok(Array.isArray(emptyView.output), "output is a content array");
	assert.equal(emptyView.output?.length, 2, "output has image + text");

	const emptyImage = emptyView.output?.[0];
	assert.ok(emptyImage && typeof emptyImage === "object" && "type" in emptyImage && emptyImage.type === "image", "first item is an image");
	assert.equal((emptyImage as { mimeType?: string }).mimeType, "image/png", "image mimeType is image/png");
	const emptyImageData = (emptyImage as { data?: unknown }).data;
	assert.ok(typeof emptyImageData === "string" && emptyImageData.length > 0, "image data is a non-empty base64 string");
	const emptyPng = Buffer.from(emptyImageData, "base64");
	assert.ok(emptyPng.length >= 8, "decoded PNG has bytes");
	assert.equal(emptyPng[0], 0x89);
	assert.equal(emptyPng[1], 0x50);
	assert.equal(emptyPng[2], 0x4e);
	assert.equal(emptyPng[3], 0x47);

	const emptyText = emptyView.output?.[1];
	assert.ok(emptyText && typeof emptyText === "object" && "type" in emptyText && emptyText.type === "text", "second item is text");
	const emptyScorecard = (emptyText as { text?: string }).text ?? "";
	console.log("\n   scorecard text:\n" + emptyScorecard.split("\n").map((l) => "   " + l).join("\n"));

	const emptyDoc = await harness.snapshot(CanvasDoc, canvasId, context);
	const emptyOps = emptyDoc?.ops ?? [];
	console.log(`   canvas doc exists: ${emptyDoc !== undefined}`);
	const emptyExpectedHash = hashBytes(rasterizePng(emptyOps, 256));
	const emptyActualHash = hashBytes(emptyPng);
	console.log(`   direct raster hash: ${emptyExpectedHash}`);
	console.log(`   advertised PNG hash: ${emptyActualHash}`);
	assert.equal(emptyActualHash, emptyExpectedHash, "empty canvas PNG hash matches direct rasterisation");
	assert.ok(emptyScorecard.includes("Strokes: 0"), "empty scorecard shows 0 strokes");
	assert.ok(emptyScorecard.includes(`Canvas ID: ${canvasId}`), "empty scorecard shows the canvas id");
	assertNeutralScorecard(emptyView.output, emptyScorecard);

	console.log("\n2. Paint, then view_canvas");
	before = commitSeqs.length;
	const paintResult = await call("paint", {
		points: [
			[10, 10],
			[50, 50],
			[90, 20],
		],
		width: 6,
	});
	assert.ok(!paintResult.isError, `paint failed: ${textOf(paintResult)}`);
	paintCommits += deltaSince(before, commitSeqs);
	console.log(`   paint: ${textOf(paintResult)}`);

	before = commitSeqs.length;
	const paintedView = await call("view_canvas", {});
	viewCommits += deltaSince(before, commitSeqs);
	assert.ok(!paintedView.isError, `view_canvas failed: ${textOf(paintedView)}`);
	assert.equal(paintedView.output?.length, 3, "painted result has image + scorecard + ops");
	const paintedImage = paintedView.output?.[0];
	assert.ok(paintedImage && typeof paintedImage === "object" && "type" in paintedImage && paintedImage.type === "image");
	const paintedPng = Buffer.from((paintedImage as { data: string }).data, "base64");
	const paintedText = paintedView.output?.[1];
	assert.ok(paintedText && typeof paintedText === "object" && "type" in paintedText && paintedText.type === "text");
	const paintedScorecard = (paintedText as { text?: string }).text ?? "";
	assert.ok(paintedScorecard.includes(ALLOWED_SENTENCE), "painted scorecard carries the M2 sentence");
	const paintedOps = paintedView.output?.[2];
	assert.ok(paintedOps && typeof paintedOps === "object" && "type" in paintedOps && paintedOps.type === "text", "third item mirrors the ops");
	assert.ok(
		(paintedOps as { text?: string }).text?.includes("```json elr-canvas-ops"),
		"third item is the tagged elr-canvas-ops JSON block",
	);

	const paintedDoc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(paintedDoc, "canvas doc exists after paint");
	const paintedExpectedHash = hashBytes(rasterizePng(paintedDoc.ops, 256));
	const paintedActualHash = hashBytes(paintedPng);
	console.log(`   direct raster hash: ${paintedExpectedHash}`);
	console.log(`   advertised PNG hash: ${paintedActualHash}`);
	assert.equal(paintedActualHash, paintedExpectedHash, "painted canvas PNG hash matches direct rasterisation");
	assert.ok(paintedScorecard.includes("Strokes: 1"), "painted scorecard shows 1 stroke");
	assert.notEqual(paintedActualHash, emptyActualHash, "painted canvas hash differs from empty canvas hash");
	assertNeutralScorecard(paintedView.output, paintedScorecard);

	console.log("\n3. reset_canvas, then view_canvas");
	before = commitSeqs.length;
	const resetResult = await call("reset_canvas", {});
	assert.ok(!resetResult.isError, `reset_canvas failed: ${textOf(resetResult)}`);
	resetCommits += deltaSince(before, commitSeqs);
	console.log(`   reset: ${textOf(resetResult)}`);

	before = commitSeqs.length;
	const resetView = await call("view_canvas", {});
	viewCommits += deltaSince(before, commitSeqs);
	assert.ok(!resetView.isError, `view_canvas after reset failed: ${textOf(resetView)}`);
	const resetImage = resetView.output?.[0];
	assert.ok(resetImage && typeof resetImage === "object" && "type" in resetImage && resetImage.type === "image");
	const resetPng = Buffer.from((resetImage as { data: string }).data, "base64");
	const resetText = resetView.output?.[1];
	assert.ok(resetText && typeof resetText === "object" && "type" in resetText && resetText.type === "text");
	const resetScorecard = (resetText as { text?: string }).text ?? "";

	const resetDoc = await harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(resetDoc, "canvas doc exists after reset");
	const resetExpectedHash = hashBytes(rasterizePng(resetDoc.ops, 256));
	const resetActualHash = hashBytes(resetPng);
	console.log(`   direct raster hash: ${resetExpectedHash}`);
	console.log(`   advertised PNG hash: ${resetActualHash}`);
	assert.equal(resetActualHash, resetExpectedHash, "post-reset canvas PNG hash matches direct rasterisation");
	assert.ok(resetScorecard.includes("Strokes: 0"), "post-reset scorecard shows 0 strokes");
	assert.ok(resetScorecard.includes("Attempt: 1"), "post-reset scorecard shows attempt 1");
	assert.notEqual(resetActualHash, paintedActualHash, "post-reset image hash differs from pre-reset painted hash");
	assertNeutralScorecard(resetView.output, resetScorecard);

	console.log("\n4. Commit-count accounting");
	unsubscribe();
	console.log(`   view_canvas commits: ${viewCommits}`);
	console.log(`   paint commits: ${paintCommits}`);
	console.log(`   reset_canvas commits: ${resetCommits}`);
	console.log(`   canvas-doc commits observed: ${commitSeqs.length} (seqs: ${commitSeqs.join(", ")})`);
	assert.equal(viewCommits, 0, "three view_canvas calls produce zero durable commits");
	assert.equal(paintCommits, 1, "paint produces exactly one durable commit");
	assert.equal(resetCommits, 1, "reset_canvas produces exactly one durable commit");

	await harness.close(context);

	console.log("\nAll view_canvas checks passed.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

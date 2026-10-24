// ELR M1 proof: the canvas extension is actually installed in the live agent.
//
// Unlike the other M1 proof scripts, which build their own registry, this one opens the real
// Agent exactly as src/agent.ts does (Agent.open()), asks the root conversation to resolve its
// agent, and prints the tool list the owner's agent is offered. It then asserts the four canvas
// tools are present with their painting identity strings, and that viewing a canvas whose doc
// does not exist yet returns a blank canvas instead of an error.
//
// It needs no network and no OPENROUTER_API_KEY (Agent.open() only stores the provider).
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Agent as AgentType } from "../../src/agent.ts";

const dataDir = await mkdtemp(join(tmpdir(), "agent-tools-check-"));
process.env.DATA_DIR = dataDir;
process.env.PORT = "0";
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "agent-tools-bootstrap";

// Import the app only after the environment above is set: config reads DATA_DIR at import time.
const { Agent } = await import("../../src/agent.ts");

const CANVAS_TOOLS = ["paint", "view_canvas", "reset_canvas", "done"] as const;

type ContentItem = { readonly type: string; readonly mimeType?: string; readonly data?: string; readonly text?: string };
type LiveTool = {
	readonly name: string;
	readonly description: string;
	execute(
		args: unknown,
		api: ToolExecutionApi,
		context: Context,
	): Promise<{ isError?: boolean; output?: readonly ContentItem[] }>;
};

function makeApi(harness: AgentType["harness"], conversationId: string): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId: "agent-tools-check",
		registry: {} as never,
		models: {} as never,
		env: undefined,
		commit: (change: (tx: Tx) => unknown | Promise<unknown>, ctx: Context) => harness.commit(change, ctx),
		snapshot: (...args: unknown[]) => (harness.snapshot as (...a: unknown[]) => unknown)(...args),
		watchDoc: () => () => {},
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

async function main(): Promise<void> {
	console.log(`data dir: ${dataDir}\n`);
	const agent = await Agent.open();
	try {
		// Resolve the root conversation's agent: the exact extension list src/agent.ts installs.
		const resolved = await agent.root.agent(BACKGROUND_CONTEXT);
		const live = resolved.tools as unknown as LiveTool[];
		const names = live.map((tool) => tool.name);
		console.log(`live agent ("root") offers ${names.length} tools:`);
		for (const name of names) console.log(`   - ${name}`);

		console.log("\ncanvas tool identities:");
		for (const name of CANVAS_TOOLS) {
			const tool = live.find((candidate) => candidate.name === name);
			assert.ok(tool, `the live agent must offer the canvas tool "${name}"`);
			const identity = tool.description.split(". ")[0]!;
			const pattern = new RegExp(`^namespace:painting\\|name:${name}\\|version:1\\|configHash:[0-9a-f]+$`);
			assert.ok(pattern.test(identity), `${name} description must carry its painting identity, got: ${identity}`);
			console.log(`   ${name}\n      ${identity}`);
		}

		// View a canvas whose durable doc does not exist yet: must be a blank canvas, not an error.
		const canvasId = "agent-tools-never-painted";
		const doc = await agent.harness.snapshot(
			(await import("../../src/elr/canvas.ts")).CanvasDoc,
			canvasId,
			BACKGROUND_CONTEXT,
		);
		assert.equal(doc, undefined, "the canvas doc must not exist before the view");
		const view = live.find((candidate) => candidate.name === "view_canvas")!;
		const result = await view.execute({}, makeApi(agent.harness, canvasId), BACKGROUND_CONTEXT);
		assert.ok(!result.isError, `view_canvas of a missing canvas errored: ${JSON.stringify(result.output)}`);
		const items = result.output ?? [];
		const image = items.find((item) => item.type === "image");
		const text = items.find((item) => item.type === "text")?.text ?? "";
		assert.ok(image, "view_canvas must return an image content item");
		assert.equal(image.mimeType, "image/png", "the image must be image/png");
		assert.ok((image.data ?? "").length > 0, "the image must carry base64 data");
		assert.match(text, /Strokes: 0/, "the blank canvas scorecard must report zero strokes");
		console.log(`\nview_canvas on a canvas with no doc -> items=[${items.map((item) => item.type).join(", ")}], ${text.split("\n")[2]}`);

		console.log("\nAll agent tool checks passed.");
	} finally {
		await agent.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

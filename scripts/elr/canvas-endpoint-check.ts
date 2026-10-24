// ELR M1 GET /api/elr/canvas/:id.png proof script.
// Boots the app on an ephemeral port with a throwaway data dir, enrols a passkey
// session, paints through the canvas tool, then exercises the PNG endpoint.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import type { Agent as AgentType } from "../../src/agent.ts";
import { TestAuthenticator } from "../test-authenticator.ts";

const context = BACKGROUND_CONTEXT;
const dataDir = await mkdtemp(join(tmpdir(), "canvas-endpoint-check-"));
process.env.DATA_DIR = dataDir;
process.env.PORT = "0";
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "canvas-endpoint-bootstrap";

// Import app modules only after the environment above is set, so config reads
// the throwaway DATA_DIR and ephemeral PORT.
const { Agent } = await import("../../src/agent.ts");
const { ownerAuth } = await import("../../src/auth.ts");
const { config } = await import("../../src/config.ts");
const { startHttp } = await import("../../src/http.ts");
const { createCanvasExtension, CanvasDoc } = await import("../../src/elr/canvas.ts");
const { rasterizePng } = await import("../../src/elr/raster.ts");

function textOf(result: { output?: readonly { type: string; text?: string }[] }): string {
	const first = result.output?.[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

function makeApi(harness: AgentType["harness"], conversationId: string): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId: "check",
		registry: {} as never,
		models: {} as never,
		env: undefined,
		commit: (change: (tx: Tx) => unknown | Promise<unknown>, ctx: Context) => harness.commit(change, ctx),
		snapshot: () => {
			throw new Error("not implemented");
		},
		watchDoc: () => {
			return () => {};
		},
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

async function main() {
	console.log(`data dir: ${dataDir}\n`);

	const agent = await Agent.open();
	const server = startHttp(agent);
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "server bound to a port");
	const port = address.port;
	const base = `http://localhost:${port}`;
	const origin = config.auth.origins[0]!;

	// 1. Unauthenticated request is rejected.
	{
		const res = await fetch(`${base}/api/elr/canvas/test-001.png`);
		console.log(`1. GET without session cookie -> ${res.status}`);
		assert.equal(res.status, 401);
	}

	// 2. Create an owner session by enrolling a passkey.
	const device = new TestAuthenticator(ownerAuth.rpID, origin);
	const cookieHeaders: string[] = [];
	const authRes = {
		setHeader: (name: string, value: string | string[]) => {
			if (name.toLowerCase() === "set-cookie") {
				cookieHeaders.push(...(Array.isArray(value) ? value : [value]));
			}
		},
	} as unknown as ServerResponse;
	const { recoveryCodes } = await ownerAuth.register(authRes, {
		response: device.register(await ownerAuth.registrationOptions()),
		name: "Test Endpoint",
	});
	assert.ok(recoveryCodes && recoveryCodes.length === 8, "registration yields recovery codes");
	const cookieMatch = /agent_session=([^;]+)/.exec(cookieHeaders.join("; "));
	assert.ok(cookieMatch, "registration sets a session cookie");
	const sessionCookie = cookieMatch[1]!;
	console.log(`   owner session created: ${sessionCookie.slice(0, 8)}...`);

	// Paint a known stroke set through the canvas tool.
	const canvasId = "test-canvas-001";
	const extension = createCanvasExtension();
	const tools = (extension as { tools: typeof extension.tools }).tools;
	assert.ok(Array.isArray(tools), "extension exposes tools");
	const paintTool = tools.find((t: { name: string }) => t.name === "paint");
	assert.ok(paintTool, "paint tool exists");
	const api = makeApi(agent.harness, canvasId);
	const stroke1 = { points: [[10, 10], [50, 50], [90, 20]], width: 6 };
	const stroke2 = { points: [[200, 200], [220, 240]], width: 4 };
	const result1 = await paintTool.execute(stroke1 as never, api, context);
	const result2 = await paintTool.execute(stroke2 as never, api, context);
	assert.ok(!result1.isError, `paint 1 failed: ${textOf(result1)}`);
	assert.ok(!result2.isError, `paint 2 failed: ${textOf(result2)}`);
	console.log(`   painted: ${textOf(result1)}; ${textOf(result2)}`);

	const doc = await agent.harness.snapshot(CanvasDoc, canvasId, context);
	assert.ok(doc, "canvas doc exists");
	const expectedPng = Buffer.from(rasterizePng(doc.ops, 256));
	const expectedHash = createHash("sha256").update(expectedPng).digest("hex");
	console.log(`   expected PNG sha256: ${expectedHash}`);

	// GET the PNG and compare to a direct rasterisation.
	const headers = { cookie: `agent_session=${sessionCookie}` };
	const get = await fetch(`${base}/api/elr/canvas/${canvasId}.png`, { headers });
	console.log(`2. GET with session -> ${get.status}, content-type: ${get.headers.get("content-type")}`);
	assert.equal(get.status, 200);
	assert.equal(get.headers.get("content-type"), "image/png");
	const body = Buffer.from(await get.arrayBuffer());
	assert.ok(body.length >= 8, "PNG has a header");
	assert.equal(body[0], 0x89);
	assert.equal(body[1], 0x50);
	assert.equal(body[2], 0x4e);
	assert.equal(body[3], 0x47);
	const bodyHash = createHash("sha256").update(body).digest("hex");
	assert.equal(bodyHash, expectedHash, "endpoint PNG matches direct rasterisation");
	const etag = get.headers.get("etag") ?? "";
	console.log(`   ETag: ${etag}, body sha256: ${bodyHash}`);

	// 3. If-None-Match with the ETag returns 304.
	{
		const cached = await fetch(`${base}/api/elr/canvas/${canvasId}.png`, {
			headers: { ...headers, "if-none-match": etag },
		});
		console.log(`3. If-None-Match ${etag} -> ${cached.status}`);
		assert.equal(cached.status, 304);
	}

	// Unknown but well-formed id returns 404.
	{
		const unknown = await fetch(`${base}/api/elr/canvas/unknown-id.png`, { headers });
		const unknownBody = await unknown.text();
		console.log(`4a. unknown id -> ${unknown.status}, body: ${unknownBody.slice(0, 120)}`);
		assert.equal(unknown.status, 404);
		assert.ok(!unknownBody.includes("ENOENT") && !unknownBody.includes("/etc/passwd"), "no file contents in 404 body");
	}

	// Traversal/id with encoded dots/slashes is rejected and leaks no files.
	{
		const traversal = await fetch(`${base}/api/elr/canvas/%2e%2e%2fsecret.png`, { headers });
		const traversalBody = await traversal.text();
		console.log(`4b. traversal id -> ${traversal.status}, body: ${traversalBody.slice(0, 120)}`);
		assert.ok(traversal.status === 400 || traversal.status === 404, `traversal id rejected: ${traversal.status}`);
		assert.ok(
			!traversalBody.includes("ENOENT") && !traversalBody.includes("/etc/passwd") && !traversalBody.includes("package.json"),
			"no file contents in traversal response",
		);
	}

	// Receiving the same canvas twice yields identical bytes.
	{
		const get2 = await fetch(`${base}/api/elr/canvas/${canvasId}.png`, { headers });
		const body2 = Buffer.from(await get2.arrayBuffer());
		const hash2 = createHash("sha256").update(body2).digest("hex");
		console.log(`5. second GET hash: ${hash2}`);
		assert.equal(hash2, bodyHash, "repeated GET returns identical bytes");
	}

	console.log("\nAll canvas endpoint checks passed.");

	await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	await agent.close();
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

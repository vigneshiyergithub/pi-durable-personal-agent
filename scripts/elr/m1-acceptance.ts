// ELR M1 end-to-end acceptance proof (spec docs/elr-canvas-spec.md §9 M1).
//
// One re-runnable script that exercises the real paths — the real tool registry, the real durable
// SQLite store, and the real HTTP server — and prints one "PASS <n>: ..." line per acceptance
// criterion with the observed values. It exits non-zero on the first failure.
//
// It needs no network and no OPENROUTER_API_KEY. Blocks:
//   1. Determinism: same op list rasterised twice in-process and once in a child process.
//   2. No native image dependencies: npm ls capture + package.json/locks unchanged vs origin/master.
//   3. view_canvas through the registry returns an image content item (image/png).
//   4. Restart survival: process A paints, a separate process B reopens the store and views it.
//   5. HTTP: unauthenticated 401, authenticated 200 image/png with the block-4 hash.
//   6. Repo gates: typecheck, web build and smoke all exit 0.
//
// Child mode (used for the genuine cross-process blocks): `--child raster|paint|view ...`.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type { Registry, ToolExecutionApi, Tx } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCanvasExtension, CanvasDoc } from "../../src/elr/canvas.ts";
import { rasterizePng, type Op } from "../../src/elr/raster.ts";
import { TestAuthenticator } from "../test-authenticator.ts";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const selfPath = fileURLToPath(import.meta.url);
const CHILD_PREFIX = "M1_CHILD_RESULT ";

process.env.OPENROUTER_API_KEY ||= "unused";

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────────

// One fixed op list: several strokes plus an arc (block 1).
const FIXTURE_OPS: Op[] = [
	{ kind: "stroke", points: [[40, 40], [90, 90], [140, 40]], width: 8 },
	{ kind: "stroke", points: [[200, 200], [220, 180], [240, 200]], width: 4 },
	{ kind: "stroke", points: [[30, 220], [80, 210], [130, 230], [180, 215]], width: 6 },
	{ kind: "arc", cx: 128, cy: 128, r: 70, a0: 0, a1: Math.PI, width: 5 },
];

// The stroke-only set process A paints through the `paint` tool (block 4).
const STROKE_SET: { points: [number, number][]; width: number }[] = [
	{ points: [[40, 40], [90, 90], [140, 40]], width: 8 },
	{ points: [[200, 200], [220, 180], [240, 200]], width: 4 },
];
const EXPECTED_OPS: Op[] = STROKE_SET.map((s) => ({ kind: "stroke", points: s.points, width: s.width }));

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

type ContentItem = { readonly type: string; readonly mimeType?: string; readonly data?: string; readonly text?: string };

function contentOf(result: { output?: readonly unknown[] }): ContentItem[] {
	return (result.output ?? []) as unknown as ContentItem[];
}

function textOf(result: { output?: readonly unknown[] }): string {
	const first = contentOf(result)[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

// ── Real registry + durable store ───────────────────────────────────────────────────────────────

type RegisteredTool = {
	readonly name: string;
	execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<{ isError?: boolean; output?: readonly unknown[] }>;
};

type OpenTools = {
	harness: Harness;
	registry: Registry;
	find(name: string): RegisteredTool;
};

async function openTools(dataDir: string): Promise<OpenTools> {
	const registry = createRegistry();
	registry.install(createCanvasExtension());
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dataDir, "agent.sqlite")),
		{ models, registry, onReport: () => {} },
		BACKGROUND_CONTEXT,
	);
	const installed = registry.snapshot().tools();
	const find = (name: string): RegisteredTool => {
		const entry = installed.find((t) => (t.tool as { name?: string }).name === name);
		assert.ok(entry, `tool "${name}" is registered in the canvas extension`);
		return entry.tool as unknown as RegisteredTool;
	};
	return { harness, registry, find };
}

function makeApi(harness: Harness, registry: Registry, conversationId: string): ToolExecutionApi {
	return {
		conversationId: conversationId as never,
		taskId: 0 as never,
		callId: "m1-acceptance",
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

// ── Child process plumbing ──────────────────────────────────────────────────────────────────────

type ChildResult = { code: number; stdout: string; stderr: string };

function runChild(mode: string, args: string[]): Promise<ChildResult> {
	return new Promise((resolve) => {
		const proc = spawn(process.execPath, [selfPath, "--child", mode, ...args], { cwd: repoRoot });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

function parseChild(result: ChildResult, label: string): Record<string, unknown> {
	assert.equal(result.code, 0, `${label} exited ${result.code}: ${result.stderr || result.stdout}`);
	const line = result.stdout.split("\n").find((l) => l.startsWith(CHILD_PREFIX));
	assert.ok(line, `${label} printed no result line.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	return JSON.parse(line.slice(CHILD_PREFIX.length)) as Record<string, unknown>;
}

function emit(value: unknown): void {
	process.stdout.write(`\n${CHILD_PREFIX}${JSON.stringify(value)}\n`);
}

async function childMain(mode: string, args: string[]): Promise<void> {
	if (mode === "raster") {
		const ops = JSON.parse(Buffer.from(args[0]!, "base64").toString("utf8")) as Op[];
		emit({ pid: process.pid, hash: sha256(rasterizePng(ops)) });
		return;
	}
	const [dataDir, canvasId] = args as [string, string];
	const { harness, registry, find } = await openTools(dataDir);
	try {
		if (mode === "paint") {
			const paint = find("paint");
			for (const stroke of STROKE_SET) {
				const result = await paint.execute(stroke, makeApi(harness, registry, canvasId), BACKGROUND_CONTEXT);
				if (result.isError) throw new Error(`paint failed: ${textOf(result)}`);
			}
			const doc = await harness.snapshot(CanvasDoc, canvasId, BACKGROUND_CONTEXT);
			const ops = (doc?.ops ?? []) as Op[];
			emit({
				pid: process.pid,
				canvasId,
				strokes: ops.length,
				opsHash: sha256(JSON.stringify(ops)),
				pngHash: sha256(rasterizePng(ops)),
			});
			return;
		}
		if (mode === "view") {
			const view = find("view_canvas");
			const result = await view.execute({}, makeApi(harness, registry, canvasId), BACKGROUND_CONTEXT);
			if (result.isError) throw new Error(`view_canvas failed: ${textOf(result)}`);
			const items = contentOf(result);
			const image = items.find((i) => i.type === "image");
			if (image === undefined || typeof image.data !== "string") throw new Error("view_canvas returned no image content");
			const png = Buffer.from(image.data, "base64");
			emit({ pid: process.pid, canvasId, types: items.map((i) => i.type), pngHash: sha256(png) });
			return;
		}
		throw new Error(`unknown child mode: ${mode}`);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

// ── Block helpers ───────────────────────────────────────────────────────────────────────────────

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<ChildResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, { cwd: options.cwd ?? repoRoot, env: options.env ?? process.env });
		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => (stderr += d));
		proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

function tail(text: string, lines = 12): string {
	const parts = text.trim().split("\n");
	return parts.slice(-lines).join("\n");
}

// ── The six blocks ──────────────────────────────────────────────────────────────────────────────

async function block1(): Promise<void> {
	console.log("1. Determinism: one op list, rasterised twice in-process and once in a child process");
	const h1 = sha256(rasterizePng(FIXTURE_OPS));
	const h2 = sha256(rasterizePng(FIXTURE_OPS));
	const child = await runChild("raster", [Buffer.from(JSON.stringify(FIXTURE_OPS)).toString("base64")]);
	const parsed = parseChild(child, "raster child");
	const h3 = String(parsed.hash);
	console.log(`   in-process #1:      ${h1}`);
	console.log(`   in-process #2:      ${h2}`);
	console.log(`   child process (pid ${parsed.pid}): ${h3}`);
	assert.equal(h1, h2, "two in-process rasterisations must be byte-identical");
	assert.equal(h1, h3, "the child-process rasterisation must match");
	assert.notEqual(parsed.pid, process.pid, "the third hash must come from a distinct process");
	console.log(`PASS 1: three SHA-256 hashes equal (${h1})`);
}

async function block2(): Promise<void> {
	console.log("\n2. No native image dependencies");
	let npmOutput = "";
	let npmExit = 0;
	try {
		npmOutput = execFileSync("npm", ["ls", "canvas", "skia-canvas", "sharp"], { encoding: "utf8", cwd: repoRoot });
	} catch (error) {
		const e = error as { status?: number; stdout?: string; stderr?: string; message?: string };
		npmExit = e.status ?? 1;
		npmOutput = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message || "";
	}
	console.log(`   $ npm ls canvas skia-canvas sharp   (exit ${npmExit})`);
	for (const line of npmOutput.trim().split("\n")) console.log(`   | ${line}`);
	const banned = /(^|[\s/])(canvas|skia-canvas|sharp)@/;
	assert.ok(!banned.test(npmOutput), "no banned native image package may appear in the tree");
	assert.ok(npmOutput.includes("(empty)"), "the dependency tree must be empty");
	console.log(`   verdict: no native image dependency (tree empty; npm exit ${npmExit} is expected when absent)`);

	const diff = execFileSync("git", ["diff", "--name-only", "origin/master...HEAD", "--", "*package*.json"], {
		encoding: "utf8",
		cwd: repoRoot,
	}).trim();
	console.log(`   git diff --name-only origin/master...HEAD -- '*package*.json' -> ${diff === "" ? "(empty)" : diff}`);
	assert.equal(diff, "", "package.json and both lockfiles must be unchanged versus origin/master");
	console.log("PASS 2: npm tree has no canvas/skia-canvas/sharp; package.json and both locks unchanged");
}

async function block3(): Promise<void> {
	console.log("\n3. view_canvas through the tool registry returns an image content item");
	const dataDir = await mkdtemp(join(tmpdir(), "m1-block3-"));
	const { harness, registry, find } = await openTools(dataDir);
	try {
		const view = find("view_canvas");
		const result = await view.execute({}, makeApi(harness, registry, "m1-block3-canvas"), BACKGROUND_CONTEXT);
		assert.ok(!result.isError, `view_canvas failed: ${textOf(result)}`);
		const items = contentOf(result);
		const types = items.map((i) => i.type);
		console.log(`   content item types: ${types.join(", ")}`);
		const image = items.find((i) => i.type === "image");
		assert.ok(image, "an image content item must be present");
		assert.equal(image.mimeType, "image/png", "the image must be image/png");
		assert.ok(typeof image.data === "string" && image.data.length > 0, "the image must carry base64 data");
		console.log(`PASS 3: view_canvas returned an image item (mimeType=image/png, ${image.data.length} base64 chars)`);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

async function block4(): Promise<{ canvasId: string; dataDir: string; pngHash: string }> {
	console.log("\n4. Restart survival: process A paints, a separate process B reopens the store and views");
	const dataDir = await mkdtemp(join(tmpdir(), "m1-restart-"));
	const canvasId = "m1-restart-canvas";
	const expectedHash = sha256(rasterizePng(EXPECTED_OPS));

	const a = parseChild(await runChild("paint", [dataDir, canvasId]), "paint child (A)");
	console.log(`   A pid=${a.pid} painted ${a.strokes} strokes, canvas=${a.canvasId}, png sha256=${a.pngHash}`);
	assert.equal(a.pngHash, expectedHash, "A's painted PNG must match the direct rasterisation of the same ops");

	const b = parseChild(await runChild("view", [dataDir, canvasId]), "view child (B)");
	console.log(`   B pid=${b.pid} reopened the store and viewed canvas=${b.canvasId}, types=[${(b.types as string[]).join(", ")}]`);
	console.log(`   B png sha256=${b.pngHash}`);
	console.log(`   direct raster sha256=${expectedHash}`);
	assert.notEqual(a.pid, b.pid, "A and B must be distinct processes");
	assert.equal(b.pngHash, expectedHash, "B's PNG hash must equal the direct rasterisation of the same ops");
	assert.equal(a.pngHash, b.pngHash, "A's and B's PNG hashes must match");
	console.log(`PASS 4: process A (pid ${a.pid}) painted and process B (pid ${b.pid}) reopened the durable store; hashes match (${b.pngHash})`);
	return { canvasId, dataDir, pngHash: String(b.pngHash) };
}

async function block5(canvasId: string, dataDir: string, expectedHash: string): Promise<void> {
	console.log("\n5. HTTP: unauthenticated 401, authenticated 200 image/png with the block-4 hash");
	process.env.DATA_DIR = dataDir;
	process.env.PORT = "0";
	process.env.OPENROUTER_API_KEY ||= "unused";
	process.env.AUTH_TOKEN ||= "m1-acceptance-bootstrap";

	const { Agent } = await import("../../src/agent.ts");
	const { ownerAuth } = await import("../../src/auth.ts");
	const { config } = await import("../../src/config.ts");
	const { startHttp } = await import("../../src/http.ts");

	const agent = await Agent.open();
	const server = startHttp(agent);
	await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", () => resolve())));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "HTTP server bound to a port");
	const base = `http://localhost:${address.port}`;

	try {
		const unauth = await fetch(`${base}/api/elr/canvas/${canvasId}.png`);
		await unauth.arrayBuffer();
		console.log(`   GET without a session -> ${unauth.status} ${unauth.headers.get("content-type") ?? ""}`);
		assert.equal(unauth.status, 401, "unauthenticated request must be rejected");

		const origin = config.auth.origins[0]!;
		const device = new TestAuthenticator(ownerAuth.rpID, origin);
		const cookieHeaders: string[] = [];
		const response = {
			setHeader: (name: string, value: string | string[]) => {
				if (name.toLowerCase() === "set-cookie") cookieHeaders.push(...(Array.isArray(value) ? value : [value]));
			},
		} as unknown as ServerResponse;
		await ownerAuth.register(response, { response: device.register(await ownerAuth.registrationOptions()), name: "M1 Acceptance" });
		const cookie = /agent_session=([^;]+)/.exec(cookieHeaders.join("; "))?.[1];
		assert.ok(cookie, "registering a passkey must set a session cookie");

		const authed = await fetch(`${base}/api/elr/canvas/${canvasId}.png`, { headers: { cookie: `agent_session=${cookie}` } });
		const body = Buffer.from(await authed.arrayBuffer());
		const hash = sha256(body);
		console.log(`   GET with a session -> ${authed.status} ${authed.headers.get("content-type")}, sha256=${hash}`);
		assert.equal(authed.status, 200, "authenticated request must succeed");
		assert.equal(authed.headers.get("content-type"), "image/png", "the response must be image/png");
		assert.equal(hash, expectedHash, "the served PNG must equal the block-4 hash");
		console.log(`PASS 5: 401 without a session; 200 image/png with a session and the matching hash (${hash})`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await agent.close();
	}
}

async function block6(): Promise<void> {
	console.log("\n6. Repo gates: typecheck, web build and smoke");
	const gates: { label: string; command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [
		{ label: "npm run typecheck", command: "npm", args: ["run", "typecheck"] },
		{ label: "npm run build:web", command: "npm", args: ["run", "build:web"] },
		{
			label: "OPENROUTER_API_KEY= node --max-old-space-size=1024 scripts/smoke.ts",
			command: process.execPath,
			args: ["--max-old-space-size=1024", "scripts/smoke.ts"],
			env: { ...process.env, OPENROUTER_API_KEY: "" },
		},
	];
	for (const gate of gates) {
		const result = await run(gate.command, gate.args, { env: gate.env });
		console.log(`   $ ${gate.label}   (exit ${result.code})`);
		for (const line of tail(result.stdout || result.stderr).split("\n")) console.log(`   | ${line}`);
		assert.equal(result.code, 0, `${gate.label} must exit 0`);
	}
	console.log("PASS 6: typecheck, web build and smoke all exited 0");
}

async function main(): Promise<void> {
	console.log("ELR M1 acceptance\n");
	await block1();
	await block2();
	await block3();
	const restart = await block4();
	await block5(restart.canvasId, restart.dataDir, restart.pngHash);
	await block6();
	console.log("\nAll ELR M1 acceptance blocks passed.");
}

if (process.argv[2] === "--child") {
	childMain(process.argv[3] ?? "", process.argv.slice(4)).catch((error) => {
		console.error(error);
		process.exit(1);
	});
} else {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

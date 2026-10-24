// Re-runnable regression suite for the /canvas route.
//
// It starts the real production server (`node src/main.ts`) with a throwaway
// DATA_DIR and drives it over HTTP, so it covers config.dataDir → handler root
// and the src/http.ts dispatch. Every acceptance case is a separately named
// node:test assertion. No new dependencies, credentials or network are needed.
//
// Run with: npm run test:canvas
//       or: node --test scripts/canvas-static-route.test.ts

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

const TOKEN = "route-suite-canvas-token-8d2f4a6c";
const TEST_TIMEOUT = 120_000;

const INDEX_MARKER = "ROUTE_SUITE_INDEX_MARKER";
const GALLERY_MARKER = "ROUTE_SUITE_GALLERY_MARKER";
const SVG_MARKER = "ROUTE_SUITE_SVG_MARKER";
const PNG_MARKER = "ROUTE_SUITE_PNG_MARKER";
const JSON_MARKER = "ROUTE_SUITE_JSON_MARKER";
const INNER_MARKER = "ROUTE_SUITE_INNER_MARKER";
const NOTES_SECRET = "ROUTE_SUITE_NOTES_SECRET";
const PUBLIC_URL_SECRET = "ROUTE_SUITE_PUBLIC_URL_SECRET";
const PID_SECRET = "ROUTE_SUITE_PID_SECRET";
const LOG_SECRET = "ROUTE_SUITE_LOG_SECRET";
const GENERATOR_SECRET = "ROUTE_SUITE_GENERATOR_SECRET";
const OUTSIDE_SECRET = "ROUTE_SUITE_OUTSIDE_SECRET";

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GET / exercises the pre-existing web-chat static handler, which needs
// web/dist. The verify command builds it; build it here too so the suite is
// self-contained when run on its own.
function ensureWebBuilt(): void {
	if (existsSync(join(repoRoot, "web", "dist", "index.html"))) return;
	const result = spawnSync("npm", ["--prefix", "web", "run", "build"], { cwd: repoRoot, stdio: "inherit" });
	if (result.status !== 0) throw new Error("web/dist is missing and `npm --prefix web run build` failed");
}

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method: "GET", agent: false, headers: { connection: "close", ...headers } },
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => void (body += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** Send a raw HTTP request line so actual NUL bytes / odd targets reach the server untouched. */
function rawRequest(port: number, target: string, headers: Record<string, string> = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		let raw = "";
		socket.setEncoding("latin1");
		socket.on("connect", () => {
			const extra = Object.entries(headers)
				.map(([key, value]) => `${key}: ${value}\r\n`)
				.join("");
			socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n${extra}\r\n`);
		});
		socket.on("data", (chunk: string) => void (raw += chunk));
		socket.on("error", reject);
		socket.on("end", () => {
			const headerEnd = raw.indexOf("\r\n\r\n");
			const head = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
			const lines = head.split("\r\n");
			const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
			const parsed: Record<string, string> = {};
			for (const line of lines.slice(1)) {
				const idx = line.indexOf(":");
				if (idx !== -1) parsed[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
			}
			resolve({ status, headers: parsed, body: headerEnd === -1 ? "" : raw.slice(headerEnd + 4) });
		});
	});
}

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			if (address === null || typeof address === "string") return reject(new Error("could not allocate a port"));
			probe.close(() => resolve(address.port));
		});
	});
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await request(port, "/health");
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(100);
	}
	throw new Error("server did not answer GET /health in time");
}

const children = new Set<ChildProcess>();

interface ServerHandle {
	port: number;
	log: string;
	stop(): Promise<void>;
}

async function startServer(dataDir: string, token: string | undefined): Promise<ServerHandle> {
	const port = await freePort();
	const logPath = join(dataDir, `server-${port}.log`);
	const logFd = openSync(logPath, "w");
	const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, PORT: String(port), OPENROUTER_API_KEY: "unused" };
	delete env.CANVAS_ACCESS_TOKEN;
	if (token !== undefined) env.CANVAS_ACCESS_TOKEN = token;
	const child = spawn(process.execPath, ["--max-old-space-size=1024", mainScript], {
		cwd: repoRoot,
		env,
		stdio: ["ignore", logFd, logFd],
	});
	children.add(child);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

	const handle: ServerHandle = {
		port,
		log: "",
		async stop() {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			await Promise.race([exited, sleep(3000)]);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			children.delete(child);
			try {
				closeSync(logFd);
			} catch {
				// already closed
			}
			handle.log = await readFile(logPath, "utf8").catch(() => "");
		},
	};

	try {
		await waitForHealth(port, 30_000);
	} catch (error) {
		await handle.stop();
		throw error;
	}
	return handle;
}

function setCookieHeader(result: HttpResult): string {
	const raw = result.headers["set-cookie"];
	return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function cookiePair(setCookie: string): string {
	const match = /canvas_access=([^;]+)/.exec(setCookie);
	return match ? `canvas_access=${match[1]}` : "";
}

let dataDir: string;
let publicRoot: string;
let outsideSecret: string;
let server: ServerHandle;
let cookie: string;

async function buildFixture(): Promise<void> {
	dataDir = await mkdtemp(join(tmpdir(), "canvas-route-suite-"));
	const canvasRoot = join(dataDir, "workspace", "canvas");
	publicRoot = join(canvasRoot, "public");
	await mkdir(join(publicRoot, "day"), { recursive: true });
	await mkdir(join(publicRoot, "subdir"), { recursive: true });
	await mkdir(join(publicRoot, "emptydir"), { recursive: true });

	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	await writeFile(join(publicRoot, "gallery.html"), `<h1>${GALLERY_MARKER}</h1>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.svg"), `<svg>${SVG_MARKER}</svg>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.png"), Buffer.from(`\x89PNG\r\n\x1a\n${PNG_MARKER}`, "binary"));
	await writeFile(join(publicRoot, "day", "2026-10-18.json"), JSON.stringify({ date: "2026-10-18", marker: JSON_MARKER }));
	await writeFile(join(publicRoot, "day", "notes.txt"), NOTES_SECRET);
	await writeFile(join(publicRoot, "subdir", "inner.html"), `<h1>${INNER_MARKER}</h1>`);

	await mkdir(join(canvasRoot, "run"), { recursive: true });
	await mkdir(join(canvasRoot, "logs"), { recursive: true });
	await writeFile(join(canvasRoot, ".public-url"), PUBLIC_URL_SECRET);
	await writeFile(join(canvasRoot, "run", "server.pid"), PID_SECRET);
	await writeFile(join(canvasRoot, "logs", "agent.log"), LOG_SECRET);
	await writeFile(join(canvasRoot, "generate.mjs"), `// ${GENERATOR_SECRET}`);

	outsideSecret = join(dataDir, "outside-secret.txt");
	await writeFile(outsideSecret, OUTSIDE_SECRET);
	await symlink(outsideSecret, join(publicRoot, "link.svg"));
}

before(async () => {
	ensureWebBuilt();
	await buildFixture();
	server = await startServer(dataDir, TOKEN);
	const handshake = await request(server.port, `/canvas/?k=${encodeURIComponent(TOKEN)}`);
	const setCookie = setCookieHeader(handshake);
	cookie = cookiePair(setCookie);
	if (handshake.status !== 302 || cookie === "") {
		await server.stop();
		throw new Error(`canvas handshake failed: status=${handshake.status} set-cookie=${setCookie}`);
	}
});

after(async () => {
	if (server) {
		const log = (await server.stop(), server.log);
		assert.ok(!log.includes(TOKEN), "token leaked into the server log");
	}
	if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

function assertNoLeak(result: HttpResult, markers: string[], label: string): void {
	for (const marker of markers) {
		assert.ok(!result.body.includes(marker), `${label} leaked ${marker}`);
	}
	assert.ok(!/Index of|Directory listing/i.test(result.body), `${label} returned a directory listing`);
}

const CANVAS_LEAKS = [INDEX_MARKER, GALLERY_MARKER, SVG_MARKER, JSON_MARKER, INNER_MARKER];

it("disables /canvas/ with 404 when CANVAS_ACCESS_TOKEN is unset", { timeout: TEST_TIMEOUT }, async () => {
	const isolated = await startServer(dataDir, undefined);
	try {
		const res = await request(isolated.port, "/canvas/");
		assert.equal(res.status, 404, `GET /canvas/ with the token unset must be 404, got ${res.status}`);
		assertNoLeak(res, [...CANVAS_LEAKS, NOTES_SECRET], "disabled /canvas/");
		const file = await request(isolated.port, "/canvas/index.html");
		assert.equal(file.status, 404, `GET /canvas/index.html with the token unset must be 404, got ${file.status}`);
		assertNoLeak(file, CANVAS_LEAKS, "disabled /canvas/index.html");
	} finally {
		await isolated.stop();
	}
});

it("disables /canvas/ with 404 when CANVAS_ACCESS_TOKEN is empty", { timeout: TEST_TIMEOUT }, async () => {
	const isolated = await startServer(dataDir, "");
	try {
		const res = await request(isolated.port, "/canvas/");
		assert.equal(res.status, 404, `GET /canvas/ with an empty token must be 404, got ${res.status}`);
		assertNoLeak(res, [...CANVAS_LEAKS, NOTES_SECRET], "disabled /canvas/");
	} finally {
		await isolated.stop();
	}
});

it("returns 401 with no content for a missing token", async () => {
	const res = await request(server.port, "/canvas/");
	assert.equal(res.status, 401, `GET /canvas/ without a token must be 401, got ${res.status}`);
	assertNoLeak(res, [...CANVAS_LEAKS, NOTES_SECRET], "401 response");
	assert.ok(!res.body.includes(TOKEN), "401 response echoed the token");
	assert.ok(!/CANVAS_ACCESS_TOKEN|canvas_access|access[_-]?token/i.test(res.body), "401 response hinted at the token");
});

it("returns 401 with no content for a wrong token", async () => {
	const res = await request(server.port, "/canvas/?k=wrong-token");
	assert.equal(res.status, 401, `GET /canvas/?k=wrong-token must be 401, got ${res.status}`);
	assertNoLeak(res, [...CANVAS_LEAKS, NOTES_SECRET], "wrong-token response");
	assert.ok(!res.body.includes(TOKEN), "wrong-token response echoed the real token");
	assert.ok(!/CANVAS_ACCESS_TOKEN|canvas_access|access[_-]?token/i.test(res.body), "wrong-token response hinted at the token");
});

it("sets an HttpOnly, SameSite=Lax cookie and redirects to a clean /canvas/", async () => {
	const res = await request(server.port, `/canvas/?k=${encodeURIComponent(TOKEN)}`);
	assert.equal(res.status, 302, `token handshake must redirect, got ${res.status}`);
	assert.equal(res.headers.location, "/canvas/", `handshake Location must be /canvas/, got ${String(res.headers.location)}`);
	assert.ok(!String(res.headers.location).includes(TOKEN), "handshake Location contained the token");
	const setCookie = setCookieHeader(res);
	assert.match(setCookie, /HttpOnly/i, `cookie missing HttpOnly: ${setCookie}`);
	assert.match(setCookie, /SameSite=Lax/i, `cookie missing SameSite=Lax: ${setCookie}`);
	assert.match(setCookie, /Path=\/canvas/i, `cookie missing Path=/canvas: ${setCookie}`);
	assert.notEqual(cookiePair(setCookie), "", "handshake did not set the canvas_access cookie");
});

it("serves the authenticated index as text/html; charset=utf-8 with nosniff", async () => {
	const res = await request(server.port, "/canvas/", { cookie });
	assert.equal(res.status, 200, `cookie-authenticated GET /canvas/ must be 200, got ${res.status}`);
	assert.equal(res.headers["content-type"], "text/html; charset=utf-8", "index content-type");
	assert.equal(res.headers["x-content-type-options"], "nosniff", "index must carry X-Content-Type-Options: nosniff");
	assert.ok(res.body.includes(INDEX_MARKER), "index body missing the fixture marker");
});

it("serves .svg as image/svg+xml", async () => {
	const res = await request(server.port, "/canvas/day/2026-10-18.svg", { cookie });
	assert.equal(res.status, 200, `svg request must be 200, got ${res.status}`);
	assert.equal(res.headers["content-type"], "image/svg+xml", "svg content-type");
	assert.ok(res.body.includes(SVG_MARKER), "svg body missing the fixture marker");
});

it("serves .png as image/png", async () => {
	const res = await request(server.port, "/canvas/day/2026-10-18.png", { cookie });
	assert.equal(res.status, 200, `png request must be 200, got ${res.status}`);
	assert.equal(res.headers["content-type"], "image/png", "png content-type");
	assert.ok(res.body.includes(PNG_MARKER), "png body missing the fixture marker");
});

it("serves .json as application/json", async () => {
	const res = await request(server.port, "/canvas/day/2026-10-18.json", { cookie });
	assert.equal(res.status, 200, `json request must be 200, got ${res.status}`);
	assert.equal(res.headers["content-type"], "application/json", "json content-type");
	assert.ok(res.body.includes(JSON_MARKER), "json body missing the fixture marker");
});

it("rejects an unknown extension instead of sniffing it", async () => {
	const res = await request(server.port, "/canvas/day/notes.txt", { cookie });
	assert.equal(res.status, 404, `unknown extension must be 404, got ${res.status}`);
	assert.ok(!res.body.includes(NOTES_SECRET), "unknown-extension response leaked the file");
	assert.equal(res.headers["x-content-type-options"], "nosniff", "unknown-extension response must carry nosniff");
});

it("does not list an existing directory", async () => {
	for (const path of ["/canvas/day/", "/canvas/subdir/", "/canvas/emptydir/"]) {
		const res = await request(server.port, path, { cookie });
		assert.equal(res.status, 404, `${path} must not list, got ${res.status}`);
		assert.ok(!res.body.includes("Index of"), `${path} returned a directory listing`);
		assert.ok(!res.body.includes("inner.html"), `${path} leaked a child file name`);
		assert.ok(!res.body.includes("2026-10-18"), `${path} leaked a child file name`);
	}
});

it("rejects plain ../ traversal", async () => {
	const res = await request(server.port, "/canvas/../outside-secret.txt", { cookie });
	assert.notEqual(res.status, 200, `plain ../ traversal must not be served, got ${res.status}`);
	assert.ok(!res.body.includes(OUTSIDE_SECRET), "plain ../ traversal leaked the target file");
});

it("rejects percent-encoded %2e%2e%2f traversal", async () => {
	const res = await request(server.port, "/canvas/%2e%2e%2foutside-secret.txt", { cookie });
	assert.notEqual(res.status, 200, `%2e%2e%2f traversal must not be served, got ${res.status}`);
	assert.ok(!res.body.includes(OUTSIDE_SECRET), "%2e%2e%2f traversal leaked the target file");
});

it("rejects double-encoded %252e%252e%252f traversal", async () => {
	const res = await request(server.port, "/canvas/%252e%252e%252foutside-secret.txt", { cookie });
	assert.notEqual(res.status, 200, `double-encoded traversal must not be served, got ${res.status}`);
	assert.ok(!res.body.includes(OUTSIDE_SECRET), "double-encoded traversal leaked the target file");
});

it("rejects absolute filesystem paths", async () => {
	const direct = await request(server.port, "/canvas//etc/passwd", { cookie });
	assert.notEqual(direct.status, 200, `absolute path traversal must not be served, got ${direct.status}`);
	assert.ok(!direct.body.includes("root:"), "absolute path traversal leaked /etc/passwd");

	const encoded = await request(server.port, `/canvas/${outsideSecret}`, { cookie });
	assert.notEqual(encoded.status, 200, `absolute target must not be served, got ${encoded.status}`);
	assert.ok(!encoded.body.includes(OUTSIDE_SECRET), "absolute target leaked the outside file");
});

it("rejects backslash traversal", async () => {
	const encoded = await request(server.port, "/canvas/..%5Coutside-secret.txt", { cookie });
	assert.notEqual(encoded.status, 200, `encoded backslash traversal must not be served, got ${encoded.status}`);
	assert.ok(!encoded.body.includes(OUTSIDE_SECRET), "encoded backslash traversal leaked the target file");

	const raw = await request(server.port, "/canvas/..\\outside-secret.txt", { cookie });
	assert.notEqual(raw.status, 200, `raw backslash traversal must not be served, got ${raw.status}`);
	assert.ok(!raw.body.includes(OUTSIDE_SECRET), "raw backslash traversal leaked the target file");
});

it("rejects NUL bytes", async () => {
	const encoded = await request(server.port, "/canvas/index.html%00.png", { cookie });
	assert.notEqual(encoded.status, 200, `encoded NUL must not be served, got ${encoded.status}`);
	assert.ok(!encoded.body.includes(INDEX_MARKER), "encoded NUL leaked canvas content");

	const raw = await rawRequest(server.port, "/canvas/index.html\0.png", { cookie });
	assert.notEqual(raw.status, 200, `raw NUL must not be served, got ${raw.status}`);
	assert.ok(!raw.body.includes(INDEX_MARKER), "raw NUL leaked canvas content");
});

it("rejects a symlink inside the public tree that points outside the root", async () => {
	const res = await request(server.port, "/canvas/link.svg", { cookie });
	assert.notEqual(res.status, 200, `escaping symlink must not be served, got ${res.status}`);
	assert.ok(!res.body.includes(OUTSIDE_SECRET), "escaping symlink leaked the outside file");
});

it("serves only the public tree: volume sentinels are never reachable", async () => {
	const cases: Array<[string, string]> = [
		["/canvas/.public-url", PUBLIC_URL_SECRET],
		["/canvas/run/server.pid", PID_SECRET],
		["/canvas/logs/agent.log", LOG_SECRET],
		["/canvas/generate.mjs", GENERATOR_SECRET],
	];
	for (const [path, marker] of cases) {
		const res = await request(server.port, path, { cookie });
		assert.equal(res.status, 404, `${path} must be 404, got ${res.status}`);
		assert.ok(!res.body.includes(marker), `${path} leaked a volume sentinel`);
		assertNoLeak(res, CANVAS_LEAKS, path);
	}
});

it("keeps GET / at its pre-existing 200", async () => {
	const res = await request(server.port, "/");
	assert.equal(res.status, 200, `GET / must stay 200, got ${res.status}`);
	assert.match(String(res.headers["content-type"]), /^text\/html/, `GET / content-type must stay text/html, got ${String(res.headers["content-type"])}`);
});

it("keeps GET /health at its pre-existing 200", async () => {
	const res = await request(server.port, "/health");
	assert.equal(res.status, 200, `GET /health must stay 200, got ${res.status}`);
	assert.equal(JSON.parse(res.body).ok, true, "GET /health body must still say ok:true");
});

it("keeps existing /api/* routes at their pre-existing status codes", async () => {
	const authState = await request(server.port, "/api/auth/state");
	assert.equal(authState.status, 200, `GET /api/auth/state must stay 200, got ${authState.status}`);
	const status = await request(server.port, "/api/status");
	assert.equal(status.status, 401, `GET /api/status must stay 401 unauthenticated, got ${status.status}`);
});

it("never logs the canvas token", async () => {
	const log = await readFile(join(dataDir, `server-${server.port}.log`), "utf8").catch(() => "");
	assert.ok(!log.includes(TOKEN), "canvas token appeared in the server log");
});

// Kill anything a failed before/after hook left behind.
after(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
});

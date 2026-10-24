// Re-runnable, live end-to-end proof for the /canvas route.
//
// Unlike the in-process proofs (which call createCanvasHandler directly), this
// proof starts the *real* production server — `node src/main.ts` — with a
// throwaway DATA_DIR, and drives it over HTTP. It therefore verifies the full
// wiring: config.dataDir → createCanvasHandler root, the src/http.ts dispatch,
// the Secure cookie hardening, and route additivity with the token unset.
//
// It needs no credentials (OPENROUTER_API_KEY is a placeholder) and no network
// (nothing model-driven is exercised before the checks finish). Every child is
// killed in a finally block.
//
// Run with: node --test scripts/canvas-static-live.ts
//       or: npm run test:canvas-live

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

const TOKEN = "live-canvas-token";
const INDEX_MARKER = "LiveCanvasIndexMarker";
const SVG_MARKER = "LiveCanvasSvgMarker";
const SECRET_MARKER = "LIVE-VOLUME-SECRET-MARKER";
const TEST_TIMEOUT = 120_000;

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method: "GET", headers: { connection: "close", ...headers } },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => (text += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
			},
		);
		req.on("error", reject);
		req.end();
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

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await get(port, "/health");
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(100);
	}
	throw new Error("server did not become ready in time");
}

const children = new Set<ChildProcess>();
after(() => {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
});

// The /canvasfoo and /canvases fall-through assertions exercise the pre-existing
// web-chat static handler, which needs web/dist. The verify command builds it;
// if this proof is run on its own in a checkout without it, build it first.
let webBuilt: Promise<void> | undefined;
function ensureWebBuilt(): Promise<void> {
	webBuilt ??= (async () => {
		try {
			await access(join(repoRoot, "web", "dist", "index.html"));
			return;
		} catch {
			// not built yet
		}
		const result = spawnSync("npm", ["--prefix", "web", "run", "build"], { cwd: repoRoot, stdio: "inherit" });
		if (result.status !== 0) throw new Error("web/dist is missing and `npm --prefix web run build` failed");
	})();
	return webBuilt;
}

before(async () => {
	await ensureWebBuilt();
});

interface ServerHandle {
	port: number;
	log: string;
	stop(): Promise<void>;
}

/** Start `node src/main.ts` with DATA_DIR/PORT and, optionally, CANVAS_ACCESS_TOKEN. */
async function startServer(dataDir: string, token?: string): Promise<ServerHandle> {
	const port = await freePort();
	const logPath = join(dataDir, "server.log");
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
		await waitForServer(port, 25_000);
	} catch (error) {
		await handle.stop();
		throw error;
	}
	return handle;
}

function setCookieValue(result: HttpResult): string {
	const raw = result.headers["set-cookie"];
	return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function cookiePair(setCookie: string): string {
	const match = /canvas_access=([^;]+)/.exec(setCookie);
	return match ? `canvas_access=${match[1]}` : "";
}

async function makePublicTree(dataDir: string): Promise<string> {
	const publicRoot = join(dataDir, "workspace", "canvas", "public");
	await mkdir(join(publicRoot, "day"), { recursive: true });
	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	await writeFile(join(publicRoot, "day", "fixture.svg"), `<svg>${SVG_MARKER}</svg>`);
	return publicRoot;
}

async function withDataDir(body: (dataDir: string) => Promise<void>): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-live-"));
	try {
		await body(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

it(
	"sets Secure on the canvas cookie only when the request is https",
	{ timeout: TEST_TIMEOUT },
	async () => {
		await withDataDir(async (dataDir) => {
			await makePublicTree(dataDir);
			const server = await startServer(dataDir, TOKEN);
			try {
				const secure = await get(server.port, `/canvas/?k=${TOKEN}`, { "x-forwarded-proto": "https" });
				assert.equal(secure.status, 302, "https handshake should redirect");
				const secureCookie = setCookieValue(secure);
				assert.match(secureCookie, /canvas_access=/, "https handshake should set the cookie");
				assert.match(secureCookie, /HttpOnly/i);
				assert.match(secureCookie, /SameSite=Lax/i);
				assert.match(secureCookie, /;\s*Secure/i, "https cookie must carry Secure");

				const plain = await get(server.port, `/canvas/?k=${TOKEN}`, {});
				assert.equal(plain.status, 302, "plain-http handshake should redirect");
				const plainCookie = setCookieValue(plain);
				assert.match(plainCookie, /canvas_access=/, "plain handshake should set the cookie");
				assert.doesNotMatch(plainCookie, /;\s*Secure/i, "plain-http cookie must NOT carry Secure");

				const index = await get(server.port, "/canvas/", { cookie: cookiePair(plainCookie) });
				assert.equal(index.status, 200, "plain-http auth flow should still serve the canvas");
				assert.match(String(index.headers["content-type"]), /text\/html/);

				assert.ok(!server.log.includes(TOKEN), "token leaked into the server log");
			} finally {
				await server.stop();
			}
		});
	},
);

it(
	"does not serve /canvas-prefixed non-canvas paths from the canvas root",
	{ timeout: TEST_TIMEOUT },
	async () => {
		await withDataDir(async (dataDir) => {
			await makePublicTree(dataDir);
			const server = await startServer(dataDir, TOKEN);
			try {
				const handshake = await get(server.port, `/canvas/?k=${TOKEN}`, {});
				const cookie = cookiePair(setCookieValue(handshake));

				for (const path of ["/canvasfoo", "/canvases", "/canvas.html"]) {
					const res = await get(server.port, path, { cookie });
					assert.notEqual(res.status, 401, `${path} must not be answered by the canvas auth handler`);
					assert.ok(!res.body.includes(INDEX_MARKER), `${path} returned canvas index content`);
					assert.ok(!res.body.includes(SVG_MARKER), `${path} returned canvas art`);
				}

				// /canvas.html has an extension, so the pre-existing static handler 404s.
				const html = await get(server.port, "/canvas.html", { cookie });
				assert.equal(html.status, 404, "/canvas.html should hit the pre-existing 404");

				// /canvasfoo and /canvases fall through to the web-chat static handler:
				// 200 (SPA fallback) or 503 (web/dist unbuilt). Both are pre-existing.
				for (const path of ["/canvasfoo", "/canvases"]) {
					const res = await get(server.port, path, { cookie });
					assert.ok([200, 503].includes(res.status), `${path} expected the web-chat fallback, got ${res.status}`);
					if (res.status === 200) {
						assert.match(String(res.headers["content-type"]), /text\/html/, `${path} should be served as html`);
					}
				}
			} finally {
				await server.stop();
			}
		});
	},
);

it(
	"reads the canvas tree from exactly DATA_DIR/workspace/canvas/public",
	{ timeout: TEST_TIMEOUT },
	async () => {
		await withDataDir(async (dataDir) => {
			const publicRoot = await makePublicTree(dataDir);
			// A secret-bearing file elsewhere on the volume, next to public/.
			await writeFile(join(dataDir, "workspace", "canvas", "secret.svg"), `<svg>${SECRET_MARKER}</svg>`);

			const server = await startServer(dataDir, TOKEN);
			try {
				const handshake = await get(server.port, `/canvas/?k=${TOKEN}`, {});
				const cookie = cookiePair(setCookieValue(handshake));
				assert.notEqual(cookie, "", "handshake did not set a cookie");

				const svg = await get(server.port, "/canvas/day/fixture.svg", { cookie });
				assert.equal(svg.status, 200, "fixture should be served from DATA_DIR/public");
				assert.equal(svg.headers["content-type"], "image/svg+xml");
				assert.equal(svg.headers["x-content-type-options"], "nosniff");
				assert.ok(svg.body.includes(SVG_MARKER), "fixture body was not the DATA_DIR copy");

				// The volume sibling is not under public/: unreachable, by direct and traversal paths.
				const secret = await get(server.port, "/canvas/secret.svg", { cookie });
				assert.equal(secret.status, 404);
				assert.ok(!secret.body.includes(SECRET_MARKER));
				const traversal = await get(server.port, "/canvas/%2e%2e%2fsecret.svg", { cookie });
				assert.equal(traversal.status, 404);
				assert.ok(!traversal.body.includes(SECRET_MARKER));

				// Rename public/: the same authenticated request must now 404,
				// proving the handler reads <DATA_DIR>/workspace/canvas/public.
				await rename(publicRoot, `${publicRoot}-moved`);
				const after = await get(server.port, "/canvas/day/fixture.svg", { cookie });
				assert.equal(after.status, 404, "renaming public/ must make the fixture unreachable");
				assert.ok(!after.body.includes(SVG_MARKER));
				const secretAfter = await get(server.port, "/canvas/secret.svg", { cookie });
				assert.equal(secretAfter.status, 404);
				assert.ok(!secretAfter.body.includes(SECRET_MARKER));
			} finally {
				await server.stop();
			}
		});
	},
);

it(
	"disables /canvas when CANVAS_ACCESS_TOKEN is unset while /health stays 200",
	{ timeout: TEST_TIMEOUT },
	async () => {
		await withDataDir(async (dataDir) => {
			await makePublicTree(dataDir);
			const server = await startServer(dataDir);
			try {
				const canvas = await get(server.port, "/canvas/");
				assert.equal(canvas.status, 404, "/canvas/ must be disabled with the token unset");
				assert.ok(!canvas.body.includes(INDEX_MARKER), "disabled /canvas leaked content");

				const health = await get(server.port, "/health");
				assert.equal(health.status, 200, "/health must stay 200");
				assert.equal(JSON.parse(health.body).ok, true);
			} finally {
				await server.stop();
			}
		});
	},
);

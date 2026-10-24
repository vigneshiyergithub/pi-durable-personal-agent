// End-to-end attack matrix for the /canvas route against the PRODUCTION server.
//
// The accepted in-process suite (scripts/canvas-static-security.ts) drives the
// production handler behind its own trivial `request.url.startsWith("/canvas")`
// router, so the real dispatch in src/http.ts is never exercised. This script
// closes that gap without touching either module: it builds the same DATA_DIR
// tree, starts the server exactly as production starts it
//
//   DATA_DIR=<tmp> PORT=<free port> OPENROUTER_API_KEY=unused \
//     CANVAS_ACCESS_TOKEN=<token> node src/main.ts
//
// waits for GET /health, authenticates through /canvas/?k=<token> over real
// HTTP, captures the HttpOnly cookie, and replays the whole matrix.
//
// Expectation note: WHATWG URL parsing collapses `..` segments and treats `\`
// as `/` BEFORE dispatch. src/http.ts therefore decides the canvas boundary on
// the RAW request target: when the raw target names /canvas but the parsed
// pathname does not, it answers an inert 404 before any other handler can see
// it. Every attack case must be refused by the production server (400/403/404),
// and each line reports which layer answered (the canvas handler or the
// raw-target canvas guard). Nothing under the canvas root or the volume may
// leak; a case that is ever served is reported as a FINDING instead of hidden.
//
// No dependencies (node builtins only). Run with:
//   npm run test:canvas-matrix
// or:
//   node scripts/canvas-static-matrix-e2e.ts

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCanvasPath } from "../src/canvas-static.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

// The /canvasfoo and /canvases fall-through assertions exercise the pre-existing
// web-chat static handler, which needs web/dist. The verify command builds it;
// build it here too so the fall-through status is deterministic when this proof
// is run on its own.
function ensureWebBuilt(): void {
	if (existsSync(join(repoRoot, "web", "dist", "index.html"))) return;
	const result = spawnSync("npm", ["--prefix", "web", "run", "build"], { cwd: repoRoot, stdio: "inherit" });
	if (result.status !== 0) throw new Error("web/dist is missing and `npm --prefix web run build` failed");
}

const TOKEN = "e2e-matrix-canary-token-9c4f1b7a";

// Distinct markers so any leak is unambiguous.
const INDEX = "E2E_CANVAS_INDEX_MARKER";
const GALLERY = "E2E_GALLERY_MARKER";
const SVG = "E2E_SVG_ART_MARKER";
const JSON_M = "E2E_JSON_MARKER";
const INNER = "E2E_INNER_MARKER";
const NOTES = "E2E_NOTES_SECRET_MARKER";
const PUBLIC_URL = "E2E_PUBLIC_URL_SECRET_MARKER";
const PID = "E2E_PID_SECRET_MARKER";
const LOG = "E2E_LOG_SECRET_MARKER";
const GENERATOR = "E2E_GENERATOR_SECRET_MARKER";
const OUTSIDE = "E2E_OUTSIDE_SECRET_MARKER";

// Nothing from these may ever appear in a refused response body.
const LEAK_TOKENS = [
	PUBLIC_URL,
	PID,
	LOG,
	GENERATOR,
	OUTSIDE,
	NOTES,
	INDEX,
	GALLERY,
	SVG,
	JSON_M,
	INNER,
	TOKEN,
	"Index of",
];

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
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

/** Allocate a port, then close the probe so the port is genuinely free at spawn. */
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
			const res = await get(port, "/health");
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(100);
	}
	throw new Error("server did not answer GET /health in time");
}

function setCookieHeader(result: HttpResult): string {
	const raw = result.headers["set-cookie"];
	return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function cookiePair(setCookie: string): string {
	const match = /canvas_access=([^;]+)/.exec(setCookie);
	return match ? `canvas_access=${match[1]}` : "";
}

/** The pathname the production dispatcher sees, i.e. after WHATWG normalisation. */
function normalisedPathname(raw: string): string {
	try {
		return new URL(raw, "http://localhost").pathname;
	} catch {
		return "";
	}
}

function isCanvasPath(pathname: string): boolean {
	return pathname === "/canvas" || pathname.startsWith("/canvas/");
}

async function buildTree(dataDir: string): Promise<string> {
	const canvasRoot = join(dataDir, "workspace", "canvas");
	const publicRoot = join(canvasRoot, "public");
	await mkdir(join(publicRoot, "day"), { recursive: true });
	await mkdir(join(publicRoot, "subdir"), { recursive: true });
	await mkdir(join(publicRoot, "emptydir"), { recursive: true });

	// Public tree: the only files the route may serve.
	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX}</h1>`);
	await writeFile(join(publicRoot, "gallery.html"), `<h1>${GALLERY}</h1>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.svg"), `<svg>${SVG}</svg>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.json"), JSON.stringify({ date: "2026-10-18", marker: JSON_M }));
	await writeFile(join(publicRoot, "day", "notes.txt"), NOTES);
	await writeFile(join(publicRoot, "subdir", "inner.html"), `<h1>${INNER}</h1>`);

	// Secret-bearing files on the volume, outside public/.
	await mkdir(join(canvasRoot, "run"), { recursive: true });
	await mkdir(join(canvasRoot, "logs"), { recursive: true });
	await writeFile(join(canvasRoot, ".public-url"), PUBLIC_URL);
	await writeFile(join(canvasRoot, "run", "server.pid"), PID);
	await writeFile(join(canvasRoot, "logs", "agent.log"), LOG);
	await writeFile(join(canvasRoot, "generate.mjs"), `// ${GENERATOR}`);
	await writeFile(join(dataDir, "outside-secret.txt"), OUTSIDE);

	// Symlink escapes inside the public tree.
	await symlink(join(canvasRoot, ".public-url"), join(publicRoot, "leak"));
	await symlink(dataDir, join(publicRoot, "outdir"));
	return publicRoot;
}

async function main(): Promise<number> {
	ensureWebBuilt();
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-matrix-"));
	const publicRoot = await buildTree(dataDir);
	const port = await freePort();
	const logPath = join(dataDir, "server.log");
	const logFd = openSync(logPath, "w");

	// The real command, printed before any assertion, exactly as production starts it.
	console.log(`SPAWN: DATA_DIR=${dataDir} PORT=${port} OPENROUTER_API_KEY=unused CANVAS_ACCESS_TOKEN=${TOKEN} node src/main.ts`);
	console.log(`PORT: ${port}`);

	const child = spawn(process.execPath, ["--max-old-space-size=1024", mainScript], {
		cwd: repoRoot,
		env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), OPENROUTER_API_KEY: "unused", CANVAS_ACCESS_TOKEN: TOKEN },
		stdio: ["ignore", logFd, logFd],
	});
	let exitInfo = { code: -1, signal: "" };
	child.once("exit", (code, signal) => {
		exitInfo = { code: code ?? -1, signal: String(signal ?? "") };
	});

	const failures: string[] = [];
	const findings: string[] = [];
	const expectOk = (condition: unknown, message: string) => {
		if (!condition) failures.push(message);
		return Boolean(condition);
	};

	try {
		// 1. Wait for the production server to be healthy.
		await waitForHealth(port, 60_000);
		const health = await get(port, "/health");
		console.log(`GET /health -> ${health.status} (production server is up)`);
		expectOk(health.status === 200, `/health answered ${health.status}`);

		// 2. Authenticate through /canvas/?k=<token> and capture the cookie.
		const noAuth = await get(port, "/canvas/");
		console.log(`GET /canvas/ (no cookie) -> ${noAuth.status} [auth]`);
		expectOk(noAuth.status === 401, `unauthenticated /canvas/ must be 401, got ${noAuth.status}`);
		expectOk(noAuth.status === 401 && !noAuth.body.includes(TOKEN), "unauthenticated /canvas/ body hinted at the token");
		for (const marker of LEAK_TOKENS) expectOk(!noAuth.body.includes(marker), `unauthenticated /canvas/ body contained ${marker}`);

		const handshake = await get(port, `/canvas/?k=${encodeURIComponent(TOKEN)}`);
		const setCookie = setCookieHeader(handshake);
		const cookie = cookiePair(setCookie);
		console.log(`GET /canvas/?k=<token> -> ${handshake.status} [auth, sets HttpOnly cookie]`);
		expectOk(handshake.status === 302, `token handshake must redirect, got ${handshake.status}`);
		expectOk(/HttpOnly/i.test(setCookie), "handshake cookie missing HttpOnly");
		expectOk(/SameSite=Lax/i.test(setCookie), "handshake cookie missing SameSite=Lax");
		expectOk(setCookie !== "" && cookie !== "", "handshake did not set canvas_access cookie");

		const authed = await get(port, "/canvas/", { cookie });
		console.log(`GET /canvas/ (cookie) -> ${authed.status} content-type=${String(authed.headers["content-type"])} [auth]`);
		expectOk(authed.status === 200, `cookie /canvas/ must be 200, got ${authed.status}`);
		expectOk(String(authed.headers["content-type"]).startsWith("text/html"), "cookie /canvas/ must be text/html");
		expectOk(authed.body.includes(INDEX), "cookie /canvas/ did not serve index.html");

		// Positive control: the cookie really does unlock the canvas tree.
		const svg = await get(port, "/canvas/day/2026-10-18.svg", { cookie });
		console.log(`GET /canvas/day/2026-10-18.svg (cookie) -> ${svg.status} content-type=${String(svg.headers["content-type"])} [control]`);
		expectOk(svg.status === 200 && svg.body.includes(SVG), "authenticated SVG control was not served");

		// 3. The full attack matrix, replayed unchanged over real HTTP.
		const cases = [
			"/canvas/../.public-url",
			"/canvas/../../.public-url",
			"/canvas/..%2f.public-url",
			"/canvas/%2e%2e%2f.public-url",
			"/canvas/%252e%252e%252f.public-url",
			"/canvas//etc/passwd",
			"/canvas/%2Fetc%2Fpasswd",
			"/canvas/..%5C.public-url",
			"/canvas/..\\.public-url",
			"/canvas/index.html%00.png",
			"/canvas/leak",
			"/canvas/outdir/outside-secret.txt",
			"/canvas/outdir/",
			"/canvas/.public-url",
			"/canvas/run/server.pid",
			"/canvas/logs/agent.log",
			"/canvas/generate.mjs",
			"/canvas/../outside-secret.txt",
			"/canvas/day/",
			"/canvas/subdir/",
			"/canvas/emptydir/",
			"/canvas/day/notes.txt",
		];

		for (const path of cases) {
			const res = await get(port, path, { cookie });
			const pathname = normalisedPathname(path);
			const rawPath = path.split("?")[0] ?? "/";
			const rawNamesCanvas = rawPath === "/canvas" || rawPath.startsWith("/canvas/");
			const normNamesCanvas = isCanvasPath(pathname);
			const refused = res.status === 400 || res.status === 403 || res.status === 404;

			// The security invariant: no canvas/volume content ever leaks.
			for (const marker of LEAK_TOKENS) {
				expectOk(!res.body.includes(marker), `${path} leaked marker ${marker} (body: ${res.body.slice(0, 120)})`);
			}

			let layer: string;
			if (normNamesCanvas) {
				const resolved = await resolveCanvasPath(publicRoot, path, pathname);
				let reason: string;
				if (!resolved.ok) {
					reason = resolved.reason;
				} else {
					const ext = extname(resolved.file).toLowerCase();
					reason = [".html", ".svg", ".png", ".json"].includes(ext) ? "served" : "unknown extension";
				}
				layer = `canvas handler: ${reason}`;
			} else if (rawNamesCanvas) {
				layer = `raw-target canvas guard (parsed pathname ${pathname} left /canvas)`;
			} else {
				layer = `non-canvas target (parsed pathname ${pathname})`;
			}

			if (!refused) findings.push(`${path} -> ${res.status} [${layer}]`);
			expectOk(refused, `${path} must be refused by the production server, got ${res.status} [${layer}]`);
			console.log(`GET ${path} -> ${res.status} [${layer}]`);
		}

		// 3b. Paths that merely resemble /canvas must keep falling through to the
		// pre-existing handlers exactly as before (no behaviour change from the
		// raw-target canvas guard, which only fires when the raw target names the
		// /canvas prefix).
		const fallThrough: { path: string; expected: number[] }[] = [
			{ path: "/canvas.html", expected: [404] },
			{ path: "/canvasfoo", expected: [200, 503] },
			{ path: "/canvases", expected: [200, 503] },
		];
		for (const { path, expected } of fallThrough) {
			const res = await get(port, path, { cookie });
			console.log(`GET ${path} -> ${res.status} [fall-through, pre-existing web handler]`);
			expectOk(expected.includes(res.status), `${path} expected one of ${expected.join("/")}, got ${res.status}`);
			for (const marker of [INDEX, GALLERY, SVG, JSON_M, INNER]) {
				expectOk(!res.body.includes(marker), `${path} returned canvas content`);
			}
			if (res.status === 200) {
				expectOk(String(res.headers["content-type"]).startsWith("text/html"), `${path} 200 must be the web-chat HTML`);
			}
		}

		// 4. The token must never reach the server log.
		const log = await readFile(logPath, "utf8").catch(() => "");
		expectOk(!log.includes(TOKEN), "token leaked into the server log");
		for (const marker of [PUBLIC_URL, PID, LOG, GENERATOR, OUTSIDE]) {
			expectOk(!log.includes(marker), `server log leaked ${marker}`);
		}

		console.log("");
		console.log(`RESULT: ${cases.length} attack cases replayed over real HTTP against the production server`);
		console.log(`FINDINGS: ${findings.length === 0 ? "none" : findings.join("; ")}`);
		if (failures.length > 0) {
			console.log(`FAILURES (${failures.length}):`);
			for (const failure of failures) console.log(`  - ${failure}`);
			return 1;
		}
		console.log("PASS: every attack case was refused with no canvas/volume content leaked; non-canvas paths fell through unchanged");
		return 0;
	} finally {
		// Always terminate the child: SIGTERM, then SIGKILL.
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await Promise.race([once(child, "exit").catch(() => undefined), sleep(3000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await Promise.race([once(child, "exit").catch(() => undefined), sleep(1000)]);
		try {
			closeSync(logFd);
		} catch {
			// already closed
		}
		await rm(dataDir, { recursive: true, force: true });
		console.log(`CLEANUP: child terminated (exit=${exitInfo.code} signal=${exitInfo.signal}); temp tree removed`);
	}
}

const code = await main();
process.exitCode = code;

// Re-runnable end-to-end proof for the /canvas defects confirmed in
// docs/notes/canvas-warning-survey.md and fixed in src/canvas-static.ts.
//
// It starts the *real* production server (`node src/main.ts`) with a throwaway
// DATA_DIR and drives it over HTTP, so it exercises the full wiring:
// config.dataDir → createCanvasHandler root and the src/http.ts dispatch.
//
//   D1  GET /canvas (bare, no trailing slash) must not serve the index page at
//       the domain root. With a valid cookie it redirects to /canvas/; with a
//       valid ?k= token it redirects to /canvas/ and sets the cookie.
//   D2  An unauthenticated request of any method gets 401, never a 405 that
//       confirms the route exists (405 is only for authenticated non-GET/HEAD).
//   D3  The token handshake redirects to the requested canvas path with the
//       query stripped, not always to the gallery index.
//
// It also proves the startup/health requirement: the server starts and
// GET /health is 200 when CANVAS_ACCESS_TOKEN is unset or empty and when
// ${DATA_DIR}/workspace/canvas/public does not exist, while /canvas is 404.
//
// No credentials (OPENROUTER_API_KEY is a placeholder) and no network are
// needed. Run with:
//   npm run test:canvas-fixes
// or:
//   node scripts/canvas-static-fixes.ts

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

const TOKEN = "fixes-canvas-token-3f7a1c9e";
const INDEX_MARKER = "FixesCanvasIndexMarker";
const SVG_MARKER = "FixesCanvasSvgMarker";

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// GET / exercises the pre-existing web-chat static handler, which needs
// web/dist. The verify command builds it; build it here too so the proof is
// self-contained and GET / returns its usual 200 rather than the unbuilt path.
function ensureWebBuilt(): void {
	if (existsSync(join(repoRoot, "web", "dist", "index.html"))) return;
	const result = spawnSync("npm", ["--prefix", "web", "run", "build"], { cwd: repoRoot, stdio: "inherit" });
	if (result.status !== 0) throw new Error("web/dist is missing and `npm --prefix web run build` failed");
}

function httpRequestOnce(
	method: string,
	port: number,
	path: string,
	headers: Record<string, string> = {},
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method, agent: false, headers: { connection: "close", ...headers } },
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
			const res = await httpRequestOnce("GET", port, "/health");
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(100);
	}
	throw new Error("server did not answer GET /health in time");
}

interface ServerHandle {
	port: number;
	stop(): Promise<void>;
	log: string;
}

const children = new Set<ChildProcess>();
async function startServer(dataDir: string, token: string | undefined): Promise<ServerHandle> {
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

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

async function makePublicTree(dataDir: string): Promise<void> {
	const publicRoot = join(dataDir, "workspace", "canvas", "public");
	await mkdir(join(publicRoot, "day"), { recursive: true });
	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.svg"), `<svg>${SVG_MARKER}</svg>`);
}

/** D1 + D3 + D2: the route fixes, over the real production server. */
async function routeFixes(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-fixes-route-"));
	await makePublicTree(dataDir);
	const server = await startServer(dataDir, TOKEN);
	try {
		const port = server.port;

		// D1 (handshake form): /canvas?k=<token> must redirect to /canvas/ (clean)
		// and set the cookie; it must not render the index at the root base.
		const bareHandshake = await httpRequestOnce("GET", port, `/canvas?k=${TOKEN}`);
		check(bareHandshake.status === 302, `D1: /canvas?k=token expected 302, got ${bareHandshake.status}`);
		check(
			bareHandshake.headers.location === "/canvas/",
			`D1: /canvas?k=token expected Location /canvas/, got ${String(bareHandshake.headers.location)}`,
		);
		check(!bareHandshake.body.includes(INDEX_MARKER), "D1: /canvas?k=token body leaked the index page");
		check(/canvas_access=/.test(setCookieHeader(bareHandshake)), "D1: /canvas?k=token did not set the cookie");
		check(!String(bareHandshake.headers.location).includes(TOKEN), "D1: token appeared in the redirect Location");

		// D1 (cookie form): /canvas with a valid cookie must redirect to /canvas/.
		const bareCookie = await httpRequestOnce("GET", port, "/canvas", {
			cookie: `canvas_access=${TOKEN}`,
		});
		check(bareCookie.status === 302, `D1: cookie GET /canvas expected 302, got ${bareCookie.status}`);
		check(
			bareCookie.headers.location === "/canvas/",
			`D1: cookie GET /canvas expected Location /canvas/, got ${String(bareCookie.headers.location)}`,
		);
		check(!bareCookie.body.includes(INDEX_MARKER), "D1: cookie GET /canvas body leaked the index page");

		// Unauthenticated bare /canvas keeps the uniform 401 (the security
		// requirement for a missing/wrong token) and never serves the index.
		const bareAnon = await httpRequestOnce("GET", port, "/canvas");
		check(bareAnon.status === 401, `D1: unauthenticated GET /canvas expected 401, got ${bareAnon.status}`);
		check(!bareAnon.body.includes(INDEX_MARKER), "D1: unauthenticated GET /canvas leaked the index page");
		const bareWrong = await httpRequestOnce("GET", port, "/canvas?k=wrong-token");
		check(bareWrong.status === 401, `D1: GET /canvas?k=wrong expected 401, got ${bareWrong.status}`);
		check(!bareWrong.body.includes(INDEX_MARKER), "D1: GET /canvas?k=wrong leaked the index page");

		// The index is only served at the trailing-slash URL.
		const index = await httpRequestOnce("GET", port, "/canvas/", { cookie: `canvas_access=${TOKEN}` });
		check(index.status === 200, `cookie GET /canvas/ expected 200, got ${index.status}`);
		check(index.body.includes(INDEX_MARKER), "cookie GET /canvas/ did not serve the index page");
		check(
			String(index.headers["content-type"]).startsWith("text/html"),
			`cookie GET /canvas/ expected text/html, got ${String(index.headers["content-type"])}`,
		);

		// D2: an unauthenticated non-GET must get the uniform 401, not a 405.
		const anonPost = await httpRequestOnce("POST", port, "/canvas/");
		check(anonPost.status === 401, `D2: unauthenticated POST /canvas/ expected 401, got ${anonPost.status}`);
		check(!anonPost.body.includes(INDEX_MARKER), "D2: unauthenticated POST body leaked the index page");
		const authedPost = await httpRequestOnce("POST", port, "/canvas/", { cookie: `canvas_access=${TOKEN}` });
		check(authedPost.status === 405, `D2: authenticated POST /canvas/ expected 405, got ${authedPost.status}`);

		// D3: a token on a file path redirects to that file, not the gallery index.
		const fileHandshake = await httpRequestOnce("GET", port, `/canvas/day/2026-10-18.svg?k=${TOKEN}`);
		check(fileHandshake.status === 302, `D3: file handshake expected 302, got ${fileHandshake.status}`);
		check(
			fileHandshake.headers.location === "/canvas/day/2026-10-18.svg",
			`D3: file handshake expected Location /canvas/day/2026-10-18.svg, got ${String(fileHandshake.headers.location)}`,
		);
		const file = await httpRequestOnce("GET", port, "/canvas/day/2026-10-18.svg", {
			cookie: `canvas_access=${TOKEN}`,
		});
		check(file.status === 200 && file.body.includes(SVG_MARKER), "D3: authenticated file read did not serve the art");

		// The token must never reach the log.
		check(!server.log.includes(TOKEN), "token leaked into the server log");
	} finally {
		await server.stop();
		await rm(dataDir, { recursive: true, force: true });
	}
}

/** Existing routes keep their status codes while /canvas is additive. */
async function routeAdditivity(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-fixes-additivity-"));
	await makePublicTree(dataDir);
	const server = await startServer(dataDir, TOKEN);
	try {
		const port = server.port;
		const health = await httpRequestOnce("GET", port, "/health");
		console.log(`  GET /health -> ${health.status}`);
		check(health.status === 200, `/health expected 200, got ${health.status}`);

		const home = await httpRequestOnce("GET", port, "/");
		console.log(`  GET / -> ${home.status}`);
		check(home.status === 200, `/ expected 200 (web built), got ${home.status}`);

		const authState = await httpRequestOnce("GET", port, "/api/auth/state");
		console.log(`  GET /api/auth/state -> ${authState.status}`);
		check(authState.status === 200, `/api/auth/state expected 200, got ${authState.status}`);

		// An existing /api/* route, unauthenticated: the pre-existing 401.
		const apiStatus = await httpRequestOnce("GET", port, "/api/status");
		console.log(`  GET /api/status -> ${apiStatus.status}`);
		check(apiStatus.status === 401, `/api/status expected 401, got ${apiStatus.status}`);
	} finally {
		await server.stop();
		await rm(dataDir, { recursive: true, force: true });
	}
}

/** The server starts and /health is 200 with the token unset/empty and no canvas tree. */
async function startupWithoutCanvas(): Promise<void> {
	for (const [label, token] of [
		["unset", undefined],
		["empty", ""],
	] as const) {
		const dataDir = await mkdtemp(join(tmpdir(), `canvas-fixes-startup-${label}-`));
		// Deliberately do NOT create ${DATA_DIR}/workspace/canvas/public.
		try {
			const server = await startServer(dataDir, token);
			try {
				const health = await httpRequestOnce("GET", server.port, "/health");
				check(health.status === 200, `${label}: /health expected 200, got ${health.status}`);
				const canvas = await httpRequestOnce("GET", server.port, "/canvas/");
				check(canvas.status === 404, `${label}: /canvas/ with no token/tree expected 404, got ${canvas.status}`);
				check(!canvas.body.includes(INDEX_MARKER), `${label}: disabled /canvas/ leaked content`);
				const bare = await httpRequestOnce("GET", server.port, "/canvas");
				check(bare.status === 404, `${label}: /canvas with no token/tree expected 404, got ${bare.status}`);
			} finally {
				await server.stop();
			}
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	}
}

async function main(): Promise<number> {
	ensureWebBuilt();
	await routeFixes();
	await routeAdditivity();
	await startupWithoutCanvas();

	if (failures.length > 0) {
		console.log("canvas fixes proof: FAIL");
		for (const failure of failures) console.log(`  - ${failure}`);
		return 1;
	}
	console.log("canvas fixes proof: PASS");
	console.log("  D1: GET /canvas and GET /canvas?k=token redirect to /canvas/; only /canvas/ serves the index");
	console.log("  D2: unauthenticated non-GET is 401; authenticated non-GET is 405");
	console.log("  D3: GET /canvas/day/x.svg?k=token redirects to /canvas/day/x.svg, not the gallery index");
	console.log("  additivity: /health 200, / 200, /api/auth/state 200, /api/status 401 unchanged");
	console.log("  startup: /health 200 and /canvas 404 with the token unset/empty and no canvas tree");
	return 0;
}

try {
	process.exitCode = await main();
} finally {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
}

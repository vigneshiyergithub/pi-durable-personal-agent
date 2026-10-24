// Re-runnable regression proof for the /canvas route:
//
//   1. Additivity: with CANVAS_ACCESS_TOKEN unset, /canvas is disabled (404)
//      while the existing routes are untouched in the same server run
//      (/health 200, / the web chat HTML, /api/status 401).
//   2. The route resolves its root from DATA_DIR: a fixture tree shaped like
//      ${DATA_DIR}/workspace/canvas/public is served, and nothing else on the
//      volume is reachable (secret files, generator scripts, symlink escapes).
//   3. The handler source really derives its root from config.dataDir and never
//      hardcodes /data.
//
// It starts the real production HTTP server (via scripts/canvas-static-serve.ts,
// which uses the real src/http.ts routing) and drives it over HTTP, so it needs
// no credentials and no network.
//
// Run with: npm run test:canvas-regression
//       or: node scripts/canvas-static-regression.ts

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const serveScript = join(here, "canvas-static-serve.ts");

const TOKEN = "regression-canvas-token";
const INDEX_MARKER = "RegressionCanvasIndex";
const GALLERY_MARKER = "RegressionCanvasGallery";
const SECRET_MARKER = "TOP-SECRET-VOLUME-DATA";

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function httpRequestOnce(method: string, port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const allHeaders: Record<string, string> = { connection: "close", ...headers };
		const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: allHeaders }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
		});
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
			const res = await httpRequestOnce("GET", port, "/health");
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(50);
	}
	throw new Error("server did not become ready in time");
}

/** Start the real server in a child process with the given env, run the body, then stop it. */
async function withServer(env: Record<string, string>, body: (port: number) => Promise<void>): Promise<void> {
	const port = await freePort();
	const logDir = await mkdtemp(join(tmpdir(), "canvas-regression-log-"));
	const logFd = openSync(join(logDir, "server.log"), "w");
	const child = spawn(process.execPath, ["--max-old-space-size=1024", serveScript], {
		env: { ...process.env, PORT: String(port), ...env },
		stdio: ["ignore", logFd, logFd],
	});
	child.on("error", (error) => console.error("failed to start server:", error));
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		await waitForServer(port, 10_000);
		await body(port);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await Promise.race([exited, sleep(2000)]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		try {
			closeSync(logFd);
		} catch {
			// already closed
		}
		await rm(logDir, { recursive: true, force: true });
	}
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}

function setCookieHeader(result: HttpResult): string {
	const raw = result.headers["set-cookie"];
	return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

function cookiePair(setCookie: string): string {
	const match = /canvas_access=([^;]+)/.exec(setCookie);
	return match ? `canvas_access=${match[1]}` : "";
}

/** Part 1: token unset -> /canvas disabled, existing routes unchanged. */
async function regressionPart(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-regression-off-"));
	await mkdir(join(dataDir, "workspace", "canvas", "public"), { recursive: true });
	await writeFile(join(dataDir, "workspace", "canvas", "public", "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	try {
		await withServer({ DATA_DIR: dataDir, CANVAS_ACCESS_TOKEN: "" }, async (port) => {
			const health = await httpRequestOnce("GET", port, "/health");
			check(health.status === 200, `/health expected 200, got ${health.status}`);
			let healthBody: { ok?: boolean; version?: string } = {};
			try {
				healthBody = JSON.parse(health.body) as { ok?: boolean; version?: string };
			} catch {
				// checked below
			}
			check(healthBody.ok === true, `/health body expected {ok:true,...}, got ${health.body}`);
			check(typeof healthBody.version === "string", `/health body missing version: ${health.body}`);

			const home = await httpRequestOnce("GET", port, "/");
			const homeType = String(home.headers["content-type"] ?? "");
			if (home.status === 200) {
				check(homeType.startsWith("text/html"), `/ expected text/html, got ${homeType}`);
				check(home.body.includes('id="root"') || home.body.includes("<title>Personal Agent</title>"), "/ did not return the web chat HTML");
			} else if (home.status === 503) {
				// web/dist not built in this checkout: the documented fallback.
				check(homeType.startsWith("text/plain"), `/ 503 expected text/plain, got ${homeType}`);
				check(home.body.includes("Web app not built"), `/ 503 body was not the usual fallback: ${home.body}`);
			} else {
				check(false, `/ expected 200 (built) or 503 (unbuilt), got ${home.status}`);
			}

			const api = await httpRequestOnce("GET", port, "/api/status");
			check(api.status === 401, `/api/status expected 401 unauthenticated, got ${api.status}`);
			check(api.body.includes('"unauthorized"'), `/api/status body expected unauthorized, got ${api.body}`);

			const canvas = await httpRequestOnce("GET", port, "/canvas/");
			check(canvas.status === 404, `/canvas/ with CANVAS_ACCESS_TOKEN unset expected 404, got ${canvas.status}`);
			const canvasFile = await httpRequestOnce("GET", port, "/canvas/index.html");
			check(canvasFile.status === 404, `/canvas/index.html with token unset expected 404, got ${canvasFile.status}`);
			for (const res of [canvas, canvasFile]) {
				check(!res.body.includes(INDEX_MARKER), "disabled /canvas leaked canvas content");
			}

			// The body must not hint at the required token.
			check(!/access[_-]?token|CANVAS_ACCESS_TOKEN/i.test(canvas.body), "disabled /canvas hinted at the token variable");

			// /health still healthy after the disabled /canvas requests.
			const healthAgain = await httpRequestOnce("GET", port, "/health");
			check(healthAgain.status === 200, `/health after /canvas expected 200, got ${healthAgain.status}`);
		});
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

/** Part 2: token set, fixture volume layout under DATA_DIR. */
async function volumePart(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-regression-on-"));
	const canvasRoot = join(dataDir, "workspace", "canvas");
	const publicRoot = join(canvasRoot, "public");
	await mkdir(join(publicRoot, "day"), { recursive: true });
	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	await writeFile(join(publicRoot, "gallery.html"), `<h1>${GALLERY_MARKER}</h1>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.svg"), `<svg>${INDEX_MARKER}</svg>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.json"), JSON.stringify({ art: INDEX_MARKER }));
	await writeFile(join(publicRoot, "url.txt"), "https://tunnel.example");
	// Secret-bearing neighbours on the same volume: must all be unreachable.
	await writeFile(join(canvasRoot, ".public-url"), `FAKE_TUNNEL_URL=https://tunnel.example ${SECRET_MARKER}`);
	await mkdir(join(canvasRoot, "run"), { recursive: true });
	await writeFile(join(canvasRoot, "run", "server.pid"), "12345");
	await mkdir(join(canvasRoot, "logs"), { recursive: true });
	await writeFile(join(canvasRoot, "logs", "agent.log"), SECRET_MARKER);
	await writeFile(join(canvasRoot, "generate.mjs"), `console.log("${SECRET_MARKER}");`);
	const outside = join(dataDir, "outside-secret.txt");
	await writeFile(outside, SECRET_MARKER);
	await symlink(outside, join(publicRoot, "link.svg"));

	try {
		await withServer({ DATA_DIR: dataDir, CANVAS_ACCESS_TOKEN: TOKEN }, async (port) => {
			const handshake = await httpRequestOnce("GET", port, `/canvas/?k=${TOKEN}`);
			check(handshake.status === 302, `/canvas/?k=token expected 302, got ${handshake.status}`);
			check(handshake.headers.location === "/canvas/", `/canvas/ handshake Location expected /canvas/, got ${String(handshake.headers.location)}`);
			const setCookie = setCookieHeader(handshake);
			check(/HttpOnly/i.test(setCookie), `cookie missing HttpOnly: ${setCookie}`);
			check(/SameSite=Lax/i.test(setCookie), `cookie missing SameSite=Lax: ${setCookie}`);
			check(/Path=\/canvas/i.test(setCookie), `cookie missing Path=/canvas: ${setCookie}`);
			const cookie = cookiePair(setCookie);
			check(cookie !== "", "handshake did not set a canvas_access cookie");

			// Serving the fixture proves the handler read its root from DATA_DIR.
			const index = await httpRequestOnce("GET", port, "/canvas/", { cookie });
			check(index.status === 200, `/canvas/ with cookie expected 200, got ${index.status}`);
			check(index.body.includes(INDEX_MARKER), "/canvas/ did not serve the DATA_DIR fixture index");
			check(String(index.headers["content-type"]).startsWith("text/html"), `/canvas/ content-type expected text/html, got ${String(index.headers["content-type"])}`);
			check(index.headers["x-content-type-options"] === "nosniff", "/canvas/ missing X-Content-Type-Options: nosniff");

			const gallery = await httpRequestOnce("GET", port, "/canvas/gallery.html", { cookie });
			check(gallery.status === 200 && gallery.body.includes(GALLERY_MARKER), `/canvas/gallery.html expected 200 + marker, got ${gallery.status}`);

			const svg = await httpRequestOnce("GET", port, "/canvas/day/2026-10-18.svg", { cookie });
			check(svg.status === 200, `/canvas/day/2026-10-18.svg expected 200, got ${svg.status}`);
			check(svg.headers["content-type"] === "image/svg+xml", `svg content-type expected image/svg+xml, got ${String(svg.headers["content-type"])}`);

			const json = await httpRequestOnce("GET", port, "/canvas/day/2026-10-18.json", { cookie });
			check(json.status === 200, `/canvas/day/2026-10-18.json expected 200, got ${json.status}`);
			check(json.headers["content-type"] === "application/json", `json content-type expected application/json, got ${String(json.headers["content-type"])}`);

			// Unknown extension: rejected, never sniffed.
			const txt = await httpRequestOnce("GET", port, "/canvas/url.txt", { cookie });
			check(txt.status === 404, `/canvas/url.txt expected 404, got ${txt.status}`);

			// Everything else on the volume stays unreachable. These forms reach the
			// canvas handler (their separators/dots are still encoded in the parsed
			// pathname) and must be rejected with 404.
			const rejected = [
				"/canvas/.public-url",
				"/canvas/run/server.pid",
				"/canvas/logs/agent.log",
				"/canvas/generate.mjs",
				"/canvas/link.svg",
				"/canvas/%2e%2e%2f.public-url",
				"/canvas/..%2f.public-url",
				"/canvas/..%5C.public-url",
				"/canvas/%252e%252e%252f.public-url",
				"/canvas/day/",
			];
			for (const path of rejected) {
				const res = await httpRequestOnce("GET", port, path, { cookie });
				check(res.status === 404, `${path} expected 404, got ${res.status}`);
				check(!res.body.includes(SECRET_MARKER), `${path} leaked secret volume content`);
				check(!res.body.includes(INDEX_MARKER), `${path} leaked canvas content`);
				check(!res.body.includes("Index of"), `${path} returned a directory listing`);
			}

			// Plain `..` / backslashes are removed by WHATWG URL parsing before
			// routing, so they never reach the canvas handler; they must still not
			// leak any volume content (they fall through to the existing web app).
			for (const path of ["/canvas/../.public-url", "/canvas/..\\.public-url", "/canvas/../../logs/agent.log"]) {
				const res = await httpRequestOnce("GET", port, path, { cookie });
				check(!res.body.includes(SECRET_MARKER), `${path} leaked secret volume content`);
				check(!res.body.includes(INDEX_MARKER), `${path} leaked canvas content`);
			}

			// Wrong token: 401, no content, no hint.
			const wrong = await httpRequestOnce("GET", port, `/canvas/?k=wrong-token`);
			check(wrong.status === 401, `/canvas/?k=wrong-token expected 401, got ${wrong.status}`);
			check(!wrong.body.includes(INDEX_MARKER), "401 body leaked canvas content");
			check(!/access[_-]?token|CANVAS_ACCESS_TOKEN/i.test(wrong.body), "401 body hinted at the token variable");
		});
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

/** Part 3: static assertion that the root comes from DATA_DIR, not a hardcoded path. */
async function sourcePart(): Promise<void> {
	const httpSource = await readFile(join(repoRoot, "src", "http.ts"), "utf8");
	check(
		httpSource.includes('join(config.dataDir, "workspace", "canvas", "public")'),
		"src/http.ts does not derive the canvas root from config.dataDir",
	);
	check(!/["'`]\/data\//.test(httpSource), "src/http.ts contains a hardcoded /data path");
}

async function main(): Promise<number> {
	console.log("canvas regression proof");
	await regressionPart();
	await volumePart();
	await sourcePart();

	if (failures.length > 0) {
		console.log("\nFAIL");
		for (const failure of failures) console.log(`  - ${failure}`);
		return 1;
	}
	console.log("  /health 200, / chat UI served, /api/status 401, /canvas disabled (404) with the token unset");
	console.log("  /canvas served the DATA_DIR fixture (index, gallery, svg, json) behind the token cookie");
	console.log("  volume neighbours and traversal/symlink escapes all 404, no listings, no secret content");
	console.log("  src/http.ts derives the root from config.dataDir with no hardcoded /data");
	console.log("\nPASS: existing routes unchanged and /canvas is additive");
	return 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.error("proof crashed:", error);
		process.exitCode = 1;
	},
);

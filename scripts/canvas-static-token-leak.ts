// Re-runnable proof that CANVAS_ACCESS_TOKEN never leaks into logs, response
// bodies or response headers.
//
// It starts the real production HTTP server (via scripts/canvas-static-serve.ts)
// with a distinctive canary token, captures the server's stdout+stderr to a
// file, then exercises:
//   * /canvas/?k=<canary>       -> 302 + Set-Cookie (the one legitimate carrier)
//   * /canvas/ with that cookie -> 200 file
//   * /canvas/ with a wrong token -> 401
//   * /canvas/ with no token      -> 401
//   * /canvas/nope.svg            -> 404
//   * a traversal attempt         -> 404
//   * the handled-error path: a malformed request target with the canary in the
//     query string -> 400, and an authenticated route whose handler throws with
//     the canary in the query string -> 500, must not log the query
//
// Then it greps the canary through the captured logs and every response, and
// fails (exit 1) if it appears anywhere except the successful handshake's
// Set-Cookie value. It also checks that no logged line contains a "?k=" value.
//
// Run with: npm run test:canvas-token-leak
//       or: node scripts/canvas-static-token-leak.ts

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CANARY = "zzCANARY7f3a9b2c6d4e1f8a5b0c9d2e7f4a1b3czz";
const INDEX_MARKER = "Canvas Gallery Index";
const WRONG_TOKEN = "definitely-not-the-canvas-token";
// Throwaway bearer set only in this proof's child process, so the proof can
// reach an authenticated route that throws inside the server's own try/catch
// and exercises the production error logger.
const PROOF_AUTH_TOKEN = "proof-auth-token-not-a-secret";

const here = dirname(fileURLToPath(import.meta.url));
const serveScript = join(here, "canvas-static-serve.ts");

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

interface NamedResponse {
	name: string;
	result: HttpResult;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function countOccurrences(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let count = 0;
	let index = 0;
	while ((index = haystack.indexOf(needle, index)) !== -1) {
		count += 1;
		index += needle.length;
	}
	return count;
}

function httpRequestOnce(
	method: string,
	port: number,
	path: string,
	headers: Record<string, string>,
	body?: string,
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(body);
		const allHeaders: Record<string, string> = { connection: "close", ...headers };
		if (payload) allHeaders["content-length"] = String(payload.byteLength);
		const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: allHeaders }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
		});
		req.on("error", reject);
		if (payload) req.write(payload);
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
			const port = address.port;
			probe.close(() => resolve(port));
		});
	});
}

async function waitForServer(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await httpRequestOnce("GET", port, "/health", {});
			if (res.status === 200) return;
		} catch {
			// not up yet
		}
		await sleep(50);
	}
	throw new Error("server did not become ready in time");
}

function headerText(name: string, value: string | string[] | undefined): string {
	if (value === undefined) return "";
	return `${name}: ${Array.isArray(value) ? value.join(", ") : value}`;
}

async function main(): Promise<number> {
	const dataDir = await mkdtemp(join(tmpdir(), "canvas-token-leak-"));
	const canvasRoot = join(dataDir, "workspace", "canvas");
	const publicRoot = join(canvasRoot, "public");

	await mkdir(join(publicRoot, "day"), { recursive: true });
	await writeFile(join(publicRoot, "index.html"), `<h1>${INDEX_MARKER}</h1>`);
	await writeFile(join(publicRoot, "day", "2026-10-18.svg"), "<svg>canvas art</svg>");
	// Secret-bearing files outside the public tree: never reachable, never logged.
	await writeFile(join(canvasRoot, ".public-url"), "FAKE_TUNNEL_URL=https://tunnel.example");
	await mkdir(join(canvasRoot, "logs"), { recursive: true });
	await writeFile(join(canvasRoot, "logs", "agent.log"), "secret agent log line");

	const port = await freePort();
	const logPath = join(dataDir, "server.log");
	const logFd = openSync(logPath, "w");
	const child = spawn(process.execPath, ["--max-old-space-size=1024", serveScript], {
		env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), CANVAS_ACCESS_TOKEN: CANARY, AUTH_TOKEN: PROOF_AUTH_TOKEN },
		stdio: ["ignore", logFd, logFd],
	});
	child.on("error", (error) => console.error("failed to start server:", error));
	// Register before any request: the child may crash (that is one of the things
	// we are testing for) before we get to the shutdown step.
	const childExited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

	let exitCode = 1;
	try {
		await waitForServer(port, 10_000);

		const responses: NamedResponse[] = [];
		const record = (name: string, result: HttpResult) => {
			responses.push({ name, result });
			return result;
		};

		// 1. Token handshake: the only place the canary may legitimately appear.
		const handshake = record("handshake", await httpRequestOnce("GET", port, `/canvas/?k=${CANARY}`, {}));
		const rawSetCookie = handshake.headers["set-cookie"];
		const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
		const cookieMatch = setCookie ? /canvas_access=([^;]+)/.exec(setCookie) : null;
		const cookie = cookieMatch ? `canvas_access=${cookieMatch[1]}` : "";

		// 2. Authenticated read from the cookie.
		record("cookie-index", await httpRequestOnce("GET", port, "/canvas/", { cookie }));

		// 3. Auth failures and not-found, with the canary never in the request.
		record("wrong-token", await httpRequestOnce("GET", port, `/canvas/?k=${WRONG_TOKEN}`, {}));
		record("no-token", await httpRequestOnce("GET", port, "/canvas/", {}));
		record("missing-file", await httpRequestOnce("GET", port, "/canvas/nope.svg", { cookie }));
		record("traversal", await httpRequestOnce("GET", port, "/canvas/%2e%2e%2f.public-url", { cookie }));

		// 4. Handled error inside the server's own try/catch, canary in the query.
		record(
			"error-messages",
			await httpRequestOnce("GET", port, `/api/messages?k=${CANARY}`, { authorization: `Bearer ${PROOF_AUTH_TOKEN}` }),
		);

		// 5. Malformed request target carrying the canary: this used to throw
		// before the server's try/catch and print the raw target (query included)
		// as an Error property. It must now be handled without logging the target.
		let malformed: HttpResult;
		try {
			malformed = await httpRequestOnce("GET", port, `///%2f?k=${CANARY}`, {});
		} catch (error) {
			malformed = { status: 0, headers: {}, body: `request failed: ${(error as Error).message}` };
		}
		record("malformed-url", malformed);

		// Let the server flush its log before we stop it.
		await sleep(200);
		child.kill("SIGTERM");
		await childExited;
		closeSync(logFd);
		const logText = await readFile(logPath, "utf8");

		// ── Analysis ────────────────────────────────────────────────────────────
		const logCount = countOccurrences(logText, CANARY);

		let bodyCount = 0;
		let bodyCount401404 = 0;
		let headerViolations = 0;
		let legitSetCookieCount = 0;
		for (const { name, result } of responses) {
			bodyCount += countOccurrences(result.body, CANARY);
			if (result.status === 401 || result.status === 404) bodyCount401404 += countOccurrences(result.body, CANARY);
			for (const [header, value] of Object.entries(result.headers)) {
				const text = headerText(header, value);
				let occurrences = countOccurrences(text, CANARY);
				if (name === "handshake" && header.toLowerCase() === "set-cookie") {
					legitSetCookieCount += occurrences;
					occurrences = 0; // legitimate carrier
				}
				headerViolations += occurrences;
			}
		}

		const kQueryInLogs = logText.includes("?k=");

		// ── Report ──────────────────────────────────────────────────────────────
		// Mask the canary in our own output so it cannot be mistaken for a leak.
		const maskedCanary = `${CANARY.slice(0, 8)}...${CANARY.slice(-4)}`;
		console.log("canvas token-leak proof");
		console.log(`  canary                          : ${maskedCanary}`);
		console.log(`  canary in stdout/stderr         : ${logCount}`);
		console.log(`  canary in response bodies       : ${bodyCount}`);
		console.log(`  canary in 401/404 bodies        : ${bodyCount401404}`);
		console.log(`  canary in response headers      : ${headerViolations} (excluding legit Set-Cookie)`);
		console.log(`  canary in handshake Set-Cookie  : ${legitSetCookieCount} (legitimate)`);
		console.log(`  '?k=' present in logs           : ${kQueryInLogs}`);
		console.log("  statuses                        : " + responses.map((r) => `${r.name}=${r.result.status}`).join(", "));

		const failures: string[] = [];
		const check = (condition: boolean, message: string) => {
			if (!condition) failures.push(message);
		};

		// Positive controls: the proof is meaningless unless the flow really ran.
		check(handshake.status === 302, `handshake expected 302, got ${handshake.status}`);
		check(handshake.headers.location === "/canvas/", `handshake Location expected /canvas/, got ${String(handshake.headers.location)}`);
		check(legitSetCookieCount >= 1, "handshake Set-Cookie did not carry the canary (token not actually in use)");
		const index = responses.find((r) => r.name === "cookie-index")!;
		check(index.result.status === 200, `cookie read expected 200, got ${index.result.status}`);
		check(index.result.body.includes(INDEX_MARKER), "cookie read did not return the canvas index");
		check(logText.includes("[http] listening"), "server log was not captured (no listening line)");
		const httpLogLines = logText.split("\n").filter((line) => line.includes("[http]")).length;
		check(httpLogLines >= 2, "handled error path did not log through the production logger (positive control)");

		// The actual security assertions.
		check(logCount === 0, `canary leaked into stdout/stderr ${logCount} time(s)`);
		check(bodyCount === 0, `canary leaked into response bodies ${bodyCount} time(s)`);
		check(bodyCount401404 === 0, `canary leaked into a 401/404 body ${bodyCount401404} time(s)`);
		check(headerViolations === 0, `canary leaked into a response header ${headerViolations} time(s)`);
		check(!kQueryInLogs, "logs contain a '?k=' query value");

		// Status expectations for the exercised requests.
		const expected: Record<string, number> = {
			handshake: 302,
			"cookie-index": 200,
			"wrong-token": 401,
			"no-token": 401,
			"missing-file": 404,
			traversal: 404,
			"error-messages": 500,
			"malformed-url": 400,
		};
		for (const { name, result } of responses) {
			if (expected[name] !== undefined) check(result.status === expected[name], `${name} expected ${expected[name]}, got ${result.status}`);
		}

		if (failures.length > 0) {
			console.log("\nFAIL");
			for (const failure of failures) console.log(`  - ${failure}`);
		} else {
			console.log("\nPASS: canary appears 0 times in logs and response bodies; only in the handshake Set-Cookie");
		}
		exitCode = failures.length === 0 ? 0 : 1;
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		try {
			closeSync(logFd);
		} catch {
			// already closed
		}
		await rm(dataDir, { recursive: true, force: true });
	}
	return exitCode;
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

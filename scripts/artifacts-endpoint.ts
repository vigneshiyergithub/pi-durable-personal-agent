// Proof for GET /api/artifacts: the session-authenticated Artifacts endpoint with server-side
// canvas-token resolution. It follows scripts/canvas-static-fixes.ts' live-server pattern: it
// starts the *real* production server (`node src/main.ts`) with a throwaway DATA_DIR and PORT,
// drives it over HTTP, and kills the child afterwards.
//
// Cases (each prints a named PASS line and appends to the failure list when it does not hold):
//   1  unauthenticated -> 401, none of the data file's url strings in the body
//   2  authenticated (real passkey enrolment over HTTP: bearer bootstrap -> passkey
//      registration -> session cookie) -> 200 with the rows
//   3  fixture add/remove cycle against the SAME running server, no restart: write the data
//      file, the entry appears; delete it, it is gone
//   4  data file absent -> the built-in canvas and blog defaults
//   5  hostile fixture (javascript: and data: urls + one valid entry) -> hostile ones absent,
//      skipped count >= 2, valid one present
//   6  empty entries array -> 200 with an empty list
//   7  secret scan: the data file written by the test never carries the token, the token
//      appears in no captured response body except the one resolved link per session-authed
//      response that composes it, and never in the server log
//   8  the resolved canvas link, fetched through the ?k= token/cookie handshake, returns 200
//   9  CANVAS_ACCESS_TOKEN unset -> the canvas entry is returned with an unavailable reason and
//      no url, instead of a broken token-bearing link
//   9b/9c  the blog's built-in default (auth marker "blog-url") resolves BLOG_PUBLIC_URL at
//      request time: unset -> blog row unavailable with a reason and no url (never the old
//      example.com placeholder); set to a throwaway https URL -> the row serves exactly that
//      URL with available:true; hostile values (javascript:, data:, relative, protocol-relative,
//      empty) each -> unavailable with a reason and no link
//  10  hostile token-gated entries (kind canvas, hostile urls: //evil.example.com/,
//      http://evil.example.com/, /\evil.example.com, https://evil.example.com/x,
//      javascript:alert(1), /canvas/../secret, /canvas/%2e%2e/secret, and a non-canvas kind
//      carrying the marker): one request per entry -> the exact token string appears NOWHERE in
//      the response, the id is not in the entries, and the refusal is counted (skipped === 1)
//  11  positive control: the legitimate "/canvas/" auth entry's link DOES contain the token (so
//      case 10 is not vacuous), the blog row is unaffected, and the composed link still works end
//      to end through the ?k= token/cookie handshake (302 then 200)
//
// Run with: npm run test:artifacts-endpoint
//       or: node scripts/artifacts-endpoint.ts

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestAuthenticator } from "./test-authenticator.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

// The token this proof configures for the server. Distinctive, never token-shaped beyond being
// long enough to be recognisable in scans.
const CANVAS_TOKEN = "artifacts-proof-canvas-token-z9ffqm4c";
// Throwaway bearer used once, to bootstrap the first passkey enrolment for each data dir —
// exactly how the owner enrols the very first passkey.
const PROOF_BEARER = "artifacts-proof-bearer-zzz";
const CANARY_MARKER = "ArtifactsProofCanvasIndex";

const mask = (value: string) =>
	typeof value === "string" ? value.replaceAll(CANVAS_TOKEN, `<${CANVAS_TOKEN.slice(0, 12)}…>`) : String(value);

interface HttpResult {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const failures: string[] = [];
function check(condition: boolean, message: string): void {
	if (!condition) failures.push(message);
}
function passLine(name: string, detail: string): void {
	console.log(`PASS ${name}: ${detail}`);
}

function httpRequestOnce(
	method: string,
	port: number,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(body);
		const allHeaders: Record<string, string> = { connection: "close", ...headers };
		if (payload) allHeaders["content-length"] = String(payload.byteLength);
		const req = httpRequest(
			{ hostname: "127.0.0.1", port, path, method, headers: allHeaders },
			(res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => void (text += chunk));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
			},
		);
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
	logPath: string;
	stop(): Promise<void>;
}

const children = new Set<ChildProcess>();
async function startServer(
	dataDir: string,
	canvasToken: string | undefined,
	bearer: string,
	blogUrl: string | undefined = undefined,
): Promise<ServerHandle> {
	const port = await freePort();
	const logPath = join(dataDir, "server.log");
	const logFd = openSync(logPath, "w");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DATA_DIR: dataDir,
		PORT: String(port),
		OPENROUTER_API_KEY: "unused",
		AUTH_TOKEN: bearer,
	};
	delete env.CANVAS_ACCESS_TOKEN;
	delete env.BLOG_PUBLIC_URL;
	if (canvasToken !== undefined) env.CANVAS_ACCESS_TOKEN = canvasToken;
	if (blogUrl !== undefined) env.BLOG_PUBLIC_URL = blogUrl;
	const child = spawn(process.execPath, ["--max-old-space-size=1024", mainScript], {
		cwd: repoRoot,
		env,
		stdio: ["ignore", logFd, logFd],
	});
	children.add(child);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const handle: ServerHandle = {
		port,
		logPath,
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

interface ArtifactsResponse {
	source?: unknown;
	skipped?: unknown;
	entries?: Array<Record<string, unknown>>;
}

function asArtifacts(result: HttpResult): ArtifactsResponse {
	return JSON.parse(result.body) as ArtifactsResponse;
}

/**
 * The real session handshake: POST /api/auth/register/options with the legacy bearer (valid only
 * for the first passkey), then POST /api/auth/register/verify carrying a genuine WebAuthn
 * registration response, and return the agent_session cookie the server sets.
 */
async function enrol(server: ServerHandle, bearer: string): Promise<string> {
	const origin = `http://localhost:${server.port}`;
	const post = { authorization: `Bearer ${bearer}`, origin, "content-type": "application/json" };
	const options = await httpRequestOnce("POST", server.port, "/api/auth/register/options", post);
	check(options.status === 200, `register/options expected 200, got ${options.status}: ${options.body.slice(0, 200)}`);
	const device = new TestAuthenticator("localhost", origin);
	const challenge = (JSON.parse(options.body) as { challenge: string }).challenge;
	const verify = await httpRequestOnce(
		"POST",
		server.port,
		"/api/auth/register/verify",
		post,
		JSON.stringify({ response: device.register({ challenge }), name: "Artifacts Proof Passkey" }),
	);
	check(verify.status === 200, `register/verify expected 200, got ${verify.status}: ${verify.body.slice(0, 200)}`);
	const raw = verify.headers["set-cookie"];
	const setCookie = Array.isArray(raw) ? raw.join("; ") : (raw ?? "");
	const session = /agent_session=([^;]+)/.exec(setCookie);
	check(session !== null, "register/verify did not set the agent_session cookie");
	return session ? `agent_session=${session[1]}` : "";
}

interface Capture {
	name: string;
	result: HttpResult;
	/** How many times the token may legitimately appear: 0 unless the body carries a resolved token-gated link. */
	allowedTokens: number;
}

/** Total occurrences of the token that may appear in the given body, counting resolved links. */
function allowedTokenOccurrences(body: ArtifactsResponse): number {
	return (body.entries ?? []).filter((e) => typeof e.url === "string" && e.url.includes(`?k=${encodeURIComponent(CANVAS_TOKEN)}`)).length;
}

async function main(): Promise<number> {
	console.log("artifacts endpoint proof");
	const dataDir = await mkdtemp(join(tmpdir(), "artifacts-endpoint-"));
	const canvasPublic = join(dataDir, "workspace", "canvas", "public");
	await mkdir(canvasPublic, { recursive: true });
	await writeFile(join(canvasPublic, "index.html"), `<h1>${CANARY_MARKER}</h1>`);

	// The data file exists BEFORE case 1, so the 401 check has real url strings to withhold.
	const fixtureUrl = "https://proof-blog.example/latest";
	const fixtureId = "blog-fixture";
	const fixtureTitle = "Proof blog";
	const artifactsFile = join(dataDir, "artifacts.json");
	const writeData = async (value: unknown) => writeFile(artifactsFile, JSON.stringify(value));
	await writeData({
		artifacts: [
			{ id: fixtureId, title: fixtureTitle, kind: "blog", url: fixtureUrl, description: "fixture from the proof" },
			{ id: "canvas-fixture", title: "Secret canvas note", kind: "canvas", url: "/canvas/", description: "token-gated", auth: "canvas-token" },
		],
	});

	const server = await startServer(dataDir, CANVAS_TOKEN, PROOF_BEARER);
	const captured: Capture[] = [];
	const record = (name: string, result: HttpResult): HttpResult => {
		captured.push({ name, result, allowedTokens: allowedTokenOccurrences(result.body ? asArtifacts(result) : {}) });
		return result;
	};
	const urlsOf = (body: ArtifactsResponse) => (body.entries ?? []).map((e) => String(e.url));
	/** How many resolved token-gated links this response carries: the only legitimate token carriers. */
	const carryingToken = (artifactBody: ArtifactsResponse) =>
		(artifactBody.entries ?? []).filter((e) => typeof e.url === "string" && e.url.includes(`?k=${encodeURIComponent(CANVAS_TOKEN)}`)).length;

	try {
		// 1. Unauthenticated: 401 in the repo's shared shape; no url string from the data file leaks.
		const anon = record("anon", await httpRequestOnce("GET", server.port, "/api/artifacts"));
		check(anon.status === 401, `case 1: unauthenticated GET expected 401, got ${anon.status}`);
		check(
			!anon.body.includes(fixtureUrl) && !anon.body.includes("/canvas/") && !anon.body.includes(fixtureTitle),
			"case 1: the 401 body leaked url strings from the data file",
		);
		const anonError = JSON.parse(anon.body) as { error?: string };
		check(anonError.error === "unauthorized", `case 1: expected the shared unauthorized body, got ${anon.body.slice(0, 200)}`);
		console.log(`1. unauthenticated GET /api/artifacts -> ${anon.status}`);
		passLine("t1-unauth-401-no-urls", `status 401 and none of the data-file url strings in the body`);

		// 2. Authenticated through the real session handshake -> 200 and the rows.
		const cookie = await enrol(server, PROOF_BEARER);
		const authed = record("authed", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(authed.status === 200, `case 2: authenticated GET expected 200, got ${authed.status}`);
		const authedBody = asArtifacts(authed);
		check(
			urlsOf(authedBody).includes(fixtureUrl) && carryingToken(authedBody) === 1,
			`case 2: expected the fixture rows, got ${JSON.stringify(authedBody.entries ?? []).slice(0, 400)}`,
		);
		console.log(`2. authenticated GET /api/artifacts -> ${authed.status}`);
		for (const entry of authedBody.entries ?? []) {
			console.log(`   - row: ${String(entry.id)} kind=${String(entry.kind)} url=${mask(String(entry.url))} available=${String(entry.available)}`);
		}
		passLine("t2-auth-200-with-rows", "200 with the fixture rows (blog, token-gated canvas)");

		// 3. Fixture add/remove cycle against the SAME running server, no restart.
		const addedId = "added-entry";
		const addedUrl = "https://proof-added.example/note";
		await writeData({
			artifacts: [
				{ id: fixtureId, title: fixtureTitle, kind: "blog", url: fixtureUrl, description: "fixture from the proof" },
				{ id: addedId, title: "Added mid-run", kind: "report", url: addedUrl, description: "written while the server is up" },
				{ id: "canvas-fixture", title: "Secret canvas note", kind: "canvas", url: "/canvas/", description: "token-gated", auth: "canvas-token" },
			],
		});
		const withAdded = record("added", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(withAdded.status === 200, `case 3 (add): expected 200, got ${withAdded.status}`);
		check(urlsOf(asArtifacts(withAdded)).includes(addedUrl), "case 3 (add): the new entry did not appear without a restart");
		console.log(`3a. after writing the data file (no restart) -> the new entry ${addedUrl} is present`);
		passLine("t3a-add-without-restart", `the entry written mid-run appears immediately`);
		await writeData({
			artifacts: [
				{ id: fixtureId, title: fixtureTitle, kind: "blog", url: fixtureUrl, description: "fixture from the proof" },
				{ id: "canvas-fixture", title: "Secret canvas note", kind: "canvas", url: "/canvas/", description: "token-gated", auth: "canvas-token" },
			],
		});
		const withoutAdded = record("removed", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(withoutAdded.status === 200, `case 3 (remove): expected 200, got ${withoutAdded.status}`);
		check(!withoutAdded.body.includes(addedUrl) && !withoutAdded.body.includes(addedId), "case 3 (remove): the deleted entry is still served");
		console.log(`3b. after deleting the entry (no restart) -> it is gone`);
		passLine("t3b-remove-without-restart", "the deleted entry disappears immediately");

		// 4. Data file absent -> built-in canvas and blog defaults, with the blog's address resolved
		// from the environment (unset here -> unavailable with a reason, never a placeholder).
		await rm(artifactsFile, { force: true });
		const defaults = record("defaults", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(defaults.status === 200, `case 4: expected 200, got ${defaults.status}`);
		const defaultsBody = asArtifacts(defaults);
		const defaultIds = (defaultsBody.entries ?? []).map((e) => String(e.id)).sort();
		check(
			defaultsBody.source === "defaults" && JSON.stringify(defaultIds) === JSON.stringify(["blog", "canvas"]),
			`case 4: expected the built-in canvas and blog defaults, got ${JSON.stringify(defaultIds)} / source=${String(defaultsBody.source)}`,
		);
		const defaultBlog = (defaultsBody.entries ?? []).find((e) => e.id === "blog");
		check(
			defaultBlog !== undefined && defaultBlog.available === false && defaultBlog.url === null
				&& typeof defaultBlog.reason === "string" && (defaultBlog.reason as string).includes("unavailable"),
			`case 4: with BLOG_PUBLIC_URL unset the blog row must be unavailable (url null, reason), got ${JSON.stringify(defaultBlog ?? null)}`,
		);
		check(!defaults.body.includes("example.com") && !defaults.body.includes("BLOG_PUBLIC_URL_SPLICED"), "case 4: a placeholder or example.com URL was served");
		console.log(`4. with the data file absent -> rows: ${defaultIds.join(", ")} (source: ${String(defaultsBody.source)}); blog row: unavailable (${JSON.stringify(defaultBlog?.reason ?? null)})`);
		passLine("t4-missing-file-defaults", "canvas and blog defaults appear; the blog is unavailable with a reason and no url (env var unset)");

		// 5. Hostile fixture: javascript:, data:, plus one valid entry.
		const validId = "valid-entry";
		const validUrl = "https://proof-valid.example/report";
		await writeData({
			artifacts: [
				{ id: "js", title: "JS", url: "javascript:alert(1)", description: "hostile" },
				{ id: "data", title: "Data", url: "data:text/html,hi", description: "hostile" },
				{ id: validId, title: "Valid", kind: "report", url: validUrl, description: "regular entry" },
			],
		});
		const hostile = record("hostile", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(hostile.status === 200, `case 5: expected 200, got ${hostile.status}`);
		const hostileBody = asArtifacts(hostile);
		const hostileUrls = urlsOf(hostileBody);
		const skippedCount = Number(hostileBody.skipped ?? -1);
		check(
			!hostileUrls.includes("javascript:alert(1)") && !hostileUrls.includes("data:text/html,hi"),
			"case 5: a hostile url was served",
		);
		check(
			hostileUrls.includes(validUrl) && skippedCount >= 2,
			`case 5: expected the valid entry and skipped >= 2, got urls=${JSON.stringify(hostileUrls)} skipped=${skippedCount}`,
		);
		console.log(`5. hostile fixture -> javascript:/data: entries absent, skipped count: ${skippedCount}, valid entry present: ${hostileUrls.includes(validUrl)}`);
		passLine("t5-hostile-refused", `javascript:/data: absent with skipped=${skippedCount}, the valid entry present`);

		// 6. Empty entries array -> 200 with an empty list.
		await writeData({ artifacts: [] });
		const empty = record("empty", await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie }));
		check(empty.status === 200, `case 6: expected 200, got ${empty.status}`);
		const emptyBody = asArtifacts(empty);
		check(
			(emptyBody.entries ?? []).length === 0 && (emptyBody.source as string) === "file",
			`case 6: expected an empty list from the file, got ${empty.body.slice(0, 200)}`,
		);
		console.log(`6. empty entries array -> ${empty.status} with ${JSON.stringify(emptyBody)} rows`);
		passLine("t6-empty-list", "200 with an empty list");

		// 7. Secret scan. Restore the fixture first so the file on disk is one the test wrote.
		await writeData({
			artifacts: [
				{ id: fixtureId, title: fixtureTitle, kind: "blog", url: fixtureUrl, description: "fixture from the proof" },
				{ id: "canvas-fixture", title: "Secret canvas note", kind: "canvas", url: "/canvas/", description: "token-gated", auth: "canvas-token" },
			],
		});
		const scan = await readFile(artifactsFile, "utf8");
		check(!scan.includes(CANVAS_TOKEN), "case 7: the canvas token is stored in the data file");
		check(!scan.includes("?k="), "case 7: a token-bearing query is stored in the data file");
		check(!/[a-f0-9]{32}/.test(scan), "case 7: a 32-hex token-shaped string is stored in the data file");
		let tokenTotalss = 0;
		for (const { name, result, allowedTokens } of captured) tokenTotalss += count(result.body, CANVAS_TOKEN) - allowedTokens;
		check(tokenTotalss === 0, `case 7: the token appeared outside a resolved link ${tokenTotalss} time(s) across ${captured.length} captured response bodies`);
		check(count(anon.body, CANVAS_TOKEN) === 0, "case 7: the token appeared in the unauthenticated 401 body");
		console.log(`7. secret scan -> ${captured.length} response bodies scanned: token only inside resolved links (${tokenTotalss} violations); data file written by the test carries no token`);
		passLine("t7-secret-scan-clean", "no token in the data file, no token outside resolved links, no 32-hex slice in the data file");

		// 8. The resolved canvas link through the token/cookie flow -> 200.
		const canvasRow = (defaultsBody.entries ?? []).find((e) => e.id === "canvas");
		check(canvasRow !== undefined && typeof canvasRow?.url === "string" && canvasRow?.url.startsWith("/canvas/?k="), "case 8: the defaults response did not compose the canvas link");
		const canvasLink = (canvasRow?.url as string) ?? "";
		const handshake = await httpRequestOnce("GET", server.port, canvasLink);
		check(handshake.status === 302, `case 8: expected the ?k= handshake to 302, got ${handshake.status}`);
		const raw = handshake.headers["set-cookie"];
		const setCookie = Array.isArray(raw) ? raw[0] ?? "" : (raw ?? "");
		const canvasCookie = /canvas_access=([^;]+)/.exec(setCookie);
		check(canvasCookie !== null, "case 8: the handshake did not set the canvas_access cookie");
		const through = await httpRequestOnce("GET", server.port, "/canvas/", { cookie: canvasCookie ? `canvas_access=${canvasCookie[1]}` : "" });
		check(through.status === 200, `case 8: expected the cookie read to 200, got ${through.status}`);
		check(through.body.includes(CANARY_MARKER), "case 8: the cookie read did not return the canvas index");
		console.log(`8. resolved canvas link ${mask(canvasLink)} -> handshake ${handshake.status}, cookie read ${through.status}`);
		passLine("t8-canvas-link-200", "the composed link works through the token/cookie flow (302 then 200)");

		await server.stop();

		// The token must never reach the server log (the ?k= value included).
		const log = await readFile(server.logPath, "utf8").catch(() => "");
		check(!log.includes(CANVAS_TOKEN) && !log.includes("?k="), "case 7b: the canvas token leaked into the server log");
		passLine("t7b-token-not-in-log", "server log carries no token and no ?k=");
	} finally {
		await server.stop();
	}

	// 9. CANVAS_ACCESS_TOKEN unset (fresh server, fresh data dir): unavailable marker, no url.
	const dataDir2 = await mkdtemp(join(tmpdir(), "artifacts-endpoint-unset-"));
	const server2 = await startServer(dataDir2, undefined, PROOF_BEARER);
	try {
		const cookie2 = await enrol(server2, PROOF_BEARER);
		const unset = await httpRequestOnce("GET", server2.port, "/api/artifacts", { cookie: cookie2 });
		check(unset.status === 200, `case 9: expected 200, got ${unset.status}`);
		const unsetBody = asArtifacts(unset);
		const canvasRow = (unsetBody.entries ?? []).find((e) => e.id === "canvas");
		check(
			canvasRow !== undefined && canvasRow?.available === false && canvasRow?.url === null && typeof canvasRow?.reason === "string" && (canvasRow?.reason as string).includes("unavailable"),
			`case 9: expected an unavailable canvas entry with no url, got ${JSON.stringify(canvasRow ?? null)}`,
		);
		check(!unset.body.includes("?k="), "case 9: a token-bearing url appeared with the token unset");
		const disabled = await httpRequestOnce("GET", server2.port, "/canvas/");
		check(disabled.status === 404, `case 9: /canvas/ with the token unset expected 404 (route disabled), got ${disabled.status}`);
		console.log(`9. CANVAS_ACCESS_TOKEN unset -> canvas entry: ${JSON.stringify(canvasRow ?? null)}; /canvas/ -> ${disabled.status}`);
		passLine("t9-token-unset-unavailable", "clear unavailable marker with a null url, no broken link");
	} finally {
		await server2.stop();
		await rm(dataDir2, { recursive: true, force: true });
	}

	// 9b + 9c. Blog address resolution (BLOG_PUBLIC_URL), read exactly like the canvas reads its
	// token, at request time: one fresh server per value, data file absent (built-in defaults).
	//   set to a throwaway https URL -> the row serves EXACTLY that URL with available:true
	//   hostile values (javascript:, data:, relative, protocol-relative, empty) and none at all ->
	//     the row is available:false, url:null with a reason — a fallback "example.com" placeholder
	//     would fail the example.com check below
	const blogCases: Array<{ name: string; value?: string; expectUrl: string | null }> = [
		{ name: "unset", expectUrl: null },
		{ name: "set-throwaway-https", value: "https://proof-blog-throwaway.example/journal", expectUrl: "https://proof-blog-throwaway.example/journal" },
		{ name: "javascript", value: "javascript:alert(1)", expectUrl: null },
		{ name: "data", value: "data:text/html,x", expectUrl: null },
		{ name: "relative", value: "notes.html", expectUrl: null },
		{ name: "protocol-relative", value: "//evil.example.com/", expectUrl: null },
		{ name: "empty", value: "", expectUrl: null },
	];
	for (const blogCase of blogCases) {
		const dataDirBlog = await mkdtemp(join(tmpdir(), "artifacts-endpoint-blog-"));
		try {
			const serverBlog = await startServer(dataDirBlog, undefined, PROOF_BEARER, blogCase.value);
			try {
				const cookieBlog = await enrol(serverBlog, PROOF_BEARER);
				const res = await httpRequestOnce("GET", serverBlog.port, "/api/artifacts", { cookie: cookieBlog });
				check(res.status === 200, `case 9 (${blogCase.name}): expected 200, got ${res.status}`);
				const body = asArtifacts(res);
				const blogRow = (body.entries ?? []).find((e) => e.id === "blog");
				check(blogRow !== undefined, `case 9 (${blogCase.name}): the blog row is missing`);
				if (blogCase.expectUrl === null) {
					check(
						blogRow !== undefined && blogRow.available === false && blogRow.url === null
							&& typeof blogRow.reason === "string" && (blogRow.reason as string).includes("unavailable"),
						`case 9 (${blogCase.name}): expected an unavailable blog row (url null, reason), got ${JSON.stringify(blogRow ?? null)}`,
					);
					check(!res.body.includes("example.com"), `case 9 (${blogCase.name}): a placeholder/example.com url was served`);
				} else {
					check(
						blogRow !== undefined && blogRow.available === true && blogRow.url === blogCase.expectUrl,
						`case 9 (${blogCase.name}): expected the blog row to serve exactly ${blogCase.expectUrl}, got ${JSON.stringify(blogRow ?? null)}`,
					);
				}
				console.log(`9 (blog ${blogCase.name}) BLOG_PUBLIC_URL=${JSON.stringify(blogCase.value ?? null)} -> url=${JSON.stringify(blogRow?.url ?? null)} available=${String(blogRow?.available)} reason=${JSON.stringify(blogRow?.reason ?? null)}`);
				passLine(`t9b-blog-${blogCase.name}`, blogCase.expectUrl === null ? "unavailable with a reason and no url" : `serves exactly ${blogCase.expectUrl}`);
			} finally {
				await serverBlog.stop();
			}
		} finally {
			await rm(dataDirBlog, { recursive: true, force: true });
		}
	}

	// 10 + 11. Hostile token-gated entries and the positive control (fresh server, token SET, fresh data dir).
	const dataDir3 = await mkdtemp(join(tmpdir(), "artifacts-endpoint-hostile-"));
	const canvasPublic3 = join(dataDir3, "workspace", "canvas", "public");
	await mkdir(canvasPublic3, { recursive: true });
	await writeFile(join(canvasPublic3, "index.html"), `<h1>${CANARY_MARKER}</h1>`);
	const artifactsFile3 = join(dataDir3, "artifacts.json");
	const writeData3 = async (value: unknown) => writeFile(artifactsFile3, JSON.stringify(value));
	const server3 = await startServer(dataDir3, CANVAS_TOKEN, PROOF_BEARER);
	try {
		const cookie3 = await enrol(server3, PROOF_BEARER);
		// Hostile: every one of these carries the auth marker and must be refused with the exact
		// token string absent from the response and the refusal counted.
		const hostileAuth: Array<Record<string, string>> = [
			{ id: "h-proto-rel", kind: "canvas", auth: "canvas-token", url: "//evil.example.com/" },
			{ id: "h-abs-http", kind: "canvas", auth: "canvas-token", url: "http://evil.example.com/" },
			{ id: "h-backslash", kind: "canvas", auth: "canvas-token", url: "/\\evil.example.com" },
			{ id: "h-abs-https", kind: "canvas", auth: "canvas-token", url: "https://evil.example.com/x" },
			{ id: "h-js", kind: "canvas", auth: "canvas-token", url: "javascript:alert(1)" },
			{ id: "h-dotdot", kind: "canvas", auth: "canvas-token", url: "/canvas/../secret" },
			{ id: "h-encoded-dotdot", kind: "canvas", auth: "canvas-token", url: "/canvas/%2e%2e/secret" },
			{ id: "h-not-canvas", kind: "report", auth: "canvas-token", url: "/steal/" },
		];
		for (const hostileEntry of hostileAuth) {
			await writeData3({ artifacts: [hostileEntry] });
			const res = await httpRequestOnce("GET", server3.port, "/api/artifacts", { cookie: cookie3 });
			check(res.status === 200, `case 10 (${hostileEntry.id}): expected 200, got ${res.status}`);
			check(!res.body.includes(CANVAS_TOKEN), `case 10 (${hostileEntry.id}): the exact token string appears in the response`);
			check(!res.body.includes("?k="), `case 10 (${hostileEntry.id}): a token-bearing query appeared in the response`);
			const body = asArtifacts(res);
			check(
				!(body.entries ?? []).some((e) => String(e.id) === hostileEntry.id),
				`case 10 (${hostileEntry.id}): the hostile entry was served anyway`,
			);
			const skippedCount = Number(body.skipped ?? -1);
			check(skippedCount === 1, `case 10 (${hostileEntry.id}): expected the refusal counted (skipped=1), got ${skippedCount}`);
			console.log(`10. hostile auth entry ${hostileEntry.id} (url ${JSON.stringify(hostileEntry.url)}) -> token absent, refused (skipped=${skippedCount}, entries=${(body.entries ?? []).length})`);
			passLine(`t10-hostile-auth-${hostileEntry.id}`, "the token string appears nowhere in the response; refusal counted as skipped");
		}

		// 11. Positive control: the legitimate /canvas/ auth entry's link DOES contain the token, and
		// the composed link still works end to end through the ?k= token/cookie handshake.
		const legitUrl = "https://proof-blog.example/latest";
		await writeData3({
			artifacts: [
				{ id: "canvas-legit", title: "Canvas", kind: "canvas", url: "/canvas/", description: "token-gated", auth: "canvas-token" },
				{ id: "blog-legit", title: "Blog", kind: "blog", url: legitUrl, description: "not gated" },
			],
		});
		const positive = await httpRequestOnce("GET", server3.port, "/api/artifacts", { cookie: cookie3 });
		check(positive.status === 200, `case 11: expected 200, got ${positive.status}`);
		const positiveBody = asArtifacts(positive);
		const positiveCanvas = (positiveBody.entries ?? []).find((e) => e.id === "canvas-legit");
		check(
			positiveCanvas !== undefined && positiveCanvas.available === true && positiveCanvas.url === `/canvas/?k=${encodeURIComponent(CANVAS_TOKEN)}`,
			`case 11: expected the legitimate canvas link with the token, got ${JSON.stringify(positiveCanvas ?? null)}`,
		);
		check(positive.body.includes(CANVAS_TOKEN) && count(positive.body, CANVAS_TOKEN) === 1, "case 11: the token did not appear exactly once in the positive-control response");
		check(Number(positiveBody.skipped ?? -1) === 0, "case 11: the legitimate entries should not be skipped");
		check(
			(positiveBody.entries ?? []).some((e) => e.id === "blog-legit" && e.url === legitUrl && e.available === true),
			"case 11: the non-gated blog row is unaffected",
		);
		console.log(`11. positive control -> the legitimate canvas link carries the token exactly once (skipped=${String(positiveBody.skipped)})`);
		passLine("t11-positive-control-token-present", "the legitimate /canvas/ auth entry's link contains the token");
		const canvasLink3 = String(positiveCanvas?.url ?? "");
		const handshake3 = await httpRequestOnce("GET", server3.port, canvasLink3);
		check(handshake3.status === 302, `case 11: expected the ?k= handshake to 302, got ${handshake3.status}`);
		const raw3 = handshake3.headers["set-cookie"];
		const setCookie3 = Array.isArray(raw3) ? raw3[0] ?? "" : (raw3 ?? "");
		const canvasCookie3 = /canvas_access=([^;]+)/.exec(setCookie3);
		check(canvasCookie3 !== null, "case 11: the handshake did not set the canvas_access cookie");
		const through3 = await httpRequestOnce("GET", server3.port, "/canvas/", { cookie: canvasCookie3 ? `canvas_access=${canvasCookie3[1]}` : "" });
		check(through3.status === 200, `case 11: expected the cookie read to be 200, got ${through3.status}`);
		check(through3.body.includes(CANARY_MARKER), "case 11: the cookie read did not return the canvas index");
		console.log(`11. composed link ${mask(canvasLink3)} -> handshake ${handshake3.status}, cookie read ${through3.status}`);
		passLine("t11-canvas-link-e2e-200", "the legitimate composed link works end to end (302 then 200)");
	} finally {
		await server3.stop();
		await rm(dataDir3, { recursive: true, force: true });
	}

	await rm(dataDir, { recursive: true, force: true });
	if (failures.length > 0) {
		console.log("\nFAIL");
		for (const failure of failures) console.log(`  - ${failure}`);
		return 1;
	}
	console.log("\nartifacts endpoint proof: PASS");
	return 0;
}

function count(haystack: string, needle: string): number {
	if (needle === "") return 0;
	let total = 0;
	let index = 0;
	while ((index = haystack.indexOf(needle, index)) !== -1) {
		total += 1;
		index += needle.length;
	}
	return total;
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

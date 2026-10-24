// Proof of the documented add/remove workflow for the Artifacts list. It follows ONLY the steps
// the README documents ("Artifacts: one list of everything the agent has made"): it copies the
// README's own JSON example into a throwaway DATA_DIR, starts the real production server
// (`node src/main.ts`) pointed at it, signs in through the real passkey handshake, and shows:
//
//   (a) the documented example entry is served — the exact id/title/kind/url/description from
//       README.md's copy-pasteable example, from DATA_DIR/artifacts.json (source "file");
//   (b) after deleting the file, the built-in canvas and blog defaults are served instead.
//
// It exits 0 exactly when both hold, and it uses no token or secret: CANVAS_ACCESS_TOKEN and
// BLOG_PUBLIC_URL are both left unset on purpose, so nothing token-shaped is involved and no
// placeholder address can appear (the canvas and blog rows still resolve, just with the
// unavailable marker the README documents).
//
// Run with: npm run test:artifacts-workflow-proof
//       or: node scripts/artifacts-workflow-proof.ts

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TestAuthenticator } from "./test-authenticator.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const mainScript = join(repoRoot, "src", "main.ts");

// Throwaway bearer used once, to bootstrap the first passkey enrolment — exactly how the owner
// enrols the very first passkey (README: "Signing in: passkeys").
const PROOF_BEARER = "artifacts-workflow-proof-bearer-zzz";

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

const children = new Set<ChildProcess>();
async function startServer(dataDir: string): Promise<{ port: number; stop(): Promise<void> }> {
	const port = await freePort();
	const logPath = join(dataDir, "server.log");
	const logFd = openSync(logPath, "w");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		DATA_DIR: dataDir,
		PORT: String(port),
		OPENROUTER_API_KEY: "unused",
		AUTH_TOKEN: PROOF_BEARER,
	};
	delete env.CANVAS_ACCESS_TOKEN;
	delete env.BLOG_PUBLIC_URL;
	const child = spawn(process.execPath, ["--max-old-space-size=1024", mainScript], {
		cwd: repoRoot,
		env,
		stdio: ["ignore", logFd, logFd],
	});
	children.add(child);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	const handle = {
		port,
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

/** The real session handshake: bearer bootstrap of the first passkey enrolment (README: passkeys). */
async function enrol(port: number): Promise<string> {
	const origin = `http://localhost:${port}`;
	const post = { authorization: `Bearer ${PROOF_BEARER}`, origin, "content-type": "application/json" };
	const options = await httpRequestOnce("POST", port, "/api/auth/register/options", post);
	check(options.status === 200, `register/options expected 200, got ${options.status}: ${options.body.slice(0, 200)}`);
	const device = new TestAuthenticator("localhost", origin);
	const challenge = (JSON.parse(options.body) as { challenge: string }).challenge;
	const verify = await httpRequestOnce(
		"POST",
		port,
		"/api/auth/register/verify",
		post,
		JSON.stringify({ response: device.register({ challenge }), name: "Artifacts Workflow Proof" }),
	);
	check(verify.status === 200, `register/verify expected 200, got ${verify.status}: ${verify.body.slice(0, 200)}`);
	const raw = verify.headers["set-cookie"];
	const setCookie = Array.isArray(raw) ? raw.join("; ") : (raw ?? "");
	const session = /agent_session=([^;]+)/.exec(setCookie);
	check(session !== null, "register/verify did not set the agent_session cookie");
	return session ? `agent_session=${session[1]}` : "";
}

/** Extract README.md's own copy-pasteable JSON example from the fenced ```json block. */
function readDocumentedExample(): unknown {
	const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
	const section = readme.slice(readme.indexOf("## Artifacts"), readme.indexOf("In the web app the section"));
	const fenced = section.slice(section.indexOf("```json") + "```json".length, section.indexOf("```", section.indexOf("```json") + 9));
	return JSON.parse(fenced);
}

try {
	await main();
	process.exitCode = failures.length === 0 ? 0 : 1;
} finally {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
}

async function main(): Promise<void> {
	console.log("artifacts workflow proof (the documented steps, nothing else)");

	// (a) documented step 1: copy the README's example entry into DATA_DIR/artifacts.json.
	const dataDir = await mkdtemp(join(tmpdir(), "artifacts-workflow-"));
	const artifactsFile = join(dataDir, "artifacts.json");
	const documented = readDocumentedExample() as { artifacts: Array<Record<string, unknown>> };
	const example = documented.artifacts[0]!;
	await mkdir(dataDir, { recursive: true });
	await writeFile(artifactsFile, JSON.stringify(documented, null, 2));
	await stat(artifactsFile); // the file really is on disk
	console.log(`(a) wrote the README example to ${artifactsFile}:`);
	console.log(`    ${JSON.stringify(example)}`);

	// Documented step 2: the server reads the file at each request — just request the list.
	const server = await startServer(dataDir);
	try {
		// The list is never public (the canvas link carries access): an anonymous request is refused.
		const anon = await httpRequestOnce("GET", server.port, "/api/artifacts");
		check(anon.status === 401, `an unauthenticated GET expected the shared 401 gate, got ${anon.status}`);
		check(!anon.body.includes(String(example.url)), "the 401 body leaked the example's url string");
		console.log(`    unauthenticated GET -> ${anon.status} (never public)`);

		const cookie = await enrol(server.port);
		const authed = await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie });
		check(authed.status === 200, `authenticated GET expected 200, got ${authed.status}`);
		const body = JSON.parse(authed.body) as ArtifactsResponse;
		const row = (body.entries ?? []).find((e) => e.id === example.id);
		check(
			row !== undefined
			&& row.title === example.title
			&& row.kind === example.kind
			&& row.url === example.url
			&& row.description === example.description,
			`the documented example entry was not served as written: ${JSON.stringify(row ?? null)}`,
		);
		check(body.source === "file", `expected source "file", got ${String(body.source)}`);
		console.log(`(b) served from the file -> GET /api/artifacts -> ${authed.status}, source=${String(body.source)}`);
		console.log(`    row: id=${String(row?.id)} title=${String(row?.title)} kind=${String(row?.kind)} url=${String(row?.url)} description=${String(row?.description)}`);

		// (c) documented remove step: delete the file — no restart, no redeploy.
		await rm(artifactsFile, { force: true });
		const after = await httpRequestOnce("GET", server.port, "/api/artifacts", { cookie });
		check(after.status === 200, `GET after deleting the file expected 200, got ${after.status}`);
		const defaults = JSON.parse(after.body) as ArtifactsResponse;
		const ids = (defaults.entries ?? []).map((e) => String(e.id)).sort();
		check(
			defaults.source === "defaults" && JSON.stringify(ids) === JSON.stringify(["blog", "canvas"]),
			`expected the built-in canvas and blog defaults, got source=${String(defaults.source)} ids=${JSON.stringify(ids)}`,
		);
		check(!after.body.includes(String(example.id)) && !after.body.includes(String(example.url)), "the deleted example entry is still served");
		console.log(`(c) deleted the file -> GET /api/artifacts -> ${after.status}, source=${String(defaults.source)}`);
		for (const entry of defaults.entries ?? []) {
			console.log(`    row: id=${String(entry.id)} title=${String(entry.title)} kind=${String(entry.kind)} available=${String(entry.available)}`);
		}

		// The blog's built-in default carries NO address: with BLOG_PUBLIC_URL unset it renders as
		// unavailable with a reason — never the old example.com placeholder and never a dead link.
		const blogRow = (defaults.entries ?? []).find((e) => e.id === "blog");
		check(
			blogRow !== undefined && blogRow.available === false && blogRow.url === null
				&& typeof blogRow.reason === "string" && (blogRow.reason as string).includes("unavailable"),
			`expected the built-in blog row to be unavailable (url null, reason) with BLOG_PUBLIC_URL unset, got ${JSON.stringify(blogRow ?? null)}`,
		);
		check(!after.body.includes("example.com"), "a placeholder example.com url is served for the built-in blog");

		// Nothing secret-shaped anywhere in this flow: no token var and no BLOG_PUBLIC_URL was set, so
		// no body may carry a composed token link or a resolved blog address, and the data file this
		// proof wrote carries no token.
		for (const [name, result] of [["anon", anon], ["authed", authed], ["defaults", after]] as const) {
			check(!result.body.includes("?k=") && !result.body.includes("canvas_access="), `a token-shaped query appeared in the ${name} body`);
		}
		const fileText = await readFile(artifactsFile, "utf8").catch(() => "");
		check(fileText === "" ? true : !/token/i.test(fileText), "the data file carries a token-shaped string");

		await server.stop();
	} finally {
		await server.stop();
	}
	await rm(dataDir, { recursive: true, force: true });

	if (failures.length > 0) {
		console.log("\nFAIL");
		for (const failure of failures) console.log(`  - ${failure}`);
		return;
	}
	console.log("\nartifacts workflow proof: PASS");
}

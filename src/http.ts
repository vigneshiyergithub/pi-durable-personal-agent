// HTTP API, the AG-UI endpoint CopilotKit talks to, and the built web app (web/dist). Everything under /api needs the
// owner's passkey session (see src/auth.ts), except /api/auth/* (signing in), /api/runner/* (task containers, with their
// own per-attempt token), and the GitHub App setup callbacks, which are bound to a one-time state the owner started.
import { restoreJob } from "./schedule-policy.ts";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Agent } from "./agent.ts";
import { history, runAgui } from "./agui.ts";
import { composeTokenLink, loadArtifacts, urlError } from "./artifacts.ts";
import { ownerAuth } from "./auth.ts";
import { createCanvasHandler } from "./canvas-static.ts";
import { config } from "./config.ts";
import { scorecards } from "./scorecards.ts";
import { telemetry } from "./telemetry.ts";
import { vitals } from "./vitals.ts";
import { proxyChatCompletion } from "./llm-proxy.ts";
import { readBody } from "./request-body.ts";
import { Jobs } from "./state.ts";
import { Reports, roles } from "./office.ts";
import { readGitHubApp, replaceGitHubAppKey, writeGitHubApp } from "./sandbox.ts";
import { CanvasDoc } from "./elr/canvas.ts";
import { rasterizePng } from "./elr/raster.ts";

const webRoot = new URL("../web/dist/", import.meta.url).pathname;
const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
};

/** Signing in and managing passkeys. Returns false when the route is not an auth route. */
async function authRoute(route: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
	if (!route.startsWith("GET /api/auth/") && !route.startsWith("POST /api/auth/") && !route.startsWith("DELETE /api/auth/")) return false;
	const who = await ownerAuth.requester(request);
	const enrolled = await ownerAuth.enrolled();
	const guessing = route.endsWith("/recover") || route.endsWith("/login/verify") || route.endsWith("/register/verify");
	if (guessing && !ownerAuth.allow(request)) return json(response, 429, { error: "too many attempts; wait a few minutes" }), true;
	// The very first passkey may be enrolled with the legacy bearer token; every later one needs a signed-in session.
	const mayRegister = who.via === "session" || (!enrolled && who.via === "bearer");
	const fail = (error: unknown, status = 400) => json(response, status, { error: error instanceof Error ? error.message : String(error) });
	try {
		switch (route) {
			case "GET /api/auth/state":
				json(response, 200, { enrolled, authenticated: who.via === "session", bootstrap: !enrolled && Boolean(config.authToken) });
				return true;
			case "POST /api/auth/register/options":
				if (!mayRegister) return fail(new Error("sign in first"), 401), true;
				json(response, 200, await ownerAuth.registrationOptions());
				return true;
			case "POST /api/auth/register/verify":
				if (!mayRegister) return fail(new Error("sign in first"), 401), true;
				json(response, 200, await ownerAuth.register(response, (await body(request)) as { response: unknown; name?: unknown }));
				return true;
			case "POST /api/auth/login/options":
				json(response, 200, await ownerAuth.authenticationOptions());
				return true;
			case "POST /api/auth/login/verify":
				await ownerAuth.signIn(response, (await body(request)) as { response: { id?: string } });
				json(response, 200, { ok: true });
				return true;
			case "POST /api/auth/recover": {
				const { code } = await body(request);
				json(response, 200, await ownerAuth.recover(response, String(code ?? "")));
				return true;
			}
			case "POST /api/auth/logout":
				await ownerAuth.signOut(request, response);
				json(response, 200, { ok: true });
				return true;
		}
		// Managing your security needs a signed-in session (not the legacy token).
		if (who.via !== "session") return fail(new Error("sign in with your passkey first"), 401), true;
		if (route === "GET /api/auth/security") return json(response, 200, await ownerAuth.overview()), true;
		if (route === "POST /api/auth/recovery-codes") return json(response, 200, { recoveryCodes: await ownerAuth.regenerateRecoveryCodes() }), true;
		if (route === "POST /api/auth/logout-all") {
			await ownerAuth.signOutEverywhere();
			await ownerAuth.signOut(request, response);
			return json(response, 200, { ok: true }), true;
		}
		const remove = /^DELETE \/api\/auth\/passkeys\/([\w-]+)$/.exec(route);
		if (remove) return (await ownerAuth.removePasskey(remove[1]!), json(response, 200, { ok: true })), true;
		json(response, 404, { error: "not found" });
		return true;
	} catch (error) {
		fail(error);
		return true;
	}
}

const bearer = (request: IncomingMessage) => request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";

/**
 * GET /api/artifacts: the Artifacts quick-access list (see src/artifacts.ts) behind the web app's section. Session-only:
 * the canvas link carries the owner's canvas access, so there is no anonymous version of this route — it sits behind
 * the shared passkey gate and a caller without a session gets the same `{ error: "unauthorized" }` as every other /api
 * route, with no URLs.
 *
 * Token-gated entries (auth: "canvas-token") are composed HERE, at request time: the token lives only in the
 * environment and is spliced into the link the owner follows (the ?k= handshake of /canvas, which swaps it for a
 * cookie) — and ONLY onto a same-origin /canvas/ path of a genuine canvas entry (see src/artifacts.ts): the
 * loader refuses any other auth-marked entry (counted in skipped), and the composed link is re-validated
 * immediately before it is put in the response. The token is never stored in the data file, never logged, and
 * never sent to anyone unauthenticated. When CANVAS_ACCESS_TOKEN is unset the /canvas route is disabled anyway
 * (404), so the entry is returned with an `unavailable` reason and a null URL instead of a link that cannot work.
 *
 * The blog is handled the same way, via the `blog-url` marker: its public address is read HERE, at request
 * time, from `BLOG_PUBLIC_URL` — never from the data file, never baked into the build. The resolved value is
 * re-validated with the loader's URL rules (absolute http:// or https:// — javascript:, data:, file:,
 * protocol-relative, relative paths and empty values are refused) before it leaves the server. When the
 * variable is unset or invalid, the entry is returned with `available: false`, `url: null` and a reason —
 * never a placeholder and never a dead link.
 *
 * Blog URLs resolve per request, so restarting (or editing the environment) is enough to change them; the
 * data file only ever MARKS that the address comes from the environment.
 */
const BLOG_URL_ENV = "BLOG_PUBLIC_URL";
const UNCONFIGURED_BLOG = "unavailable: blog address is not configured";

export async function artifactList(): Promise<unknown> {
	const { entries, skipped, source } = await loadArtifacts();
	const token = process.env.CANVAS_ACCESS_TOKEN?.trim() ?? "";
	const rows: Array<Record<string, unknown>> = [];
	let refused = 0;
	for (const entry of entries) {
		const { auth, ...rest } = entry;
		if (auth === "blog-url") {
			// Resolve the blog's public address from the environment at request time and re-validate
			// it with the same URL rules as a data-file entry before it leaves the server.
			const candidate = process.env[BLOG_URL_ENV]?.trim() ?? "";
			if (candidate === "") {
				rows.push({ ...rest, url: null, available: false, reason: UNCONFIGURED_BLOG });
				continue;
			}
			const bad = urlError(candidate, undefined);
			if (bad !== undefined) {
				refused += 1;
				rows.push({ ...rest, url: null, available: false, reason: `unavailable: blog address refused (${bad})` });
				continue;
			}
			rows.push({ ...rest, url: candidate, available: true });
			continue;
		}
		if (auth !== "canvas-token") {
			rows.push({ ...rest, available: true });
			continue;
		}
		if (token === "") {
			// No token in the environment: the link would be broken (the canvas route answers 404), so return the
			// entry with a clear "unavailable" marker and no token-bearing URL instead.
			rows.push({ ...rest, url: null, available: false, reason: "unavailable: canvas access token is not configured" });
			continue;
		}
		// Compose the exact working canvas link: site path plus the ?k= token, which the canvas handler exchanges
		// for a cookie on the first follow — but never onto a target that is not the canvas itself.
		const composed = composeTokenLink(entry, token);
		if ("refused" in composed) {
			// The loader already refuses hostile token-gated entries, so this is unreachable from valid data;
			// kept as a final gate: no token and no off-origin URL leaves the server for a refused entry.
			refused += 1;
			rows.push({ ...rest, url: null, available: false, reason: `refused: ${composed.refused}` });
			continue;
		}
		rows.push({ ...rest, url: composed.url, available: true });
	}
	return { source, skipped: skipped.length + refused, entries: rows };
}

const canvasRoot = join(config.dataDir, "workspace", "canvas", "public");
const canvasHandler = createCanvasHandler(canvasRoot, process.env.CANVAS_ACCESS_TOKEN?.trim() ?? "");

/** Task containers report here with their per-attempt token; nothing else is reachable with it. */
async function runnerRoute(agent: Agent, route: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
	const input = await body(request, 32_000_000); // evidence carries the branch as a git bundle
	const token = bearer(request);
	const taskId = String(input.taskId);
	const attempt = Number(input.attempt);
	try {
		switch (route) {
			case "POST /api/runner/heartbeat":
				return json(response, 200, await agent.orchestrator.runnerHeartbeat(taskId, attempt, token, input.resources));
			case "POST /api/runner/holdouts":
				return json(response, 200, await agent.orchestrator.runnerHoldouts(taskId, attempt, token));
			case "POST /api/runner/evidence":
				await agent.orchestrator.runnerEvidence(taskId, attempt, token, input.evidence, input.sessionId);
				return json(response, 200, { ok: true });
			default:
				return json(response, 404, { error: "not found" });
		}
	} catch (error) {
		if (error instanceof Error && error.message === "unauthorized") return json(response, 401, { error: "unauthorized" });
		throw error;
	}
}

// ── GitHub App setup (manifest flow): GitHub returns the app's private key straight to this server. ─────────────────

const pendingSetups = new Map<string, number>(); // one-time state → expiry

function appManifest(base: string) {
	return {
		name: `pi-agent-${randomBytes(3).toString("hex")}`,
		url: base,
		hook_attributes: { url: `${base}/health`, active: false },
		redirect_url: `${base}/setup/github-app/callback`,
		setup_url: `${base}/setup/github-app/installed`,
		public: false,
		// administration: create repos for new projects. contents/pull_requests: push agent branches, open and merge PRs.
		// Tokens handed to task containers are narrowed to contents:read on one repo.
		default_permissions: { administration: "write", contents: "write", pull_requests: "write", metadata: "read" },
		default_events: [],
	};
}

const page = (response: ServerResponse, status: number, title: string, text: string) => {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	response.end(`<!doctype html><meta name=viewport content="width=device-width"><title>${title}</title><body style="font:16px system-ui;max-width:560px;margin:15vh auto;padding:0 16px"><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="/">Back to your agent</a></p>`);
};

async function setupRoute(url: URL, response: ServerResponse): Promise<void> {
	if (url.pathname === "/setup/github-app/callback") {
		const state = url.searchParams.get("state") ?? "";
		const expires = pendingSetups.get(state);
		pendingSetups.delete(state);
		if (!expires || expires < Date.now()) return page(response, 400, "Setup link expired", "Start the GitHub App setup again from your agent.");
		const code = encodeURIComponent(url.searchParams.get("code") ?? "");
		const converted = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
			method: "POST",
			headers: { accept: "application/vnd.github+json", "user-agent": "pi-durable-agent" },
		});
		if (!converted.ok) return page(response, 502, "GitHub App setup failed", `GitHub answered ${converted.status}. Start the setup again.`);
		const app = (await converted.json()) as { id: number; slug: string; pem: string };
		await writeGitHubApp({ appId: app.id, slug: app.slug, privateKey: app.pem });
		response.writeHead(302, { location: `https://github.com/apps/${app.slug}/installations/new` });
		return void response.end();
	}
	if (url.pathname === "/setup/github-app/installed") {
		const app = await readGitHubApp();
		return page(response, 200, "GitHub App installed", `${app ? `<b>${app.slug}</b> is installed.` : "Installed."} Your agent finds the org on its own; you can close this tab.`);
	}
	return page(response, 404, "Not found", "");
}

async function body(request: IncomingMessage, limit = 5_000_000): Promise<Record<string, any>> {
	const raw = (await readBody(request, limit)).toString("utf8");
	return raw ? JSON.parse(raw) : {};
}

const json = (response: ServerResponse, status: number, value: unknown) => {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
};

const gzipAsync = promisify(gzip);

/**
 * GET answers the web app polls: gzipped when the client takes it, with an ETag so an unchanged poll is a 304 with no
 * body. Every byte here is billed as egress, and the dashboard asks for these every few seconds while a tab is open.
 */
async function jsonCached(request: IncomingMessage, response: ServerResponse, value: unknown): Promise<void> {
	const body = Buffer.from(JSON.stringify(value));
	const etag = `"${createHash("sha256").update(body).digest("base64url").slice(0, 22)}"`;
	const headers = { "content-type": "application/json", etag, "cache-control": "no-cache", vary: "accept-encoding" };
	if (request.headers["if-none-match"] === etag) {
		response.writeHead(304, headers);
		response.end();
		return;
	}
	if (body.length > 1024 && String(request.headers["accept-encoding"] ?? "").includes("gzip")) {
		response.writeHead(200, { ...headers, "content-encoding": "gzip" });
		response.end(await gzipAsync(body));
		return;
	}
	response.writeHead(200, headers);
	response.end(body);
}

/** Health response: ok + version, where version is the short Git SHA from RAILWAY_GIT_COMMIT_SHA or "dev". */
export function health(): { ok: true; version: string } {
	const sha = process.env.RAILWAY_GIT_COMMIT_SHA?.trim();
	return { ok: true, version: sha ? sha.slice(0, 7) : "dev" };
}

/** Serves web/dist, falling back to index.html for client routes. Hashed assets are cached for a year. */
async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
	const file = normalize(join(webRoot, pathname === "/" ? "index.html" : pathname));
	if (!file.startsWith(webRoot)) return json(response, 404, { error: "not found" });
	try {
		const data = await readFile(file);
		const immutable = pathname.startsWith("/assets/");
		response.writeHead(200, {
			"content-type": types[extname(file)] ?? "application/octet-stream",
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		});
		response.end(data);
	} catch {
		if (extname(pathname) !== "") return json(response, 404, { error: "not found" });
		try {
			response.writeHead(200, { "content-type": types[".html"], "cache-control": "no-cache" });
			response.end(await readFile(join(webRoot, "index.html")));
		} catch {
			response.writeHead(503, { "content-type": "text/plain" });
			response.end("Web app not built: run `npm run build:web`.");
		}
	}
}

export function startHttp(agent: Agent) {
	const server = createServer(async (request, response) => {
		let url: URL;
		try {
			url = new URL(request.url ?? "/", "http://localhost");
		} catch {
			// Never let a malformed request target reach the logger: URL parse errors
			// carry the raw string (query string and any ?k= token included) as an
			// enumerable `input` property that console.error would print.
			response.writeHead(400, { "content-type": "text/plain" });
			response.end("Bad request");
			return;
		}
		try {
			// The canvas boundary is decided on the RAW request target, not the
			// normalised pathname. URL parsing collapses `..` segments and treats
			// `\` as `/`, so a normalising client or proxy could otherwise move a
			// `/canvas/...` request out of the canvas prefix and into the chat
			// handler. When the raw target names /canvas but the parsed pathname
			// does not, answer an inert 404 (nothing logged, nothing echoed).
			// Requests whose raw target never names /canvas are untouched, and
			// encoded traversals like `/canvas/%2e%2e%2f…` keep their parsed
			// pathname under /canvas/ and still reach the canvas handler.
			const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
			const rawNamesCanvas = rawPath === "/canvas" || rawPath.startsWith("/canvas/");
			const normNamesCanvas = url.pathname === "/canvas" || url.pathname.startsWith("/canvas/");
			if (rawNamesCanvas && !normNamesCanvas) {
				response.writeHead(404, { "content-type": "application/json", "x-content-type-options": "nosniff" });
				return void response.end(JSON.stringify({ error: "not found" }));
			}
			if (url.pathname === "/canvas" || url.pathname.startsWith("/canvas/")) return canvasHandler(request, response);
			if (url.pathname === "/health") return json(response, 200, health());
			if (url.pathname.startsWith("/setup/github-app/") && request.method === "GET") return setupRoute(url, response);
			if (!url.pathname.startsWith("/api/")) {
				if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "method not allowed" });
				return serveStatic(url.pathname, response);
			}
			const route = `${request.method} ${url.pathname}`;
			const llm = /^POST \/api\/runner\/llm\/([\w-]+)\/(\d+)\/v1\/chat\/completions$/.exec(route);
			if (llm) {
				// Task containers reach the coding model through the agent; only a live attempt's LLM token gets through.
				if (!(await agent.orchestrator.llmAuthorized(llm[1]!, Number(llm[2]), bearer(request)))) return json(response, 401, { error: "unauthorized" });
				const s = config.sandbox;
				if (s.coderProvider !== "opencode-go" || !s.opencodeApiKey) return json(response, 503, { error: "the coding model proxy is not configured" });
				return proxyChatCompletion(request, response, {
					baseUrl: s.opencodeBaseUrl,
					key: s.opencodeApiKey,
					models: s.coderModel.split(",").map((m) => m.trim()).filter(Boolean), // a fallback chain, in order
					timeoutMs: (s.attemptMinutes + 5) * 60_000,
					session: `pi-${llm[1]}-${llm[2]}`, // one OpenCode conversation per attempt (its resume included)
				}, { task: llm[1]!, attempt: Number(llm[2]) });
			}
			if (url.pathname.startsWith("/api/runner/")) return runnerRoute(agent, route, request, response);
			if (request.method !== "GET" && !ownerAuth.sameOrigin(request)) return json(response, 403, { error: "cross-origin request refused" });
			if (await authRoute(route, request, response)) return;
			if (!(await ownerAuth.requester(request)).authenticated) return json(response, 401, { error: "unauthorized" });

			const canvasPng = /^GET \/api\/elr\/canvas\/([A-Za-z0-9_-]{1,64})\.png$/.exec(route);
			if (canvasPng) {
				const id = canvasPng[1]!;
				const doc = await agent.harness.snapshot(CanvasDoc, id, BACKGROUND_CONTEXT);
				if (doc === undefined) return json(response, 404, { error: "not found" });
				const png = Buffer.from(rasterizePng(doc.ops, 256));
				const etag = createHash("sha256").update(png).digest("hex");
				const ifNoneMatch = request.headers["if-none-match"];
				if (ifNoneMatch && (ifNoneMatch === etag || ifNoneMatch === `"${etag}"`)) {
					response.writeHead(304, { etag: `"${etag}"` });
					return void response.end();
				}
				response.writeHead(200, {
					"content-type": "image/png",
					"content-length": String(png.length),
					etag: `"${etag}"`,
					"cache-control": "private, no-store",
				});
				return void response.end(png);
			}

			const restore = /^POST \/api\/jobs\/([\w-]+)\/restore$/.exec(route);
			if (restore) {
				await agent.root.commit(async (tx) => restoreJob(await tx.doc(Jobs, agent.root.id), restore[1]!), BACKGROUND_CONTEXT);
				return json(response, 200, { ok: true });
			}
			const jobWatch = /^POST \/api\/jobs\/([\w-]+)\/watch$/.exec(route);
			if (jobWatch) {
				const { enabled } = await body(request);
				if (typeof enabled !== "boolean") return json(response, 400, { error: "enabled must be boolean" });
				await agent.root.commit(async (tx) => {
					const job = (await tx.doc(Jobs, agent.root.id)).jobs.find((j) => j.id === jobWatch[1]);
					if (!job?.everyMinutes) throw new Error("only recurring jobs can watch project state");
					job.runOnChange = enabled;
					delete job.lastFingerprint;
				}, BACKGROUND_CONTEXT);
				return json(response, 200, { ok: true });
			}

			const goalAction = /^POST \/api\/goals\/([\w-]+)\/(approve|cancel|veto|pause|resume|retire)$/.exec(route);
			if (goalAction) {
				const [, goalId, action] = goalAction;
				const reason = async (fallback: string) => String((await body(request)).reason ?? "").slice(0, 500) || fallback;
				const o = agent.orchestrator;
				const message =
					action === "approve"
						? await o.approve(goalId!)
						: action === "veto"
							? await o.veto(goalId!, await reason("vetoed from the web app"))
							: action === "pause"
								? await o.pause(goalId!, await reason("paused from the web app"))
								: action === "resume"
									? await o.resume(goalId!)
									: action === "retire"
										? await o.retire(goalId!, await reason("closed from the web app"))
										: await o.cancel(goalId!, "cancelled from the web app");
				return json(response, 200, { message });
			}

			switch (route) {
				case "POST /api/agui": {
					const input = await body(request);
					if (typeof input.runId !== "string" || !Array.isArray(input.messages)) {
						return json(response, 400, { error: "expected an AG-UI RunAgentInput" });
					}
					return runAgui(agent, { threadId: String(input.threadId ?? "owner"), runId: input.runId, messages: input.messages }, response);
				}
				case "GET /api/messages":
					return jsonCached(request, response, { messages: await history(agent, Number(url.searchParams.get("limit") ?? 200), url.searchParams.get("thread") ?? "owner") });
				case "POST /api/stop":
					await (await agent.thread(String((await body(request)).thread ?? "owner"))).abort(BACKGROUND_CONTEXT);
					return json(response, 200, { ok: true });
				case "POST /api/chat": {
					const { message, requestId } = await body(request);
					if (typeof message !== "string" || message.trim() === "") return json(response, 400, { error: "message required" });
					const id = typeof requestId === "string" ? requestId : randomUUID();
					return json(response, 200, { answer: await agent.ask(message, `http:${id}`) });
				}
				case "GET /api/setup": {
					const app = await readGitHubApp();
					return json(response, 200, {
						missing: await agent.orchestrator.missingSetup(),
						githubApp: app ? { slug: app.slug, org: app.org ?? null, installed: Boolean(app.installationId) } : null,
						publicUrl: config.sandbox.callbackUrl ?? null,
					});
				}
				case "POST /api/setup/github-app/key": {
					// Key rotation: the owner generates a new key on GitHub and uploads it here; it is checked with GitHub first.
					const { privateKey } = await body(request, 20_000);
					if (typeof privateKey !== "string") return json(response, 400, { error: "privateKey (PEM) required" });
					const { slug } = await replaceGitHubAppKey(privateKey);
					return json(response, 200, { message: `New key installed for ${slug}. Now delete the old key on GitHub.` });
				}
				case "POST /api/setup/github-app": {
					const { org } = await body(request);
					if (typeof org !== "string" || !/^[\w-]{1,39}$/.test(org)) return json(response, 400, { error: "org name required" });
					if (!config.sandbox.callbackUrl) return json(response, 503, { error: "the agent has no public URL" });
					const state = randomBytes(24).toString("base64url");
					pendingSetups.set(state, Date.now() + 60 * 60_000);
					return json(response, 200, {
						action: `https://github.com/organizations/${org}/settings/apps/new?state=${state}`,
						manifest: JSON.stringify(appManifest(config.sandbox.callbackUrl)),
					});
				}
				case "GET /api/reports":
					return json(response, 200, { reports: (await agent.harness.snapshot(Reports, agent.root.id, BACKGROUND_CONTEXT))?.reports ?? [] });
				case "GET /api/artifacts":
					return json(response, 200, await artifactList());
				case "GET /api/roles":
					return json(response, 200, { roles: roles() });
				case "GET /api/orchestra":
					return jsonCached(request, response, await agent.orchestrator.state());
				case "GET /api/scorecards":
					return json(response, 200, scorecards(await agent.orchestrator.state()));
				case "GET /api/status":
					return jsonCached(request, response, await agent.status());
				case "GET /api/telemetry":
					return jsonCached(request, response, await telemetry(agent));
				case "GET /api/transcript":
					return json(response, 200, { text: await agent.recentActivity(Number(url.searchParams.get("limit") ?? 60)) });
				case "GET /api/elr/lab":
					// Lab panel data, loaded lazily on first request: nothing at boot, /health never waits.
					return json(response, 200, await (await import("./elr/lab.ts")).labSnapshot());
				case "POST /api/reflect":
					return json(response, 200, { report: await agent.maybeReflect(true) });
				default:
					return json(response, 404, { error: "not found" });
			}
		} catch (error) {
			// Log the stack/message only: Error objects can carry the raw request
			// target (query string included) as an enumerable property.
			console.error("[http]", error instanceof Error ? (error.stack ?? error.message) : String(error));
			if (response.headersSent) return void response.end();
			vitals.serverErrors++;
			return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	server.requestTimeout = 0; // SSE runs can be long; Railway enforces its own limits
	server.listen(config.port, () => {
		console.log(`[http] listening on :${config.port}`);
		// ELR M2: defer the journal reconcile out of this callback so the listener can answer /health
		// before (and while) the transcript is re-derived; it also yields between chunks.
		setImmediate(() => void agent.startReconcile());
	});
	return server;
}

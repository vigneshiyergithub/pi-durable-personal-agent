// Security proof for the /canvas static route.
//
// Builds a temporary DATA_DIR tree, starts a real HTTP server on an ephemeral
// port using the production canvas handler, authenticates with the shared
// token, then exercises every traversal / encoding / symlink / path-escape
// attack listed in the acceptance criteria. Each attack is logged on one line
// with its HTTP status, and the response body is checked for leaked target
// content.
//
// Run with:
//   npm run test:canvas-security
// or directly:
//   node scripts/canvas-static-security.ts

import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createCanvasHandler, resolveCanvasPath } from "../src/canvas-static.ts";

const TOKEN = "canvas-security-token-42";

interface AttackCase {
	path: string;
	marker: string;
	label?: string;
}

interface HttpResult {
	status: number;
	headers: NodeJS.Dict<string | string[]>;
	body: string;
}

let server: Server;
let baseUrl: string;
let cookie: string;
let publicRoot: string;
let dataDir: string;

function httpGet(path: string, headers?: Record<string, string>): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ hostname: "127.0.0.1", port: new URL(baseUrl).port, path, method: "GET", headers },
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

function pathnameOf(rawPath: string): string {
	try {
		return new URL(rawPath, baseUrl).pathname;
	} catch {
		return "";
	}
}

async function reasonFor(path: string): Promise<string> {
	const resolved = await resolveCanvasPath(publicRoot, path, pathnameOf(path));
	return resolved.ok ? "served" : resolved.reason;
}

function headerValue(headers: NodeJS.Dict<string | string[]>, name: string): string | undefined {
	const v = headers[name.toLowerCase()];
	return Array.isArray(v) ? v[0] : v;
}

function maxAgeSeconds(cacheControl: string): number {
	const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl);
	return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

async function assertRefuses(path: string, marker: string, label?: string) {
	const res = await httpGet(path, { cookie });
	const ok = res.status >= 400 && res.status <= 404;
	const tag = label ? `${label}: ${path}` : path;
	const reason = await reasonFor(path);
	console.log(`GET ${tag} -> ${res.status} (${reason})`);
	assert.ok(ok, `${path} must be refused, got ${res.status}`);
	assert.ok(
		!res.body.includes(marker),
		`${path} body leaked target content (marker: ${marker}): ${res.body.slice(0, 200)}`,
	);
}

async function assertServes(path: string, marker: string, contentType?: string) {
	const res = await httpGet(path, { cookie });
	console.log(`GET ${path} -> ${res.status} (${await reasonFor(path)})`);
	assert.equal(res.status, 200, `${path} should be served, got ${res.status}: ${res.body.slice(0, 200)}`);
	assert.ok(res.body.includes(marker), `${path} body missing expected content`);
	if (contentType) {
		const ct = Array.isArray(res.headers["content-type"]) ? res.headers["content-type"][0] : res.headers["content-type"];
		assert.equal(ct, contentType, `${path} wrong content-type`);
	}
}

describe("canvas-static security", () => {
	before(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "canvas-security-"));
		publicRoot = join(dataDir, "workspace", "canvas", "public");
		const canvasRoot = join(dataDir, "workspace", "canvas");

		// Public tree: the only files the route is allowed to serve.
		await mkdir(join(publicRoot, "day"), { recursive: true });
		await mkdir(join(publicRoot, "subdir"), { recursive: true });
		await mkdir(join(publicRoot, "emptydir"), { recursive: true });
		await writeFile(join(publicRoot, "index.html"), "<h1>Canvas Gallery Index</h1>");
		await writeFile(join(publicRoot, "gallery.html"), "<h1>Gallery Page</h1>");
		await writeFile(join(publicRoot, "day", "2026-10-18.svg"), "<svg>canvas-art-2026-10-18</svg>");
		await writeFile(join(publicRoot, "day", "2026-10-18.json"), JSON.stringify({ date: "2026-10-18", art: true }));
		await writeFile(join(publicRoot, "day", "2026-10-18.png"), Buffer.from("\x89PNG\r\n\x1a\nPNG_FIXTURE_BYTES", "binary"));
		await writeFile(join(publicRoot, "day", "notes.txt"), "SECRET_CANVAS_NOTES");
		await writeFile(join(publicRoot, "subdir", "inner.html"), "<h1>Subdir Inner</h1>");

		// Secret-bearing files outside the public tree.
		await mkdir(join(canvasRoot, "run"), { recursive: true });
		await mkdir(join(canvasRoot, "logs"), { recursive: true });
		await writeFile(join(canvasRoot, ".public-url"), "FAKE_TUNNEL_URL=https://tunnel.example");
		await writeFile(join(canvasRoot, "run", "server.pid"), "12345");
		await writeFile(join(canvasRoot, "logs", "agent.log"), "secret agent log line");
		await writeFile(join(canvasRoot, "generate.mjs"), "// canvas generator script");
		await writeFile(join(dataDir, "outside-secret.txt"), "OUTSIDE_SECRET");

		// Symlink escapes inside the public tree.
		await symlink(join(canvasRoot, ".public-url"), join(publicRoot, "leak"));
		await symlink(join(dataDir), join(publicRoot, "outdir"));

		// Point DATA_DIR at the temp tree for realism, even though the handler
		// under test receives the resolved public root directly.
		process.env.DATA_DIR = dataDir;

		const handler = createCanvasHandler(publicRoot, TOKEN);
		server = createServer((request, response) => {
			if (request.url?.startsWith("/canvas")) {
				handler(request, response).catch((error) => {
					console.error("[canvas handler error]", error);
					if (!response.headersSent) {
						response.writeHead(500, { "content-type": "text/plain" });
						response.end("Internal server error");
					}
				});
				return;
			}
			response.writeHead(404, { "content-type": "text/plain" });
			response.end("Not found");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("server did not bind to a port");
		baseUrl = `http://127.0.0.1:${address.port}`;

		// Authenticate and capture the HttpOnly cookie.
		const auth = await httpGet(`/canvas/?k=${encodeURIComponent(TOKEN)}`);
		assert.equal(auth.status, 302, "token query should redirect");
		const rawSetCookie = auth.headers["set-cookie"];
		const setCookie = Array.isArray(rawSetCookie) ? rawSetCookie[0] : rawSetCookie;
		assert.ok(typeof setCookie === "string" && setCookie.length > 0, "set-cookie header missing");
		const match = /canvas_access=([^;]+)/.exec(setCookie);
		assert.ok(match, "canvas_access cookie missing");
		cookie = `canvas_access=${match[1]}`;
	});

	after(() => {
		server?.close();
	});

	it("authenticates /canvas/ and serves index.html", async () => {
		await assertServes("/canvas/", "Canvas Gallery Index", "text/html; charset=utf-8");
	});

	it("serves known file types with correct content types", async () => {
		await assertServes("/canvas/day/2026-10-18.svg", "canvas-art-2026-10-18", "image/svg+xml");
		await assertServes("/canvas/day/2026-10-18.json", "2026-10-18", "application/json");
		await assertServes("/canvas/gallery.html", "Gallery Page", "text/html; charset=utf-8");
		await assertServes("/canvas/day/2026-10-18.png", "PNG_FIXTURE_BYTES", "image/png");
	});

	it("sets security and cache headers for every response", async () => {
		const cases: { path: string; wantStatus: number; wantType?: string }[] = [
			{ path: "/canvas/", wantStatus: 200, wantType: "text/html; charset=utf-8" },
			{ path: "/canvas/gallery.html", wantStatus: 200, wantType: "text/html; charset=utf-8" },
			{ path: "/canvas/day/2026-10-18.svg", wantStatus: 200, wantType: "image/svg+xml" },
			{ path: "/canvas/day/2026-10-18.png", wantStatus: 200, wantType: "image/png" },
			{ path: "/canvas/day/2026-10-18.json", wantStatus: 200, wantType: "application/json" },
			{ path: "/canvas/day/notes.txt", wantStatus: 404 },
			{ path: "/canvas/day/", wantStatus: 404 },
			{ path: "/canvas/missing.html", wantStatus: 404 },
		];
		for (const c of cases) {
			const res = await httpGet(c.path, { cookie });
			const ct = headerValue(res.headers, "content-type");
			const nosniff = headerValue(res.headers, "x-content-type-options");
			console.log(`GET ${c.path} -> status=${res.status}, content-type=${ct ?? "(none)"}, x-content-type-options=${nosniff ?? "(none)"}`);
			assert.equal(res.status, c.wantStatus, `${c.path}: expected status ${c.wantStatus}`);
			assert.equal(nosniff, "nosniff", `${c.path}: must carry X-Content-Type-Options: nosniff`);
			if (c.wantType) {
				assert.equal(ct, c.wantType, `${c.path}: wrong content-type`);
			}
			if (res.status === 200) {
				const cc = headerValue(res.headers, "cache-control");
				assert.ok(typeof cc === "string", `${c.path}: Cache-Control header missing`);
				assert.ok(
					cc.includes("no-cache") || maxAgeSeconds(cc) <= 60,
					`${c.path}: Cache-Control '${cc}' allows a cache lifetime longer than 60s`,
				);
			}
		}
	});

	it("rejects an unknown extension and does not sniff with query-string or Accept tricks", async () => {
		const base = "/canvas/day/notes.txt";
		const marker = "SECRET_CANVAS_NOTES";
		for (const path of [
			base,
			`${base}?k=${encodeURIComponent(TOKEN)}`,
			`${base}?format=json`,
			`${base}?ext=html`,
		]) {
			const res = await httpGet(path, {
				cookie,
				accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			});
			console.log(`GET ${path} (Accept trick) -> ${res.status}`);
			assert.notEqual(res.status, 200, `${path} must not be served with Accept trick`);
			assert.ok(!res.body.includes(marker), `${path} leaked notes.txt bytes`);
			assert.equal(headerValue(res.headers, "x-content-type-options"), "nosniff", `${path}: nosniff missing`);
		}
		for (const path of [base, `${base}?k=${encodeURIComponent(TOKEN)}`]) {
			const res = await httpGet(path, {
				cookie,
				accept: "image/png",
			});
			console.log(`GET ${path} (Accept: image/png) -> ${res.status}`);
			assert.notEqual(res.status, 200, `${path} must not be served as image/png`);
			assert.ok(!res.body.includes(marker), `${path} leaked notes.txt bytes`);
		}
	});

	it("refuses traversal and encoding escapes", async () => {
		const cases: AttackCase[] = [
			{ path: "/canvas/../.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/../../.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/..%2f.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/%2e%2e%2f.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/%252e%252e%252f.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas//etc/passwd", marker: "root:" },
			{ path: "/canvas/%2Fetc%2Fpasswd", marker: "root:" },
			{ path: "/canvas/..%5C.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/..\\.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/index.html%00.png", marker: "Canvas Gallery Index" },
		];
		for (const c of cases) {
			await assertRefuses(c.path, c.marker);
		}
	});

	it("refuses absolute / file:// style targets", async () => {
		// Direct handler invocation for a file:// request-target; the production
		// handler is still what resolves and rejects it.
		const fileUrl = "file:///etc/passwd";
		const handler = createCanvasHandler(publicRoot, TOKEN);
		const res = await new Promise<HttpResult>((resolve) => {
			const response = {
				status: 0,
				headers: {} as Record<string, string>,
				body: "",
				writeHead(status: number, headers: Record<string, string>) {
					this.status = status;
					Object.assign(this.headers, headers);
				},
				end(body?: string | Buffer) {
					this.body = body ? (typeof body === "string" ? body : body.toString("utf8")) : "";
					resolve(this as unknown as HttpResult);
				},
			};
			void handler(
				{ url: fileUrl, method: "GET", headers: { cookie } } as import("node:http").IncomingMessage,
				response as unknown as import("node:http").ServerResponse,
			);
		});
		console.log(`GET ${fileUrl} -> ${res.status} (${await reasonFor(fileUrl)})`);
		assert.ok(res.status >= 400 && res.status <= 404, `file:// target must be refused, got ${res.status}`);
		assert.ok(!res.body.includes("root:"), "file:// response leaked /etc/passwd content");
	});

	it("refuses volume files outside the public tree", async () => {
		const cases: AttackCase[] = [
			{ path: "/canvas/.public-url", marker: "FAKE_TUNNEL_URL" },
			{ path: "/canvas/run/server.pid", marker: "12345" },
			{ path: "/canvas/logs/agent.log", marker: "secret agent log" },
			{ path: "/canvas/generate.mjs", marker: "canvas generator" },
			{ path: "/canvas/../outside-secret.txt", marker: "OUTSIDE_SECRET" },
		];
		for (const c of cases) {
			await assertRefuses(c.path, c.marker);
		}
	});

	it("refuses symlink escapes", async () => {
		await assertRefuses("/canvas/leak", "FAKE_TUNNEL_URL");
		await assertRefuses("/canvas/outdir/outside-secret.txt", "OUTSIDE_SECRET");
		await assertRefuses("/canvas/outdir/", "OUTSIDE_SECRET");
	});

	it("refuses directory listings", async () => {
		for (const path of ["/canvas/day/", "/canvas/subdir/", "/canvas/emptydir/"]) {
			const res = await httpGet(path, { cookie });
			console.log(`GET ${path} -> ${res.status} (${await reasonFor(path)})`);
			assert.ok(res.status >= 400 && res.status <= 404, `${path} should refuse directory listing`);
			assert.ok(!res.body.includes("Index of"), `${path} body looks like a directory listing`);
			assert.ok(!res.body.includes("inner.html"), `${path} body leaked child file names`);
			assert.ok(!res.body.includes("2026-10-18"), `${path} body leaked child file names`);
		}
	});

	it("is disabled when the token is empty", async () => {
		const handler = createCanvasHandler(publicRoot, "");
		const res = await new Promise<HttpResult>((resolve) => {
			const response = {
				status: 0,
				headers: {} as Record<string, string>,
				body: "",
				writeHead(status: number, headers: Record<string, string>) {
					this.status = status;
					Object.assign(this.headers, headers);
				},
				end(body?: string | Buffer) {
					this.body = body ? (typeof body === "string" ? body : body.toString("utf8")) : "";
					resolve(this as unknown as HttpResult);
				},
			};
			void handler(
				{ url: "/canvas/", method: "GET", headers: {} } as import("node:http").IncomingMessage,
				response as unknown as import("node:http").ServerResponse,
			);
		});
		console.log(`GET /canvas/ (disabled) -> ${res.status}`);
		assert.equal(res.status, 404, "disabled route must return 404");
		assert.ok(!res.body.includes("Canvas Gallery Index"), "disabled route leaked content");
	});
});

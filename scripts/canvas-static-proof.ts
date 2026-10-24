import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createCanvasHandler, resolveCanvasPath } from "../src/canvas-static.ts";

interface MockResponse {
	status?: number;
	headers: Record<string, string>;
	body: string;
	writeHead(status: number, headers: Record<string, string>): void;
	end(body?: string | Buffer): void;
}

interface RequestOpts {
	url: string;
	method?: string;
	cookie?: string;
}

function mockRequest(opts: RequestOpts): IncomingMessage {
	return {
		url: opts.url,
		method: opts.method ?? "GET",
		headers: opts.cookie ? { cookie: opts.cookie } : {},
	} as unknown as IncomingMessage;
}

function runHandler(
	handler: ReturnType<typeof createCanvasHandler>,
	opts: RequestOpts,
): Promise<MockResponse> {
	return new Promise((resolve, reject) => {
		const res: MockResponse = {
			status: undefined,
			headers: {},
			body: "",
			writeHead(status: number, headers: Record<string, string>) {
				this.status = status;
				for (const [k, v] of Object.entries(headers)) {
					this.headers[k.toLowerCase()] = v;
				}
			},
			end(body?: string | Buffer) {
				this.body = body ? (typeof body === "string" ? body : body.toString("utf8")) : "";
				resolve(this);
			},
		};
		handler(mockRequest(opts), res as unknown as ServerResponse).catch(reject);
	});
}

function inert(body: string): boolean {
	const lowered = body.toLowerCase();
	return (
		!lowered.includes("index.html") &&
		!lowered.includes("gallery") &&
		!lowered.includes("<svg") &&
		!lowered.includes(".json") &&
		!lowered.includes("canvas_access") &&
		!lowered.includes("secret-token")
	);
}

describe("resolveCanvasPath", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "canvas-root-"));
		await mkdir(join(root, "day"));
		await writeFile(join(root, "index.html"), "<html>gallery</html>");
		await writeFile(join(root, "day", "2024-01-01.svg"), "<svg/>");
	});

	it("resolves the root to index.html", async () => {
		const r = await resolveCanvasPath(root, "/canvas/", "/canvas/");
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.file, join(root, "index.html"));
	});

	it("resolves a nested file", async () => {
		const r = await resolveCanvasPath(root, "/canvas/day/2024-01-01.svg", "/canvas/day/2024-01-01.svg");
		assert.equal(r.ok, true);
		if (!r.ok) return;
		assert.equal(r.file, join(root, "day", "2024-01-01.svg"));
	});

	it("rejects dot-dot traversal", async () => {
		const r = await resolveCanvasPath(root, "/canvas/../secret", "/canvas/../secret");
		assert.equal(r.ok, false);
	});

	it("rejects percent-encoded traversal", async () => {
		const r = await resolveCanvasPath(root, "/canvas/%2e%2e%2fsecret", "/canvas/../secret");
		assert.equal(r.ok, false);
	});

	it("rejects double-encoded traversal", async () => {
		const r = await resolveCanvasPath(root, "/canvas/%252e%252e%252fsecret", "/canvas/%2e%2e%2fsecret");
		assert.equal(r.ok, false);
	});

	it("rejects backslashes", async () => {
		const r = await resolveCanvasPath(root, "/canvas/..\\secret", "/canvas/../secret");
		assert.equal(r.ok, false);
	});

	it("rejects NUL bytes", async () => {
		const r = await resolveCanvasPath(root, "/canvas/%00etc", "/canvas/\u0000etc");
		assert.equal(r.ok, false);
	});

	it("rejects symlinks that escape the root", async () => {
		const outside = join(dirname(root), "outside-secret.txt");
		await writeFile(outside, "top secret");
		await symlink(outside, join(root, "escape.txt"));
		const r = await resolveCanvasPath(root, "/canvas/escape.txt", "/canvas/escape.txt");
		assert.equal(r.ok, false);
	});

	it("rejects directory listings", async () => {
		const r = await resolveCanvasPath(root, "/canvas/day/", "/canvas/day/");
		assert.equal(r.ok, false);
	});

	it("rejects unknown extensions", async () => {
		await writeFile(join(root, "url.txt"), "https://example.com");
		const r = await resolveCanvasPath(root, "/canvas/url.txt", "/canvas/url.txt");
		assert.equal(r.ok, true);
		if (!r.ok) return;
		// Resolution itself succeeds; the handler rejects by extension later.
		const stat = await lstat(r.file);
		assert.ok(stat.isFile());
	});
});

describe("createCanvasHandler", () => {
	let root: string;
	const token = "secret-token";

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "canvas-root-"));
		await mkdir(join(root, "day"));
		await writeFile(join(root, "index.html"), "<html>gallery</html>");
		await writeFile(join(root, "day", "2024-01-01.svg"), "<svg/>");
		await writeFile(join(root, "url.txt"), "https://example.com");
	});

	it("is disabled when the token is empty", async () => {
		const handler = createCanvasHandler(root, "");
		for (const path of ["/canvas/", "/canvas/index.html", "/canvas/day/2024-01-01.svg"]) {
			const res = await runHandler(handler, { url: path });
			assert.equal(res.status, 404);
			assert.ok(inert(res.body), `body for ${path} leaked content: ${res.body}`);
		}
	});

	it("requires authentication when enabled", async () => {
		const handler = createCanvasHandler(root, token);
		const res = await runHandler(handler, { url: "/canvas/" });
		assert.equal(res.status, 401);
		assert.ok(inert(res.body), `401 body leaked content: ${res.body}`);
	});

	it("sets an HttpOnly SameSite=Lax cookie and redirects on a valid query token", async () => {
		const handler = createCanvasHandler(root, token);
		const res = await runHandler(handler, { url: `/canvas/?k=${encodeURIComponent(token)}` });
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, "/canvas/");
		const setCookie = res.headers["set-cookie"];
		assert.ok(typeof setCookie === "string", "set-cookie header present");
		assert.match(setCookie, /canvas_access=/);
		assert.match(setCookie, /HttpOnly/i);
		assert.match(setCookie, /SameSite=Lax/i);
		assert.match(setCookie, /Path=\/canvas/i);
		assert.match(setCookie, /Max-Age=/i);
		assert.ok(!res.headers.location?.includes(token), "token must not appear in Location");
	});

	it("serves index.html once the cookie is set", async () => {
		const handler = createCanvasHandler(root, token);
		const auth = await runHandler(handler, { url: `/canvas/?k=${encodeURIComponent(token)}` });
		assert.equal(auth.status, 302);
		const cookie = auth.headers["set-cookie"];
		assert.ok(typeof cookie === "string");

		const res = await runHandler(handler, { url: "/canvas/", cookie });
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
		assert.equal(res.headers["x-content-type-options"], "nosniff");
		assert.equal(res.headers["cache-control"], "no-cache");
		assert.equal(res.body, "<html>gallery</html>");
	});

	it("redirects a bare /canvas to /canvas/ instead of serving the index at the root base (D1)", async () => {
		const handler = createCanvasHandler(root, token);

		const queryRes = await runHandler(handler, { url: `/canvas?k=${encodeURIComponent(token)}` });
		assert.equal(queryRes.status, 302, "bare /canvas?k= must redirect");
		assert.equal(queryRes.headers.location, "/canvas/");
		assert.match(queryRes.headers["set-cookie"] ?? "", /canvas_access=/);
		assert.ok(!queryRes.body.includes("gallery"), "bare /canvas?k= must not serve the index");

		const cookieRes = await runHandler(handler, { url: "/canvas", cookie: `canvas_access=${token}` });
		assert.equal(cookieRes.status, 302, "cookie-authenticated bare /canvas must redirect");
		assert.equal(cookieRes.headers.location, "/canvas/");
		assert.ok(!cookieRes.body.includes("gallery"), "cookie bare /canvas must not serve the index");
	});

	it("redirects a file token handshake to the requested file, not the gallery index (D3)", async () => {
		const handler = createCanvasHandler(root, token);
		const res = await runHandler(handler, { url: `/canvas/day/2024-01-01.svg?k=${encodeURIComponent(token)}` });
		assert.equal(res.status, 302);
		assert.equal(res.headers.location, "/canvas/day/2024-01-01.svg");
		assert.match(res.headers["set-cookie"] ?? "", /canvas_access=/);
	});

	it("authenticates before rejecting a non-GET method (D2)", async () => {
		const handler = createCanvasHandler(root, token);
		const anon = await runHandler(handler, { url: "/canvas/", method: "POST" });
		assert.equal(anon.status, 401, "unauthenticated POST must be 401, not 405");
		assert.ok(inert(anon.body));
		const authed = await runHandler(handler, { url: "/canvas/", method: "POST", cookie: `canvas_access=${token}` });
		assert.equal(authed.status, 405, "authenticated POST must be 405");
	});

	it("serves a nested SVG with the right content type", async () => {
		const handler = createCanvasHandler(root, token);
		const auth = await runHandler(handler, { url: `/canvas/?k=${encodeURIComponent(token)}` });
		const cookie = auth.headers["set-cookie"];
		assert.ok(typeof cookie === "string");
		const res = await runHandler(handler, { url: "/canvas/day/2024-01-01.svg", cookie });
		assert.equal(res.status, 200);
		assert.equal(res.headers["content-type"], "image/svg+xml");
		assert.equal(res.headers["x-content-type-options"], "nosniff");
		assert.equal(res.body, "<svg/>");
	});

	it("rejects an unknown extension even when authenticated", async () => {
		const handler = createCanvasHandler(root, token);
		const auth = await runHandler(handler, { url: `/canvas/?k=${encodeURIComponent(token)}` });
		const cookie = auth.headers["set-cookie"];
		assert.ok(typeof cookie === "string");
		const res = await runHandler(handler, { url: "/canvas/url.txt", cookie });
		assert.equal(res.status, 404);
		assert.ok(inert(res.body));
	});

	it("rejects traversal attempts", async () => {
		const handler = createCanvasHandler(root, token);
		const auth = await runHandler(handler, { url: `/canvas/?k=${encodeURIComponent(token)}` });
		const cookie = auth.headers["set-cookie"];
		assert.ok(typeof cookie === "string");
		for (const url of ["/canvas/../package.json", "/canvas/%2e%2e%2fpackage.json"]) {
			const res = await runHandler(handler, { url, cookie });
			assert.equal(res.status, 404, `${url} should be rejected`);
		}
	});

	it("rejects a wrong token", async () => {
		const handler = createCanvasHandler(root, token);
		const res = await runHandler(handler, { url: "/canvas/?k=wrong" });
		assert.equal(res.status, 401);
		assert.ok(inert(res.body));
	});

	it("rejects a wrong cookie", async () => {
		const handler = createCanvasHandler(root, token);
		const res = await runHandler(handler, { url: "/canvas/", cookie: "canvas_access=wrong" });
		assert.equal(res.status, 401);
		assert.ok(inert(res.body));
	});
});

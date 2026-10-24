// Proof: every /canvas response isolates agent-written content from the owner's app on the same origin. The CSP
// sandbox blocks scripts (in HTML and SVG), forms, popups and framing, so a canvas page can never act with the owner's
// session. Runs a real HTTP server with the production handler.
//   node scripts/canvas-static-isolation.ts
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_HEADERS, createCanvasHandler } from "../src/canvas-static.ts";

const TOKEN = "isolation-proof-token-0123456789";
const root = await mkdtemp(join(tmpdir(), "canvas-isolation-"));
await writeFile(join(root, "index.html"), `<!doctype html><title>g</title><img src="a.svg"><script>fetch("/api/auth/recovery-codes",{method:"POST"})</script>`);
await writeFile(join(root, "a.svg"), `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/status")</script><circle r="5"/></svg>`);

const handler = createCanvasHandler(root, TOKEN);
const server = createServer((request, response) => void handler(request, response));
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as { port: number };
const base = `http://127.0.0.1:${port}`;
const get = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init });
const cookie = { headers: { cookie: `canvas_access=${encodeURIComponent(TOKEN)}` } };

const cases: Array<[string, Response, number]> = [
	["no token", await get("/canvas/"), 401],
	["token handshake", await get(`/canvas/?k=${TOKEN}`), 302],
	["gallery page (has <script>)", await get("/canvas/index.html", cookie), 200],
	["svg (has <script>)", await get("/canvas/a.svg", cookie), 200],
	["missing file", await get("/canvas/nope.html", cookie), 404],
	["wrong method", await get("/canvas/index.html", { ...cookie, method: "POST" }), 405],
];

for (const [name, response, status] of cases) {
	assert.equal(response.status, status, `${name}: status`);
	for (const [header, value] of Object.entries(CANVAS_HEADERS)) {
		assert.equal(response.headers.get(header), value, `${name}: ${header}`);
	}
	const csp = response.headers.get("content-security-policy")!;
	const sandbox = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("sandbox"))!;
	assert.ok(sandbox, `${name}: CSP has a sandbox directive`);
	for (const forbidden of ["allow-scripts", "allow-forms", "allow-popups", "allow-top-navigation", "allow-modals"]) {
		assert.ok(!sandbox.includes(forbidden), `${name}: sandbox must not ${forbidden}`);
	}
	for (const directive of ["script-src 'none'", "connect-src 'none'", "frame-ancestors 'none'", "form-action 'none'"]) {
		assert.ok(csp.includes(directive), `${name}: CSP ${directive}`);
	}
	console.log(`  ✓ ${name}: ${status}, sandboxed, no scripts, not frameable`);
}
server.close();
console.log("✓ canvas isolation: every /canvas response is sandboxed (no scripts in HTML or SVG), unframeable and no-referrer");

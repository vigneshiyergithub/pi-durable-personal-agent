// The runner compresses what task containers send (LLM requests through its local relay, evidence and heartbeats), and
// the agent's body reader takes it back: same bytes in, fewer on the wire.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { readBody } from "../src/request-body.ts";
// @ts-expect-error the runner is plain JavaScript
import { startLlmRelay } from "../runner/task-runner.mjs";

const conversation = { model: "m", stream: true, messages: Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `step ${i}: edited src/feature.ts and ran npm test; all 42 tests passed` })) };

test("the relay gzips requests, keeps auth, and streams the answer back unchanged", async () => {
	let seen: { encoding?: string; wire: number; body: string; auth?: string; path?: string } | undefined;
	const agent = createServer(async (request: IncomingMessage, response) => {
		const wire = Number(request.headers["content-length"] ?? 0);
		const encoding = request.headers["content-encoding"];
		const body = (await readBody(request, 16 * 2 ** 20)).toString("utf8");
		seen = { encoding, wire, body, auth: request.headers.authorization, path: request.url };
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
		response.end('data: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((r) => agent.listen(0, "127.0.0.1", r));
	try {
		const target = `http://127.0.0.1:${(agent.address() as AddressInfo).port}/api/runner/llm/t1/1/v1`;
		const relay: string = await startLlmRelay(target);
		const plain = JSON.stringify(conversation);
		const answer = await fetch(`${relay}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer llm-token" }, body: plain });
		assert.equal(answer.status, 200);
		assert.equal(await answer.text(), 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}\n\ndata: [DONE]\n\n');
		assert.equal(seen?.path, "/api/runner/llm/t1/1/v1/chat/completions");
		assert.equal(seen?.encoding, "gzip");
		assert.equal(seen?.auth, "Bearer llm-token");
		assert.equal(seen?.body, plain, "the agent reads exactly what OpenCode sent");
		assert.ok(seen!.wire < plain.length / 5, `on the wire ${seen!.wire} B for ${plain.length} B of JSON`);
	} finally {
		agent.close();
	}
});

test("the body reader enforces its limit after decompression and refuses unknown encodings", async () => {
	const serve = (handle: (request: IncomingMessage) => Promise<string>) => {
		const server = createServer(async (request, response) => response.end(await handle(request).catch((e: Error) => `error: ${e.message}`)));
		return new Promise<{ url: string; close: () => void }>((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
	};
	const { url, close } = await serve(async (request) => (await readBody(request, 1000)).toString("utf8").length.toString());
	try {
		const post = (body: Buffer, encoding?: string) => fetch(url, { method: "POST", headers: encoding ? { "content-encoding": encoding } : {}, body: new Uint8Array(body) }).then((r) => r.text());
		assert.equal(await post(Buffer.from("x".repeat(900))), "900");
		assert.equal(await post(gzipSync("y".repeat(900)), "gzip"), "900");
		assert.equal(await post(gzipSync("z".repeat(5000)), "gzip"), "error: request too large", "a small gzip cannot expand past the limit");
		assert.equal(await post(Buffer.from("not gzip"), "gzip"), "error: invalid gzip body");
		assert.equal(await post(Buffer.from("{}"), "br"), "error: unsupported content-encoding br");
	} finally {
		close();
	}
});

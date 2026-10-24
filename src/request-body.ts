// Request bodies, gunzipped when the sender compressed them. Task containers compress everything they send (their LLM
// requests and evidence): those bytes leave the sandbox project over the public network and are billed as egress.
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

const gunzipAsync = promisify(gunzip);

/** The whole body, at most `limit` bytes after decompression; throws "request too large" past it. */
export async function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
	const encoding = String(request.headers["content-encoding"] ?? "identity").toLowerCase();
	if (encoding !== "identity" && encoding !== "gzip") throw new Error(`unsupported content-encoding ${encoding}`);
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > limit) throw new Error("request too large");
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks);
	if (encoding === "identity") return raw;
	try {
		return await gunzipAsync(raw, { maxOutputLength: limit });
	} catch (error) {
		throw new Error((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "request too large" : "invalid gzip body");
	}
}

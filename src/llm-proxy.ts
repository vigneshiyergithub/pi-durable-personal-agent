// The coding model, reached through the agent: task containers call this proxy with a per-attempt LLM token, and only the
// agent holds the provider's key (OpenCode Go). A container can't leak the key it never sees, and a leaked LLM token is
// only good for this attempt's lifetime, for the one configured model, and for chat completions.
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type LlmCall, readUsage, recordLlmCall } from "./llm-usage.ts";
import { readBody } from "./request-body.ts";

const MAX_BODY = 16 * 2 ** 20;
/** How long a model that hit its limit (or can't serve this workspace) is skipped before it is tried again. */
const SKIP_MS = 10 * 60_000;
const skipUntil = new Map<string, number>();

/** A shared admission signal: do not provision workers when every model is cooling down. */
export function coderReadyAt(models: string[]): number {
	const until = models.map((model) => skipUntil.get(model) ?? 0);
	return until.length && until.every((at) => at > Date.now()) ? Math.min(...until) : 0;
}

/** Models in the chain that are being skipped right now, and until when (for the Monitor). */
export function skippedModels(): Array<{ model: string; until: string }> {
	return [...skipUntil].filter(([, until]) => until > Date.now()).map(([model, until]) => ({ model, until: new Date(until).toISOString() }));
}

/**
 * Reads the usage out of an answer as it streams past: the last `usage` object in the server-sent events (or the JSON
 * body), and the model that answered. Nothing is buffered beyond one partial line.
 */
function usageTap(stream: boolean) {
	let partial = "";
	let body = "";
	const found: { usage?: unknown; model?: string } = {};
	const take = (json: string) => {
		try {
			const value = JSON.parse(json) as { usage?: unknown; model?: unknown };
			if (value.usage) found.usage = value.usage;
			if (typeof value.model === "string") found.model = value.model;
		} catch {
			// not JSON (keep-alive comments, [DONE]): nothing to read
		}
	};
	return {
		push(chunk: Uint8Array) {
			const text = Buffer.from(chunk).toString("utf8");
			if (!stream) {
				if (body.length < 4 * 2 ** 20) body += text;
				return;
			}
			const lines = (partial + text).split("\n");
			partial = lines.pop() ?? "";
			for (const line of lines) if (line.startsWith("data:") && line.includes('"usage"')) take(line.slice(5).trim());
		},
		end() {
			if (stream && partial.startsWith("data:")) take(partial.slice(5).trim());
			if (!stream) take(body);
			return found;
		},
	};
}

/** Upstream errors that mean "this model can't serve you right now": go to the next model in the chain. */
const unavailable = (status: number, text: string) =>
	status === 429 || status === 503 || (status >= 400 && status < 500 && /limit|quota|exceeded|capacity|region|not available|unavailable/i.test(text));

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	return JSON.parse((await readBody(request, MAX_BODY)).toString("utf8")) as Record<string, unknown>;
}

/**
 * Forwards one OpenAI-compatible chat completion upstream with the agent's key and streams the answer back (server-sent
 * events pass through unchanged). The model is forced from the configured chain, in order: when one reports its limit or
 * can't serve the workspace, it is skipped for a while and the next one answers. Chat completions are stateless, so
 * switching models between requests of one conversation is fine.
 */
export async function proxyChatCompletion(
	request: IncomingMessage,
	response: ServerResponse,
	upstream: { baseUrl: string; key: string; models: string[]; timeoutMs: number; session: string },
	meter: { task: string; attempt: number },
): Promise<void> {
	let input: Record<string, unknown>;
	try {
		input = await readJson(request);
	} catch (error) {
		response.writeHead(400, { "content-type": "application/json" });
		return void response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "bad request" } }));
	}
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), upstream.timeoutMs);
	const disconnected = () => { if (!response.writableEnded) abort.abort(); };
	response.on("close", disconnected);
	const started = Date.now();
	const stream = input.stream === true;
	// Ask for the token counts on streams too (OpenAI-compatible APIs send them in a final chunk), so usage is metered.
	if (stream) input.stream_options = { ...(input.stream_options as object | undefined), include_usage: true };
	const fallbacks: Array<{ model: string; status: number }> = [];
	const record = (call: Omit<LlmCall, "at" | "task" | "attempt" | "stream" | "ms" | "fallbacks">) =>
		recordLlmCall({ at: started, task: meter.task, attempt: meter.attempt, stream, ms: Date.now() - started, ...(fallbacks.length ? { fallbacks } : {}), ...call });
	const ready = upstream.models.filter((m) => (skipUntil.get(m) ?? 0) <= Date.now());
	const chain = ready;
	if (!chain.length) {
		clearTimeout(timer);
		response.off("close", disconnected);
		response.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.max(1, Math.ceil((coderReadyAt(upstream.models) - Date.now()) / 1000))) });
		return void response.end(JSON.stringify({ error: { message: "All configured coding models are cooling down; retry later." } }));
	}
	try {
		// The last model's answer goes back as it is, error or not.
		for (const [i, model] of chain.entries()) {
			input.model = model; // whatever the container asked for, it gets a model from the chain
			const answer = await fetch(`${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				// OpenCode Go asks clients to name themselves and send a stable session per conversation (one per attempt here),
				// so it can route and cache prompts; see opencode.ai/docs/go, "Where can I use it?".
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${upstream.key}`,
					"user-agent": "pi-durable-agent/1.0 (opencode task runner)",
					"x-opencode-session": upstream.session,
				},
				body: JSON.stringify(input),
				signal: abort.signal,
			});
			if (!answer.ok && i < chain.length - 1) {
				const text = await answer.text();
				if (unavailable(answer.status, text)) {
					skipUntil.set(model, Date.now() + SKIP_MS);
					fallbacks.push({ model, status: answer.status });
					console.warn(`[llm] ${model} unavailable (${answer.status}: ${text.slice(0, 160)}); falling back to ${chain[i + 1]}`);
					continue;
				}
				response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
				record({ model, status: answer.status, error: text.slice(0, 300) });
				return void response.end(text);
		}
			response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
			const tap = usageTap(stream);
			let ttfbMs: number | undefined;
			let errorText = "";
			if (answer.body) {
				for await (const chunk of answer.body) {
					ttfbMs ??= Date.now() - started;
					tap.push(chunk);
					if (!answer.ok && errorText.length < 300) errorText += Buffer.from(chunk).toString("utf8");
					if (!response.write(chunk)) await once(response, "drain", { signal: abort.signal });
				}
			}
			if (!answer.ok && unavailable(answer.status, errorText)) skipUntil.set(model, Date.now() + SKIP_MS);
			const found = tap.end();
			record({
				model: found.model ?? model,
				status: answer.status,
				ttfbMs: stream ? ttfbMs : undefined,
				...readUsage(found.usage),
				...(answer.ok ? {} : { error: errorText.slice(0, 300) }),
			});
			return void response.end();
		}
	} catch (error) {
		record({ model: String(input.model ?? chain.at(-1) ?? ""), status: response.headersSent ? 499 : 502, error: `upstream: ${error instanceof Error ? error.message : error}`.slice(0, 300) });
		if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
		response.end(response.headersSent ? undefined : JSON.stringify({ error: { message: `upstream: ${error instanceof Error ? error.message : error}` } }));
	} finally {
		clearTimeout(timer);
		response.off("close", disconnected);
	}
}

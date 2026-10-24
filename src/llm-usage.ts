// A meter on the coding-model proxy (src/llm-proxy.ts): one line per request the containers make through the agent to
// OpenCode Go — which model answered, tokens, latency, errors and limit fallbacks — so the Monitor can show plan usage
// that never reaches OpenRouter or the harness. Kept as JSON lines on the volume so it survives deploys; records older
// than KEEP_DAYS are dropped when the file is next read.
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";

const KEEP_DAYS = 35;
const file = () => join(config.dataDir, "llm-usage.jsonl");

export type LlmCall = {
	at: number;
	task: string;
	attempt: number;
	/** The model that gave the final answer (the last one tried). */
	model: string;
	status: number;
	stream: boolean;
	/** Until the whole answer was sent back. */
	ms: number;
	/** Until the first byte of the answer, for streams. */
	ttfbMs?: number;
	input?: number;
	output?: number;
	cached?: number;
	/** When the provider reports a price for the request. */
	costUsd?: number;
	/** Models tried first that reported a limit (or were unavailable), with their status. */
	fallbacks?: Array<{ model: string; status: number }>;
	error?: string;
};

/** Pulls token counts (and a cost, if any) out of an OpenAI-compatible `usage` object. */
export function readUsage(usage: unknown): Pick<LlmCall, "input" | "output" | "cached" | "costUsd"> {
	if (!usage || typeof usage !== "object") return {};
	const u = usage as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
	const details = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
	return {
		input: num(u.prompt_tokens) ?? num(u.input_tokens),
		output: num(u.completion_tokens) ?? num(u.output_tokens),
		cached: num(details.cached_tokens) ?? num(u.cache_read_input_tokens),
		costUsd: num(u.cost) ?? num(u.total_cost),
	};
}

let writing: Promise<void> = Promise.resolve();

/** Appends one record. Best-effort: metering must never break a coding request. */
export function recordLlmCall(call: LlmCall): void {
	writing = writing
		.then(() => appendFile(file(), `${JSON.stringify(call)}\n`))
		.catch((error) => console.error("[llm-usage]", error instanceof Error ? error.message : error));
}

/** Every record since `since` (ms), oldest first. */
export async function llmCalls(since: number): Promise<LlmCall[]> {
	await writing;
	const text = await readFile(file(), "utf8").catch(() => "");
	const all: LlmCall[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			all.push(JSON.parse(line) as LlmCall);
		} catch {
			// a torn last line from a crash mid-append: skip it
		}
	}
	const keep = Date.now() - KEEP_DAYS * 86_400_000;
	const kept = all.filter((c) => c.at >= keep);
	if (kept.length < all.length) {
		// Trim inside the write chain, from a fresh read, so an append that landed meanwhile is kept.
		writing = writing
			.then(async () => {
				const lines = (await readFile(file(), "utf8")).split("\n").filter(Boolean);
				const fresh = lines.filter((line) => {
					try {
						return (JSON.parse(line) as LlmCall).at >= keep;
					} catch {
						return false;
					}
				});
				await writeFile(file(), fresh.map((line) => `${line}\n`).join(""));
			})
			.catch(() => {});
	}
	return kept.filter((c) => c.at >= since);
}

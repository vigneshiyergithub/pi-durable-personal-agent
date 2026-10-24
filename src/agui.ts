// AG-UI bridge (https://docs.ag-ui.com): lets CopilotKit's HttpAgent drive the owner conversation. A run streams the
// conversation's live pi-durable events as AG-UI events over SSE: text, reasoning, tool calls with their results, and
// tool output as it runs. The durable transcript stays the source of truth, so only the newest user message of the
// request is used; history comes from GET /api/messages.
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type AgentEvent, type EntryRecord, type MessageChange, watchEvents } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";

const context = BACKGROUND_CONTEXT;

type Event = { type: string } & Record<string, unknown>;
type AguiMessage = Record<string, unknown> & { id: string; role: string };

type RunInput = {
	threadId: string;
	runId: string;
	messages: Array<{ role: string; content?: unknown }>;
};

/** Strips the "[17 Oct 2026, 13:09] " stamp the host adds to inputs. */
const unstamp = (text: string) => text.replace(/^\[\d{1,2} \w{3} \d{4}, \d{1,2}:\d{2}\] /, "");

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
			: "";

/** The transcript in AG-UI message form, for hydrating the client. */
export async function history(agent: Agent, limit = 200, thread = "owner"): Promise<AguiMessage[]> {
	await agent.thread(thread); // explicit allowlist, shared by history/run/stop
	const bounded = Math.max(1, Math.min(1000, Number.isFinite(limit) ? Math.floor(limit) : 200));
	const owner = partitionLegacyJobs(await conversationHistory(agent.root, bounded));
	return thread === "owner" ? owner.owner : [...owner.jobs, ...await conversationHistory(agent.jobs, bounded)].slice(-bounded);
}

/** Preserve legacy scheduled runs without moving or rewriting durable transcript entries. */
export function partitionLegacyJobs(messages: AguiMessage[]): { owner: AguiMessage[]; jobs: AguiMessage[] } {
	const owner: AguiMessage[] = [], jobs: AguiMessage[] = [];
	let scheduled: boolean | undefined;
	for (const message of messages) {
		if (message.role === "user") scheduled = /^\[job [^\]]+\]/.test(textOf(message.content));
		if (scheduled !== undefined) (scheduled ? jobs : owner).push(message);
	}
	return { owner, jobs };
}

async function conversationHistory(conversation: Agent["root"], limit: number): Promise<AguiMessage[]> {
	const page = await conversation.entries({}, limit, undefined, context);
	const messages: AguiMessage[] = [];
	for (const entry of [...page.items].reverse()) {
		(entry.model ?? []).forEach((message, index) => messages.push(...toAgui(message, `e${entry.id}-${index}`)));
	}
	// A page can start mid-turn; drop leading tool results whose call is not on the page.
	while (messages[0]?.role === "tool") messages.shift();
	return messages;
}

function toAgui(message: Message, id: string): AguiMessage[] {
	switch (message.role) {
		case "user":
			return [{ id, role: "user", content: unstamp(textOf(message.content)) }];
		case "assistant": {
			const out: AguiMessage[] = [];
			const thinking = message.content.flatMap((p) => (p.type === "thinking" && p.thinking ? [p.thinking] : []));
			if (thinking.length) out.push({ id: `${id}-r`, role: "reasoning", content: thinking.join("\n\n") });
			const text = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
			const toolCalls = message.content.flatMap((p) =>
				p.type === "toolCall"
					? [{ id: p.id, type: "function", function: { name: p.name, arguments: JSON.stringify(p.arguments) } }]
					: [],
			);
			if (text || toolCalls.length) out.push({ id, role: "assistant", content: text, ...(toolCalls.length ? { toolCalls } : {}) });
			return out;
		}
		case "toolResult":
			return [
				{
					id,
					role: "tool",
					toolCallId: message.toolCallId,
					content: textOf(message.content),
					...(message.isError ? { error: "error" } : {}),
				},
			];
		default:
			return [];
	}
}

/** Translates one assistant message's streaming changes into AG-UI start/content/end events. */
class Translator {
	private turn = 0;
	private base = "";
	/** Open blocks by content index, with the text already sent for text and reasoning blocks. */
	private open = new Map<number, { kind: "text" | "reasoning" | "tool"; id: string; name?: string; sent: string }>();
	/** Content indexes of the current message already closed, so a final snapshot does not reopen them. */
	private done = new Set<number>();
	/** Tool calls whose arguments were still empty when their block closed; finished at tool_execution_start. */
	private pendingArgs = new Set<string>();

	private readonly emit: (event: Event) => void;

	constructor(emit: (event: Event) => void) {
		this.emit = emit;
	}

	handle(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					this.closeAll();
					this.done.clear();
					this.base = `live-${Date.now().toString(36)}-${this.turn++}`;
				}
				return;
			case "message_update":
				for (const change of event.changes) this.change(change);
				return;
			case "message_end": {
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") this.finish(message);
				return;
			}
			case "tool_execution_start":
				if (this.pendingArgs.delete(event.toolCallId)) this.endTool(event.toolCallId, JSON.stringify(event.args));
				return;
			case "tool_execution_update":
				if (event.parentToolCallId !== undefined || event.output === undefined) return;
				this.emit({ type: "CUSTOM", name: "tool_output", value: { toolCallId: event.toolCallId, ...event.output } });
				return;
			case "tool_execution_end":
				if (event.parentToolCallId !== undefined) return;
				this.emit({
					type: "TOOL_CALL_RESULT",
					messageId: `${event.toolCallId}-result`,
					toolCallId: event.toolCallId,
					role: "tool",
					content: resultText(event.entry),
				});
				return;
			case "auto_retry_start":
				this.emit({ type: "CUSTOM", name: "retry", value: { attempt: event.attempt, error: event.errorMessage } });
				return;
			case "compaction_start":
				this.emit({ type: "CUSTOM", name: "compaction", value: { status: "started", blocking: event.blocking } });
				return;
			case "compaction_end":
				this.emit({ type: "CUSTOM", name: "compaction", value: { status: "finished", error: event.error } });
				return;
			default:
				return;
		}
	}

	private change(change: MessageChange): void {
		switch (change.type) {
			// Progress is committed in batches, so a *_start block can already hold the first chunk of text.
			case "text_start":
				this.ensure(change.contentIndex, "text");
				this.catchUp(change.contentIndex, change.block);
				return;
			case "thinking_start":
				this.ensure(change.contentIndex, "reasoning");
				this.catchUp(change.contentIndex, change.block);
				return;
			case "text_delta":
				this.ensure(change.contentIndex, "text");
				this.append(change.contentIndex, change.delta);
				return;
			case "thinking_delta":
				this.ensure(change.contentIndex, "reasoning");
				this.append(change.contentIndex, change.delta);
				return;
			case "toolcall_start":
				if (change.block.type === "toolCall") this.ensure(change.contentIndex, "tool", change.block.id, change.block.name);
				return;
			case "block":
				this.close(change.contentIndex, change.block);
				return;
			case "message":
				this.finish(change.message);
				return;
			default:
				return; // toolcall_delta: arguments are sent whole when the block completes
		}
	}

	private ensure(index: number, kind: "text" | "reasoning" | "tool", toolId?: string, name?: string): void {
		if (this.open.has(index) || this.done.has(index)) return;
		const id = toolId ?? `${this.base}-${index}`;
		this.open.set(index, { kind, id, name, sent: "" });
		if (kind === "text") this.emit({ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" });
		if (kind === "reasoning") {
			this.emit({ type: "REASONING_START", messageId: id });
			this.emit({ type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" });
		}
		if (kind === "tool") this.emit({ type: "TOOL_CALL_START", toolCallId: id, toolCallName: name, parentMessageId: this.base });
	}

	private append(index: number, delta: string): void {
		const open = this.open.get(index);
		if (open === undefined || !delta) return;
		open.sent += delta;
		const type = open.kind === "text" ? "TEXT_MESSAGE_CONTENT" : "REASONING_MESSAGE_CONTENT";
		this.emit({ type, messageId: open.id, delta });
	}

	/** Sends whatever a block snapshot holds beyond what was already streamed. */
	private catchUp(index: number, block: AssistantMessage["content"][number] | undefined): void {
		const open = this.open.get(index);
		if (open === undefined || block === undefined) return;
		const full = block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : undefined;
		if (full !== undefined && full.length > open.sent.length && full.startsWith(open.sent)) {
			this.append(index, full.slice(open.sent.length));
		}
	}

	private close(index: number, block?: AssistantMessage["content"][number]): void {
		if (block?.type === "toolCall" && !this.open.has(index)) this.ensure(index, "tool", block.id, block.name);
		if (block?.type === "text" && block.text && !this.open.has(index)) this.ensure(index, "text");
		if (block?.type === "thinking" && block.thinking && !this.open.has(index)) this.ensure(index, "reasoning");
		this.catchUp(index, block);
		const open = this.open.get(index);
		if (open === undefined) return;
		this.open.delete(index);
		this.done.add(index);
		if (open.kind === "text") this.emit({ type: "TEXT_MESSAGE_END", messageId: open.id });
		if (open.kind === "reasoning") {
			this.emit({ type: "REASONING_MESSAGE_END", messageId: open.id });
			this.emit({ type: "REASONING_END", messageId: open.id });
		}
		if (open.kind === "tool") {
			const args = block?.type === "toolCall" ? block.arguments : undefined;
			if (args !== undefined && Object.keys(args).length > 0) this.endTool(open.id, JSON.stringify(args));
			else this.pendingArgs.add(open.id);
		}
	}

	private endTool(toolCallId: string, args: string): void {
		this.emit({ type: "TOOL_CALL_ARGS", toolCallId, delta: args });
		this.emit({ type: "TOOL_CALL_END", toolCallId });
	}

	/** Closes everything at the end of a message, opening blocks the stream skipped (a provider without streaming). */
	private finish(message: AssistantMessage): void {
		message.content.forEach((block, index) => this.close(index, block));
		this.closeAll();
	}

	closeAll(): void {
		for (const index of [...this.open.keys()]) this.close(index);
	}

	/** At the end of a run: a call that never started still needs its end event. */
	finishRun(): void {
		this.closeAll();
		for (const id of this.pendingArgs) this.endTool(id, "{}");
		this.pendingArgs.clear();
	}
}

function resultText(entry: EntryRecord | undefined): string {
	const message = entry?.model?.[0];
	if (message?.role !== "toolResult") return "(no result)";
	const text = textOf(message.content);
	return message.isError ? `Error: ${text}` : text;
}

export async function runAgui(agent: Agent, input: RunInput, response: ServerResponse): Promise<void> {
	const conversation = await agent.thread(input.threadId);
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	const emit = (event: Event) => {
		if (!response.writableEnded) response.write(`data: ${JSON.stringify(event)}\n\n`);
	};
	const { threadId, runId } = input;
	emit({ type: "RUN_STARTED", threadId, runId });
	const keepAlive = setInterval(() => response.write(": ping\n\n"), 15_000);

	const translator = new Translator(emit);
	// Attach before submitting so nothing of this run is missed.
	const stream = await watchEvents(agent.harness, conversation.id, context);
	stream.start(async (events) => {
		for (const event of events) translator.handle(event);
	});
	try {
		const last = [...input.messages].reverse().find((m) => m.role === "user");
		const text = textOf(last?.content).trim();
		if (text === "") throw new Error("no user message in request");
		const submission = await agent.submit(conversation, text, `agui:${input.threadId}:${runId}`);
		const settled = await submission.wait(context);
		await new Promise((resolve) => setTimeout(resolve, 50)); // let the final commit's events flush
		translator.finishRun();
		if (settled.status === "done") {
			emit({ type: "RUN_FINISHED", threadId, runId });
		} else {
			const answer = await agent.answerText(conversation, settled);
			emit({ type: "RUN_ERROR", message: answer.replace(/^⚠️ /, "") });
		}
	} catch (error) {
		translator.finishRun();
		emit({ type: "RUN_ERROR", message: error instanceof Error ? error.message : String(error) });
	} finally {
		clearInterval(keepAlive);
		await stream.stop();
		response.end();
	}
}

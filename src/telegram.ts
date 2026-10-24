// Telegram long polling. Messages are admitted durably (requestId per update) before the offset advances, and replies
// are tracked in HostState.pendingReplies, so a restart mid-answer still delivers it.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Agent } from "./agent.ts";
import { config } from "./config.ts";
import { HostState } from "./state.ts";
import { vitals } from "./vitals.ts";

const context = BACKGROUND_CONTEXT;

type Update = { update_id: number; message?: { chat: { id: number }; from?: { id: number }; text?: string } };

export class Telegram {
	private stopped = false;

	private readonly agent: Agent;
	private readonly token: string;

	constructor(agent: Agent, token: string) {
		this.agent = agent;
		this.token = token;
	}

	private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
		const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const json = (await response.json()) as { ok: boolean; result: T; description?: string };
		if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
		return json.result;
	}

	async send(chatId: number, text: string): Promise<void> {
		for (let i = 0; i < text.length; i += 4000) {
			await this.call("sendMessage", { chat_id: chatId, text: text.slice(i, i + 4000) });
		}
	}

	/** Sends to the owner's chat (learned from their first message, or TELEGRAM_OWNER_ID for a private chat). */
	async notifyOwner(text: string): Promise<void> {
		const host = await this.agent.harness.snapshot(HostState, this.agent.root.id, context);
		const chatId = host?.telegramChatId ?? Number(config.telegramOwnerId);
		if (!Number.isFinite(chatId)) throw new Error("no Telegram chat known yet: message the bot first");
		await this.send(chatId, text);
	}

	async run(): Promise<void> {
		while (!this.stopped) {
			try {
				const host = await this.agent.harness.snapshot(HostState, this.agent.root.id, context);
				const updates = await this.call<Update[]>(
					"getUpdates",
					{ offset: host?.telegramOffset, timeout: 50, allowed_updates: ["message"] },
					60_000,
				);
				vitals.telegramPolledAt = Date.now();
				vitals.telegramError = undefined;
				for (const update of updates) await this.handle(update);
			} catch (error) {
				if (this.stopped) return;
				vitals.telegramError = error instanceof Error ? error.message : String(error);
				console.error("[telegram]", error);
				await new Promise((resolve) => setTimeout(resolve, 5_000));
			}
		}
	}

	stop(): void {
		this.stopped = true;
	}

	private async handle(update: Update): Promise<void> {
		const message = update.message;
		const advance = (chatId?: number) =>
			this.agent.root.commit(async (tx) => {
				const host = await tx.doc(HostState, this.agent.root.id);
				host.telegramOffset = update.update_id + 1;
				if (chatId !== undefined) host.telegramChatId = chatId;
			}, context);

		if (message?.text === undefined) return void (await advance());
		const chatId = message.chat.id;
		const from = String(message.from?.id ?? "");

		if (config.telegramOwnerId === undefined) {
			await this.send(chatId, `Not configured yet. Your Telegram id is ${from}: set TELEGRAM_OWNER_ID=${from} and redeploy.`);
			return void (await advance());
		}
		if (from !== config.telegramOwnerId) return void (await advance()); // ignore strangers silently

		const text = message.text.trim();
		const command = await this.command(text);
		if (command !== undefined) {
			await advance(chatId);
			return void (await this.send(chatId, command));
		}

		void this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
		try {
			const submission = await this.agent.submit(this.agent.root, text, `tg:${update.update_id}`);
			await advance(chatId);
			await this.agent.trackReply(submission.id);
		} catch (error) {
			await advance(chatId);
			await this.send(chatId, `⚠️ ${error instanceof Error ? error.message : error}`);
		}
	}

	private async command(text: string): Promise<string | undefined> {
		switch (text.split(/\s+/)[0]) {
			case "/start":
			case "/help":
				return "Just talk to me. Commands: /status, /stop (abort current work), /reset (fresh context, keeps memory), /reflect (run the self-improvement loop now).";
			case "/status":
				return JSON.stringify(await this.agent.status(), null, 2);
			case "/stop":
				await this.agent.root.abort(context);
				return "Stopped.";
			case "/reset":
				await this.agent.root.reset("Context was reset by the owner. Long-term memory and skills are unchanged.", context);
				return "Context reset. Memory and skills kept.";
			case "/reflect":
				void this.agent.maybeReflect(true).then(
					async (report) => {
						if (report) await this.notifyOwner(`🔁 Reflection:\n${report}`);
					},
					(error) => this.notifyOwner(`⚠️ reflection failed: ${error}`),
				);
				return "Reflecting…";
			default:
				return undefined;
		}
	}
}

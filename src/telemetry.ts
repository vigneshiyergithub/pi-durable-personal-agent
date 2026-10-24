// What the web app's Monitor view shows: health, spend, model calls, activity, reflector passes and coding containers.
// Everything is derived from what is already durable — every model call in a transcript carries its model, timing, cost
// and stop reason, every tool result its timing and error flag — plus the orchestrator's goals and this process's
// vitals and numeric runner resource observations. Transcripts are scanned newest first back to WINDOW_DAYS, and the result is cached
// briefly so a dashboard left open costs one scan every CACHE_MS.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { type Conversation, type ConversationId, UsageDoc, type UsageState } from "@earendil-works/pi-durable";
import type { Agent } from "./agent.ts";
import { config } from "./config.ts";
import { skippedModels } from "./llm-proxy.ts";
import { type LlmCall, llmCalls } from "./llm-usage.ts";
import { memory, vitals } from "./vitals.ts";

const context = BACKGROUND_CONTEXT;
const WINDOW_DAYS = 14;
const MAX_ENTRIES = 4_000; // per conversation, a ceiling on one scan
const CACHE_MS = 15_000;
const DAY = 86_400_000;

type Kind = "root" | "reflector" | "foreman" | "reviewer";

type Call = { kind: Kind; at: number; model: string; durationMs?: number; costUsd: number; input: number; output: number; error?: string };
type ToolRun = { at: number; name: string; durationMs?: number; error: boolean; detail: string; args: Record<string, unknown> };
type Turn = { kind: Kind; goalId?: string; at: number; end: number; prompt: string; calls: Call[]; tools: ToolRun[]; answer: string };

export type TurnSummary = {
	id: string;
	at: string;
	source: "chat" | "job" | "reflector" | "foreman" | "reviewer";
	title: string;
	goalId?: string;
	durationMs: number;
	costUsd: number;
	models: string[];
	toolCalls: number;
	toolErrors: Array<{ name: string; detail: string }>;
	modelError?: string;
	/** Notable tool calls by name, e.g. skill_save, memory. */
	tools: Record<string, number>;
};

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (part?.type === "text" ? part.text : "")).join("")
			: "";
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const shortModel = (model: string) => model.split("/").at(-1) ?? model;

/** Groups a conversation's messages (oldest first) into turns: each input and everything done in reply to it. */
async function scan(conversation: Conversation, kind: Kind, since: number, goalId?: string): Promise<Turn[]> {
	const messages: Message[] = [];
	let cursor: unknown;
	let seen = 0;
	scanning: do {
		const page = await conversation.entries({}, 500, cursor as never, context);
		for (const entry of page.items) {
			seen++;
			const model = entry.model ?? [];
			for (let i = model.length - 1; i >= 0; i--) messages.push(model[i]!);
			const at = (model[0] as { timestamp?: number } | undefined)?.timestamp;
			if ((at !== undefined && at < since) || seen >= MAX_ENTRIES) break scanning;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	messages.reverse();

	const turns: Turn[] = [];
	let turn: Turn | undefined;
	const args = new Map<string, Record<string, unknown>>();
	for (const message of messages) {
		const at = (message as { timestamp?: number }).timestamp ?? 0;
		if (message.role === "user") {
			const prompt = textOf(message.content);
			if (prompt.startsWith("<summary>") || prompt.startsWith("The conversation history before this point")) continue; // compaction
			turn = { kind, goalId, at, end: at, prompt, calls: [], tools: [], answer: "" };
			turns.push(turn);
		} else if (turn && message.role === "assistant") {
			const m = message as AssistantMessage;
			const failed = m.stopReason === "error" || m.stopReason === "aborted";
			turn.calls.push({
				kind,
				at,
				model: m.responseModel ?? m.model,
				durationMs: m.durationMs,
				costUsd: m.usage?.cost?.total ?? 0,
				input: m.usage?.input ?? 0,
				output: m.usage?.output ?? 0,
				error: failed ? clip(m.errorMessage ?? m.stopReason, 200) : undefined,
			});
			for (const part of m.content) {
				if (part.type === "toolCall") args.set(part.id, (part.arguments ?? {}) as Record<string, unknown>);
				if (part.type === "text" && part.text.trim()) turn.answer = part.text.trim();
			}
			turn.end = Math.max(turn.end, at + (m.durationMs ?? 0));
		} else if (turn && message.role === "toolResult") {
			const r = message as ToolResultMessage;
			turn.tools.push({
				at,
				name: r.toolName,
				durationMs: r.durationMs,
				error: r.isError,
				detail: clip(textOf(r.content).trim(), 240),
				args: args.get(r.toolCallId) ?? {},
			});
			turn.end = Math.max(turn.end, at + (r.durationMs ?? 0));
		}
	}
	return turns.filter((t) => t.at >= since);
}

const STAMP = /^\[[^\]]{4,40}\] /; // the "[19 Oct 2026, 14:31] " prefix Agent.submit adds
const JOB = /^\[job ([\w-]+)\] /;

function summarize(turn: Turn, index: number): TurnSummary {
	const prompt = turn.prompt.replace(STAMP, "");
	const job = JOB.exec(prompt);
	const source = turn.kind === "root" ? (job ? "job" : "chat") : turn.kind;
	const firstLine = (job ? prompt.slice(job[0].length) : prompt).split("\n")[0]!.trim();
	const tools: Record<string, number> = {};
	for (const t of turn.tools) tools[t.name] = (tools[t.name] ?? 0) + 1;
	return {
		id: `${turn.kind}:${turn.goalId ?? ""}:${turn.at}:${index}`,
		at: new Date(turn.at).toISOString(),
		source,
		title: clip(firstLine, 140),
		goalId: turn.goalId,
		durationMs: Math.max(0, turn.end - turn.at),
		costUsd: turn.calls.reduce((sum, c) => sum + c.costUsd, 0),
		models: [...new Set(turn.calls.map((c) => shortModel(c.model)))],
		toolCalls: turn.tools.length,
		toolErrors: turn.tools.filter((t) => t.error).map((t) => ({ name: t.name, detail: t.detail })),
		modelError: turn.calls.findLast((c) => c.error)?.error,
		tools,
	};
}

const sumCost = (state: UsageState | undefined) => {
	let total = 0;
	for (const group of [state?.models, state?.tools]) {
		for (const value of Object.values(group ?? {})) total += (value as { cost?: { total?: number } }).cost?.total ?? 0;
	}
	return total;
};

const percentile = (values: number[], p: number) => {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** The calendar day of a timestamp in the owner's timezone, as YYYY-MM-DD. */
const dayKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(ms);

async function build(agent: Agent) {
	const now = Date.now();
	const since = now - WINDOW_DAYS * DAY;
	const [orchestra, inspection, total] = await Promise.all([
		agent.orchestrator.state(),
		agent.harness.inspect(context).catch(() => undefined),
		agent.spend(),
	]);
	const status = await agent.status();

	// Every conversation that spends: the owner's, the reflector, and each goal's foreman and reviewer.
	const sources: Array<{ id: ConversationId; kind: Kind; goalId?: string }> = [
		{ id: agent.root.id, kind: "root" },
		{ id: agent.jobs.id, kind: "root" },
		{ id: agent.reflector.id, kind: "reflector" },
	];
	for (const goal of orchestra.goals) {
		sources.push({ id: goal.foremanId, kind: "foreman", goalId: goal.id });
		if (goal.reviewerId) sources.push({ id: goal.reviewerId, kind: "reviewer", goalId: goal.id });
	}

	const lifetime: Record<Kind, number> = { root: 0, reflector: 0, foreman: 0, reviewer: 0 };
	const turns: Turn[] = [];
	await Promise.all(
		sources.map(async (source) => {
			lifetime[source.kind] += sumCost(await agent.harness.snapshot(UsageDoc, source.id, context).catch(() => undefined));
			const goal = source.goalId ? orchestra.goals.find((g) => g.id === source.goalId) : undefined;
			if (goal && Date.parse(goal.updatedAt) < since) return; // nothing of it can fall in the window
			const conversation =
				source.kind === "root" ? (source.id === agent.jobs.id ? agent.jobs : agent.root) : source.kind === "reflector" ? agent.reflector : await agent.harness.conversation(source.id, context);
			if (conversation) turns.push(...(await scan(conversation, source.kind, since, source.goalId)));
		}),
	);
	turns.sort((a, b) => a.at - b.at);
	const calls = turns.flatMap((t) => t.calls);
	const summaries = turns.map(summarize);

	// Coding containers spend outside the harness (their own capped key, or the OpenCode Go plan).
	const attempts = orchestra.goals.flatMap((goal) =>
		goal.tasks.flatMap((task) => task.attempts.map((attempt) => ({ goal, task, attempt }))),
	);
	const coderCost = (from: number, to = Infinity) =>
		attempts.reduce((sum, { attempt }) => {
			const at = Date.parse(attempt.finishedAt ?? attempt.claimedAt);
			return at >= from && at < to ? sum + (attempt.evidence?.costUsd ?? 0) : sum;
		}, 0);

	// Daily spend over the window, by kind, in the owner's timezone.
	const days: Array<{ day: string; root: number; reflector: number; goals: number; coders: number }> = [];
	for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push({ day: dayKey(now - i * DAY), root: 0, reflector: 0, goals: 0, coders: 0 });
	const byDay = new Map(days.map((d) => [d.day, d]));
	for (const call of calls) {
		const day = byDay.get(dayKey(call.at));
		if (!day) continue;
		if (call.kind === "root") day.root += call.costUsd;
		else if (call.kind === "reflector") day.reflector += call.costUsd;
		else day.goals += call.costUsd;
	}
	for (const { attempt } of attempts) {
		const day = byDay.get(dayKey(Date.parse(attempt.finishedAt ?? attempt.claimedAt)));
		if (day) day.coders += attempt.evidence?.costUsd ?? 0;
	}

	const today = dayKey(now);
	const todayCalls = calls.filter((c) => dayKey(c.at) === today);
	const kindToday = (kinds: Kind[]) => {
		const list = todayCalls.filter((c) => kinds.includes(c.kind));
		return {
			calls: list.length,
			input: list.reduce((s, c) => s + c.input, 0),
			output: list.reduce((s, c) => s + c.output, 0),
			costUsd: list.reduce((s, c) => s + c.costUsd, 0),
		};
	};
	const hourAgo = now - 3_600_000;
	const lastHour = calls.filter((c) => c.at >= hourAgo);

	// Models over the last 24 hours.
	const recent = calls.filter((c) => c.at >= now - DAY);
	const models = [...new Set(recent.map((c) => c.model))]
		.map((model) => {
			const list = recent.filter((c) => c.model === model);
			const durations = list.flatMap((c) => (c.durationMs === undefined ? [] : [c.durationMs]));
			return {
				model: shortModel(model),
				kinds: [...new Set(list.map((c) => c.kind))],
				calls: list.length,
				errors: list.filter((c) => c.error).length,
				p50Ms: percentile(durations, 50),
				p95Ms: percentile(durations, 95),
				costUsd: list.reduce((s, c) => s + c.costUsd, 0),
			};
		})
		.sort((a, b) => b.calls - a.calls);

	// Tools over the last 24 hours, worst first.
	const toolRuns = turns.flatMap((t) => t.tools).filter((t) => t.at >= now - DAY);
	const tools = [...new Set(toolRuns.map((t) => t.name))]
		.map((name) => {
			const list = toolRuns.filter((t) => t.name === name);
			const durations = list.flatMap((t) => (t.durationMs === undefined ? [] : [t.durationMs]));
			const failures = list.filter((t) => t.error);
			return { name, calls: list.length, errors: failures.length, p95Ms: percentile(durations, 95), lastError: failures.at(-1)?.detail };
		})
		.sort((a, b) => b.errors - a.errors || b.calls - a.calls);

	// Reflector passes: what each read, changed and cost.
	const passes = turns
		.filter((t) => t.kind === "reflector")
		.map((t, i) => {
			const s = summarize(t, i);
			const changes = t.tools
				.filter((tool) => ["skill_save", "skill_rollback", "skill_remove", "memory", "schedule_job", "cancel_job", "notify"].includes(tool.name))
				.map((tool) => ({
					tool: tool.name,
					target: String(tool.args.name ?? tool.args.topic ?? tool.args.action ?? tool.args.id ?? ""),
					note: clip(String(tool.args.description ?? tool.args.content ?? tool.args.prompt ?? tool.args.message ?? ""), 240),
					error: tool.error ? tool.detail : undefined,
				}));
			return { at: s.at, durationMs: s.durationMs, costUsd: s.costUsd, models: s.models, toolCalls: s.toolCalls, changes, report: clip(t.answer, 1_500), error: s.modelError };
		})
		.reverse();

	const containers = attempts
		.filter(({ attempt }) => attempt.sandbox)
		.map(({ goal, task, attempt }) => ({
			name: `task-${task.id}-${attempt.n}`,
			goalId: goal.id,
			goal: goal.title,
			task: task.title,
			attempt: attempt.n,
			model: attempt.model,
			state: !attempt.finishedAt && !attempt.sandbox!.cleaned ? "running" : !attempt.sandbox!.cleaned ? "cleanup" : "removed",
			startedAt: attempt.claimedAt,
			heartbeatAt: attempt.heartbeatAt,
			resources: attempt.evidence?.resources ?? attempt.resources,
			resourcesAt: attempt.evidence?.resources ? attempt.finishedAt : attempt.resourcesAt,
			finishedAt: attempt.finishedAt,
			costUsd: attempt.evidence?.costUsd,
			unbudgeted: attempt.unbudgeted,
			evidencePending: Boolean(attempt.pendingEvidence),
			evidenceRetryAt: attempt.pendingEvidence?.retryAfter,
			verdict: attempt.verdict?.decision,
			error: attempt.error ?? attempt.evidence?.agentError,
		}))
		.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

	const coding = await codingUsage(now, attempts, dayKey);

	const goalTitles = Object.fromEntries(orchestra.goals.map((g) => [g.id, g.title]));
	const failuresHour = summaries.filter((s) => Date.parse(s.at) >= hourAgo && (s.toolErrors.length > 0 || s.modelError));

	return {
		generatedAt: new Date(now).toISOString(),
		windowDays: WINDOW_DAYS,
		timezone: config.timezone,
		health: {
			startedAt: new Date(vitals.startedAt).toISOString(),
			version: vitals.version ?? null,
			serverErrors: vitals.serverErrors,
			harnessReports: vitals.harnessReports,
			scheduling: inspection?.scheduling ?? "unknown",
			liveTasks: inspection?.tasks.length ?? 0,
			queuedSubmissions: inspection?.submissions.length ?? 0,
			telegram: {
				enabled: config.telegramToken !== undefined,
				polledAt: vitals.telegramPolledAt ? new Date(vitals.telegramPolledAt).toISOString() : null,
				error: vitals.telegramError ?? null,
			},
			pauseAll: config.pauseAll,
			memory: memory(),
			reflecting: status.reflecting,
			lastReflectAt: status.lastReflectAt,
			reflectEveryHours: status.reflectEveryHours,
			failuresLastHour: failuresHour.length,
			toolErrorsLastHour: failuresHour.reduce((n, s) => n + s.toolErrors.length, 0),
		},
		spend: {
			totalUsd: total,
			capUsd: config.maxSpendUsd,
			lifetime: { ...lifetime, coders: coderCost(0) },
			todayUsd: todayCalls.reduce((s, c) => s + c.costUsd, 0),
			todayCodersUsd: coderCost(Date.parse(`${today}T00:00:00Z`) - tzOffsetMs(now)),
			lastHourUsd: lastHour.reduce((s, c) => s + c.costUsd, 0),
			days,
			today: {
				root: kindToday(["root"]),
				reflector: kindToday(["reflector"]),
				goals: kindToday(["foreman", "reviewer"]),
			},
			topTurns: summaries
				.filter((s) => dayKey(Date.parse(s.at)) === today)
				.sort((a, b) => b.costUsd - a.costUsd)
				.slice(0, 6),
		},
		models,
		tools,
		activity: summaries.slice(-300).reverse(),
		events: orchestra.events.slice(-100).reverse(),
		incidents: (orchestra.incidents ?? []).slice().reverse(),
		passes,
		containers: containers.slice(0, 30),
		coding,
		goalTitles,
		jobs: status.jobs.length,
		skills: { total: status.skills.length, broken: status.skills.filter((s) => s.error).length },
	};
}

type AttemptRef = { goal: { id: string; title: string }; task: { id: string; title: string }; attempt: { n: number; evidence?: { costUsd?: number } } };

/** OpenCode Go usage, from the coding-model proxy's meter: plan windows, models, days, attempts and recent errors. */
async function codingUsage(now: number, attempts: AttemptRef[], dayKey: (ms: number) => string) {
	const calls = await llmCalls(now - 30 * DAY);
	const limited = (c: LlmCall) => (c.fallbacks?.length ?? 0) + (c.status === 429 ? 1 : 0);
	const totals = (list: LlmCall[]) => ({
		requests: list.length,
		input: list.reduce((s, c) => s + (c.input ?? 0), 0),
		output: list.reduce((s, c) => s + (c.output ?? 0), 0),
		cached: list.reduce((s, c) => s + (c.cached ?? 0), 0),
		errors: list.filter((c) => c.status >= 400).length,
		limitHits: list.reduce((s, c) => s + limited(c), 0),
		costUsd: list.some((c) => c.costUsd !== undefined) ? list.reduce((s, c) => s + (c.costUsd ?? 0), 0) : null,
	});
	// OpenCode Go meters its plan over rolling windows; show usage over the same spans.
	const windows = [
		{ label: "5 hours", ms: 5 * 3_600_000 },
		{ label: "24 hours", ms: DAY },
		{ label: "7 days", ms: 7 * DAY },
		{ label: "30 days", ms: 30 * DAY },
	].map((w) => ({ label: w.label, ...totals(calls.filter((c) => c.at >= now - w.ms)) }));

	const week = calls.filter((c) => c.at >= now - 7 * DAY);
	const models = [...new Set(week.map((c) => c.model))]
		.map((model) => {
			const list = week.filter((c) => c.model === model);
			const ok = list.filter((c) => c.status < 400);
			return {
				model,
				...totals(list),
				p50Ms: percentile(ok.map((c) => c.ms), 50),
				p95Ms: percentile(ok.map((c) => c.ms), 95),
				ttfbP50Ms: percentile(ok.flatMap((c) => (c.ttfbMs === undefined ? [] : [c.ttfbMs])), 50),
			};
		})
		.sort((a, b) => b.requests - a.requests);

	const days: Array<{ day: string; requests: number; input: number; output: number; cached: number; errors: number }> = [];
	for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.push({ day: dayKey(now - i * DAY), requests: 0, input: 0, output: 0, cached: 0, errors: 0 });
	const byDay = new Map(days.map((d) => [d.day, d]));
	for (const c of calls) {
		const d = byDay.get(dayKey(c.at));
		if (!d) continue;
		d.requests++;
		d.input += c.input ?? 0;
		d.output += c.output ?? 0;
		d.cached += c.cached ?? 0;
		if (c.status >= 400) d.errors++;
	}

	const byAttempt = new Map<string, LlmCall[]>();
	for (const c of calls) byAttempt.set(`${c.task}#${c.attempt}`, [...(byAttempt.get(`${c.task}#${c.attempt}`) ?? []), c]);
	const attemptRows = [...byAttempt.entries()]
		.map(([key, list]) => {
			const [task, n] = key.split("#");
			const ref = attempts.find((a) => a.task.id === task && a.attempt.n === Number(n));
			return {
				task: task!,
				attempt: Number(n),
				taskTitle: ref?.task.title,
				goalId: ref?.goal.id,
				goalTitle: ref?.goal.title,
				startedAt: new Date(list[0]!.at).toISOString(),
				lastAt: new Date(list.at(-1)!.at).toISOString(),
				models: [...new Set(list.map((c) => c.model))],
				...totals(list),
				/** What OpenCode itself estimated the attempt cost, from its model prices. */
				estimatedUsd: ref?.attempt.evidence?.costUsd,
			};
		})
		.sort((a, b) => b.lastAt.localeCompare(a.lastAt))
		.slice(0, 20);

	return {
		provider: config.sandbox.coderProvider,
		chain: config.sandbox.coderModel.split(",").map((m) => m.trim()).filter(Boolean),
		skipped: skippedModels(),
		firstSeen: calls[0] ? new Date(calls[0].at).toISOString() : null,
		lastSeen: calls.at(-1) ? new Date(calls.at(-1)!.at).toISOString() : null,
		windows,
		models,
		days,
		attempts: attemptRows,
		errors: calls
			.filter((c) => c.status >= 400 || c.fallbacks?.length)
			.slice(-12)
			.reverse()
			.map((c) => ({ at: new Date(c.at).toISOString(), task: c.task, attempt: c.attempt, model: c.model, status: c.status, error: c.error, fallbacks: c.fallbacks })),
	};
}

/** How far the owner's timezone is ahead of UTC right now, in ms (for "today" starting at local midnight). */
function tzOffsetMs(at: number): number {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: config.timezone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
	const local = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
	return local - Math.floor(at / 1000) * 1000;
}

export type Telemetry = Awaited<ReturnType<typeof build>>;

let cached: { at: number; value: Promise<Telemetry> } | undefined;

export function telemetry(agent: Agent): Promise<Telemetry> {
	if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
	const value = build(agent);
	cached = { at: Date.now(), value };
	value.catch(() => {
		if (cached?.value === value) cached = undefined;
	});
	return value;
}

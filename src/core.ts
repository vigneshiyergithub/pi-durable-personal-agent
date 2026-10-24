// The fixed core the agent cannot rewrite: identity, long-term memory, the skill system, scheduling, and notifications.
// Everything the agent learns to do lives in skills (see skills.ts) on top of this.
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord/context";
import { type ConversationId, defineExtension, defineTool, section, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { reconcileReports } from "./schedule-policy.ts";
import { config } from "./config.ts";
import { type Skills, SKILL_PREFIX } from "./skills.ts";
import { type Job, Jobs } from "./state.ts";

const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });

const readMemory = () => readFile(config.memoryPath, "utf8").catch(() => "");

const MEMORY_KINDS = ["rule", "preference", "project", "fact"] as const;

/** One memory line: `- [2026-10-19] (rule) Deployment: never bind 8080`. Newlines are folded so an entry stays one line. */
export function memoryEntry(args: { content: string; kind?: string; topic?: string }, today = new Date()): string {
	let body = args.content.replace(/\s*\n\s*/g, " ").trim().replace(/^[-*]\s+/, "");
	const dated = /^\[(\d{4}-\d{2}-\d{2})\]\s*/.exec(body);
	if (dated) body = body.slice(dated[0].length);
	const date = dated?.[1] ?? today.toISOString().slice(0, 10);
	const topic = args.topic?.replace(/[:\n]/g, " ").trim();
	return `- [${date}]${args.kind ? ` (${args.kind})` : ""} ${topic ? `${topic}: ` : ""}${body}`;
}

export type CoreDeps = {
	skills: Skills;
	/** The conversation that owns jobs and host state. */
	rootId: () => ConversationId;
	reflectorId?: () => ConversationId;
	notify: (message: string) => Promise<void>;
	/** Recent owner and jobs turns, rendered as text, for the reflector. */
	recentActivity: (limit: number) => Promise<string>;
};

const IDENTITY = `You are a personal agent that runs continuously on a server and works for one person, your owner.
You reach them via Telegram and a web chat. Inputs prefixed with [job] come from your own scheduler, not from the owner.

How you work:
- Be concise. Do the task with your tools rather than describing how you would do it.
- You have a persistent Linux workspace (bash, read, write, edit). Files there survive restarts.
- Keep long-term facts about the owner and their preferences with \`memory\`. Read it before asking the owner something you may already know.
- You are the owner's orchestrator for their software projects. You never write project code yourself: OpenCode does, in throwaway containers. Projects are this agent itself (the owner merges its PRs) and repos you create with \`create_project\` (you merge those). When the owner wants something built or fixed in a project, agree the goal and its acceptance criteria with them (ask if vague), check \`list_projects\`, then \`create_goal\`. Project and goal status change all the time: always call \`list_projects\` or \`goal_status\` fresh before answering about them, never rely on an earlier answer. A foreman plans it and sends the owner the plan with a one-time approval code. You cannot approve a plan yourself: call \`approve_plan\` only with the code the owner typed to you, or ask them to press Approve in the web app. Use \`goal_status\` to report progress and \`message_foreman\` to pass on the owner's answers and changes of direction.
- Use \`schedule_job\` for reminders, recurring checks, and follow-ups. A job sends you its prompt at the scheduled time and your final answer is forwarded to the owner. Use \`notify\` for messages mid-task.

You can extend yourself. When you notice you lack a capability, or keep doing the same multi-step thing by hand, write a skill with \`skill_save\`:
a JavaScript ES module whose default export is \`(kit) => kit.defineExtension({ name: "${SKILL_PREFIX}<name>", tools: [...] })\`.
\`kit\` provides defineExtension, defineTool, Type (TypeBox) and fetch. Skills define tools only, and cannot import npm packages (use kit and fetch). They may import pure node: builtins (node:crypto, node:url, node:zlib), but they cannot read or write files or start processes.
A tool is \`kit.defineTool({ name, description, parameters: kit.Type.Object({...}), execute: async (args) => ({ output: [{ type: "text", text }] }) })\`. It may also return \`control: { handoff }\` to reset the context.
Skill tools run isolated in their own process as an unprivileged user, with a 256 MB memory limit and 60 s per call: a call that exceeds either is stopped and returns an error, so keep loops bounded and stream nothing large.
Skills see no secrets except the ones the owner set for them: environment variables named SKILL_* (e.g. process.env.SKILL_WEATHER_KEY). If a skill needs an API key that isn't there, ask the owner to add it in Railway as SKILL_<NAME>; never ask for it in chat. A skill is validated before it replaces the old version; if it fails to load, nothing changes. Test new tools by calling them right after saving. Use \`skill_rollback\` if a new version misbehaves.
Skill sources live at ${config.skillsDir}/<name>.mjs. To change a skill, \`read\` that file and call \`skill_save\` with the full new code; never edit skill files directly. Call external APIs defensively (timeouts, a retry on 5xx) and return a clear error message instead of throwing raw HTTP errors.`;

export function createCore(deps: CoreDeps) {
	const updateJobs = async (api: ToolExecutionApi, ctx: Context, change: (jobs: Job[]) => string) => {
		let result = "";
		await api.commit(async (tx) => {
			const doc = await tx.doc(Jobs, deps.rootId());
			result = change(doc.jobs);
			reconcileReports(doc);
		}, ctx);
		return result;
	};

	return defineExtension({
		name: "core",
		sections: [
			section("identity", () => IDENTITY, { tag: false }),
			section("memory", async () => (await readMemory()).trim() || undefined),
			section("skills", () => {
				const skills = deps.skills.list();
				if (skills.length === 0) return "No skills yet.";
				return skills
					.map((s) => `- ${s.name}: ${s.description || "(no description)"} [tools: ${s.tools.join(", ")}]${s.error ? ` BROKEN: ${s.error}` : ""}`)
					.join("\n");
			}),
		],
		tools: [
			defineTool({
				name: "memory",
				description:
					"Long-term memory shown in your system prompt every turn. It is a list of one-line entries, `- [YYYY-MM-DD] (kind) Topic: fact`, where kind is rule (a standing instruction from the owner), preference, project or fact. action=append adds one entry: pass kind and a short topic, and put only the fact in content (it is dated for you). action=replace rewrites the whole file (to prune or reorganise; keep it under ~150 lines and every line in the entry format).",
				parameters: Type.Object({
					action: Type.Union([Type.Literal("append"), Type.Literal("replace")]),
					content: Type.String(),
					kind: Type.Optional(Type.Union(MEMORY_KINDS.map((k) => Type.Literal(k)))),
					topic: Type.Optional(Type.String({ description: "A few words naming what the fact is about, e.g. Deployment" })),
				}),
				replay: "safe",
				execute: async (args) => {
					const current = await readMemory();
					const next = args.action === "append" ? `${current.trimEnd()}\n${memoryEntry(args)}\n` : `${args.content.trim()}\n`;
					await writeFile(config.memoryPath, next.trimStart());
					return text(`memory ${args.action}ed (${next.split("\n").length} lines)`);
				},
			}),
			defineTool({
				name: "skill_save",
				description: "Create or replace a skill (a hot-loaded extension giving you new tools). See the system prompt for the module format.",
				parameters: Type.Object({
					name: Type.String({ description: "lowercase-dashed name, without the skill- prefix" }),
					description: Type.String({ description: "one line: what it does and when to use it" }),
					code: Type.String({ description: "the full ES module source" }),
				}),
				execute: async (args) => {
					const info = await deps.skills.save(args.name, args.code, args.description);
					return text(`saved skill ${info.name}; tools now available: ${info.tools.join(", ") || "(none)"}`);
				},
			}),
			defineTool({
				name: "skill_list",
				description: "List installed skills with their tools and load errors.",
				parameters: Type.Object({}),
				execute: async () => text(JSON.stringify(deps.skills.list(), null, 2)),
			}),
			defineTool({
				name: "skill_rollback",
				description: "Restore the previous version of a skill.",
				parameters: Type.Object({ name: Type.String() }),
				execute: async (args) => text(`rolled back ${(await deps.skills.rollback(args.name)).name}`),
			}),
			defineTool({
				name: "skill_remove",
				description: "Uninstall a skill (archived, can be rolled back).",
				parameters: Type.Object({ name: Type.String() }),
				execute: async (args) => {
					await deps.skills.remove(args.name);
					return text(`removed ${args.name}`);
				},
			}),
			defineTool({
				name: "schedule_job",
				description: `Schedule a prompt to be sent to you later. Times are ISO 8601; the owner's timezone is ${config.timezone}.`,
				parameters: Type.Object({
					prompt: Type.String({ description: "what you should do when it fires, written as an instruction to yourself" }),
					purpose: Type.Optional(Type.Union([Type.Literal("general"), Type.Literal("daily-report")], { description: "daily-report replaces the previous daily CEO report; general keeps intentionally separate jobs" })),
					at: Type.String({ description: "ISO 8601 time of the first run, with offset" }),
					everyMinutes: Type.Optional(Type.Number({ minimum: 5, description: "repeat interval; omit for one-shot" })),
					runOnChange: Type.Optional(Type.Boolean({ description: "For recurring orchestra-status watches only: skip model calls until goals/tasks/review state changes. Never use for time reminders or external-site checks." })),
				}),
				replay: "safe",
				execute: async (args, api, ctx) => {
					const at = new Date(args.at);
					if (Number.isNaN(at.getTime())) throw new Error(`invalid time: ${args.at}`);
					const id = `job-${randomUUID().slice(0, 8)}`;
					const creator = api.conversationId === deps.reflectorId?.() ? "reflector" : "agent";
					await updateJobs(api, ctx, (jobs) => {
						// Documents are JSON: an absent interval must be left out, not stored as undefined.
						const job: Job = { id, prompt: args.prompt, nextRunAt: at.toISOString(), createdBy: creator };
						if (args.purpose) job.purpose = args.purpose;
						if (args.everyMinutes !== undefined) job.everyMinutes = args.everyMinutes;
						if (args.runOnChange && args.everyMinutes) job.runOnChange = true;
						jobs.push(job);
						return id;
					});
					return text(`scheduled ${id} for ${at.toISOString()}${args.everyMinutes ? `, every ${args.everyMinutes} min` : ""}`);
				},
			}),
			defineTool({
				name: "list_jobs",
				description: "List scheduled jobs.",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					const doc = await api.snapshot(Jobs, deps.rootId(), ctx);
					return text(JSON.stringify(doc?.jobs ?? [], null, 2));
				},
			}),
			defineTool({
				name: "cancel_job",
				description: "Cancel a scheduled job by id.",
				parameters: Type.Object({ id: Type.String() }),
				replay: "safe",
				execute: async (args, api, ctx) =>
					text(
						await updateJobs(api, ctx, (jobs) => {
							const index = jobs.findIndex((job) => job.id === args.id);
							if (index < 0) return `no job ${args.id}`;
							jobs.splice(index, 1);
							return `cancelled ${args.id}`;
						}),
					),
			}),
			defineTool({
				name: "notify",
				description: "Send the owner a message on Telegram right now. Use from scheduled jobs or when something needs their attention.",
				parameters: Type.Object({ message: Type.String() }),
				execute: async (args) => {
					await deps.notify(args.message);
					return text("sent");
				},
			}),
			defineTool({
				name: "recent_activity",
				description: "Read the owner's recent conversation with the main agent (newest last). For reflection.",
				parameters: Type.Object({ limit: Type.Optional(Type.Number({ maximum: 400 })) }),
				execute: async (args) => text(await deps.recentActivity(args.limit ?? 120)),
			}),
		],
	});
}

export const REFLECTOR_INSTRUCTIONS = `You are the reflection loop of the personal agent: its outer loop. You are not talking to the owner.
Each time you are woken, review what happened since the last reflection with \`recent_activity\` and improve the agent:
1. Failures and friction: tool errors, things the agent could not do, repeated manual multi-step work, corrections from the owner.
2. Fix the cause: write or repair a skill (skill_save, then call its tools to test them), or roll back a skill that made things worse.
3. Curate memory: add durable facts and preferences the agent learned; remove stale or duplicate lines (memory replace). Keep one entry per line in the form \`- [YYYY-MM-DD] (rule|preference|project|fact) Topic: fact\`, rewriting older lines into it.
4. Schedule follow-ups the agent promised but did not schedule.
5. The software factory: call \`scorecards\` once. It compares the coder, foreman and reviewer numbers over 7 days with 30 days and lists what got clearly worse (first-attempt acceptance, proof pass rate, cost per accepted task, review rounds) in \`worse\`, with the owner message in \`notice\`. If \`notice\` is present, send it to the owner with \`notify\`, once, adding your own suggested change if the activity explains the drop. If it is absent, say nothing about the scorecards. This step is advisory only: never change models, configuration or goals yourself, and it does not count towards your 3 changes.
Make at most 3 changes per reflection, each small and tested. Prefer improving an existing skill over adding a new one.
Finish with a short changelog. Otherwise only \`notify\` the owner if you changed something they would notice or need to approve.`;

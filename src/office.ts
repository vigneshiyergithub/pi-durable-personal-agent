// The Office (issue #9): what the owner sees at a glance, and the agent's daily CEO report. Reports are kept as a
// durable document on the root conversation; the web app's Office tab reads them with the roles of the team.
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { type ConversationId, defineDoc, defineExtension, defineTool, type Tx } from "@earendil-works/pi-durable";
import { isDailyReport, reconcileReports } from "./schedule-policy.ts";
import { config } from "./config.ts";
import { type Job, Jobs } from "./state.ts";

export type Report = { id: string; at: string; title: string; markdown: string; goalIds: string[] };

export const Reports = defineDoc<{ reports: Report[] }>({
	kind: "app.reports",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ reports: [] }),
});

const KEEP_REPORTS = 30;
export const CEO_REPORT_JOB = "ceo-daily-report";

const CEO_REPORT_PROMPT = `Write today's CEO report for the owner and save it with save_report. You run the agent's software factory; the owner reads this once a day.
Gather the facts first: goal_status (open goals), scorecards, and recent_activity. Then write markdown, under 400 words, with these sections:
- **Shipped:** goals done or merged since the last report, each with its goal id.
- **Broke:** rollbacks, failed reverts and false alarms (the crash bin), escalations, and goals stuck for more than a day.
- **Learned:** what the scorecards say: first-attempt acceptance, missing reports, review rounds, cost per task. Name one thing to change.
- **Spend:** today's spend against the cap.
- **Tomorrow:** what you will push forward.
- **Needs you:** each decision only the owner can make, one line each with the goal id, or "Nothing."
Cite real goal ids only. Don't pad: if nothing happened, say so in two lines. Then answer with one line: the report's title.`;

/** The daily CEO report job, created once; the owner or the agent may change or cancel it like any job. */
export async function ensureReportJob(tx: Tx, rootId: ConversationId): Promise<void> {
	const doc = await tx.doc(Jobs, rootId);
	// Repair the first archive release: its detached-array push persisted [] rather than the seed.
	// The bundled seed prompt is known; its previous run time is not recoverable, so restoring
	// this inactive template schedules a new run instead of pretending to preserve that time.
	if (!doc.archiveVersion) {
		if (doc.reportSeeded && doc.archived?.length === 0 && !doc.jobs.some((j) => j.id === CEO_REPORT_JOB) && doc.jobs.some(isDailyReport)) {
			doc.archived = [{ job: { id: CEO_REPORT_JOB, prompt: CEO_REPORT_PROMPT, everyMinutes: 1440, nextRunAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(), createdBy: "agent" }, at: new Date().toISOString(), reason: "Recovered default report template after archive persistence repair; restoring schedules a new daily run." }];
		}
		doc.archiveVersion = 1;
	}
	reconcileReports(doc);
	if (doc.reportSeeded) return;
	doc.reportSeeded = true;
	// Existing installations may have deliberately cancelled their report.
	if (doc.jobs.length || (await tx.doc(Reports, rootId)).reports.length) return;
	const job: Job = {
		id: CEO_REPORT_JOB,
		prompt: CEO_REPORT_PROMPT,
		nextRunAt: new Date(Date.now() + 10 * 60_000).toISOString(),
		everyMinutes: 24 * 60,
		createdBy: "agent",
	};
	doc.jobs.push(job);
}

/** Who does what, from the live configuration. */
export function roles() {
	return [
		{ role: "agent", model: config.model, does: "talks to you, runs goals and jobs, writes skills" },
		{ role: "reflector", model: config.reflectModel, does: "reviews recent work and improves memory and skills" },
		{ role: "foreman", model: config.foremanModel, does: "plans each goal and judges every attempt's evidence" },
		{ role: "coder", model: config.sandbox.coderModel, does: "writes the code in throwaway containers (OpenCode)" },
		{ role: "reviewer", model: config.reviewerModel, does: "reviews each goal's whole diff before the merge gate" },
	] as const;
}

export function createOfficeExtension(deps: { rootId: () => ConversationId; jobsId?: () => ConversationId }) {
	return defineExtension({
		name: "office",
		tools: [
			defineTool({
				name: "save_report",
				description: "Save a CEO report for the owner's Office (markdown). Use it for the daily report.",
				parameters: Type.Object({
					title: Type.String({ description: "short, e.g. 'Oct 19: M2 merged, one false alarm'" }),
					markdown: Type.String(),
					goalIds: Type.Optional(Type.Array(Type.String(), { description: "goals the report talks about" })),
				}),
				execute: async (args, api, ctx) => {
					if (api.conversationId !== deps.rootId() && api.conversationId !== deps.jobsId?.()) throw new Error("only the agent's own conversation writes reports");
					await api.commit(async (tx) => {
						const doc = await tx.doc(Reports, deps.rootId());
						doc.reports.unshift({ id: `rep-${randomUUID().slice(0, 6)}`, at: new Date().toISOString(), title: args.title, markdown: args.markdown.slice(0, 20_000), goalIds: args.goalIds ?? [] });
						if (doc.reports.length > KEEP_REPORTS) doc.reports.length = KEEP_REPORTS;
					}, ctx);
					return { output: [{ type: "text" as const, text: "Saved to the Office." }] };
				},
			}),
		],
	});
}

// Workflows as data (issue #8, docs/workflows.md). A workflow is a versioned list of built-in stage kinds; the
// orchestrator looks every stage transition up in the goal's workflow instead of hard-coding it. Step (a): only the
// default workflow exists, and it reproduces the pipeline exactly. Its env-controlled values are kept as "config" and
// "project" and resolved live, so AUTO_APPROVE_PLANS, MERGE_VETO_MINUTES, OBSERVE_MINUTES and each project's merge mode
// behave as before.
//
// Invariants live here, in code (a protected path), not in workflow data: a workflow that merges into the agent's own
// repo always gets an independent review, the gate and an observation window, whatever its stages say.
import { type ConversationId, defineDoc, type Tx } from "@earendil-works/pi-durable";
import { config } from "./config.ts";

export type Stage =
	| { kind: "plan" }
	| { kind: "approve"; by: "owner" | "auto" | "config" }
	| { kind: "code"; maxAttempts: number; verify: "project" | "none" }
	| { kind: "review"; maxRounds: number }
	| { kind: "gate" }
	| { kind: "veto"; minutes: number | "project" }
	| { kind: "merge"; mode: "agent" | "owner" | "project" }
	| { kind: "observe"; minutes: number | "config" };
export type StageKind = Stage["kind"];

export type Workflow = {
	id: string;
	version: number;
	title: string;
	description: string;
	stages: Stage[];
	status: "draft" | "approved" | "retired";
};

/** Today's pipeline, as data. */
export const DEFAULT_WORKFLOW: Workflow = {
	id: "default",
	version: 1,
	title: "Software factory",
	description: "Plan, code in containers with proofs, independent review, gate, veto window, merge, observe production.",
	status: "approved",
	stages: [
		{ kind: "plan" },
		{ kind: "approve", by: "config" },
		{ kind: "code", maxAttempts: 3, verify: "project" },
		{ kind: "review", maxRounds: 3 },
		{ kind: "gate" },
		{ kind: "veto", minutes: "project" },
		{ kind: "merge", mode: "project" },
		{ kind: "observe", minutes: "config" },
	],
};

export const Workflows = defineDoc<{ workflows: Workflow[] }>({
	kind: "app.workflows",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ workflows: [] }),
});

/** Seeds the default workflow once. Versions are immutable once used, so an existing default is left alone. */
export async function ensureDefaultWorkflow(tx: Tx, rootId: ConversationId): Promise<void> {
	const doc = await tx.doc(Workflows, rootId);
	if (!doc.workflows.some((w) => w.id === DEFAULT_WORKFLOW.id && w.version === DEFAULT_WORKFLOW.version)) doc.workflows.push(structuredClone(DEFAULT_WORKFLOW));
}

/** The canonical order stages are inserted in when an invariant adds one. */
const ORDER: StageKind[] = ["plan", "approve", "code", "review", "gate", "veto", "merge", "observe"];

/**
 * The stages a goal actually runs: its workflow's, plus whatever the invariants require. For the agent's own repo, a
 * workflow that merges always includes review, gate and observe (with defaults if the workflow left them out).
 */
export function effectiveStages(workflow: Workflow, isSelfRepo: boolean): Stage[] {
	const stages = structuredClone(workflow.stages);
	if (isSelfRepo && stages.some((s) => s.kind === "merge")) {
		const required: Stage[] = [{ kind: "review", maxRounds: 3 }, { kind: "gate" }, { kind: "observe", minutes: "config" }];
		for (const stage of required) {
			if (stages.some((s) => s.kind === stage.kind)) continue;
			const at = stages.findIndex((s) => ORDER.indexOf(s.kind) > ORDER.indexOf(stage.kind));
			stages.splice(at === -1 ? stages.length : at, 0, stage);
		}
	}
	return stages;
}

/** The stage that follows the first stage of `kind`, or undefined when the workflow ends there. */
export function nextStage(stages: Stage[], kind: StageKind): Stage | undefined {
	const at = stages.findIndex((s) => s.kind === kind);
	return at === -1 ? undefined : stages[at + 1];
}

export const findStage = <K extends StageKind>(stages: Stage[], kind: K) => stages.find((s): s is Extract<Stage, { kind: K }> => s.kind === kind);

/** Whether a plan starts without the owner's code. No approve stage at all means it starts at once. */
export function approvedAutomatically(stages: Stage[]): boolean {
	const approve = findStage(stages, "approve");
	if (!approve) return true;
	return approve.by === "config" ? config.autoApprovePlans : approve.by === "auto";
}

/**
 * How a goal that passed the gate is merged: by the owner, or by the agent after a veto window (0 = at once). "project"
 * resolves the project's merge mode, which is what the pipeline did before workflows: owner → the owner merges;
 * veto → MERGE_VETO_MINUTES; agent → at once.
 */
export function mergePlan(stages: Stage[], projectMerge: "owner" | "veto" | "agent"): { by: "owner" } | { by: "agent"; vetoMinutes: number } {
	const merge = findStage(stages, "merge");
	const veto = findStage(stages, "veto");
	const mode = !merge ? "owner" : merge.mode === "project" ? (projectMerge === "owner" ? "owner" : "agent") : merge.mode;
	if (mode === "owner") return { by: "owner" };
	const minutes = !veto ? 0 : veto.minutes === "project" ? (projectMerge === "veto" ? config.vetoMinutes : 0) : veto.minutes;
	return { by: "agent", vetoMinutes: minutes };
}

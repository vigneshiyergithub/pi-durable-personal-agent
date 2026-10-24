// Run with: node scripts/scorecards.test.ts. The fixture is worked out by hand; every expected value below has its arithmetic in a comment.
import assert from "node:assert/strict";
import type { ConversationId } from "@earendil-works/pi-durable";
import { scorecards } from "../src/scorecards.ts";
import type { Attempt, Evidence, Goal, OrchestraState, Review, Task, TaskStatus } from "../src/orchestra.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
/** Rounds a rate to 6 places so the expected values stay readable. */
const r = (n: number | null) => (n === null ? null : Math.round(n * 1e6) / 1e6);

type AttemptSpec = {
	n: number;
	model?: string;
	decision?: "accept" | "revise" | "escalate";
	/** Days ago it finished. Omit for an attempt still running. */
	finishedAgo?: number;
	costUsd?: number;
	durationMs?: number;
	report?: boolean;
	/** One entry per proof: its exit code. */
	proofs?: number[];
};

function attempt(spec: AttemptSpec): Attempt & { model?: string } {
	const finished = spec.finishedAgo !== undefined;
	const evidence: Evidence | undefined = finished
		? {
				report: spec.report
					? { status: "done", summary: "", changes: [], tests: [], risks: [], questions: [] }
					: undefined,
				commits: [],
				diffStat: "",
				diff: "",
				diffTruncated: false,
				costUsd: spec.costUsd,
				durationMs: spec.durationMs ?? 0,
				proofs: spec.proofs?.map((exitCode) => ({
					criterion: "c",
					command: "npm test",
					expect: "exit 0",
					exitCode,
					output: "",
					timedOut: false,
				})),
			}
		: undefined;
	return {
		n: spec.n,
		model: spec.model,
		coder: "opencode",
		claimedAt: ago(0),
		heartbeatAt: ago(0),
		finishedAt: finished ? ago(spec.finishedAgo ?? 0) : undefined,
		evidence,
		verdict: spec.decision ? { decision: spec.decision, feedback: "", at: ago(spec.finishedAgo ?? 0) } : undefined,
	};
}

function task(id: string, status: TaskStatus, attempts: Attempt[]): Task {
	return { id, title: id, instructions: "", acceptance: [], coder: "opencode", status, maxAttempts: 3, attempts };
}

function review(model: string, round: number, status: Review["status"], findings?: Review["findings"]): Review {
	return { status, round, model, findings };
}

function goal(
	id: string,
	projectId: string,
	updatedDaysAgo: number,
	tasks: Task[],
	extra: Partial<Goal> = {},
): Goal {
	return {
		id,
		projectId,
		title: id,
		description: "",
		acceptance: [],
		status: "done",
		branch: `goal/${id}`,
		foremanId: "foreman" as unknown as ConversationId,
		tasks,
		createdAt: ago(updatedDaysAgo + 1),
		updatedAt: ago(updatedDaysAgo),
		createdBy: id,
		...extra,
	};
}

const state: OrchestraState = {
	projects: [
		{ id: "alpha", repo: "owner/alpha", base: "main", merge: "owner", description: "", createdAt: ago(100) },
		{ id: "beta", repo: "owner/beta", base: "main", merge: "veto", description: "", createdAt: ago(100) },
	],
	events: [],
	goals: [
		// alpha, 1 day ago. A1 is accepted first try; A2 is accepted on attempt 3 after two revisions, and its second
		// attempt has no report. Proofs: A1 has 1 pass; A2's last attempt has 1 pass and 1 fail. Reviewed twice.
		goal(
			"g1",
			"alpha",
			1,
			[
				task("A1", "accepted", [
					attempt({ n: 1, model: "m1", decision: "accept", finishedAgo: 1, costUsd: 0.1, durationMs: 60_000, report: true, proofs: [0] }),
				]),
				task("A2", "accepted", [
					attempt({ n: 1, model: "m1", decision: "revise", finishedAgo: 2, costUsd: 0.2, durationMs: 120_000, report: true }),
					attempt({ n: 2, model: "m1", decision: "revise", finishedAgo: 2, costUsd: 0.2, durationMs: 180_000, report: false }),
					attempt({ n: 3, model: "m1", decision: "accept", finishedAgo: 1, costUsd: 0.3, durationMs: 240_000, report: true, proofs: [0, 1] }),
				]),
			],
			{
				review: review("rev-a", 2, "approved", [
					{ severity: "blocker", note: "x" },
					{ severity: "major", note: "x" },
					{ severity: "minor", note: "x" },
				]),
				merge: { pr: 1, url: "", status: "merged" },
			},
		),
		// alpha, 2 days ago. E1 escalates on its only finished attempt; R1 is still running, so it counts nowhere.
		goal("g2", "alpha", 2, [
			task("E1", "escalated", [
				attempt({ n: 1, model: "m2", decision: "escalate", finishedAgo: 3, costUsd: 0.05, durationMs: 60_000, report: true }),
			]),
			task("R1", "running", [attempt({ n: 1, model: "m2" })]),
		]),
		// beta, 5 days ago. B1 is accepted first try. Approved by rev-b, then vetoed.
		goal(
			"g3",
			"beta",
			5,
			[
				task("B1", "accepted", [
					attempt({ n: 1, model: "m2", decision: "accept", finishedAgo: 5, costUsd: 0.4, durationMs: 120_000, report: true }),
				]),
			],
			{ review: review("rev-b", 1, "approved"), merge: { pr: 3, url: "", status: "vetoed" } },
		),
		// beta, 2 days ago. No tasks. rev-b sent it back with one major finding.
		goal("g5", "beta", 2, [], {
			review: review("rev-b", 1, "changes_requested", [{ severity: "major", note: "x" }]),
		}),
		// beta, 10 days ago: outside 7d, inside 30d and all.
		goal("g4", "beta", 10, [
			task("O1", "accepted", [
				attempt({ n: 1, model: "m1", decision: "accept", finishedAgo: 10, costUsd: 0.5, durationMs: 30_000, report: true }),
			]),
		]),
		// alpha, 60 days ago: only in all.
		goal("g6", "alpha", 60, [
			task("X1", "accepted", [
				attempt({ n: 1, model: "m1", decision: "accept", finishedAgo: 60, costUsd: 0.25, durationMs: 60_000, report: true }),
			]),
		]),
	],
};

const s = scorecards(state, NOW);
const total = (w: "7d" | "30d" | "all") => s.windows[w].total;
const project = (w: "7d" | "30d" | "all", p: string) => s.windows[w].byProject[p];

// ---- 7d: goals g1, g2, g3, g5; attempts A1, A2 (x3), E1, B1 ----
const t7 = total("7d");
// m1: 4 finished attempts. Tasks A1 (first try, accepted) and A2 (not first try, accepted). 1/2 = 0.5.
// attempts per accepted task: (1 + 3) / 2 = 2. Missing reports: 1/4. Proofs 2 pass of 3. Cost: (0.1 + 0.7) / 2 = 0.4.
// Durations 1, 2, 3, 4 min: median 2.5.
assert.equal(t7.coder.m1.attempts, 4);
assert.equal(r(t7.coder.m1.firstAttemptAcceptance), 0.5);
assert.equal(t7.coder.m1.attemptsPerAcceptedTask, 2);
assert.equal(r(t7.coder.m1.missingReportRate), 0.25);
assert.equal(r(t7.coder.m1.proofPassRate), 0.666667);
assert.equal(r(t7.coder.m1.costPerAcceptedTask), 0.4);
assert.equal(t7.coder.m1.medianDurationMin, 2.5);
// m2: attempts E1 and B1. First try: B1 accepted, E1 escalated: 1/2. Accepted: B1 only, 1 attempt, cost 0.4.
// No proofs, so null. Durations 1 and 2 min: median 1.5.
assert.equal(t7.coder.m2.attempts, 2);
assert.equal(t7.coder.m2.firstAttemptAcceptance, 0.5);
assert.equal(t7.coder.m2.attemptsPerAcceptedTask, 1);
assert.equal(t7.coder.m2.missingReportRate, 0);
assert.equal(t7.coder.m2.proofPassRate, null);
assert.equal(r(t7.coder.m2.costPerAcceptedTask), 0.4);
assert.equal(t7.coder.m2.medianDurationMin, 1.5);
// Foreman: 6 verdicts (A1 accept, A2 revise x2 and accept, E1 escalate, B1 accept). Escalate 1/6, revise 2/6.
// Reviewed goals: g1, g3, g5. Overruled (round > 1): g1, so 1/3.
assert.equal(t7.foreman.verdicts, 6);
assert.equal(r(t7.foreman.escalationRate), 0.166667);
assert.equal(r(t7.foreman.reviseRate), 0.333333);
assert.equal(r(t7.foreman.acceptsOverruledByReviewer), 0.333333);
// rev-a: g1 only. rev-b: g3 (approved, vetoed) and g5 (changes requested).
assert.deepEqual(t7.reviewer["rev-a"], {
	goalsReviewed: 1,
	rounds: 2,
	approvals: 1,
	changesRequested: 0,
	findings: { blocker: 1, major: 1, minor: 1 },
	approvedButVetoedOrBlocked: 0,
});
assert.deepEqual(t7.reviewer["rev-b"], {
	goalsReviewed: 2,
	rounds: 2,
	approvals: 1,
	changesRequested: 1,
	findings: { blocker: 0, major: 1, minor: 0 },
	approvedButVetoedOrBlocked: 1,
});
assert.equal(t7.coder.m3, undefined);

// 7d, alpha: E1 is alpha's only m2 attempt, and it is not accepted, so every accepted-task metric is null.
const a7 = project("7d", "alpha");
assert.equal(a7.coder.m2.attempts, 1);
assert.equal(a7.coder.m2.firstAttemptAcceptance, 0);
assert.equal(a7.coder.m2.attemptsPerAcceptedTask, null);
assert.equal(a7.coder.m2.costPerAcceptedTask, null);
assert.equal(a7.coder.m2.proofPassRate, null);
assert.equal(a7.coder.m2.medianDurationMin, 1);
assert.equal(a7.coder.m1.attempts, 4);
assert.equal(r(a7.foreman.escalationRate), 0.2);
assert.equal(r(a7.foreman.reviseRate), 0.4);
assert.equal(a7.foreman.acceptsOverruledByReviewer, 1);
assert.equal(a7.reviewer["rev-b"], undefined);

// 7d, beta: only B1 (m2) is in the window; g3 and g5 are reviewed, none overruled.
const b7 = project("7d", "beta");
assert.deepEqual(Object.keys(b7.coder), ["m2"]);
assert.equal(b7.coder.m2.attempts, 1);
assert.equal(b7.coder.m2.firstAttemptAcceptance, 1);
assert.equal(r(b7.coder.m2.costPerAcceptedTask), 0.4);
assert.equal(b7.foreman.verdicts, 1);
assert.equal(b7.foreman.escalationRate, 0);
assert.equal(b7.foreman.reviseRate, 0);
assert.equal(b7.foreman.acceptsOverruledByReviewer, 0);
assert.equal(b7.reviewer["rev-b"].goalsReviewed, 2);

// ---- 30d: adds O1 (m1, beta, 10 days ago) and g4 ----
const t30 = total("30d");
// m1: 5 attempts. Tasks A1, A2, O1: first try accepted A1 and O1, so 2/3. Attempts per accepted: (1 + 3 + 1) / 3 = 5/3.
// Missing reports 1/5. Cost: (0.1 + 0.7 + 0.5) / 3 = 0.4333. Durations 0.5, 1, 2, 3, 4 min: median 2.
assert.equal(t30.coder.m1.attempts, 5);
assert.equal(r(t30.coder.m1.firstAttemptAcceptance), 0.666667);
assert.equal(r(t30.coder.m1.attemptsPerAcceptedTask), 1.666667);
assert.equal(r(t30.coder.m1.missingReportRate), 0.2);
assert.equal(r(t30.coder.m1.proofPassRate), 0.666667);
assert.equal(r(t30.coder.m1.costPerAcceptedTask), 0.433333);
assert.equal(t30.coder.m1.medianDurationMin, 2);
// Foreman: 7 verdicts; escalate 1/7; revise 2/7; overruled still 1 of 3 reviewed goals.
assert.equal(t30.foreman.verdicts, 7);
assert.equal(r(t30.foreman.escalationRate), 0.142857);
assert.equal(r(t30.foreman.reviseRate), 0.285714);
assert.equal(r(t30.foreman.acceptsOverruledByReviewer), 0.333333);
// beta, 30d: B1 and O1, no revisions or escalations, and no goals overruled.
const b30 = project("30d", "beta");
assert.equal(b30.coder.m1.attempts, 1);
assert.equal(r(b30.coder.m1.costPerAcceptedTask), 0.5);
assert.equal(b30.coder.m1.medianDurationMin, 0.5);
assert.equal(b30.foreman.verdicts, 2);
assert.equal(b30.foreman.acceptsOverruledByReviewer, 0);

// ---- all: adds X1 (m1, alpha, 60 days ago) and g6 ----
const tAll = total("all");
// m1: 6 attempts. Tasks A1, A2, O1, X1: first try accepted A1, O1, X1 of 4, so 0.75.
// Attempts per accepted: 6 / 4 = 1.5. Missing reports 1/6. Cost: (0.1 + 0.7 + 0.5 + 0.25) / 4 = 0.3875.
// Durations 0.5, 1, 1, 2, 3, 4 min: median 1.5.
assert.equal(tAll.coder.m1.attempts, 6);
assert.equal(r(tAll.coder.m1.firstAttemptAcceptance), 0.75);
assert.equal(tAll.coder.m1.attemptsPerAcceptedTask, 1.5);
assert.equal(r(tAll.coder.m1.missingReportRate), 0.166667);
assert.equal(r(tAll.coder.m1.costPerAcceptedTask), 0.3875);
assert.equal(tAll.coder.m1.medianDurationMin, 1.5);
// Foreman: 8 verdicts; escalate 1/8; revise 2/8; overruled 1 of 3 reviewed goals.
assert.equal(tAll.foreman.verdicts, 8);
assert.equal(tAll.foreman.escalationRate, 0.125);
assert.equal(tAll.foreman.reviseRate, 0.25);
assert.equal(r(tAll.foreman.acceptsOverruledByReviewer), 0.333333);
// alpha, all: 6 verdicts; escalate 1/6, revise 2/6.
assert.equal(r(project("all", "alpha").foreman.escalationRate), 0.166667);
assert.equal(project("all", "alpha").coder.m1.attempts, 5);

// ---- empty state: every rate null, nothing NaN ----
const empty = scorecards({ goals: [], projects: [], events: [] }, NOW);
for (const w of ["7d", "30d", "all"] as const) {
	const board = empty.windows[w].total;
	assert.deepEqual(board.coder, {});
	assert.deepEqual(board.reviewer, {});
	assert.equal(board.foreman.verdicts, 0);
	assert.equal(board.foreman.escalationRate, null);
	assert.equal(board.foreman.reviseRate, null);
	assert.equal(board.foreman.acceptsOverruledByReviewer, null);
}

console.log("✓ scorecards: windows, projects, coder, foreman, reviewer and null rates match the hand-worked fixture");

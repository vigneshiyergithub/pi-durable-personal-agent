// Scorecards (issue #7): advisory numbers computed from OrchestraState on demand. Nothing is stored, nothing is decided
// from them. Attempts fall in a window by finishedAt, goals by updatedAt. Rates are 0..1, or null when the denominator is 0.
import type { Attempt, Evidence, Goal, OrchestraState } from "./orchestra.ts";

export type Window = "7d" | "30d" | "all";
export const WINDOWS: readonly Window[] = ["7d", "30d", "all"];
type Severity = "blocker" | "major" | "minor";

export type CoderScore = {
	/** Finished attempts in the window. */
	attempts: number;
	/** Of tasks accepted or escalated with a finished attempt in the window: the share accepted on attempt 1. */
	firstAttemptAcceptance: number | null;
	/** Mean attempts per accepted task (all of the task's attempts). */
	attemptsPerAcceptedTask: number | null;
	/** Finished attempts with no evidence.report, over finished attempts. */
	missingReportRate: number | null;
	/** Proofs with exitCode 0, over all proofs of finished attempts. */
	proofPassRate: number | null;
	/** Summed evidence.costUsd over every attempt of accepted tasks, divided by accepted tasks. */
	costPerAcceptedTask: number | null;
	medianDurationMin: number | null;
};

export type ForemanScore = {
	verdicts: number;
	escalationRate: number | null;
	reviseRate: number | null;
	/** Reviewed goals with review.round > 1, over reviewed goals. */
	acceptsOverruledByReviewer: number | null;
};

export type ReviewerScore = {
	goalsReviewed: number;
	rounds: number;
	/** Goals whose latest review is approved. */
	approvals: number;
	/** Goals whose latest review requested changes. */
	changesRequested: number;
	findings: Record<Severity, number>;
	approvedButVetoedOrBlocked: number;
};

export type ScoreBoard = {
	/** Coder metrics keyed by attempt model ("unknown" when the attempt does not name one). */
	coder: Record<string, CoderScore>;
	foreman: ForemanScore;
	/** Reviewer metrics keyed by review.model. */
	reviewer: Record<string, ReviewerScore>;
};

export type Scorecards = {
	generatedAt: string;
	windows: Record<Window, { total: ScoreBoard; byProject: Record<string, ScoreBoard> }>;
};

/** An attempt as scorecards read it: `model` is the coder's model id, once the orchestrator records it. */
type ScoredAttempt = Attempt & { model?: string };
type FinishedAttempt = ScoredAttempt & { finishedAt: string; evidence: Evidence };

const DAY_MS = 86_400_000;
const WINDOW_MS: Record<Exclude<Window, "all">, number> = { "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

/** Attempts that ran to an outcome. An unavailable coder never ran, so it is not an attempt. */
const isFinished = (attempt: ScoredAttempt): attempt is FinishedAttempt =>
	attempt.finishedAt !== undefined && attempt.evidence !== undefined && attempt.evidence.coderUnavailable === undefined;

function inWindow(at: string, window: Window, now: number): boolean {
	return window === "all" || Date.parse(at) >= now - WINDOW_MS[window];
}

/** A share from 0 to 1, or null when there is nothing to divide by. */
function ratio(part: number, whole: number): number | null {
	return whole === 0 ? null : part / whole;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length / 2;
	return sorted.length % 2 ? sorted[Math.floor(mid)] : (sorted[mid - 1] + sorted[mid]) / 2;
}

type CoderAcc = {
	attempts: number;
	missingReport: number;
	proofs: number;
	proofsPassed: number;
	durationsMs: number[];
	taskFirstTries: number;
	taskFirstAccepted: number;
	accepted: number;
	acceptedAttempts: number;
	acceptedCostUsd: number;
};

type ReviewerAcc = Omit<ReviewerScore, "findings"> & { findings: Record<Severity, number> };

function emptyCoder(): CoderAcc {
	return {
		attempts: 0,
		missingReport: 0,
		proofs: 0,
		proofsPassed: 0,
		durationsMs: [],
		taskFirstTries: 0,
		taskFirstAccepted: 0,
		accepted: 0,
		acceptedAttempts: 0,
		acceptedCostUsd: 0,
	};
}

function emptyReviewer(): ReviewerAcc {
	return {
		goalsReviewed: 0,
		rounds: 0,
		approvals: 0,
		changesRequested: 0,
		findings: { blocker: 0, major: 0, minor: 0 },
		approvedButVetoedOrBlocked: 0,
	};
}

/** One window's numbers for a set of goals (already filtered to one project, or all of them). */
function scoreBoard(goals: Goal[], window: Window, now: number): ScoreBoard {
	const coder = new Map<string, CoderAcc>();
	const reviewer = new Map<string, ReviewerAcc>();
	const foreman = { verdicts: 0, escalate: 0, revise: 0, reviewed: 0, overruled: 0 };
	const coderFor = (model: string) => {
		let acc = coder.get(model);
		if (!acc) coder.set(model, (acc = emptyCoder()));
		return acc;
	};

	for (const goal of goals) {
		for (const task of goal.tasks) {
			if (task.kind === "holdout") continue; // the orchestrator's own holdout runs: no coder, no foreman verdict
			const attempts: ScoredAttempt[] = task.attempts;
			const finished = attempts.filter(isFinished);
			const finishedInWindow = finished.filter((a) => inWindow(a.finishedAt, window, now));
			for (const attempt of finishedInWindow) {
				const acc = coderFor(attempt.model ?? "unknown");
				acc.attempts++;
				if (attempt.evidence.report === undefined) acc.missingReport++;
				for (const proof of attempt.evidence.proofs ?? []) {
					acc.proofs++;
					if (proof.exitCode === 0) acc.proofsPassed++;
				}
				acc.durationsMs.push(attempt.evidence.durationMs);
				if (attempt.verdict) {
					foreman.verdicts++;
					if (attempt.verdict.decision === "escalate") foreman.escalate++;
					if (attempt.verdict.decision === "revise") foreman.revise++;
				}
			}

			// A task belongs to the window when it has a finished attempt in it, and to the model of its last finished attempt.
			if (finishedInWindow.length === 0) continue;
			const last = finished.reduce((a, b) => (b.n > a.n ? b : a));
			const acc = coderFor(last.model ?? "unknown");
			if (task.status === "accepted" || task.status === "escalated") {
				acc.taskFirstTries++;
				if (attempts.find((a) => !a.unbudgeted)?.verdict?.decision === "accept") acc.taskFirstAccepted++;
			}
			if (task.status === "accepted") {
				acc.accepted++;
				acc.acceptedAttempts += attempts.length;
				acc.acceptedCostUsd += attempts.reduce((sum, a) => sum + (a.evidence?.costUsd ?? 0), 0);
			}
		}

		if (!goal.review || !inWindow(goal.updatedAt, window, now)) continue;
		const review = goal.review;
		if (review.status !== "approved" && review.status !== "changes_requested") continue;
		foreman.reviewed++;
		if (review.round > 1) foreman.overruled++;

		let acc = reviewer.get(review.model);
		if (!acc) reviewer.set(review.model, (acc = emptyReviewer()));
		acc.goalsReviewed++;
		acc.rounds += review.round;
		if (review.status === "approved") acc.approvals++;
		else acc.changesRequested++;
		for (const finding of review.findings ?? []) acc.findings[finding.severity]++;
		if (review.status === "approved" && (goal.merge?.status === "vetoed" || goal.merge?.status === "blocked")) {
			acc.approvedButVetoedOrBlocked++;
		}
	}

	return {
		coder: Object.fromEntries(
			[...coder].map(([model, acc]) => {
				const medianMs = median(acc.durationsMs);
				const score: CoderScore = {
					attempts: acc.attempts,
					firstAttemptAcceptance: ratio(acc.taskFirstAccepted, acc.taskFirstTries),
					attemptsPerAcceptedTask: ratio(acc.acceptedAttempts, acc.accepted),
					missingReportRate: ratio(acc.missingReport, acc.attempts),
					proofPassRate: ratio(acc.proofsPassed, acc.proofs),
					costPerAcceptedTask: ratio(acc.acceptedCostUsd, acc.accepted),
					medianDurationMin: medianMs === null ? null : medianMs / 60_000,
				};
				return [model, score];
			}),
		),
		foreman: {
			verdicts: foreman.verdicts,
			escalationRate: ratio(foreman.escalate, foreman.verdicts),
			reviseRate: ratio(foreman.revise, foreman.verdicts),
			acceptsOverruledByReviewer: ratio(foreman.overruled, foreman.reviewed),
		},
		reviewer: Object.fromEntries(reviewer),
	};
}

export function scorecards(state: OrchestraState, now = Date.now()): Scorecards {
	const projectIds = new Set<string>(state.projects.map((project) => project.id));
	for (const goal of state.goals) projectIds.add(goal.projectId);

	const windows = {} as Scorecards["windows"];
	for (const window of WINDOWS) {
		const byProject: Record<string, ScoreBoard> = {};
		for (const projectId of projectIds) {
			byProject[projectId] = scoreBoard(
				state.goals.filter((goal) => goal.projectId === projectId),
				window,
				now,
			);
		}
		windows[window] = { total: scoreBoard(state.goals, window, now), byProject };
	}
	return { generatedAt: new Date(now).toISOString(), windows };
}

/** A number that got clearly worse in the last 7 days than over 30 days, with a suggested change for the owner. */
export type Trend = { metric: string; subject: string; recent: number; baseline: number; suggestion: string };

/** Fewest finished attempts (per coder model) or reviewed goals in the 7-day window before a trend counts. */
const MIN_RECENT_ATTEMPTS = 5;
const MIN_RECENT_REVIEWS = 3;

/**
 * The numbers that got clearly worse in `recent` (7d) than in `baseline` (30d): first-attempt acceptance or proof pass
 * rate down 15 points, cost per accepted task up 50% (and at least $0.10), or half a review round more per goal. Too
 * few recent attempts or reviews count as no trend. Advisory: the reflector tells the owner; nothing changes by itself.
 */
export function scorecardTrends(recent: ScoreBoard | undefined, baseline: ScoreBoard | undefined): Trend[] {
	const trends: Trend[] = [];
	if (!recent || !baseline) return trends; // a project with no goals yet
	for (const [model, now] of Object.entries(recent.coder)) {
		const before = baseline.coder[model];
		if (!before || now.attempts < MIN_RECENT_ATTEMPTS) continue;
		const drop = (a: number | null, b: number | null) => a !== null && b !== null && b - a >= 0.15;
		if (drop(now.firstAttemptAcceptance, before.firstAttemptAcceptance)) {
			trends.push({ metric: "first-attempt acceptance", subject: model, recent: now.firstAttemptAcceptance!, baseline: before.firstAttemptAcceptance!, suggestion: "look at the recent escalations; ask the foreman for smaller tasks, or try a different CODER_MODEL" });
		}
		if (drop(now.proofPassRate, before.proofPassRate)) {
			trends.push({ metric: "proof pass rate", subject: model, recent: now.proofPassRate!, baseline: before.proofPassRate!, suggestion: "check whether the failing proofs are flaky or genuine; if genuine, try a different CODER_MODEL" });
		}
		const cost = now.costPerAcceptedTask;
		const costBefore = before.costPerAcceptedTask;
		if (cost !== null && costBefore !== null && cost >= costBefore * 1.5 && cost - costBefore >= 0.1) {
			trends.push({ metric: "cost per accepted task", subject: model, recent: cost, baseline: costBefore, suggestion: "consider a cheaper CODER_MODEL or a lower ATTEMPT_BUDGET_USD, or ask the foreman for smaller tasks" });
		}
	}
	const rounds = (board: ScoreBoard) => {
		const reviews = Object.values(board.reviewer);
		const goals = reviews.reduce((n, r) => n + r.goalsReviewed, 0);
		return { goals, perGoal: goals ? reviews.reduce((n, r) => n + r.rounds, 0) / goals : null };
	};
	const now = rounds(recent);
	const before = rounds(baseline);
	if (now.goals >= MIN_RECENT_REVIEWS && now.perGoal !== null && before.perGoal !== null && now.perGoal - before.perGoal >= 0.5) {
		trends.push({ metric: "review rounds per goal", subject: "all reviewers", recent: now.perGoal, baseline: before.perGoal, suggestion: "the foreman may be accepting weak evidence; consider a stronger FOREMAN_MODEL" });
	}
	return trends;
}

/** One owner message for all the worsened numbers, or undefined when nothing got clearly worse. */
export function scorecardNotice(trends: Trend[]): string | undefined {
	if (!trends.length) return undefined;
	const show = (t: Trend, n: number) => (t.metric.startsWith("cost") ? `$${n.toFixed(2)}` : t.metric.startsWith("review") ? n.toFixed(1) : `${Math.round(n * 100)}%`);
	return `📉 Factory scorecards got worse this week:\n${trends.map((t) => `- ${t.metric} (${t.subject}): ${show(t, t.recent)} over 7 days vs ${show(t, t.baseline)} over 30 days. Suggestion: ${t.suggestion}.`).join("\n")}\nAdvisory only: nothing was changed.`;
}

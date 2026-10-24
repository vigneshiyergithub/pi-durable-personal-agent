// The reflector's scorecard step: a clearly worse 7-day number produces one owner notice; a stable board produces none.
//
// scorecardTrends/scorecardNotice (src/scorecards.ts) are what the `scorecards` tool returns as `worse` and `notice`;
// the reflector is told to notify the owner with `notice` once when it is present, and to stay silent otherwise.
//
// Run with: node --test scripts/scorecard-trends.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import { scorecardNotice, scorecardTrends, type CoderScore, type ScoreBoard } from "../src/scorecards.ts";

const coder = (over: Partial<CoderScore> = {}): CoderScore => ({
	attempts: 10,
	firstAttemptAcceptance: 0.8,
	attemptsPerAcceptedTask: 1.2,
	missingReportRate: 0,
	proofPassRate: 0.9,
	costPerAcceptedTask: 0.5,
	medianDurationMin: 12,
	...over,
});
const board = (score: CoderScore, rounds = 4, goalsReviewed = 4): ScoreBoard => ({
	coder: { "kimi-k2.7-code": score },
	foreman: { verdicts: 10, escalationRate: 0, reviseRate: 0.1, acceptsOverruledByReviewer: 0 },
	reviewer: { "glm-5.3": { goalsReviewed, rounds, approvals: goalsReviewed, changesRequested: 0, findings: { blocker: 0, major: 0, minor: 0 }, approvedButVetoedOrBlocked: 0 } },
});

/** What one reflection sends the owner about the scorecards. */
const notificationsFor = (recent: ScoreBoard, baseline: ScoreBoard) => [scorecardNotice(scorecardTrends(recent, baseline))].filter(Boolean) as string[];

it("a worsening scorecard produces one owner notification naming every worse number", () => {
	const sent = notificationsFor(board(coder({ firstAttemptAcceptance: 0.5, proofPassRate: 0.6, costPerAcceptedTask: 1.2 }), 8, 4), board(coder(), 4, 4));
	assert.equal(sent.length, 1);
	assert.match(sent[0]!, /first-attempt acceptance \(kimi-k2\.7-code\): 50% over 7 days vs 80% over 30 days/);
	assert.match(sent[0]!, /proof pass rate .*60% .*90%/);
	assert.match(sent[0]!, /cost per accepted task .*\$1\.20 .*\$0\.50/);
	assert.match(sent[0]!, /review rounds per goal .*2\.0 .*1\.0/);
	assert.match(sent[0]!, /Suggestion: /);
	assert.match(sent[0]!, /Advisory only/);
});

it("a stable scorecard produces none", () => {
	assert.deepEqual(notificationsFor(board(coder()), board(coder())), []);
	// Small wobbles below the thresholds are not "clearly worse".
	assert.deepEqual(notificationsFor(board(coder({ firstAttemptAcceptance: 0.7, proofPassRate: 0.8, costPerAcceptedTask: 0.7 }), 5, 4), board(coder(), 4, 4)), []);
});

it("ignores a 7-day window with too few attempts or reviews to judge", () => {
	assert.deepEqual(notificationsFor(board(coder({ attempts: 2, firstAttemptAcceptance: 0 }), 6, 2), board(coder(), 2, 2)), []);
});

it("a project with no goals has no trend", () => {
	assert.deepEqual(scorecardTrends(undefined, undefined), []);
});

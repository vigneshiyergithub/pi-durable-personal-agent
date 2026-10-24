// The merge gate's "holdouts" check, and how a failing holdout's output is shown to the foreman.
//
// Drives the real gate() (src/orchestra.ts) with stubs only for GitHub and the workflow snapshot, like
// scripts/orchestra-protected-paths.test.ts. The end-to-end flow (examiner, holdout run, foreman feedback) is in
// scripts/smoke.ts.
//
// Run with: node --test scripts/orchestra-holdouts.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Agent } from "../src/agent.ts";
import { hideCommand, Orchestrator, type GateCheck, type Goal, type Holdouts, type OrchestraClients, type Project } from "../src/orchestra.ts";

const HEAD = "abc1234";

/** The real "holdouts" gate check for a goal whose code passes its proofs, with these holdouts. */
async function holdoutsCheck(holdouts: Holdouts | undefined): Promise<GateCheck> {
	const github = { pullRequest: async () => ({ headSha: HEAD, state: "open" as const, merged: false, mergeable: true }) };
	const clients = { railway: {}, keys: {}, github } as unknown as OrchestraClients;
	const agent = { root: { id: "holdouts-suite" }, harness: { snapshot: async () => undefined } } as unknown as Agent;
	const orchestrator = new Orchestrator(agent, clients);
	const task = {
		id: "task-1",
		title: "Feature",
		instructions: "",
		acceptance: ["works"],
		coder: "opencode",
		status: "accepted",
		maxAttempts: 3,
		attempts: [
			{
				n: 1,
				evidence: {
					commits: [`${HEAD} add feature`],
					diffStat: "",
					diff: "",
					diffTruncated: false,
					durationMs: 1,
					pushed: HEAD,
					verify: { command: "npm test", exitCode: 0, output: "", timedOut: false },
					proofs: [{ criterionIndex: 0, criterion: "works", command: "npm test", expect: "pass", exitCode: 0, output: "", timedOut: false }],
				},
			},
		],
	};
	const goal = { id: "gate", projectId: "demo-app", title: "holdouts", description: "", acceptance: ["works"], status: "delivering", branch: "agent/holdouts", tasks: [task], holdouts, createdAt: "", updatedAt: "" } as unknown as Goal;
	const project = { id: "demo-app", repo: "owner/demo-app", base: "main", verify: "npm test", merge: "agent", description: "", createdAt: "" } as unknown as Project;
	const checks = await (orchestrator as unknown as { gate(goal: Goal, project: Project, pr: number): Promise<GateCheck[]> }).gate(goal, project, 7);
	assert.equal(checks.find((c) => c.name === "proofs")?.ok, true, "the coder's proofs pass in every case here");
	return checks.find((c) => c.name === "holdouts")!;
}

const ready = (lastRun?: Holdouts["lastRun"]): Holdouts => ({
	status: "ready",
	model: "m",
	checks: [{ criterionIndex: 0, command: "test -f done", expect: "" }],
	...(lastRun ? { lastRun } : {}),
});

it("blocks a goal whose proofs pass but whose holdout failed on the PR head", async () => {
	const check = await holdoutsCheck(ready({ headSha: HEAD, at: "", passed: false, results: [{ index: 0, exitCode: 1, output: "", timedOut: false }] }));
	assert.equal(check.ok, false);
	assert.match(check.detail, /failing/);
});

it("blocks when the holdouts passed on another commit than the PR head", async () => {
	const check = await holdoutsCheck(ready({ headSha: "0ld0ld0", at: "", passed: true, results: [] }));
	assert.equal(check.ok, false);
	assert.match(check.detail, /0ld0ld0.*abc1234/);
});

it("blocks when the holdouts never ran, or the examiner has not written or failed to write them", async () => {
	assert.equal((await holdoutsCheck(ready())).ok, false);
	assert.equal((await holdoutsCheck({ status: "running", model: "m" })).ok, false);
	assert.equal((await holdoutsCheck({ status: "failed", model: "m" })).ok, false);
});

it("passes when every holdout passed on the PR head", async () => {
	const check = await holdoutsCheck(ready({ headSha: HEAD, at: "", passed: true, results: [{ index: 0, exitCode: 0, output: "", timedOut: false }] }));
	assert.equal(check.ok, true, check.detail);
});

it("passes goals from before holdouts, and goals with nothing checkable by a command", async () => {
	assert.equal((await holdoutsCheck(undefined)).ok, true);
	assert.equal((await holdoutsCheck({ status: "ready", model: "m", checks: [], uncheckable: [{ criterionIndex: 0, reason: "taste" }] })).ok, true);
});

it("hides the command and its parts from the output the foreman sees, and truncates it", () => {
	const command = "cd app && npm test -- --grep 'csv export escapes commas' | grep -q '1 passing'";
	const output = `+ ${command}\n> npm test -- --grep 'csv export escapes commas'\n0 passing\n${"x".repeat(1000)}`;
	const shown = hideCommand(output, command);
	assert.ok(!shown.includes("csv export escapes commas"));
	assert.ok(!shown.includes("grep -q '1 passing'"));
	assert.ok(shown.length <= 400);
	assert.match(hideCommand("+ npm run check-x\n1 failing", "npm run check-x"), /\[hidden\]\n1 failing/);
});

it("a check the owner waived no longer counts: a failing run on the PR head passes, and all-waived passes", async () => {
	const failed = { headSha: HEAD, at: "", passed: false, results: [{ index: 0, exitCode: 1, output: "", timedOut: false }, { index: 1, exitCode: 0, output: "", timedOut: false }] };
	const two: Holdouts = { status: "ready", model: "m", checks: [{ criterionIndex: 0, command: "false", expect: "" }, { criterionIndex: 0, command: "true", expect: "" }], lastRun: failed };
	assert.equal((await holdoutsCheck(two)).ok, false, "check #0 fails");
	const waived = await holdoutsCheck({ ...two, waived: [{ index: 0, reason: "wrong", at: "" }] });
	assert.equal(waived.ok, true, waived.detail);
	assert.match(waived.detail, /1 passed.*1 waived/);
	const all = await holdoutsCheck({ ...two, lastRun: undefined, waived: [{ index: 0, reason: "", at: "" }, { index: 1, reason: "", at: "" }] });
	assert.equal(all.ok, true, all.detail);
});

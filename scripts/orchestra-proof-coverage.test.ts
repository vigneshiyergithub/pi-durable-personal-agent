// The merge gate's "proofs" check: every acceptance criterion of a task needs at least one passing proof.
//
// Drives the real gate() (src/orchestra.ts) the same way scripts/orchestra-protected-paths.test.ts does, with stubs
// only for GitHub and the workflow snapshot. Also checks the runner's proof cap (keepProofs in runner/task-runner.mjs)
// never drops the only proof of a criterion.
//
// Run with: node --test scripts/orchestra-proof-coverage.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Agent } from "../src/agent.ts";
import { Orchestrator, type GateCheck, type Goal, type OrchestraClients, type Project, type Proof } from "../src/orchestra.ts";
// @ts-expect-error The single-file JavaScript runner ships without TypeScript declarations.
import { keepProofs } from "../runner/task-runner.mjs";

const ACCEPTANCE = ["exports CSV", "escapes commas", "streams large reports"];

const proof = (criterionIndex: number | undefined, exitCode = 0): Proof => ({
	...(criterionIndex === undefined ? {} : { criterionIndex }),
	criterion: criterionIndex === undefined ? "legacy" : ACCEPTANCE[criterionIndex]!,
	command: `test ${criterionIndex}`,
	expect: "exit 0",
	exitCode,
	output: "",
	timedOut: false,
});

/** The real "proofs" gate check for one accepted task with commits and these proofs. */
async function proofsCheck(proofs: Proof[]): Promise<GateCheck> {
	const github = { pullRequest: async () => ({ headSha: "abc1234", state: "open" as const, merged: false, mergeable: true }) };
	const clients = { railway: {}, keys: {}, github } as unknown as OrchestraClients;
	const agent = { root: { id: "proof-coverage-suite" }, harness: { snapshot: async () => undefined } } as unknown as Agent;
	const orchestrator = new Orchestrator(agent, clients);
	const task = {
		id: "task-1",
		title: "CSV export",
		instructions: "",
		acceptance: ACCEPTANCE,
		coder: "opencode",
		status: "accepted",
		maxAttempts: 3,
		attempts: [
			{
				n: 1,
				evidence: {
					commits: ["abc1234 add export"],
					diffStat: "",
					diff: "",
					diffTruncated: false,
					durationMs: 1,
					pushed: "abc1234",
					verify: { command: "npm test", exitCode: 0, output: "", timedOut: false },
					proofs,
				},
			},
		],
	};
	const goal = { id: "gate", projectId: "demo-app", title: "coverage", description: "", acceptance: ["a"], status: "delivering", branch: "agent/coverage", tasks: [task], createdAt: "", updatedAt: "" } as unknown as Goal;
	const project = { id: "demo-app", repo: "owner/demo-app", base: "main", verify: "npm test", merge: "auto", description: "", createdAt: "" } as unknown as Project;
	const checks = await (orchestrator as unknown as { gate(goal: Goal, project: Project, pr: number): Promise<GateCheck[]> }).gate(goal, project, 7);
	return checks.find((c) => c.name === "proofs")!;
}

it("fails a task with 3 criteria and passing proofs for only 2, naming the uncovered one", async () => {
	const check = await proofsCheck([proof(0), proof(1)]);
	assert.equal(check.ok, false);
	assert.match(check.detail, /no passing proof for #2 "streams large reports"/);
	assert.doesNotMatch(check.detail, /#0|#1/);
});

it("passes once the third criterion has a passing proof", async () => {
	const check = await proofsCheck([proof(0), proof(1), proof(2)]);
	assert.equal(check.ok, true, check.detail);
});

it("still fails when every criterion is covered but another proof fails", async () => {
	const check = await proofsCheck([proof(0), proof(1), proof(2), proof(1, 1)]);
	assert.equal(check.ok, false);
	assert.match(check.detail, /1 failing proof/);
});

it("counts a failing proof as no coverage", async () => {
	const check = await proofsCheck([proof(0), proof(1), proof(2, 1)]);
	assert.equal(check.ok, false);
	assert.match(check.detail, /#2/);
});

it("treats proofs without criterionIndex (older attempts) as covering nothing", async () => {
	const check = await proofsCheck([proof(undefined), proof(undefined), proof(undefined)]);
	assert.equal(check.ok, false);
	assert.match(check.detail, /#0.*#1.*#2/);
});

it("runner keeps the first proof of every criterion even past the cap of 8", () => {
	// 6 extra proofs for criterion 0 come first; criteria 1..9 each have one proof after them.
	const raw = [
		...Array.from({ length: 6 }, (_, i) => ({ criterionIndex: 0, criterion: "c0", command: `extra ${i}`, expect: "" })),
		...Array.from({ length: 9 }, (_, i) => ({ criterionIndex: i + 1, criterion: `c${i + 1}`, command: `only ${i + 1}`, expect: "" })),
	];
	const kept = keepProofs(raw, 10);
	assert.equal(kept.length, 10, "the cap rises to the number of criteria");
	assert.deepEqual(new Set(kept.map((p: { criterionIndex: number }) => p.criterionIndex)), new Set(Array.from({ length: 10 }, (_, i) => i)));
});

it("runner drops out-of-range indexes so they cover nothing", () => {
	const kept = keepProofs([{ criterionIndex: 5, criterion: "x", command: "true", expect: "" }], 3);
	assert.equal(kept.length, 1);
	assert.equal("criterionIndex" in kept[0]!, false);
});

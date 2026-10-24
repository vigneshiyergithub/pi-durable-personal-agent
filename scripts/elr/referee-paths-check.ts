// ELR referee-path protection proof (spec docs/elr-canvas-spec.md §9 M0, D9).
//
// The ELR referee paths — src/elr/verifier/** and bench/tasks/** — must sit behind the merge gate's
// PROTECTED_PATHS, so the agent can never merge a change to the code that judges its own experiments.
// This script imports the real list and the real gate from src/orchestra.ts: it prints the effective
// list, hands the real gate() the changed-file lists GitHub's compare reports for realistic PRs, and
// requires the referee files to be refused by name, a docs/-only diff to pass untouched, and the
// referee files' neighbours to stay unguarded. It exits 0 only when every expectation holds;
// otherwise it names what failed.
import type { Agent } from "../../src/agent.ts";
import { Orchestrator, SELF_PROJECT, isProtected, PROTECTED_PATHS, type GateCheck, type Goal, type OrchestraClients, type Project } from "../../src/orchestra.ts";

/** The entries spec §9 M0 / D9 require behind the merge gate. */
const REQUIRED = ["src/elr/verifier/**", "bench/tasks/**"] as const;
/** Real files behind those globs: a goal diff touching any of them must be flagged as protected. */
const REFEREE_FILES = ["src/elr/verifier/score.ts", "src/elr/verifier/index.ts", "bench/tasks/checks.ts", "bench/tasks/cli.ts"] as const;
/** Not referee paths: the gate must not over-block them. */
const NEIGHBOURS = ["src/elr/raster.ts", "bench/verifier/checks.ts", "src/main.ts"] as const;

/** The real "protected paths" gate check (src/orchestra.ts gate()) for a PR whose compare reports these paths. */
async function gateCheck(paths: string[]): Promise<GateCheck> {
	const github = {
		pullRequest: async () => ({ headSha: "abc1234", state: "open" as const, merged: false, mergeable: true }),
		compare: async () => ({ headSha: "abc1234", diff: "not needed here", files: paths.length, paths, truncated: false }),
	};
	const clients = { railway: {}, keys: {}, github } as unknown as OrchestraClients;
	// No durable state needed: a workflow snapshot of "nothing" resolves to the DEFAULT_WORKFLOW.
	const agent = { root: { id: "referee-paths-proof" }, harness: { snapshot: async () => undefined } } as unknown as Agent;
	const orchestrator = new Orchestrator(agent, clients);
	const goal = {
		id: "referee-paths", projectId: SELF_PROJECT.id, title: "the referee judges its own", description: "", acceptance: [],
		status: "delivering", branch: "agent/referee-paths", tasks: [], createdAt: "", updatedAt: "",
	} as unknown as Goal;
	const project = { ...SELF_PROJECT, repo: "owner/pi-durable-personal-agent", base: "master", merge: "veto", description: "", createdAt: "" } as unknown as Project;
	// gate() is private (production calls it from deliver()); this drives the real implementation.
	const checks = await (orchestrator as unknown as { gate(goal: Goal, project: Project, pr: number): Promise<GateCheck[]> }).gate(goal, project, 7);
	return checks.find((c) => c.name === "protected paths")!;
}

let failed = false;
console.log("PROTECTED_PATHS in src/orchestra.ts (the list the merge gate filters a goal's changed files through):");
for (const path of PROTECTED_PATHS) console.log(`  ${path}`);

for (const entry of REQUIRED) {
	if (!PROTECTED_PATHS.includes(entry)) {
		console.error(`FAIL: "${entry}" is missing from PROTECTED_PATHS (src/orchestra.ts) — the merge gate would let the agent merge its own ELR referee (spec D9).`);
		failed = true;
	}
}
for (const file of REFEREE_FILES) {
	if (!isProtected(file)) {
		console.error(`FAIL: the gate matcher does not flag ${file} as protected — a goal touching it could be merged by the agent.`);
		failed = true;
	}
}
for (const file of NEIGHBOURS) {
	if (isProtected(file)) {
		console.error(`FAIL: ${file} is not a referee path but the gate matcher flags it as protected (over-blocking).`);
		failed = true;
	}
}

// The gate itself, end to end: a PR whose compare reports a referee file must be refused, naming it;
// a PR that touches only docs must pass. (The other gate checks — verify, proofs, review — are not
// wired up here, so only the "protected paths" check is read.)
for (const [name, paths, refuse] of [
	["PR touching src/elr/verifier/anything.ts", ["src/elr/verifier/anything.ts", "web/src/lib/api.ts"], true],
	["PR touching bench/tasks/anything.ts", ["bench/tasks/anything.ts"], true],
	["PR touching only docs/readme.md", ["docs/readme.md"], false],
] as const) {
	const check = await gateCheck([...paths]);
	console.log(`  ${name}: ${check.ok ? "not refused" : `REFUSED: "${check.detail}"`}`);
	if (check.ok !== refuse) continue;
	console.error(`FAIL: the real gate ${check.ok ? "did not refuse" : "refused"} ${name} (check said: "${check.detail}").`);
	failed = true;
}

if (failed) process.exit(1);
console.log(`PASS: the merge gate protects the ELR referee paths (${REQUIRED.join(", ")}): it refuses a diff touching the referee's files by name, lets a docs-only PR through, and the matcher flags the referee files, not their neighbours.`);

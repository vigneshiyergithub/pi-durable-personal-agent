// The merge gate's "protected paths" check, driven as production drives it.
//
// Each case hands the real gate() (src/orchestra.ts) a PR whose diff is a real git-format unified diff
// (the compare GitHubApp.compare reports as `paths`), and asserts the check the gate records: refused
// when the diff touches a guardrail file, naming it in the refusal, silent for everything else. The
// matcher itself is never copied or asserted-on: the refusal and its message come out of the real
// gate() code, which filters the PR's changed files through the real isProtected. The stubs replace
// only the external systems (the GitHub PR/compare API and the workflow snapshot), which is what
// OrchestraClients is for; gate() is private, so it is driven through a cast — nothing in
// src/orchestra.ts is changed.
//
// Run with: node --test scripts/orchestra-protected-paths.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Agent } from "../src/agent.ts";
import { Orchestrator, SELF_PROJECT, type GateCheck, type Goal, type OrchestraClients, type Project } from "../src/orchestra.ts";

/** The changed paths GitHub's compare reports for a diff: each file's name, plus the old path of a rename. */
const changedPaths = (diff: string) =>
	[...new Set([...diff.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].flatMap(([, a, b]) => [a!, b!]))];

/** The real "protected paths" gate check (src/orchestra.ts gate()) for a PR with this unified diff. */
async function gateFor(diff: string): Promise<GateCheck> {
	const github = {
		pullRequest: async () => ({ headSha: "abc1234", state: "open" as const, merged: false, mergeable: true }),
		compare: async () => ({ headSha: "abc1234", diff, files: changedPaths(diff).length, paths: changedPaths(diff), truncated: false }),
	};
	const clients = {
		railway: {},
		keys: {},
		github,
	} as unknown as OrchestraClients;
	// No durable state needed: a workflow snapshot of "nothing" resolves to the DEFAULT_WORKFLOW.
	const agent = { root: { id: "protected-paths-suite" }, harness: { snapshot: async () => undefined } } as unknown as Agent;
	const orchestrator = new Orchestrator(agent, clients);
	const goal = {
		id: "gate",
		projectId: SELF_PROJECT.id,
		title: "protected paths suite",
		description: "",
		acceptance: [],
		status: "delivering",
		branch: "agent/protected-paths",
		tasks: [],
		createdAt: "",
		updatedAt: "",
	} as unknown as Goal;
	const project = {
		id: SELF_PROJECT.id,
		repo: "owner/pi-durable-personal-agent",
		base: "master",
		verify: "npm test",
		merge: "owner",
		description: "",
		createdAt: "",
	} as Project;
	// gate() is private (production calls it from deliver()); this drives the real implementation.
	const checks = await (orchestrator as unknown as { gate(goal: Goal, project: Project, pr: number): Promise<GateCheck[]> }).gate(goal, project, 7);
	return checks.find((c) => c.name === "protected paths")!;
}

const refused = (check: GateCheck, expected: string | string[]) => {
	assert.equal(check.ok, false, `expected the gate to refuse this PR; the check said ok with detail "${check.detail}"`);
	assert.match(check.detail, /changes guardrail files the agent never merges itself/);
	for (const path of [expected].flat()) assert.match(check.detail, new RegExp(path.replace(/[.]/g, "\\.")));
};

it('refuses a diff touching src/elr/verifier/anything.ts, refusing only it by name', async () => {
	const check = await gateFor(`diff --git a/src/elr/verifier/anything.ts b/src/elr/verifier/anything.ts
index 9f8c2de..e2b1a77 100644
--- a/src/elr/verifier/anything.ts
+++ b/src/elr/verifier/anything.ts
@@ -1,2 +1,3 @@
 export const anything = () => "the referee that judges the agent's own experiments";
+anything.tinkerWith = true;
diff --git a/web/src/lib/api.ts b/web/src/lib/api.ts
index 03a1bc2..4d5e6f7 100644
--- a/web/src/lib/api.ts
+++ b/web/src/lib/api.ts
@@ -1,2 +1,3 @@
 export const api = { base: "" };
+export const extra = 1;
`);
	refused(check, "src/elr/verifier/anything.ts");
	assert.doesNotMatch(check.detail, /web\/src\/lib\/api\.ts/, "the refusal must name the guardrail file, not the innocent one");
});

it('refuses a diff touching bench/tasks/anything.ts and names it in the refusal', async () => {
	const check = await gateFor(`diff --git a/bench/tasks/anything.ts b/bench/tasks/anything.ts
index 5c630fb..88ba1c3 100644
--- a/bench/tasks/anything.ts
+++ b/bench/tasks/anything.ts
@@ -1,2 +1,3 @@
 export const anything = () => "a benchmark task the referee scores against";
+anything.wateredDown = true;
`);
	refused(check, "bench/tasks/anything.ts");
});

it('refuses a diff touching src/config.ts (an already-protected path) and names it', async () => {
	const check = await gateFor(`diff --git a/src/config.ts b/src/config.ts
index 74b5c11..9de4a02 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,2 +1,3 @@
 export const config = {};
+config.loosen = true;
`);
	refused(check, "src/config.ts");
});

it('refuses a nested bench/tasks/nested/x.ts, not just one level deep', async () => {
	const check = await gateFor(`diff --git a/bench/tasks/nested/x.ts b/bench/tasks/nested/x.ts
new file mode 100644
index 0000000..c1a9d2e
--- /dev/null
+++ b/bench/tasks/nested/x.ts
@@ -0,0 +1,2 @@
+export const x = () => "nested under the benchmark tasks";
`);
	refused(check, "bench/tasks/nested/x.ts");
});

it('refuses a nested src/elr/verifier/sub/y.ts, not just one level deep', async () => {
	const check = await gateFor(`diff --git a/src/elr/verifier/sub/y.ts b/src/elr/verifier/sub/y.ts
new file mode 100644
index 0000000..b3c7d4f
--- /dev/null
+++ b/src/elr/verifier/sub/y.ts
@@ -0,0 +1,2 @@
+export const y = () => "nested under the referee";
`);
	refused(check, "src/elr/verifier/sub/y.ts");
});

it('refuses a rename of src/elr/verifier/score.ts (GitHub reports both names), naming both', async () => {
	const check = await gateFor(`diff --git a/src/elr/verifier/score.ts b/src/elr/verifier/scoring.ts
similarity index 97%
rename from src/elr/verifier/score.ts
rename to src/elr/verifier/scoring.ts
`);
	refused(check, ["src/elr/verifier/score.ts", "src/elr/verifier/scoring.ts"]);
});

it('does not refuse a diff touching only non-protected paths (docs/, observers, bench/verifier, src/elr/raster.ts)', async () => {
	const check = await gateFor(`diff --git a/docs/readme.md b/docs/readme.md
index 1a2b3c4..5d6e7f8 100644
--- a/docs/readme.md
+++ b/docs/readme.md
@@ -1,2 +1,3 @@
 # readme
+more words
diff --git a/src/observers/foo.ts b/src/observers/foo.ts
new file mode 100644
index 0000000..9a8b7c6
--- /dev/null
+++ b/src/observers/foo.ts
@@ -0,0 +1,2 @@
+export const foo = () => "not a guardrail";
diff --git a/bench/verifier/checks.ts b/bench/verifier/checks.ts
index 2f4e6d8..8c0a2b4 100644
--- a/bench/verifier/checks.ts
+++ b/bench/verifier/checks.ts
@@ -1,2 +1,3 @@
 export const checks = true;
+checks.more = true;
diff --git a/src/elr/raster.ts b/src/elr/raster.ts
index 3d5c7b9..7e1f3a2 100644
--- a/src/elr/raster.ts
+++ b/src/elr/raster.ts
@@ -1,2 +1,3 @@
 export const raster = true;
+raster.more = true;
`);
	assert.equal(check.ok, true, `the gate must not refuse non-guardrail work; it said: "${check.detail}"`);
	assert.equal(check.detail, "none touched");
});

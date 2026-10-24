// Shared driver for the review render budget proofs: the budget cases in
// scripts/orchestra-review-diff-chars.test.ts and the merge-gate proofs
// scripts/proof-review-diff-full-render.ts / scripts/proof-review-diff-truncation.ts.
//
// It drives the real reviewer path — startReviews() (private, like gate() in
// orchestra-protected-paths.test.ts) with stubbed external systems: github.compare hands the
// reviewer path a diff of a known size and agent.submit captures exactly what the reviewer would
// read, so the rendered diff body and its truncation marker come out of the real reviewMessage()
// code in src/orchestra.ts. Nothing in src/orchestra.ts is changed for these proofs.
import assert from "node:assert/strict";
import type { Agent } from "../src/agent.ts";
import type { Goal, OrchestraClients, Project } from "../src/orchestra.ts";

let fresh = 0;
/** A fresh evaluation of src/orchestra.ts. The render budget itself lives in src/config.ts (declared once, read once
 *  at import), so the effective value in this process is fixed by the environment at the first import; the budget
 *  cases that need a per-case override run the real module in child processes (see scripts/orchestra-review-diff-chars.test.ts). */
export async function importOrchestra(override?: string) {
	const previous = process.env.REVIEW_DIFF_CHARS;
	if (override === undefined) delete process.env.REVIEW_DIFF_CHARS;
	else process.env.REVIEW_DIFF_CHARS = override;
	try {
		return await import(`../src/orchestra.ts?review-diff-chars=${++fresh}`);
	} finally {
		if (previous === undefined) delete process.env.REVIEW_DIFF_CHARS;
		else process.env.REVIEW_DIFF_CHARS = previous;
	}
}

/** A git-format unified diff of exactly `chars` characters, ending in a tail sentinel line and a second sentinel after it, so the very end of the diff is uniquely identifiable. */
export function diffOfChars(chars: number): string {
	const head = `diff --git a/size-${chars}.txt b/size-${chars}.txt\nindex 0000000..1111111 100644\n--- /dev/null\n+++ b/size-${chars}.txt\n@@ -0,0 +1,3 @@\n`;
	const tail = `+export const tailMarker_${chars} = "the second-to-last diff line";\n+export const lastLine_${chars} = "the very last diff line";\n`;
	const filler = `+${"x".repeat(Math.max(0, chars - head.length - tail.length - 2))}\n`;
	const diff = head + filler + tail;
	assert.equal(diff.length, chars, `diffOfChars(${chars}) must produce exactly ${chars} characters`);
	return diff;
}

/** What the independent reviewer would read for this diff: the real startReviews() renders it and agent.submit captures it.
 *  `diff` is handed to the stubbed github.compare; a caller may pass a real `compare` instead (proof-review-diff-compare.ts
 *  drives the REAL GitHubApp.compare, off-line, and `diff` then only locates the sentinel expectations). */
export async function reviewInputFor(diff: string, compare?: OrchestraClients["github"]["compare"]): Promise<string> {
	const { Orchestrator, createOrchestraExtension } = await importOrchestra();
	const goal = {
		id: "render",
		projectId: "self",
		title: "review render budget",
		description: "",
		acceptance: [],
		status: "reviewing",
		branch: "agent/review-render",
		tasks: [],
		createdAt: "",
		updatedAt: "",
		createdBy: "",
		review: { status: "pending", round: 1, model: "test-model" },
	} as unknown as Goal;
	const project = { id: "self", repo: "owner/repo", base: "master", verify: "npm test", merge: "owner", description: "", createdAt: "" } as Project;
	const state = { goals: [goal], projects: [project], events: [], incidents: [] };
	const submitted: string[] = [];
	const agent = {
		root: {
			id: "review-render-suite",
			commit: async (fn: (tx: unknown) => unknown) =>
				fn({
					createConversation: async () => ({ id: "reviewer-1" }),
					doc: async () => state,
				}),
		},
		harness: { snapshot: async () => state, conversation: async () => ({ id: "reviewer-1" }) },
		submit: async (_reviewer: unknown, message: string) => {
			submitted.push(message);
		},
		notifier: async () => {},
	} as unknown as Agent;
	// startReviews configures the reviewer conversation with submit_review; creating the extension sets that tool.
	createOrchestraExtension({ agent: () => agent, orchestrator: () => new Orchestrator(agent) });
	const clients = {
		railway: {},
		keys: {},
		github: {
			compare:
				compare ??
				(async () => ({ headSha: "abc1234", diff, files: 3, paths: [`size-${diff.length}.txt`], truncated: false })),
		},
	} as unknown as OrchestraClients;
	await (new Orchestrator(agent, clients) as unknown as { startReviews(): Promise<void> }).startReviews();
	assert.equal(submitted.length, 1, "the reviewer must receive exactly one message");
	return submitted[0]!;
}

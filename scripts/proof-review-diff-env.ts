// Proofs C and D for the merge gate's review render budget (REVIEW_DIFF_CHARS, src/config.ts):
// a custom and a blank environment value, honoured on the REAL path.
//
// The budget is declared in src/config.ts and read once at import — the running server has one
// value per process, so each case here runs the real module (and the real render path: startReviews()
// -> reviewMessage(), via scripts/review-render-driver.ts) in a fresh child process whose
// environment carries exactly REVIEW_DIFF_CHARS=<case value>.
//
// Cases (this script spawns each as a child of itself, then asserts every child passed):
// C1. REVIEW_DIFF_CHARS=200000, a 199999-character diff (just UNDER): renders IN FULL, tail
//     sentinel and its follower present, no ", TRUNCATED" marker.
// C2. REVIEW_DIFF_CHARS=200000, a 200001-character diff (just OVER): marked ", TRUNCATED", cut at
//     exactly 200000, no sentinel past the budget reaches the reviewer.
// D.  REVIEW_DIFF_CHARS="   " (whitespace): falls back to the default 300000, which the effective
//     value must report AND a 400000-character diff must still be marked ", TRUNCATED" and cut at
//     exactly 300000 — the blank fallback is not a way to disable the guard.
//
// Exits 0 only when all cases hold (a failing child or a failed assertion is exit 1).
//
// Run from the repository root: node scripts/proof-review-diff-env.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { diffOfChars, importOrchestra, reviewInputFor } from "./review-render-driver.ts";

type Case = { label: string; env: string; chars: number; expect: "whole" | "truncated"; budget: number };
const CASES: Case[] = [
	{
		label: `C-under: REVIEW_DIFF_CHARS=200000, a 199999-character diff just UNDER it renders whole`,
		env: "200000",
		chars: 199_999,
		expect: "whole",
		budget: 200_000,
	},
	{
		label: `C-over: REVIEW_DIFF_CHARS=200000, a 200001-character diff just OVER it truncates at exactly 200000`,
		env: "200000",
		chars: 200_001,
		expect: "truncated",
		budget: 200_000,
	},
	{
		label: `D: REVIEW_DIFF_CHARS="   " (blank) reads as the default 300000 and a 400000-character diff still truncates at exactly 300000`,
		env: "   ",
		chars: 400_000,
		expect: "truncated",
		budget: 300_000,
	},
	{
		label: `E-ceiling: REVIEW_DIFF_CHARS=1000000 (exactly the hard maximum), a 1100001-character diff still truncates at exactly 1000000 — the override cannot disable the guard`,
		env: "1000000",
		chars: 1_100_001,
		expect: "truncated",
		budget: 1_000_000,
	},
];

/** One case, inside a fresh process whose environment carries REVIEW_DIFF_CHARS=<ctx.env>. */
const runCase = async (c: Case): Promise<string> => {
	const effective = (await importOrchestra(process.env.REVIEW_DIFF_CHARS)).REVIEW_DIFF_CHARS;
	assert.equal(
		effective,
		c.budget,
		`the module must read the budget from the environment at import: expected ${c.budget}, got ${effective}`,
	);
	const diff = diffOfChars(c.chars);
	const message = await reviewInputFor(diff);
	if (c.expect === "whole") {
		assert.ok(message.includes(diff), `the full ${c.chars}-character diff must reach the reviewer`);
		assert.ok(message.includes(`tailMarker_${c.chars}`), "the tail sentinel must reach the reviewer");
		assert.ok(message.includes(`lastLine_${c.chars}`), "the second sentinel after the tail must reach the reviewer");
		assert.doesNotMatch(message, /, TRUNCATED/, `a diff under the ${effective} budget must not be marked TRUNCATED`);
		return `whole: ${c.chars} chars rendered ${message.length} to the reviewer, both sentinels present, no TRUNCATED (budget read as ${effective})`;
	}
	assert.match(message, /, TRUNCATED/, `a diff beyond the ${effective} budget must still be marked TRUNCATED`);
	// A wide overrun keeps both sentinels recalculating past the cut; a 1-character overrun (C-over) cannot,
	// because the tail sentinel sits inside the first budget characters of a 200001-character diff — there the
	// exact cut carries the claim: the body is the first `effective` characters, the final one remains withheld.
	if (c.chars > c.budget + 1000) {
		assert.ok(!message.includes(`tailMarker_${c.chars}`) && !message.includes(`lastLine_${c.chars}`), "no sentinel past the budget may reach the reviewer");
	}
	const start = message.indexOf(diff.slice(0, 64));
	const end = message.indexOf("\n\nDecide with submit_review");
	assert.notEqual(start, -1, "the head of the diff must reach the reviewer");
	assert.equal(message.slice(start, end), diff.slice(0, effective), `the reviewer must read exactly the first ${effective} characters`);
	return `truncated: ${c.chars} chars rendered ${message.length}, marked TRUNCATED, cut at exactly ${effective}`;
};

if (process.argv[2] === "--child") {
	const [charsRaw, expectRaw, budgetRaw] = process.argv.slice(3);
	console.log(
		await runCase({
			label: "child",
			env: process.env.REVIEW_DIFF_CHARS ?? "",
			chars: Number(charsRaw),
			expect: expectRaw as "whole" | "truncated",
			budget: Number(budgetRaw),
		}),
	);
} else {
	const results = CASES.map((c) => {
		const env: NodeJS.ProcessEnv = { ...process.env, REVIEW_DIFF_CHARS: c.env };
		const line = execFileSync(
			process.execPath,
			[process.argv[1]!, "--child", String(c.chars), c.expect, String(c.budget)],
			{ env, encoding: "utf8" },
		).trim();
		return { label: c.label, line };
	});
	for (const { label, line } of results) console.log(`CASE PASS\n  ${label}\n  ${line}`);
	console.log(
		`PROOF OK: ${CASES.length}/${CASES.length} cases passed on the real path — a custom value is used with sharp edges both sides, a blank value reads as the default 300000, and even at the hard maximum 1000000 a larger diff still truncates (the override is a knob, never a switch off)`,
	);
}

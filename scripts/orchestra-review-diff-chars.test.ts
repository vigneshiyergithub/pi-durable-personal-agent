// The merge gate's review render budget (REVIEW_DIFF_CHARS, src/config.ts), driven as production drives it.
//
// The budget is declared exactly once in src/config.ts and read once at import, exactly the way the
// running server reads it: the budget cases therefore set the environment and evaluate the real module
// from scratch in a child process per case. The render cases drive the real render path through the
// shared driver in scripts/review-render-driver.ts (startReviews() -> reviewMessage() in src/orchestra.ts),
// against the default budget the fresh process sees.
// Nothing in src/ is changed for these tests.
//
// Run with: node --test scripts/orchestra-review-diff-chars.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { it } from "node:test";
import { diffOfChars, reviewInputFor } from "./review-render-driver.ts";

const DEFAULT_BUDGET = 300_000;
// The render cases run against the default budget: drop any ambient override so the budget declaration
// read once at import inside this process sees the default. The budget cases below set their own per-case
// environment in the child processes they spawn.
delete process.env.REVIEW_DIFF_CHARS;

/** The effective REVIEW_DIFF_CHARS as the real code computes it: node evaluates src/orchestra.ts (which reads the
 *  single declaration in src/config.ts once at import) in a child whose environment carries `override`. */
const effectiveBudget = (override?: string): number => {
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (override === undefined) delete env.REVIEW_DIFF_CHARS;
	else env.REVIEW_DIFF_CHARS = override;
	const printed = execFileSync(
		process.execPath,
		["--input-type=module", "-e", "const m = await import('./src/orchestra.ts'); console.log(String(m.REVIEW_DIFF_CHARS));"],
		{ env, encoding: "utf8" },
	);
	return Number(printed.trim());
};

it("the effective budget is 300000 with no override", () => {
	const value = effectiveBudget();
	console.log(`effective REVIEW_DIFF_CHARS with no override: ${value}`);
	assert.equal(value, DEFAULT_BUDGET);
});

it("REVIEW_DIFF_CHARS=150000 overrides the effective budget", () => {
	const value = effectiveBudget("150000");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=150000: ${value}`);
	assert.equal(value, 150_000);
});

it("REVIEW_DIFF_CHARS=   (whitespace) falls back to the default 300000", () => {
	const value = effectiveBudget("   ");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS="   " (whitespace): ${value}`);
	assert.equal(value, DEFAULT_BUDGET);
});

it("REVIEW_DIFF_CHARS=\" 150000 \" (surrounding whitespace) is trimmed and takes the value 150000", () => {
	const value = effectiveBudget(" 150000 ");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=" 150000 " (surrounding whitespace): ${value}`);
	assert.equal(value, 150_000);
});

it("REVIEW_DIFF_CHARS=200000 overrides the effective budget (small test overrides stay honoured)", () => {
	const value = effectiveBudget("200000");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=200000: ${value}`);
	assert.equal(value, 200_000);
});

it("REVIEW_DIFF_CHARS=1000000 (exactly the hard maximum) is honoured", () => {
	const value = effectiveBudget("1000000");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=1000000 (the maximum): ${value}`);
	assert.equal(value, 1_000_000);
});

it("REVIEW_DIFF_CHARS=1000001 (just above the hard maximum) falls back to the default 300000", () => {
	const value = effectiveBudget("1000001");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=1000001: ${value}`);
	assert.equal(value, DEFAULT_BUDGET);
});

it("REVIEW_DIFF_CHARS=9007199254740991 (unbounded attempt) falls back to the default 300000, not unbounded", () => {
	const value = effectiveBudget("9007199254740991");
	console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=9007199254740991: ${value}`);
	assert.equal(value, DEFAULT_BUDGET);
});

it("an invalid override (abc, 0, -1, empty, Infinity, 3.5) falls back to the default instead of disabling truncation", () => {
	for (const invalid of ["abc", "0", "-1", "", "Infinity", "3.5"]) {
		const value = effectiveBudget(invalid);
		console.log(`effective REVIEW_DIFF_CHARS with REVIEW_DIFF_CHARS=${JSON.stringify(invalid)}: ${value}`);
		assert.equal(value, DEFAULT_BUDGET, `override ${JSON.stringify(invalid)} must fall back to the default, not ${value}`);
	}
});

it("a 240000-character diff renders in full to the reviewer input, with no truncation marker", async () => {
	const diff = diffOfChars(240_000);
	const message = await reviewInputFor(diff);
	assert.ok(message.includes(diff), "the full 240000-character diff must be present in the reviewer input");
	assert.ok(message.includes(`tailMarker_240000`), "the tail sentinel must reach the reviewer");
	assert.ok(message.includes(`lastLine_240000`), "the second sentinel after the tail must reach the reviewer");
	assert.doesNotMatch(message, /, TRUNCATED/, "a diff within the 300000 budget must not be marked TRUNCATED");
	console.log(`a 240000-character diff rendered ${message.length} characters to the reviewer with no TRUNCATED marker`);
});

it("a 400000-character diff beyond the budget still truncates: cut at 300000 and marked TRUNCATED", async () => {
	const diff = diffOfChars(400_000);
	const message = await reviewInputFor(diff);
	assert.match(message, /, TRUNCATED/, "a diff beyond the 300000 budget must still be marked TRUNCATED");
	assert.ok(!message.includes("tailMarker_400000"), "nothing past the budget may reach the reviewer");
	assert.ok(!message.includes("lastLine_400000"), "the second sentinel past the budget may not reach the reviewer either");
	const start = message.indexOf(diff.slice(0, 64));
	const end = message.indexOf("\n\nDecide with submit_review");
	assert.notEqual(start, -1, "the head of the diff must reach the reviewer");
	assert.equal(message.slice(start, end), diff.slice(0, DEFAULT_BUDGET), "the reviewer must read exactly the first 300000 characters of the diff");
	console.log(`a 400000-character diff rendered ${message.length} characters to the reviewer, marked TRUNCATED, cut at ${DEFAULT_BUDGET}`);
});

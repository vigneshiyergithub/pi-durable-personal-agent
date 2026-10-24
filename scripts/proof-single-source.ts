// Proof: the review render budget has a single source of truth (src/config.ts).
//
// The budget may exist at exactly one declaration site — the reviewDiffChars line in src/config.ts —
// with src/orchestra.ts and src/sandbox.ts reading `= config.reviewDiffChars` instead of carrying
// their own literal. The hard ceiling (REVIEW_DIFF_CHARS_MAX) must likewise be declared exactly once
// next to it, and the environment name REVIEW_DIFF_CHARS must be read once, in config.ts.
//
// Exits 0 only when the single-source property holds, non-zero otherwise.
//
// Run from the repository root: node scripts/proof-single-source.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const srcFiles = readdirSync("src", { recursive: true, encoding: "utf8" })
	.filter((f) => f.endsWith(".ts"))
	.map((f) => join("src", f));

const capLiteral = /\b(150_000|150000|200_000|200000|300_000|300000)\b/g;

// 1. The 150000/200000/300000 cap literals appear on exactly one line in src/: the declaration's fallback.
const capLines: string[] = [];
for (const file of srcFiles) {
	for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
		capLiteral.lastIndex = 0;
		if (capLiteral.test(line) && !/^\s*(\/\/|\*|#)/.test(line)) capLines.push(`${file}:${i + 1}: ${line.trim()}`);
	}
}
assert.equal(capLines.length, 1, `the cap literal must appear on exactly one non-comment line in src/, got: ${JSON.stringify(capLines)}`);
assert.match(capLines[0]!, /^src\/config\.ts:\d+:.*reviewDiffChars/, "the sole cap-literal line must be the reviewDiffChars declaration in src/config.ts");

// 2. The hard ceiling is declared exactly once, in src/config.ts, next to the budget it bounds.
const maxLines: string[] = [];
for (const file of srcFiles) {
	for (const [i, line] of readFileSync(file, "utf8").split("\n").entries()) {
		if (/\b1_000_000\b/.test(line) && /REVIEW_DIFF_CHARS_MAX/.test(line) && !/^\s*(\/\/|\*|#)/.test(line)) maxLines.push(`${file}:${i + 1}: ${line.trim()}`);
	}
}
assert.equal(maxLines.length, 1, `REVIEW_DIFF_CHARS_MAX = 1_000_000 must be declared on exactly one non-comment line in src/, got: ${JSON.stringify(maxLines)}`);
assert.match(maxLines[0]!, /^src\/config\.ts:\d+:.*REVIEW_DIFF_CHARS_MAX/, "the ceiling must be the REVIEW_DIFF_CHARS_MAX declaration in src/config.ts");

// 3. Every reader reads config.reviewDiffChars; the environment name is read only in config.ts.
const config = readFileSync("src/config.ts", "utf8");
assert.match(config, /reviewDiffChars:\s*bounded\(parsePositiveInt\(env\("REVIEW_DIFF_CHARS"\)\), REVIEW_DIFF_CHARS_MAX\) \?\? 300_000/);
assert.equal(config.match(/env\("REVIEW_DIFF_CHARS"\)/g)!.length, 1, 'env("REVIEW_DIFF_CHARS") must be read exactly once, in src/config.ts');
for (const reader of ["src/orchestra.ts", "src/sandbox.ts"]) {
	const text = readFileSync(reader, "utf8");
	assert.match(text, /const REVIEW_DIFF_CHARS = config\.reviewDiffChars;/, `${reader} must read config.reviewDiffChars`);
	capLiteral.lastIndex = 0;
	assert.ok(!capLiteral.test(text), `${reader} must not carry its own cap literal`);
}

console.log("SINGLE SOURCE OK: one cap literal (src/config.ts reviewDiffChars fallback), one ceiling (REVIEW_DIFF_CHARS_MAX), one env read, orchestra.ts and sandbox.ts reading = config.reviewDiffChars");

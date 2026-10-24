// Stored evidence keeps exactly what its readers use (the foreman's diff head, the tails of verify/proof/holdout
// output), so the orchestra document stays small.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EVIDENCE_KEEP, type Evidence, slimEvidence } from "../src/orchestra.ts";

const big = (char: string, n: number) => char.repeat(n);
const evidence = (): Evidence => ({
	commits: ["abc feat"],
	diffStat: " src/a.ts | 2 +-",
	diff: `HEAD${big("d", 60_000)}`,
	diffTruncated: false,
	verify: { command: "npm test", exitCode: 1, output: `${big("v", 50_000)}FAILED: 3 tests`, timedOut: false },
	proofs: [{ criterionIndex: 0, criterion: "c", command: "node p.ts", expect: "ok", exitCode: 0, output: `${big("p", 20_000)}ok`, timedOut: false }],
	holdouts: [{ index: 0, exitCode: 1, output: `${big("h", 9_000)}boom`, timedOut: false }],
	bundle: big("b", 1000),
	durationMs: 1,
});

test("keeps the diff head and the output tails, drops the bundle", () => {
	const slim = slimEvidence(evidence());
	assert.equal(slim.diff.length, EVIDENCE_KEEP.diff);
	assert.ok(slim.diff.startsWith("HEAD"), "the foreman reads the start of the diff");
	assert.equal(slim.diffTruncated, true, "a cut diff says so");
	assert.equal(slim.verify!.output.length, EVIDENCE_KEEP.verify);
	assert.ok(slim.verify!.output.endsWith("FAILED: 3 tests"), "failures are at the end of the output");
	assert.ok(slim.proofs![0]!.output.endsWith("ok") && slim.proofs![0]!.output.length === EVIDENCE_KEEP.output);
	assert.ok(slim.holdouts![0]!.output.endsWith("boom") && slim.holdouts![0]!.output.length === EVIDENCE_KEEP.output);
	assert.equal(slim.bundle, undefined);
	assert.ok(JSON.stringify(slim).length < JSON.stringify(evidence()).length / 5);
	assert.deepEqual([slim.commits, slim.diffStat, slim.verify!.exitCode, slim.proofs![0]!.exitCode], [["abc feat"], " src/a.ts | 2 +-", 1, 0], "facts are untouched");
});

test("small evidence passes through unchanged", () => {
	const small: Evidence = { commits: [], diffStat: "", diff: "tiny", diffTruncated: false, verify: { command: "t", exitCode: 0, output: "ok", timedOut: false }, durationMs: 5 };
	assert.deepEqual(slimEvidence(small), small);
});

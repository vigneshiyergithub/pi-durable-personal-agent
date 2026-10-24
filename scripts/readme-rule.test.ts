// This repo's README rule, checked on the diff: readmeFindings (src/orchestra.ts) adds a major finding when a diff
// changes how environment variables are read without touching README.md. The end-to-end flow is in scripts/smoke.ts.
//
// Run with: node --test scripts/readme-rule.test.ts
import assert from "node:assert/strict";
import { it } from "node:test";
import { readmeFindings, SELF_PROJECT } from "../src/orchestra.ts";

const diff = (body: string, paths = ["src/config.ts"]) => ({ diff: `diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1 +1 @@\n${body}`, paths });

it("flags a new environment variable without a README change", () => {
	const [finding] = readmeFindings(SELF_PROJECT.id, diff('+\tlimit: Number(env("FEATURE_LIMIT", "5")),'));
	assert.equal(finding?.severity, "major");
	assert.equal(finding?.file, "README.md");
	assert.match(finding!.note, /FEATURE_LIMIT/);
});

it("flags a removed variable, a changed default, and process.env forms", () => {
	assert.equal(readmeFindings(SELF_PROJECT.id, diff('-\tlimit: Number(env("OLD_LIMIT", "5")),')).length, 1);
	assert.match(readmeFindings(SELF_PROJECT.id, diff('-\tx: env("X_MODE", "a"),\n+\tx: env("X_MODE", "b"),'))[0]!.note, /X_MODE/);
	assert.match(readmeFindings(SELF_PROJECT.id, diff('+const a = process.env.ALPHA_ONE;\n+const b = process.env["BETA_TWO"];'))[0]!.note, /ALPHA_ONE, BETA_TWO/);
});

it("is silent when README.md changes too, for moved lines, for other projects, and for diffs without env vars", () => {
	assert.deepEqual(readmeFindings(SELF_PROJECT.id, diff('+\tlimit: Number(env("FEATURE_LIMIT", "5")),', ["src/config.ts", "README.md"])), []);
	assert.deepEqual(readmeFindings(SELF_PROJECT.id, diff('-\tx: env("X_MODE", "a"),\n+\tx: env("X_MODE", "a"),')), [], "a line moved unchanged is not a config change");
	assert.deepEqual(readmeFindings("demo-app", diff('+\tlimit: Number(env("FEATURE_LIMIT", "5")),')), []);
	assert.deepEqual(readmeFindings(SELF_PROJECT.id, diff("+export const a = 1;")), []);
});

it("ignores env vars in test and benchmark files, but still flags the app's own in the same diff", () => {
	const file = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`;
	for (const path of ["scripts/smoke.ts", "bench/run.ts", "runner/test/lifecycle-linux.mjs", "src/feature.test.ts"]) {
		assert.deepEqual(readmeFindings(SELF_PROJECT.id, { diff: file(path, "+process.env.SMOKE_ONLY = '1';"), paths: [path] }), [], path);
	}
	const mixed = file("scripts/smoke.ts", "+process.env.SMOKE_ONLY = '1';") + file("src/config.ts", '+\tlimit: env("REAL_LIMIT"),');
	assert.match(readmeFindings(SELF_PROJECT.id, { diff: mixed, paths: ["scripts/smoke.ts", "src/config.ts"] })[0]!.note, /\(REAL_LIMIT\)/);
});

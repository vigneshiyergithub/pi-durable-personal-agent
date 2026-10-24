/**
 * Fixture provenance (the one-line capture recipe, kept here because the fixture file holds only emitted bytes):
 * runner/test/fixtures/log-format.txt is the output of logging each line of runner/test/log-lines.mjs through the
 * runner's log helper exactly as it existed BEFORE the closing-log-pipe hardening: `git show
 * 44b2036:runner/task-runner.mjs` is extracted, its two log-path statements (`const started = Date.now();` and the
 * `const log = (...parts) => console.log(...)` right after it) are evaluated verbatim, and each line is passed one per
 * call. Re-run with `node runner/test/capture-log-format.mjs` to reproduce the fixture byte for byte.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { logLines } from "./log-lines.mjs";

const preChangeSource = execFileSync("git", ["show", "44b2036:runner/task-runner.mjs"], { encoding: "utf8" });
const match = preChangeSource.match(/const started = Date\.now\(\);\nconst log = \(\.\.\.parts\) => console\.log\(.+\);/);
if (!match) throw new Error("could not find the pre-change log helper");
const log = new Function(`${match[0]}; return log;`)();

process.stdout.write(logLines.map((line) => log(line)).join(""));

/**
 * Behavioural proof 3: normal output is unchanged.
 * A fresh run of the runner's log helper (imported straight from runner/task-runner.mjs, side-effect free) over the
 * healthy-run lines of runner/test/log-lines.mjs is byte-identical to the pre-change fixture
 * runner/test/fixtures/log-format.txt (its `#` lines are provenance comments, not output).
 * Run as `node runner/test/log-format.mjs`; exits 0 exactly when the criterion holds.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8");

const child = spawn(process.execPath, [fileURLToPath(new URL("log-format-child.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
let current = "";
child.stdout.on("data", (d) => (current += d));
const { code } = await new Promise((resolve) => child.on("close", (c, s) => resolve({ code: c, signal: s })));
if (code !== 0) {
	console.error(`FAIL log-format: the current-run child exited ${code}`);
	process.exit(1);
}
const expected = read("fixtures/log-format.txt")
	.split("\n")
	.filter((l) => l && !l.startsWith("#"))
	.map((l) => `${l}\n`)
	.join("");
if (current !== expected) {
	console.error(`FAIL log-format: current output differs from the pre-change fixture\n${current}`);
	process.exit(1);
}
console.log("ok: the current run of the helper is byte-identical to the pre-change fixture (cmp-equivalent)");

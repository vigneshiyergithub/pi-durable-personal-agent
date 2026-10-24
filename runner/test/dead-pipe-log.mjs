/**
 * Behavioural proof 2: the runner's log helper never throws on a log pipe whose reader is gone, and silently drops the
 * output instead. The helper comes straight from runner/task-runner.mjs (the direct-execution guard makes the import
 * side-effect free), so the proof exercises exactly what the container runs. The child writes several lines through
 * the helper over a dead pipe, and must reach its final marker with exit 0.
 * Run as `node runner/test/dead-pipe-log.mjs`; exits 0 exactly when the criterion holds.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [fileURLToPath(new URL("dead-pipe-log-child.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
// Close this end of the child's stdout pipe: the log collector is gone, exactly as when the platform shuts down.
child.stdout.destroy();
let stderr = "";
let stdout = "";
child.stdout.on("data", (d) => (stdout += d));
child.stderr.on("data", (d) => (stderr += d));
const { code, signal } = await new Promise((resolve) => child.on("close", (c, s) => resolve({ code: c, signal: s })));
if (code !== 0 || signal) {
	console.error(`FAIL dead-pipe-log: exit code ${code}, killed by signal ${signal ?? "none"}, stderr: ${stderr.trim().slice(-300)}`);
	process.exit(1);
}
const marker = stderr.split("\n").find((l) => l.startsWith("SURVIVED:"));
if (!marker) {
	console.error(`FAIL dead-pipe-log: no final marker on stderr; stdout dropped: ${stdout.trim().slice(-200)}`);
	process.exit(1);
}
console.log(`ok dead-pipe-log: ${marker}`);

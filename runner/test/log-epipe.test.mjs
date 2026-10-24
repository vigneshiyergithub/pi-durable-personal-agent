/**
 * Reproduction harness for the closed-log-pipe (EPIPE) failure mode and its absence, side by side.
 *
 * Both demonstrations spawn the same child (runner/test/log-epipe-child.mjs) with the same N lines, the same pacing
 * and the same reader-closing mechanism — the parent reads the child's first log line and only then destroys its end
 * of the pipe (the "log collector is gone" event) — so the only difference is the writer:
 *
 *   control  bare console.log with no error handling. Expected: the child dies with a non-zero exit and `EPIPE` on
 *            its stderr — the uncaught-exception crash that killed goal-d74b9d's attempt twice.
 *   hardened  the runner's own log helper, imported by the child straight from runner/task-runner.mjs. Expected: the
 *            child exits 0 and reaches its final marker on stderr, printed after the N writes.
 *
 * Run:              node runner/test/log-epipe.test.mjs              (exits 0 exactly when both cases pass)
 * Teeth self-test:  node runner/test/log-epipe.test.mjs --self-test  (the naive writer is deliberately pointed at the
 *               hardened case's expectations; the harness must detect that as a failure — exits 0 exactly when the
 *               assertions have teeth, and 1 if the checks could ever pass a broken hardened case)
 *
 * Also runnable under the repo's test runner: `node --test runner/test/log-epipe.test.mjs` picks the file up the same
 * way (any non-zero exit shows up as a failing test file).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("log-epipe-child.mjs", import.meta.url));
const LINES = 8;
const MARKER = "HARDENED-OK:";
const TIMEOUT_MS = 15_000;

/** Spawns the child, reads its first log line, destroys the parent's end of the stdout pipe, and waits for the exit. */
async function runChild(naive) {
	const child = spawn(process.execPath, [childPath], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, NAIVE_WRITER: naive ? "1" : "", LOG_LINES: String(LINES) },
	});
	let firstLine = "";
	let stderr = "";
	child.stdout.on("data", () => {}); // drain after the destroy decision
	child.stderr.on("data", (d) => (stderr += d));
	// deterministic reader close: wait for the first line to arrive, then close our end (no fixed sleep)
	firstLine = (await new Promise((resolve) => child.stdout.once("data", resolve))).toString().split("\n")[0].trim();
	child.stdout.destroy();
	const close = await new Promise((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	return { firstLine, stderr: stderr.trim(), ...close };
}

/** The hardened case's assertion; the teeth self-test reuses it with the naive writer plugged into that slot. */
async function hardenedCaseExpectation(writer = "hardened") {
	const run = await runChild(writer === "naive");
	const marker = run.stderr.split("\n").find((l) => l.startsWith(MARKER));
	// (the runner's log helper prefixes its lines "[runner +0s] …", so the first line contains rather than starts with it)
	const ok = run.code === 0 && !run.signal && Boolean(marker) && run.firstLine.includes("log line 1 of");
	const reason = `exit code: ${run.code}; signal: ${run.signal ?? "none"}; first line: ${run.firstLine || "<none>"}; stderr tail: ${run.stderr.slice(-300) || "<none>"}`;
	return { ok, reason, run, marker };
}

if (process.argv.includes("--self-test")) {
	// The naive writer pointed at the hardened case's expectations must fail them — otherwise these assertions
	// could not tell a hardened child from a dying one and the main run would be a script that always passes.
	const { ok, reason, run } = await hardenedCaseExpectation("naive");
	if (ok) {
		console.error(`FAIL self-test: the hardened-case assertions PASSED a naive console.log child — they have no teeth.\n  ${reason}`);
		process.exit(1);
	}
	console.log(`PASS self-test: the hardened-case assertions correctly failed the naive writer (exit ${run.code}, no marker), so the assertions have teeth`);
	console.log(`  naive stderr where a hardened child would have printed ${MARKER}:\n    ${run.stderr.split("\n").join("\n    ").slice(-600) || "<empty stderr>"}`);
	process.exit(0);
}

// Case 1 — control: naive console.log, no error handling.
const naive = await runChild(true);
const naiveOk = naive.code !== 0 && naive.signal === null && /EPIPE/.test(naive.stderr);
console.log(`control: exit code ${naive.code}${naive.signal ? ` (signal ${naive.signal})` : ""}; stderr:`);
console.log(naive.stderr.split("\n").map((l) => `  ${l}`).join("\n") || "  <empty stderr>");
console.log(`${naiveOk ? "PASS" : "FAIL"} control (naive console.log): expected a non-zero exit with EPIPE on stderr, got exit ${naive.code}${naive.signal ? ` signal ${naive.signal}` : ""}, EPIPE ${/EPIPE/.test(naive.stderr) ? "present" : "absent"}`);
if (!naiveOk) process.exit(1);

// Case 2 — hardened: the runner's own log helper (imported from runner/task-runner.mjs by the child).
const hard = await hardenedCaseExpectation();
console.log(`hardened: exit code ${hard.run.code}${hard.run.signal ? ` (signal ${hard.run.signal})` : ""}; last stderr line: ${hard.marker ?? "(none)"}`);
console.log(`${hard.ok ? "PASS" : "FAIL"} hardened (runner log helper): expected exit 0 and the final ${MARKER} line after ${LINES} writes, got ${hard.reason}`);
process.exit(hard.ok ? 0 : 1);

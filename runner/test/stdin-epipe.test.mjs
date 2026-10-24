/**
 * Behavioural proof of the dead-child stdin hardening, control and hardened side by side.
 *
 * Both halves spawn the same child (runner/test/stdin-epipe-child.mjs) with the same three stdin writes and the same
 * marker — the only difference is the writer:
 *
 *   control   the bare `stdin.end(input)` the runner had before the guard. Expected: the child dies with a non-zero
 *             exit and the raw `write EPIPE` (or ERR_STREAM_DESTROYED) on its stderr, before its final marker — the
 *             uncaught-exception crash that kills an attempt.
 *   hardened  the runner's own stdin-write path, imported by the child straight from runner/task-runner.mjs (the
 *             direct-execution guard makes that import side-effect free). Expected: the child exits 0, its final
 *             marker is printed, and the alive case received its input verbatim.
 *
 * Run:              node runner/test/stdin-epipe.test.mjs              (exits 0 exactly when both cases pass)
 * Teeth self-test:  node runner/test/stdin-epipe.test.mjs --self-test  (the hardened expectations are pointed at the
 *               unguarded child; they must fail it — exits 0 exactly when the assertions have teeth)
 *
 * Also runnable under the repo's test runner: `node --test runner/test/stdin-epipe.test.mjs` picks the file up the
 * same way (any non-zero exit shows up as a failing test file).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const childPath = fileURLToPath(new URL("stdin-epipe-child.mjs", import.meta.url));
const MARKER = "SURVIVED: three stdin writes";
const ALIVE_OK = "ALIVE-OK: the live child received the input verbatim";
const TIMEOUT_MS = 15_000;

/** Spawns the child and collects stdout, stderr and its exit; a timeout SIGKILL is itself a failure. */
async function runChild(unguarded) {
	const child = spawn(process.execPath, [childPath], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, UNGUARDED: unguarded ? "1" : "" },
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
	const close = await new Promise((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	return { stdout, stderr: stderr.trim(), ...close };
}

/** The hardened case's assertion; the teeth self-test reuses it with the unguarded writer plugged into that slot. */
async function hardenedCaseExpectation(writer = "hardened") {
	const run = await runChild(writer === "unguarded");
	const ok =
		run.code === 0 && !run.signal && run.stderr.includes(MARKER) && run.stderr.includes(ALIVE_OK) && !/EPIPE|ERR_STREAM/.test(run.stderr);
	const reason = `exit code: ${run.code}; signal: ${run.signal ?? "none"}; stderr: ${run.stderr.slice(-300) || "<empty>"}`;
	return { ok, reason, run };
}

if (process.argv.includes("--self-test")) {
	// The unguarded writer pointed at the hardened case's expectations must fail them — otherwise these assertions
	// could not tell a guarded writer from a dying one and the main run would be a script that always passes.
	const { ok, reason, run } = await hardenedCaseExpectation("unguarded");
	if (ok) {
		console.error(`FAIL self-test: the hardened-case assertions PASSED an unguarded stdin.end child — they have no teeth.\n  ${reason}`);
		process.exit(1);
	}
	console.log(`PASS self-test: the hardened-case assertions correctly failed the unguarded writer (exit ${run.code}, no marker), so the assertions have teeth`);
	process.exit(0);
}

// Case 1 — negative control: the pre-guard bare stdin.end, no error handling anywhere.
const naive = await runChild(true);
const naiveOk = naive.code !== 0 && naive.signal === null && /EPIPE|ERR_STREAM_DESTROYED/.test(naive.stderr) && !naive.stderr.includes(MARKER);
console.log(`control: exit code ${naive.code}${naive.signal ? ` (signal ${naive.signal})` : ""}; stderr:`);
console.log(naive.stderr.split("\n").map((l) => `  ${l}`).join("\n") || "  <empty stderr>");
console.log(`${naiveOk ? "PASS" : "FAIL"} control (bare stdin.end): expected a non-zero exit with EPIPE or ERR_STREAM_DESTROYED on stderr and no marker, got exit ${naive.code}, match ${/EPIPE|ERR_STREAM_DESTROYED/.test(naive.stderr)}, marker ${naive.stderr.includes(MARKER) ? "present" : "absent"}`);
if (!naiveOk) process.exit(1);

// Case 2 — hardened: the runner's own stdin-write path (feedStdin, imported from runner/task-runner.mjs).
const hard = await hardenedCaseExpectation();
console.log(`hardened: exit code ${hard.run.code}; marker: ${hard.run.stderr.split("\n").find((l) => l.startsWith("SURVIVED:")) ?? "(none)"}`);
console.log(`${hard.ok ? "PASS" : "FAIL"} hardened (runner feedStdin): expected exit 0, the alive case receiving its input verbatim, and the final ${MARKER} line; got ${hard.reason}`);
process.exit(hard.ok ? 0 : 1);

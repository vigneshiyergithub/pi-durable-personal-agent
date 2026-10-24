/**
 * Behavioural proof 1 of the closing-log-pipe hardening: the process survives a dead output stream — and the proof
 * OBSERVES the asynchronous failure, it does not just trust the exit code.
 *
 * EPIPE on a closed pipe is emitted asynchronously: the write calls return first (the failure is only recorded on
 * the stream), the 'error' event itself fires on the nextTick drain, and 'close' right after it. A child that exits
 * immediately after its writes can be gone before the error event ever fires, so a bare "exited 0 at the marker"
 * would pass vacuously (the reviewer's finding about the previous children). Each case here therefore runs, under
 * identical conditions (the parent closes its end of that stream's pipe before the child starts — the "log collector
 * is gone" event):
 *
 *   hardened  the child imports the runner (side-effect free on import; it attaches the closing-log-pipe guards
 *             before anything else), writes to the closed stream, then waits (bounded, on the event loop, via
 *             pipe-survival-wait.mjs) for the written stream's 'close' — reachable only after the 'error' event has
 *             actually run, and only if it did not kill the process. Then it verifies the recorded failure is the
 *             EPIPE, prints its EPIPE-OBSERVED line and final marker, and exits 0. It attaches no 'error' listener
 *             of its own: the runner's guard is the only thing keeping it alive.
 *   control   the same data, the same closed stream, the same bounded wait — but no import of the runner, hence no
 *             guard. Expected: the unhandled 'error' event kills it with the raw `write EPIPE` on its stderr, before
 *             any marker — showing the conditions really raise the error the guard suppresses.
 *
 * The harness exits 0 exactly when both hardened children observed the async EPIPE, survived to their markers at
 * exit 0, and both controls died non-zero with EPIPE and no marker; each case's exit code, observation, marker and
 * output are printed so the evidence is readable. A SIGKILL (hung child) is itself a failure.
 * Run as `node runner/test/pipe-survival.mjs`; also picked up by `node --test runner/test/pipe-survival.mjs`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MARKERS = {
	stdout: "SURVIVED: stdout closed, EPIPE observed (error event ran), still exits 0",
	stderr: "SURVIVED: stderr closed, EPIPE observed (error event ran), still exits 0",
};
const HARDENED_CHILD = { stdout: "pipe-survival-stdout-child.mjs", stderr: "pipe-survival-stderr-child.mjs" };
const TIMEOUT_MS = 15_000;

/** Spawns the child, closes the parent's end of the pipe that carries `died`'s output, and collects everything. */
async function runChild(file, died, env = {}) {
	const child = spawn(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...env },
	});
	child[died].destroy();
	const out = { stdout: "", stderr: "" };
	child.stdout.on("data", (d) => (out.stdout += d));
	child.stderr.on("data", (d) => (out.stderr += d));
	const { code, signal } = await new Promise((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("close", (c, s) => {
			clearTimeout(timer);
			resolve({ code: c, signal: s });
		});
	});
	return { ...out, code, signal };
}

const describe = (r) =>
	`exit code: ${r.code}${r.signal ? ` (killed by signal ${r.signal})` : ""}; stdout: ${JSON.stringify(r.stdout.trim())}; stderr:\n${r.stderr.split("\n").map((l) => `  ${l}`).join("\n") || "  <empty>"}`;

for (const died of ["stdout", "stderr"]) {
	// Hardened: the runner's guard must keep the child alive through the OBSERVED asynchronous EPIPE.
	const hard = await runChild(HARDENED_CHILD[died], died);
	const hardGot = `${hard.stdout}${hard.stderr}`;
	const marker = hardGot.split("\n").find((l) => l.startsWith("SURVIVED:"));
	const observation = hardGot.split("\n").find((l) => l.startsWith("EPIPE-OBSERVED:"));
	const hardOk =
		hard.code === 0 && !hard.signal && Boolean(observation) && marker === MARKERS[died] && !hardGot.includes("NO-ERROR-OBSERVED") && !hardGot.includes("WRONG-ERROR-OBSERVED");
	console.log(`hardened (${died} closed): exit code ${hard.code}${hard.signal ? ` (signal ${hard.signal})` : ""}; observation: ${observation ?? "(none)"}`);
	console.log(`hardened (${died} closed): marker: ${marker ?? "(none)"}`);
	console.log(describe(hard));
	if (!hardOk) {
		console.error(`FAIL pipe-survival (${died} closed, hardened): expected the asynchronous EPIPE observed, exit 0 at "${MARKERS[died]}", got the above`);
		process.exit(1);
	}

	// Unguarded control: same conditions, no guard — the EPIPE must be fatal, proving the error really happens.
	const control = await runChild("pipe-survival-control-child.mjs", died, { CLOSED_STREAM: died });
	const controlGot = `${control.stdout}${control.stderr}`;
	const controlMarker = controlGot.split("\n").find((l) => l.startsWith("SURVIVED:") || l.startsWith("CONTROL-SURVIVED:"));
	const controlRecorded = controlGot.split("\n").find((l) => l.startsWith("CONTROL-RECORDED:"));
	// EPIPE evidence: for the stdout-closed control the raw crash lands on its (still alive) stderr; for the
	// stderr-closed control the stderr IS the dead pipe, so the captured failure recorded before the fatal drain
	// is the evidence — either way EPIPE must appear in the output, and both are printed below.
	const controlOk =
		control.code !== 0 && control.signal === null && /EPIPE/.test(controlGot) && Boolean(controlRecorded) && !controlMarker;
	console.log(`control (${died} closed): exit code ${control.code}${control.signal ? ` (signal ${control.signal})` : ""}; recorded failure: ${controlRecorded ?? "(none)"}`);
	console.log(describe(control));
	if (!controlOk) {
		console.error(`FAIL pipe-survival (${died} closed, control): expected a non-zero exit with the recorded EPIPE, EPIPE in the output and no marker, got the above`);
		process.exit(1);
	}
}

console.log("ok: both hardened children observed the asynchronous EPIPE on the closed stream, survived to their markers at exit 0, and both unguarded controls died non-zero with EPIPE and no marker");

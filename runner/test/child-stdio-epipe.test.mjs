/**
 * Behavioural proof of the child-stdio hardening, control and hardened side by side.
 *
 * All cases run the same harness, runner/test/child-stdio-epipe-child.mjs — which spawns a probe child with the
 * runner's exact spawn shape and captures its streams either through the runner's guarded capture lines (imported
 * from runner/task-runner.mjs) or, for the control, through the runner's pre-guard bare capture. The injected
 * failure is the same in every failure case: the parent's read end of the child's stdout closes mid-stream, surfacing
 * the way it does in the field — as an asynchronous EPIPE-class 'error' on the stream the runner is reading (see the
 * harness for the exact mechanism).
 *
 *   baseline   the pre-guard capture of the probe, run directly by this driver — the "exactly as before" reference.
 *   control    pre-guard capture under the failure: the uncaught error kills the process before any marker; its raw
 *              unhandled stream error is printed here in full (the error the guard suppresses).
 *   hardened   guarded capture under the failure: the runner exits 0, prints its final marker, and the bytes captured
 *              before the break — and only those — are still what it reports; the break hit mid-stream, because the
 *              capture missed the probe's tail.
 *   narrow     guarded capture under a NON-dead-pipe failure (BREAK_CODE=EIO, outside the closed-pipe class): the
 *              guard must not swallow it — the process dies non-zero with the raw error and no marker, exactly as
 *              the control, instead of silently truncating what run() reports while the exit code still looks whole.
 *   healthy    guarded capture without any failure: byte-for-byte the baseline, full output and the same exit code —
 *              the guard may not change what the runner reports while the pipe is alive.
 *
 * Run: node runner/test/child-stdio-epipe.test.mjs  (exits 0 exactly when all cases hold)
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const harnessPath = fileURLToPath(new URL("child-stdio-epipe-child.mjs", import.meta.url));
const probePath = fileURLToPath(new URL("child-stdio-epipe-probe.mjs", import.meta.url));
const MARKER = "SURVIVED: child stdio capture finished, runner still exits 0";
const TIMEOUT_MS = 20_000;

/** Runs a node file with pipes on both streams; a timeout SIGKILL is itself a failure. */
function runNode(path, env = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

const fail = (msg) => {
	console.error(`FAIL ${msg}`);
	process.exit(1);
};

// Baseline: the pre-guard capture of the probe, run directly with the bare capture the runner had — the reference.
const base = await runNode(probePath);
if (base.code !== 0 || !base.stdout.includes("PROBE-DONE: 30 lines written, exit 0\n") || !base.stderr.includes("probe stderr: alive\n"))
	fail(`baseline sanity (pre-guard capture of the probe): exit ${base.code}, stderr ${JSON.stringify(base.stderr.slice(-120))}`);
console.log(`ok baseline (pre-guard capture, no failure): exit ${base.code}, ${base.stdout.length} stdout bytes, ${base.stderr.length} stderr bytes`);

// Case 1 — negative control: the pre-guard capture under the same breaker; its unhandled stream error is printed raw.
const control = await runNode(harnessPath, { UNGUARDED: "1", HARNESS_MODE: "close" });
console.log(`control (pre-guard capture): exit ${control.code}; the raw stream error the guard suppresses, as the death printed it:`);
console.log(control.stderr.split("\n").map((l) => (l ? `  ${l}` : "  -")).join("\n"));
if (control.code === 0 || !/EPIPE/.test(control.stderr) || control.stderr.includes(MARKER))
	fail(`control (pre-guard capture): expected a non-zero EPIPE death before the marker, got exit ${control.code}${control.signal ? ` (signal ${control.signal})` : ""}, marker ${control.stderr.includes(MARKER) ? "present" : "absent"}`);

// Case 2 — hardened: the runner's guarded capture with the read end closed mid-stream.
const hard = await runNode(harnessPath, { HARNESS_MODE: "close" });
if (hard.code !== 0) fail(`hardened close case: the runner died (exit ${hard.code})`);
if (!hard.stderr.includes(MARKER)) fail(`hardened close case: the final marker is missing; stderr ends with ${JSON.stringify(hard.stderr.slice(-200))}`);
let capture;
try {
	capture = JSON.parse(hard.stdout);
} catch {
	fail(`hardened close case: no result JSON; stdout ${JSON.stringify(hard.stdout.slice(-200))}, stderr ${JSON.stringify(hard.stderr.slice(-200))}`);
}
if (!base.stdout.startsWith(capture.stdout)) fail(`hardened close case: the ${capture.stdout.length} captured bytes are not a byte-identical prefix of the child's stdout`);
if (capture.stdout.length === 0 || capture.stdout.length >= base.stdout.length) fail(`hardened close case: the break did not land mid-stream (captured ${capture.stdout.length} of ${base.stdout.length} bytes)`);
if (!capture.stderr.includes("probe stderr: alive\n")) fail(`hardened close case: the child's stderr capture was lost: ${JSON.stringify((capture.stderr ?? "").slice(-200))}`);
console.log(`  captured before the break (${capture.stdout.length} of ${base.stdout.length} bytes; child exit code ${capture.code}): ${JSON.stringify(capture.stdout)}`);
console.log(`ok hardened close case (guard): exit ${hard.code}, marker present, capture preserved intact as a strict byte-identical prefix`);

// Case 2b — narrowness: an error outside the dead-pipe class (EIO) on the same captured stream must still kill the
// process exactly as the pre-guard control does — the capture guard drops only the closed-pipe class, so a real
// stream defect surfaces instead of silently truncating the evidence run() would report.
const eioControl = await runNode(harnessPath, { UNGUARDED: "1", HARNESS_MODE: "close", BREAK_CODE: "EIO" });
console.log(`control EIO (pre-guard capture): exit ${eioControl.code}; the raw error as the death printed it:`);
console.log(eioControl.stderr.split("\n").map((l) => (l ? `  ${l}` : "  -")).join("\n"));
if (eioControl.code === 0 || !/EIO/.test(eioControl.stderr) || eioControl.stderr.includes(MARKER))
	fail(`control EIO (pre-guard capture): expected a non-zero EIO death before the marker, got exit ${eioControl.code}, marker ${eioControl.stderr.includes(MARKER) ? "present" : "absent"}`);
const eio = await runNode(harnessPath, { HARNESS_MODE: "close", BREAK_CODE: "EIO" });
console.log(`narrow EIO (guarded capture): exit ${eio.code}; the raw error as the death printed it:`);
console.log(eio.stderr.split("\n").map((l) => (l ? `  ${l}` : "  -")).join("\n"));
if (eio.code === 0 || !/EIO/.test(eio.stderr) || eio.stderr.includes(MARKER))
	fail(`narrow EIO case: expected the guarded capture to rethrow a non-dead-pipe error — non-zero exit with the raw EIO before the marker, got exit ${eio.code}, marker ${eio.stderr.includes(MARKER) ? "present" : "absent"}`);
console.log(`ok narrow EIO case (guard is narrow): exit ${eio.code}, no marker, the raw error surfaced, same as the pre-guard control`);

// Case 3 — healthy path unchanged: guarded capture with no failure is byte-for-byte the pre-guard reference.
const healthy = await runNode(harnessPath, { HARNESS_MODE: "normal" });
let healthyResult;
try {
	healthyResult = JSON.parse(healthy.stdout);
} catch {
	healthyResult = undefined;
}
if (healthy.code !== 0 || !healthyResult) fail(`healthy case: harness died (exit ${healthy.code}), stdout ${JSON.stringify(healthy.stdout.slice(-120))}`);
if (healthyResult.code !== base.code || healthyResult.stdout !== base.stdout || healthyResult.stderr !== base.stderr)
	fail(`healthy case: the guarded capture differs from the pre-guard reference (exit ${healthyResult.code} vs ${base.code}, stdout ${healthyResult.stdout.length} vs ${base.stdout.length} bytes, stderr ${healthyResult.stderr.length} vs ${base.stderr.length} bytes)`);
console.log(`ok healthy case (guard): exit ${healthyResult.code}, ${healthyResult.stdout.length} stdout bytes and ${healthyResult.stderr.length} stderr bytes byte-identical to the pre-guard reference`);

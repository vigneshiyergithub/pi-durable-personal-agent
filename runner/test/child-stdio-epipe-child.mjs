/**
 * Plays the runner's spawn path, byte for byte, with the guard surface imported straight from the real file
 * (runner/task-runner.mjs is side-effect free on import): it spawns runner/test/child-stdio-epipe-probe.mjs with
 * run()'s spawn shape — stdio ["ignore", "pipe", "pipe"], data listeners on both of the child's stdio streams,
 * resolve on 'close' — and reports {code, stdout, stderr} as JSON on the parent's stdout (this process's own
 * reporting; the runner's context is the child under its capture, not itself).
 *
 * HARNESS_MODE:
 *   normal — no failure; the healthy capture the runner had before and has after the guard (byte-identical claim).
 *   close  — the child's stdout pipe breaks mid-stream: after the first captured chunk the parent's read end
 *            closes. On this Node a plain destroy() lands as a silent close (the grandchild's writes just start
 *            failing), so the failure is injected exactly where a kernel-triggered pipe death arrives — the async
 *            'error' event the stream raises, the class the incident reported ("unhandled EPIPE inside
 *            /tmp/task-runner.mjs"). With the guard attached it is dropped silently; the runner survives it and
 *            keeps whatever it captured. BREAK_CODE picks the injected error's code: the default EPIPE is the
 *            dead-pipe class the capture guard drops; anything outside it (e.g. EIO) must be rethrown by the
 *            guard's narrow listener and kill the process exactly as before the guards.
 * UNGUARDED — the pre-guard capture (bare `child.stdout.on("data", …)`, no listener) the runner had before, for
 *            the negative control: the same injected error is then uncaught and kills the process.
 * Run: node runner/test/child-stdio-epipe-child.mjs
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardedCapture } from "../task-runner.mjs";

const MODE = process.env.HARNESS_MODE ?? "normal";
const probePath = fileURLToPath(new URL("child-stdio-epipe-probe.mjs", import.meta.url));

/** run()'s spawn shape: pipe in and both output streams piped; output collected for the attempt's evidence. */
const child = spawn(process.execPath, [probePath], { stdio: ["ignore", "pipe", "pipe"] });
let stdout = "";
let stderr = "";

if (process.env.UNGUARDED) {
	// Control: the runner's pre-guard capture, verbatim.
	child.stdout.on("data", (d) => (stdout += d));
	child.stderr.on("data", (d) => (stderr += d));
} else {
	// Hardened: exactly the two guarded capture lines run() and runOpencode() now use.
	guardedCapture(child.stdout).on("data", (d) => (stdout += d));
	guardedCapture(child.stderr).on("data", (d) => (stderr += d));
}

if (MODE === "close") {
	// Let the first chunk land, keep the pipe flowing, then break the parent's read end the way a gone collector
	// surfaces in-process: as an EPIPE-class 'error' on the very stream the runner is reading (or, with BREAK_CODE,
	// an error outside that class, which the narrow guard must not swallow).
	const code = process.env.BREAK_CODE ?? "EPIPE";
	const errno = code === "EPIPE" ? -32 : code === "EIO" ? -5 : undefined;
	child.stdout.once("data", () => {
		setTimeout(() => child.stdout.destroy(Object.assign(new Error(`read ${code}`), { code, errno, syscall: "read" })), 0);
	});
}

const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
child.on("close", (code) => {
	clearTimeout(timer);
	console.log(JSON.stringify({ code: code ?? 1, stdout, stderr }));
	process.stderr.write("SURVIVED: child stdio capture finished, runner still exits 0\n");
	process.exit(0);
});

/**
 * The child both halves of runner/test/log-epipe.test.mjs spawn. One file on purpose: the number of lines, the pacing,
 * the marker and the exit path are byte-identical, so the only variable across the two cases is the writer.
 *
 * NAIVE_WRITER=1 → bare console.log, no error handling anywhere: the incident's exact shape (goal-d74b9d: the runner
 * died on `write EPIPE on a Socket` right after the first log lines, because nothing attached an 'error' listener).
 * Otherwise the writer is the runner's own log helper, imported straight from runner/task-runner.mjs — not a copy.
 * That import is side-effect free except for attaching the closing-log-pipe guards (the direct-execution guard keeps
 * startup out of imports), so the hardened case exercises exactly what the container runs.
 *
 * The final marker goes to stderr: the parent keeps reading stderr in both cases, and in the hardened case stdout is
 * the dead pipe the writes are (silently) dropped into, so stderr is the only survivable channel to report on.
 */
const writer = process.env.NAIVE_WRITER === "1" ? console.log : (await import("../task-runner.mjs")).log;

const LINES = Number(process.env.LOG_LINES ?? 8);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 1; i <= LINES; i++) {
	writer(`log line ${i} of ${LINES}`);
	await pause(50); // let the parent read this line and close its end of the pipe before the next write
}

process.stderr.write(`HARDENED-OK: wrote ${LINES} log lines and reached the final marker\n`);
process.exit(0);

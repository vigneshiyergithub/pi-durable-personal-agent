/**
 * A stand-in child for the runner's spawn paths: it writes a deterministic, paced sequence of lines to stdout
 * (each ~30ms apart so the reader sees it mid-stream) plus one stderr line, then exits 0 with a final marker.
 * The bytes are the baseline for the byte comparisons in runner/test/child-stdio-epipe.test.mjs; nothing here is
 * guarded — the child's own fate is not what the proofs are about.
 */
const LINES = 30;
const PACE_MS = 30;
process.stderr.write("probe stderr: alive\n");
let i = 0;
const timer = setInterval(() => {
	if (i === LINES) {
		clearInterval(timer);
		process.stdout.write("PROBE-DONE: 30 lines written, exit 0\n");
		process.exit(0);
	}
	i++;
	process.stdout.write(`probe line ${String(i).padStart(2, "0")}/30\n`);
}, PACE_MS);

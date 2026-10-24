/**
 * Mirror case of pipe-survival-stdout-child.mjs: here the STDERR pipe's reader is closed, the same guard attaches to
 * both streams at runner startup (via the side-effect-free import of runner/task-runner.mjs), and the child must
 * wait for the recorded asynchronous EPIPE and cross the 'error' event's drain (the shared bounded observation, no
 * 'error' listener of its own) before it survives to its marker and exits 0. NO-ERROR-OBSERVED with a non-zero exit
 * if the failure never lands within the bound.
 */
import "../task-runner.mjs";
import { OBSERVE_BOUND_MS, crossErrorDrain, recordStreamFailure } from "./pipe-survival-wait.mjs";

const closed = process.stderr;
const survivor = process.stdout;
const MARKER = "SURVIVED: stderr closed, EPIPE observed (error event ran), still exits 0";

closed.write("write to a dead pipe (1)\n");
closed.write("write to a dead pipe (2)\n");

const failure = await recordStreamFailure(closed);
if (!failure) {
	survivor.write(`NO-ERROR-OBSERVED: stderr never recorded a write failure within the ${OBSERVE_BOUND_MS}ms bound\n`);
	process.exit(1);
}
await crossErrorDrain();
if (failure.code !== "EPIPE") {
	survivor.write(`WRONG-ERROR-OBSERVED: stderr recorded ${String(failure)} instead of write EPIPE\n`);
	process.exit(1);
}
survivor.write(`EPIPE-OBSERVED: stderr failed asynchronously after the dead-pipe writes (captured: ${String(failure)}) — and the 'error' event's drain is crossed with the process alive\n`);
survivor.write(`${MARKER}\n`);
process.exit(0);

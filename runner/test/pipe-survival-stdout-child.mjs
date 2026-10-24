/**
 * The stdout pipe's reader is closed before this child starts (see runner/test/pipe-survival.mjs): writes to it
 * raise EPIPE — asynchronously, on the nextTick drain after the write calls have returned (the write only records
 * the failure on the stream; the 'error' event fires later, in that drain). Survival is therefore only proven once
 * the error has actually run: the child waits (bounded, on the event loop, via the shared pipe-survival-wait.mjs)
 * for the recorded failure, crosses the drain in which the 'error' event is emitted — the drain an unguarded
 * process dies in — and only then verifies the captured failure is the EPIPE the conditions raise, prints the
 * EPIPE-OBSERVED line and its final marker, and exits 0. It attaches no 'error' listener of its own — the no-op
 * guard imported from runner/task-runner.mjs is the only thing keeping this process alive; under a runner without
 * it, the 'error' emission is unhandled and this child dies with an uncaught EPIPE and no marker. If the failure
 * never lands within the bound, the child prints NO-ERROR-OBSERVED and exits non-zero, so the proof fails instead
 * of passing vacuously.
 */
import "../task-runner.mjs";
import { OBSERVE_BOUND_MS, crossErrorDrain, recordStreamFailure } from "./pipe-survival-wait.mjs";

const closed = process.stdout;
const survivor = process.stderr;
const MARKER = "SURVIVED: stdout closed, EPIPE observed (error event ran), still exits 0";

closed.write("write to a dead pipe (1)\n");
closed.write("write to a dead pipe (2)\n");

const failure = await recordStreamFailure(closed);
if (!failure) {
	survivor.write(`NO-ERROR-OBSERVED: stdout never recorded a write failure within the ${OBSERVE_BOUND_MS}ms bound\n`);
	process.exit(1);
}
await crossErrorDrain();
if (failure.code !== "EPIPE") {
	survivor.write(`WRONG-ERROR-OBSERVED: stdout recorded ${String(failure)} instead of write EPIPE\n`);
	process.exit(1);
}
survivor.write(`EPIPE-OBSERVED: stdout failed asynchronously after the dead-pipe writes (captured: ${String(failure)}) — and the 'error' event's drain is crossed with the process alive\n`);
survivor.write(`${MARKER}\n`);
process.exit(0);

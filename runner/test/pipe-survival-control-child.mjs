/**
 * The unguarded control both pipe-survival cases run beside their hardened child (see runner/test/pipe-survival.mjs).
 * It does NOT import runner/task-runner.mjs: nothing anywhere attaches an 'error' listener, so when the closed pipe's
 * 'error' event is emitted (on the nextTick drain after the writes) it is unhandled and thrown — this child dies with
 * the uncaught `write EPIPE` and never reaches its marker. Same data, same closed stream (CLOSED_STREAM=stdout|
 * stderr), the SAME bounded observation as the hardened children (same file, same steps — the only variable is the
 * guard): any survival here would mean the conditions raise no fatal error at all, and the harness must fail the
 * proof. The failure captured in the record step is printed to the surviving stream BEFORE the fatal drain — in the
 * stderr-closed case the child's own stderr is the dead pipe, so the surviving stream is the only channel the EPIPE
 * evidence can reach.
 */
import { OBSERVE_BOUND_MS, crossErrorDrain, recordStreamFailure } from "./pipe-survival-wait.mjs";

const closed = process[process.env.CLOSED_STREAM === "stderr" ? "stderr" : "stdout"];
const survivor = closed === process.stdout ? process.stderr : process.stdout;
const streamName = closed === process.stdout ? "stdout" : "stderr";

closed.write("write to a dead pipe (1)\n");
closed.write("write to a dead pipe (2)\n");

const failure = await recordStreamFailure(closed);
if (!failure) {
	survivor.write(`NO-ERROR-OBSERVED: ${streamName} never recorded a write failure within the ${OBSERVE_BOUND_MS}ms bound\n`);
	process.exit(1);
}
survivor.write(`CONTROL-RECORDED: the unguarded ${streamName} write failed with ${String(failure)} — next the 'error' event's drain runs unguarded\n`);
await crossErrorDrain();
survivor.write(`CONTROL-SURVIVED: ${streamName} recorded ${String(failure)} and the unguarded process lived through the 'error' event's drain, so the guard has nothing to suppress\n`);
process.exit(0);

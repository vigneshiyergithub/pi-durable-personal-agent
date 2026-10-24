/**
 * The bounded observation both halves of the pipe-survival proof wait on (runner/test/pipe-survival*.mjs), in the
 * two steps the asynchronous failure itself has (internal/streams/destroy):
 *
 *   recordStreamFailure(stream, boundMs)
 *     EPIPE on a closed pipe is emitted ASYNCHRONOUSLY: the failing write returns having only RECORDED the error on
 *     the stream (`stream.errored`, set synchronously inside the write), while the 'error' event itself fires on the
 *     nextTick drain (emitErrorNT). So the first step waits (bounded, on the event loop — setTimeout polls of the
 *     actual stream state, no busy exit, no fixed sleep) for the failure to be recorded and CAPTURES that record:
 *     the Error object the stream kept, or null if nothing landed within the bound (so the child fails the proof
 *     with NO-ERROR-OBSERVED instead of passing vacuously).
 *
 *   crossErrorDrain()
 *     The second step: cross the drain in which the 'error' event actually runs (emitErrorNT, right before the
 *     timers phase) by waiting one full event-loop turn (setImmediate). THIS is the step that gives the proof its
 *     teeth: an unguarded process dies in that drain with the uncaught `write EPIPE` and never reaches its marker;
 *     surviving it means the 'error' event was emitted and did not kill the process.
 *
 * (Note: with the runner's guard attached, Node resets the stdout/stderr socket after the handled error — `errored`
 * reads null again and the stream stays usable — which is exactly why the failure must be captured in the record
 * step, before the drain.)
 *
 * Purely observational: neither step attaches a listener to the stream, an 'error' listener least of all — whether
 * the error is fatal is decided entirely by the child's own guard (the runner's, or its absence in the control).
 */
export const OBSERVE_BOUND_MS = 2_000;

export function recordStreamFailure(stream, boundMs = OBSERVE_BOUND_MS) {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = () => {
			if (stream.errored != null) return resolve(stream.errored);
			if (Date.now() - start >= boundMs) return resolve(null);
			setTimeout(tick, 5);
		};
		tick();
	});
}

export function crossErrorDrain() {
	return new Promise((resolve) => setImmediate(resolve));
}

// ELR M3 benchmark harness — shared types and the error the CLI reports without a stack trace
// (spec docs/elr-canvas-spec.md §3, §7, §9 M3).
//
// Everything under src/elr/bench/ is reachable only from bench/**. Nothing in the server's boot or
// request path may import it: GET /health is probed with a 10 s timeout (goal-0e3687 is hardening the
// journal boot path separately), so the benchmark must stay out of that module graph. The re-runnable
// proof is `! git grep -n "elr/bench" src/ -- ':!src/elr/bench*'`.

/** A user-facing benchmark failure. The CLI prints `message` and exits non-zero, never a stack trace. */
export class BenchError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "BenchError";
		this.code = code;
	}
}

/** The arms M3 defines (§7). A is implemented in this slice; B and B′ arrive in later slices. */
export const ARM_IDS = ["A", "B", "B1"] as const;
export type ArmId = (typeof ARM_IDS)[number];

export function isArmId(value: string): value is ArmId {
	return (ARM_IDS as readonly string[]).includes(value);
}

/** The task sets the CLI accepts (§7). `smoke` is exactly 3 tasks. */
export const BENCH_SET_IDS = ["T", "H", "X", "X0", "smoke"] as const;
export type BenchSetId = (typeof BENCH_SET_IDS)[number];

export function isBenchSetId(value: string): value is BenchSetId {
	return (BENCH_SET_IDS as readonly string[]).includes(value);
}

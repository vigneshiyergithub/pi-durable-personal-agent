// ELR M3 benchmark spend cap (spec docs/elr-canvas-spec.md §7, §8, §9 M3).
//
// BENCH_MAX_USD stops a run before it overspends. The decision "may the next episode start?" is a pure
// function of what the run has already recorded (`spent`), its own cap, and a conservative estimate of
// what the next episode could cost. It reads no environment and no MAX_SPEND_USD bookkeeping: the
// benchmark budget is separate from the chat/coding budget (spec §7, D10), so a small MAX_SPEND_USD
// never caps a bench run and a small bench cap never changes MAX_SPEND_USD accounting.
//
// This file is under src/elr/bench/, which the server's boot/request path must never import (see
// types.ts); the decision is pure so it is unit-testable with no network and no money.

/** Why an episode may not start. The message always names BENCH_MAX_USD and the amount spent. */
export type EpisodeBudgetStop = {
	readonly start: false;
	readonly spentUsd: number;
	readonly capUsd: number;
	readonly nextEstimateUsd: number;
	readonly reason: string;
};

export type EpisodeBudgetDecision = { readonly start: true } | EpisodeBudgetStop;

function stop(spentUsd: number, capUsd: number, nextEstimateUsd: number, detail: string): EpisodeBudgetStop {
	return {
		start: false,
		spentUsd,
		capUsd,
		nextEstimateUsd,
		reason: `BENCH_MAX_USD=$${capUsd} ${detail} (spent $${spentUsd.toFixed(6)})`,
	};
}

/**
 * Decide whether the next episode of a run may start.
 *
 * - `spentUsd` is the sum of the costs already recorded for this run.
 * - `capUsd` is BENCH_MAX_USD, the run's own cap (never MAX_SPEND_USD).
 * - `nextEstimateUsd` is a conservative per-episode reserve, so the cap holds even when past episodes
 *   were cheap (for example a reference-driver episode that cost nothing).
 *
 * Stops when the spend already recorded has reached the cap, or when spending the reserve on top of it
 * would cross the cap. Otherwise the next episode may start.
 */
export function decideEpisodeStart(spentUsd: number, capUsd: number, nextEstimateUsd: number): EpisodeBudgetDecision {
	if (spentUsd >= capUsd) return stop(spentUsd, capUsd, nextEstimateUsd, "already reached");
	if (spentUsd + nextEstimateUsd > capUsd) {
		return stop(spentUsd, capUsd, nextEstimateUsd, `would be exceeded by a $${nextEstimateUsd.toFixed(6)} episode`);
	}
	return { start: true };
}

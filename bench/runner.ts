// ELR M3 benchmark run (spec docs/elr-canvas-spec.md §7, §9 M3).
//
// Drives a whole set for one arm: build the M2 task set, run each task as an episode, enforce
// BENCH_MAX_USD before each episode, write the results JSONL and print a per-episode and total
// summary. This file lives in bench/ (not src/) so nothing in the server's module graph can reach it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildTaskSet } from "./tasks/generators.ts";
import { openBenchHarness, runEpisode, type BenchDriver, type EpisodeRecord } from "../src/elr/bench/episode.ts";
import { formatRunSummary, writeResults, type RunSummary } from "../src/elr/bench/results.ts";
import { decideEpisodeStart } from "../src/elr/bench/budget.ts";
import { usesSystemOne } from "../src/elr/bench/arm.ts";
import { resolveSystemOneClient } from "../src/elr/bench/system-one-run.ts";
import type { SystemOneClient, SystemOneEvaluator } from "../src/elr/system-one.ts";
import { resetJournalCache } from "../src/elr/journal.ts";
import { BenchError, type ArmId, type BenchSetId } from "../src/elr/bench/types.ts";

export const DEFAULT_BENCH_MODEL = "deepseek/deepseek-v4.1-flash";
export const DEFAULT_MAX_USD = 10;
export const DEFAULT_EPISODE_TIMEOUT_MS = 45_000;
/**
 * A conservative per-episode spend reserved before starting the next episode, so `BENCH_MAX_USD`
 * stops a run before it overspends even when past episodes happened to be cheap. The first episode
 * always runs (a run needs at least one measurement). The value matches the proposal's
 * $0.0019–$0.0032 per episode (docs/elr-canvas-proposal.md, "Cost of one benchmark replicate").
 */
export const DEFAULT_EPISODE_RESERVE_USD = 0.002;

export type RunnerOptions = {
	arm: ArmId;
	set: BenchSetId;
	seed: number;
	/** "auto" uses the real model when OPENROUTER_API_KEY is set, else the offline reference driver. */
	driver: BenchDriver | "auto";
	maxUsd: number;
	episodeTimeoutMs?: number;
	modelId?: string;
	resultsPath?: string;
	dataDir?: string;
	/** Arm B′ only: inject a System One client (tests) or resolve one from the environment. */
	systemOneClient?: SystemOneClient;
	systemOneEvaluators?: readonly SystemOneEvaluator[];
	/** Test hook: receives every text an episode's agent saw. */
	onAgentText?: (text: string) => void;
	log?: (line: string) => void;
	now?: () => number;
};

function defaultResultsPath(arm: ArmId, set: BenchSetId, seed: number): string {
	const dir = resolve(process.env.BENCH_RESULTS_DIR?.trim() || "data/bench");
	return join(dir, `${arm}-${set}-${seed}.jsonl`);
}

function resolveDriver(driver: BenchDriver | "auto"): BenchDriver {
	if (driver !== "auto") return driver;
	return process.env.OPENROUTER_API_KEY ? "model" : "reference";
}

export async function runBenchmark(options: RunnerOptions): Promise<RunSummary> {
	const driver = resolveDriver(options.driver);
	if (driver === "model" && !process.env.OPENROUTER_API_KEY) {
		throw new BenchError("no-api-key", "the model driver needs OPENROUTER_API_KEY; set it or pass --driver reference");
	}
	const envModel = process.env.BENCH_MODEL?.trim() || undefined;
	const modelId = driver === "reference" ? "faux-1" : options.modelId ?? envModel ?? DEFAULT_BENCH_MODEL;
	const log = options.log ?? ((line: string) => console.log(line));
	const taskSet = buildTaskSet(options.set, options.seed);
	const requested = taskSet.tasks.length;
	const runId = `${options.arm}-${options.set}-${options.seed}-${new Date(options.now?.() ?? Date.now()).toISOString()}`;
	const resultsPath = options.resultsPath ?? defaultResultsPath(options.arm, options.set, options.seed);
	const timeoutMs = options.episodeTimeoutMs ?? DEFAULT_EPISODE_TIMEOUT_MS;

	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "elr-bench-")));
	const ownsDataDir = options.dataDir === undefined;
	process.env.DATA_DIR = dataDir;
	resetJournalCache();

	const bench = await openBenchHarness({ arm: options.arm, driver, dataDir, modelId });
	// Arm B′ runs System One after each episode. The real client is used only when a key is present;
	// otherwise a fixed-cost offline stub keeps smoke runs free (spec §9 M3, §6).
	const systemOne =
		usesSystemOne(options.arm)
			? {
					client: options.systemOneClient ?? resolveSystemOneClient(),
					...(options.systemOneEvaluators === undefined ? {} : { evaluators: options.systemOneEvaluators }),
				}
			: undefined;
	const records: EpisodeRecord[] = [];
	let spent = 0;
	let stopped = false;
	let stoppedReason: string | undefined;

	try {
		log(`bench: arm=${options.arm} set=${options.set} seed=${options.seed} tasks=${requested} driver=${driver} model=${modelId}`);
		const reserve = Number(process.env.BENCH_EPISODE_RESERVE_USD ?? DEFAULT_EPISODE_RESERVE_USD);
		for (let i = 0; i < taskSet.tasks.length; i++) {
			const task = taskSet.tasks[i]!;
			// The first episode always runs (a run needs at least one measurement); from the second on the
			// pure budget function decides whether the next episode may start.
			if (i > 0) {
				const decision = decideEpisodeStart(spent, options.maxUsd, reserve);
				if (!decision.start) {
					stopped = true;
					stoppedReason = `${decision.reason}; stopping before episode ${i + 1}`;
					log(`bench: ${stoppedReason}`);
					break;
				}
			}
			const record = await runEpisode(bench, {
				task,
				arm: options.arm,
				seed: options.seed,
				driver,
				modelId,
				runId,
				timeoutMs,
				...(systemOne === undefined ? {} : { systemOne }),
				...(options.onAgentText === undefined ? {} : { onAgentText: options.onAgentText }),
				now: options.now,
			});
			records.push(record);
			spent += record.costUsd;
			const fp = record.providerFingerprint;
			log(
				`episode ${i + 1}/${requested} task=${record.taskId} boundaryF=${record.boundaryF.toFixed(4)} ` +
					`calls=${record.calls} strokes=${record.strokes} costUsd=$${record.costUsd.toFixed(6)} ` +
					`success=${record.success} model=${record.model} provider=${fp.provider} responseId=${fp.responseId}`,
			);
		}
		await writeResults(resultsPath, records);
	} finally {
		await bench.close();
		resetJournalCache();
		if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
	}

	const summary: RunSummary = {
		runId,
		arm: options.arm,
		set: options.set,
		seed: options.seed,
		requested,
		completed: records.length,
		totalCostUsd: spent,
		maxUsd: options.maxUsd,
		resultsPath,
		driver,
		model: modelId,
		stopped,
		...(stoppedReason === undefined ? {} : { stoppedReason }),
	};
	for (const line of formatRunSummary(summary)) log(line);
	return summary;
}

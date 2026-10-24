// ELR M3 results JSONL (spec docs/elr-canvas-spec.md §7, §9 M3).
//
// One JSON object per line, one line per episode. The file is overwritten per run (its name carries
// arm, set and seed), so a run's file always holds exactly that run's episodes. Writing/reading is
// pure Node with no dependency.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EpisodeRecord } from "./episode.ts";

export const RESULTS_SCHEMA = "elr.bench.episode/2";

export async function writeResults(path: string, records: readonly EpisodeRecord[]): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const body = records.map((record) => JSON.stringify(record)).join("\n");
	await writeFile(path, records.length === 0 ? "" : `${body}\n`, "utf8");
}

export async function readResults(path: string): Promise<EpisodeRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as EpisodeRecord);
}

export type RunSummary = {
	runId: string;
	arm: string;
	set: string;
	seed: number;
	requested: number;
	completed: number;
	totalCostUsd: number;
	maxUsd: number;
	resultsPath: string;
	driver: string;
	model: string;
	stopped: boolean;
	stoppedReason?: string;
};

export function formatRunSummary(summary: RunSummary): string[] {
	const lines = [
		`bench: arm=${summary.arm} set=${summary.set} seed=${summary.seed} driver=${summary.driver} model=${summary.model}`,
		`bench: episodes=${summary.completed}/${summary.requested} totalCostUsd=$${summary.totalCostUsd.toFixed(6)} cap=$${summary.maxUsd}`,
	];
	if (summary.stopped) lines.push(`bench: stopped before the next episode: ${summary.stoppedReason ?? "cap reached"}`);
	lines.push(`bench: results=${summary.resultsPath}`);
	return lines;
}

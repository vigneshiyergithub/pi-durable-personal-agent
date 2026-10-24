// ELR Lab panel data (spec docs/elr-canvas-spec.md §3 web/src, §7, §8, §9 M3): benchmark runs and
// learning curves from the results JSONL, knowledge grouped by status from the journal (D7). Read
// straight from disk on each request; src/http.ts loads this lazily so the boot path and /health
// never wait on it. Every failure — missing or corrupt files included — degrades to an empty
// section, never a failed request. Nothing credential-like is read or served.
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type LabRun = {
	id: string;
	arm: string;
	set: string;
	seed: number | null;
	date: string | null;
	totalCostUsd: number;
	episodes: number;
	/** complete: every line parsed; corrupt: some or none did; empty: no lines at all. */
	status: "complete" | "corrupt" | "empty";
};
/** One curve per run: boundary-F (the verifier's reward) per episode, from recorded JSONL only. */
export type LabCurve = { id: string; label: string; scores: number[] };
export type LabNode = { id: string; statement: string };
export type LabSnapshot = { runs: LabRun[]; curves: LabCurve[]; knowledge: Record<string, LabNode[]> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

type Episode = { runId: string | null; arm: string | null; set: string | null; seed: number | null; boundaryF: number; costUsd: number; at: string | null };

/** One JSONL line per episode; a bad line drops that episode, never the whole run. */
function parseEpisodes(body: string): { episodes: Episode[]; lines: number } {
	const lines = body.split("\n").filter((line) => line.trim() !== "");
	const episodes: Episode[] = [];
	for (const line of lines) {
		try {
			const row: unknown = JSON.parse(line);
			if (!isRecord(row) || typeof row.boundaryF !== "number" || !Number.isFinite(row.boundaryF)) continue;
			episodes.push({
				runId: text(row.runId),
				arm: text(row.arm),
				set: text(row.set),
				seed: num(row.seed, Number.NaN),
				boundaryF: row.boundaryF,
						costUsd: num(row.costUsd, 0),
				at: text(row.endedAt) ?? text(row.startedAt),
			});
		} catch {
			// corrupt line: skipped, the run degrades
		}
	}
	return { episodes, lines: lines.length };
}

async function readRun(dir: string, file: string): Promise<{ run: LabRun; curve: LabCurve }> {
	const stem = file.replace(/\.jsonl$/, "");
	try {
		const { episodes, lines } = parseEpisodes(await readFile(join(dir, file), "utf8"));
		const first = episodes[0];
		const dates = episodes.map((e) => e.at).filter((d): d is string => d !== null).sort();
		const run: LabRun = {
			id: first?.runId ?? stem,
			arm: first?.arm ?? "",
			set: first?.set ?? "",
			seed: first !== undefined && Number.isFinite(first.seed) ? first.seed : null,
			date: dates.at(-1) ?? null,
			totalCostUsd: Math.round(episodes.reduce((sum, e) => sum + e.costUsd, 0) * 1e6) / 1e6,
			episodes: episodes.length,
			status: episodes.length === lines ? (episodes.length > 0 ? "complete" : "empty") : "corrupt",
		};
		return {
			run,
			curve: {
				id: run.id,
				label: `${run.arm || "?"} · ${run.set || "?"} · ${run.seed === null ? "seed ?" : `seed ${run.seed}`}`,
				scores: episodes.map((e) => e.boundaryF),
				},
		};
	} catch {
		return { run: { id: stem, arm: "", set: "", seed: null, date: null, totalCostUsd: 0, episodes: 0, status: "corrupt" }, curve: { id: stem, label: stem, scores: [] } };
	}
}

/** Knowledge grouped by status, read from the journal's SQLite file directly (read-only, capped). */
function knowledgeByStatus(file: string): Record<string, LabNode[]> {
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(file, { readOnly: true });
	} catch {
		return {};
	}
	try {
		const grouped: Record<string, LabNode[]> = {};
		const rows = db.prepare("SELECT id, statement, status FROM knowledge_nodes ORDER BY updatedAt DESC LIMIT 500").all();
		for (const row of rows as Record<string, unknown>[]) {
			const statement = typeof row.statement === "string" ? row.statement.slice(0, 240) : "";
			if (statement === "") continue;
			const status = typeof row.status === "string" && row.status.trim() !== "" ? row.status.trim().slice(0, 40) : "unknown";
			(grouped[status] ??= []).push({ id: String(row.id ?? ""), statement });
		}
		return grouped;
	} catch {
		return {};
	} finally {
		db.close();
	}
}

/** The Lab panel's whole payload. Never throws: every failure becomes an empty section. */
export async function labSnapshot(options: { resultsDir?: string; journalFile?: string } = {}): Promise<LabSnapshot> {
	const dir = options.resultsDir ?? resolve(process.env.BENCH_RESULTS_DIR?.trim() || "data/bench");
	const journalFile = options.journalFile ?? join(resolve(process.env.DATA_DIR?.trim() || "./data"), "elr.sqlite");
	const runs: LabRun[] = [];
	const curves: LabCurve[] = [];
	try {
		for (const file of (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort()) {
			const parsed = await readRun(dir, file);
			runs.push(parsed.run);
			curves.push(parsed.curve);
		}
		runs.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
		curves.sort((a, b) => runs.findIndex((r) => r.id === a.id) - runs.findIndex((r) => r.id === b.id));
	} catch {
		// no results dir: the empty sections are the empty state
	}
	return { runs, curves, knowledge: knowledgeByStatus(journalFile) };
}

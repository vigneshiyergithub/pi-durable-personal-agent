// ELR M2 boot-block measurement: how long the journal boot path (open + §4 migrations + transcript
// reconcile) can actually block, on a large transcript, in a fresh process (spec docs/elr-canvas-spec.md
// §4, §9 M2; follow-up to the "probes: GET /health no answer" warning observed while M2 was live).
//
// This is a *measurement*, not a fix. It times the boot path that the shipped code actually runs:
// `bootJournal()` — open the journal, run the §4 migrations, and re-derive every missing canvas event
// from the pi-durable transcript — exactly as `Agent.open()` calls it at boot (src/agent.ts), i.e.
// entirely before the HTTP listener comes up. The measured number is corroborating evidence for the
// /health hazard; the ordering fix itself is goal-0e3687's, not this branch's.
//
//   setup (parent):
//     1. a throwaway FILE-backed DATA_DIR is created and the §4 migrations are applied to its
//        /data/elr.sqlite (src/elr/journal.ts `Journal`, the same migration boot runs);
//     2. a pi-durable transcript of SEED_ACTIONS canvas actions (2 entries each, so >= 5000 entries)
//        is committed through the repo's own storage/harness APIs (bench/journal/harness.ts
//        `openHarness` + `tx.appendEntry`), and the journal is left with *none* of the corresponding
//        events, so the boot reconciler must re-derive every one of them.
//   measure (child, fresh process, one per run): the journal file is removed before each run so the
//     child runs the whole boot path from scratch — `bootJournal()` — timed with performance.now() and
//     printed as JSON. Every run therefore re-derives all events; the max across runs is the worst-case
//     boot block.
//
// Run:  node bench/journal/boot-block.ts    (npm run proof:journal-boot-block)
// Env:  ELR_BOOT_BLOCK_ACTIONS (default 2500 actions == 5000 transcript entries)
//       ELR_BOOT_BLOCK_RUNS    (default 3 fresh-process runs)
//
// Exits 0 exactly when: the transcript has >= 5000 entries; the journal starts with 0 events; the boot
// path re-derived every event in every run; and the worst-case boot block was printed. Exits 1 otherwise.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { bootJournal, Journal } from "../../src/elr/journal.ts";
import { openHarness } from "./harness.ts";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "../..");

/** Canvas actions to seed; each action is an assistant toolCall entry + a tool-result entry. */
const SEED_ACTIONS = Number(process.env.ELR_BOOT_BLOCK_ACTIONS ?? 2500);
/** Fresh-process boot runs; the worst (max) is reported. */
const RUNS = Number(process.env.ELR_BOOT_BLOCK_RUNS ?? 3);

/** The production observation probe's per-request timeout (10 s), read from src/orchestra.ts. */
function readProbeTimeout(): number {
	const text = readFileSync(join(ROOT, "src/orchestra.ts"), "utf8");
	const match = /AbortSignal\.timeout\(\s*([\d_]+)\s*\)/.exec(text);
	if (match === null) throw new Error("could not read the production probe timeout from src/orchestra.ts");
	return Number(match[1]!.replace(/_/g, ""));
}

const PROBE_BUDGET = readProbeTimeout();

type BootBlock = {
	totalMs: number;
	conversations: number;
	inserted: number;
	eventsInJournal: number;
	fts5: boolean;
};

function countEvents(journalPath: string): number {
	const db = new DatabaseSync(journalPath, { readOnly: true });
	try {
		return Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
	} finally {
		db.close();
	}
}

/**
 * Seed a pi-durable transcript of `count` canvas actions (assistant toolCall + tool-result entries,
 * batched) into `dataDir/agent.sqlite`, the source of truth the boot reconciler reads. No journal
 * events are written. Returns the number of actions (== the number of journal events a full reconcile
 * must produce).
 */
async function seedCanvasTranscript(dataDir: string, count: number): Promise<number> {
	process.env.DATA_DIR = dataDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	const { harness, conversation } = await openHarness(dataDir);
	const conversationId = conversation.id;
	const batch = 250;
	try {
		for (let start = 0; start < count; start += batch) {
			const end = Math.min(start + batch, count);
			await conversation.commit(async (tx) => {
				for (let i = start; i < end; i++) {
					const toolCallId = `seed-tool-${i}`;
					await tx.appendEntry(conversationId, {
						kind: "pi.assistant",
						model: [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: toolCallId, name: "paint", arguments: { points: [[i % 256, 0], [0, i % 256]], width: 3 } }],
							},
						] as never,
					});
					await tx.appendEntry(conversationId, {
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolCallId,
								toolName: "paint",
								isError: false,
								timestamp: Date.now(),
								content: [{ type: "text", text: "painted" }],
								details: {
									namespace: "painting",
									version: 1,
									configHash: `seed-${i}`,
									tool: "paint",
									attempt: 0,
									opHash: `op-${i}`,
									beforeHash: `before-${i}`,
									afterHash: `after-${i}`,
								},
							},
						] as never,
					});
				}
			}, BACKGROUND_CONTEXT);
		}
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
	return count;
}

/**
 * Child mode: a single fresh-process boot against the already-populated DATA_DIR. Times the real boot
 * path the shipped code runs — `bootJournal()` (open + §4 migrations + transcript reconcile, exactly
 * as `Agent.open()` calls it) — and prints one JSON line.
 */
async function childBoot(dataDir: string): Promise<void> {
	process.env.DATA_DIR = dataDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	const { harness } = await openHarness(dataDir);
	try {
		const t0 = performance.now();
		const boot = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
		const doneAt = performance.now();
		const journalPath = boot.journal.path;
		const eventsInJournal = countEvents(journalPath);
		await boot.journal.close();
		const block: BootBlock = {
			totalMs: Number((doneAt - t0).toFixed(1)),
			conversations: boot.conversations,
			inserted: boot.inserted,
			eventsInJournal,
			fts5: boot.fts5,
		};
		console.log(`BOOT_BLOCK ${JSON.stringify(block)}`);
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

function runChild(dataDir: string): BootBlock {
	const result = spawnSync(process.execPath, [SCRIPT, "child", dataDir], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, DATA_DIR: dataDir, OPENROUTER_API_KEY: "unused" },
	});
	const line = (result.stdout ?? "").split("\n").find((l) => l.startsWith("BOOT_BLOCK "));
	if (result.status !== 0 || line === undefined) {
		throw new Error(`boot child failed (status=${result.status} signal=${result.signal}):\n${result.stdout}\n${result.stderr}`);
	}
	return JSON.parse(line.slice("BOOT_BLOCK ".length)) as BootBlock;
}

/** Remove the journal (and its WAL/shadow files) so the next fresh-process boot must rebuild it all. */
function removeJournal(journalPath: string): void {
	for (const suffix of ["", "-wal", "-shm"]) rmSync(journalPath + suffix, { force: true });
}

async function main(): Promise<void> {
	console.log("=== ELR M2 boot-block measurement: large transcript, fresh-process boot ===");
	console.log("(measurement only; the ordering fix is goal-0e3687's, not this branch's)");
	console.log(`production probe timeout: ${PROBE_BUDGET} ms (src/orchestra.ts)`);
	console.log(`seeding:                  ${SEED_ACTIONS} canvas actions (${SEED_ACTIONS * 2} transcript entries)`);

	const dataDir = mkdtempSync(join(tmpdir(), "elr-boot-block-"));
	const journalPath = join(dataDir, "elr.sqlite");
	try {
		// 1. Apply the §4 migrations to the file-backed journal (the same migration path boot runs).
		const migrator = new Journal(journalPath);
		console.log(`\njournal created + migrated: schema_version=${migrator.schemaVersion()} fts5=${migrator.fts5Available()} path=${journalPath}`);
		migrator.close();

		// 2. Seed a large pi-durable transcript through the repo's own storage API; no journal events are written.
		console.log(`\nseeding ${SEED_ACTIONS} transcript actions ...`);
		const actions = await seedCanvasTranscript(dataDir, SEED_ACTIONS);
		const entries = actions * 2;
		const journalEventsBefore = countEvents(journalPath);
		console.log(`seeded ${actions} actions -> ${entries} transcript entries committed to agent.sqlite`);
		console.log(`journal events before boot: ${journalEventsBefore} (the reconciler must re-derive all ${actions})`);

		// 3. Each run boots from a removed journal, so the child runs the whole open + migrate + reconcile path.
		const blocks: BootBlock[] = [];
		for (let run = 1; run <= RUNS; run++) {
			removeJournal(journalPath);
			const block = runChild(dataDir);
			blocks.push(block);
			console.log(
				`run ${run}: bootJournal(open+migrate+reconcile)=${block.totalMs} ms, reconciler inserted=${block.inserted}, events now=${block.eventsInJournal}`,
			);
		}

		const maxTotal = Math.max(...blocks.map((b) => b.totalMs));
		console.log(`\nworst boot block (max of ${RUNS} fresh-process runs): ${maxTotal} ms`);
		console.log(`corroboration: ${PROBE_BUDGET} ms probe timeout / ${maxTotal} ms worst block = ${(PROBE_BUDGET / maxTotal).toFixed(1)}x`);

		const allInsertedFully = blocks.every((b) => b.inserted === actions && b.eventsInJournal === actions);
		const ok = entries >= 5000 && journalEventsBefore === 0 && actions >= 1 && allInsertedFully && maxTotal > 0;
		console.log(`\ntranscript entries >= 5000 (got ${entries}) and journal missing every event (${journalEventsBefore}): ${entries >= 5000 && journalEventsBefore === 0}`);
		console.log(`boot path re-derived every event in every run (inserted=${blocks.map((b) => b.inserted).join(", ")} of ${actions}): ${allInsertedFully}`);
		console.log(`worst-case boot block printed: ${maxTotal} ms`);
		console.log(`\nmeasurement valid: ${ok}`);
		process.exitCode = ok ? 0 : 1;
	} finally {
		rmSync(dataDir, { recursive: true, force: true });
	}
}

if (process.argv[2] === "child" && process.argv[3] !== undefined) {
	childBoot(process.argv[3]).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
} else {
	await main();
}

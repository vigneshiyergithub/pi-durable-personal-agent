// Re-runnable M2 proofs (spec docs/elr-canvas-spec.md §3, §4, §5, §9 M2). Every case exits 0 exactly
// when its criterion holds, non-zero otherwise. No network, no credentials, no model in the loop.
//
//   node bench/journal/proofs.ts journal    [schema|negative|migrate|idempotent|append-only|wiring|fts|all]
//   node bench/journal/proofs.ts episode    [six|production|all]       (episode negative corrupts a hash)
//   node bench/journal/proofs.ts reconcile  [crash|idempotent|transcript|converge|dup|deferred|all]
//   node bench/journal/proofs.ts boot       [migrations|source|crash|reachable|nonfatal|agent|all]
//   node bench/journal/proofs.ts boot-guard [nonfatal|logline|repair|all]
//
// The journal cases print the Node version so the runner can confirm the production image's major
// (Dockerfile: FROM node:24-slim; engines: node >=24).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	bootJournal,
	bootReconcile,
	CANVAS_NAMESPACE,
	deriveCanvasCalls,
	hashOp,
	JOURNAL_FTS_TABLES,
	JOURNAL_SCHEMA_VERSION,
	JOURNAL_TABLES,
	Journal,
	journalFor,
	journalReadyLine,
	openBootJournal,
	readConversationTranscript,
	reconcileBootJournal,
	resetJournalCache,
	sha256Hex,
	TRANSCRIPT_TABLE,
	type JournalEvent,
	type TranscriptCall,
} from "../../src/elr/journal.ts";
import {
	AGENT_DB_FILE,
	appendTranscript,
	canvasTools,
	JOURNAL_DB_FILE,
	openHarness,
	PRODUCTION_WRITE_PATH,
	runAction,
	runScriptedEpisode,
	scriptedCallIds,
	SCRIPTED_EPISODE,
	seedSyntheticCanvasTranscript,
	SIX_ACTION_EPISODE,
	SYNTHETIC_LOSS_CAVEAT,
	type EpisodeResult,
} from "./harness.ts";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const self = fileURLToPath(import.meta.url);
const childScript = join(repoRoot, "bench", "journal", "children.ts");

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

function tempDb(): { path: string; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "elr-journal-"));
	return { path: join(dir, "elr.sqlite"), dir };
}

function gitGrep(pattern: string, file: string): string {
	const result = spawnSync("git", ["grep", "-n", pattern, "--", file], { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0 || !result.stdout.trim()) fail(`git grep ${pattern} ${file} found nothing (status ${result.status})`);
	return result.stdout.trim();
}

function duplicateToolCallIds(journalPath: string): string[] {
	const db = new DatabaseSync(journalPath);
	try {
		return db
			.prepare("SELECT toolCallId, COUNT(*) AS c FROM events GROUP BY toolCallId HAVING c > 1")
			.all()
			.map((row) => String((row as Record<string, unknown>).toolCallId));
	} finally {
		db.close();
	}
}

/** The journal's events as a map toolCallId -> canonical payload (every column, sorted keys). */
function snapshotEvents(journalPath: string): Map<string, string> {
	const db = new DatabaseSync(journalPath, { readOnly: true });
	try {
		const rows = db.prepare("SELECT * FROM events ORDER BY toolCallId").all() as Record<string, unknown>[];
		const snapshot = new Map<string, string>();
		for (const row of rows) {
			const payload: Record<string, unknown> = {};
			for (const key of Object.keys(row).sort()) payload[key] = row[key];
			snapshot.set(String(row.toolCallId), JSON.stringify(payload));
		}
		return snapshot;
	} finally {
		db.close();
	}
}

type SnapshotDiff = { missing: string[]; extra: string[]; differing: string[]; equal: boolean };

/** Compare two event snapshots key-by-key: missing/extra keys and keys whose payloads differ. */
function compareSnapshots(reference: Map<string, string>, candidate: Map<string, string>): SnapshotDiff {
	const missing = [...reference.keys()].filter((key) => !candidate.has(key));
	const extra = [...candidate.keys()].filter((key) => !reference.has(key));
	const differing = [...reference.keys()].filter((key) => candidate.has(key) && reference.get(key) !== candidate.get(key));
	return { missing, extra, differing, equal: missing.length === 0 && extra.length === 0 && differing.length === 0 };
}

type ChildResult = { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function spawnChild(args: string[]): ChildResult {
	return spawnSync(process.execPath, [childScript, ...args], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "unused" } }) as ChildResult;
}

type EventView = {
	id: string;
	toolCallId: string;
	conversationId: string;
	sessionId: string | null;
	attemptId: string | null;
	parentEventId: string | null;
	kind: string;
	tool: string | null;
	namespace: string | null;
	version: number | null;
	configHash: string | null;
	opHash: string | null;
	beforeHash: string | null;
	afterHash: string | null;
};

function view(event: JournalEvent): EventView {
	return {
		id: event.id,
		toolCallId: event.toolCallId,
		conversationId: event.conversationId,
		sessionId: event.sessionId,
		attemptId: event.attemptId,
		parentEventId: event.parentEventId,
		kind: event.kind,
		tool: event.tool,
		namespace: event.namespace,
		version: event.version,
		configHash: event.configHash,
		opHash: event.opHash,
		beforeHash: event.beforeHash,
		afterHash: event.afterHash,
	};
}

function short(hash: string | null | undefined): string {
	return hash === null || hash === undefined ? "-" : hash.slice(0, 12);
}


// ── Journal: schema, migrations, events, FTS5 (spec §4, §5, §9 M2) ────────────────────────────────

/** Exact column names AND declared types per §4 table, in order ("name:TYPE,..."), from PRAGMA table_info. */
const SPEC_TYPES: Record<string, string> = {
	sessions: "id:TEXT,conversationId:TEXT,domain:TEXT,tool:TEXT,configHash:TEXT,arm:TEXT,seed:INTEGER,outcome:TEXT,startedAt:TEXT,endedAt:TEXT",
	attempts: "id:TEXT,sessionId:TEXT,attemptIndex:INTEGER,status:TEXT,boundaryF:REAL,startedAt:TEXT,endedAt:TEXT",
	events: "id:TEXT,toolCallId:TEXT,conversationId:TEXT,sessionId:TEXT,attemptId:TEXT,parentEventId:TEXT,kind:TEXT,tool:TEXT,namespace:TEXT,version:INTEGER,configHash:TEXT,opHash:TEXT,beforeHash:TEXT,afterHash:TEXT,createdAt:TEXT",
	evaluations: "id:TEXT,eventId:TEXT,attemptId:TEXT,sessionId:TEXT,source:TEXT,boundaryF:REAL,score:REAL,abstain:INTEGER,probability:REAL,calibratedProbability:REAL,evidenceRefs:TEXT,createdAt:TEXT",
	knowledge_nodes: "id:TEXT,kind:TEXT,statement:TEXT,domain:TEXT,originTools:TEXT,verifiedTools:TEXT,hypothesizedTools:TEXT,excludedTools:TEXT,supportingEvidence:TEXT,contradictingEvidence:TEXT,status:TEXT,configHash:TEXT,createdAt:TEXT,updatedAt:TEXT",
	knowledge_relations: "id:TEXT,fromNodeId:TEXT,toNodeId:TEXT,relation:TEXT,createdAt:TEXT",
	procedures: "id:TEXT,name:TEXT,nodeId:TEXT,params:TEXT,body:TEXT,status:TEXT,configHash:TEXT,trials:INTEGER,createdAt:TEXT,updatedAt:TEXT",
	transfer_records: "id:TEXT,nodeId:TEXT,fromTool:TEXT,toTool:TEXT,status:TEXT,experimentId:TEXT,createdAt:TEXT,updatedAt:TEXT",
	experiments: "id:TEXT,nodeId:TEXT,name:TEXT,taskSet:TEXT,arm:TEXT,status:TEXT,result:TEXT,startedAt:TEXT,endedAt:TEXT,createdAt:TEXT",
	retrievals: "id:TEXT,sessionId:TEXT,nodeId:TEXT,rank:INTEGER,createdAt:TEXT",
};

function columnSpecs(db: DatabaseSync, table: string): string {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row) => `${String((row as Record<string, unknown>).name)}:${String((row as Record<string, unknown>).type ?? "")}`)
		.join(",");
}

function assertJournalSchema(journal: Journal, db: DatabaseSync): void {
	assert.equal(journal.schemaVersion(), JOURNAL_SCHEMA_VERSION, "fresh DB is at the current schema version");
	const objects = journal.schemaObjects();
	const names = new Set(objects.map((o) => o.name));
	for (const table of JOURNAL_TABLES) if (!names.has(table)) fail(`table "${table}" was not created by the migration`);
	for (const fts of JOURNAL_FTS_TABLES) if (!names.has(fts)) fail(`FTS5 table "${fts}" was not created by the migration`);

	console.log(`schema: ${JOURNAL_TABLES.length} §4 tables + ${JOURNAL_FTS_TABLES.length} FTS5 tables, version ${journal.schemaVersion()}`);
	for (const table of JOURNAL_TABLES) {
		const actual = columnSpecs(db, table);
		if (actual !== SPEC_TYPES[table]) fail(`table "${table}" columns/types differ:\n    actual:   ${actual}\n    expected: ${SPEC_TYPES[table]}`);
		console.log(`  ${table}(${actual.split(",").map((c) => c.replace(":", " ")).join(", ")})`);
	}
	for (const fts of JOURNAL_FTS_TABLES) {
		const row = objects.find((o) => o.name === fts);
		if (row === undefined || !/USING\s+fts5/i.test(row.sql)) fail(`"${fts}" is not an FTS5 virtual table`);
		console.log(`  ${fts}: ${row.sql.replace(/\s+/g, " ")}`);
	}
	if (journal.fts5Available() !== true) fail("FTS5 is not available in this SQLite build");

	db.prepare("INSERT INTO events_fts (eventId, toolCallId, conversationId, tool, opHash) VALUES (?, ?, ?, ?, ?)").run("evt-1", "call-1", "conv-1", "paint", "hash-alpha");
	db.prepare("INSERT INTO events_fts (eventId, toolCallId, conversationId, tool, opHash) VALUES (?, ?, ?, ?, ?)").run("evt-2", "call-2", "conv-1", "pen", "hash-beta");
	db.prepare("INSERT INTO knowledge_fts (nodeId, statement, kind, domain) VALUES (?, ?, ?, ?)").run("node-1", "Close a circle with one continuous stroke", "tactic", "painting");
	const events = db.prepare("SELECT eventId, toolCallId, tool FROM events_fts WHERE events_fts MATCH ? ORDER BY rank").all("pen") as Record<string, unknown>[];
	const nodes = db.prepare("SELECT nodeId, kind FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank").all("continuous") as Record<string, unknown>[];
	if (events.length !== 1 || String(events[0]!.toolCallId) !== "call-2") fail(`events_fts MATCH "pen" returned ${JSON.stringify(events)}`);
	if (nodes.length !== 1 || String(nodes[0]!.nodeId) !== "node-1") fail(`knowledge_fts MATCH "continuous" returned ${JSON.stringify(nodes)}`);
	console.log(`FTS5 MATCH "pen" -> ${events.map((r) => `${r.toolCallId}(${r.tool})`).join(", ")}`);
	console.log(`FTS5 MATCH "continuous" -> ${nodes.map((r) => `${r.nodeId}(${r.kind})`).join(", ")}`);
}

function journalSchemaCase(): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path);
	const db = new DatabaseSync(path);
	try {
		console.log(`node ${process.version}`);
		assertJournalSchema(journal, db);
		console.log("PASS schema: all ten §4 tables + both FTS5 tables on a fresh DB, columns/types exact, MATCH returns the inserted rows");
	} finally {
		db.close();
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

function journalNegativeCase(): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path);
	const db = new DatabaseSync(path);
	try {
		console.log(`negative control: dropping table "retrievals" from ${path}`);
		db.exec("DROP TABLE retrievals");
		assertJournalSchema(journal, db);
		fail("the negative control passed even though a §4 table was dropped");
	} finally {
		db.close();
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

function journalMigrateCase(): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path);
	try {
		const before = JSON.stringify(journal.schemaObjects());
		const versionBefore = journal.schemaVersion();
		journal.migrate();
		journal.migrate();
		const after = JSON.stringify(journal.schemaObjects());
		if (before !== after) fail("re-running the migration path changed the schema");
		if (journal.schemaVersion() !== versionBefore) fail("re-running the migration path changed the schema version");
		assert.equal(journal.countEvents(), 0, "a re-run writes no data");
		console.log(`migrate: schema unchanged after 3 migration runs (version ${journal.schemaVersion()}, ${journal.schemaObjects().length} objects)`);
		console.log("PASS migrate: the migration path is re-runnable and idempotent");
	} finally {
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

function journalIdempotentCase(): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path);
	try {
		const event = {
			toolCallId: "call-dup",
			conversationId: "conv-1",
			tool: "paint",
			opHash: hashOp({ points: [[1, 2], [3, 4]], width: 5 }),
			beforeHash: "a".repeat(64),
			afterHash: "b".repeat(64),
		};
		const first = journal.recordEvent(event);
		const second = journal.recordEvent(event);
		assert.equal(first, true, "the first write inserts a row");
		assert.equal(second, false, "the second write of the same toolCallId is ignored");
		assert.equal(journal.countEvents(), 1, "exactly one row exists after writing the same toolCallId twice");
		const stored = journal.getEventByToolCallId("call-dup");
		assert.ok(stored, "the event is readable by toolCallId");
		console.log(`idempotent: wrote toolCallId "call-dup" twice -> ${journal.countEvents()} row (INSERT OR IGNORE)`);
		console.log("PASS idempotent: a repeated toolCallId never creates a second row");
	} finally {
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

function journalAppendOnlyCase(skipUniquenessGuard = false): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path, { enforceToolCallIdUniqueness: !skipUniquenessGuard });
	const conversationId = "conv-append-only";
	const toolCallId = "call-append-1";
	const original = {
		toolCallId,
		conversationId,
		kind: "action" as const,
		tool: "paint",
		namespace: CANVAS_NAMESPACE,
		version: 1,
		configHash: "cfg-original",
		opHash: hashOp({ points: [[10, 20], [30, 40]], width: 5 }),
		beforeHash: "a".repeat(64),
		afterHash: "b".repeat(64),
	};
	try {
		console.log(`append-only: UNIQUE(toolCallId) ${skipUniquenessGuard ? "OFF (negative control)" : "ON"}`);
		assert.equal(journal.recordEvent({ ...original, id: "evt_append_seed" }), true, "the first write inserts the row");
		const before = journal.countEvents();
		let accepted = 0;
		for (let i = 0; i < 5; i++) {
			if (journal.recordEvent({ ...original, id: `evt_append_attempt_${i}` })) accepted++;
		}
		const after = journal.countEvents();
		console.log(`five identical re-inserts of toolCallId "${toolCallId}": rows before=${before} after=${after}, accepted=${accepted} (INSERT OR IGNORE)`);
		assert.equal(after, before, "five re-inserts leave the events row count unchanged");
		assert.equal(accepted, 0, "all five re-inserts are ignored");
		const afterDuplicates = after;

		for (let i = 1; i <= 3; i++) {
			assert.equal(
				journal.recordEvent({
					toolCallId: `call-distinct-${i}`,
					conversationId,
					tool: "paint",
					opHash: hashOp({ points: [[i, i]], width: 2 }),
					beforeHash: sha256Hex(`before-${i}`),
					afterHash: sha256Hex(`after-${i}`),
				}),
				true,
				`distinct toolCallId call-distinct-${i} is inserted`,
			);
		}
		const afterDistinct = journal.countEvents();
		console.log(`three further distinct toolCallIds: rows ${afterDuplicates} -> ${afterDistinct} (added ${afterDistinct - afterDuplicates})`);
		assert.equal(afterDistinct - afterDuplicates, 3, "three distinct toolCallIds add exactly three rows");

		const conflicting = {
			...original,
			id: "evt_append_conflict",
			tool: "reset_canvas",
			opHash: hashOp({ different: true }),
			beforeHash: "c".repeat(64),
			afterHash: "d".repeat(64),
		};
		const conflictAccepted = journal.recordEvent(conflicting);
		const stored = journal.getEventByToolCallId(toolCallId);
		assert.ok(stored, "the first event is readable by toolCallId");
		console.log(`conflicting re-insert of "${toolCallId}" accepted=${conflictAccepted}; stored row:`);
		console.log(JSON.stringify(stored));
		assert.equal(conflictAccepted, false, "the conflicting re-insert is ignored");
		assert.equal(stored.tool, original.tool, "the original tool name is unchanged");
		assert.equal(stored.opHash, original.opHash, "the original op hash is unchanged");
		assert.equal(stored.beforeHash, original.beforeHash, "the original before hash is unchanged");
		assert.equal(stored.afterHash, original.afterHash, "the original after hash is unchanged");

		const events = journal.listEvents(conversationId);
		const distinct = new Set(events.map((event) => event.toolCallId));
		console.log(`final: events rows=${journal.countEvents()}, distinct toolCallIds=${distinct.size}`);
		assert.equal(journal.countEvents(), distinct.size, "row count equals the number of distinct toolCallIds");
		assert.deepEqual(duplicateToolCallIds(path), [], "no toolCallId appears in the events table twice");
		console.log("PASS append-only: INSERT OR IGNORE keeps one row per toolCallId and the first payload wins");
	} finally {
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function journalWiringCase(): Promise<void> {
	const dataDir = await mkdtemp(join(tmpdir(), "elr-journal-wiring-"));
	process.env.DATA_DIR = dataDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const { harness, registry, conversationId } = await openHarness(dataDir);
	try {
		const tools = canvasTools(registry);
		const strokes: [number, number][][] = [
			[[10, 10], [20, 20]],
			[[30, 30], [40, 40]],
		];
		for (let i = 0; i < strokes.length; i++) {
			const result = await runAction(tools, { tool: "paint", args: { points: strokes[i], width: 4 }, attempt: 0 }, harness, registry, conversationId, `call-wire-${i + 1}`);
			assert.notEqual(result.isError, true, "paint succeeds");
		}

		const journal = new Journal(join(dataDir, JOURNAL_DB_FILE));
		try {
			const events = journal.listEvents(conversationId);
			assert.equal(events.length, 2, "two paint calls wrote two action events");
			assert.equal(events[0]!.parentEventId, null, "the first action has no parent");
			assert.equal(events[1]!.parentEventId, events[0]!.id, "the second action links to the first");
			assert.equal(events[1]!.beforeHash, events[0]!.afterHash, "raster hashes chain stroke to stroke");
			assert.ok(events.every((e) => e.tool === "paint" && e.namespace === CANVAS_NAMESPACE && e.attemptId === `${conversationId}#0`), "tool identity and attempt recorded");
			for (const event of events) console.log(`  ${event.toolCallId} parent=${short(event.parentEventId)} before=${short(event.beforeHash)} after=${short(event.afterHash)}`);
			console.log("PASS wiring: the canvas paint tool writes linked action events with chained before/after hashes");
		} finally {
			journal.close();
		}
	} finally {
		resetJournalCache();
		await harness.close(BACKGROUND_CONTEXT);
		rmSync(dataDir, { recursive: true, force: true });
	}
}

function journalFtsCase(): void {
	const { path, dir } = tempDb();
	const journal = new Journal(path);
	try {
		console.log(`node ${process.version}`);
		const available = journal.fts5Available();
		console.log(`FTS5 available: ${available}`);
		if (!available) fail("FTS5 is not available in this SQLite build");

		const tools = ["paint", "paint", "pen"];
		const opHashes = tools.map((tool, i) => hashOp({ tool, index: i }));
		for (let i = 0; i < tools.length; i++) {
			journal.recordEvent({
				toolCallId: `call-fts-${i}`,
				conversationId: "conv-fts",
				tool: tools[i]!,
				opHash: opHashes[i]!,
				beforeHash: sha256Hex(`before-${i}`),
				afterHash: sha256Hex(`after-${i}`),
			});
		}
		const byTool = journal.searchEvents("pen");
		const byHash = journal.searchEvents(opHashes[1]!);
		if (byTool.length !== 1 || byTool[0]!.toolCallId !== "call-fts-2") fail(`MATCH tool=pen returned ${JSON.stringify(byTool.map((e) => e.toolCallId))}`);
		if (byHash.length !== 1 || byHash[0]!.toolCallId !== "call-fts-1") fail(`MATCH opHash returned ${JSON.stringify(byHash.map((e) => e.toolCallId))}`);

		journal.recordKnowledgeNode({ kind: "tactic", statement: "Close a circle with one continuous stroke before adding detail", domain: "painting", originTools: ["brush"] });
		const nodes = journal.searchKnowledge("continuous");
		if (nodes.length !== 1 || nodes[0]!.kind !== "tactic") fail(`MATCH knowledge returned ${JSON.stringify(nodes)}`);

		console.log(`FTS5 hits for "pen": ${byTool.map((e) => `${e.toolCallId}(${e.tool})`).join(", ")}`);
		console.log(`FTS5 hits for opHash ${opHashes[1]!.slice(0, 12)}…: ${byHash.map((e) => e.toolCallId).join(", ")}`);
		console.log(`FTS5 hits for "continuous" (knowledge_fts): ${nodes.map((n) => n.id).join(", ")}`);
		console.log("PASS fts: FTS5 MATCH returns the expected events");
	} finally {
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── Scripted episode through the real tools (spec §3, §4, §9 M2) ──────────────────────────────────

async function sixCase(episode: EpisodeResult): Promise<void> {
	const { events, conversationId, rasterFiles } = episode;
	if (events.length !== 6) fail(`expected exactly 6 action events, got ${events.length}`);
	if (rasterFiles.length !== events.length + 1) fail(`expected ${events.length + 1} raster artifacts, got ${rasterFiles.length}`);
	const files = await Promise.all(rasterFiles.map(async (file) => ({ name: basename(file), hash: sha256Hex(await readFile(file)) })));
	const attemptId = `${conversationId}#1`;
	console.log("event rows (one per action event, in order):");
	for (let i = 0; i < events.length; i++) {
		const e = events[i]!;
		console.log(`  ${i + 1}. id=${e.id} toolCallId=${e.toolCallId} tool=${e.tool} attempt=${e.attemptId} parent=${e.parentEventId ?? "(none)"} before=${e.beforeHash} after=${e.afterHash}`);
		const parent = i === 0 ? null : events[i - 1]!.id;
		if (e.kind !== "action") fail(`event ${i + 1} kind=${e.kind}`);
		if (e.attemptId !== attemptId) fail(`event ${i + 1} (${e.toolCallId}) attempt=${e.attemptId}, expected ${attemptId}`);
		if (e.parentEventId !== parent) fail(`event ${i + 1} (${e.toolCallId}) parent=${e.parentEventId}, expected ${parent ?? "(none)"}`);
	}
	console.log("per-action raster: recorded hash vs sha256 recomputed from the file on disk:");
	for (let i = 0; i < events.length; i++) {
		const e = events[i]!;
		for (const [side, recorded, file] of [["before", e.beforeHash, files[i]!], ["after", e.afterHash, files[i + 1]!]] as const) {
			const match = recorded === file.hash;
			console.log(`  ${e.toolCallId} ${side}=${recorded} file[${file.name}]=${file.hash} match=${match ? "yes" : "NO"}`);
			if (!match) fail(`event ${i + 1} (${e.toolCallId}) ${side}Hash ${recorded} != file hash ${file.hash}`);
		}
	}
	console.log(`checks: 6 events, all attempt=${attemptId}, event 1 parent=(none), events 2-6 chain, every before/after hash equals the on-disk raster hash`);
	console.log("PASS six: six correctly linked, hash-verified action events through the real canvas tools");
}

async function episodeNegativeCase(): Promise<void> {
	const episode = await runScriptedEpisode(SIX_ACTION_EPISODE, "sx");
	try {
		const wrong = "0".repeat(64);
		const events = episode.events.map((event, i) => (i === 2 ? { ...event, afterHash: wrong } : event));
		console.log(`NEGATIVE CONTROL: event 3 (${events[2]!.toolCallId}) recorded afterHash replaced with ${wrong}`);
		await sixCase({ ...episode, events });
		fail("the negative control passed even though event 3's recorded afterHash was corrupted");
	} finally {
		await episode.cleanup();
	}
}

async function productionCase(): Promise<void> {
	const canvasSource = await readFile(join(repoRoot, "src", "elr", "canvas.ts"), "utf8");
	const journalSource = await readFile(join(repoRoot, "src", "elr", "journal.ts"), "utf8");
	if (!canvasSource.includes("journalFor().recordCanvasAction(")) fail("src/elr/canvas.ts does not call journalFor().recordCanvasAction() — the tools are not wired to the journal");
	if (!/function recordAction\(/.test(canvasSource)) fail("src/elr/canvas.ts has no recordAction() used by the canvas tools");
	if (!/recordCanvasAction\(input:/.test(journalSource)) fail("src/elr/journal.ts has no Journal.recordCanvasAction()");
	if (!/INSERT OR IGNORE INTO events/.test(journalSource)) fail("src/elr/journal.ts does not use INSERT OR IGNORE for events");

	console.log("production write path (the same functions the canvas tools call):");
	for (const step of PRODUCTION_WRITE_PATH) console.log(`  ${step}`);
	for (const tool of ["paint", "reset_canvas", "done"]) {
		if (!new RegExp(`recordAction\\(api, \\{ tool: "${tool}"`).test(canvasSource)) fail(`the canvas ${tool} tool does not call recordAction()`);
		console.log(`  ${tool} -> recordAction(api, { tool: "${tool}", ... })`);
	}
	console.log("PASS production: events are written by src/elr/canvas.ts recordAction() through Journal.recordCanvasAction()/recordEvent()");
}


// ── Boot reconciler and crash-resume (spec §3, §4, §9 M2) ─────────────────────────────────────────

/** Run all six actions through the real tools with a normal journal: the "uninterrupted episode". */
async function runReferenceEpisode(dataDir: string): Promise<EventView[]> {
	process.env.DATA_DIR = dataDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const { harness, registry, conversation, conversationId } = await openHarness(dataDir);
	const tools = canvasTools(registry);
	const callIds = scriptedCallIds();
	for (let i = 0; i < SCRIPTED_EPISODE.length; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`reference action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
	}
	const journal = journalFor(join(dataDir, JOURNAL_DB_FILE));
	const events = journal.listEvents(conversationId).map(view);
	journal.close();
	resetJournalCache();
	await harness.close(BACKGROUND_CONTEXT);
	return events;
}

function eventFieldDiff(a: readonly EventView[], b: readonly EventView[]): string[] {
	const diffs: string[] = [];
	if (a.length !== b.length) diffs.push(`row count ${a.length} vs ${b.length}`);
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		for (const field of Object.keys(a[i]!) as (keyof EventView)[]) {
			if (a[i]![field] !== b[i]![field]) diffs.push(`${a[i]!.toolCallId}.${field}: ${JSON.stringify(a[i]![field])} vs ${JSON.stringify(b[i]![field])}`);
		}
	}
	return diffs;
}

function printEventSet(label: string, events: readonly EventView[]): void {
	console.log(`${label} (${events.length} events):`);
	for (const event of events) {
		console.log(
			`  ${event.toolCallId} id=${event.id} tool=${event.tool} attempt=${event.attemptId} parent=${event.parentEventId ?? "-"} op=${short(event.opHash)} before=${short(event.beforeHash)} after=${short(event.afterHash)}`,
		);
	}
}

async function reconcileCrashCase(): Promise<void> {
	const base = tempDir("elr-reconcile-");
	const persistent = join(base, "persistent");
	const referenceDir = join(base, "run-a");
	const lossDir = join(base, "deliberate-loss");
	const resultJson = join(persistent, "resume-result.json");
	try {
		const reference = await runReferenceEpisode(referenceDir);
		printEventSet("run A (uninterrupted)", reference);

		const crash = spawnChild(["reconcile", "crash3", persistent]);
		console.log(`run B kill: child exit status=${crash.status} signal=${crash.signal}`);
		if (crash.stderr) console.log(`run B kill stderr:\n${crash.stderr.trim()}`);
		if (crash.signal !== "SIGKILL") fail(`expected the run B child to die by SIGKILL, got status=${crash.status} signal=${crash.signal}`);

		const markerPath = join(persistent, "crash3.json");
		if (!existsSync(markerPath)) fail("the run B child wrote no marker; the transcript may not have committed");
		const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { conversationId: string; journalEvents: EventView[]; journalEventCount: number };
		assert.equal(marker.journalEvents.length, 3, `the journal state at kill time must be exactly the first 3 events, had ${marker.journalEvents.length}`);
		assert.deepEqual(marker.journalEvents.map((event) => event.toolCallId), scriptedCallIds().slice(0, 3), "the events at kill time are not the first three scripted actions");
		printEventSet("run B journal state at kill time (SIGKILL after action 3)", marker.journalEvents);

		const resumed = spawnChild(["reconcile", "resume3", persistent, resultJson]);
		if (resumed.status !== 0) fail(`resume3 child exited ${resumed.status}\nstdout:\n${resumed.stdout}\nstderr:\n${resumed.stderr}`);
		if (resumed.stdout) process.stdout.write(resumed.stdout);
		if (resumed.stderr) process.stdout.write(resumed.stderr);
		const result = JSON.parse(readFileSync(resultJson, "utf8")) as { before: EventView[]; inserted: number; final: EventView[] };

		assert.equal(result.before.length, 3, `run B must resume from exactly the 3 events of the crashed run, found ${result.before.length}`);
		assert.deepEqual(result.before.map((event) => event.toolCallId), scriptedCallIds().slice(0, 3), "the resume did not start from the crashed run's three events");
		assert.equal(result.inserted, 0, `the reconciler must add nothing when nothing is missing, inserted ${result.inserted}`);
		assert.deepEqual(result.final, reference, "run B's final event set differs from run A's");

		const finalIds = result.final.map((e) => e.toolCallId);
		const uniqueIds = new Set(finalIds);
		assert.equal(uniqueIds.size, finalIds.length, "duplicate toolCallIds in run B's final journal");
		assert.equal(result.final.length, 6, `expected the full six-event episode, got ${result.final.length}`);
		assert.equal(new Set(result.final.map((e) => e.attemptId)).size, 2, "both attempts are represented");
		const dupes = duplicateToolCallIds(join(persistent, JOURNAL_DB_FILE));
		assert.deepEqual(dupes, [], `SQL duplicate toolCallId check found ${JSON.stringify(dupes)}`);
		const check = spawnChild(["reconcile", "check", join(persistent, JOURNAL_DB_FILE), String(result.final.length)]);
		if (check.status !== 0) fail(`the standalone checker rejected run B's journal (exit ${check.status}): ${check.stderr}`);
		console.log(`no duplicate toolCallIds: ${finalIds.length} events, ${uniqueIds.size} distinct ids; checker: ${check.stdout.trim()}`);
		printEventSet("run B (SIGKILL after action 3, then resume)", result.final);

		const fieldDiffs = eventFieldDiff(reference, result.final);
		console.log(`diff run A vs run B: compared ${reference.length} events x 13 fields, ${fieldDiffs.length} field differences`);
		if (fieldDiffs.length > 0) fail(`run A and run B differ on ${fieldDiffs.length} field(s): ${fieldDiffs.slice(0, 4).join("; ")}`);

		const lossEvents = await runReferenceEpisode(lossDir);
		const target = lossEvents[2]!;
		const lossJournalPath = join(lossDir, JOURNAL_DB_FILE);
		const raw = new DatabaseSync(lossJournalPath);
		const deleted = raw.prepare("DELETE FROM events WHERE toolCallId = ?").run(target.toolCallId);
		const remaining = Number((raw.prepare("SELECT COUNT(*) AS c FROM events").get() as Record<string, unknown>).c);
		raw.close();
		assert.equal(Number(deleted.changes), 1, `expected to delete exactly one event row, deleted ${deleted.changes}`);
		assert.equal(remaining, 5, `expected 5 events after the deletion, found ${remaining}`);
		console.log(`deliberate loss: DELETE FROM events WHERE toolCallId='${target.toolCallId}' directly in ${lossJournalPath} (rows 6 -> ${remaining})`);
		console.log(`  removed row:    ${JSON.stringify(target)}`);

		resetJournalCache();
		const lossHarness = await openHarness(lossDir);
		try {
			const lossJournal = journalFor(lossJournalPath);
			const reinserted = await bootReconcile(lossJournal, lossHarness.conversation, BACKGROUND_CONTEXT);
			const rederived = lossJournal.getEventByToolCallId(target.toolCallId);
			assert.equal(reinserted, 1, `the reconciler must re-derive exactly the one deleted event, inserted ${reinserted}`);
			assert.ok(rederived !== undefined, `the deleted event ${target.toolCallId} was not re-derived`);
			const rederivedView = view(rederived);
			console.log(`  re-derived row: ${JSON.stringify(rederivedView)}`);
			assert.deepEqual(rederivedView, target, "the re-derived row differs from the deleted row");
			console.log(`  identical: attempt=${rederivedView.attemptId} parent=${rederivedView.parentEventId} op=${short(rederivedView.opHash)} before=${short(rederivedView.beforeHash)} after=${short(rederivedView.afterHash)}`);
		} finally {
			resetJournalCache();
			await lossHarness.harness.close(BACKGROUND_CONTEXT);
		}

		console.log("PASS crash: SIGKILL after action 3 with exactly 3 journal events, resume adds no duplicates, run B equals run A on every field; the reconciler re-derived a deliberately deleted row identically");
	} finally {
		resetJournalCache();
		rmSync(base, { recursive: true, force: true });
	}
}

function reconcileNegativeCase(): void {
	const dir = tempDir("elr-reconcile-negative-");
	const journalPath = join(dir, JOURNAL_DB_FILE);
	try {
		console.log("positive control: a clean journal with 3 unique toolCallIds");
		const clean = new Journal(journalPath, { enforceToolCallIdUniqueness: false });
		for (let i = 1; i <= 3; i++) {
			clean.recordEvent({
				id: `evt_neg_seed_${i}`,
				toolCallId: `neg-${i}`,
				conversationId: "conv-neg",
				tool: "paint",
				opHash: hashOp({ neg: i }),
				beforeHash: short(sha256Hex(`before-${i}`)),
				afterHash: short(sha256Hex(`after-${i}`)),
			});
		}
		clean.close();

		const cleanCheck = spawnChild(["reconcile", "check", journalPath, "3"]);
		if (cleanCheck.status !== 0) fail(`the checker rejected a clean journal (exit ${cleanCheck.status}): ${cleanCheck.stderr}`);
		console.log(`  checker on the clean journal: exit ${cleanCheck.status} (${cleanCheck.stdout.trim()})`);

		const db = new DatabaseSync(journalPath);
		db.prepare(
			"INSERT INTO events (id, toolCallId, conversationId, kind, tool, opHash, beforeHash, afterHash, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run("evt_neg_injected", "neg-2", "conv-neg", "action", "paint", "op-injected", "b-injected", "a-injected", new Date().toISOString());
		db.close();
		const dupes = duplicateToolCallIds(journalPath);
		assert.deepEqual(dupes, ["neg-2"], `the SQL duplicate query did not see the injected duplicate: ${JSON.stringify(dupes)}`);
		console.log(`injected duplicate: toolCallId 'neg-2' appears ${2} times (SQL GROUP BY ... HAVING c > 1: ${JSON.stringify(dupes)})`);

		const bad = spawnChild(["reconcile", "check", journalPath, "4"]);
		if (bad.status === 0) fail("the checker exited 0 on a journal with an injected duplicate toolCallId");
		console.log(`negative: checker exit code = ${bad.status} (non-zero as required)`);
		if (bad.stderr) console.log(`  checker stderr: ${bad.stderr.trim()}`);
		console.log("PASS negative: duplicate detection rejects an injected duplicate toolCallId (non-zero), and accepts a clean journal (zero)");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function reconcileIdempotentCase(): Promise<void> {
	const base = tempDir("elr-reconcile-idem-");
	const persistent = join(base, "persistent");
	const lost = join(base, "lost-journal");
	try {
		const crash = spawnChild(["reconcile", "pre-crash", persistent, lost]);
		if (crash.signal !== "SIGKILL") fail(`expected SIGKILL, got status=${crash.status} signal=${crash.signal}`);

		process.env.DATA_DIR = persistent;
		process.env.OPENROUTER_API_KEY ||= "unused";
		resetJournalCache();
		const { harness, conversation, conversationId } = await openHarness(persistent);
		const journal = journalFor(join(persistent, JOURNAL_DB_FILE));

		const first = await bootReconcile(journal, conversation, BACKGROUND_CONTEXT);
		const idsAfterFirst = journal.listEvents(conversationId).map((e) => e.id);
		const countAfterFirst = journal.countEvents();
		const second = await bootReconcile(journal, conversation, BACKGROUND_CONTEXT);
		const idsAfterSecond = journal.listEvents(conversationId).map((e) => e.id);
		const countAfterSecond = journal.countEvents();

		assert.equal(first, 3, "the first reconcile inserts the 3 missing events");
		assert.equal(second, 0, "the second reconcile inserts nothing");
		assert.equal(countAfterSecond, countAfterFirst, `row count changed on the second run (${countAfterFirst} -> ${countAfterSecond})`);
		assert.deepEqual(idsAfterSecond, idsAfterFirst, "event ids changed on the second run");

		console.log(`idempotent: first reconcile inserted ${first} events (${countAfterFirst} rows), second inserted ${second} (${countAfterSecond} rows), ids unchanged`);
		console.log(SYNTHETIC_LOSS_CAVEAT);
		console.log("PASS idempotent: running the reconciler twice leaves the row count and ids unchanged");

		journal.close();
		resetJournalCache();
		await harness.close(BACKGROUND_CONTEXT);
	} finally {
		resetJournalCache();
		rmSync(base, { recursive: true, force: true });
	}
}

/**
 * Convergence proof (ELR M2 hygiene): a deferred, chunked, interrupted reconcile must converge to
 * exactly the same journal event set as an uninterrupted one — no duplicates, no gaps, no value
 * drift. Three scenarios run in one command, each on its own throwaway DATA_DIR with an identical,
 * deterministic synthetic transcript:
 *   (a) uninterrupted: open + full reconcile, snapshot the journal as a map toolCallId -> payload;
 *   (b) interrupted then resumed: the real chunked reconcile is aborted after a real prefix (>=100
 *       committed rows) by wrapping the real `Journal.reconcile`, the journal is closed, and a fresh
 *       boot on the same DATA_DIR re-derives the rest;
 *   (c) idempotency: the reconcile is run once more over the finished journal and must insert 0.
 * It asserts (b) and (c) equal (a) as sets and per-key values, that no toolCallId is duplicated and
 * no key is missing, and exits non-zero on any mismatch. The abort is driven by committed rows, not
 * a fixed sleep. Run: node bench/journal/proofs.ts reconcile converge  (npm run proof:reconcile).
 */
async function reconcileConvergeCase(): Promise<void> {
	const EVENTS = Number(process.env.ELR_CONVERGE_EVENTS ?? "3000");
	const PREFIX = Number(process.env.ELR_CONVERGE_PREFIX ?? "100");
	if (!Number.isInteger(EVENTS) || EVENTS < 2) fail(`ELR_CONVERGE_EVENTS must be an integer >= 2, got ${process.env.ELR_CONVERGE_EVENTS}`);
	if (!Number.isInteger(PREFIX) || PREFIX < 1 || PREFIX >= EVENTS) fail(`ELR_CONVERGE_PREFIX must be an integer in [1, ${EVENTS - 1}], got ${process.env.ELR_CONVERGE_PREFIX}`);
	process.env.OPENROUTER_API_KEY ||= "unused";

	const base = tempDir("elr-converge-");
	const dirA = join(base, "a");
	const dirB = join(base, "b");
	const journalA = join(dirA, JOURNAL_DB_FILE);
	const journalB = join(dirB, JOURNAL_DB_FILE);
	const seedTimestamp = 1_700_000_000_000;
	try {
		console.log(`converge: seeding ${EVENTS} deterministic transcript actions into two throwaway DATA_DIRs ...`);
		await seedSyntheticCanvasTranscript(dirA, EVENTS, seedTimestamp);
		await seedSyntheticCanvasTranscript(dirB, EVENTS, seedTimestamp);
		for (const journal of [journalA, journalB]) for (const suffix of ["", "-wal", "-shm"]) rmSync(journal + suffix, { force: true });

		// (a) uninterrupted: open the journal, run the whole reconcile, snapshot.
		resetJournalCache();
		const harnessA = await openHarness(dirA);
		let countA = 0;
		let insertedA = 0;
		let snapA = new Map<string, string>();
		try {
			const openA = openBootJournal({ harness: harnessA.harness, context: BACKGROUND_CONTEXT, journalPath: journalA, transcriptPath: join(dirA, AGENT_DB_FILE) });
			insertedA = (await reconcileBootJournal(openA, { harness: harnessA.harness, context: BACKGROUND_CONTEXT })).inserted;
			countA = openA.journal.countEvents();
			openA.journal.close();
			snapA = snapshotEvents(journalA);
		} finally {
			resetJournalCache();
			await harnessA.harness.close(BACKGROUND_CONTEXT);
		}
		console.log(`scenario (a) uninterrupted:          transcript=${EVENTS} journalEvents=${countA} inserted=${insertedA}`);

		// (b) interrupted then resumed: abort the real chunked reconcile after a real committed prefix.
		resetJournalCache();
		const harnessB = await openHarness(dirB);
		let prefix = 0;
		let interrupted = false;
		try {
			const openB = openBootJournal({ harness: harnessB.harness, context: BACKGROUND_CONTEXT, journalPath: journalB, transcriptPath: join(dirB, AGENT_DB_FILE) });
			const journal = openB.journal;
			const realReconcile = journal.reconcile.bind(journal);
			const patched = journal as unknown as { reconcile: (calls: readonly TranscriptCall[]) => number };
			patched.reconcile = (calls) => {
				if (journal.countEvents() >= PREFIX) {
					interrupted = true;
					throw new Error("elr-converge: deliberate interruption after a real committed prefix");
				}
				return realReconcile(calls);
			};
			try {
				await reconcileBootJournal(openB, { harness: harnessB.harness, context: BACKGROUND_CONTEXT });
			} catch (error) {
				if (!interrupted) throw error;
			}
			prefix = journal.countEvents();
			openB.journal.close();
		} finally {
			resetJournalCache();
			await harnessB.harness.close(BACKGROUND_CONTEXT);
		}
		if (!interrupted) fail("scenario (b): the reconcile was never interrupted");
		if (prefix < PREFIX || prefix >= EVENTS) fail(`scenario (b): interruption prefix ${prefix} is not a real prefix of ${EVENTS}`);

		// Resume on the same DATA_DIR, then (c) run the reconcile once more over the finished journal.
		resetJournalCache();
		const harnessB2 = await openHarness(dirB);
		let countB = 0;
		let countC = 0;
		let resumedInserted = 0;
		let idempotentInserted = 0;
		let snapB = new Map<string, string>();
		let snapC = new Map<string, string>();
		try {
			const openB2 = openBootJournal({ harness: harnessB2.harness, context: BACKGROUND_CONTEXT, journalPath: journalB, transcriptPath: join(dirB, AGENT_DB_FILE) });
			resumedInserted = (await reconcileBootJournal(openB2, { harness: harnessB2.harness, context: BACKGROUND_CONTEXT })).inserted;
			countB = openB2.journal.countEvents();
			snapB = snapshotEvents(journalB);
			idempotentInserted = (await reconcileBootJournal(openB2, { harness: harnessB2.harness, context: BACKGROUND_CONTEXT })).inserted;
			countC = openB2.journal.countEvents();
			snapC = snapshotEvents(journalB);
			openB2.journal.close();
		} finally {
			resetJournalCache();
			await harnessB2.harness.close(BACKGROUND_CONTEXT);
		}
		console.log(`scenario (b) interrupted then resumed: transcript=${EVENTS} interruptedPrefix=${prefix} journalEvents=${countB} resumedInserted=${resumedInserted}`);
		console.log(`scenario (c) idempotent re-run:        transcript=${EVENTS} journalEvents=${countC} insertedOnRerun=${idempotentInserted}`);

		// Fault injection for the negative check: delete committed rows from the resumed journal so the
		// resumed set genuinely differs from the uninterrupted one, and the assertions below must fail.
		const injectGap = Number(process.env.ELR_CONVERGE_INJECT_GAP ?? "0");
		if (!Number.isInteger(injectGap) || injectGap < 0) fail(`ELR_CONVERGE_INJECT_GAP must be a non-negative integer, got ${process.env.ELR_CONVERGE_INJECT_GAP}`);
		if (injectGap > 0) {
			const db = new DatabaseSync(journalB);
			try {
				db.prepare("DELETE FROM events WHERE toolCallId IN (SELECT toolCallId FROM events ORDER BY toolCallId LIMIT ?)").run(injectGap);
			} finally {
				db.close();
			}
			snapB = snapshotEvents(journalB);
			countB = countA - injectGap;
			console.log(`negative injection: deleted ${injectGap} committed row(s) from the resumed journal (ELR_CONVERGE_INJECT_GAP) — the assertions must now fail`);
		}

		const duplicates = [...duplicateToolCallIds(journalA), ...duplicateToolCallIds(journalB)];
		const ab = compareSnapshots(snapA, snapB);
		const ac = compareSnapshots(snapA, snapC);

		assert.equal(insertedA, EVENTS, "scenario (a): the uninterrupted reconcile must insert every seeded event");
		assert.equal(countA, EVENTS, "scenario (a): the journal must hold every seeded event");
		assert.equal(resumedInserted, EVENTS - prefix, "scenario (b): the resumed reconcile must insert exactly the missing events");
		assert.equal(countB, EVENTS, "scenario (b): the resumed journal must hold every seeded event");
		assert.equal(idempotentInserted, 0, "scenario (c): the idempotent re-run must insert nothing");
		assert.equal(countC, countA, "scenario (c): the re-run must not change the row count");
		assert.deepEqual(duplicates, [], `duplicate toolCallIds found: ${duplicates.join(", ")}`);
		assert.ok(ab.equal, `scenario (b) differs from (a): missing=${ab.missing.length} extra=${ab.extra.length} differing=${ab.differing.length}`);
		assert.ok(ac.equal, `scenario (c) differs from (a): missing=${ac.missing.length} extra=${ac.extra.length} differing=${ac.differing.length}`);

		// Negative control: the comparison must actually notice a difference (not echo a constant).
		const mutated = new Map(snapA);
		const dropped = [...mutated.keys()][0]!;
		mutated.delete(dropped);
		const negative = compareSnapshots(snapA, mutated);
		if (negative.equal || negative.missing.length !== 1) fail("the snapshot comparison is not sensitive to a dropped key");

		const missing = ab.missing.length + ab.extra.length + ac.missing.length + ac.extra.length;
		const equal = ab.equal && ac.equal;
		console.log(`negative control: dropping toolCallId ${dropped} from the reference is detected (missing=${negative.missing.length}, equal=${negative.equal})`);
		console.log(`convergence: a=${countA} b=${countB} c=${countC} duplicates=${duplicates.length} missing=${missing} equal=${equal}`);
		console.log("PASS converge: the deferred/chunked/interrupted reconcile converges to the uninterrupted event set, with no duplicates and no gaps");
	} finally {
		resetJournalCache();
		rmSync(base, { recursive: true, force: true });
	}
}

/**
 * Duplicate-toolCallId case (ELR M2 hygiene convergence criterion c): a transcript that contains the
 * SAME toolCallId twice must produce exactly one journal row. The dedupe lives in the events table's
 * UNIQUE(toolCallId) + INSERT OR IGNORE (src/elr/journal.ts recordEvent), not in the transcript
 * reader: deriveCanvasCalls() yields one call per tool-result entry, so a duplicated toolCallId is
 * genuinely reconciled twice and the journal collapses it. The counts are read back from the journal
 * SQL itself, not from the reconciler's bookkeeping.
 * Run: node bench/journal/proofs.ts reconcile dup
 */
async function reconcileDupCase(): Promise<void> {
	const dir = tempDir("elr-reconcile-dup-");
	const journalPath = join(dir, JOURNAL_DB_FILE);
	process.env.OPENROUTER_API_KEY ||= "unused";
	const dupId = "dup-call-1";
	try {
		resetJournalCache();
		const { harness, conversation, conversationId } = await openHarness(dir);
		try {
			// Seed a transcript whose canvas entries use the same toolCallId in two separate
			// assistant/tool-result pairs — the duplicate input the criterion is about.
			await conversation.commit(async (tx) => {
				for (let round = 0; round < 2; round++) {
					await tx.appendEntry(conversation.id, {
						kind: "pi.assistant",
						model: [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: dupId, name: "paint", arguments: { points: [[round, round]], width: 2 } }],
							},
						],
					} as never);
					await tx.appendEntry(conversation.id, {
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolCallId: dupId,
								toolName: "paint",
								isError: false,
								timestamp: 1_700_000_000_000 + round,
								content: [{ type: "text", text: "painted" }],
								details: {
									namespace: CANVAS_NAMESPACE,
									version: 1,
									configHash: `dup-${round}`,
									tool: "paint",
									attempt: 0,
									opHash: `op-${round}`,
									beforeHash: `before-${round}`,
									afterHash: `after-${round}`,
								},
							},
						],
					} as never);
				}
			}, BACKGROUND_CONTEXT);

			const transcript = await readConversationTranscript(conversation, BACKGROUND_CONTEXT);
			const derived = deriveCanvasCalls(conversationId, transcript).map((call) => call.toolCallId);
			const occurrences = derived.filter((id) => id === dupId).length;
			console.log(`dup input: transcript toolCallIds = ${JSON.stringify(derived)} (toolCallId "${dupId}" appears ${occurrences}x)`);
			if (occurrences !== 2 || derived.length !== 2) fail(`expected the transcript to contain toolCallId "${dupId}" exactly twice, derived ${derived.length} calls (${occurrences}x "${dupId}")`);

			// Reconcile through the post-fix path (openBootJournal + reconcileBootJournal, the deferred
			// boot halves) with a fresh (absent) journal.
			const open = openBootJournal({ harness, context: BACKGROUND_CONTEXT, journalPath, transcriptPath: join(dir, AGENT_DB_FILE) });
			const { inserted } = await reconcileBootJournal(open, { harness, context: BACKGROUND_CONTEXT });
			const firstRow = open.journal.getEventByToolCallId(dupId);
			open.journal.close();

			const db = new DatabaseSync(journalPath, { readOnly: true });
			const rowsForId = Number((db.prepare("SELECT COUNT(*) AS c FROM events WHERE toolCallId = ?").get(dupId) as { c: number }).c);
			const total = Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
			db.close();
			const dupesInTable = duplicateToolCallIds(journalPath);
			console.log(`dup out: reconcile inserted=${inserted}; journal rows for toolCallId="${dupId}": ${rowsForId} (row: ${JSON.stringify(firstRow)}); total events rows=${total}`);
			console.log(`dup out: SQL "GROUP BY toolCallId HAVING c > 1" over the journal: ${JSON.stringify(dupesInTable)}`);
			assert.equal(inserted, 1, "the reconciler must insert exactly once for the duplicated toolCallId");
			assert.equal(rowsForId, 1, `expected exactly one journal row for toolCallId "${dupId}", found ${rowsForId}`);
			assert.equal(total, 1, "the journal must hold exactly one event in total");
			assert.ok(firstRow, "the event is readable by toolCallId");
			assert.deepEqual(dupesInTable, [], `duplicate toolCallIds found in the journal: ${JSON.stringify(dupesInTable)}`);
			console.log("PASS dup: a transcript containing the same toolCallId twice reconciles to exactly one journal row");
		} finally {
			resetJournalCache();
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		resetJournalCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Deferred/never-run case (ELR M2 hygiene convergence criterion d): with the reconcile disabled or
 * still pending (a boot where the deferred half never ran), the journal stays empty; a later boot's
 * reconcile still re-derives every missing event from the pi-durable transcript and reaches N/N,
 * and a further reconcile on the finished journal inserts nothing. Counts are read back from the
 * journal SQL itself. The transcript size is ELR_DEFERRED_EVENTS (default 80000, the same scale the
 * responsiveness harness uses).
 * Run: node bench/journal/proofs.ts reconcile deferred
 */
async function reconcileDeferredCase(): Promise<void> {
	const EVENTS = Number(process.env.ELR_DEFERRED_EVENTS ?? "80000");
	if (!Number.isInteger(EVENTS) || EVENTS < 1) fail(`ELR_DEFERRED_EVENTS must be a positive integer, got ${process.env.ELR_DEFERRED_EVENTS}`);
	const dir = tempDir("elr-reconcile-deferred-");
	const journalPath = join(dir, JOURNAL_DB_FILE);
	process.env.OPENROUTER_API_KEY ||= "unused";
	try {
		console.log(`deferred: seeding ${EVENTS} deterministic transcript actions into ${join(dir, AGENT_DB_FILE)} ...`);
		await seedSyntheticCanvasTranscript(dir, EVENTS, 1_700_000_000_000);

		// Boot 1: only the synchronous half (open + migrations). The deferred reconcile never runs —
		// as if the process was stopped before startReconcile(). The journal must stay empty.
		resetJournalCache();
		const harnessA = await openHarness(dir);
		let eventsAfterBoot1 = -1;
		try {
			const openA = openBootJournal({ harness: harnessA.harness, context: BACKGROUND_CONTEXT, journalPath, transcriptPath: join(dir, AGENT_DB_FILE) });
			eventsAfterBoot1 = openA.journal.countEvents();
			openA.journal.close();
		} finally {
			resetJournalCache();
			await harnessA.harness.close(BACKGROUND_CONTEXT);
		}
		console.log(`boot 1 (deferred reconcile never ran): journal events=${eventsAfterBoot1}`);
		if (eventsAfterBoot1 !== 0) fail(`boot 1 must leave the journal empty when the reconcile never ran, found ${eventsAfterBoot1}`);

		// A later boot: the deferred reconcile runs (exactly what src/http.ts does from the listen
		// callback), and everything is re-derived from the transcript alone.
		resetJournalCache();
		const harnessB = await openHarness(dir);
		let inserted = -1;
		let rerunInserted = -1;
		try {
			const openB = openBootJournal({ harness: harnessB.harness, context: BACKGROUND_CONTEXT, journalPath, transcriptPath: join(dir, AGENT_DB_FILE) });
			inserted = (await reconcileBootJournal(openB, { harness: harnessB.harness, context: BACKGROUND_CONTEXT })).inserted;
			rerunInserted = (await reconcileBootJournal(openB, { harness: harnessB.harness, context: BACKGROUND_CONTEXT })).inserted;
			openB.journal.close();
		} finally {
			resetJournalCache();
			await harnessB.harness.close(BACKGROUND_CONTEXT);
		}
		const db = new DatabaseSync(journalPath, { readOnly: true });
		const final = Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
		db.close();
		const dupes = duplicateToolCallIds(journalPath);
		console.log(`boot 2 (later boot, deferred reconcile): inserted=${inserted}, further reconcile inserted=${rerunInserted}, journal events=${final}/${EVENTS}, SQL duplicates=${JSON.stringify(dupes)}`);
		assert.equal(inserted, EVENTS, `the later boot must re-derive all ${EVENTS} missing events, inserted ${inserted}`);
		assert.equal(final, EVENTS, `the journal must hold all ${EVENTS} seeded events (N/N), found ${final}`);
		assert.equal(rerunInserted, 0, "a further reconcile over the finished journal must insert nothing");
		assert.deepEqual(dupes, [], `duplicate toolCallIds found in the journal: ${JSON.stringify(dupes)}`);
		console.log("PASS deferred: a boot whose reconcile never ran leaves the journal empty, and a later boot re-derives all N events from the transcript (N/N), idempotently");
	} finally {
		resetJournalCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

async function reconcileTranscriptCase(): Promise<void> {
	const base = tempDir("elr-reconcile-source-");
	const persistent = join(base, "persistent");
	const lost = join(base, "lost-journal");
	try {
		const crash = spawnChild(["reconcile", "pre-crash", persistent, lost]);
		if (crash.signal !== "SIGKILL") fail(`expected SIGKILL, got status=${crash.status} signal=${crash.signal}`);

		const agentDb = join(persistent, AGENT_DB_FILE);
		const db = new DatabaseSync(agentDb);
		let rows: { record: string }[];
		try {
			rows = db.prepare(`SELECT record FROM ${TRANSCRIPT_TABLE} WHERE conversation_id = 1 ORDER BY id ASC`).all() as { record: string }[];
		} finally {
			db.close();
		}
		const canvasToolResults = rows
			.map((row) => JSON.parse(row.record) as { kind?: string; model?: readonly { role?: string; toolName?: string }[] })
			.filter((entry) => entry.kind === "pi.tool-result")
			.flatMap((entry) => (entry.model ?? []).filter((m) => m.role === "toolResult" && typeof m.toolName === "string"))
			.map((m) => m.toolName!);
		if (canvasToolResults.length !== 3) fail(`expected 3 canvas tool results in the entries table, found ${canvasToolResults.length}`);

		process.env.DATA_DIR = persistent;
		process.env.OPENROUTER_API_KEY ||= "unused";
		resetJournalCache();
		const { harness, conversation, conversationId } = await openHarness(persistent);
		const transcript = await readConversationTranscript(conversation, BACKGROUND_CONTEXT);
		const calls = deriveCanvasCalls(conversationId, transcript);
		assert.equal(calls.length, 3, `Conversation.entries gave ${calls.length} canvas calls, expected 3`);
		assert.deepEqual(calls.map((c) => c.toolCallId), scriptedCallIds().slice(0, 3), "the derived toolCallIds are the crashed actions' ids");

		console.log(`transcript source: file=${agentDb}`);
		console.log(`transcript source: table="entries" (pi-durable storage), ${rows.length} entries, ${canvasToolResults.length} canvas tool results [${canvasToolResults.join(", ")}]`);
		console.log(`transcript source: function="Conversation.entries({ order: \\"ascending\\" }, limit, cursor, context)" via src/elr/journal.ts readConversationTranscript() -> deriveCanvasCalls() -> Journal.reconcile()`);
		console.log("PASS transcript: the reconciler reads the pi-durable `entries` table through Conversation.entries()");

		resetJournalCache();
		await harness.close(BACKGROUND_CONTEXT);
	} finally {
		resetJournalCache();
		rmSync(base, { recursive: true, force: true });
	}
}


// ── Boot entry point (spec §3, §4, §9 M2) ────────────────────────────────────────────────────────

type CrashState = {
	base: string;
	persistent: string;
	lost: string;
	conversationId: string;
	preCrashIds: string[];
	firstInserted: number;
	secondInserted: number;
	countAfterFirst: number;
	countAfterSecond: number;
	idsAfterFirst: string[];
	idsAfterSecond: string[];
	final: JournalEvent[];
};

async function bootCrashScenario(): Promise<CrashState> {
	const base = tempDir("elr-boot-");
	const persistent = join(base, "persistent");
	const lost = join(base, "lost-journal");
	const crash = spawnChild(["boot", "pre-crash", persistent, lost]);
	if (crash.stderr) console.error(crash.stderr.trim());
	if (crash.signal !== "SIGKILL") {
		rmSync(base, { recursive: true, force: true });
		fail(`expected the pre-crash child to die by SIGKILL, got status=${crash.status} signal=${crash.signal}`);
	}
	const marker = JSON.parse(readFileSync(join(persistent, "pre-crash.json"), "utf8")) as { conversationId: string; preCrashIds: string[]; preCrashEventCount: number };
	console.log(`killed: transcript has 6 canvas results, the survivor journal has ${marker.preCrashIds.length} events`);

	process.env.DATA_DIR = persistent;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const { harness, conversationId } = await openHarness(persistent);
	try {
		const first = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
		const journal = first.journal;
		const countAfterFirst = journal.countEvents();
		const idsAfterFirst = journal.listEvents(conversationId).map((event) => event.id);
		const second = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
		const countAfterSecond = journal.countEvents();
		const idsAfterSecond = journal.listEvents(conversationId).map((event) => event.id);
		const final = journal.listEvents(conversationId);
		return { base, persistent, lost, conversationId, preCrashIds: marker.preCrashIds, firstInserted: first.inserted, secondInserted: second.inserted, countAfterFirst, countAfterSecond, idsAfterFirst, idsAfterSecond, final };
	} finally {
		resetJournalCache();
		await harness.close(BACKGROUND_CONTEXT);
	}
}

async function bootMigrationsCase(): Promise<void> {
	const dir = tempDir("elr-boot-migrate-");
	process.env.DATA_DIR = dir;
	resetJournalCache();
	try {
		const dbPath = join(dir, "elr.sqlite");
		if (existsSync(dbPath)) fail("the proof started with an elr.sqlite already present");
		const booted = await bootJournal({ harness: { conversation: async () => undefined }, context: BACKGROUND_CONTEXT });
		assert.equal(booted.conversations, 0, "no pi-durable conversations were available to reconcile");
		if (!existsSync(dbPath)) fail("bootJournal did not create the journal file");
		assert.equal(booted.journal.schemaVersion(), JOURNAL_SCHEMA_VERSION, "the created DB is at the current schema version");
		assert.equal(booted.journal.fts5Available(), true, "FTS5 is available on the created DB");
		assert.equal(booted.fts5, booted.journal.fts5Available(), "the boot result reports the journal's FTS5 availability");
		const names = new Set(booted.journal.schemaObjects().map((object) => object.name));
		for (const table of JOURNAL_TABLES) if (!names.has(table)) fail(`bootJournal did not create §4 table "${table}"`);
		for (const fts of JOURNAL_FTS_TABLES) if (!names.has(fts)) fail(`bootJournal did not create FTS5 table "${fts}"`);

		console.log(`migrated a missing journal: ${dbPath}`);
		console.log(`  ${JOURNAL_TABLES.length} §4 tables + ${JOURNAL_FTS_TABLES.length} FTS5 tables, schema version ${booted.journal.schemaVersion()}, fts5=${booted.journal.fts5Available()}`);
		console.log(`  tables: ${JOURNAL_TABLES.join(", ")}`);

		const schemaProof = spawnSync(process.execPath, [self, "journal", "schema"], { cwd: repoRoot, encoding: "utf8", env: { ...process.env, OPENROUTER_API_KEY: "unused" } });
		if (schemaProof.status !== 0) fail(`bench/journal/proofs.ts journal schema exited ${schemaProof.status}: ${schemaProof.stderr}`);
		console.log("  schema proof: node bench/journal/proofs.ts journal schema -> PASS");
		console.log("PASS migrations: bootJournal opened a missing /data/elr.sqlite, ran the §4 migrations, schema verified");
	} finally {
		resetJournalCache();
		rmSync(dir, { recursive: true, force: true });
	}
}

function bootSourceCase(): void {
	assert.equal(TRANSCRIPT_TABLE, "entries", "the transcript table is pi-durable's `entries`");
	const read = gitGrep("readConversationTranscript", "src/elr/journal.ts");
	const derive = gitGrep("deriveCanvasCalls", "src/elr/journal.ts");
	const reconcile = gitGrep("export class Journal", "src/elr/journal.ts");
	const boot = gitGrep("export async function bootJournal", "src/elr/journal.ts");
	const bootReconcileGrep = gitGrep("export async function bootReconcile", "src/elr/journal.ts");
	const swallow = gitGrep("journal write failed", "src/elr/canvas.ts");

	console.log(`transcript source: file=<DATA_DIR>/agent.sqlite, table="${TRANSCRIPT_TABLE}" (pi-durable storage)`);
	console.log(`transcript read:   Conversation.entries({ order: "ascending" }, limit, cursor, context)`);
	console.log(`boot entry point:  ${boot}`);
	console.log(`functions invoked: ${read}`);
	console.log(`                   ${derive}`);
	console.log(`                   ${bootReconcileGrep}`);
	console.log(`                   ${reconcile}`);
	console.log(`swallow path:      ${swallow}  (canvas recordAction try/catch -> console.error, tool result unchanged)`);
	console.log("PASS source: transcript source and invoked functions named; journal failure is swallowed on the tool path");
}

async function bootReachableCase(): Promise<void> {
	const callSite = gitGrep("bootJournal(", "src/agent.ts");
	console.log(`call site: ${callSite}`);
	const bootModule = gitGrep("export async function bootJournal(", "src/elr/journal.ts");
	console.log(`definition: ${bootModule}`);

	const state = await bootCrashScenario();
	try {
		assert.equal(state.firstInserted, 3, `the first boot must insert the 3 missing events, inserted ${state.firstInserted}`);
		assert.equal(state.secondInserted, 0, `the second boot must insert nothing, inserted ${state.secondInserted}`);
		assert.equal(state.countAfterSecond, state.countAfterFirst, `two boots changed the row count (${state.countAfterFirst} -> ${state.countAfterSecond})`);
		assert.deepEqual(state.idsAfterSecond, state.idsAfterFirst, "two boots changed the event ids");
		console.log(`two boots: first inserted ${state.firstInserted} events (${state.countAfterFirst} rows), second inserted ${state.secondInserted} (${state.countAfterSecond} rows), ids unchanged`);
		console.log(SYNTHETIC_LOSS_CAVEAT);
		console.log("PASS reachable: bootJournal called from src/agent.ts, and booting twice adds no events");
	} finally {
		resetJournalCache();
		rmSync(state.base, { recursive: true, force: true });
	}
}

async function bootCrashCase(): Promise<void> {
	const state = await bootCrashScenario();
	try {
		assert.equal(state.countAfterFirst, 6, `after bootJournal exactly six events must exist, found ${state.countAfterFirst}`);
		assert.equal(state.final.length, 6, `after bootJournal the conversation must have six events, found ${state.final.length}`);
		assert.equal(state.final.filter((event) => event.tool === "paint" || event.tool === "reset_canvas" || event.tool === "done").length, 6, "all six are canvas actions");

		const toolCallIds = state.final.map((event) => event.toolCallId);
		assert.equal(new Set(toolCallIds).size, toolCallIds.length, "duplicate toolCallIds in the final journal");
		const dupes = duplicateToolCallIds(join(state.persistent, "elr.sqlite"));
		assert.deepEqual(dupes, [], `SQL duplicate toolCallId check found ${JSON.stringify(dupes)}`);

		const afterIds = new Set(state.idsAfterFirst);
		for (const id of state.preCrashIds) if (!afterIds.has(id)) fail(`pre-crash event id ${id} was changed by the reconcile`);
		assert.deepEqual(state.idsAfterFirst.slice(0, 3), state.preCrashIds, "the three pre-crash ids must keep their order and value");
		assert.equal(state.firstInserted, 3, `exactly the 3 missing events must be re-derived, inserted ${state.firstInserted}`);

		console.log("events (3 pre-crash preserved, 3 re-derived from the transcript):");
		for (const event of state.final) {
			const origin = state.preCrashIds.includes(event.id) ? "pre-crash" : "boot";
			console.log(`  ${event.toolCallId} id=${event.id} tool=${event.tool} attempt=${event.attemptId} origin=${origin}`);
		}
		console.log(`no duplicate toolCallIds: ${toolCallIds.length} events, ${new Set(toolCallIds).size} distinct ids (SQL GROUP BY ... HAVING c > 1: none)`);
		console.log(SYNTHETIC_LOSS_CAVEAT);
		console.log("PASS crash: six events, three pre-crash ids preserved, no duplicates");
	} finally {
		resetJournalCache();
		rmSync(state.base, { recursive: true, force: true });
	}
}

async function bootNonfatalCase(): Promise<void> {
	const base = tempDir("elr-boot-nonfatal-");
	const blocker = join(base, "blocker");
	writeFileSync(blocker, "not a directory");
	process.env.DATA_DIR = blocker; // defaultJournalPath -> <base>/blocker/elr.sqlite, whose parent is a file
	resetJournalCache();
	try {
		let threw = false;
		try {
			journalFor();
		} catch {
			threw = true;
		}
		assert.equal(threw, true, "the journal path must be genuinely broken for this proof");

		const { harness, registry, conversationId } = await openHarness(base);
		try {
			const tools = canvasTools(registry);
			const result = await runAction(tools, SCRIPTED_EPISODE[0]!, harness, registry, conversationId, "nonfatal-1");
			assert.notEqual(result.isError, true, "a broken journal must not fail the canvas tool call");
			const text = (result.output ?? []).map((item) => (item as { text?: string }).text ?? "").join(" ");
			console.log(`tool result (journal write failed, tool succeeded): ${text.trim()}`);
			console.log(`swallow path: ${gitGrep("journal write failed", "src/elr/canvas.ts")}`);
			console.log("PASS nonfatal: a journal failure never fails a tool call");
		} finally {
			resetJournalCache();
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		delete process.env.DATA_DIR;
		resetJournalCache();
		rmSync(base, { recursive: true, force: true });
	}
}

// ── Boot-path guard (spec §3, §9 M2, D9) ─────────────────────────────────────────────────────────

function bootAgent(dataDir: string): ChildResult {
	return spawnSync(process.execPath, ["--max-old-space-size=1024", childScript, "agent"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: { ...process.env, DATA_DIR: dataDir, OPENROUTER_API_KEY: "", MAX_SPEND_USD: "0" },
	}) as ChildResult;
}

/** Real Agent.open(): migrations + reconcile, run twice on one DATA_DIR. */
async function bootAgentCase(): Promise<void> {
	const base = tempDir("elr-boot-agent-");
	const data = join(base, "data");
	const seed = spawnChild(["boot", "pre-crash", data, join(base, "lost")]);
	if (seed.signal !== "SIGKILL") {
		rmSync(base, { recursive: true, force: true });
		fail(`the seed child did not die by SIGKILL: status=${seed.status} signal=${seed.signal}`);
	}
	// Drop the crash survivor's journal; rebuild it from the transcript alone.
	for (const suffix of ["", "-wal", "-shm"]) rmSync(join(data, JOURNAL_DB_FILE) + suffix, { force: true });
	const journalPath = join(data, JOURNAL_DB_FILE);
	assert.equal(existsSync(journalPath), false, "the journal must be absent before the first boot");
	console.log(`seeded fixture: ${SCRIPTED_EPISODE.length} canvas results in ${AGENT_DB_FILE}, no ${JOURNAL_DB_FILE}`);
	const counts: number[] = [];
	try {
		for (let run = 1; run <= 2; run++) {
			const boot = bootAgent(data);
			console.log(`boot ${run}: Agent.open() exit=${boot.status} signal=${boot.signal}`);
			for (const line of boot.stdout.trim().split("\n")) console.log(`  out| ${line}`);
			for (const line of boot.stderr.trim().split("\n").filter(Boolean)) console.log(`  err| ${line}`);
			if (boot.status !== 0) fail(`Agent.open() boot ${run} exited ${boot.status}, expected 0:\n${boot.stderr}`);
			if (/Error:|at .+\(.+:\d+:\d+\)/i.test(boot.stderr)) fail(`boot ${run} logged a fatal error or stack trace:\n${boot.stderr}`);
			const ready = boot.stdout.split("\n").find((line) => line.startsWith("[elr] journal ready:"));
			if (ready === undefined) fail(`boot ${run} did not log the reconcile step:\n${boot.stdout}`);
			const db = new DatabaseSync(journalPath);
			try {
				const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().map((row) => String((row as { name: string }).name)));
				for (const table of JOURNAL_TABLES) if (!names.has(table)) fail(`boot ${run}: post-boot DB lacks §4 table ${table}`);
				for (const fts of JOURNAL_FTS_TABLES) if (!names.has(fts)) fail(`boot ${run}: post-boot DB lacks FTS5 table ${fts}`);
				const version = Number((db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v);
				const count = Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
				counts.push(count);
				console.log(`  migration step -> schema_migrations version=${version}; ${JOURNAL_TABLES.length} §4 + ${JOURNAL_FTS_TABLES.length} FTS5 tables present`);
				console.log(`  reconcile step -> ${ready.trim()} (events in DB: ${count})`);
			} finally {
				db.close();
			}
		}
		assert.equal(counts[0], SCRIPTED_EPISODE.length, `the first boot must re-derive ${SCRIPTED_EPISODE.length} events, found ${counts[0]}`);
		assert.equal(counts[1], counts[0], `a second boot changed the event count: ${counts[0]} -> ${counts[1]}`);
		const dupes = duplicateToolCallIds(journalPath);
		assert.deepEqual(dupes, [], `duplicate toolCallIds after boot: ${JSON.stringify(dupes)}`);
		console.log(`idempotent: ${counts[0]} events after boot 1, ${counts[1]} after boot 2, no duplicate toolCallIds`);
		console.log(`call site: ${gitGrep("bootJournal(", "src/agent.ts")}`);
		console.log("PASS agent-boot: the real Agent.open() start-up migrated and reconciled the journal twice, with no duplicates");
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

function printGuard(): void {
	const callSite = gitGrep("const booted = await bootJournal", "src/agent.ts");
	const guard = gitGrep("journal boot failed", "src/agent.ts");
	const agentSource = readFileSync(join(repoRoot, "src", "agent.ts"), "utf8");
	const lines = agentSource.split("\n");
	const index = lines.findIndex((line) => line.includes("journal boot failed"));
	if (index < 4) fail("could not locate the try/catch guard in src/agent.ts");
	console.log("guard at the src/agent.ts call site (src/agent.ts is a PROTECTED path; the change needs the owner's merge):");
	console.log(`  git grep ${callSite}`);
	console.log(`  git grep ${guard}`);
	for (let i = index - 4; i <= index + 1; i++) console.log(`  src/agent.ts:${i + 1}: ${lines[i]}`);
}

function guardNonfatalCase(): void {
	const injections: readonly { label: string; injure: (journalPath: string) => void }[] = [
		{ label: "corrupt elr.sqlite (garbage bytes)", injure: (journalPath) => writeFileSync(journalPath, "this is not a sqlite database; garbage bytes\n") },
		{ label: "unusable elr.sqlite path (a directory)", injure: (journalPath) => mkdirSync(journalPath, { recursive: true }) },
	];
	for (const injection of injections) {
		const dir = tempDir("elr-boot-guard-");
		const journalPath = join(dir, JOURNAL_DB_FILE);
		try {
			injection.injure(journalPath);
			if (!existsSync(journalPath)) fail(`the injection (${injection.label}) did not create ${journalPath}`);
			const child = bootAgent(dir);
			if (child.status !== 0) fail(`Agent.open() did not survive ${injection.label}: exit=${child.status} signal=${child.signal}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
			if (!child.stdout.includes("AGENT_OPEN_OK")) fail(`the start-up path did not report success for ${injection.label}:\n${child.stdout}`);
			const failureLine = child.stderr.split("\n").find((line) => line.includes("[elr] journal boot failed"));
			if (failureLine === undefined) fail(`the journal failure was not logged to stderr for ${injection.label}:\n${child.stderr}`);
			if (!/\[elr\] journal boot failed: .+/.test(failureLine)) fail(`the failure line names no cause for ${injection.label}: ${failureLine}`);
			if (child.stdout.includes("[elr] journal ready")) fail(`a ready line was logged even though boot failed for ${injection.label}:\n${child.stdout}`);
			console.log(`injected ${injection.label}: ${journalPath}`);
			console.log(`  start-up completed: ${child.stdout.trim().split("\n").join(" | ")}`);
			console.log(`  failure logged: ${failureLine.trim()}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	printGuard();
	console.log("PASS nonfatal: a broken /data/elr.sqlite did not stop Agent.open(), and the cause is logged");
}

function guardLoglineCase(): void {
	const dir = tempDir("elr-boot-logline-");
	try {
		const child = bootAgent(dir);
		if (child.status !== 0) fail(`Agent.open() failed on a fresh data dir: exit=${child.status}\n${child.stderr}`);
		if (!child.stdout.includes("AGENT_OPEN_OK")) fail(`the start-up path did not report success:\n${child.stdout}`);
		const readyLines = child.stdout.split("\n").filter((line) => line.startsWith("[elr] journal ready:"));
		if (readyLines.length !== 1) fail(`expected exactly one boot line, found ${readyLines.length}:\n${child.stdout}`);
		const line = readyLines[0]!;
		const match = /^\[elr\] journal ready: fts5=(on|off) conversations=(\d+) eventsReconciled=(\d+)$/.exec(line);
		if (match === null) fail(`the boot line does not name FTS5 and the counts: ${line}`);
		const [, fts5, conversations, reconciled] = match;
		if (fts5 !== "on") fail(`FTS5 was reported unavailable on this runtime: ${line}`);
		assert.ok(Number(conversations) >= 1, `the boot line reports no conversations: ${line}`);
		const expected = journalReadyLine({ fts5: true, conversations: Number(conversations), inserted: Number(reconciled) });
		assert.equal(line, expected, "the call site's formatter disagrees with the observed line");
		console.log(`boot log line: ${line}`);
		console.log(`  fts5=${fts5} conversations=${conversations} eventsReconciled=${reconciled}`);
		console.log(`call site: ${gitGrep("journalReadyLine", "src/agent.ts")}`);
		console.log("  (the post-deploy confirmation path: grep '[elr] journal ready' in the production log; a CI image check was out of scope)");
		console.log("PASS logline: a successful boot names FTS5 availability and the conversation/event counts on one line");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function guardRepairCase(): Promise<void> {
	const dir = tempDir("elr-boot-repair-");
	const journalPath = join(dir, JOURNAL_DB_FILE);
	process.env.DATA_DIR = dir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const actions = SCRIPTED_EPISODE.slice(0, 3);
	const callIds = actions.map((_, i) => `repair-${i + 1}`);
	try {
		writeFileSync(journalPath, "corrupt\n");
		let journalThrew = false;
		try {
			journalFor();
		} catch {
			journalThrew = true;
		}
		assert.equal(journalThrew, true, "the journal path must be genuinely broken for this proof");

		const child = bootAgent(dir);
		if (child.status !== 0) fail(`Agent.open() did not survive the injected boot failure: exit=${child.status}\n${child.stderr}`);
		if (!child.stderr.includes("[elr] journal boot failed")) fail(`the injected boot failure was not logged:\n${child.stderr}`);
		console.log(`injected boot failure logged, start-up survived: ${child.stderr.split("\n").find((l) => l.includes("[elr] journal boot failed"))!.trim()}`);

		const { harness, registry, conversation, conversationId } = await openHarness(dir);
		try {
			const tools = canvasTools(registry);
			for (let i = 0; i < actions.length; i++) {
				const action = actions[i]!;
				const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
				assert.notEqual(result.isError, true, `tool ${action.tool} failed while the journal was broken`);
				await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
			}
			console.log(`while the journal was broken: ${actions.length} canvas tool calls succeeded and their transcript entries committed`);

			resetJournalCache();
			for (const suffix of ["", "-wal", "-shm"]) rmSync(`${journalPath}${suffix}`, { force: true });
			const first = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
			const idsAfterFirst = first.journal.listEvents(conversationId).map((event) => event.id);
			const second = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
			const idsAfterSecond = second.journal.listEvents(conversationId).map((event) => event.id);

			assert.equal(first.inserted, actions.length, `the repaired boot must re-derive all ${actions.length} events, inserted ${first.inserted}`);
			assert.equal(first.journal.countEvents(), actions.length);
			assert.equal(new Set(idsAfterFirst).size, idsAfterFirst.length, "duplicate event ids after the repair boot");
			assert.equal(second.inserted, 0, `a second boot must insert nothing, inserted ${second.inserted}`);
			assert.deepEqual(idsAfterSecond, idsAfterFirst, "a second boot changed the event ids");

			const extraCallId = "repair-after";
			const extra = await runAction(tools, actions[0]!, harness, registry, conversationId, extraCallId);
			assert.notEqual(extra.isError, true, "a tool call after the repair must succeed");
			assert.equal(first.journal.countEvents(), actions.length + 1, "the post-repair tool call was not journaled");
			assert.ok(first.journal.getEventByToolCallId(extraCallId) !== undefined, "the post-repair event is missing");

			console.log(`repaired boot: inserted ${first.inserted} events (${first.journal.countEvents() - 1} from the transcript), second boot inserted ${second.inserted}, no duplicate ids`);
			console.log(`post-repair tool call journaled: toolCallId=${extraCallId}`);
			console.log("PASS repair: tools kept working through the failure, and a later boot repaired the journal without duplicates");
		} finally {
			resetJournalCache();
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		delete process.env.DATA_DIR;
		resetJournalCache();
		rmSync(dir, { recursive: true, force: true });
	}
}


// ── Dispatch (one entry point, flag-driven cases) ────────────────────────────────────────────────

type Group = "journal" | "episode" | "reconcile" | "boot" | "boot-guard";
const GROUPS: Record<Group, readonly string[]> = {
	journal: ["schema", "migrate", "idempotent", "append-only", "wiring", "fts"],
	episode: ["six", "production"],
	reconcile: ["crash", "idempotent", "transcript", "converge", "dup", "deferred"],
	boot: ["migrations", "source", "crash", "reachable", "nonfatal", "agent"],
	"boot-guard": ["nonfatal", "logline", "repair"],
};

async function main(): Promise<void> {
	const group = (process.argv[2] ?? "journal") as Group;
	const which = process.argv[3] ?? "all";
	const skipUniquenessGuard = process.argv.includes("--skip-uniqueness-guard");
	if (!Object.prototype.hasOwnProperty.call(GROUPS, group)) fail(`unknown group "${group}" (expected ${Object.keys(GROUPS).join("|")})`);
	const cases = GROUPS[group];
	const negative = which === "negative";
	if (which !== "all" && !negative && !cases.includes(which)) fail(`unknown case "${which}" for group "${group}" (expected ${cases.join("|")}|all)`);
	const run = (name: string): boolean => which === "all" || which === name;

	if (group === "journal") {
		if (run("schema")) journalSchemaCase();
		if (negative) journalNegativeCase();
		if (run("migrate")) journalMigrateCase();
		if (run("idempotent")) journalIdempotentCase();
		if (run("append-only")) journalAppendOnlyCase(skipUniquenessGuard);
		if (run("wiring")) await journalWiringCase();
		if (run("fts")) journalFtsCase();
	} else if (group === "episode") {
		if (negative) {
			await episodeNegativeCase();
		} else {
			if (run("six")) {
				const episode = await runScriptedEpisode(SIX_ACTION_EPISODE, "sx");
				try {
					await sixCase(episode);
				} finally {
					await episode.cleanup();
				}
			}
			if (run("production")) await productionCase();
		}
	} else if (group === "reconcile") {
		if (negative) {
			reconcileNegativeCase();
		} else {
		if (run("crash")) await reconcileCrashCase();
		if (run("idempotent")) await reconcileIdempotentCase();
		if (run("transcript")) await reconcileTranscriptCase();
		if (run("converge")) await reconcileConvergeCase();
		if (run("dup")) await reconcileDupCase();
		if (run("deferred")) await reconcileDeferredCase();
		}
	} else if (group === "boot") {
		if (run("migrations")) await bootMigrationsCase();
		if (run("source")) bootSourceCase();
		if (run("crash")) await bootCrashCase();
		if (run("reachable")) await bootReachableCase();
		if (run("nonfatal")) await bootNonfatalCase();
		if (run("agent")) await bootAgentCase();
	} else if (group === "boot-guard") {
		if (run("nonfatal")) guardNonfatalCase();
		if (run("logline")) guardLoglineCase();
		if (run("repair")) await guardRepairCase();
	}
	const selected = which === "all" ? [...cases] : [which];
	console.log(`PASS (${group} ${which}): ${selected.length} case(s) held (${selected.join(", ")})`);
}

try {
	await main();
} catch (error) {
	console.error(`FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
	process.exit(1);
}

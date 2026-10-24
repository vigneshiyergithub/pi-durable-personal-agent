// Boot-completion harness for the ELR M2 hygiene split (acceptance criterion 3).
//
// Drives the real `Agent.open()` + the real HTTP listener against a throwaway DATA_DIR with a seeded
// pi-durable transcript and no pre-existing journal. It waits for the deferred reconcile handle
// (`agent.reconcileDone`), then reads `/data/elr.sqlite` directly and prints the applied migration /
// schema state plus the reconcile completion counts. Exits 0 only when:
//   - the §4 migration ran (schema version, all tables + FTS5 tables present),
//   - the reconcile reported ok with zero errors,
//   - the journal holds exactly the seeded events (no more, no fewer),
//   - no duplicate toolCallIds (the INSERT OR IGNORE key).
//
//   node scripts/health-boot-reconcile.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { freePort, seedCanvasTranscript } from "./health-harness.ts";

const EVENTS = Number(process.env.HEALTH_EVENTS ?? "300");
if (!Number.isInteger(EVENTS) || EVENTS < 1) {
	console.error(`health-boot-reconcile: HEALTH_EVENTS must be a positive integer, got ${process.env.HEALTH_EVENTS}`);
	process.exit(2);
}

const dataDir = await mkdtemp(join(tmpdir(), "agent-boot-reconcile-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "health-boot-reconcile";

console.log(`health-boot-reconcile: seeding ${EVENTS} canvas events into ${join(dataDir, "agent.sqlite")} ...`);
await seedCanvasTranscript(dataDir, EVENTS);
for (const suffix of ["", "-wal", "-shm"]) await rm(join(dataDir, "elr.sqlite") + suffix, { force: true });

const port = await freePort();
process.env.PORT = String(port);

const { Agent } = await import("../src/agent.ts");
const { startHttp } = await import("../src/http.ts");
const journalModule = await import("../src/elr/journal.ts");

const agent = await Agent.open();
const server = startHttp(agent);
const outcome = await agent.reconcileDone;
server.close();
await agent.close();

const journalPath = join(dataDir, "elr.sqlite");
let schemaVersion = 0;
let tables: string[] = [];
let present = 0;
let duplicates: string[] = [];
try {
	const db = new DatabaseSync(journalPath, { readOnly: true });
	try {
		schemaVersion = Number((db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number }).v);
		tables = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => String((row as { name: string }).name));
		present = Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
		duplicates = db
			.prepare("SELECT toolCallId, COUNT(*) AS c FROM events GROUP BY toolCallId HAVING c > 1")
			.all()
			.map((row) => String((row as { toolCallId: string }).toolCallId));
	} finally {
		db.close();
	}
} catch (error) {
	console.error(`health-boot-reconcile: could not read the journal: ${error instanceof Error ? error.message : String(error)}`);
	await rm(dataDir, { recursive: true, force: true });
	process.exit(1);
}

const missingTables = [...journalModule.JOURNAL_TABLES, ...journalModule.JOURNAL_FTS_TABLES].filter((name) => !tables.includes(name));
console.log(`migrations: schema_migrations version=${schemaVersion} (expected ${journalModule.JOURNAL_SCHEMA_VERSION}); ${journalModule.JOURNAL_TABLES.length} §4 + ${journalModule.JOURNAL_FTS_TABLES.length} FTS5 tables; missing=${missingTables.length === 0 ? "none" : missingTables.join(",")}`);
console.log(`reconcile: ok=${outcome.ok} conversations=${outcome.conversations} imported=${outcome.inserted} errors=${outcome.error === undefined ? 0 : 1}${outcome.error === undefined ? "" : ` (${outcome.error})`}`);
console.log(`journal: events present=${present} (seeded ${EVENTS}), duplicate toolCallIds=${duplicates.length}`);

await rm(dataDir, { recursive: true, force: true });

const ok =
	outcome.ok &&
	outcome.error === undefined &&
	outcome.inserted === EVENTS &&
	present === EVENTS &&
	duplicates.length === 0 &&
	schemaVersion === journalModule.JOURNAL_SCHEMA_VERSION &&
	missingTables.length === 0;
if (!ok) {
	console.error("health-boot-reconcile: FAIL");
	process.exit(1);
}
console.log("health-boot-reconcile: PASS");
process.exit(0);

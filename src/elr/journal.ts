// ELR evidence journal (spec docs/elr-canvas-spec.md §3, §4, §5, §9 M2).
//
// The journal is a separate SQLite file (`/data/elr.sqlite`, decision D7) that holds the §4 tables:
// sessions, attempts, events, evaluations, knowledge_nodes, knowledge_relations, procedures,
// transfer_records, experiments and retrievals. It is written with `node:sqlite` (the driver already
// used by the repo through pi-durable's `openNodeSqliteStorage`) plus an FTS5 virtual table, so no
// new dependency is needed.
//
// Events are immutable and keyed by `toolCallId` with `INSERT OR IGNORE` (spec §4). A repeated write
// of the same tool call therefore never creates a second row. The pi-durable transcript stays the
// source of truth: `deriveCanvasCalls()` maps committed transcript entries to journal rows and
// `reconcile()` re-inserts the missing ones on boot, idempotently.
//
// The journal stores references, not payloads: a conversation id, a tool call id, an op hash and the
// before/after raster hashes. It never copies the transcript.
//
// The canvas tools (src/elr/canvas.ts) write one `action` event per paint/reset/done through
// `recordCanvasAction()`. Writes are best-effort: a journal failure never fails a tool call, and the
// reconciler fills any event the crash lost.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, Cursor } from "@earendil-works/pi-durable";

/** Bump when the schema changes; each version gets its own ordered migration. */
export const JOURNAL_SCHEMA_VERSION = 1;

/** The §4 table names, in creation order. The migration proof asserts exactly these exist. */
export const JOURNAL_TABLES = [
	"sessions",
	"attempts",
	"events",
	"evaluations",
	"knowledge_nodes",
	"knowledge_relations",
	"procedures",
	"transfer_records",
	"experiments",
	"retrievals",
] as const;

export type JournalTable = (typeof JOURNAL_TABLES)[number];

/** The FTS5 virtual tables: one over events, one over knowledge nodes (spec §5 advisory section). */
export const JOURNAL_FTS_TABLES = ["events_fts", "knowledge_fts"] as const;

export type EventKind = "action" | "evaluation" | "reflection" | "session" | "attempt" | "retrieval";

export type EvaluationSource = "deterministic" | "system-one" | "task-verifier" | "human";

/** A row of the `events` table, as the query helpers return it. */
export type JournalEvent = {
	readonly id: string;
	readonly toolCallId: string;
	readonly conversationId: string;
	readonly sessionId: string | null;
	readonly attemptId: string | null;
	readonly parentEventId: string | null;
	readonly kind: EventKind;
	readonly tool: string | null;
	readonly namespace: string | null;
	readonly version: number | null;
	readonly configHash: string | null;
	readonly opHash: string | null;
	readonly beforeHash: string | null;
	readonly afterHash: string | null;
	readonly createdAt: string;
};

export type JournalEventInput = {
	toolCallId: string;
	conversationId: string;
	id?: string;
	sessionId?: string | null;
	attemptId?: string | null;
	parentEventId?: string | null;
	kind?: EventKind;
	tool?: string | null;
	namespace?: string | null;
	version?: number | null;
	configHash?: string | null;
	opHash?: string | null;
	beforeHash?: string | null;
	afterHash?: string | null;
	createdAt?: string;
};

export type EvaluationInput = {
	id?: string;
	eventId?: string | null;
	attemptId?: string | null;
	sessionId?: string | null;
	source: EvaluationSource;
	/** Optional score fields; a row may carry an abstain instead of a score. */
	boundaryF?: number | null;
	score?: number | null;
	abstain?: boolean;
	probability?: number | null;
	calibratedProbability?: number | null;
	evidenceRefs?: readonly string[];
	createdAt?: string;
};

export type KnowledgeNodeInput = {
	id?: string;
	kind: string;
	statement: string;
	domain?: string | null;
	originTools: readonly string[];
	verifiedTools?: readonly string[];
	hypothesizedTools?: readonly string[];
	excludedTools?: readonly string[];
	supportingEvidence?: readonly string[];
	contradictingEvidence?: readonly string[];
	status?: string;
	configHash?: string | null;
	createdAt?: string;
	updatedAt?: string;
};

export type TranscriptCall = {
	toolCallId: string;
	conversationId: string;
	tool: string;
	kind?: EventKind;
	sessionId?: string | null;
	attemptId?: string | null;
	parentEventId?: string | null;
	namespace?: string | null;
	version?: number | null;
	configHash?: string | null;
	opHash?: string | null;
	beforeHash?: string | null;
	afterHash?: string | null;
	createdAt?: string;
};

export const CANVAS_TOOLS = ["paint", "reset_canvas", "done"] as const;
export const CANVAS_NAMESPACE = "painting";

export type TranscriptEntry = {
	readonly kind: string;
	readonly model?: readonly unknown[];
	readonly data?: unknown;
};

type AssistantToolCall = { id: string; name: string; arguments: unknown };

type Row = Record<string, unknown>;

function nowIso(): string {
	return new Date().toISOString();
}

/** Yield to the event loop, so a long reconciliation never monopolises the main thread. */
function yieldNow(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Events reconciled synchronously between two event-loop yields. Keeps the biggest synchronous
 * block of the boot reconcile bounded, so `/health` (and every other request) is never blocked for
 * more than a few milliseconds while the transcript is re-derived.
 */
export const RECONCILE_CHUNK = 50;

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Recursively sort object keys, so a hash does not depend on property insertion order. */
function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/** Canonical JSON (sorted keys, no whitespace). */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

export function hashOp(op: unknown): string {
	return sha256Hex(canonicalJson(op));
}

export function eventIdFor(toolCallId: string): string {
	return `evt_${sha256Hex(toolCallId).slice(0, 32)}`;
}

function asText(value: unknown): string | null {
	return value === null || value === undefined ? null : String(value);
}

function asNumber(value: unknown): number | null {
	return value === null || value === undefined ? null : Number(value);
}

function boolToInt(value: boolean | undefined): number {
	return value === true ? 1 : 0;
}

function parseJsonArray(value: unknown): string[] {
	if (typeof value !== "string") return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function normalizeEventKind(kind: EventKind | undefined): EventKind {
	return kind ?? "action";
}

type Migration = {
	readonly version: number;
	readonly name: string;
	readonly statements: readonly string[];
};

export type JournalOptions = {
	enforceToolCallIdUniqueness?: boolean;
};

function eventsTableStatement(uniqueToolCallId: boolean): string {
	return `CREATE TABLE IF NOT EXISTS events (
				id TEXT PRIMARY KEY,
				toolCallId TEXT NOT NULL${uniqueToolCallId ? " UNIQUE" : ""},
				conversationId TEXT NOT NULL,
				sessionId TEXT,
				attemptId TEXT,
				parentEventId TEXT,
				kind TEXT NOT NULL DEFAULT 'action',
				tool TEXT,
				namespace TEXT,
				version INTEGER,
				configHash TEXT,
				opHash TEXT,
				beforeHash TEXT,
				afterHash TEXT,
				createdAt TEXT NOT NULL
			)`;
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial §4 tables and FTS5 indexes",
		statements: [
			`CREATE TABLE IF NOT EXISTS schema_migrations (
				version INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				appliedAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY,
				conversationId TEXT NOT NULL,
				domain TEXT NOT NULL,
				tool TEXT NOT NULL,
				configHash TEXT,
				arm TEXT,
				seed INTEGER,
				outcome TEXT,
				startedAt TEXT NOT NULL,
				endedAt TEXT
			)`,
			`CREATE TABLE IF NOT EXISTS attempts (
				id TEXT PRIMARY KEY,
				sessionId TEXT NOT NULL,
				attemptIndex INTEGER NOT NULL,
				status TEXT NOT NULL DEFAULT 'open',
				boundaryF REAL,
				startedAt TEXT NOT NULL,
				endedAt TEXT
			)`,
			eventsTableStatement(true),
			`CREATE TABLE IF NOT EXISTS evaluations (
				id TEXT PRIMARY KEY,
				eventId TEXT,
				attemptId TEXT,
				sessionId TEXT,
				source TEXT NOT NULL,
				boundaryF REAL,
				score REAL,
				abstain INTEGER NOT NULL DEFAULT 0,
				probability REAL,
				calibratedProbability REAL,
				evidenceRefs TEXT NOT NULL DEFAULT '[]',
				createdAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS knowledge_nodes (
				id TEXT PRIMARY KEY,
				kind TEXT NOT NULL,
				statement TEXT NOT NULL,
				domain TEXT,
				originTools TEXT NOT NULL DEFAULT '[]',
				verifiedTools TEXT NOT NULL DEFAULT '[]',
				hypothesizedTools TEXT NOT NULL DEFAULT '[]',
				excludedTools TEXT NOT NULL DEFAULT '[]',
				supportingEvidence TEXT NOT NULL DEFAULT '[]',
				contradictingEvidence TEXT NOT NULL DEFAULT '[]',
				status TEXT NOT NULL DEFAULT 'hypothesis',
				configHash TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS knowledge_relations (
				id TEXT PRIMARY KEY,
				fromNodeId TEXT NOT NULL,
				toNodeId TEXT NOT NULL,
				relation TEXT NOT NULL,
				createdAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS procedures (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				nodeId TEXT,
				params TEXT NOT NULL DEFAULT '{}',
				body TEXT,
				status TEXT NOT NULL DEFAULT 'candidate',
				configHash TEXT,
				trials INTEGER NOT NULL DEFAULT 0,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS transfer_records (
				id TEXT PRIMARY KEY,
				nodeId TEXT,
				fromTool TEXT NOT NULL,
				toTool TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'untested',
				experimentId TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS experiments (
				id TEXT PRIMARY KEY,
				nodeId TEXT,
				name TEXT NOT NULL,
				taskSet TEXT,
				arm TEXT,
				status TEXT NOT NULL DEFAULT 'planned',
				result TEXT,
				startedAt TEXT,
				endedAt TEXT,
				createdAt TEXT NOT NULL
			)`,
			`CREATE TABLE IF NOT EXISTS retrievals (
				id TEXT PRIMARY KEY,
				sessionId TEXT NOT NULL,
				nodeId TEXT NOT NULL,
				rank INTEGER,
				createdAt TEXT NOT NULL
			)`,
			`CREATE INDEX IF NOT EXISTS events_conversation_idx ON events (conversationId, createdAt)`,
			`CREATE INDEX IF NOT EXISTS events_attempt_idx ON events (attemptId)`,
			`CREATE INDEX IF NOT EXISTS retrievals_session_idx ON retrievals (sessionId)`,
			`CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5 (
				eventId UNINDEXED,
				toolCallId UNINDEXED,
				conversationId UNINDEXED,
				tool,
				opHash,
				tokenize = 'unicode61'
			)`,
			`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5 (
				nodeId UNINDEXED,
				statement,
				kind,
				domain,
				tokenize = 'unicode61'
			)`,
		],
	},
];

export function migrate(db: DatabaseSync, options: JournalOptions = {}): void {
	db.exec(
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			appliedAt TEXT NOT NULL
		)`,
	);
	const migrations =
		options.enforceToolCallIdUniqueness === false
			? MIGRATIONS.map((migration) => ({
					...migration,
					statements: migration.statements.map((statement) =>
						statement.startsWith("CREATE TABLE IF NOT EXISTS events (")
							? eventsTableStatement(false)
							: statement,
					),
				}))
			: MIGRATIONS;
	const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number((r as Row).version)));
	for (const migration of migrations) {
		if (applied.has(migration.version)) continue;
		db.exec("BEGIN");
		try {
			for (const statement of migration.statements) db.exec(statement);
			db.prepare("INSERT INTO schema_migrations (version, name, appliedAt) VALUES (?, ?, ?)").run(
				migration.version,
				migration.name,
				nowIso(),
			);
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}

export function fts5Available(db: DatabaseSync): boolean {
	const rows = db.prepare("SELECT name FROM pragma_module_list WHERE name = 'fts5'").all();
	return rows.length > 0;
}

export function defaultJournalPath(env: NodeJS.ProcessEnv = process.env): string {
	const dataDir = resolve(env.DATA_DIR?.trim() || "./data");
	return join(dataDir, "elr.sqlite");
}

/**
 * The ELR journal. Opening runs the migration path, then the caller may write and read. All methods
 * are synchronous because `node:sqlite`'s `DatabaseSync` is, and the tool path needs no await.
 */
export class Journal {
	readonly path: string;
	private readonly db: DatabaseSync;

	constructor(path: string = ":memory:", options: JournalOptions = {}) {
		this.path = path;
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = OFF");
		this.migrate(options);
	}

	migrate(options: JournalOptions = {}): void {
		migrate(this.db, options);
	}

	/** The highest applied migration version, or 0 for a brand-new database. */
	schemaVersion(): number {
		const rows = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").all();
		return Number((rows[0] as Row | undefined)?.version ?? 0);
	}

	schemaObjects(): { type: string; name: string; sql: string }[] {
		return this.db
			.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
			.all()
			.map((row) => ({ type: String((row as Row).type), name: String((row as Row).name), sql: String((row as Row).sql ?? "") }));
	}

	/** Columns of one table, from `PRAGMA table_info`, for the migration proof. */
	columns(table: string): string[] {
		return this.db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.map((row) => String((row as Row).name));
	}

	fts5Available(): boolean {
		return fts5Available(this.db);
	}

	close(): void {
		this.db.close();
	}

	// ── Events (append-only, keyed by toolCallId) ──

	recordEvent(input: JournalEventInput): boolean {
		if (!input.toolCallId) throw new Error("event requires a toolCallId");
		if (!input.conversationId) throw new Error("event requires a conversationId");
		const id = input.id ?? eventIdFor(input.toolCallId);
		const createdAt = input.createdAt ?? nowIso();
		const kind = normalizeEventKind(input.kind);
		const info = this.db
			.prepare(
				`INSERT OR IGNORE INTO events
					(id, toolCallId, conversationId, sessionId, attemptId, parentEventId, kind, tool, namespace, version, configHash, opHash, beforeHash, afterHash, createdAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.toolCallId,
				input.conversationId,
				input.sessionId ?? null,
				input.attemptId ?? null,
				input.parentEventId ?? null,
				kind,
				input.tool ?? null,
				input.namespace ?? null,
				input.version ?? null,
				input.configHash ?? null,
				input.opHash ?? null,
				input.beforeHash ?? null,
				input.afterHash ?? null,
				createdAt,
			);
		const inserted = Number(info.changes) > 0;
		if (inserted && (input.tool !== undefined || input.opHash !== undefined)) {
			this.db
				.prepare("INSERT INTO events_fts (eventId, toolCallId, conversationId, tool, opHash) VALUES (?, ?, ?, ?, ?)")
				.run(id, input.toolCallId, input.conversationId, input.tool ?? "", input.opHash ?? "");
		}
		return inserted;
	}

	recordCanvasAction(input: Omit<TranscriptCall, "kind"> & { kind?: EventKind }): boolean {
		const parentEventId =
			input.parentEventId === undefined ? this.latestEventId(input.conversationId) : input.parentEventId;
		return this.recordEvent({ ...input, parentEventId, kind: normalizeEventKind(input.kind) });
	}

	getEventByToolCallId(toolCallId: string): JournalEvent | undefined {
		const row = this.db.prepare("SELECT * FROM events WHERE toolCallId = ?").get(toolCallId);
		return row === undefined ? undefined : toEvent(row as Row);
	}

	countEvents(): number {
		return Number((this.db.prepare("SELECT COUNT(*) AS c FROM events").get() as Row).c);
	}

	/** Events of one conversation in insertion order (oldest first). */
	listEvents(conversationId: string): JournalEvent[] {
		return this.db
			.prepare("SELECT * FROM events WHERE conversationId = ? ORDER BY createdAt, rowid")
			.all(conversationId)
			.map((row) => toEvent(row as Row));
	}

	/** The newest event id for a conversation, used as the next action's `parentEventId`. */
	latestEventId(conversationId: string): string | null {
		const row = this.db
			.prepare("SELECT id FROM events WHERE conversationId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1")
			.get(conversationId);
		return row === undefined ? null : String((row as Row).id);
	}

	/** FTS5 MATCH over event references. `match` uses the FTS5 query syntax. */
	searchEvents(match: string, limit = 20): JournalEvent[] {
		return this.db
			.prepare(
				`SELECT e.* FROM events_fts JOIN events e ON e.id = events_fts.eventId
				 WHERE events_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(match, limit)
			.map((row) => toEvent(row as Row));
	}

	// ── Sessions and attempts ──

	insertSession(input: {
		id: string;
		conversationId: string;
		domain: string;
		tool: string;
		configHash?: string | null;
		arm?: string | null;
		seed?: number | null;
		outcome?: string | null;
		startedAt?: string;
		endedAt?: string | null;
	}): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO sessions (id, conversationId, domain, tool, configHash, arm, seed, outcome, startedAt, endedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.conversationId,
				input.domain,
				input.tool,
				input.configHash ?? null,
				input.arm ?? null,
				input.seed ?? null,
				input.outcome ?? null,
				input.startedAt ?? nowIso(),
				input.endedAt ?? null,
			);
	}

	insertAttempt(input: {
		id: string;
		sessionId: string;
		attemptIndex: number;
		status?: string;
		boundaryF?: number | null;
		startedAt?: string;
		endedAt?: string | null;
	}): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO attempts (id, sessionId, attemptIndex, status, boundaryF, startedAt, endedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id,
				input.sessionId,
				input.attemptIndex,
				input.status ?? "open",
				input.boundaryF ?? null,
				input.startedAt ?? nowIso(),
				input.endedAt ?? null,
			);
	}

	// ── Evaluations (interpretations never edit events) ──

	recordEvaluation(input: EvaluationInput): string {
		const id = input.id ?? randomUUID();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO evaluations
					(id, eventId, attemptId, sessionId, source, boundaryF, score, abstain, probability, calibratedProbability, evidenceRefs, createdAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.eventId ?? null,
				input.attemptId ?? null,
				input.sessionId ?? null,
				input.source,
				input.boundaryF ?? null,
				input.score ?? null,
				boolToInt(input.abstain),
				input.probability ?? null,
				input.calibratedProbability ?? null,
				JSON.stringify(input.evidenceRefs ?? []),
				input.createdAt ?? nowIso(),
			);
		return id;
	}

	listEvaluations(sessionId: string): Row[] {
		return this.db.prepare("SELECT * FROM evaluations WHERE sessionId = ? ORDER BY createdAt").all(sessionId) as Row[];
	}

	// ── Knowledge nodes and relations ──

	recordKnowledgeNode(input: KnowledgeNodeInput): string {
		const id = input.id ?? randomUUID();
		const createdAt = input.createdAt ?? nowIso();
		const updatedAt = input.updatedAt ?? createdAt;
		this.db
			.prepare(
				`INSERT OR IGNORE INTO knowledge_nodes
					(id, kind, statement, domain, originTools, verifiedTools, hypothesizedTools, excludedTools,
					 supportingEvidence, contradictingEvidence, status, configHash, createdAt, updatedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				id,
				input.kind,
				input.statement,
				input.domain ?? null,
				JSON.stringify(input.originTools),
				JSON.stringify(input.verifiedTools ?? []),
				JSON.stringify(input.hypothesizedTools ?? []),
				JSON.stringify(input.excludedTools ?? []),
				JSON.stringify(input.supportingEvidence ?? []),
				JSON.stringify(input.contradictingEvidence ?? []),
				input.status ?? "hypothesis",
				input.configHash ?? null,
				createdAt,
				updatedAt,
			);
		this.db
			.prepare("INSERT INTO knowledge_fts (nodeId, statement, kind, domain) VALUES (?, ?, ?, ?)")
			.run(id, input.statement, input.kind, input.domain ?? "");
		return id;
	}

	getKnowledgeNode(id: string): Row | undefined {
		return this.db.prepare("SELECT * FROM knowledge_nodes WHERE id = ?").get(id) as Row | undefined;
	}

	nodeEvidenceIds(id: string): { supporting: string[]; contradicting: string[] } {
		const row = this.getKnowledgeNode(id);
		if (row === undefined) return { supporting: [], contradicting: [] };
		return { supporting: parseJsonArray(row.supportingEvidence), contradicting: parseJsonArray(row.contradictingEvidence) };
	}

	recordKnowledgeRelation(input: { id?: string; fromNodeId: string; toNodeId: string; relation: string; createdAt?: string }): void {
		this.db
			.prepare("INSERT OR IGNORE INTO knowledge_relations (id, fromNodeId, toNodeId, relation, createdAt) VALUES (?, ?, ?, ?, ?)")
			.run(input.id ?? randomUUID(), input.fromNodeId, input.toNodeId, input.relation, input.createdAt ?? nowIso());
	}

	/** FTS5 MATCH over knowledge node statements, for the advisory section (spec §5). */
	searchKnowledge(match: string, limit = 20): Row[] {
		return this.db
			.prepare(
				`SELECT n.* FROM knowledge_fts JOIN knowledge_nodes n ON n.id = knowledge_fts.nodeId
				 WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?`,
			)
			.all(match, limit) as Row[];
	}

	// ── Procedures, transfer records, experiments, retrievals ──

	recordProcedure(input: {
		id?: string;
		name: string;
		nodeId?: string | null;
		params?: string;
		body?: string | null;
		status?: string;
		configHash?: string | null;
		trials?: number;
		createdAt?: string;
		updatedAt?: string;
	}): void {
		const createdAt = input.createdAt ?? nowIso();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO procedures (id, name, nodeId, params, body, status, configHash, trials, createdAt, updatedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id ?? randomUUID(),
				input.name,
				input.nodeId ?? null,
				input.params ?? "{}",
				input.body ?? null,
				input.status ?? "candidate",
				input.configHash ?? null,
				input.trials ?? 0,
				createdAt,
				input.updatedAt ?? createdAt,
			);
	}

	recordTransferRecord(input: {
		id?: string;
		nodeId?: string | null;
		fromTool: string;
		toTool: string;
		status?: string;
		experimentId?: string | null;
		createdAt?: string;
		updatedAt?: string;
	}): void {
		const createdAt = input.createdAt ?? nowIso();
		this.db
			.prepare(
				`INSERT OR IGNORE INTO transfer_records (id, nodeId, fromTool, toTool, status, experimentId, createdAt, updatedAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id ?? randomUUID(),
				input.nodeId ?? null,
				input.fromTool,
				input.toTool,
				input.status ?? "untested",
				input.experimentId ?? null,
				createdAt,
				input.updatedAt ?? createdAt,
			);
	}

	recordExperiment(input: {
		id?: string;
		nodeId?: string | null;
		name: string;
		taskSet?: string | null;
		arm?: string | null;
		status?: string;
		result?: string | null;
		startedAt?: string | null;
		endedAt?: string | null;
		createdAt?: string;
	}): void {
		this.db
			.prepare(
				`INSERT OR IGNORE INTO experiments (id, nodeId, name, taskSet, arm, status, result, startedAt, endedAt, createdAt)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				input.id ?? randomUUID(),
				input.nodeId ?? null,
				input.name,
				input.taskSet ?? null,
				input.arm ?? null,
				input.status ?? "planned",
				input.result ?? null,
				input.startedAt ?? null,
				input.endedAt ?? null,
				input.createdAt ?? nowIso(),
			);
	}

	/** Record that a node was in context for a session (drives deprecation, spec §4). */
	recordRetrieval(input: { id?: string; sessionId: string; nodeId: string; rank?: number | null; createdAt?: string }): void {
		this.db
			.prepare("INSERT OR IGNORE INTO retrievals (id, sessionId, nodeId, rank, createdAt) VALUES (?, ?, ?, ?, ?)")
			.run(input.id ?? randomUUID(), input.sessionId, input.nodeId, input.rank ?? null, input.createdAt ?? nowIso());
	}

	listRetrievals(sessionId: string): Row[] {
		return this.db.prepare("SELECT * FROM retrievals WHERE sessionId = ? ORDER BY rank, createdAt").all(sessionId) as Row[];
	}

	// ── Boot reconciler ──

	reconcile(calls: readonly TranscriptCall[]): number {
		if (calls.length === 0) return 0;
		let inserted = 0;
		// One commit per chunk: the boot reconciler inserts in bounded batches, so this keeps each
		// synchronous block (and its disk commit) short. A crash rolls the chunk back; the events are
		// re-derived from the transcript on the next boot, so nothing is lost.
		this.db.exec("SAVEPOINT journal_reconcile");
		try {
			for (const call of calls) {
				if (this.recordCanvasAction(call)) inserted++;
			}
			this.db.exec("RELEASE journal_reconcile");
		} catch (error) {
			this.db.exec("ROLLBACK TO journal_reconcile");
			this.db.exec("RELEASE journal_reconcile");
			throw error;
		}
		return inserted;
	}
}

export async function reconcileConversation(
	journal: Journal,
	conversationId: string,
	readEntries: () => Promise<readonly TranscriptEntry[]>,
): Promise<number> {
	const entries = await readEntries();
	return journal.reconcile(deriveCanvasCalls(conversationId, entries));
}

export const TRANSCRIPT_TABLE = "entries";

export async function readConversationTranscript(
	conversation: Pick<Conversation, "entries">,
	context: Context,
	pageSize = 500,
): Promise<TranscriptEntry[]> {
	const entries: TranscriptEntry[] = [];
	let cursor: Cursor | undefined;
	for (;;) {
		const page = await conversation.entries({ order: "ascending" }, pageSize, cursor, context);
		for (const entry of page.items) entries.push(entry as unknown as TranscriptEntry);
		if (page.next === undefined) break;
		cursor = page.next;
	}
	return entries;
}

export async function bootReconcile(
	journal: Journal,
	conversation: Conversation,
	context: Context,
	pageSize = 500,
): Promise<number> {
	return reconcileConversation(journal, String(conversation.id), () => readConversationTranscript(conversation, context, pageSize));
}

export function defaultTranscriptPath(env: NodeJS.ProcessEnv = process.env): string {
	const dataDir = resolve(env.DATA_DIR?.trim() || "./data");
	return join(dataDir, "agent.sqlite");
}

/** Resolve a conversation handle by id; a live `Harness` satisfies this. */
export type ConversationSource = {
	conversation(id: ConversationId, context: Context): Promise<Conversation | undefined>;
};

export type BootJournalOptions = {
	harness: ConversationSource;
	context: Context;
	journalPath?: string;
	transcriptPath?: string;
	conversationIds?: readonly number[];
	/** Page size when reading a transcript. */
	pageSize?: number;
};

export type BootJournalResult = {
	/** The journal that was opened (running its migrations) and reconciled. */
	journal: Journal;
	/** How many pi-durable conversations were visited. */
	conversations: number;
	/** How many missing events were re-derived from their transcripts. */
	inserted: number;
	fts5: boolean;
};

export function journalReadyLine(result: Pick<BootJournalResult, "fts5" | "conversations" | "inserted">): string {
	return `[elr] journal ready: fts5=${result.fts5 ? "on" : "off"} conversations=${result.conversations} eventsReconciled=${result.inserted}`;
}

export function listConversationIds(transcriptPath: string = defaultTranscriptPath()): number[] {
	if (!existsSync(transcriptPath)) return [];
	const db = new DatabaseSync(transcriptPath, { readOnly: true });
	try {
		return db.prepare("SELECT id FROM conversations ORDER BY id").all().map((row) => Number((row as Row).id));
	} finally {
		db.close();
	}
}

export async function bootJournal(options: BootJournalOptions): Promise<BootJournalResult> {
	const open = openBootJournal(options);
	const { conversations, inserted } = await reconcileBootJournal(open, options);
	return { journal: open.journal, conversations, inserted, fts5: open.fts5 };
}

/**
 * The synchronous half of the boot path: open the journal (running its §4 migrations) and list the
 * pi-durable conversations the reconciler will visit. Opening + migrating is cheap and a hard
 * prerequisite for the canvas writes, so it stays ahead of `server.listen()`. The expensive
 * transcript reconciliation is `reconcileBootJournal`, which the caller runs *after* the HTTP
 * listener is up (src/http.ts calls it from the listen callback).
 */
export type BootJournalOpen = {
	/** The journal that was opened, with its migrations applied. */
	journal: Journal;
	fts5: boolean;
	conversationIds: readonly number[];
};

export function openBootJournal(options: BootJournalOptions): BootJournalOpen {
	const journal = journalFor(options.journalPath ?? defaultJournalPath());
	const fts5 = journal.fts5Available();
	const ids = options.conversationIds ?? listConversationIds(options.transcriptPath ?? defaultTranscriptPath());
	return { journal, fts5, conversationIds: ids };
}

/**
 * The deferred half of the boot path: re-derive missing events from each conversation's transcript,
 * reconciling in bounded chunks (`RECONCILE_CHUNK`) with a yield to the event loop between them, so
 * a long reconciliation never blocks `/health` or any other request. Idempotent by construction
 * (`INSERT OR IGNORE` keyed by toolCallId): running it twice inserts nothing the second time, and it
 * is safe to stop after any chunk and re-derive the missing events on the next boot.
 *
 * Called by src/http.ts from the listener callback, and by `bootJournal` for scripts/tests.
 */
export async function reconcileBootJournal(
	open: BootJournalOpen,
	options: Pick<BootJournalOptions, "harness" | "context" | "pageSize">,
): Promise<{ conversations: number; inserted: number }> {
	let conversations = 0;
	let inserted = 0;
	for (const id of open.conversationIds) {
		const conversation = await options.harness.conversation(id as ConversationId, options.context);
		if (conversation === undefined) continue;
		conversations++;
		const entries = await readConversationTranscript(conversation, options.context, options.pageSize);
		const calls = deriveCanvasCalls(String(conversation.id), entries);
		for (let i = 0; i < calls.length; i += RECONCILE_CHUNK) {
			inserted += open.journal.reconcile(calls.slice(i, i + RECONCILE_CHUNK));
			await yieldNow();
		}
	}
	return { conversations, inserted };
}

/** The completion line for the deferred reconcile: conversation and event counts. */
export function journalReconciledLine(result: { conversations: number; inserted: number }): string {
	return `[elr] journal reconciled: conversations=${result.conversations} eventsReconciled=${result.inserted}`;
}

/** Map events rows to the typed shape (null-prototype rows -> plain objects). */
function toEvent(row: Row): JournalEvent {
	return {
		id: String(row.id),
		toolCallId: String(row.toolCallId),
		conversationId: String(row.conversationId),
		sessionId: asText(row.sessionId),
		attemptId: asText(row.attemptId),
		parentEventId: asText(row.parentEventId),
		kind: String(row.kind) as EventKind,
		tool: asText(row.tool),
		namespace: asText(row.namespace),
		version: asNumber(row.version),
		configHash: asText(row.configHash),
		opHash: asText(row.opHash),
		beforeHash: asText(row.beforeHash),
		afterHash: asText(row.afterHash),
		createdAt: String(row.createdAt),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** Assistant tool calls in one transcript entry, keyed by call id. */
function assistantCalls(entry: TranscriptEntry): AssistantToolCall[] {
	const calls: AssistantToolCall[] = [];
	for (const message of entry.model ?? []) {
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (isRecord(item) && item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
				calls.push({ id: item.id, name: item.name, arguments: item.arguments });
			}
		}
	}
	return calls;
}

/** Tool result messages in one transcript entry. */
function toolResults(entry: TranscriptEntry): { toolCallId: string; toolName: string; timestamp?: number; details?: unknown; isError: boolean }[] {
	const results: { toolCallId: string; toolName: string; timestamp?: number; details?: unknown; isError: boolean }[] = [];
	for (const message of entry.model ?? []) {
		if (!isRecord(message) || message.role !== "toolResult") continue;
		if (typeof message.toolCallId === "string" && typeof message.toolName === "string") {
			results.push({
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
				details: message.details,
				isError: message.isError === true,
			});
		}
	}
	return results;
}

type CanvasDetails = {
	namespace: string;
	version: number;
	configHash: string;
	tool: string;
	attempt: number;
	opHash: string;
	beforeHash: string;
	afterHash: string;
};

function parseCanvasDetails(value: unknown): CanvasDetails | undefined {
	if (!isRecord(value)) return undefined;
	const { namespace, version, configHash, tool, attempt, opHash, beforeHash, afterHash } = value;
	if (
		typeof namespace !== "string" ||
		typeof version !== "number" ||
		typeof configHash !== "string" ||
		typeof tool !== "string" ||
		typeof attempt !== "number" ||
		typeof opHash !== "string" ||
		typeof beforeHash !== "string" ||
		typeof afterHash !== "string"
	) {
		return undefined;
	}
	return { namespace, version, configHash, tool, attempt, opHash, beforeHash, afterHash };
}

export function deriveCanvasCalls(conversationId: string, entries: readonly TranscriptEntry[]): TranscriptCall[] {
	const argsByCallId = new Map<string, unknown>();
	const calls: TranscriptCall[] = [];
	const canvasTools = new Set<string>(CANVAS_TOOLS);
	for (const entry of entries) {
		for (const call of assistantCalls(entry)) argsByCallId.set(call.id, call.arguments);
	}
	let previousEventId: string | null = null;
	for (const entry of entries) {
		if (entry.kind !== "pi.tool-result") continue;
		for (const result of toolResults(entry)) {
			if (!canvasTools.has(result.toolName)) continue;
			// A tool error recorded no op; the live tool path never journals one, so skip it too.
			if (result.isError) continue;
			const args = argsByCallId.get(result.toolCallId);
			const details = parseCanvasDetails(result.details);
			const eventId = eventIdFor(result.toolCallId);
			calls.push({
				toolCallId: result.toolCallId,
				conversationId,
				tool: details?.tool ?? result.toolName,
				namespace: details?.namespace ?? CANVAS_NAMESPACE,
				version: details?.version ?? null,
				configHash: details?.configHash ?? null,
				opHash: details?.opHash ?? (args === undefined ? null : hashOp(args)),
				beforeHash: details?.beforeHash ?? null,
				afterHash: details?.afterHash ?? null,
				sessionId: conversationId,
				attemptId: details === undefined ? null : `${conversationId}#${details.attempt}`,
				parentEventId: previousEventId,
				createdAt: result.timestamp === undefined ? undefined : new Date(result.timestamp).toISOString(),
			});
			previousEventId = eventId;
		}
	}
	return calls;
}

let cachedJournal: Journal | undefined;
let cachedJournalPath: string | undefined;

export function journalFor(path: string = defaultJournalPath()): Journal {
	if (cachedJournal !== undefined && cachedJournalPath === path) return cachedJournal;
	cachedJournal?.close();
	cachedJournal = new Journal(path);
	cachedJournalPath = path;
	return cachedJournal;
}

/** Test helper: drop the cached handle (the caller owns closing it). */
export function resetJournalCache(): void {
	cachedJournal = undefined;
	cachedJournalPath = undefined;
}

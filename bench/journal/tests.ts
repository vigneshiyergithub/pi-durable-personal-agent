// Unit tests for the M2 journal, episode, reconciler and boot entry point (spec §9 M2).
// Run: node --test bench/journal/tests.ts  (ELR_TEST_GROUP selects journal|episode|reconcile|boot)
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	bootJournal,
	bootReconcile,
	deriveCanvasCalls,
	eventIdFor,
	JOURNAL_FTS_TABLES,
	JOURNAL_SCHEMA_VERSION,
	JOURNAL_TABLES,
	journalFor,
	journalReadyLine,
	Journal,
	readConversationTranscript,
	resetJournalCache,
	sha256Hex,
	hashOp,
} from "../../src/elr/journal.ts";
import {
	appendTranscript,
	canvasTools,
	JOURNAL_DB_FILE,
	openHarness,
	runAction,
	runToolEpisode,
	scriptedCallIds,
	SCRIPTED_EPISODE,
	type EpisodeResult,
} from "./harness.ts";

function withJournal(fn: (journal: Journal) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "elr-journal-test-"));
	const journal = new Journal(join(dir, "elr.sqlite"));
	try {
		fn(journal);
	} finally {
		journal.close();
		rmSync(dir, { recursive: true, force: true });
	}
}


function registerJournalTests(): void {
	test("migration creates every §4 table and the FTS5 indexes", () => {
		withJournal((journal) => {
			const names = new Set(journal.schemaObjects().map((o) => o.name));
			for (const table of [...JOURNAL_TABLES, ...JOURNAL_FTS_TABLES]) assert.ok(names.has(table), `missing ${table}`);
		});
	});

	test("the migration path is re-runnable", () => {
		withJournal((journal) => {
			const before = JSON.stringify(journal.schemaObjects());
			journal.migrate();
			assert.equal(JSON.stringify(journal.schemaObjects()), before);
		});
	});

	test("the same toolCallId is inserted once", () => {
		withJournal((journal) => {
			const event = { toolCallId: "call-1", conversationId: "conv-1", tool: "paint", opHash: hashOp({}) };
			assert.equal(journal.recordEvent(event), true);
			assert.equal(journal.recordEvent(event), false);
			assert.equal(journal.countEvents(), 1);
		});
	});

	test("linked events keep stable ids and links across a transcript reconcile", () => {
		withJournal((journal) => {
			journal.recordCanvasAction({ toolCallId: "a", conversationId: "c", tool: "paint", opHash: "h1", beforeHash: "b1", afterHash: "a1" });
			journal.recordCanvasAction({ toolCallId: "b", conversationId: "c", tool: "paint", opHash: "h2", beforeHash: "a1", afterHash: "a2" });
			const first = journal.listEvents("c");
			assert.equal(first.length, 2);
			assert.equal(first[1]!.parentEventId, first[0]!.id);

			const inserted = journal.reconcile([
				{ toolCallId: "a", conversationId: "c", tool: "paint", opHash: "h1", beforeHash: "b1", afterHash: "a1" },
				{ toolCallId: "b", conversationId: "c", tool: "paint", opHash: "h2", beforeHash: "a1", afterHash: "a2" },
				{ toolCallId: "c", conversationId: "c", tool: "paint", opHash: "h3", beforeHash: "a2", afterHash: "a3" },
			]);
			assert.equal(inserted, 1);
			const after = journal.listEvents("c");
			assert.equal(after.length, 3);
			assert.equal(after[0]!.id, first[0]!.id);
			assert.equal(after[1]!.id, first[1]!.id);
			assert.equal(after[2]!.parentEventId, after[1]!.id);
		});
	});

	test("deriveCanvasCalls re-derives canvas actions from transcript entries", () => {
		const calls = deriveCanvasCalls("conv-x", [
			{
				kind: "pi.assistant",
				model: [{ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "paint", arguments: { width: 4 } }] }],
			},
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c1", toolName: "paint", timestamp: 1 }] },
		]);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.toolCallId, "c1");
		assert.equal(calls[0]!.opHash, hashOp({ width: 4 }));
	});
}


async function withEpisode(fn: (episode: EpisodeResult) => Promise<void>): Promise<void> {
	const episode = await runToolEpisode();
	try {
		await fn(episode);
	} finally {
		await episode.cleanup();
	}
}

function registerEpisodeTests(): void {
	test("the scripted episode gives exactly 6 action events in order", async () => {
		await withEpisode(async ({ events, toolCallIds }) => {
			assert.equal(events.length, 6);
			assert.deepEqual(events.map((e) => e.toolCallId), toolCallIds);
			assert.deepEqual(events.map((e) => e.tool), SCRIPTED_EPISODE.map((a) => a.tool));
			assert.ok(events.every((e) => e.kind === "action"));
		});
	});

	test("every event's attempt and parent links are correct", async () => {
		await withEpisode(async ({ events, conversationId, actions }) => {
			assert.equal(events.length, 6);
			for (let i = 0; i < events.length; i++) {
				assert.equal(events[i]!.attemptId, `${conversationId}#${actions[i]!.attempt}`);
				assert.equal(events[i]!.parentEventId, i === 0 ? null : events[i - 1]!.id);
			}
			assert.deepEqual(
				events.map((e) => e.attemptId),
				["episode-conversation#0", "episode-conversation#0", "episode-conversation#1", "episode-conversation#1", "episode-conversation#1", "episode-conversation#1"],
			);
		});
	});

	test("every event's before/after hashes equal the hashes of the rasters the episode produced", async () => {
		await withEpisode(async ({ events, rasterFiles }) => {
			const fileHashes = await Promise.all(rasterFiles.map(async (file) => sha256Hex(await readFile(file))));
			assert.equal(fileHashes.length, 7);
			for (let i = 0; i < events.length; i++) {
				assert.equal(events[i]!.beforeHash, fileHashes[i]);
				assert.equal(events[i]!.afterHash, fileHashes[i + 1]);
			}
		});
	});
}


function registerReconcileTests(): void {
	test("deriveCanvasCalls re-derives the full event references from a transcript with details", () => {
		const detailsA = { namespace: "painting", version: 1, configHash: "cafe", tool: "paint", attempt: 0, opHash: "op-a", beforeHash: "b", afterHash: "a" };
		const detailsB = { namespace: "painting", version: 1, configHash: "cafe", tool: "paint", attempt: 1, opHash: "op-b", beforeHash: "a", afterHash: "c" };
		const entries = [
			{
				kind: "pi.assistant",
				model: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "k1", name: "paint", arguments: { width: 4 } },
							{ type: "toolCall", id: "k2", name: "paint", arguments: { width: 4 } },
						],
					},
				],
			},
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "k1", toolName: "paint", timestamp: 1700000000000, details: detailsA, isError: false }] },
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "k2", toolName: "paint", timestamp: 1700000000001, details: detailsB, isError: false }] },
			{ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "k3", toolName: "paint", timestamp: 1700000000002, isError: true }] },
		];
		const calls = deriveCanvasCalls("7", entries);
		assert.equal(calls.length, 2);
		assert.equal(calls[0]!.toolCallId, "k1");
		assert.equal(calls[0]!.sessionId, "7");
		assert.equal(calls[0]!.attemptId, "7#0");
		assert.equal(calls[0]!.parentEventId, null, "the first derived call is the chain root");
		assert.equal(calls[0]!.beforeHash, "b");
		assert.equal(calls[0]!.afterHash, "a");
		assert.equal(calls[0]!.configHash, "cafe");
		assert.equal(calls[1]!.attemptId, "7#1");
		assert.equal(calls[1]!.parentEventId, eventIdFor(calls[0]!.toolCallId), "each derived call chains onto the previous derived event");
	});

	test("bootReconcile reads the pi-durable transcript and is idempotent", async () => {
		const persistent = mkdtempSync(join(tmpdir(), "elr-reconcile-test-"));
		const lost = mkdtempSync(join(tmpdir(), "elr-reconcile-test-lost-"));
		process.env.DATA_DIR = lost; // the crashed run's journal, discarded
		process.env.OPENROUTER_API_KEY ||= "unused";
		resetJournalCache();
		try {
			const { harness, registry, conversation, conversationId } = await openHarness(persistent);
			const tools = canvasTools(registry);
			const callIds = scriptedCallIds();
			for (let i = 0; i < 2; i++) {
				const result = await runAction(tools, SCRIPTED_EPISODE[i]!, harness, registry, conversationId, callIds[i]!);
				await appendTranscript(conversation, { id: callIds[i]!, name: SCRIPTED_EPISODE[i]!.tool, arguments: SCRIPTED_EPISODE[i]!.args }, result, Date.now() + i);
			}

			process.env.DATA_DIR = persistent;
			resetJournalCache();
			const journal = journalFor(join(persistent, JOURNAL_DB_FILE));
			const transcript = await readConversationTranscript(conversation, BACKGROUND_CONTEXT);
			assert.equal(transcript.length, 4, "two actions give four transcript entries (call + result)");

			const first = await bootReconcile(journal, conversation, BACKGROUND_CONTEXT);
			const idsAfterFirst = journal.listEvents(conversationId).map((e) => e.id);
			const second = await bootReconcile(journal, conversation, BACKGROUND_CONTEXT);
			const idsAfterSecond = journal.listEvents(conversationId).map((e) => e.id);

			assert.equal(first, 2);
			assert.equal(second, 0);
			assert.equal(journal.countEvents(), 2);
			assert.deepEqual(idsAfterSecond, idsAfterFirst);

			journal.close();
			resetJournalCache();
			await harness.close(BACKGROUND_CONTEXT);
		} finally {
			resetJournalCache();
			rmSync(persistent, { recursive: true, force: true });
			rmSync(lost, { recursive: true, force: true });
		}
	});
}


function registerBootTests(): void {
	test("the boot log line names FTS5 availability and the counts", () => {
		assert.equal(journalReadyLine({ fts5: true, conversations: 2, inserted: 3 }), "[elr] journal ready: fts5=on conversations=2 eventsReconciled=3");
		assert.equal(journalReadyLine({ fts5: false, conversations: 0, inserted: 0 }), "[elr] journal ready: fts5=off conversations=0 eventsReconciled=0");
	});

	test("bootJournal migrates a missing /data/elr.sqlite", async () => {
		const dir = mkdtempSync(join(tmpdir(), "elr-boot-test-migrate-"));
		process.env.DATA_DIR = dir;
		resetJournalCache();
		try {
			const dbPath = join(dir, "elr.sqlite");
			assert.equal(existsSync(dbPath), false, "the journal is missing before boot");
			const booted = await bootJournal({ harness: { conversation: async () => undefined }, context: BACKGROUND_CONTEXT });
			assert.equal(existsSync(dbPath), true, "bootJournal creates the journal");
			assert.equal(booted.journal.schemaVersion(), JOURNAL_SCHEMA_VERSION);
			assert.equal(booted.fts5, booted.journal.fts5Available(), "the boot result reports the journal's FTS5 availability");
			const names = new Set(booted.journal.schemaObjects().map((object) => object.name));
			for (const table of JOURNAL_TABLES) assert.ok(names.has(table), `missing §4 table ${table}`);
			for (const fts of JOURNAL_FTS_TABLES) assert.ok(names.has(fts), `missing FTS5 table ${fts}`);
		} finally {
			resetJournalCache();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("bootJournal reconciles the pi-durable transcript idempotently", async () => {
		const persistent = mkdtempSync(join(tmpdir(), "elr-boot-test-"));
		const lost = mkdtempSync(join(tmpdir(), "elr-boot-test-lost-"));
		process.env.DATA_DIR = lost; // the live journal writes go somewhere that is discarded
		process.env.OPENROUTER_API_KEY ||= "unused";
		resetJournalCache();
		try {
			const { harness, registry, conversation, conversationId } = await openHarness(persistent);
			const tools = canvasTools(registry);
			const callIds = scriptedCallIds();
			for (let i = 0; i < 2; i++) {
				const result = await runAction(tools, SCRIPTED_EPISODE[i]!, harness, registry, conversationId, callIds[i]!);
				await appendTranscript(conversation, { id: callIds[i]!, name: SCRIPTED_EPISODE[i]!.tool, arguments: SCRIPTED_EPISODE[i]!.args }, result, Date.now() + i);
			}

			process.env.DATA_DIR = persistent;
			resetJournalCache();
			const first = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
			const idsAfterFirst = first.journal.listEvents(conversationId).map((event) => event.id);
			const second = await bootJournal({ harness, context: BACKGROUND_CONTEXT });
			const idsAfterSecond = second.journal.listEvents(conversationId).map((event) => event.id);

			assert.equal(first.inserted, 2, "the first boot re-derives both missing events");
			assert.equal(second.inserted, 0, "the second boot inserts nothing");
			assert.equal(first.journal.countEvents(), 2);
			assert.deepEqual(idsAfterSecond, idsAfterFirst);

			resetJournalCache();
			await harness.close(BACKGROUND_CONTEXT);
		} finally {
			resetJournalCache();
			rmSync(persistent, { recursive: true, force: true });
			rmSync(lost, { recursive: true, force: true });
		}
	});
}

const group = process.env.ELR_TEST_GROUP ?? "all";
if (group === "all" || group === "journal") registerJournalTests();
if (group === "all" || group === "episode") registerEpisodeTests();
if (group === "all" || group === "reconcile") registerReconcileTests();
if (group === "all" || group === "boot") registerBootTests();

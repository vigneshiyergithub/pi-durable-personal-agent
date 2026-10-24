// Child processes for the M2 journal crash-resume and boot-guard proofs (spec §4, §9 M2).
// Deliberately separate processes so the kills are real SIGKILLs, not simulated throws.
//
//   node bench/journal/children.ts reconcile pre-crash <persistentDir> <lostJournalDir>
//   node bench/journal/children.ts reconcile crash3    <persistentDir>
//   node bench/journal/children.ts reconcile resume3   <persistentDir> <resultJsonPath>
//   node bench/journal/children.ts reconcile check     <journalPath> <expected>
//   node bench/journal/children.ts boot      pre-crash <persistentDir> <lostDir>
//   node bench/journal/children.ts agent
//
// No network and no credentials: the model provider is registered but never called.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { bootReconcile, journalFor, readConversationTranscript, resetJournalCache, type JournalEvent } from "../../src/elr/journal.ts";
import { appendTranscript, canvasTools, JOURNAL_DB_FILE, openHarness, runAction, scriptedCallIds, SCRIPTED_EPISODE } from "./harness.ts";

function eventView(event: JournalEvent) {
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

function killSelf(): void {
	process.kill(process.pid, "SIGKILL");
	void new Promise<never>(() => {});
}

/** reconcile pre-crash: 3 actions, transcript committed, journal writes lost, then SIGKILL. */
async function reconcilePreCrash(persistentDir: string, lostJournalDir: string): Promise<void> {
	process.env.DATA_DIR = lostJournalDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	const { harness, registry, conversation, conversationId } = await openHarness(persistentDir);
	const tools = canvasTools(registry);
	const callIds = scriptedCallIds();
	for (let i = 0; i < 3; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now());
	}
	const lostJournal = journalFor(join(lostJournalDir, JOURNAL_DB_FILE));
	const marker = {
		mode: "pre-crash",
		conversationId,
		actionsRun: 3,
		persistentDir,
		transcriptFile: join(persistentDir, "agent.sqlite"),
		lostJournalPath: lostJournal.path,
		lostJournalEvents: lostJournal.listEvents(conversationId).map(eventView),
	};
	writeFileSync(join(persistentDir, "pre-crash.json"), JSON.stringify(marker, null, 2));
	process.stdout.write(`pre-crash: ran actions 1-3, transcript committed, killing with SIGKILL\n`);
	killSelf();
}

/** boot pre-crash: all 6 transcript entries, only actions 1-3 journaled persistently, then SIGKILL. */
async function bootPreCrash(persistentDir: string, lostDir: string): Promise<void> {
	mkdirSync(persistentDir, { recursive: true });
	process.env.OPENROUTER_API_KEY ||= "unused";
	process.env.DATA_DIR = persistentDir;
	resetJournalCache();
	const { harness, registry, conversation, conversationId } = await openHarness(persistentDir);
	const tools = canvasTools(registry);
	const callIds = scriptedCallIds();

	for (let i = 0; i < 3; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
	}
	const preCrashJournal = journalFor(join(persistentDir, JOURNAL_DB_FILE));
	const preCrashIds = preCrashJournal.listEvents(conversationId).map((event) => event.id);

	process.env.DATA_DIR = lostDir;
	resetJournalCache();
	for (let i = 3; i < SCRIPTED_EPISODE.length; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
	}

	const marker = {
		mode: "pre-crash",
		conversationId,
		actionsRun: SCRIPTED_EPISODE.length,
		persistentDir,
		transcriptFile: join(persistentDir, "agent.sqlite"),
		persistentJournalPath: preCrashJournal.path,
		preCrashIds,
		preCrashEventCount: preCrashIds.length,
		lostJournalPath: journalFor(join(lostDir, JOURNAL_DB_FILE)).path,
	};
	writeFileSync(join(persistentDir, "pre-crash.json"), JSON.stringify(marker, null, 2));
	process.stdout.write(`pre-crash: six transcript entries committed, journal holds ${preCrashIds.length} events, killing with SIGKILL\n`);
	killSelf();
}

/** reconcile crash3: actions 1-3 with a persistent journal, then SIGKILL (nothing is lost). */
async function crashAfterThree(persistentDir: string): Promise<void> {
	process.env.DATA_DIR = persistentDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const { harness, registry, conversation, conversationId } = await openHarness(persistentDir);
	const tools = canvasTools(registry);
	const callIds = scriptedCallIds();
	for (let i = 0; i < 3; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
	}
	const journal = journalFor(join(persistentDir, JOURNAL_DB_FILE));
	const events = journal.listEvents(conversationId).map(eventView);
	const marker = {
		mode: "crash3",
		conversationId,
		actionsRun: 3,
		journalEvents: events,
		journalEventCount: events.length,
		transcriptEntries: 3,
		journalPath: journal.path,
		transcriptFile: join(persistentDir, "agent.sqlite"),
	};
	writeFileSync(join(persistentDir, "crash3.json"), JSON.stringify(marker, null, 2));
	process.stdout.write(`crash3: actions 1-3 journaled+transcribed (${events.length} journal events), killing with SIGKILL\n`);
	killSelf();
}

/** reconcile resume3: reconcile the crashed journal, resume actions 4-6, write the event sets. */
async function resumeAfterThree(persistentDir: string, resultJsonPath: string): Promise<void> {
	process.env.DATA_DIR = persistentDir;
	process.env.OPENROUTER_API_KEY ||= "unused";
	resetJournalCache();
	const { harness, registry, conversation, conversationId } = await openHarness(persistentDir);
	const tools = canvasTools(registry);
	const callIds = scriptedCallIds();
	const journal = journalFor(join(persistentDir, JOURNAL_DB_FILE));

	const before = journal.listEvents(conversationId).map(eventView);
	const transcript = await readConversationTranscript(conversation, BACKGROUND_CONTEXT);
	const inserted = await bootReconcile(journal, conversation, BACKGROUND_CONTEXT);
	const afterReconcile = journal.listEvents(conversationId).map(eventView);

	for (let i = 3; i < SCRIPTED_EPISODE.length; i++) {
		const action = SCRIPTED_EPISODE[i]!;
		const result = await runAction(tools, action, harness, registry, conversationId, callIds[i]!);
		if (result.isError === true) throw new Error(`resumed action ${i + 1} (${action.tool}) failed`);
		await appendTranscript(conversation, { id: callIds[i]!, name: action.tool, arguments: action.args }, result, Date.now() + i);
	}

	const final = journal.listEvents(conversationId).map(eventView);
	const result = {
		mode: "resume3",
		conversationId,
		transcriptSource: {
			file: join(persistentDir, "agent.sqlite"),
			table: "entries",
			function: 'Conversation.entries({ order: "ascending" }, limit, cursor, context)',
		},
		transcriptEntries: transcript.length,
		before,
		inserted,
		afterReconcile,
		final,
	};
	writeFileSync(resultJsonPath, JSON.stringify(result, null, 2));
	await journal.close();
	await harness.close(BACKGROUND_CONTEXT);
	console.log(`resume3: before=${before.length}, reconciler inserted=${inserted}, final=${final.length} events`);
}

/** reconcile check: reject a journal with duplicate toolCallIds or the wrong event count. */
function checkJournal(journalPath: string, expected: number): void {
	const db = new DatabaseSync(journalPath);
	try {
		const dupes = db
			.prepare("SELECT toolCallId, COUNT(*) AS c FROM events GROUP BY toolCallId HAVING c > 1")
			.all()
			.map((row) => `${String((row as Record<string, unknown>).toolCallId)} x${String((row as Record<string, unknown>).c)}`);
		const count = Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as Record<string, unknown>).c);
		if (dupes.length > 0) {
			process.stderr.write(`check FAILED: duplicate toolCallIds: ${dupes.join(", ")}\n`);
			process.exit(3);
		}
		if (count !== expected) {
			process.stderr.write(`check FAILED: expected ${expected} events, found ${count}\n`);
			process.exit(4);
		}
		process.stdout.write(`check OK: ${count} events, 0 duplicate toolCallIds\n`);
	} finally {
		db.close();
	}
}

const [mode, sub, first, second] = process.argv.slice(2);
try {
	if (mode === "reconcile" && sub === "pre-crash" && first !== undefined && second !== undefined) {
		await reconcilePreCrash(first, second);
	} else if (mode === "reconcile" && sub === "crash3" && first !== undefined) {
		await crashAfterThree(first);
	} else if (mode === "reconcile" && sub === "resume3" && first !== undefined && second !== undefined) {
		await resumeAfterThree(first, second);
	} else if (mode === "reconcile" && sub === "check" && first !== undefined && second !== undefined) {
		checkJournal(first, Number(second));
	} else if (mode === "boot" && sub === "pre-crash" && first !== undefined && second !== undefined) {
		await bootPreCrash(first, second);
	} else if (mode === "agent") {
		const { Agent } = await import("../../src/agent.ts");
		const agent = await Agent.open();
		console.log("AGENT_OPEN_OK");
		await agent.close();
	} else {
		console.error("usage: children.ts reconcile pre-crash <persistentDir> <lostJournalDir> | reconcile crash3 <persistentDir> | reconcile resume3 <persistentDir> <resultJson> | reconcile check <journalPath> <expected> | boot pre-crash <persistentDir> <lostDir> | agent");
		process.exit(2);
	}
} catch (error) {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	if (mode === "agent") console.error(`AGENT_OPEN_THREW: ${detail}`);
	else console.error(`FAIL: ${detail}`);
	process.exit(1);
}

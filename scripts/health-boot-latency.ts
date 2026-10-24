// Fast-boot latency harness for the journal reconciler (ELR M2 hygiene).
//
// It measures the real production boot path — the real `Agent.open()` start-up plus the real HTTP
// listener (`startHttp`) — against a throwaway `DATA_DIR`. A synthetic pi-durable transcript of N
// canvas actions (default 3000) is seeded into `agent.sqlite`, the exact storage shape the boot
// reconciler reads, and the journal is removed first so the reconciler really re-derives every
// event. The clock starts the instant the boot begins (the earliest instant the listener could be
// reachable); a tight retry loop on ECONNREFUSED records the elapsed time at the *first* `GET
// /health` that answers 200, with no sleep between attempts and no coarse polling.
//
// One machine-readable line is printed:
//   health latency: 3917ms (budget 1000ms, mode fast, events 3000, dataDir /tmp/agent-health-latency-XXXX)
// The process exits 0 exactly when the measured latency is <= HEALTH_BUDGET_MS (default 1000).
//
// HEALTH_BOOT_MODE selects the ordering through the single options-only hook
// (AgentOptions.reconcileBeforeListen, default off). "fast" (default) is the production boot: the
// listener comes up first and the reconcile is deferred. "sync" forces the pre-fix ordering, where
// the whole reconcile is awaited inside Agent.open() before the listener starts. The cost of the
// genuine reconcile grows with HEALTH_EVENTS (default 3000), so the negative control runs "sync"
// with a larger transcript; there is no artificial pause:
//   node scripts/health-boot-latency.ts
//   HEALTH_BOOT_MODE=sync HEALTH_EVENTS=80000 node scripts/health-boot-latency.ts
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server as HttpServer } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Agent as AgentInstance } from "../src/agent.ts";

const BUDGET_MS = Number(process.env.HEALTH_BUDGET_MS ?? "1000");
const EVENTS = Number(process.env.HEALTH_EVENTS ?? "3000");
// "fast" measures the production boot (listener first, reconcile deferred). "sync" forces the
// pre-fix ordering via the test-only AgentOptions.reconcileBeforeListen hook; the real reconcile cost
// grows with HEALTH_EVENTS, so no artificial delay is needed.
const MODE = process.env.HEALTH_BOOT_MODE ?? "fast";
const SEED_BATCH = 250;
const REQUEST_TIMEOUT_MS = 5_000;
const FIRST_HEALTH_DEADLINE_MS = 120_000;

if (!Number.isFinite(BUDGET_MS) || BUDGET_MS < 0) {
	console.error(`health-boot-latency: HEALTH_BUDGET_MS must be a non-negative number, got ${process.env.HEALTH_BUDGET_MS}`);
	process.exit(2);
}
if (!Number.isInteger(EVENTS) || EVENTS < 1) {
	console.error(`health-boot-latency: HEALTH_EVENTS must be a positive integer, got ${process.env.HEALTH_EVENTS}`);
	process.exit(2);
}
if (MODE !== "fast" && MODE !== "sync") {
	console.error(`health-boot-latency: HEALTH_BOOT_MODE must be "fast" or "sync", got ${process.env.HEALTH_BOOT_MODE}`);
	process.exit(2);
}

// Everything below reads DATA_DIR/PORT at import time, so set them before the dynamic imports.
const dataDir = await mkdtemp(join(tmpdir(), "agent-health-latency-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "health-boot-latency-bootstrap";

/** Seed `count` canvas actions (assistant toolCall + tool-result entries) into the pi-durable store. */
async function seedTranscript(dir: string, count: number): Promise<void> {
	const models = createModels();
	models.setProvider(openrouterProvider());
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(dir, "agent.sqlite")),
		{ models, registry: createRegistry(), onReport: () => {} },
		BACKGROUND_CONTEXT,
	);
	try {
		const conversation = await harness.root(BACKGROUND_CONTEXT);
		for (let start = 0; start < count; start += SEED_BATCH) {
			const end = Math.min(start + SEED_BATCH, count);
			await conversation.commit(async (tx) => {
				for (let i = start; i < end; i++) {
					const toolCallId = `health-seed-${i}`;
					await tx.appendEntry(conversation.id, {
						kind: "pi.assistant",
						model: [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: toolCallId, name: "paint", arguments: { points: [[i % 256, 0], [0, i % 256]], width: 3 } }],
							},
						],
					} as never);
					await tx.appendEntry(conversation.id, {
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
						],
					} as never);
				}
			}, BACKGROUND_CONTEXT);
		}
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
	}
}

/** A port nothing is listening on yet, so the retry loop sees real ECONNREFUSED until the listener binds. */
async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe: Server = createServer();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = address !== null && typeof address === "object" ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

/**
 * Tightly retry `GET /health` and return the elapsed milliseconds at the first 200. Between a
 * refused connection and the next attempt there is no sleep: a single `setImmediate` yields to the
 * event loop (so the boot can progress) without hiding the true first-response time.
 */
async function firstHealthMs(url: string, startedAt: number, deadlineMs: number): Promise<number> {
	for (;;) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
			const arrivedAt = performance.now();
			await response.arrayBuffer().catch(() => {});
			if (response.status === 200) return arrivedAt - startedAt;
		} catch {
			// The listener is not up yet (ECONNREFUSED) or the request timed out: retry at once.
		}
		if (performance.now() - startedAt > deadlineMs) throw new Error(`/health did not return 200 within ${deadlineMs}ms`);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** Events committed to the journal by the boot reconcile, or undefined if it cannot be read. */
function reconciledEvents(journalPath: string): number | undefined {
	try {
		const db = new DatabaseSync(journalPath, { readOnly: true });
		try {
			return Number((db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c);
		} finally {
			db.close();
		}
	} catch {
		return undefined;
	}
}

console.log(`health-boot-latency: seeding ${EVENTS} canvas events into ${join(dataDir, "agent.sqlite")} ...`);
await seedTranscript(dataDir, EVENTS);
// Force the reconciler to do all the work: no pre-existing journal beside the seeded transcript.
for (const suffix of ["", "-wal", "-shm"]) await rm(join(dataDir, "elr.sqlite") + suffix, { force: true });

const port = await freePort();
process.env.PORT = String(port);
const url = `http://127.0.0.1:${port}/health`;
console.log(`health-boot-latency: mode=${MODE}${MODE === "sync" ? " (forced sync: reconcile awaited before listen)" : ""}`);
console.log(`health-boot-latency: booting the real Agent.open() + HTTP listener on 127.0.0.1:${port} ...`);

// Dynamic imports: src/config.ts reads DATA_DIR/PORT at import time, so they must load after they are set.
const { Agent } = await import("../src/agent.ts");
const { startHttp } = await import("../src/http.ts");

const bootOptions = MODE === "sync" ? { reconcileBeforeListen: true } : {};
const startedAt = performance.now();
const health = firstHealthMs(url, startedAt, FIRST_HEALTH_DEADLINE_MS);
health.catch(() => {}); // if the boot throws first, this rejection is reported below, not as unhandled
let latencyMs = Number.POSITIVE_INFINITY;
let agent: AgentInstance | undefined;
let server: HttpServer | undefined;
let bootError: unknown;
try {
	const booted = await Agent.open(bootOptions);
	agent = booted;
	server = startHttp(booted);
	latencyMs = await health;
	// The listener is up (and /health answered): now wait for the deferred reconcile to finish before
	// reading the journal, so the count check below is not racing it.
	await booted.reconcileDone;
} catch (error) {
	bootError = error;
}
server?.close();

const journalPath = join(dataDir, "elr.sqlite");
const reconciled = bootError === undefined ? reconciledEvents(journalPath) : undefined;
if (reconciled !== undefined) {
	console.log(`health-boot-latency: journal reconciled ${reconciled} events (seeded ${EVENTS})`);
}

if (bootError !== undefined) {
	console.error(`health-boot-latency: boot failed: ${bootError instanceof Error ? (bootError.stack ?? bootError.message) : String(bootError)}`);
} else if (latencyMs === Number.POSITIVE_INFINITY) {
	console.log(`health latency: >${FIRST_HEALTH_DEADLINE_MS}ms (budget ${BUDGET_MS}ms, mode ${MODE}, events ${EVENTS}, dataDir ${dataDir})`);
} else {
	console.log(`health latency: ${Math.round(latencyMs)}ms (budget ${BUDGET_MS}ms, mode ${MODE}, events ${EVENTS}, dataDir ${dataDir})`);
}

const withinBudget = bootError === undefined && latencyMs <= BUDGET_MS;
if (reconciled !== undefined && reconciled !== EVENTS) {
	console.error(`health-boot-latency: the reconciler inserted ${reconciled} events, expected ${EVENTS}`);
}

await agent?.close();
await rm(dataDir, { recursive: true, force: true });

if (!withinBudget) process.exit(1);
if (reconciled !== undefined && reconciled !== EVENTS) process.exit(1);
process.exit(0);

// Boot-responsiveness harness for the ELR M2 hygiene split (acceptance criterion 2).
//
// Drives the real `Agent.open()` + HTTP listener against a throwaway DATA_DIR with a 3,000-event
// transcript and no pre-existing journal (so the deferred reconcile really re-derives all 3,000).
// From the moment the listener is started it polls `GET /health` in a tight loop until the reconcile
// handle (`agent.reconcileDone`) resolves, recording every request and its latency. It then asserts:
//   - the reconcile finished after the listener was up, with requests answered while it ran,
//   - at least one `/health` request was answered before the reconcile resolved,
//   - the maximum observed request latency is below the budget (default 1000 ms),
//   - the reconcile reported ok and imported every seeded event.
// Exits 0 only when all of the above hold.
//
//   node scripts/health-during-reconcile.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort, seedCanvasTranscript } from "./health-harness.ts";

const BUDGET_MS = Number(process.env.HEALTH_BUDGET_MS ?? "1000");
const EVENTS = Number(process.env.HEALTH_EVENTS ?? "3000");
const REQUEST_TIMEOUT_MS = 5_000;
const DEADLINE_MS = 120_000;

if (!Number.isFinite(BUDGET_MS) || BUDGET_MS < 0) {
	console.error(`health-during-reconcile: HEALTH_BUDGET_MS must be a non-negative number, got ${process.env.HEALTH_BUDGET_MS}`);
	process.exit(2);
}
if (!Number.isInteger(EVENTS) || EVENTS < 1) {
	console.error(`health-during-reconcile: HEALTH_EVENTS must be a positive integer, got ${process.env.HEALTH_EVENTS}`);
	process.exit(2);
}

const dataDir = await mkdtemp(join(tmpdir(), "agent-health-during-reconcile-"));
process.env.DATA_DIR = dataDir;
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "health-during-reconcile";

console.log(`health-during-reconcile: seeding ${EVENTS} canvas events into ${join(dataDir, "agent.sqlite")} ...`);
await seedCanvasTranscript(dataDir, EVENTS);
for (const suffix of ["", "-wal", "-shm"]) await rm(join(dataDir, "elr.sqlite") + suffix, { force: true });

const port = await freePort();
process.env.PORT = String(port);
const url = `http://127.0.0.1:${port}/health`;

const { Agent } = await import("../src/agent.ts");
const { startHttp } = await import("../src/http.ts");

const agent = await Agent.open();

let done = false;
let doneAt = 0;
const outcomePromise = agent.reconcileDone;
outcomePromise.then(() => {
	done = true;
	doneAt = performance.now();
});

const listenAt = performance.now();
const server = startHttp(agent);

let count = 0;
let during = 0;
let maxLatency = 0;
let firstHealthAt = 0;
const latencies: number[] = [];
const deadline = performance.now() + DEADLINE_MS;
while (!(done && count > 0) && performance.now() < deadline) {
	const requestStart = performance.now();
	let status: number | undefined;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		await response.arrayBuffer().catch(() => {});
		status = response.status;
	} catch {
		// The listener is not up yet (ECONNREFUSED) or the request timed out: retry at once.
	}
	const latency = performance.now() - requestStart;
	if (status === 200) {
		count++;
		latencies.push(latency);
		if (latency > maxLatency) maxLatency = latency;
		if (firstHealthAt === 0) firstHealthAt = performance.now();
		if (!done) during++;
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const outcome = await outcomePromise;
server.close();
await agent.close();
await rm(dataDir, { recursive: true, force: true });

const sorted = [...latencies].sort((a, b) => a - b);
const median = sorted.length === 0 ? 0 : sorted[Math.floor(sorted.length / 2)]!;
console.log(`health-during-reconcile: requests=${count} answeredWhileReconciling=${during} maxLatency=${Math.round(maxLatency)}ms medianLatency=${Math.round(median)}ms budget=${BUDGET_MS}ms`);
console.log(`health-during-reconcile: firstHealth=${firstHealthAt === 0 ? "none" : `${Math.round(firstHealthAt - listenAt)}ms after listen`} reconcileDone=${doneAt === 0 ? "never" : `${Math.round(doneAt - listenAt)}ms after listen`}`);
console.log(`health-during-reconcile: reconcile ok=${outcome.ok} conversations=${outcome.conversations} imported=${outcome.inserted} errors=${outcome.error === undefined ? 0 : 1}`);

const ok =
	done &&
	outcome.ok &&
	outcome.error === undefined &&
	outcome.inserted === EVENTS &&
	count > 0 &&
	during > 0 &&
	firstHealthAt > listenAt &&
	doneAt > firstHealthAt &&
	maxLatency < BUDGET_MS;
if (!ok) {
	console.error("health-during-reconcile: FAIL");
	process.exit(1);
}
console.log("health-during-reconcile: PASS");
process.exit(0);

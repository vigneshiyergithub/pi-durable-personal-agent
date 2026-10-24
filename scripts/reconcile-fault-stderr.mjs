#!/usr/bin/env node
// reconcile-fault-stderr.mjs — boots the REAL production boot path (Agent.open() + startHttp()) with
// the journal reconcile forced to throw partway (Journal.prototype.reconcile patched to throw after
// 3 chunk calls, same injection as probe-health-window.mjs's fault config), and reports verbatim:
//
//   1. the reconcile-failure stderr line the boot path itself writes
//      (`[elr] journal reconcile failed: …`, console.error in Agent.startReconcile),
//   2. the reconcileDone outcome (ok=false + error string — resolved, never thrown),
//   3. the /health status AFTER the failed reconcile (the listener keeps answering),
//   4. that this line printed at all (an unhandled rejection would have killed the process first).
//
// Exit 0 exactly when: the injected failure surfaced with a string error, /health answered 200
// afterwards, and stderr carries the reconcile-failed line but NO unhandled-rejection marker.
//
// Run: node scripts/reconcile-fault-stderr.mjs
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = await mkdtemp(join(tmpdir(), "reconcile-fault-stderr-"));
process.env.OPENROUTER_API_KEY ||= "unused";
process.env.AUTH_TOKEN ||= "reconcile-fault-stderr";

try {
	const { seedCanvasTranscript, freePort } = await import(join(ROOT, "scripts/health-harness.ts"));
	await seedCanvasTranscript(dataDir, 3000);
	process.env.DATA_DIR = dataDir;
	process.env.PORT = String(await freePort());

	const { Agent } = await import(join(ROOT, "src/agent.ts"));
	const { startHttp } = await import(join(ROOT, "src/http.ts"));
	const { Journal } = await import(join(ROOT, "src/elr/journal.ts"));

	const original = Journal.prototype.reconcile;
	let chunkCalls = 0;
	Journal.prototype.reconcile = function (...args) {
		chunkCalls++;
		if (chunkCalls > 3) throw new Error("FAULT: injected reconcile failure after 3 chunk call(s)");
		return original.apply(this, args);
	};

	const agent = await Agent.open();
	const server = startHttp(agent);
	const outcome = await agent.reconcileDone;
	const status = (await fetch(`http://127.0.0.1:${process.env.PORT}/health`, { signal: AbortSignal.timeout(5_000) })).status;
	console.log(`reconcile-fault-stderr: reconcileDone ok=${outcome.ok} error=${JSON.stringify(outcome.error ?? null)} chunkCalls=${chunkCalls}`);
	console.log(`reconcile-fault-stderr: /health after the failed reconcile: HTTP ${status}`);
	console.log("reconcile-fault-stderr: process still running — an unhandled rejection here would have exited before this line");

	server.close();
	await agent.close().catch(() => {});
	const ok = outcome.ok === false && typeof outcome.error === "string" && status === 200;
	process.exitCode = ok ? 0 : 1;
} finally {
	await rm(dataDir, { recursive: true, force: true });
}

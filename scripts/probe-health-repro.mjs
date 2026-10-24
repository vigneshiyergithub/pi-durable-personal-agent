#!/usr/bin/env node
// probe-health-repro.mjs — measure GET /health availability while the server boots, to attribute the
// production warning "probes: GET /health no answer" observed after the ELR M2 merge (88f2ab3).
//
// It is a MEASUREMENT tool, not a gate: it exits 0 only once it has produced every measurement it was
// asked for (both runs answered /health within the deadline), and non-zero if a run produced none.
//
// What it does, per run:
//   1. starts the server exactly as production does (src/main.ts, --max-old-space-size=1536,
//      OPENROUTER_API_KEY= empty, NODE_ENV=production, a free port, a throwaway DATA_DIR);
//   2. polls GET /health every POLL_INTERVAL_MS using the SAME per-request timeout as the production
//      observation probe, read from src/orchestra.ts at run time (see the printout for file:line);
//   3. reports ms from process start to the first successful /health, the number of failed polls, and
//      the failure mode of each (timeout / connection refused / non-200 / other).
//
// Two runs:
//   empty      — a fresh, uninitialised DATA_DIR.
//   populated  — a DATA_DIR whose pi-durable store (agent.sqlite) has a few thousand planted
//                transcript events (the source of truth the spec §4 boot reconciler reads).
//
// Run:  node scripts/probe-health-repro.mjs
// Seed only (used internally):  DATA_DIR=<dir> SEED_EVENTS=<n> node scripts/probe-health-repro.mjs --seed
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");

const POLL_INTERVAL_MS = 200;
const FIRST_SUCCESS_DEADLINE_MS = 30_000;
const SEED_EVENTS = Number(process.env.SEED_EVENTS ?? 3000);
const SEED_BATCH = 250;

// ── Read the production probe's timeout and wording straight from its source, so this harness can
//    never silently drift from what src/orchestra.ts actually does. ────────────────────────────────
function sourceCitation() {
	const file = join(ROOT, "src/orchestra.ts");
	const text = readFileSync(file, "utf8");
	const timeout = /AbortSignal\.timeout\(\s*([\d_]+)\s*\)/.exec(text);
	const wording = /"no answer"/.exec(text);
	if (!timeout || !wording) throw new Error("could not find the production probe timeout/wording in src/orchestra.ts");
	const lineOf = (index) => text.slice(0, index).split("\n").length;
	return {
		file: "src/orchestra.ts",
		timeoutMs: Number(timeout[1].replace(/_/g, "")),
		timeoutLine: lineOf(timeout.index),
		noAnswerLine: lineOf(wording.index),
	};
}

// ── What is actually wired into boot / the request path in this tree? (reported, not assumed) ──────
function treeFacts() {
	const journalPresent = existsSync(join(ROOT, "src/elr/journal.ts"));
	const verifierRefs = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (full.endsWith(join("src", "elr", "verifier"))) continue;
				walk(full);
			} else if (entry.name.endsWith(".ts")) {
				const text = readFileSync(full, "utf8");
				if (/from\s+"[^"]*verifier/.test(text)) verifierRefs.push(full.slice(ROOT.length + 1));
			}
		}
	};
	walk(join(ROOT, "src"));
	return { journalPresent, verifierRefs };
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
	return await new Promise((done, fail) => {
		const server = createServer();
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => done(typeof address === "object" && address ? address.port : 0));
		});
	});
}

function errorCode(error) {
	for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) {
		if (typeof e.code === "string") return e.code;
		if (Array.isArray(e.errors)) {
			for (const inner of e.errors) {
				const code = errorCode(inner);
				if (code) return code;
			}
		}
	}
	return undefined;
}

async function pollOnce(url, timeoutMs) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
		return response.status === 200
			? { ok: true, status: response.status, mode: "ok" }
			: { ok: false, status: response.status, mode: `non-200 HTTP ${response.status}` };
	} catch (error) {
		const name = error?.name ?? "";
		const text = String(error?.message ?? "");
		if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(text)) return { ok: false, mode: "timeout" };
		const code = errorCode(error);
		if (code === "ECONNREFUSED") return { ok: false, mode: "connection refused" };
		if (code === "ECONNRESET") return { ok: false, mode: "connection reset" };
		if (code) return { ok: false, mode: `connection error (${code})` };
		return { ok: false, mode: `fetch error (${name || text || "unknown"})` };
	}
}

function startServer({ dataDir, port, timeoutMs }) {
	const lines = [];
	const child = spawn(process.execPath, ["--max-old-space-size=1536", "src/main.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			NODE_ENV: "production",
			OPENROUTER_API_KEY: "", // defined-and-empty, exactly as the repo's verify command runs it
			DATA_DIR: dataDir,
			PORT: String(port),
			AUTH_TOKEN: "",
			TELEGRAM_BOT_TOKEN: "",
			TELEGRAM_OWNER_ID: "",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			for (const line of chunk.split("\n")) if (line.trim()) lines.push(line);
			if (lines.length > 40) lines.splice(0, lines.length - 40);
		});
	}
	return { child, lines, timeoutMs };
}

async function stopServer({ child }) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((done) => child.once("exit", done));
	child.kill("SIGTERM");
	await Promise.race([exited, sleep(4000)]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		await Promise.race([exited, sleep(2000)]);
	}
}

async function measure(label, dataDir, timeoutMs) {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}/health`;
	const startedAt = Date.now();
	const server = startServer({ dataDir, port, timeoutMs });
	const failures = [];
	let firstSuccessMs = null;
	let exit = null;
	server.child.once("exit", (code, signal) => void (exit = { code, signal }));
	const deadline = startedAt + FIRST_SUCCESS_DEADLINE_MS;
	while (Date.now() < deadline) {
		const result = await pollOnce(url, server.timeoutMs);
		const atMs = Date.now() - startedAt;
		if (result.ok) {
			firstSuccessMs = atMs;
			break;
		}
		failures.push({ atMs, mode: result.mode });
		if (exit) break;
		await sleep(POLL_INTERVAL_MS);
	}
	await stopServer(server);
	const modes = {};
	for (const failure of failures) modes[failure.mode] = (modes[failure.mode] ?? 0) + 1;
	return {
		label,
		dataDir,
		firstSuccessMs,
		failedPolls: failures.length,
		failureModes: modes,
		firstFailures: failures.slice(0, 5),
		serverExitedEarly: firstSuccessMs === null ? exit : null,
		logTail: server.lines.slice(-8),
	};
}

// ── Seed mode: plant a bounded pi-durable transcript into DATA_DIR/agent.sqlite. ───────────────────
async function seed() {
	const dataDir = process.env.DATA_DIR;
	if (!dataDir) throw new Error("--seed needs DATA_DIR");
	const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
	const { Agent } = await import(join(ROOT, "src/agent.ts"));
	const agent = await Agent.open();
	const conversationId = agent.root.id;
	for (let index = 0; index < SEED_EVENTS; index += SEED_BATCH) {
		const end = Math.min(index + SEED_BATCH, SEED_EVENTS);
		await agent.root.commit(async (tx) => {
			for (let i = index; i < end; i++) {
				const toolCallId = `seed-tool-${i}`;
				const now = Date.now();
				await tx.appendEntry(conversationId, {
					kind: "pi.assistant",
					model: [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: toolCallId, name: "paint", arguments: { points: [[i % 256, 0], [0, i % 256]], width: 3 } }],
						},
					],
				});
				await tx.appendEntry(conversationId, {
					kind: "pi.tool-result",
					model: [
						{
							role: "toolResult",
							toolCallId,
							toolName: "paint",
							isError: false,
							timestamp: now,
							content: [{ type: "text", text: "painted" }],
							details: {
								namespace: "painting",
								version: 1,
								configHash: `seed-${i}`,
								tool: "paint",
								attempt: 1,
								opHash: `op-${i}`,
								beforeHash: `before-${i}`,
								afterHash: `after-${i}`,
							},
						},
					],
				});
			}
		}, BACKGROUND_CONTEXT);
	}
	// Time the full transcript read the spec §4 boot reconciler performs (its dominant cost): page
	// through every committed entry, ascending, the same way readConversationTranscript() does.
	const scanStartedAt = Date.now();
	let scanned = 0;
	let cursor;
	for (;;) {
		const page = await agent.root.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
		scanned += page.items.length;
		if (page.next === undefined) break;
		cursor = page.next;
	}
	console.log(`transcript scan (spec §4 reconciler read): ${scanned} entries in ${Date.now() - scanStartedAt} ms`);
	await agent.close();
	process.stdout.write(`seeded ${SEED_EVENTS} transcript events into ${dataDir}\n`);
}

async function seedChild(dataDir) {
	await new Promise((done, fail) => {
		const child = spawn(process.execPath, [SCRIPT, "--seed"], {
			cwd: ROOT,
			env: { ...process.env, NODE_ENV: "production", OPENROUTER_API_KEY: "", DATA_DIR: dataDir, SEED_EVENTS: String(SEED_EVENTS) },
			stdio: "inherit",
		});
		child.once("exit", (code) => (code === 0 ? done() : fail(new Error(`seeder exited ${code}`))));
	});
}

async function main() {
	if (process.argv.includes("--seed")) return seed();

	const citation = sourceCitation();
	const facts = treeFacts();
	console.log("=== /health boot-availability reproduction: ELR M2 warning follow-up ===");
	console.log(`production probe timeout: ${citation.timeoutMs} ms  (${citation.file}:${citation.timeoutLine})`);
	console.log(`"no answer" detail wording: ${citation.file}:${citation.noAnswerLine}`);
	console.log(`poll interval: ${POLL_INTERVAL_MS} ms, first-success deadline: ${FIRST_SUCCESS_DEADLINE_MS} ms`);
	console.log(`M2 journal present in this tree (src/elr/journal.ts): ${facts.journalPresent}`);
	console.log(`src/** imports the verifier (outside src/elr/verifier): ${facts.verifierRefs.length ? facts.verifierRefs.join(", ") : "none -> verifier runs on no boot/request path"}`);

	const reports = [];
	const emptyDir = await mkdtemp(join(tmpdir(), "probe-health-empty-"));
	try {
		reports.push(await measure("empty", emptyDir, citation.timeoutMs));
	} finally {
		await rm(emptyDir, { recursive: true, force: true });
	}

	const populatedDir = await mkdtemp(join(tmpdir(), "probe-health-populated-"));
	try {
		console.log(`\nseeding populated run (${SEED_EVENTS} events) in ${populatedDir} ...`);
		await seedChild(populatedDir);
		reports.push(await measure("populated", populatedDir, citation.timeoutMs));
	} finally {
		await rm(populatedDir, { recursive: true, force: true });
	}

	for (const report of reports) {
		console.log(`\n--- ${report.label} run ---`);
		console.log(`ms to first successful /health after process start: ${report.firstSuccessMs === null ? "NONE" : report.firstSuccessMs}`);
		console.log(`failed polls before first success: ${report.failedPolls}`);
		console.log(`failure modes: ${JSON.stringify(report.failureModes)}`);
		if (report.firstFailures.length) console.log(`first failures: ${JSON.stringify(report.firstFailures)}`);
		if (report.serverExitedEarly) console.log(`server exited before answering: ${JSON.stringify(report.serverExitedEarly)}`);
	}
	console.log(`\nsummary: ${JSON.stringify(reports.map((r) => ({ label: r.label, firstSuccessMs: r.firstSuccessMs, failedPolls: r.failedPolls, failureModes: r.failureModes })))}`);

	const complete = reports.length === 2 && reports.every((r) => typeof r.firstSuccessMs === "number");
	console.log(`\nall required measurements produced: ${complete}`);
	process.exitCode = complete ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});

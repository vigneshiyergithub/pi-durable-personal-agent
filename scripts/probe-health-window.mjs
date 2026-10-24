#!/usr/bin/env node
// probe-health-window.mjs — continuous /health probe through the real boot + deferred journal
// reconcile, to reproduce (or falsify) the production warning "probes: GET /health no answer"
// observed while 0091c15 (ELR M2 hygiene) was live.
//
// It is a MEASUREMENT tool, not a gate: it exits 0 when every requested run produced its full set
// of measurements (and fault-injection runs survived their injected failure with /health still
// answering); it exits non-zero when a measurement is missing or a fault run crashed the process.
// A large worst gap is a finding that is printed loudly, not a non-zero exit.
//
// What one run does:
//   1. seeds a throwaway DATA_DIR's pi-durable store (agent.sqlite) with N deterministic canvas
//      actions (reusing scripts/health-harness.ts's seeder in a child process, so the measuring
//      parent stays idle) and leaves elr.sqlite absent so the boot reconcile re-derives all N;
//   2. spawns the real boot path as a child — the real Agent.open() plus the real startHttp()
//      listener on an ephemeral port, exactly as src/http.ts wires it (listener first, reconcile
//      deferred to a setImmediate in the listen callback);
//   3. probes GET /health every PHW_POLL_MS (default 50 ms) with the production observer probe's
//      own per-request timeout, read from src/orchestra.ts at run time — a rejected fetch there
//      renders as "GET /health no answer" — from before Agent.open() until a bounded quiet period
//      after the reconcile completion signal (the child prints a marker when the real
//      agent.reconcileDone promise resolves); parallel TCP-connect probes find when the listener
//      starts accepting connections;
//   4. reports, per run: time to listener accept, time to first /health 200, the worst gap between
//      consecutive successful /health responses after the first 200 (the worst window in which the
//      process was listening but not answering), the reconcile wall time, and whether the process
//      exited/crashed during the run (exit code, signal, unhandled-rejection / uncaughtException
//      markers on stderr); then per-configuration min/max over the repeats.
//
// Configurations (PHW_CONFIGS, default "control,large,xlarge,fault"):
//   control — empty transcript (0 canvas events): the delta vs the large runs is the reconcile's cost.
//   large   — PHW_EVENTS_LARGE events (default 3000, the production repro's scale).
//   xlarge  — PHW_EVENTS_XLARGE events (default 80000) to make any starvation obvious.
//   block   — NEGATIVE CONTROL: PHW_RECONCILE_BEFORE_LISTEN=1 restores the pre-#20 ordering, the
//             whole real reconcile awaited inside Agent.open() before the listener starts
//             (AgentOptions.reconcileBeforeListen in src/agent.ts, test-only, default off). The
//             failure is the genuine reconcile work at PHW_EVENTS_BLOCK events (default 400000),
//             not an injected sleep: the first /health 200 lands only after boot + read + reconcile,
//             far past the production probe timeout.
//   fault   — FORCE_RECONCILE_ERROR=1: the journal's chunked reconcile throws partway (after
//             FORCE_RECONCILE_ERROR_AFTER chunk calls, default 3); reports whether the process
//             survives it and whether /health keeps answering afterwards.
//
// Knobs: PHW_CONFIGS, PHW_REPEATS (default 3), PHW_POLL_MS (50), PHW_PROBE_TIMEOUT_MS (production
// value), PHW_QUIET_MS (1000), PHW_RUN_DEADLINE_MS (60000), PHW_EVENTS_{CONTROL,LARGE,XLARGE,FAULT},
// PHW_EVENTS_BLOCK, PHW_RECONCILE_BEFORE_LISTEN (set by the block config only),
// FORCE_RECONCILE_ERROR, FORCE_RECONCILE_ERROR_AFTER.
//
// Run:  node scripts/probe-health-window.mjs
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT), "..");
const CHILD = process.argv.includes("--child");
const SEED = process.argv.includes("--seed");

const knob = (name, fallback) => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number, got ${raw}`);
	return value;
};

const POLL_MS = knob("PHW_POLL_MS", 50);
const QUIET_MS = knob("PHW_QUIET_MS", 1_000);
const RUN_DEADLINE_MS = knob("PHW_RUN_DEADLINE_MS", 60_000);
const REPEATS = Math.max(1, Math.round(knob("PHW_REPEATS", 3)));
const EVENTS_CONTROL = Math.round(knob("PHW_EVENTS_CONTROL", 0));
const EVENTS_LARGE = Math.round(knob("PHW_EVENTS_LARGE", 3_000));
const EVENTS_XLARGE = Math.round(knob("PHW_EVENTS_XLARGE", 80_000));
const EVENTS_FAULT = Math.round(knob("PHW_EVENTS_FAULT", 3_000));
const EVENTS_BLOCK = Math.round(knob("PHW_EVENTS_BLOCK", 400_000));
const CONFIG_NAMES = (process.env.PHW_CONFIGS ?? "control,large,xlarge,block,fault")
	.split(",")
	.map((name) => name.trim())
	.filter(Boolean);

const CONFIGS = {
	control: { label: "control", events: EVENTS_CONTROL, fault: false },
	large: { label: "large", events: EVENTS_LARGE, fault: false },
	xlarge: { label: "xlarge", events: EVENTS_XLARGE, fault: false },
	block: { label: "block", events: EVENTS_BLOCK, fault: false },
	fault: { label: "fault", events: EVENTS_FAULT, fault: true },
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const atMs = () => Math.round(performance.now());

/** The production observer probe's per-request timeout, read from src/orchestra.ts at run time. */
function productionProbeTimeout() {
	const text = readFileSync(join(ROOT, "src/orchestra.ts"), "utf8");
	const match = /AbortSignal\.timeout\(\s*([\d_]+)\s*\)/.exec(text);
	if (!match) throw new Error("could not find the production probe timeout in src/orchestra.ts");
	const line = text.slice(0, match.index).split("\n").length;
	return { timeoutMs: Number(match[1].replace(/_/g, "")), file: "src/orchestra.ts", line };
}

async function freePort() {
	return await new Promise((done, fail) => {
		const probe = createNetServer();
		probe.on("error", fail);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			probe.close(() => done(typeof address === "object" && address ? address.port : 0));
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

function failureMode(error) {
	const name = error?.name ?? "";
	const text = String(error?.message ?? "");
	if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(text)) return "timeout";
	const code = errorCode(error);
	if (code === "ECONNREFUSED") return "connection refused";
	if (code === "ECONNRESET") return "connection reset";
	if (code === "ECONNABORTED") return "connection aborted";
	if (code) return `connection error (${code})`;
	return `fetch error (${name || text || "unknown"})`;
}

// ── Seed mode: plant a deterministic pi-durable transcript into $DATA_DIR/agent.sqlite, then exit. ──
async function seedChild() {
	const dataDir = process.env.DATA_DIR;
	if (!dataDir) throw new Error("--seed needs DATA_DIR");
	const count = Number(process.env.SEED_EVENTS ?? "0");
	const { seedCanvasTranscript } = await import(join(ROOT, "scripts/health-harness.ts"));
	await seedCanvasTranscript(dataDir, count);
	process.stdout.write(`seeded ${count} canvas events into ${join(dataDir, "agent.sqlite")}\n`);
}

// ── Child mode: the real boot path (Agent.open() + startHttp), instrumented with markers. ──────────
async function childMode() {
	if (!process.env.DATA_DIR || !process.env.PORT) throw new Error("--child needs DATA_DIR and PORT");
	process.env.AUTH_TOKEN ||= "probe-health-window";
	process.env.OPENROUTER_API_KEY ||= "unused";

	// Negative-control switch: restore the pre-#20 ordering, where the whole reconcile is awaited
	// inside Agent.open() before the listener starts (the test-only AgentOptions.reconcileBeforeListen
	// hook in src/agent.ts, default off). The work is the genuine reconcile — nothing is injected.
	const reconcileBeforeListen = process.env.PHW_RECONCILE_BEFORE_LISTEN === "1";
	if (reconcileBeforeListen) {
		console.log("PHW child: NEGATIVE CONTROL pre-fix ordering forced (PHW_RECONCILE_BEFORE_LISTEN=1): the real reconcile is awaited inside Agent.open(), before listen");
	}

	if (process.env.FORCE_RECONCILE_ERROR === "1") {
		const after = Math.max(0, Math.round(Number(process.env.FORCE_RECONCILE_ERROR_AFTER ?? "3")));
		const { Journal } = await import(join(ROOT, "src/elr/journal.ts"));
		const original = Journal.prototype.reconcile;
		let calls = 0;
		Journal.prototype.reconcile = function (...args) {
			calls++;
			if (calls > after) throw new Error(`FORCE_RECONCILE_ERROR: injected reconcile failure after ${calls - 1} chunk call(s)`);
			return original.apply(this, args);
		};
		console.log(`[phw-child] reconcile fault injection active: throws after ${after} chunk call(s)`);
	}

	const { Agent } = await import(join(ROOT, "src/agent.ts"));
	const { startHttp } = await import(join(ROOT, "src/http.ts"));

	const agent = await Agent.open(reconcileBeforeListen ? { reconcileBeforeListen: true } : {});
	console.log(`PHW child: opened atMs=${atMs()}${reconcileBeforeListen ? " reconcileBeforeListen=1" : ""}`);

	const originalStartReconcile = agent.startReconcile.bind(agent);
	agent.startReconcile = () => {
		console.log(`PHW child: reconcileStarted atMs=${atMs()}`);
		return originalStartReconcile();
	};

	const server = startHttp(agent);
	await new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("listening", onListening);
		server.once("error", onError);
	});
	console.log(`PHW child: listening atMs=${atMs()}`);

	const outcome = await agent.reconcileDone;
	console.log(
		`PHW child: reconcileDone atMs=${atMs()} ok=${outcome.ok} inserted=${outcome.inserted} conversations=${outcome.conversations}${outcome.error ? ` error=${outcome.error}` : ""}`,
	);
	console.log("PHW child: staying up until the harness stops us");
	await new Promise(() => {}); // SIGTERM from the parent ends the run
}

/** Spawn `node scripts/probe-health-window.mjs --seed` and wait for it to plant SEED_EVENTS events. */
async function seedTranscript(dataDir, events) {
	await new Promise((done, fail) => {
		const child = spawn(process.execPath, [SCRIPT, "--seed"], {
			cwd: ROOT,
			env: { ...process.env, DATA_DIR: dataDir, SEED_EVENTS: String(events) },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.once("error", fail);
		child.once("exit", (code) => (code === 0 ? done() : fail(new Error(`seeder exited ${code}`))));
	});
}

/** Elapsed ms from t0 at the first successful TCP connect (the listener accepting connections). */
async function waitUntilListening(port, t0, deadlineMs, shouldStop) {
	for (;;) {
		if (shouldStop() || performance.now() - t0 > deadlineMs) return null;
		const connected = await new Promise((resolve) => {
			const socket = netConnect({ port, host: "127.0.0.1" });
			const done = (result) => {
				socket.destroy();
				resolve(result);
			};
			socket.once("connect", () => done(true));
			socket.once("error", () => done(false));
		});
		if (connected) return Math.round(performance.now() - t0);
		await sleep(25);
	}
}

function minMax(runs, key) {
	const values = runs.map((run) => run[key]).filter((value) => typeof value === "number");
	if (!values.length) return "n/a";
	return `${Math.min(...values)}-${Math.max(...values)}`;
}

/** One full measurement: seed a throwaway DATA_DIR, boot the real path in a child, probe /health. */
async function runOnce(config, repeat, probeTimeoutMs) {
	const dataDir = await mkdtemp(join(tmpdir(), `probe-health-window-${config.label}-`));
	const seedStartedAt = performance.now();
	try {
		await seedTranscript(dataDir, config.events);
		const seedMs = Math.round(performance.now() - seedStartedAt);
		const port = await freePort();
		const url = `http://127.0.0.1:${port}/health`;

		const childEnv = {
			...process.env,
			NODE_ENV: "production",
			OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "unused",
			AUTH_TOKEN: "",
			TELEGRAM_BOT_TOKEN: "",
			TELEGRAM_OWNER_ID: "",
			DATA_DIR: dataDir,
			PORT: String(port),
		};
		if (config.fault) childEnv.FORCE_RECONCILE_ERROR = process.env.FORCE_RECONCILE_ERROR ?? "1";
		else delete childEnv.FORCE_RECONCILE_ERROR;
		if (config.label === "block") childEnv.PHW_RECONCILE_BEFORE_LISTEN = process.env.PHW_RECONCILE_BEFORE_LISTEN ?? "1";
		else delete childEnv.PHW_RECONCILE_BEFORE_LISTEN;

		console.log(
			`PHW run: config=${config.label} repeat=${repeat} events=${config.events} port=${port} seedMs=${seedMs}${config.fault ? " FORCE_RECONCILE_ERROR=1" : ""}`,
		);

		const t0 = performance.now();
		const child = spawn(process.execPath, [SCRIPT, "--child"], { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
		const markers = {};
		const outLines = [];
		const errLines = [];
		let stdoutBuffer = "";
		let reconcileDoneArrival; // parent-clock ms at which the reconcileDone marker arrived
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk;
			let newline;
			while ((newline = stdoutBuffer.indexOf("\n")) !== -1) {
				const line = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (!line) continue;
				outLines.push(line);
				const marker = /^PHW child: (\w+) atMs=(\d+)(.*)$/.exec(line);
				if (marker) {
					markers[marker[1]] = { atMs: Number(marker[2]), rest: marker[3] ?? "" };
					if (marker[1] === "reconcileDone") reconcileDoneArrival = performance.now() - t0;
				}
				if (/^(PHW child:|\[elr\]|\[http\]|\[phw-child\])/.test(line)) console.log(`PHW child-out: ${line}`);
			}
			if (outLines.length > 200) outLines.splice(0, outLines.length - 200);
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			for (const line of chunk.split("\n")) if (line.trim()) errLines.push(line);
			if (errLines.length > 200) errLines.splice(0, errLines.length - 200);
		});

		let exit = null;
		let weStoppedIt = false;
		child.once("exit", (code, signal) => void (exit = { code, signal }));

		// Health probes: fire-and-forget on a fixed PHW_POLL_MS cadence, each with the production
		// per-request timeout, so a hanging request never thins the sampling during starvation.
		const polls = [];
		let probing = true;
		const probe = async () => {
			const entry = { startAt: performance.now() - t0, endAt: undefined, ok: false, status: 0, mode: "" };
			polls.push(entry);
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "manual" });
				entry.endAt = performance.now() - t0;
				entry.status = response.status;
				entry.ok = response.status === 200;
				entry.mode = entry.ok ? "ok" : `non-200 HTTP ${response.status}`;
				await response.arrayBuffer().catch(() => {});
			} catch (error) {
				entry.endAt = performance.now() - t0;
				entry.mode = failureMode(error);
			}
		};
		const pollLoop = (async () => {
			while (probing) {
				void probe();
				await sleep(POLL_MS);
			}
		})();

		const firstListenMs = await waitUntilListening(port, t0, RUN_DEADLINE_MS, () => exit !== null);

		// Stop condition: reconcileDone marker plus a bounded quiet period of continued probing
		// (PHW_QUIET_MS), or the child died, or the per-run deadline passed. All elapsed ms from t0.
		let quietDeadlineAt = Number.POSITIVE_INFINITY;
		for (;;) {
			const elapsed = performance.now() - t0;
			if (markers.reconcileDone !== undefined && quietDeadlineAt === Number.POSITIVE_INFINITY) {
				quietDeadlineAt = (reconcileDoneArrival ?? elapsed) + QUIET_MS;
			}
			if (exit !== null) {
				await sleep(300); // capture trailing failures, then stop: the child is gone
				break;
			}
			if (elapsed >= quietDeadlineAt || elapsed >= RUN_DEADLINE_MS) break;
			await sleep(20);
		}
		probing = false;
		await pollLoop;

		const crashedDuringRun = exit !== null && !weStoppedIt;
		if (exit === null) {
			weStoppedIt = true;
			const exited = new Promise((done) => child.once("exit", done));
			child.kill("SIGTERM");
			await Promise.race([exited, sleep(4_000)]);
			if (child.exitCode === null && child.signalCode === null) {
				child.kill("SIGKILL");
				await Promise.race([exited, sleep(2_000)]);
			}
			exit = { code: child.exitCode, signal: child.signalCode };
		}

		const successes = polls
			.filter((p) => p.ok && typeof p.endAt === "number")
			.map((p) => p.endAt)
			.sort((a, b) => a - b);
		const first200Ms = successes.length ? Math.round(successes[0]) : null;
		let worstGapMs = 0;
		for (let i = 1; i < successes.length; i++) worstGapMs = Math.max(worstGapMs, successes[i] - successes[i - 1]);
		const failures = polls.filter((p) => !p.ok);
		const failureModes = {};
		for (const failure of failures) failureModes[failure.mode] = (failureModes[failure.mode] ?? 0) + 1;

		const reconcileStarted = markers.reconcileStarted?.atMs;
		const reconcileDone = markers.reconcileDone?.atMs;
		const reconcileWallMs =
			reconcileStarted !== undefined && reconcileDone !== undefined ? reconcileDone - reconcileStarted : null;
		const reconcileOk = markers.reconcileDone !== undefined ? /(^|\s)ok=true/.test(markers.reconcileDone.rest) : null;
		const reconcileInserted = markers.reconcileDone?.rest.match(/inserted=(\d+)/)?.[1] ?? null;
		// In block (pre-fix ordering) mode the reconcile completes inside Agent.open(), so the boot
		// path's own "[elr] journal reconciled" line is where the real row count is reported.
		const bootReconcileInserted =
			Number(outLines.map((line) => /\[elr\] journal reconciled: conversations=\d+ eventsReconciled=(\d+)/.exec(line)?.[1]).find(Boolean) ?? NaN) || null;

		const unhandledRejection = [...outLines, ...errLines].some((line) =>
			/ERR_UNHANDLED|UnhandledPromiseRejection|unhandled ?rejection/i.test(line),
		);
		const uncaughtException = [...outLines, ...errLines].some((line) => /uncaughtException/i.test(line));

		const postDone = reconcileDoneArrival !== undefined ? polls.filter((p) => p.endAt !== undefined && p.endAt >= reconcileDoneArrival) : [];
		const healthAnsweredAfterReconcile = postDone.some((p) => p.ok);

		const label = `config=${config.label} repeat=${repeat}`;
		console.log(`PHW line: ${label} firstListenMs=${firstListenMs ?? "none"}`);
		console.log(`PHW line: ${label} first200Ms=${first200Ms ?? "none"}`);
		console.log(
			`PHW line: ${label} worstGapMs=${successes.length >= 2 ? Math.round(worstGapMs) : "n/a"} successes=${successes.length}` +
				` failedPolls=${failures.length} failureModes=${JSON.stringify(failureModes)} pollMs=${POLL_MS} probeTimeoutMs=${probeTimeoutMs}`,
		);
		console.log(
			`PHW line: ${label} reconcileStartMs=${reconcileStarted ?? "none"} reconcileDoneMs=${reconcileDone ?? "none"}` +
				` reconcileWallMs=${reconcileWallMs ?? "n/a"} reconcileOk=${reconcileOk ?? "n/a"} inserted=${reconcileInserted ?? "n/a"}` +
				` bootReconcileInserted=${bootReconcileInserted ?? "n/a"}`,
		);
		console.log(
			`PHW line: ${label} childExitCode=${exit.code} childSignal=${exit.signal} crashedDuringRun=${crashedDuringRun}` +
				` unhandledRejection=${unhandledRejection} uncaughtException=${uncaughtException}`,
		);
		console.log(
			`PHW line: ${label} healthAfterReconcileDone=${reconcileDoneArrival !== undefined ? (healthAnsweredAfterReconcile ? "200" : "no") : "n/a"}` +
				` successesAfterReconcileDone=${postDone.filter((p) => p.ok).length}`,
		);
		if (crashedDuringRun || unhandledRejection || uncaughtException) {
			console.error(`PHW crash evidence: ${label} stdout tail: ${JSON.stringify(outLines.slice(-10))}`);
			console.error(`PHW crash evidence: ${label} stderr tail: ${JSON.stringify(errLines.slice(-10))}`);
		}

		const complete =
			firstListenMs !== null &&
			first200Ms !== null &&
			markers.reconcileDone !== undefined &&
			!crashedDuringRun &&
			!unhandledRejection &&
			!uncaughtException;

		return {
			config,
			repeat,
			firstListenMs,
			first200Ms,
			worstGapMs: successes.length >= 2 ? Math.round(worstGapMs) : null,
			successes: successes.length,
			failedPolls: failures.length,
			failureModes,
			reconcileStartMs: reconcileStarted ?? null,
			reconcileDoneMs: reconcileDone ?? null,
			reconcileWallMs,
			reconcile: { ok: reconcileOk, inserted: reconcileInserted === null ? null : Number(reconcileInserted) },
			bootReconcileInserted: bootReconcileInserted === null ? null : Number(bootReconcileInserted),
			childExitCode: exit.code,
			childSignal: exit.signal,
			crashedDuringRun,
			unhandledRejection,
			uncaughtException,
			healthAnsweredAfterReconcile,
			complete,
		};
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
}

async function main() {
	if (SEED) return seedChild();
	if (CHILD) return childMode();

	const citation = productionProbeTimeout();
	for (const name of CONFIG_NAMES) if (!CONFIGS[name]) throw new Error(`unknown config "${name}" (know: ${Object.keys(CONFIGS).join(", ")})`);
	const configs = CONFIG_NAMES.map((name) => CONFIGS[name]);

	console.log("=== /health availability window through boot + deferred reconcile (ELR M2 warning repro) ===");
	console.log(
		`PHW config: pollMs=${POLL_MS} probeTimeoutMs=${citation.timeoutMs} (production observer probe timeout, read from ${citation.file}:${citation.line}; a rejected fetch there renders as "GET /health no answer") quietMs=${QUIET_MS} runDeadlineMs=${RUN_DEADLINE_MS} repeats=${REPEATS}`,
	);
	console.log(`PHW configs: ${configs.map((c) => `${c.label}(events=${c.events}${c.fault ? ", FORCE_RECONCILE_ERROR=1" : ""}${c.label === "block" ? ", PHW_RECONCILE_BEFORE_LISTEN=1 (pre-#20 ordering)" : ""})`).join(" ")}`);
	console.log(
		"PHW completion signal: the child prints a marker when the real agent.reconcileDone resolves; probing continues a bounded quietMs past it. Gap resolution ~pollMs.",
	);

	const runs = [];
	for (const config of configs) {
		for (let repeat = 1; repeat <= REPEATS; repeat++) {
			runs.push(await runOnce(config, repeat, citation.timeoutMs));
			if (repeat < REPEATS) await sleep(200);
		}
		const mine = runs.filter((run) => run.config === config);
		console.log(
			`PHW summary: config=${config.label} events=${config.events} repeats=${mine.length}` +
				` firstListenMs(min-max)=${minMax(mine, "firstListenMs")} first200Ms(min-max)=${minMax(mine, "first200Ms")}` +
				` worstGapMs(min-max)=${minMax(mine, "worstGapMs")} reconcileWallMs(min-max)=${minMax(mine, "reconcileWallMs")}`,
		);
		console.log(
			`PHW verdict: config=${config.label} worstGapMs=${Math.max(...mine.map((run) => run.worstGapMs ?? 0))}` +
				` first200Ms=${Math.max(...mine.map((run) => run.first200Ms ?? Number.POSITIVE_INFINITY))}` +
				` productionProbeTimeoutMs=${citation.timeoutMs}` +
				` worstGapExceedsProbeTimeout=${mine.some((run) => (run.worstGapMs ?? 0) > citation.timeoutMs)}` +
				` first200ExceedsProbeTimeout=${mine.some((run) => (run.first200Ms ?? Number.POSITIVE_INFINITY) > citation.timeoutMs)}`,
		);
		console.log(
			`PHW reconcount: config=${config.label} events=${config.events}` +
				` bootReconcileInserted(min-max)=${minMax(mine, "bootReconcileInserted")}`,
		);
	}

	console.log("PHW compare: (per configuration, min/max over repeats; control is the no-reconcile baseline)");
	for (const config of configs) {
		const mine = runs.filter((run) => run.config === config);
		console.log(
			`PHW compare: config=${config.label} events=${config.events}${config.fault ? " faultInjected=true" : ""}` +
				` first200Ms(min-max)=${minMax(mine, "first200Ms")}` +
				` worstGapMs(min-max)=${minMax(mine, "worstGapMs")}` +
				` reconcileWallMs(min-max)=${minMax(mine, "reconcileWallMs")}` +
				` crashes=${mine.filter((run) => run.crashedDuringRun).length}`,
		);
	}

	const faultRuns = runs.filter((run) => run.config.fault);
	if (faultRuns.length) {
		const failed = faultRuns.every((run) => run.reconcile.ok === false);
		const survived = faultRuns.every((run) => !run.crashedDuringRun);
		console.log(
			`PHW fault: events=${EVENTS_FAULT} runs=${faultRuns.length} injectedFailureObserved=${failed}` +
				` processSurvived=${survived} unhandledRejection=${faultRuns.some((run) => run.unhandledRejection)}` +
				` uncaughtException=${faultRuns.some((run) => run.uncaughtException)}` +
				` healthAnsweredAfterFailure=${faultRuns.every((run) => run.healthAnsweredAfterReconcile)}`,
		);
	}

	const complete = runs.every((run) => run.complete);
	const faultHealthy = faultRuns.every((run) => run.reconcile.ok === false && !run.crashedDuringRun && run.healthAnsweredAfterReconcile);
	console.log(`PHW result: allMeasurementsProduced=${complete} faultRunsHealthy=${faultRuns.length ? faultHealthy : "n/a"}`);
	process.exitCode = complete && (!faultRuns.length || faultHealthy) ? 0 : 1;
}

main().catch((error) => {
	console.error(`probe-health-window: ${error?.stack ?? error?.message ?? String(error)}`);
	process.exitCode = 1;
});

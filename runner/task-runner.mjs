// Runs ONE coding-task attempt inside a throwaway container in the agent-sandboxes Railway project, then exits; the
// orchestrator deletes the container afterwards. Plain JavaScript on purpose: the orchestrator ships this file to the
// runner image as an environment variable. Stock node images remain supported as a fallback.
//
// The container never writes to GitHub: its GitHub token is read-only for one repo, used only to clone. The commits go
// back to the agent as a git bundle inside the evidence, and the agent (outside the sandbox) pushes them to the goal's
// agent/... branch. So a compromised container can at most read the repository it is working on.
//
// Secret handling: every secret is read once and removed from the environment before anything else starts. Each step
// gets only what it needs. The GitHub token is used for the clone and is never in git config or any child's env;
// the model key is only given to OpenCode; the project's own verify command runs with no secrets at all.
//
// Removing a variable from process.env does not erase it from /proc/<pid>/environ, which any process of the same user
// can read. So the runner (root) never shares a user with untrusted code: OpenCode and the verify command run as the
// unprivileged "node" user (uid 1000), which cannot read root's environment, and every uid-1000 process is killed
// before the token is used again for the push.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

/**
 * The container's log pipe (this process's stdout, and any child's stdin) can close while the attempt is still running
 * — the platform is shutting the container down or a log collector goes away — and the next write raises EPIPE on
 * that stream. With no 'error' listener Node promotes it to an uncaught exception and the runner dies mid-attempt,
 * dropping the whole attempt for reasons that had nothing to do with the code it was writing (observed: goal-d74b9d's
 * sweep task died twice, right after logging "using preinstalled opencode"). This guard block is the only copy in
 * the tree; the committed proofs import it straight from this file, which has no side effects on import (the
 * direct-execution guard `isMain` below keeps startup — env parsing, main(), exit — out of imports).
 * runner/test/pipe-survival.mjs, dead-pipe-log.mjs, log-format.mjs and stdin-epipe.test.mjs prove the behaviour.
 *
 * The same failure reaches the children too: a child's own stdout/stderr pipe (read by run() and runOpencode()) can
 * close or reset while the runner is reading it — a collector going away — and raises the same asynchronous 'error'
 * on that stream, so both spawn paths wrap their capture in `guardedCapture`, which drops only that closed-pipe
 * class (isDeadPipe) and rethrows everything else: the capture is the attempt's evidence, so unlike our own log
 * streams, only a closed pipe is tolerable there. The guard's long arm is proven by
 * runner/test/child-stdio-epipe.test.mjs.
 */
// ── guard:log-pipe ─── begin
const started = Date.now();
const dead = () => {};

/** The runner's OWN log streams: every error is dropped, full stop. A dead log pipe must never become an uncaught
 * exception, and log lines are not evidence — nothing is lost by staying silent. Never attach this to a child's
 * captured streams; use guardedCapture for those. */
function guarded(stream) {
	if (stream && stream.listenerCount("error") === 0) stream.on("error", dead);
	return stream;
}

/** Both standard streams, attached before anything else logs or writes. */
function guardStdStreams() {
	guarded(process.stdout);
	guarded(process.stderr);
}

/**
 * The log helper, byte-compatible with the console.log call it replaced while the pipe is alive; silent when it
 * cannot write: never throws, drops the line, and invents no retries or fallbacks — nobody is listening at the other
 * end of a dead pipe anyway.
 */
function log(...parts) {
	guardStdStreams();
	const line = `[runner +${((Date.now() - started) / 1000).toFixed(0)}s] ${parts.join(" ")}`;
	try {
		if (process.stdout.writable && !process.stdout.destroyed) process.stdout.write(`${line}\n`);
	} catch {
		// the log pipe is dead; silently drop the line
	}
}
/**
 * The errors a gone reader raises — the only class these guards drop. Anything else is a real defect: it must surface
 * the way it did before the guards, not vanish into a no-op.
 */
const DEAD_PIPE_CODES = new Set(["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

function isDeadPipe(error) {
	return DEAD_PIPE_CODES.has(error?.code);
}

/**
 * The child's captured stdout/stderr (run() and runOpencode()): evidence, not log — so unlike `guarded` above, only
 * the closed-pipe class is dropped (the isDeadPipe predicate shared with feedStdin; no second definition of the
 * codes). Any other stream error is a real defect and is rethrown from the listener, so it stays uncaught and fails
 * the attempt exactly as before the guards — silently swallowing it would truncate what run() reports while the
 * child's exit code still says the capture is complete.
 */
function guardedCapture(stream) {
	if (stream && stream.listenerCount("error") === 0)
		stream.on("error", (error) => {
			if (!isDeadPipe(error)) throw error; // not the closed-pipe class: surface it, as before the guards
		});
	return stream;
}

/**
 * Writes `input` into a child's stdin and closes it — the write path of run(). The child may already be gone (it can
 * exit between the spawn and this write, or while the write is still in flight), or its stdin's reader may have hung
 * up; then the write raises EPIPE or ERR_STREAM_DESTROYED, as an asynchronous 'error' event or a synchronous throw,
 * and unguarded either becomes an uncaught exception that kills the runner mid-attempt. Errors of that closed-pipe
 * class are dropped silently — there is nothing useful to do about a child that is gone; anything else is rethrown.
 * While the child is alive this is exactly the `stdin.end(input)` it replaced: same input written, same end.
 */
function feedStdin(stdin, input) {
	if (stdin && stdin.listenerCount("error") === 0)
		stdin.on("error", (error) => {
			if (!isDeadPipe(error)) throw error; // not the closed-pipe class: surface it, as before the guard
		});
	try {
		if (stdin?.writable && !stdin?.destroyed) stdin.end(input ?? "");
	} catch (error) {
		if (!isDeadPipe(error)) throw error; // the synchronous variant of the same narrowness
	}
	return stdin;
}
// ── guard:log-pipe ─── end
guardStdStreams(); // before anything else logs or writes, so a closed log pipe can never become an uncaught exception
/** Bounded, numeric-only diagnostics. cgroup v2 counters include child processes and filesystem cache.
 * Peaks are sampled every five seconds and at phase boundaries, not billing-grade measurements.
 * Missing cgroup files (e.g. local macOS) leave container metrics unavailable; never substitute host RAM. */
export function createResourceMonitor({ read = readFile, now = () => performance.now(), rss = () => process.memoryUsage().rss, intervalMs = 5_000 } = {}) {
	const origin = now();
	const phases = [];
	let phase;
	let previousCpu;
	let chain = Promise.resolve();
	let pending = 0;
	let stopped = false;
	let finished;
	const data = { version: 1, intervalMs, elapsedMs: 0, runnerRssBytes: 0, peakRunnerRssBytes: 0, outputBytes: 0, phases };
	const numberFile = async (path) => {
		try { const value = Number((await read(path, "utf8")).trim()); return Number.isFinite(value) && value >= 0 ? value : undefined; } catch { return undefined; }
	};
	const sample = async () => {
		const memory = await numberFile("/sys/fs/cgroup/memory.current");
		let cpu;
		try { const match = /(?:^|\n)usage_usec (\d+)/.exec(await read("/sys/fs/cgroup/cpu.stat", "utf8")); if (match) cpu = Number(match[1]) / 1_000; } catch { /* cgroup unavailable */ }
		const at = Math.max(0, now() - origin);
		data.elapsedMs = at;
		data.runnerRssBytes = rss();
		data.peakRunnerRssBytes = Math.max(data.peakRunnerRssBytes, data.runnerRssBytes);
		if (memory !== undefined) {
			data.containerMemoryBytes = memory;
			data.peakContainerMemoryBytes = Math.max(data.peakContainerMemoryBytes ?? 0, memory);
		}
		if (cpu !== undefined) {
			if (previousCpu !== undefined && phase) phase.cpuMs = (phase.cpuMs ?? 0) + Math.max(0, cpu - previousCpu);
			previousCpu = cpu;
			data.cpuMs = phases.reduce((sum, p) => sum + (p.cpuMs ?? 0), 0);
		}
		if (phase) {
			phase.durationMs = Math.max(0, at - phase.startedMs);
			phase.samples++;
			phase.peakRunnerRssBytes = Math.max(phase.peakRunnerRssBytes, data.runnerRssBytes);
			if (memory !== undefined) phase.peakContainerMemoryBytes = Math.max(phase.peakContainerMemoryBytes ?? 0, memory);
		}
	};
	const enqueue = (fn) => { pending++; chain = chain.then(fn).catch(() => {}).finally(() => pending--); return chain; }; // diagnostics must never fail a task
	const timer = setInterval(() => { if (!stopped && pending === 0) void enqueue(sample); }, intervalMs);
	timer.unref();
	return {
		async phase(name) {
			await enqueue(async () => {
				await sample();
				if (phases.length >= 8 || stopped) return;
				phase = { name, startedMs: data.elapsedMs, durationMs: 0, samples: 0, peakRunnerRssBytes: data.runnerRssBytes, outputBytes: 0 };
				if (data.containerMemoryBytes !== undefined) phase.peakContainerMemoryBytes = data.containerMemoryBytes;
				phases.push(phase);
				data.phase = name;
			});
		},
		output(bytes) { data.outputBytes += bytes; if (phase) phase.outputBytes += bytes; },
		bundle(bytes) { data.bundleBytes = bytes; },
		snapshot() { return JSON.parse(JSON.stringify(data)); },
		finish() {
			if (!finished) { stopped = true; clearInterval(timer); finished = enqueue(sample).then(() => this.snapshot()); }
			return finished;
		},
	};
}

/** Bounded diagnostic tails; raw output bytes are still counted by the resource monitor. */
export const captureTail = (before, chunk, limit = 256 * 1024) => (before + chunk).slice(-limit);

/** Parse OpenCode events incrementally. Oversized lines are discarded, never parsed as truncated JSON. */
export function createOpencodeParser(limit = 1024 * 1024) {
	let pending = "", dropping = false, sessionId, cost = 0, text = "", failure;
	const take = (line) => {
		try {
			const event = JSON.parse(line);
			sessionId ??= event.sessionID;
			if (event.type === "text") text = captureTail(text, `${event.part?.text ?? ""}\n`, limit);
			if (event.type === "step_finish" && Number.isFinite(event.part?.cost) && event.part.cost >= 0) cost += event.part.cost;
			if (event.type === "error") failure = JSON.stringify(event.error ?? event).slice(0, 800);
		} catch { /* non-event output */ }
	};
	return {
		push(chunk) {
			for (const part of String(chunk).split(/(?<=\n)/)) {
				const ended = part.endsWith("\n");
				if (!dropping && pending.length + part.length <= limit) pending += part;
				else { dropping = true; pending = ""; }
				if (ended) { if (!dropping) take(pending); pending = ""; dropping = false; }
			}
		},
		finish() { if (pending && !dropping) take(pending); pending = ""; return { sessionId, cost, text, failure }; },
	};
}

/** Reserve the final quarter (up to five minutes) for verification and evidence. */
export function attemptBudgets(started, minutes, now = Date.now()) {
	const total = minutes * 60_000;
	const deadline = started + total;
	return { deadline, codingMs: Math.max(0, deadline - Math.min(5 * 60_000, total / 4) - now) };
}

/**
 * At most max(8, criteria) proofs are re-run. The first proof for each criterion index is kept before any extra
 * ones, so the cap never drops the only proof of a criterion. A proof without a valid index is kept as an extra
 * (it is still re-run and shown) but covers no criterion at the gate.
 */
export function keepProofs(raw, criteria) {
	const limit = Math.max(8, criteria);
	const proofs = raw
		.map((p) => {
			const index = Number(p?.criterionIndex);
			return {
				...(Number.isInteger(index) && index >= 0 && (criteria === 0 || index < criteria) ? { criterionIndex: index } : {}),
				criterion: String(p?.criterion ?? ""),
				command: String(p?.command ?? ""),
				expect: String(p?.expect ?? ""),
			};
		})
		.filter((p) => p.command);
	const seen = new Set();
	const firsts = [];
	const extras = [];
	for (const p of proofs) {
		if (p.criterionIndex !== undefined && !seen.has(p.criterionIndex)) {
			seen.add(p.criterionIndex);
			firsts.push(p);
		} else extras.push(p);
	}
	const kept = new Set([...firsts, ...extras].slice(0, limit));
	return proofs.filter((p) => kept.has(p)); // the coder's order
}

/**
 * OpenCode → this local relay → the agent's model proxy: the same requests, gzipped. A chat request resends the whole
 * conversation every turn, so this is most of what an attempt sends, all of it billed as egress; JSON shrinks about
 * tenfold. Answers stream back unchanged. Only the coder's own requests reach it (127.0.0.1, no credentials added).
 */
async function startLlmRelay(target) {
	const base = target.replace(/\/$/, "");
	const server = createServer(async (request, response) => {
		const abort = new AbortController();
		response.on("close", () => { if (!response.writableEnded) abort.abort(); });
		try {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const headers = { "content-type": request.headers["content-type"] ?? "application/json" };
			for (const name of ["authorization", "accept"]) if (request.headers[name]) headers[name] = request.headers[name];
			const hasBody = request.method !== "GET" && request.method !== "HEAD";
			if (hasBody) headers["content-encoding"] = "gzip";
			const answer = await fetch(base + request.url, { method: request.method, headers, body: hasBody ? gzipSync(Buffer.concat(chunks)) : undefined, signal: abort.signal });
			response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json", "cache-control": "no-cache" });
			if (answer.body) for await (const chunk of answer.body) if (!response.write(chunk)) await once(response, "drain");
			response.end();
		} catch (error) {
			if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
			response.end(response.headersSent ? undefined : JSON.stringify({ error: { message: `relay: ${error instanceof Error ? error.message : error}` } }));
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	server.unref();
	return `http://127.0.0.1:${server.address().port}`;
}

/** True only for the direct execution by the container (`node /tmp/task-runner.mjs` after the RUNNER_JS decode), which
 * matches the real invocation shape (sh -c '… exec node /tmp/task-runner.mjs') — so these module-load startup steps
 * (env parse, main(), exit) run only there, and importing this file from the tests has no side effects. */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
const take = (name) => {
	const value = process.env[name];
	delete process.env[name];
	return value ?? "";
};
const spec = JSON.parse(Buffer.from(take("TASK_SPEC"), "base64").toString("utf8"));
const githubToken = take("GH_TOKEN");
const modelKey = take("OPENROUTER_API_KEY");
/** OpenCode Go: no provider key here, only this attempt's token for the agent's model proxy (spec.llm). */
const llmToken = take("LLM_TOKEN");
const taskToken = take("TASK_TOKEN");
take("RUNNER_JS");

const WORK = "/work";
const CODER = { uid: 1000, gid: 1000, home: "/home/node" };
/** The environment any child gets: no secrets, ever, unless a step adds one explicitly. */
const baseEnv = { PATH: process.env.PATH, HOME: "/root", LANG: "C.UTF-8", CI: "1", npm_config_update_notifier: "false" };
const coderEnv = { ...baseEnv, HOME: CODER.home };
const resources = createResourceMonitor();
const { deadline } = attemptBudgets(started, spec.attemptMinutes);
const remaining = (maximum) => Math.max(1, Math.min(maximum, deadline - Date.now()));
// This backstop also covers setup, proof subprocesses and unavailable callback endpoints.
const deadlineTimer = setTimeout(() => {
	try { process.kill(-opencode?.pid, "SIGKILL"); } catch {}
	try { spawn("pkill", ["-KILL", "-u", String(CODER.uid)], { stdio: "ignore" }); } catch {}
	process.exit(124);
}, Math.max(1, deadline - Date.now()));

/** Runs a program; `asCoder` drops to the unprivileged user that untrusted code runs as. */
function run(cmd, args, { cwd = WORK, env = baseEnv, timeoutMs = 10 * 60_000, input, asCoder = false, reserveMs = 0, captureLimit = 256 * 1024 } = {}) {
	return new Promise((resolve) => {
		const ids = asCoder ? { uid: CODER.uid, gid: CODER.gid } : {};
		const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true, ...ids });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		// A child's stdout/stderr pipe can close or reset mid-read (a collector going away): only that closed-pipe
		// class is dropped — any other stream error still surfaces, so the evidence is never silently truncated.
		guardedCapture(child.stdout).on("data", (d) => { resources.output(d.length); stdout = captureTail(stdout, d, captureLimit); });
		guardedCapture(child.stderr).on("data", (d) => { resources.output(d.length); stderr = captureTail(stderr, d, captureLimit); });
		feedStdin(child.stdin, input ?? ""); // the child may already be gone: a write to its stdin must not kill the runner
		const timer = setTimeout(() => {
			timedOut = true;
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		}, Math.max(1, remaining(timeoutMs) - reserveMs));
		child.on("error", (e) => (stderr += String(e)));
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, stdout, stderr, timedOut });
		});
	});
}

/** Never let a token reach a log line or the evidence. */
const scrub = (text) =>
	String(text)
		.replaceAll(githubToken || "\u0000", "***")
		.replaceAll(modelKey || "\u0000", "***")
		.replaceAll(llmToken || "\u0000", "***");

let repositoryOwnedByCoder = false;
async function git(...args) {
	// Repository-local config can execute programs. After coding begins, Git must run as the coder user.
	const result = await run("git", ["-c", `safe.directory=${WORK}`, "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...(repositoryOwnedByCoder ? [`--git-dir=${WORK}/.git`, `--work-tree=${WORK}`] : []), ...args], { asCoder: repositoryOwnedByCoder, env: repositoryOwnedByCoder ? coderEnv : baseEnv, captureLimit: args[0] === "diff" ? 60_000 : 256 * 1024 });
	if (result.code !== 0) throw new Error(`git ${args[0]}: ${scrub(result.stderr || result.stdout).trim()}`);
	return result.stdout.trim();
}

async function post(path, body) {
	for (let delay = 2_000; ; delay = Math.min(delay * 2, 30_000)) {
		try {
			const response = await fetch(new URL(path, spec.callbackUrl), {
				method: "POST",
				// Gzipped: everything this container sends is billed as egress (the agent accepts gzip on every runner route).
				headers: { "content-type": "application/json", "content-encoding": "gzip", authorization: `Bearer ${taskToken}` },
				body: gzipSync(JSON.stringify(body)),
				signal: AbortSignal.timeout(30_000),
			});
			if (response.ok) return response.json();
			if (response.status === 401 || response.status === 404) throw Object.assign(new Error(`rejected ${response.status}`), { fatal: true });
		} catch (error) {
			if (error.fatal) throw error;
		}
		log(`report to ${path} failed, retrying in ${delay / 1000}s`);
		await new Promise((r) => setTimeout(r, delay));
	}
}

// gitBase is https://github.com in production; tests point it at a local git server.
const gitBase = new URL(spec.gitBase ?? "https://github.com");
const plain = `${gitBase.origin}/${spec.repo}.git`;
const authed = gitBase.protocol === "https:" && githubToken ? `https://x-access-token:${githubToken}@${gitBase.host}/${spec.repo}.git` : plain;

let opencode;
let cancelled = false;
const heartbeat = setInterval(async () => {
	try {
		const { cancel } = await post("/api/runner/heartbeat", { taskId: spec.taskId, attempt: spec.attempt, resources: resources.snapshot() });
		if (cancel && !cancelled) {
			cancelled = true;
			log("cancelled by the orchestrator");
			opencode?.kill("SIGKILL");
			process.exit(0);
		}
	} catch {
		// the orchestrator decides; a failed heartbeat is not fatal here
	}
}, 30_000);

async function main() {
	if (spec.mode === "holdout") return holdoutMain();
	log(`task ${spec.taskId} attempt ${spec.attempt} on ${spec.repo}@${spec.branch}`);

	await resources.phase("toolchain");
	// 1. Reuse the image's pinned OpenCode; custom/stock images and version overrides still work.
	const installed = await run("opencode", ["--version"], { cwd: "/", timeoutMs: 30_000 });
	if (installed.code === 0 && installed.stdout.trim() === spec.opencodeVersion) {
		log(`using preinstalled opencode ${spec.opencodeVersion}`);
	} else {
		const install = await run("npm", ["install", "-g", "--no-audit", "--no-fund", `opencode-ai@${spec.opencodeVersion}`], { cwd: "/", timeoutMs: 5 * 60_000 });
		if (install.code !== 0) throw new Error(`installing opencode failed: ${install.stderr.slice(-800)}`);
		log("opencode installed");
	}

	await resources.phase("clone");
	// 2. Code: clone with the token, then make sure the token is nowhere on disk.
	await rm(WORK, { recursive: true, force: true });
	const branchExists = (await run("git", ["ls-remote", "--exit-code", "--heads", authed, spec.branch], { cwd: "/" })).code === 0;
	const clone = await run("git", ["clone", "--quiet", "--branch", branchExists ? spec.branch : spec.base, authed, WORK], { cwd: "/", timeoutMs: 5 * 60_000 });
	if (clone.code !== 0) throw new Error(`clone failed: ${scrub(clone.stderr)}`);
	await git("remote", "set-url", "origin", plain);
	if (!branchExists) await git("checkout", "-b", spec.branch);
	await rm(`${WORK}/.git/FETCH_HEAD`, { force: true });
	await git("config", "user.name", spec.gitName);
	await git("config", "user.email", spec.gitEmail);
	const baseSha = await git("rev-parse", "HEAD");
	const ownership = await run("chown", ["-R", `${CODER.uid}:${CODER.gid}`, WORK], { cwd: "/" });
	if (ownership.code !== 0) throw new Error("cannot isolate repository ownership");
	repositoryOwnedByCoder = true;
	log(`cloned at ${baseSha.slice(0, 7)}`);

	await resources.phase("coding");
	// 3. The coder: OpenCode with only the model key. The container is the sandbox, so it may run anything here;
	//    it cannot push (no token, and pushing is denied anyway).
	const reportInstruction = `End your final message with a fenced \`\`\`json block that matches this JSON Schema exactly:\n${JSON.stringify(spec.reportSchema)}`;
	const prompt = `${spec.prompt}\n\n${reportInstruction}`;
	const permission = { edit: "allow", webfetch: "allow", external_directory: "deny", bash: { "*": "allow", "git push*": "deny", "gh *": "deny" } };
	// The model: OpenRouter with this attempt's capped key, or the agent's proxy (an OpenAI-compatible provider).
	const provider = spec.llm
		? {
				agent: {
					npm: "@ai-sdk/openai-compatible",
					name: "agent",
					options: { baseURL: await startLlmRelay(spec.llm.baseURL), apiKey: llmToken },
					models: { [spec.llm.model]: { name: spec.llm.model, tool_call: true, reasoning: true, limit: { context: 262144, output: 32768 } } },
				},
			}
		: undefined;
	const opencodeEnv = {
		...coderEnv,
		...(modelKey ? { OPENROUTER_API_KEY: modelKey } : {}),
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission, ...(provider ? { provider } : {}) }),
	};
	// The attempt's budget, counted from container start, so a resume cannot run past it.
	/** One OpenCode run as the coder user. `opencode` points at it while it runs, so the heartbeat's cancel can kill it. */
	const runOpencode = (args, timeoutMs) =>
		new Promise((resolve) => {
			const child = spawn("opencode", args, { cwd: WORK, env: opencodeEnv, stdio: ["ignore", "pipe", "pipe"], detached: true, uid: CODER.uid, gid: CODER.gid });
			opencode = child;
			let stdout = "";
			let stderr = "";
			const parser = createOpencodeParser();
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			// Same narrow guard as in run(): only opencode's closed stdout/stderr pipes are dropped; anything else surfaces.
			guardedCapture(child.stdout).on("data", (d) => { resources.output(Buffer.byteLength(d)); parser.push(d); stdout = captureTail(stdout, d); });
			guardedCapture(child.stderr).on("data", (d) => { resources.output(Buffer.byteLength(d)); stderr = captureTail(stderr, d); });
			child.on("error", (error) => { stderr = captureTail(stderr, String(error)); });
			const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, remaining(timeoutMs));
			child.on("close", (code) => {
				clearTimeout(timer);
				opencode = undefined;
				const result = parser.finish();
				resolve({ code: code ?? 1, stdout, stderr, ...result, failure: result.failure ? scrub(result.failure) : undefined });
			});
		});
	const baseArgs = ["run", "--format", "json", "--dir", WORK, "-m", spec.llm ? `agent/${spec.llm.model}` : `openrouter/${spec.model}`];
	const coderArgs = [...baseArgs];
	if (spec.resumeSessionId) coderArgs.push("--session", spec.resumeSessionId);
	coderArgs.push(prompt);
	const first = await runOpencode(coderArgs, attemptBudgets(started, spec.attemptMinutes).codingMs);
	const { sessionId } = first;
	let { cost, text, failure } = first;
	let report = normalize(lastJsonBlock(text));
	// Described from the first run, before any resume, so the message says what actually happened there.
	const missingReport = report ? undefined : `opencode exited ${first.code} without a json report: ${scrub((first.stderr || text).slice(-1500))}`;
	log(`opencode finished (exit ${first.code}, $${cost.toFixed(3)})`);

	// OpenCode sometimes stops after the work is done but before its report. Resume the same session once, asking only
	// for the commit and the report, so the attempt is not thrown away. Bounded by what is left of the attempt.
	let reportRecovered = false;
	const remainingMs = attemptBudgets(started, spec.attemptMinutes).codingMs;
	if (!report && sessionId && remainingMs > 0) {
		await resources.phase("report-recovery");
		const budgetMs = Math.min(8 * 60_000, remainingMs);
		log(`no json report; resuming session ${sessionId} once (up to ${Math.round(budgetMs / 1000)}s)`);
		const resumePrompt = `Finish now. Commit your work (git add -A && git commit) and end your final message with the fenced \`\`\`json report in exactly the required schema.\n\n${reportInstruction}`;
		const resumed = await runOpencode([...baseArgs, "--session", sessionId, resumePrompt], budgetMs);
		cost += resumed.cost;
		text += resumed.text;
		report = normalize(lastJsonBlock(resumed.text));
		reportRecovered = Boolean(report);
		if (reportRecovered) failure ??= resumed.failure;
		log(`resume ${reportRecovered ? "recovered the report" : `ended without a report (exit ${resumed.code})`}, resume $${resumed.cost.toFixed(3)}, total $${cost.toFixed(3)}`);
	}
	if (!report) failure ??= missingReport;

	await resources.phase("verification");
	// 4. Facts, gathered independently of what the coder claims. Anything the coder left running goes first.
	await run("pkill", ["-KILL", "-u", String(CODER.uid)], { cwd: "/" });
	if ((await git("status", "--porcelain")) !== "") {
		await git("add", "-A");
		await git("commit", "--no-verify", "-m", `${spec.title} (attempt ${spec.attempt})`);
	}
	const verifiedSha = await git("rev-parse", "HEAD");
	const commits = (await git("log", "--format=%h %s", `${baseSha}..HEAD`)).split("\n").filter(Boolean);
	// How far the branch is behind the base as cloned (origin/<base> comes with the clone): 0 once a sync merged it.
	const behind = await run("git", ["-c", "core.fsmonitor=false", `--git-dir=${WORK}/.git`, `--work-tree=${WORK}`, "rev-list", "--count", `HEAD..origin/${spec.base}`], { asCoder: true, env: coderEnv });
	const behindBase = behind.code === 0 ? Number(behind.stdout.trim()) : undefined;
	const diffStat = await git("diff", "--stat", `${baseSha}..HEAD`);
	const fullDiff = await git("diff", `${baseSha}..HEAD`);
	let verify;
	if (spec.verify) {
		log(`verify: ${spec.verify}`);
		const result = await run("bash", ["-c", spec.verify], { env: coderEnv, asCoder: true, reserveMs: 30_000, timeoutMs: 15 * 60_000 });
		verify = { command: spec.verify, exitCode: result.code, output: scrub(`${result.stdout}\n${result.stderr}`.trim()).slice(-8_000), timedOut: result.timedOut };
	}

	// The coder's proofs are re-run here, one at a time, so the evidence shows what happens, not what the coder says.
	let proofs;
	if (report?.proofs.length) {
		await resources.phase("proofs");
		proofs = [];
		for (const proof of report.proofs) {
			if (Date.now() >= deadline - 5000) { failure = [failure, "proof budget exhausted"].filter(Boolean).join("; "); break; }
			log(`proof: ${proof.criterion}`);
			let outcome;
			try {
				const result = await run("bash", ["-c", proof.command], { env: coderEnv, asCoder: true, reserveMs: 30_000, timeoutMs: 3 * 60_000 });
				outcome = { exitCode: result.code, output: scrub(`${result.stdout}\n${result.stderr}`.trim()).slice(-3_000), timedOut: result.timedOut };
			} catch (error) {
				outcome = { exitCode: -1, output: scrub(error instanceof Error ? error.message : String(error)).slice(-3_000), timedOut: false };
			}
			proofs.push({ criterionIndex: proof.criterionIndex, criterion: proof.criterion, command: proof.command, expect: proof.expect, ...outcome });
			await run("pkill", ["-KILL", "-u", String(CODER.uid)], { cwd: "/" });
		}
		log(`proofs: ${proofs.filter((p) => p.exitCode === 0).length}/${proofs.length} exit 0`);
	}

	// Verification and proofs must apply to the packaged commit; commands cannot quietly change the tested code.
	if ((await git("rev-parse", "HEAD")) !== verifiedSha || (await git("diff", "--name-only", "HEAD"))) {
		failure = [failure, "verification/proofs changed the tested commit or tracked files"].filter(Boolean).join("; ");
		if (verify) { verify.exitCode = 1; verify.output = `${verify.output}\n${failure}`.slice(-8000); }
		(proofs ??= []).push({ criterion: "Tested commit integrity", command: "git rev-parse HEAD; git diff --name-only HEAD", expect: "The tested commit and tracked files remain unchanged", exitCode: 1, output: failure, timedOut: false });
	}

	await resources.phase("packaging");
	// 5. Package the branch for the agent to push: an incremental bundle above the cloned commit (capped at 20 MB).
	await run("pkill", ["-KILL", "-u", String(CODER.uid)], { cwd: "/" });
	let bundle;
	if (commits.length) {
		await rm("/tmp/branch.bundle", { force: true });
		await git("bundle", "create", "/tmp/branch.bundle", "HEAD", `^${baseSha}`);
		const file = await open("/tmp/branch.bundle", constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (!info.isFile() || info.uid !== CODER.uid) throw new Error("unsafe branch bundle file");
			resources.bundle(info.size);
			if (info.size > 20 * 2 ** 20) failure = `${failure ? `${failure}; ` : ""}the branch bundle is ${(info.size / 2 ** 20).toFixed(0)} MB, over the 20 MB limit`;
			else {
				const bytes = Buffer.alloc(info.size);
				let offset = 0;
				while (offset < bytes.length) {
					const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
					if (!bytesRead) throw new Error("branch bundle changed while reading");
					offset += bytesRead;
				}
				if ((await file.stat()).size !== info.size) throw new Error("branch bundle changed while reading");
				bundle = bytes.toString("base64");
			}
		} finally { await file.close(); }
	}

	const evidence = {
		resources: await resources.finish(),
		report,
		agentError: failure,
		commits,
		diffStat,
		diff: fullDiff.slice(0, 60_000),
		diffTruncated: fullDiff.length >= 60_000,
		verify,
		proofs,
		behindBase,
		costUsd: cost || undefined,
		verifiedHeadSha: verifiedSha,
		reportRecovered: reportRecovered || undefined,
		durationMs: Date.now() - started,
		bundle,
		...(bundle ? { bundleBase: baseSha } : {}),
	};
	log(`evidence ready: ${commits.length} commit(s), verify ${verify ? `exit ${verify.exitCode}` : "n/a"}, proofs ${proofs ? `${proofs.filter((p) => p.exitCode === 0).length}/${proofs.length} exit 0` : "n/a"}, report ${report?.status ?? "missing"}, bundle ${bundle ? `${Math.round(bundle.length / 1024)} KB` : "none"}${failure ? `, error: ${failure.slice(0, 200)}` : ""}`);
	await post("/api/runner/evidence", { taskId: spec.taskId, attempt: spec.attempt, sessionId, evidence: JSON.parse(JSON.stringify(evidence)) });
	log(`evidence sent: ${commits.length} commit(s), verify ${verify ? `exit ${verify.exitCode}` : "n/a"}`);
}

/**
 * A holdout run: no coder. Clone the goal branch, fetch the examiner's hidden checks with this attempt's token, run the
 * project's verify command (it installs dependencies), then each check as the unprivileged user. The commands stay in
 * memory and are never logged; the evidence carries only exit codes and output.
 */
async function holdoutMain() {
	log(`holdout run ${spec.taskId} attempt ${spec.attempt} on ${spec.repo}@${spec.branch}`);
	await resources.phase("clone");
	await rm(WORK, { recursive: true, force: true });
	const clone = await run("git", ["clone", "--quiet", "--branch", spec.branch, authed, WORK], { cwd: "/", timeoutMs: 5 * 60_000 });
	if (clone.code !== 0) throw new Error(`clone failed: ${scrub(clone.stderr)}`);
	await git("remote", "set-url", "origin", plain);
	await rm(`${WORK}/.git/FETCH_HEAD`, { force: true });
	const headSha = await git("rev-parse", "HEAD");
	const ownership = await run("chown", ["-R", `${CODER.uid}:${CODER.gid}`, WORK], { cwd: "/" });
	if (ownership.code !== 0) throw new Error("cannot isolate repository ownership");
	repositoryOwnedByCoder = true;
	log(`cloned at ${headSha.slice(0, 7)}`);

	const { checks } = await post("/api/runner/holdouts", { taskId: spec.taskId, attempt: spec.attempt });
	let failure;
	let verify;
	if (spec.verify) {
		await resources.phase("verification");
		log(`verify: ${spec.verify}`);
		const result = await run("bash", ["-c", spec.verify], { env: coderEnv, asCoder: true, reserveMs: 30_000, timeoutMs: 15 * 60_000 });
		verify = { command: spec.verify, exitCode: result.code, output: scrub(`${result.stdout}\n${result.stderr}`.trim()).slice(-8_000), timedOut: result.timedOut };
		await run("pkill", ["-KILL", "-u", String(CODER.uid)], { cwd: "/" });
	}

	await resources.phase("holdouts");
	const holdouts = [];
	for (const check of Array.isArray(checks) ? checks : []) {
		if (Date.now() >= deadline - 5000) { failure = "holdout budget exhausted"; break; }
		log(`holdout ${holdouts.length + 1}/${checks.length}`);
		let outcome;
		try {
			const result = await run("bash", ["-c", String(check.command)], { env: coderEnv, asCoder: true, reserveMs: 30_000, timeoutMs: 3 * 60_000 });
			outcome = { exitCode: result.code, output: scrub(`${result.stdout}\n${result.stderr}`.trim()).slice(-3_000), timedOut: result.timedOut };
		} catch (error) {
			outcome = { exitCode: -1, output: scrub(error instanceof Error ? error.message : String(error)).slice(-3_000), timedOut: false };
		}
		holdouts.push({ index: Number(check.index), ...outcome });
		await run("pkill", ["-KILL", "-u", String(CODER.uid)], { cwd: "/" });
	}
	log(`holdouts: ${holdouts.filter((h) => h.exitCode === 0 && !h.timedOut).length}/${holdouts.length} exit 0`);
	const evidence = { resources: await resources.finish(), agentError: failure, commits: [], diffStat: "", diff: "", diffTruncated: false, verify, holdouts, verifiedHeadSha: headSha, durationMs: Date.now() - started };
	await post("/api/runner/evidence", { taskId: spec.taskId, attempt: spec.attempt, evidence: JSON.parse(JSON.stringify(evidence)) });
	log("evidence sent");
}

/** Reads OpenCode's JSON event stream: the session id, the final text, the cost, and the last error it reported. */

function lastJsonBlock(text) {
	for (const block of [...text.matchAll(/```json\s*([\s\S]*?)```/g)].reverse()) {
		try {
			return JSON.parse(block[1]);
		} catch {
			// try an earlier block
		}
	}
	return undefined;
}

function normalize(value) {
	if (!value || typeof value !== "object") return undefined;
	const list = (v) => (Array.isArray(v) ? v.map(String) : []);
	return {
		status: ["done", "partial", "blocked"].includes(String(value.status)) ? value.status : "partial",
		summary: String(value.summary ?? ""),
		changes: list(value.changes),
		tests: Array.isArray(value.tests) ? value.tests.map((t) => ({ command: String(t?.command ?? ""), passed: Boolean(t?.passed), notes: String(t?.notes ?? "") })) : [],
		risks: list(value.risks),
		questions: list(value.questions),
		proofs: Array.isArray(value.proofs) ? keepProofs(value.proofs, Number(spec.criteria) || 0) : [],
	};
}


try {
	await main();
} catch (error) {
	const message = scrub(error instanceof Error ? error.message : String(error));
	log(`failed: ${message}`);
	await post("/api/runner/evidence", {
		taskId: spec.taskId,
		attempt: spec.attempt,
		evidence: { resources: await resources.finish(), agentError: `runner: ${message}`, commits: [], diffStat: "", diff: "", diffTruncated: false, durationMs: Date.now() - started },
	}).catch(() => {});
} finally {
	clearInterval(heartbeat);
	clearTimeout(deadlineTimer);
	await resources.finish();
}
process.exit(0);
}
export { guardStdStreams, guarded, guardedCapture, isDeadPipe, feedStdin, log, startLlmRelay };

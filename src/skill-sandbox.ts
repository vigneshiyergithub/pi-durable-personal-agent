// A child process that runs model-written skill code under hard limits, away from the agent's secrets. It gets an
// empty environment, runs as the unprivileged agent user in the container (see confine.ts), and Node's permission model
// lets it read only the app and the skills directory: no writes, no child processes, no workers. If a skill exhausts
// its memory or overruns its time limit, the process is killed and the caller gets an error; the agent is unaffected
// and the next call starts a fresh process. (Without this, one skill with a runaway loop grew the agent to 37 GB.)
import { type ChildProcess, execFile, fork } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { AGENT_USER, confined, keepAlive, scrubbedEnv } from "./confine.ts";

const HEAP_MB = 256;
const INSPECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
/** An idle skill process is stopped after this long (it holds 60+ MB); the next call starts a fresh one in ~100 ms. */
const IDLE_MS = 2 * 60_000;
/**
 * V8's heap limit does not bound everything a process can allocate (large buffers), so its real memory is also watched
 * while skill code runs: past this, the process is stopped.
 */
const MAX_RSS_MB = HEAP_MB + 384;
const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A process's resident memory in MB: /proc on Linux, ps elsewhere (local development). */
async function rssMb(pid: number): Promise<number> {
	try {
		return (Number(readFileSync(`/proc/${pid}/statm`, "utf8").split(" ")[1]) * 4096) / 2 ** 20;
	} catch {
		const { stdout } = await promisify(execFile)("ps", ["-o", "rss=", "-p", String(pid)]).catch(() => ({ stdout: "0" }));
		return Number(stdout.trim()) / 1024;
	}
}

export class SkillSandbox {
	private child: ChildProcess | undefined;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private watchdog: NodeJS.Timeout | undefined;
	private idle: NodeJS.Timeout | undefined;
	private stderr = "";

	/** Samples the skill process's memory while any call is in flight. */
	private watch(child: ChildProcess): void {
		if (this.watchdog) return;
		let busy = false;
		this.watchdog = setInterval(async () => {
			if (this.pending.size === 0) return this.unwatch();
			if (busy || child.pid === undefined) return;
			busy = true;
			const mb = await rssMb(child.pid);
			busy = false;
			if (mb > MAX_RSS_MB) this.fail(child, `the skill used too much memory (over ${MAX_RSS_MB} MB) and was stopped`);
		}, 10); // runaway code can allocate several GB per second
		this.watchdog.unref();
	}

	private unwatch(): void {
		clearInterval(this.watchdog);
		this.watchdog = undefined;
	}

	private process(): ChildProcess {
		if (this.child) return this.child;
		// Read-only: the app (the skill kit and its dependencies) and the skills. Resolved paths, since the module loader
		// checks every component of a path, symlinks included (on macOS, /var is one).
		const execArgv = [
			`--max-old-space-size=${HEAP_MB}`,
			"--permission",
			...[APP_ROOT, config.skillsDir].map((p) => `--allow-fs-read=${realpathSync(p)}`),
		];
		// Skills may call web APIs; newer Node versions gate the network behind the permission model too.
		if (process.allowedNodeEnvironmentFlags.has("--allow-net")) execArgv.push("--allow-net");
		const child = fork(fileURLToPath(new URL("./skill-thread.ts", import.meta.url)), [], {
			execArgv,
			// Only the secrets the owner set for skills (SKILL_*); never the agent's own keys.
			env: scrubbedEnv({ HOME: undefined, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("SKILL_"))) }),
			cwd: config.skillsDir,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "advanced",
			...(confined ? AGENT_USER : {}),
		});
		if (child.pid) keepAlive.add(child.pid); // runs as the agent user too; spared by the cleanup between commands
		child.once("exit", () => child.pid && keepAlive.delete(child.pid));
		this.stderr = "";
		child.stderr?.on("data", (chunk) => (this.stderr = (this.stderr + chunk).slice(-4000)));
		child.on("message", (message: { id: number; ok: boolean; value?: unknown; error?: string }) => {
			const call = this.pending.get(message.id);
			if (!call) return;
			this.pending.delete(message.id);
			clearTimeout(call.timer);
			if (message.ok) call.resolve(message.value);
			else call.reject(new Error(message.error));
			if (this.pending.size === 0) this.idleStop(child);
		});
		// "close" comes after stderr is drained, so a heap-limit crash is recognised by its message.
		child.on("close", (code, signal) => {
			const oom = signal === "SIGABRT" || /heap limit|out of memory/i.test(this.stderr);
			this.fail(child, oom ? `the skill ran out of memory (limit ${HEAP_MB} MB) and was stopped` : `the skill process stopped unexpectedly (${signal ?? `exit ${code}`})`);
		});
		// An idle sandbox never keeps the agent alive.
		child.unref();
		(child.channel as { unref?: () => void } | undefined)?.unref?.();
		this.child = child;
		return child;
	}

	/**
	 * Discards this process and rejects everything in flight on it, once it has fully exited: a caller that sees the
	 * error knows the skill's memory is already released. The next request starts a fresh process.
	 */
	private fail(child: ChildProcess, reason: string): void {
		if (this.child !== child) return;
		this.child = undefined;
		this.unwatch();
		const calls = [...this.pending.values()];
		this.pending.clear();
		for (const call of calls) clearTimeout(call.timer);
		const settle = () => {
			for (const call of calls) call.reject(new Error(reason));
		};
		if (child.exitCode !== null || child.signalCode !== null) return settle();
		child.ref(); // wait for it to be gone before the callers hear about it
		child.once("exit", settle);
		child.kill("SIGKILL");
	}

	private idleStop(child: ChildProcess): void {
		clearTimeout(this.idle);
		this.idle = setTimeout(() => {
			if (this.child !== child || this.pending.size) return;
			this.child = undefined;
			child.kill("SIGKILL");
		}, IDLE_MS);
		this.idle.unref();
	}

	private request(message: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
		clearTimeout(this.idle);
		const child = this.process();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.fail(child, `the skill did not finish within ${timeoutMs / 1000}s and was stopped`), timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.watch(child);
			child.send({ id, ...message });
		});
	}

	/** Loads a skill file in the sandbox (running its top-level code there first) and reports its name and tools. */
	inspect(path: string, version: string): Promise<{ name?: string; tools: string[] }> {
		return this.request({ kind: "inspect", path: realpathSync(path), version }, INSPECT_TIMEOUT_MS) as Promise<{ name?: string; tools: string[] }>;
	}

	call(path: string, version: string, tool: string, args: unknown): Promise<Record<string, unknown>> {
		return this.request({ kind: "call", path: realpathSync(path), version, tool, args }, CALL_TIMEOUT_MS) as Promise<Record<string, unknown>>;
	}

	async close(): Promise<void> {
		clearTimeout(this.idle);
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null && child.signalCode === null) {
			child.ref();
			await new Promise<void>((done) => {
				child.once("exit", () => done());
				child.kill("SIGKILL");
			});
		}
	}
}

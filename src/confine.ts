// Keeps model-driven code away from the agent's secrets. The server holds every credential: the GitHub App key and the
// owner's passkeys under DATA_DIR/secrets, the conversation database, and API keys in its environment. What the models
// drive runs with none of that:
//   - bash runs as an unprivileged user (uid 1000) with a scrubbed environment, so it can neither read root's files
//     nor see the server's environment (/proc/1/environ is root-only);
//   - the file tools (read, write, edit) only reach the workspace and the temp dir, checked after resolving symlinks;
//   - skills run in a child process as that same user, with an empty environment and Node's permission model.
// Confinement switches on when the server runs as root on Linux (the container). Locally the environment is still
// scrubbed and paths still checked, but commands run as you.
import { chmod, chown, lchown, mkdir, readdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, FileError } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { config } from "./config.ts";

/** The `node` user of the official image. */
export const AGENT_USER = { uid: 1000, gid: 1000 } as const;
export const confined = process.platform === "linux" && process.getuid?.() === 0;

/** The only environment model-driven processes get. */
export function scrubbedEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
	const env: Record<string, string | undefined> = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: join(config.workspaceDir, ".home"),
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "dumb",
		TZ: config.timezone,
		...extra,
	};
	return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));
}

/**
 * Locks down DATA_DIR at boot: secrets, the database and everything else become root-only, except the workspace
 * (owned by the agent user) and the skills directory (readable, so the skill process can load skills). New files the
 * server creates are private by default.
 */
export async function hardenDataDir(): Promise<void> {
	process.umask(0o077);
	await mkdir(config.workspaceDir, { recursive: true });
	await mkdir(join(config.workspaceDir, ".home"), { recursive: true });
	await mkdir(config.skillsDir, { recursive: true });
	if (!confined) return;
	await chmod(config.dataDir, 0o711); // traversable to reach the workspace, not listable
	for (const entry of await readdir(config.dataDir)) {
		const path = join(config.dataDir, entry);
		if (path === config.workspaceDir || path === config.skillsDir) continue;
		await restrict(path);
	}
	await ownTree(config.workspaceDir);
	await chmod(config.workspaceDir, 0o700);
	await publishSkills();
	const quarantined = await quarantineSecrets();
	if (quarantined.length) console.warn(`[confine] moved ${quarantined.length} file(s) holding credentials out of the workspace into DATA_DIR/quarantine: ${quarantined.join(", ")}`);
}

/** Processes of the agent user that must survive the cleanup between commands (the skill process). */
export const keepAlive = new Set<number>();

/**
 * Kills every process of the agent user that a command left behind (background jobs, servers). With none running,
 * nothing can swap a path under the file tools between their check and their use.
 */
async function killLeftovers(): Promise<void> {
	if (!confined) return;
	for (const entry of await readdir("/proc").catch(() => [])) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || keepAlive.has(pid)) continue;
		const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
		if (/^Uid:\s+(\d+)/m.exec(status)?.[1] === String(AGENT_USER.uid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

/**
 * Commands and file operations never overlap. A command's leftover processes are killed before any file operation
 * runs, so the check-then-use in the file tools can't be raced by the agent user. Commands may overlap each other,
 * and so may file operations.
 */
const turnstile = (() => {
	let commands = 0;
	let files = 0;
	let waiting: Array<() => void> = [];
	const wake = () => {
		const queued = waiting;
		waiting = [];
		for (const resume of queued) resume();
	};
	return {
		async enter(kind: "command" | "file"): Promise<void> {
			while (kind === "command" ? files > 0 : commands > 0) await new Promise<void>((resume) => waiting.push(resume));
			if (kind === "command") commands++;
			else files++;
		},
		async leave(kind: "command" | "file"): Promise<void> {
			// The last command out cleans up while still counted, so no file operation starts mid-cleanup.
			if (kind === "command" && commands === 1) await killLeftovers();
			if (kind === "command") commands--;
			else files--;
			wake();
		},
	};
})();

/**
 * Scans the workspace for credentials that reached it (the App key, API keys): the agent user can read everything
 * there. Anything found is moved to a root-only quarantine and reported.
 */
async function quarantineSecrets(): Promise<string[]> {
	const needles = [
		"PRIVATE KEY-----",
		...["OPENROUTER_API_KEY", "OPENROUTER_MANAGEMENT_KEY", "SANDBOX_RAILWAY_TOKEN", "TELEGRAM_BOT_TOKEN", "AUTH_TOKEN"]
			.map((name) => process.env[name])
			.filter((v): v is string => typeof v === "string" && v.length >= 16),
	];
	const quarantine = join(config.dataDir, "quarantine");
	const found: string[] = [];
	let budget = 20_000; // files
	const walk = async (dir: string): Promise<void> => {
		for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (--budget < 0) return;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") await walk(path);
			} else if (entry.isFile()) {
				const info = await stat(path).catch(() => undefined);
				if (!info || info.size > 2 ** 20) continue;
				const text = await readFile(path, "utf8").catch(() => "");
				if (!needles.some((n) => text.includes(n))) continue;
				await mkdir(quarantine, { recursive: true, mode: 0o700 });
				await rename(path, join(quarantine, `${Date.now()}-${relative(config.workspaceDir, path).replaceAll(sep, "__")}`));
				found.push(relative(config.workspaceDir, path));
			}
		}
	};
	await walk(config.workspaceDir);
	return found;
}

/** Makes skill files readable by the skill process (they are code, not secrets); history stays private. */
export async function publishSkills(): Promise<void> {
	if (!confined) return;
	await chmod(config.skillsDir, 0o755);
	for (const entry of await readdir(config.skillsDir)) {
		if (entry.startsWith(".")) continue;
		await chmod(join(config.skillsDir, entry), 0o644).catch(() => {});
	}
}

async function restrict(path: string): Promise<void> {
	const info = await stat(path).catch(() => undefined);
	if (!info) return;
	await chown(path, 0, 0).catch(() => {});
	if (info.isDirectory()) {
		await chmod(path, 0o700);
		for (const entry of await readdir(path)) await restrict(join(path, entry));
	} else await chmod(path, 0o600);
}

async function ownTree(path: string): Promise<void> {
	await lchown(path, AGENT_USER.uid, AGENT_USER.gid).catch(() => {});
	const info = await stat(path).catch(() => undefined);
	if (info?.isDirectory()) for (const entry of await readdir(path)) await ownTree(join(path, entry));
}

const denied = (path: string) => err<never, FileError>(new FileError("permission_denied", `${path} is outside the agent's workspace`, path));

/** File tool methods whose first argument is a path. */
const PATH_METHODS = [
	"readTextFile",
	"openTextLineReader",
	"readTextLines",
	"readBinaryFile",
	"openBinaryReader",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"fileInfo",
	"listDir",
	"listFiles",
	"openDirReader",
	"canonicalPath",
	"exists",
	"createDir",
	"remove",
] as const;
/** Ones that create or replace files, which the agent user must own afterwards. */
const CREATES = new Set<string>(["writeFile", "appendFile", "createDir", "renameFile"]);

/**
 * The execution environment for the coding tools (read, write, edit, bash): commands as the agent user with a scrubbed
 * environment, and files only inside the workspace or the temp dir.
 */
export class ConfinedEnv extends NodeExecutionEnv {
	private readonly roots: Promise<string[]>;
	private readonly dataDir: Promise<string>;

	constructor(cwd: string) {
		super({ cwd, shellEnv: scrubbedEnv() });
		this.roots = Promise.all([config.workspaceDir, tmpdir()].map((r) => realpath(r).catch(() => resolve(r))));
		this.dataDir = realpath(config.dataDir).catch(() => resolve(config.dataDir));
		for (const name of PATH_METHODS) {
			const original = (NodeExecutionEnv.prototype as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name];
			if (typeof original !== "function") continue;
			(this as unknown as Record<string, unknown>)[name] = async (path: string, ...rest: unknown[]) => {
				await turnstile.enter("file");
				try {
					if (!(await this.allowed(path))) return denied(path);
					const result = (await original.call(this, path, ...rest)) as { ok: boolean };
					if (result.ok && CREATES.has(name)) await this.handOver(path);
					return result;
				} finally {
					await turnstile.leave("file");
				}
			};
		}
	}

	override async renameFile(source: string, destination: string, context: Context) {
		await turnstile.enter("file");
		try {
			if (!(await this.allowed(source)) || !(await this.allowed(destination))) return denied(`${source} → ${destination}`);
			const result = await super.renameFile(source, destination, context);
			if (result.ok) await this.handOver(destination);
			return result;
		} finally {
			await turnstile.leave("file");
		}
	}

	override async exec(command: string | readonly string[], options: Parameters<NodeExecutionEnv["exec"]>[1], context: Context) {
		// Never the server's environment, whatever the caller asked for.
		const scrubbed = { ...options, inheritEnv: false, env: scrubbedEnv(options?.env) };
		await turnstile.enter("command");
		try {
			if (!confined) return await super.exec(command, scrubbed, context);
			const argv = typeof command === "string" ? ["sh", "-c", command] : [...command];
			return await super.exec(["setpriv", `--reuid=${AGENT_USER.uid}`, `--regid=${AGENT_USER.gid}`, "--clear-groups", "--", ...argv], scrubbed, context);
		} finally {
			await turnstile.leave("command");
		}
	}

	/** Whether a path, with every symlink resolved (for a new file: its nearest existing parent), stays in a root. */
	private async allowed(path: string): Promise<boolean> {
		const absolute = isAbsolute(path) ? path : resolve(this.cwd, path);
		let existing = absolute;
		let rest = "";
		for (;;) {
			try {
				existing = await realpath(existing);
				break;
			} catch {
				const parent = dirname(existing);
				if (parent === existing) return false;
				rest = join(existing.slice(parent.length + 1), rest);
				existing = parent;
			}
		}
		const target = rest ? join(existing, rest) : existing;
		const within = (root: string) => target === root || target.startsWith(root + sep);
		const [workspace, ...others] = await this.roots;
		if (within(workspace!)) return true;
		// The rest of the data dir (secrets, database) is never reachable, even where it lies inside the temp dir.
		if (within(await this.dataDir)) return false;
		return others.some(within);
	}

	/** Files the tools create in the workspace belong to the agent user, so bash can use them too. */
	private async handOver(path: string): Promise<void> {
		if (!confined) return;
		const absolute = resolve(this.cwd, path);
		const root = (await this.roots)[0]!;
		const real = await realpath(absolute).catch(() => absolute);
		if (!real.startsWith(root + sep)) return;
		// The path and each parent up to the workspace (createDir may have made several).
		for (let p = real; p !== root && relative(root, p) && !relative(root, p).startsWith(".."); p = dirname(p)) {
			await lchown(p, AGENT_USER.uid, AGENT_USER.gid).catch(() => {});
		}
	}
}

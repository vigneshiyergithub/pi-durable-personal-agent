// Self-written skills: ES modules the agent writes into DATA_DIR/skills. Each one default-exports a factory that gets a
// small kit injected (skills live on the volume, outside node_modules, so they cannot import packages) and returns an
// extension with tools. Installing an extension with an existing name replaces it in place, so a rewritten skill takes
// effect on the next tool call without a restart.
//
// Skill code is model-written, so it never executes in the agent's process: every tool call runs in the skill sandbox
// (a worker thread with memory and time limits), and a skill file's top-level code is first run there too. The agent
// only imports a skill after that, to read its tool names and argument schemas.
import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Extension } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { SkillSandbox } from "./skill-sandbox.ts";
import { kit } from "./skill-kit.ts";

export const SKILL_PREFIX = "skill-";
const NAME = /^[a-z][a-z0-9-]{1,40}$/;


type Registry = { install(extension: Extension): void; uninstall(extension: Extension): void };

export type SkillInfo = { name: string; tools: string[]; description: string; error?: string };

const historyDir = () => join(config.skillsDir, ".history");
const fileOf = (name: string) => join(config.skillsDir, `${name}.mjs`);

const sandbox = new SkillSandbox();

/**
 * Checks a skill file in the sandbox first (its top-level code runs there, under limits), then imports it here only to
 * read its tool definitions. Returns the tool definitions, without anything that would execute in the agent.
 */
/**
 * A skill file's version for module caches: a hash of its content. Not its mtime: two saves within one timestamp tick
 * (or one millisecond) would share it, and the sandbox would serve the previous code.
 */
const versionOf = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex").slice(0, 16);

async function definitions(path: string, name: string): Promise<Extension> {
	const version = await versionOf(path);
	const shape = await sandbox.inspect(path, version);
	if (shape.name !== `${SKILL_PREFIX}${name}`) {
		throw new Error(`extension name must be "${SKILL_PREFIX}${name}", got "${shape.name}"`);
	}
	const module = await import(`${pathToFileURL(path).href}?v=${version}-${Math.random()}`);
	const extension = (await module.default(kit)) as Extension;
	return { name: extension.name, tools: extension.tools ?? [] };
}

/** The installed form of a skill: same tools, but each call executes in the sandbox against the file at `path`. */
async function isolated(extension: Extension, path: string): Promise<Extension> {
	const version = await versionOf(path);
	return {
		name: extension.name,
		tools: (extension.tools ?? []).map((tool) => ({
			...tool,
			execute: async (args: unknown) => (await sandbox.call(path, version, tool.name, args)) as never,
		})) as Extension["tools"],
	};
}

export const closeSkillSandbox = () => sandbox.close();

export class Skills {
	private readonly installed = new Map<string, { extension: Extension; description: string }>();
	private readonly broken = new Map<string, string>();

	private readonly registry: Registry;

	constructor(registry: Registry) {
		this.registry = registry;
	}

	/** Installs every skill on disk. A broken skill is reported, never fatal: the agent must always boot. */
	async loadAll(): Promise<void> {
		await mkdir(historyDir(), { recursive: true });
		for (const file of await readdir(config.skillsDir)) {
			if (!file.endsWith(".mjs")) continue;
			const name = file.slice(0, -4);
			try {
				const extension = await definitions(fileOf(name), name);
				this.install(name, await isolated(extension, fileOf(name)), await this.describe(name));
			} catch (error) {
				this.broken.set(name, String(error));
				console.error(`[skills] ${name} failed to load:`, error);
			}
		}
	}

	/**
	 * Writes a new version of a skill. The code is staged and imported first; only if it loads is it moved into place and
	 * installed, and the previous version is kept in .history for rollback.
	 */
	async save(name: string, code: string, description: string): Promise<SkillInfo> {
		if (!NAME.test(name)) throw new Error(`invalid skill name "${name}": use lowercase letters, digits and dashes`);
		const staged = join(config.skillsDir, `.staged-${name}-${randomUUID()}.mjs`);
		await writeFile(staged, code);
		await chmod(staged, 0o644); // the skill process (another user) must read it; skills are code, not secrets
		let extension: Extension;
		try {
			extension = await definitions(staged, name);
		} catch (error) {
			await rm(staged, { force: true });
			throw new Error(`skill did not load, nothing changed: ${error instanceof Error ? error.message : error}`);
		}
		const target = fileOf(name);
		if (await exists(target)) await this.archive(name, `${Date.now()}`);
		await rename(staged, target);
		await writeFile(join(config.skillsDir, `${name}.md`), description);
		this.install(name, await isolated(extension, target), description);
		return this.info(name)!;
	}

	async remove(name: string): Promise<void> {
		const entry = this.installed.get(name);
		const target = fileOf(name);
		if (await exists(target)) {
			await this.archive(name, `${Date.now()}`);
			await rm(target);
		}
		if (entry !== undefined) this.registry.uninstall(entry.extension);
		this.installed.delete(name);
		this.broken.delete(name);
	}

	/** Restores the newest archived version of a skill. */
	async rollback(name: string): Promise<SkillInfo> {
		const versions = (await readdir(historyDir())).filter((f) => f.startsWith(`${name}.`) && f.endsWith(".mjs")).sort();
		const latest = versions.at(-1);
		if (latest === undefined) throw new Error(`no earlier version of "${name}"`);
		const code = join(historyDir(), latest);
		const notes = code.replace(/\.mjs$/, ".md");
		const description = await readFile(notes, "utf8").catch(() => this.describe(name));
		// Saving archives the current version, so a rollback can itself be rolled back.
		const info = await this.save(name, await readFile(code, "utf8"), description);
		await rm(code);
		await rm(notes, { force: true });
		return info;
	}

	list(): SkillInfo[] {
		const names = new Set([...this.installed.keys(), ...this.broken.keys()]);
		return [...names].sort().map((name) => this.info(name)!);
	}

	private info(name: string): SkillInfo | undefined {
		const entry = this.installed.get(name);
		const error = this.broken.get(name);
		if (entry === undefined && error === undefined) return undefined;
		return {
			name,
			tools: entry?.extension.tools?.map((tool) => tool.name) ?? [],
			description: entry?.description ?? "",
			...(error === undefined ? {} : { error }),
		};
	}

	/** Copies the current code and description of a skill into .history under one version stamp. */
	private async archive(name: string, stamp: string): Promise<void> {
		await copyFile(fileOf(name), join(historyDir(), `${name}.${stamp}.mjs`));
		await copyFile(join(config.skillsDir, `${name}.md`), join(historyDir(), `${name}.${stamp}.md`)).catch(() => {});
	}

	private install(name: string, extension: Extension, description: string): void {
		this.registry.install(extension);
		this.installed.set(name, { extension, description });
		this.broken.delete(name);
	}

	private async describe(name: string): Promise<string> {
		return readFile(join(config.skillsDir, `${name}.md`), "utf8").catch(() => "");
	}
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

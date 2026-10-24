// Runs as the skill sandbox's child process (see skill-sandbox.ts). Model-written skill code only ever executes here:
// as another user, with no environment and read-only access to the app and skills, under its own memory limit, so a
// runaway skill takes down this process, never the agent.
import { pathToFileURL } from "node:url";
import { kit } from "./skill-kit.ts";

type Tool = { name: string; execute: (args: unknown, api: unknown, context: unknown) => unknown };
type Extension = { name?: string; tools?: Tool[] };

const modules = new Map<string, Promise<Extension>>();

function load(path: string, version: string): Promise<Extension> {
	const key = `${path}?v=${version}`;
	let loaded = modules.get(key);
	if (loaded === undefined) {
		loaded = import(`${pathToFileURL(path).href}?v=${encodeURIComponent(version)}`).then(async (module) => {
			if (typeof module.default !== "function") throw new Error("default export must be a function (kit) => extension");
			return (await module.default(kit)) as Extension;
		});
		modules.set(key, loaded);
		loaded.catch(() => modules.delete(key));
	}
	return loaded;
}

type Request =
	| { id: number; kind: "inspect"; path: string; version: string }
	| { id: number; kind: "call"; path: string; version: string; tool: string; args: unknown };

process.on("message", async (request: Request) => {
	try {
		const extension = await load(request.path, request.version);
		if (request.kind === "inspect") {
			process.send!({ id: request.id, ok: true, value: { name: extension?.name, tools: (extension?.tools ?? []).map((t) => t.name) } });
			return;
		}
		const tool = (extension?.tools ?? []).find((t) => t.name === request.tool);
		if (tool === undefined) throw new Error(`no tool ${request.tool} in ${extension?.name}`);
		const chunks: string[] = [];
		const api = { output: (chunk: unknown) => void chunks.push(String(chunk)) };
		const result = ((await tool.execute(request.args, api, {})) ?? {}) as Record<string, unknown>;
		if (result.output === undefined && chunks.length) result.output = [{ type: "text", text: chunks.join("") }];
		// Results cross the process boundary and are stored durably: plain JSON only.
		process.send!({ id: request.id, ok: true, value: JSON.parse(JSON.stringify(result)) });
	} catch (error) {
		process.send!({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) });
	}
});

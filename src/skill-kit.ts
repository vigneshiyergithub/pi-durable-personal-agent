// What a skill module's default export receives, in the agent and in the sandbox thread alike. Skills may only define
// tools: hooks, sections and documents would run inside the agent, outside the sandbox, so they are not offered.
import { Type } from "@earendil-works/pi-ai";

const unavailable = (what: string) => () => {
	throw new Error(`${what} is not available to skills: skills run isolated and may only define tools`);
};

export const kit = {
	defineExtension: <T>(extension: T) => extension,
	defineTool: <T>(tool: T) => tool,
	Type,
	fetch: globalThis.fetch,
	section: unavailable("section"),
	hook: unavailable("hook"),
	defineDoc: unavailable("defineDoc"),
	ToolTask: undefined,
};
export type SkillKit = typeof kit;

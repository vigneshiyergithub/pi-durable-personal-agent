// ELR M3 arm definitions (spec docs/elr-canvas-spec.md §3, §7, §9 M3).
//
// An arm is the set of tools an episode conversation is configured with:
//   A  = the canvas tools plus view_canvas only — no micro scorecard, no System One.
//   B  = A + a deterministic micro scorecard appended to each canvas tool result.
//   B′ = B + System One labels (calibration arm; labels are stored, never shown to the agent).
// The System One half of B′ lives in ./system-one-run.ts and runs after the episode; the tools the agent
// sees are identical to B's, which is what keeps the calibration arm's labels isolated.
//
// The micro scorecard is injected HERE, in the benchmark runner path (owner design call): the wrap
// extension below uses pi-durable `wrapTool` to append the scorecard text to each canvas tool result,
// and canvas.ts is installed exactly as the server ships it. The default/server path and arm A
// therefore carry no scorecard (§9 M3), and nothing outside src/elr/bench imports the benchmark.
// A second wrap, "bench-target-delivery", is installed in EVERY arm (see below).
import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	wrapTool,
	type Extension,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CanvasDoc, createCanvasExtension } from "../canvas.ts";
import type { Task } from "../../../bench/tasks/generators.ts";
import { microScorecardText } from "./micro.ts";
import type { ArmId } from "./types.ts";

/** A tool result is a scorecard when its text carries any of the scorecard's field names. */
const SCORECARD_MARKERS = ["scorecard", "boundaryF", "boundary-F", "deltaF", "ΔF", "errorClass"] as const;

/** True when a tool result's text carries a micro scorecard (§5). Arm A must never satisfy this. */
export function containsScorecard(text: string): boolean {
	return SCORECARD_MARKERS.some((marker) => text.includes(marker));
}

/** True when this arm runs System One after each episode (the calibration arm B′). */
export function usesSystemOne(arm: ArmId): boolean {
	return arm === "B1";
}

/** True when this arm attaches a micro scorecard to tool results (arms B and B′). */
export function usesMicroScorecard(arm: ArmId): boolean {
	return arm === "B" || arm === "B1";
}

/**
 * Append the micro scorecard (§5) to a canvas tool result's first text item: the same text the
 * paint-result contract describes (§3 "Ack plus, in arms ≥ B, a micro scorecard"). Image content, the
 * ops mirror, details and error flags pass through untouched. With no task in scope the result is
 * returned unchanged, so the wrapper behaves exactly like arm A until the runner points it at a task.
 */
async function withScorecard(
	tool: ToolRegistration,
	result: ToolExecutionResult,
	api: ToolExecutionApi,
	context: Context,
	currentTask: () => Task | undefined,
): Promise<ToolExecutionResult> {
	const task = currentTask();
	if (task === undefined || result.output === undefined) return result;
	const index = result.output.findIndex((item) => item.type === "text");
	if (index < 0) return result;
	const first = result.output[index]!;
	if (first.type !== "text") return result;
	const doc = await api.snapshot(CanvasDoc, String(api.conversationId), context);
	const scorecard = microScorecardText(task, {
		tool: tool.name,
		ops: doc?.ops ?? [],
		...(result.isError === true ? { error: first.text } : {}),
	});
	if (scorecard === "") return result;
	const output = [...result.output];
	output[index] = { type: "text", text: `${first.text}\n${scorecard}` };
	return { ...result, output };
}

/**
 * The runner-side scorecard extension for arms B and B′: no tools of its own, it only wraps the canvas
 * extension's tools so their results carry the micro scorecard. Resolving the canvas ops from the doc
 * after the original execute keeps the scorecard a pure function of the task and the canvas state.
 */
function scorecardWrapExtension(currentTask: () => Task | undefined): Extension {
	const tools = createCanvasExtension().tools ?? [];
	return defineExtension({
		name: "bench-micro-scorecard",
		wraps: tools.map((tool) =>
			wrapTool(tool as ToolRegistration, (target) => ({
				...target,
				execute: async (args, api, context) =>
					withScorecard(target, await target.execute(args, api, context), api, context, currentTask),
			})),
		),
	});
}

/**
 * §3's view_canvas contract: "`image` content (canvas, and the target when the task has one) plus
 * a text scorecard". canvas.ts cannot know bench tasks, so the benchmark extends the SAME tool's
 * result: one more image item — the task's target, an image per D2 — right after the canvas image.
 * No tool is added (arm A's tool set is unchanged); the initial user message keeps the target, so
 * the prompt template is unchanged (§7 "Same prompt template").
 */function targetDeliveryWrapExtension(currentTask: () => Task | undefined): Extension {
	const viewCanvas = createCanvasExtension().tools?.find((tool) => tool.name === "view_canvas") as ToolRegistration;
	return defineExtension({
		name: "bench-target-delivery",
		wraps: [
			wrapTool(viewCanvas, (target) => ({
				...target,
				execute: async (args, api, context) => {
					const result = await target.execute(args, api, context);
					const task = currentTask();
					if (task?.targetPng === undefined || result.output === undefined) return result;
					const targetImage = { type: "image" as const, mimeType: "image/png", data: Buffer.from(task.targetPng).toString("base64") };
					const firstImage = result.output.findIndex((item) => item.type === "image");
					const insertAt = firstImage < 0 ? result.output.length : firstImage + 1;
					const output = [...result.output];
					output.splice(insertAt, 0, targetImage);
					return { ...result, output };
				},
			})),
		],
	});
}

/**
 * The extensions one arm installs. The registry has no other tools, so arm A's tool set is exactly
 * the canvas tools: paint, view_canvas, reset_canvas, done. Arms B and B′ additionally install the
 * scorecard wrap, so the model cannot tell B from A by the tool list, nor B from B′ at all except
 * by the tool-result text, which is identical between them.
 */
export function armExtensions(arm: ArmId, options: { currentTask?: () => Task | undefined } = {}): readonly Extension[] {
	const canvas = createCanvasExtension();
	const withTarget = [canvas, targetDeliveryWrapExtension(options.currentTask ?? (() => undefined))];
	if (!usesMicroScorecard(arm)) return withTarget;
	return [...withTarget, scorecardWrapExtension(options.currentTask ?? (() => undefined))];
}

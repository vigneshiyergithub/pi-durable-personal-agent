// ELR M1 canvas extension: paint, reset_canvas, done.
// The canvas is stored as a durable, replay-safe ordered op list keyed by canvas id.
// The rasterizer in ./raster.ts turns the same ops into PNG/SVG independently.
import { createHash } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineDocFamily, defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { hashOp, journalFor, sha256Hex } from "./journal.ts";
import { rasterizePng, type Op } from "./raster.ts";

const CANVAS_VERSION = 1;
const MAX_OPS_PER_CANVAS = 1000;
const MAX_POINTS_PER_STROKE = 512;
const MAX_WIDTH = 64;
const CANVAS_SIZE = 256;

// view_canvas mirrors the canvas ops to the client as a tagged fenced JSON block so CanvasStep can
// replay the same strokes as SVG. The block is capped so a large canvas never bloats the tool result.
const OPS_BLOCK_TAG = "elr-canvas-ops";
const MAX_OPS_PAYLOAD_BYTES = 128 * 1024;
const OPS_OMITTED_NOTE = "Ops omitted (canvas too large); see image.";

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Coordinates are rounded to 2 decimals so the mirrored op list stays compact and deterministic. */
function roundOp(op: Op): Op {
	if (op.kind === "stroke") {
		return { kind: "stroke", points: op.points.map(([x, y]) => [round2(x), round2(y)]), width: op.width };
	}
	return { kind: "arc", cx: round2(op.cx), cy: round2(op.cy), r: round2(op.r), a0: op.a0, a1: op.a1, width: op.width };
}

export type CanvasDoc = {
	id: string;
	attempt: number;
	seq: number;
	ops: Op[];
	closed: boolean;
};

export const CanvasDoc = defineDocFamily<CanvasDoc, string>({
	kind: "elr.canvas",
	version: 1,
	scope: "session",
	family: true,
	initial(seed) {
		return { id: seed, attempt: 0, seq: 0, ops: [], closed: false };
	},
});

function computeConfigHash(): string {
	// M1 has no quirks; the hash is still deterministic so later variants can be distinguished.
	return createHash("sha256").update(JSON.stringify({})).digest("hex").slice(0, 16);
}

/** Tool identity for this M1 canvas: no quirks yet, but the hash is carried on every journal event. */
const canvasIdentity = { namespace: "painting", version: CANVAS_VERSION, configHash: computeConfigHash() } as const;

/**
 * The references a canvas action exposes (spec §4: events store references). The transcript keeps the
 * tool result verbatim, so the boot reconciler re-derives a lost event's op/attempt/before/after.
 */
export type CanvasToolDetails = {
	readonly namespace: string;
	readonly version: number;
	readonly configHash: string;
	readonly tool: string;
	readonly attempt: number;
	readonly opHash: string;
	readonly beforeHash: string;
	readonly afterHash: string;
};

function actionDetails(input: {
	tool: string;
	attempt: number;
	opHash: string;
	beforeHash: string;
	afterHash: string;
}): CanvasToolDetails {
	return {
		namespace: canvasIdentity.namespace,
		version: canvasIdentity.version,
		configHash: canvasIdentity.configHash,
		tool: input.tool,
		attempt: input.attempt,
		opHash: input.opHash,
		beforeHash: input.beforeHash,
		afterHash: input.afterHash,
	};
}

function toolIdentity(namespace: string, name: string, version: number, configHash: string): string {
	return `namespace:${namespace}|name:${name}|version:${version}|configHash:${configHash}`;
}

function hashOps(ops: readonly Op[]): string {
	return sha256Hex(rasterizePng(ops, CANVAS_SIZE));
}

/** One journal action write per canvas tool call (spec §3, §9 M2). Best-effort: never fails the tool. */
function recordAction(
	api: ToolExecutionApi,
	input: { tool: string; attempt: number; opHash: string; beforeHash: string; afterHash: string },
): void {
	try {
		journalFor().recordCanvasAction({
			toolCallId: api.callId,
			conversationId: String(api.conversationId),
			sessionId: String(api.conversationId),
			attemptId: `${api.conversationId}#${input.attempt}`,
			tool: input.tool,
			namespace: canvasIdentity.namespace,
			version: canvasIdentity.version,
			configHash: canvasIdentity.configHash,
			opHash: input.opHash,
			beforeHash: input.beforeHash,
			afterHash: input.afterHash,
		});
	} catch (error) {
		// The journal is the evidence trail, not the episode: a write failure must not fail a tool call.
		console.error(`[elr] journal write failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function ok(text: string, details?: CanvasToolDetails) {
	return { output: [{ type: "text" as const, text: text }], ...(details === undefined ? {} : { details }) };
}

function err(text: string) {
	return { output: [{ type: "text" as const, text: text }], isError: true as const };
}

function validateStroke(points: unknown, width: unknown): string | undefined {
	if (!Array.isArray(points) || points.length < 2) {
		return `stroke must have at least 2 points, got ${Array.isArray(points) ? points.length : typeof points}`;
	}
	if (points.length > MAX_POINTS_PER_STROKE) {
		return `stroke has ${points.length} points, max ${MAX_POINTS_PER_STROKE}`;
	}
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0 || width > MAX_WIDTH) {
		return `width must be > 0 and <= ${MAX_WIDTH}, got ${width}`;
	}
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		if (!Array.isArray(p) || p.length !== 2) {
			return `point ${i} is not [x, y]`;
		}
		const [x, y] = p;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) {
			return `point ${i} has non-finite coordinates (${x}, ${y})`;
		}
		if (x < 0 || x > CANVAS_SIZE || y < 0 || y > CANVAS_SIZE) {
			return `point ${i} (${x}, ${y}) is outside [0, ${CANVAS_SIZE}]`;
		}
	}
	return undefined;
}

export function createCanvasExtension(): Extension {
	const identity = canvasIdentity;
	const describe = (name: string, body: string) =>
		`${toolIdentity(identity.namespace, name, identity.version, identity.configHash)}. ${body}`;

	return defineExtension({
		name: "canvas",
		tools: [
			defineTool({
				name: "paint",
				description: describe(
					"paint",
					"Paint one stroke through absolute 2D points on a 256x256 canvas. Parameters: {points: [x,y][], width}.",
				),
				parameters: Type.Object({
					points: Type.Array(Type.Tuple([Type.Number(), Type.Number()]), {
						minItems: 2,
						maxItems: MAX_POINTS_PER_STROKE,
						description: "ordered points [x, y] the stroke passes through",
					}),
					width: Type.Number({
						exclusiveMinimum: 0,
						maximum: MAX_WIDTH,
						description: "stroke width in pixels",
					}),
				}),
				execute: async (args, api: ToolExecutionApi, ctx: Context) => {
					const validation = validateStroke(args.points, args.width);
					if (validation !== undefined) {
						return err(validation);
					}
					const canvasId = String(api.conversationId);
					const op: Op = { kind: "stroke", points: args.points, width: args.width };
					let beforeHash = "";
					let afterHash = "";
					let attempt = 0;
					const result = await api.commit(async (tx) => {
						const doc = await tx.doc(CanvasDoc, canvasId, canvasId);
						if (doc.closed) {
							return err("episode is closed; call reset_canvas to start a new attempt");
						}
						if (doc.seq >= MAX_OPS_PER_CANVAS) {
							return err(`canvas op cap reached (${MAX_OPS_PER_CANVAS})`);
						}
						beforeHash = hashOps(doc.ops);
						doc.ops.push(op);
						doc.seq += 1;
						afterHash = hashOps(doc.ops);
						attempt = doc.attempt;
						return ok(
							`stroke recorded (seq=${doc.seq}, ops=${doc.ops.length})`,
							actionDetails({ tool: "paint", attempt, opHash: hashOp(op), beforeHash, afterHash }),
						);
					}, ctx);
					if (!("isError" in result) || result.isError !== true) {
						recordAction(api, { tool: "paint", attempt, opHash: hashOp(op), beforeHash, afterHash });
					}
					return result;
				},
			}),
			defineTool({
				name: "view_canvas",
				description: describe(
					"view_canvas",
					"Return the current canvas as a PNG image plus a neutral scorecard. No parameters.",
				),
				parameters: Type.Object({}),
				execute: async (_args, api: ToolExecutionApi, ctx: Context) => {
					const canvasId = String(api.conversationId);
					const doc = await api.snapshot(CanvasDoc, canvasId, ctx);
					const ops = doc?.ops ?? [];
					const attempt = doc?.attempt ?? 0;
					const id = doc?.id ?? canvasId;
					const png = rasterizePng(ops, CANVAS_SIZE);
					const pngBase64 = Buffer.from(png).toString("base64");
					const hash = createHash("sha256").update(png).digest("hex");
					const lines = [
						`Canvas ID: ${id}`,
						`Size: ${CANVAS_SIZE}x${CANVAS_SIZE}`,
						`Strokes: ${ops.length}`,
						`Attempt: ${attempt}`,
						`Image SHA-256: ${hash}`,
						`Scoring and deterministic verification arrive in M2.`,
					];
					// Mirror the ordered op list for the web client, unless it is empty or too large to send.
					let opsItem: { type: "text"; text: string } | undefined;
					if (ops.length > 0) {
						const payload = JSON.stringify({ canvasId: id, ops: ops.map(roundOp) });
						if (Buffer.byteLength(payload, "utf8") > MAX_OPS_PAYLOAD_BYTES) {
							lines.push(OPS_OMITTED_NOTE);
						} else {
							opsItem = { type: "text", text: `\`\`\`json ${OPS_BLOCK_TAG}\n${payload}\n\`\`\`` };
						}
					}
					const scorecard = lines.join("\n");
					return {
						output: [
							{ type: "image" as const, mimeType: "image/png", data: pngBase64 },
							{ type: "text" as const, text: scorecard },
							...(opsItem ? [opsItem] : []),
						],
					};
				},
			}),
			defineTool({
				name: "reset_canvas",
				description: describe(
					"reset_canvas",
					"Clear the canvas, end the current attempt, and start a new attempt.",
				),
				parameters: Type.Object({}),
				execute: async (_args, api: ToolExecutionApi, ctx: Context) => {
					const canvasId = String(api.conversationId);
					let beforeHash = "";
					let afterHash = "";
					let attempt = 0;
					const result = await api.commit(async (tx) => {
						const doc = await tx.doc(CanvasDoc, canvasId, canvasId);
						beforeHash = hashOps(doc.ops);
						doc.ops = [];
						doc.attempt += 1;
						doc.closed = false;
						afterHash = hashOps(doc.ops);
						attempt = doc.attempt;
						return ok(
							`canvas reset (attempt=${doc.attempt})`,
							actionDetails({ tool: "reset_canvas", attempt, opHash: hashOp({ tool: "reset_canvas" }), beforeHash, afterHash }),
						);
					}, ctx);
					if (!("isError" in result) || result.isError !== true) {
						recordAction(api, { tool: "reset_canvas", attempt, opHash: hashOp({ tool: "reset_canvas" }), beforeHash, afterHash });
					}
					return result;
				},
			}),
			defineTool({
				name: "done",
				description: describe("done", "End the episode and mark the current attempt as closed."),
				parameters: Type.Object({}),
				execute: async (_args, api: ToolExecutionApi, ctx: Context) => {
					const canvasId = String(api.conversationId);
					let hash = "";
					let attempt = 0;
					const result = await api.commit(async (tx) => {
						const doc = await tx.doc(CanvasDoc, canvasId, canvasId);
						doc.closed = true;
						hash = hashOps(doc.ops);
						attempt = doc.attempt;
						return ok(
							`episode closed (attempt=${doc.attempt}, seq=${doc.seq})`,
							actionDetails({ tool: "done", attempt, opHash: hashOp({ tool: "done" }), beforeHash: hash, afterHash: hash }),
						);
					}, ctx);
					if (!("isError" in result) || result.isError !== true) {
						recordAction(api, { tool: "done", attempt, opHash: hashOp({ tool: "done" }), beforeHash: hash, afterHash: hash });
					}
					return result;
				},
			}),
		],
	});
}

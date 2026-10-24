// ELR benchmark task generators (spec §3, §7, §8, §9 M2; protected path, D9). One module holding the
// seeded RNG, shape geometry, task families, quirk configs with `configHash`, and set generation.
// Targets rasterise with the repo's own rasterizer (src/elr/raster.ts); no native image dependency.
// The same (set, seed) yields byte-identical targets and the manifest's `setHash` changes with any
// parameter or config change.

import { createHash } from "node:crypto";
import { opsToCoverage, rasterizePng, type Op, type Point } from "../../src/elr/raster.ts";
import { countSet, maskFromCoverage, type BinaryMask, type ElementSpec } from "../../src/elr/verifier/index.ts";

// ── Seeded RNG (spec §8: task parameters randomised per seed) ────────────────────────────────────

export type Rng = {
	next(): number;
	int(min: number, max: number): number;
	range(min: number, max: number): number;
	pick<T>(items: readonly T[]): T;
	shuffle<T>(items: readonly T[]): T[];
	readonly seed: number;
};

/** Fold a string (or pass through a number) into a 32-bit unsigned seed with FNV-1a. */
export function toSeed(input: string | number): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input)) throw new Error(`seed must be finite, got ${input}`);
		return input >>> 0;
	}
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

/** A child seed that depends on both the parent seed and a salt, with no shared stream. */
export function deriveSeed(parent: number, salt: string): number {
	return toSeed(`${parent >>> 0}:${salt}`);
}

function mulberry32(state: number): () => number {
	let a = state >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function createRng(seed: string | number): Rng {
	const normalized = toSeed(seed);
	const draw = mulberry32(normalized);
	return {
		seed: normalized,
		next: draw,
		int(min: number, max: number): number {
			if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
				throw new Error(`int range must be integers with max >= min, got [${min}, ${max}]`);
			}
			return min + Math.floor(draw() * (max - min + 1));
		},
		range(min: number, max: number): number {
			if (!(max >= min)) throw new Error(`range must have max >= min, got [${min}, ${max}]`);
			return min + draw() * (max - min);
		},
		pick<T>(items: readonly T[]): T {
			if (items.length === 0) throw new Error("pick requires a non-empty array");
			return items[Math.floor(draw() * items.length)] as T;
		},
		shuffle<T>(items: readonly T[]): T[] {
			const out = items.slice();
			for (let i = out.length - 1; i > 0; i--) {
				const j = Math.floor(draw() * (i + 1));
				const tmp = out[i] as T;
				out[i] = out[j] as T;
				out[j] = tmp;
			}
			return out;
		},
	};
}

// ── Shape geometry (spec §7) ─────────────────────────────────────────────────────────────────────

export const CANVAS_SIZE = 256;
/** Target outlines are thin (4 px), matching boundary-F@4 and the M2 fixtures. */
export const TARGET_STROKE_WIDTH = 4;

export type ShapeKind = "circle" | "ellipse" | "square" | "triangle" | "star" | "spiral" | "arc";

export type ShapeSpec = {
	kind: ShapeKind;
	cx: number;
	cy: number;
	/** Outline/circumradius in px. */
	radius: number;
	/** Rotation in radians. */
	rotation: number;
	/** Ellipse only: ratio ry / rx, in (0, 1]. */
	aspect?: number;
	/** Arc only: sweep in radians (default a half turn). */
	sweep?: number;
};

/** The geometric half of an element spec; the task generator adds the measured ink budget. */
export type ShapeElementBase = {
	name: string;
	cx: number;
	cy: number;
	radius: number;
	tolerance: number;
	components: number;
	minClosure?: number;
};

const TWO_PI = Math.PI * 2;

function rotate(x: number, y: number, angle: number): Point {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	return [x * c - y * s, x * s + y * c];
}

function offsetPoints(shape: ShapeSpec, local: readonly Point[]): Point[] {
	return local.map(([x, y]) => {
		const [rx, ry] = rotate(x, y, shape.rotation);
		return [shape.cx + rx, shape.cy + ry] as Point;
	});
}

function circlePoints(shape: ShapeSpec, steps = 64): Point[] {
	const out: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const a = (TWO_PI * i) / steps;
		out.push([Math.cos(a) * shape.radius, Math.sin(a) * shape.radius]);
	}
	return offsetPoints(shape, out);
}

function ellipsePoints(shape: ShapeSpec, steps = 96): Point[] {
	const aspect = shape.aspect ?? 0.6;
	const out: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const a = (TWO_PI * i) / steps;
		out.push([Math.cos(a) * shape.radius, Math.sin(a) * shape.radius * aspect]);
	}
	return offsetPoints(shape, out);
}

function polygonPoints(shape: ShapeSpec, angles: readonly number[]): Point[] {
	const local: Point[] = angles.map((a) => [Math.cos(a) * shape.radius, Math.sin(a) * shape.radius] as Point);
	local.push(local[0] as Point); // close the loop
	return offsetPoints(shape, local);
}

function squarePoints(shape: ShapeSpec): Point[] {
	return polygonPoints(shape, [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]);
}

function trianglePoints(shape: ShapeSpec): Point[] {
	return polygonPoints(shape, [Math.PI / 2, Math.PI / 2 + (2 * Math.PI) / 3, Math.PI / 2 + (4 * Math.PI) / 3]);
}

function starPoints(shape: ShapeSpec): Point[] {
	const angles: number[] = [];
	for (let k = 0; k < 5; k++) {
		angles.push(-Math.PI / 2 + (k * TWO_PI) / 5);
		angles.push(-Math.PI / 2 + ((k + 0.5) * TWO_PI) / 5);
	}
	const local: Point[] = angles.map((a, i) => {
		const r = i % 2 === 0 ? shape.radius : shape.radius * 0.42;
		return [Math.cos(a) * r, Math.sin(a) * r] as Point;
	});
	local.push(local[0] as Point);
	return offsetPoints(shape, local);
}

function spiralPoints(shape: ShapeSpec, turns = 2.25, steps = 128): Point[] {
	const out: Point[] = [];
	const start = shape.radius * 0.12;
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const a = t * turns * TWO_PI;
		const r = start + (shape.radius - start) * t;
		out.push([Math.cos(a) * r, Math.sin(a) * r]);
	}
	return offsetPoints(shape, out);
}

/** Rasterizer ops for one target shape. Outlines only; filled shapes are not part of the MVP. */
export function shapeOps(shape: ShapeSpec): Op[] {
	switch (shape.kind) {
		case "circle":
			return [{ kind: "arc", cx: shape.cx, cy: shape.cy, r: shape.radius, a0: 0, a1: TWO_PI, width: TARGET_STROKE_WIDTH }];
		case "ellipse":
			return [{ kind: "stroke", points: ellipsePoints(shape), width: TARGET_STROKE_WIDTH }];
		case "square":
			return [{ kind: "stroke", points: squarePoints(shape), width: TARGET_STROKE_WIDTH }];
		case "triangle":
			return [{ kind: "stroke", points: trianglePoints(shape), width: TARGET_STROKE_WIDTH }];
		case "star":
			return [{ kind: "stroke", points: starPoints(shape), width: TARGET_STROKE_WIDTH }];
		case "spiral":
			return [{ kind: "stroke", points: spiralPoints(shape), width: TARGET_STROKE_WIDTH }];
		case "arc":
			return [
				{
					kind: "arc",
					cx: shape.cx,
					cy: shape.cy,
					r: shape.radius,
					a0: shape.rotation,
					a1: shape.rotation + (shape.sweep ?? Math.PI),
					width: TARGET_STROKE_WIDTH,
				},
			];
	}
}

/** Ops for a whole target (all shapes in order). */
export function shapesToOps(shapes: readonly ShapeSpec[]): Op[] {
	return shapes.flatMap(shapeOps);
}

const DEFAULT_TOLERANCE = 6;

/**
 * The radial band around a shape's centre that its own ink can occupy, as `[min, max]` distances.
 * Used to decide whether one element's region can catch another element's ink.
 */
export function shapeInkBand(shape: ShapeSpec): { min: number; max: number } {
	const half = TARGET_STROKE_WIDTH / 2;
	let inner: number;
	switch (shape.kind) {
		case "circle":
		case "arc":
			inner = shape.radius;
			break;
		case "ellipse":
			inner = shape.radius * (shape.aspect ?? 0.6);
			break;
		case "square":
			inner = shape.radius * Math.cos(Math.PI / 4);
			break;
		case "triangle":
			inner = shape.radius * 0.5;
			break;
		case "star":
			inner = shape.radius * 0.42;
			break;
		case "spiral":
			inner = 0;
			break;
	}
	return { min: Math.max(0, inner - half), max: shape.radius + half };
}

/**
 * The verifier element spec for one shape. Closure is only checked for full circles, where angular
 * coverage around the nominal radius is meaningful. `components` is 1 because every shape is one stroke.
 */
export function shapeElement(shape: ShapeSpec, name: string): ShapeElementBase {
	const base = { name, cx: shape.cx, cy: shape.cy, radius: shape.radius, tolerance: DEFAULT_TOLERANCE, components: 1 };
	if (shape.kind === "circle") return { ...base, minClosure: 0.95 };
	return base;
}

// ── Task families (spec §7) ──────────────────────────────────────────────────────────────────────

export type FamilyBuilder = {
	name: string;
	build(rng: Rng): ShapeSpec[];
};

export const PRIMITIVE_KINDS: readonly ShapeKind[] = ["circle", "ellipse", "square", "triangle", "star", "spiral"];

function jitter(rng: Rng, base: number, spread: number): number {
	return base + rng.range(-spread, spread);
}

function clampToCanvas(value: number, half: number): number {
	return Math.min(CANVAS_SIZE - half, Math.max(half, value));
}

/** A single primitive at a random position, scale and rotation. */
export function primitiveBuilder(kind: ShapeKind): FamilyBuilder {
	return {
		name: `primitive-${kind}`,
		build(rng: Rng): ShapeSpec[] {
			const radius =
				kind === "circle"
					? rng.range(36, 72)
					: kind === "ellipse"
						? rng.range(40, 72)
						: kind === "square"
							? rng.range(36, 64)
							: kind === "triangle"
								? rng.range(42, 74)
								: kind === "star"
									? rng.range(44, 74)
									: rng.range(40, 70);
			const half = radius + 12;
			const cx = clampToCanvas(rng.range(half, CANVAS_SIZE - half), half);
			const cy = clampToCanvas(rng.range(half, CANVAS_SIZE - half), half);
			const shape: ShapeSpec = { kind, cx, cy, radius, rotation: rng.range(0, TWO_PI) };
			if (kind === "ellipse") shape.aspect = rng.range(0.5, 0.78);
			return [shape];
		},
	};
}

function circle(cx: number, cy: number, radius: number, rotation = 0): ShapeSpec {
	return { kind: "circle", cx, cy, radius, rotation };
}
function ellipse(cx: number, cy: number, radius: number, rotation: number, aspect: number): ShapeSpec {
	return { kind: "ellipse", cx, cy, radius, rotation, aspect };
}
function square(cx: number, cy: number, radius: number, rotation = 0): ShapeSpec {
	return { kind: "square", cx, cy, radius, rotation };
}
function triangle(cx: number, cy: number, radius: number, rotation = 0): ShapeSpec {
	return { kind: "triangle", cx, cy, radius, rotation };
}
function arc(cx: number, cy: number, radius: number, rotation: number, sweep: number): ShapeSpec {
	return { kind: "arc", cx, cy, radius, rotation, sweep };
}

/** House (square + roof triangle) with a sun. Unseen in T. */
const houseAndSun: FamilyBuilder = {
	name: "house-sun",
	build(rng) {
		const cx = jitter(rng, 98, 6);
		const baseY = jitter(rng, 160, 5);
		const bodyR = jitter(rng, 44, 4);
		const roofR = jitter(rng, 36, 3);
		const roofY = baseY - bodyR * Math.SQRT1_2 + roofR * 0.5;
		const sunX = jitter(rng, 204, 5);
		const sunY = jitter(rng, 52, 5);
		const sunR = jitter(rng, 22, 3);
		return [square(cx, baseY, bodyR), triangle(cx, roofY, roofR), circle(sunX, sunY, sunR)];
	},
};

/** Face: head circle, two eyes, a smiling arc. Unseen in T. */
const face: FamilyBuilder = {
	name: "face",
	build(rng) {
		const cx = jitter(rng, 128, 5);
		const cy = jitter(rng, 130, 5);
		const headR = jitter(rng, 72, 5);
		const eyeR = jitter(rng, 9, 1.5);
		const eyeDx = headR * 0.34;
		const eyeDy = headR * 0.16;
		const smileR = headR * 0.5;
		return [
			circle(cx, cy, headR),
			circle(cx - eyeDx, cy - eyeDy, eyeR),
			circle(cx + eyeDx, cy - eyeDy, eyeR),
			arc(cx, cy - headR * 0.04, smileR, Math.PI / 6, (2 * Math.PI) / 3),
		];
	},
};

/** Concentric target rings. Unseen in T. */
const targetRings: FamilyBuilder = {
	name: "target-rings",
	build(rng) {
		const cx = jitter(rng, 128, 4);
		const cy = jitter(rng, 128, 4);
		return [circle(cx, cy, jitter(rng, 26, 2)), circle(cx, cy, jitter(rng, 48, 2)), circle(cx, cy, jitter(rng, 70, 2))];
	},
};

/** Flower: a centre disc and five ellipse petals. Unseen in T. */
const flower: FamilyBuilder = {
	name: "flower",
	build(rng) {
		const cx = jitter(rng, 128, 4);
		const cy = jitter(rng, 128, 4);
		const petalDist = jitter(rng, 42, 3);
		const petalR = jitter(rng, 26, 2);
		const petalAspect = jitter(rng, 0.52, 0.05);
		const phase = rng.range(0, TWO_PI);
		const shapes: ShapeSpec[] = [circle(cx, cy, jitter(rng, 19, 2))];
		for (let k = 0; k < 5; k++) {
			const a = phase + (k * TWO_PI) / 5;
			shapes.push(ellipse(cx + Math.cos(a) * petalDist, cy + Math.sin(a) * petalDist, petalR, a, petalAspect));
		}
		return shapes;
	},
};

/** Snowman: three stacked circles. A T composition (H never sees it). */
const snowman: FamilyBuilder = {
	name: "snowman",
	build(rng) {
		const cx = jitter(rng, 128, 4);
		// Outlines are kept disjoint so the target is three separate elements, not one blob.
		return [
			circle(cx, jitter(rng, 196, 3), jitter(rng, 38, 2)),
			circle(cx, jitter(rng, 120, 3), jitter(rng, 28, 2)),
			circle(cx, jitter(rng, 70, 3), jitter(rng, 18, 1.5)),
		];
	},
};

/** Two boxes side by side. A T composition (H never sees it). */
const twoBoxes: FamilyBuilder = {
	name: "two-boxes",
	build(rng) {
		const y = jitter(rng, 128, 5);
		const r = jitter(rng, 42, 4);
		const gap = r * 1.05 + jitter(rng, 4, 3);
		const cx = jitter(rng, 128, 4);
		return [square(cx - gap / 2, y, r, jitter(rng, 0, 0.3)), square(cx + gap / 2, y, r, jitter(rng, 0, 0.3))];
	},
};

/** Tree: a triangular canopy above a square trunk. A T composition (H never sees it). */
const tree: FamilyBuilder = {
	name: "tree",
	build(rng) {
		const cx = jitter(rng, 128, 4);
		const canopyY = jitter(rng, 96, 4);
		const trunkY = jitter(rng, 150, 3);
		return [triangle(cx, canopyY, jitter(rng, 54, 3)), square(cx, trunkY, jitter(rng, 22, 2))];
	},
};

/** Fish: an elliptical body with a triangular tail. A T composition (H never sees it). */
const fish: FamilyBuilder = {
	name: "fish",
	build(rng) {
		const cx = jitter(rng, 116, 4);
		const cy = jitter(rng, 128, 4);
		return [
			ellipse(cx, cy, jitter(rng, 52, 3), 0, jitter(rng, 0.55, 0.04)),
			triangle(cx + jitter(rng, 74, 3), cy, jitter(rng, 30, 2), -Math.PI / 2),
		];
	},
};

/** Arrow: a square shaft with a triangular head. A T composition (H never sees it). */
const arrow: FamilyBuilder = {
	name: "arrow",
	build(rng) {
		const cy = jitter(rng, 128, 4);
		const shaftX = jitter(rng, 104, 4);
		return [square(shaftX, cy, jitter(rng, 15, 2)), triangle(shaftX + jitter(rng, 46, 3), cy, jitter(rng, 32, 2), -Math.PI / 2)];
	},
};

/** Bow tie: two triangles meeting point to point. A T composition (H never sees it). */
const bowtie: FamilyBuilder = {
	name: "bowtie",
	build(rng) {
		const cx = jitter(rng, 128, 4);
		const cy = jitter(rng, 128, 4);
		const r = jitter(rng, 40, 3);
		const gap = r * 0.9;
		return [triangle(cx - gap, cy, r, -Math.PI / 2), triangle(cx + gap, cy, r, Math.PI / 2)];
	},
};

/** Compositions T trains on (and X reuses). Disjoint by name from HELDOUT_FAMILIES (spec §7). */
export const TRAIN_COMPOSITIONS: readonly FamilyBuilder[] = [snowman, twoBoxes, tree, fish, arrow, bowtie];

/** Compositions only H may see (spec §7: H is unseen in T). */
export const HELDOUT_FAMILIES: readonly FamilyBuilder[] = [houseAndSun, face, targetRings, flower];

/** Every primitive family once. */
export const PRIMITIVE_FAMILIES: readonly FamilyBuilder[] = PRIMITIVE_KINDS.map(primitiveBuilder);

// ── Quirk configs and configHash (spec §3) ───────────────────────────────────────────────────────

/** Brush quirks (spec §3): 6 points max, Chaikin smoothing, 10 strokes max. */
export type BrushQuirks = {
	tool: "brush";
	maxPointsPerStroke: number;
	chaikinIterations: number;
	maxStrokes: number;
};

/** Pen quirks (spec §3): y axis, angle unit, arc direction. */
export type PenQuirks = {
	tool: "pen";
	yAxisUp: boolean;
	angleUnit: "degrees" | "radians";
	arcDirection: "clockwise" | "counterclockwise";
};

export type QuirkConfig = BrushQuirks | PenQuirks;

export const BRUSH_QUIRKS: BrushQuirks = Object.freeze({ tool: "brush", maxPointsPerStroke: 6, chaikinIterations: 1, maxStrokes: 10 });
export const PEN_QUIRKS: PenQuirks = Object.freeze({ tool: "pen", yAxisUp: true, angleUnit: "degrees", arcDirection: "clockwise" });
export const PEN_NO_QUIRKS: PenQuirks = Object.freeze({ tool: "pen", yAxisUp: false, angleUnit: "radians", arcDirection: "counterclockwise" });

/** Recursively sort object keys so serialisation is independent of insertion order. */
function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			sorted[key] = sortValue((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/** Canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

/** Stable hash of a quirk config: sha256 of `canonicalJson(config)`, first 16 hex chars. */
export function configHash(config: QuirkConfig): string {
	return createHash("sha256").update(canonicalJson(config)).digest("hex").slice(0, 16);
}

export type NamedConfig = {
	name: string;
	tool: "brush" | "pen";
	config: QuirkConfig;
	configHash: string;
	quirks: string[];
};

/** The named configs the generators use, one per tool/control variant. */
export const NAMED_CONFIGS: readonly NamedConfig[] = Object.freeze([
	{
		name: "brush-quirks",
		tool: "brush",
		config: BRUSH_QUIRKS,
		configHash: configHash(BRUSH_QUIRKS),
		quirks: ["maxPointsPerStroke", "chaikinIterations", "maxStrokes"],
	},
	{ name: "pen-quirks", tool: "pen", config: PEN_QUIRKS, configHash: configHash(PEN_QUIRKS), quirks: ["yAxisUp", "angleUnit", "arcDirection"] },
	{ name: "pen-no-quirks", tool: "pen", config: PEN_NO_QUIRKS, configHash: configHash(PEN_NO_QUIRKS), quirks: [] },
]);

export function namedConfig(name: string): NamedConfig {
	const found = NAMED_CONFIGS.find((c) => c.name === name);
	if (!found) throw new Error(`unknown config "${name}"`);
	return found;
}

// ── Task sets (spec §7) ──────────────────────────────────────────────────────────────────────────

export const SET_IDS = ["T", "H", "X", "X0", "smoke"] as const;
export type SetId = (typeof SET_IDS)[number];

export const MANIFEST_SCHEMA = "elr.bench.tasks/1";

export type ToolName = "brush" | "pen";

export type SetPlan = {
	id: SetId;
	tool: ToolName;
	config: QuirkConfig;
	builders: readonly FamilyBuilder[];
	replicates: number;
	description: string;
};

export type Task = {
	id: string;
	set: SetId;
	index: number;
	seed: number;
	baseSeed: number;
	replicate: number;
	family: string;
	tool: ToolName;
	config: QuirkConfig;
	configHash: string;
	shapes: ShapeSpec[];
	targetOps: Op[];
	targetPng: Uint8Array;
	targetHash: string;
	elements: ElementSpec[];
	totalInkBudget: number;
};

export type ManifestTask = {
	id: string;
	index: number;
	seed: number;
	replicate: number;
	family: string;
	targetHash: string;
	configHash: string;
	elements: ElementSpec[];
	totalInkBudget: number;
};

export type Manifest = {
	schema: string;
	set: SetId;
	seed: number;
	tool: ToolName;
	config: QuirkConfig;
	configHash: string;
	count: number;
	replicates: number;
	setHash: string;
	tasks: ManifestTask[];
};

export type TaskSet = { plan: SetPlan; seed: number; tasks: Task[]; manifest: Manifest };

const SCHEMA = MANIFEST_SCHEMA;
const hashConfig = configHash;

function wrap(builders: readonly FamilyBuilder[], times: number): FamilyBuilder[] {
	const out: FamilyBuilder[] = [];
	for (let i = 0; i < times; i++) for (const builder of builders) out.push(builder);
	return out;
}

// T: 12 primitives (each kind twice) then 12 compositions (six T compositions twice). T's
// compositions are disjoint from H's held-out families (spec §7).
const T_BUILDERS: FamilyBuilder[] = [...wrap(PRIMITIVE_FAMILIES, 2), ...wrap(TRAIN_COMPOSITIONS, 2)];
// H: the four unseen compositions, three variants each -> 12 base tasks x 3 replicates.
const H_BUILDERS: FamilyBuilder[] = wrap(HELDOUT_FAMILIES, 3);
// X: the six primitives plus six compositions (T's, since transfer is measured on the pen tool).
const X_BUILDERS: FamilyBuilder[] = [...PRIMITIVE_FAMILIES, ...TRAIN_COMPOSITIONS];
// X0: six primitives, no quirks.
const X0_BUILDERS: FamilyBuilder[] = [...PRIMITIVE_FAMILIES];
// smoke: one primitive and two compositions, all from T's (non-held-out) pool.
const SMOKE_BUILDERS: FamilyBuilder[] = [PRIMITIVE_FAMILIES[0]!, TRAIN_COMPOSITIONS[0]!, TRAIN_COMPOSITIONS[3]!];

const PLANS: Record<SetId, SetPlan> = {
	T: { id: "T", tool: "brush", config: BRUSH_QUIRKS, builders: T_BUILDERS, replicates: 1, description: "train: twelve brush primitives then twelve 2-3 element compositions" },
	H: { id: "H", tool: "brush", config: BRUSH_QUIRKS, builders: H_BUILDERS, replicates: 3, description: "held-out: unseen compositions (house+sun, face, target rings, flower), 12 x 3 seeds" },
	X: { id: "X", tool: "pen", config: PEN_QUIRKS, builders: X_BUILDERS, replicates: 3, description: "transfer: primitives plus compositions, pen with hidden quirks, 12 x 3 replicates" },
	X0: { id: "X0", tool: "pen", config: PEN_NO_QUIRKS, builders: X0_BUILDERS, replicates: 1, description: "control: six primitives, pen with no quirks" },
	smoke: { id: "smoke", tool: "brush", config: BRUSH_QUIRKS, builders: SMOKE_BUILDERS, replicates: 1, description: "smoke: three tasks (primitive, composition, composition) for M3" },
};

export function planFor(set: SetId): SetPlan {
	const plan = PLANS[set];
	if (!plan) throw new Error(`unknown set "${set}" (expected one of ${SET_IDS.join(", ")})`);
	return plan;
}

export function isSetId(value: string): value is SetId {
	return (SET_IDS as readonly string[]).includes(value);
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Inked pixels within `radius` px of (cx, cy), used to set a generous but real ink budget. */
function inkInRadius(mask: BinaryMask, cx: number, cy: number, radius: number): number {
	const r2 = radius * radius;
	let count = 0;
	for (let y = 0; y < mask.height; y++) {
		const dy = y + 0.5 - cy;
		for (let x = 0; x < mask.width; x++) {
			const i = y * mask.width + x;
			if (mask.data[i] === 0) continue;
			const dx = x + 0.5 - cx;
			if (dx * dx + dy * dy <= r2) count++;
		}
	}
	return count;
}

/** Circles below this radius cover too few pixels for a 0.95 angular-coverage closure check. */
const MIN_CLOSURE_RADIUS = 20;

/**
 * Does any other shape's ink fall inside element `i`'s attribution disk? If so, that disk's
 * connected-component count would include the other shape and the check must be skipped.
 */
function pollutionFlags(shapes: readonly ShapeSpec[], tolerances: readonly number[]): boolean[] {
	return shapes.map((a, i) => {
		const rA = a.radius + (tolerances[i] ?? 0);
		return shapes.some((b, j) => {
			if (i === j) return false;
			const d = Math.hypot(a.cx - b.cx, a.cy - b.cy);
			const band = shapeInkBand(b);
			const minDist = d >= band.max ? d - band.max : d <= band.min ? band.min - d : 0;
			return minDist <= rA;
		});
	});
}

/** Element specs for a target: closure, component count (only when unpolluted) and an ink budget. */
function buildElements(shapes: readonly ShapeSpec[], mask: BinaryMask): ElementSpec[] {
	const bases = shapes.map((shape, i) => shapeElement(shape, `${slug(shape.kind)}-${i + 1}`));
	const polluted = pollutionFlags(shapes, bases.map((b) => b.tolerance));
	return shapes.map((shape, i) => {
		const base = bases[i]!;
		const ink = inkInRadius(mask, base.cx, base.cy, base.radius + base.tolerance);
		const element: ElementSpec = { name: base.name, cx: base.cx, cy: base.cy, radius: base.radius, tolerance: base.tolerance };
		if (base.minClosure !== undefined && shape.kind === "circle" && shape.radius >= MIN_CLOSURE_RADIUS) element.minClosure = base.minClosure;
		if (base.components !== undefined && !polluted[i]) element.components = base.components;
		element.inkBudget = Math.ceil(ink * 1.5) + 80;
		return element;
	});
}

function buildTask(plan: SetPlan, baseSeed: number, builder: FamilyBuilder, replicate: number, index: number): Task {
	const seed = deriveSeed(baseSeed, `${plan.id}:${builder.name}:${replicate}`);
	const rng = createRng(seed);
	const shapes = builder.build(rng);
	const targetOps = shapesToOps(shapes);
	const targetPng = rasterizePng(targetOps, CANVAS_SIZE);
	const mask = maskFromCoverage(opsToCoverage(targetOps, CANVAS_SIZE), CANVAS_SIZE, CANVAS_SIZE);
	const elements = buildElements(shapes, mask);
	const totalInkBudget = Math.ceil(countSet(mask.data) * 1.5) + 200;
	return {
		id: `${plan.id}-${String(index).padStart(3, "0")}-${builder.name}`,
		set: plan.id,
		index,
		seed,
		baseSeed,
		replicate,
		family: builder.name,
		tool: plan.tool,
		config: plan.config,
		configHash: hashConfig(plan.config),
		shapes,
		targetOps,
		targetPng,
		targetHash: sha256Hex(targetPng),
		elements,
		totalInkBudget,
	};
}

function manifestTask(task: Task): ManifestTask {
	return {
		id: task.id,
		index: task.index,
		seed: task.seed,
		replicate: task.replicate,
		family: task.family,
		targetHash: task.targetHash,
		configHash: task.configHash,
		elements: task.elements,
		totalInkBudget: task.totalInkBudget,
	};
}

/** Build a whole set. `seedInput` may be a number or a string. */
export function buildTaskSet(set: SetId, seedInput: string | number = 0): TaskSet {
	const plan = planFor(set);
	const seed = toSeed(seedInput);
	const tasks: Task[] = [];
	let index = 0;
	for (const builder of plan.builders) {
		for (let replicate = 0; replicate < plan.replicates; replicate++) {
			tasks.push(buildTask(plan, seed, builder, replicate, index));
			index++;
		}
	}
	const configHash = hashConfig(plan.config);
	const core = {
		schema: SCHEMA,
		set: plan.id,
		seed,
		tool: plan.tool,
		config: plan.config,
		configHash,
		count: tasks.length,
		replicates: plan.replicates,
		tasks: tasks.map(manifestTask),
	};
	const manifest: Manifest = { ...core, setHash: sha256Hex(new TextEncoder().encode(canonicalJson(core))) };
	return { plan, seed, tasks, manifest };
}

/** Canonical per-task record (no PNG bytes) written alongside the target image. */
export function taskRecord(task: Task): Record<string, unknown> {
	return {
		schema: SCHEMA,
		id: task.id,
		set: task.set,
		index: task.index,
		seed: task.seed,
		baseSeed: task.baseSeed,
		replicate: task.replicate,
		family: task.family,
		tool: task.tool,
		config: task.config,
		configHash: task.configHash,
		shapes: task.shapes,
		targetOps: task.targetOps,
		elements: task.elements,
		totalInkBudget: task.totalInkBudget,
		targetHash: task.targetHash,
	};
}

/** sha256 of the canonical manifest; the set's content hash. */
export function setHash(set: SetId, seedInput: string | number = 0): string {
	return buildTaskSet(set, seedInput).manifest.setHash;
}

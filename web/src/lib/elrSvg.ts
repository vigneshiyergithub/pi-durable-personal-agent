// Pure, DOM-free, JSX-free SVG renderer for ELR canvas ops.
// Mirrors the geometry rules in src/elr/raster.ts so the web SVG and server PNG
// describe the same strokes.

export type Point = [number, number];

export type StrokeOp = {
	kind: "stroke";
	points: Point[];
	width: number;
};

export type ArcOp = {
	kind: "arc";
	cx: number;
	cy: number;
	r: number;
	a0: number;
	a1: number;
	width: number;
};

export type Op = StrokeOp | ArcOp;

const DEFAULT_SIZE = 256;
const MAX_SIZE = 4096;
const MAX_COORD = 1e6;

function clamp(n: number, min: number, max: number): number {
	return n < min ? min : n > max ? max : n;
}

function isFiniteInRange(n: number): boolean {
	return typeof n === "number" && Number.isFinite(n) && n >= -MAX_COORD && n <= MAX_COORD;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function flattenArc(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
	if (r <= 0 || !Number.isFinite(r) || a1 <= a0 || !Number.isFinite(a0) || !Number.isFinite(a1)) {
		return [];
	}
	const sweep = a1 - a0;
	let step: number;
	if (r <= 0.35) {
		step = sweep;
	} else {
		step = 2 * Math.acos(clamp(1 - 0.35 / r, -1, 1));
	}
	step = Math.max(0.0001, Math.min(sweep, step));
	const n = Math.ceil(sweep / step);
	const points: Point[] = [];
	for (let i = 0; i <= n; i++) {
		const t = i / n;
		const a = a0 + t * sweep;
		points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
	}
	return points;
}

function pointsToPathD(points: readonly Point[]): string | undefined {
	if (points.length === 0) return undefined;
	const parts: string[] = [];
	for (let i = 0; i < points.length; i++) {
		const p = points[i];
		if (!Array.isArray(p) || p.length !== 2) return undefined;
		const [x, y] = p;
		if (!isFiniteInRange(x) || !isFiniteInRange(y)) return undefined;
		parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
	}
	return parts.join(" ");
}

function opToPath(op: Op): { d: string; width: number } | undefined {
	if (!op || typeof op !== "object") return undefined;
	if (typeof op.width !== "number" || !Number.isFinite(op.width) || op.width <= 0) return undefined;

	let points: Point[] | undefined;
	if (op.kind === "stroke") {
		if (!Array.isArray(op.points) || op.points.length === 0) return undefined;
		points = op.points.filter((p): p is Point => {
			if (!Array.isArray(p) || p.length !== 2) return false;
			const [x, y] = p;
			return isFiniteInRange(x) && isFiniteInRange(y);
		});
		if (points.length === 0) return undefined;
	} else if (op.kind === "arc") {
		points = flattenArc(op.cx, op.cy, op.r, op.a0, op.a1);
		if (points.length === 0) return undefined;
	} else {
		return undefined;
	}

	const d = pointsToPathD(points);
	if (!d) return undefined;
	return { d, width: op.width };
}

export function opsToPaths(ops: readonly Op[]): Array<{ d: string; width: number }> {
	const out: Array<{ d: string; width: number }> = [];
	for (const op of ops) {
		const p = opToPath(op);
		if (p) out.push(p);
	}
	return out;
}

/**
 * Strict, throwing-free validation of a single untrusted op: same geometry rules as `opToPath`
 * (finite in-range coordinates, a positive width, arcs with r > 0 and a1 > a0), but it rejects an
 * op wholesale if any coordinate is malformed instead of silently dropping it. Used by the web
 * turn builder to decide whether a mirrored op list may be replayed at all.
 */
export function isValidOp(op: unknown): op is Op {
	if (!op || typeof op !== "object") return false;
	const candidate = op as Op;
	if (typeof candidate.width !== "number" || !Number.isFinite(candidate.width) || candidate.width <= 0) return false;
	if (candidate.kind === "stroke") {
		if (!Array.isArray(candidate.points) || candidate.points.length === 0) return false;
		return candidate.points.every(
			(p) => Array.isArray(p) && p.length === 2 && isFiniteInRange(p[0]) && isFiniteInRange(p[1]),
		);
	}
	if (candidate.kind === "arc") {
		return (
			isFiniteInRange(candidate.cx) &&
			isFiniteInRange(candidate.cy) &&
			isFiniteInRange(candidate.r) &&
			isFiniteInRange(candidate.a0) &&
			isFiniteInRange(candidate.a1) &&
			candidate.r > 0 &&
			candidate.a1 > candidate.a0
		);
	}
	return false;
}

export function opsToSvg(ops: readonly Op[], size = DEFAULT_SIZE): string {
	if (!Number.isFinite(size) || size <= 0 || size > MAX_SIZE) {
		size = DEFAULT_SIZE;
	}
	const s = Math.round(size);
	const viewBox = escapeAttr(`0 0 ${s} ${s}`);
	const dim = escapeAttr(String(s));

	const paths = opsToPaths(ops);
	const pathMarkup = paths
		.map((p) => {
			const d = escapeAttr(p.d);
			const width = escapeAttr(p.width.toFixed(2));
			return `<path d="${d}" stroke="black" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" fill="none" />`;
		})
		.join("");

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${dim}" height="${dim}">` +
		`<rect width="${dim}" height="${dim}" fill="white" />` +
		`${pathMarkup}</svg>`
	);
}

import { crc32, deflateSync } from "node:zlib";

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

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function clamp(n: number, min: number, max: number): number {
	return n < min ? min : n > max ? max : n;
}

function writeUint32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	b[0] = (n >>> 24) & 0xff;
	b[1] = (n >>> 16) & 0xff;
	b[2] = (n >>> 8) & 0xff;
	b[3] = n & 0xff;
	return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	return concat(writeUint32(data.length), typeBytes, data, writeUint32(crc32(concat(typeBytes, data))));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

function stampDisc(cx: number, cy: number, radius: number, cov: Float32Array, w: number, h: number): void {
	const margin = radius + 0.5;
	const x0 = Math.max(0, Math.floor(cx - margin));
	const y0 = Math.max(0, Math.floor(cy - margin));
	const x1 = Math.min(w - 1, Math.ceil(cx + margin));
	const y1 = Math.min(h - 1, Math.ceil(cy + margin));
	for (let y = y0; y <= y1; y++) {
		const py = y + 0.5;
		const row = y * w;
		for (let x = x0; x <= x1; x++) {
			const px = x + 0.5;
			const dx = px - cx;
			const dy = py - cy;
			const d = Math.sqrt(dx * dx + dy * dy);
			const c = 1 - smoothstep(radius - 0.5, radius + 0.5, d);
			if (c <= 0) continue;
			const i = row + x;
			const v = cov[i] + c;
			cov[i] = v > 1 ? 1 : v;
		}
	}
}

function clipSegment(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	xmin: number,
	ymin: number,
	xmax: number,
	ymax: number,
): { x0: number; y0: number; x1: number; y1: number } | null {
	let t0 = 0;
	let t1 = 1;
	const dx = x1 - x0;
	const dy = y1 - y0;

	const update = (p: number, q: number): boolean => {
		if (p === 0) return q >= 0;
		const r = q / p;
		if (p < 0) {
			if (r > t1) return false;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return false;
			if (r < t1) t1 = r;
		}
		return true;
	};

	if (!update(-dx, x0 - xmin)) return null;
	if (!update(dx, xmax - x0)) return null;
	if (!update(-dy, y0 - ymin)) return null;
	if (!update(dy, ymax - y0)) return null;
	if (t0 > t1) return null;
	return {
		x0: x0 + t0 * dx,
		y0: y0 + t0 * dy,
		x1: x0 + t1 * dx,
		y1: y0 + t1 * dy,
	};
}

function strokePolyline(points: readonly Point[], width: number, cov: Float32Array, w: number, h: number): void {
	if (width <= 0 || points.length === 0) return;
	const radius = width / 2;
	const spacing = Math.min(1, width / 4);
	const margin = radius + 0.5;
	const xmin = -margin;
	const ymin = -margin;
	const xmax = w + margin;
	const ymax = h + margin;

	if (points.length === 1) {
		const [x, y] = points[0];
		if (x >= xmin && x <= xmax && y >= ymin && y <= ymax) stampDisc(x, y, radius, cov, w, h);
		return;
	}

	for (let i = 0; i < points.length - 1; i++) {
		const [x0, y0] = points[i];
		const [x1, y1] = points[i + 1];
		if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) continue;
		const clipped = clipSegment(x0, y0, x1, y1, xmin, ymin, xmax, ymax);
		if (clipped === null) continue;
		const dx = clipped.x1 - clipped.x0;
		const dy = clipped.y1 - clipped.y0;
		const len = Math.hypot(dx, dy);
		if (len === 0) continue;
		const n = Math.max(1, Math.ceil(len / spacing));
		for (let k = 0; k <= n; k++) {
			const t = k / n;
			stampDisc(clipped.x0 + dx * t, clipped.y0 + dy * t, radius, cov, w, h);
		}
	}
}

function flattenArc(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
	if (r <= 0 || !Number.isFinite(r) || a1 <= a0 || !Number.isFinite(a0) || !Number.isFinite(a1)) return [];
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

function rasterizeInk(ops: readonly Op[], size: number): Float32Array {
	if (size <= 0) throw new Error("size must be positive");
	const w = size;
	const h = size;
	const cov = new Float32Array(w * h);
	for (const op of ops) {
		if (op.width <= 0 || !Number.isFinite(op.width)) continue;
		const radius = op.width / 2;
		const margin = radius + 0.5;
		if (op.kind === "stroke") {
			strokePolyline(op.points, op.width, cov, w, h);
		} else if (op.kind === "arc") {
			if (op.cx + op.r < -margin || op.cx - op.r > w + margin || op.cy + op.r < -margin || op.cy - op.r > h + margin) continue;
			const points = flattenArc(op.cx, op.cy, op.r, op.a0, op.a1);
			strokePolyline(points, op.width, cov, w, h);
		}
	}
	return cov;
}

export function opsToCoverage(ops: readonly Op[], size = 256): Uint8Array {
	const cov = rasterizeInk(ops, size);
	const n = cov.length;
	const bytes = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const v = Math.round(cov[i] * 255);
		bytes[i] = v > 255 ? 255 : v < 0 ? 0 : v;
	}
	return bytes;
}

export function encodePng(width: number, height: number, coverage: Uint8Array): Uint8Array {
	if (width <= 0 || height <= 0) throw new Error("width and height must be positive");
	if (coverage.length !== width * height) throw new Error("coverage length does not match dimensions");
	const filteredSize = (width + 1) * height;
	const filtered = new Uint8Array(filteredSize);
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width + 1);
		filtered[rowStart] = 0;
		const srcStart = y * width;
		for (let x = 0; x < width; x++) {
			filtered[rowStart + 1 + x] = 255 - coverage[srcStart + x];
		}
	}
	const idat = deflateSync(filtered, { level: 6 });
	const ihdr = concat(writeUint32(width), writeUint32(height), new Uint8Array([8, 0, 0, 0, 0]));
	return concat(
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", new Uint8Array(idat.buffer, idat.byteOffset, idat.byteLength)),
		pngChunk("IEND", new Uint8Array(0)),
	);
}

export function rasterizePng(ops: readonly Op[], size = 256): Uint8Array {
	return encodePng(size, size, opsToCoverage(ops, size));
}

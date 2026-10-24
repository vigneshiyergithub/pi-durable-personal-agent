import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { opsToPaths, opsToSvg, type Op, type Point } from "../../web/src/lib/elrSvg.ts";
import { STEP_DISPATCH } from "../../web/src/lib/turns.ts";

const FIXTURE_OPS: Op[] = [
	{ kind: "stroke", points: [[50, 50], [100, 100], [150, 50]], width: 8 },
	{ kind: "arc", cx: 128, cy: 200, r: 60, a0: 0, a1: Math.PI, width: 6 },
	{ kind: "stroke", points: [[200, 200], [220, 180], [240, 200]], width: 4 },
];

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function clamp(n: number, min: number, max: number): number {
	return n < min ? min : n > max ? max : n;
}

// Independent reimplementation of the server-side arc-flattening rule in src/elr/raster.ts.
function serverFlattenArc(cx: number, cy: number, r: number, a0: number, a1: number): Point[] {
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

// Build path "d" strings the same way the rasterizer does: flatten arcs, then polylines.
function serverSidePathGeometry(ops: readonly Op[]): string {
	const parts: string[] = [];
	for (const op of ops) {
		if (typeof op.width !== "number" || !Number.isFinite(op.width) || op.width <= 0) continue;
		let points: Point[] | undefined;
		if (op.kind === "stroke") {
			points = op.points.filter((p): p is Point => {
				if (!Array.isArray(p) || p.length !== 2) return false;
				const [x, y] = p;
				return Number.isFinite(x) && Number.isFinite(y);
			});
		} else if (op.kind === "arc") {
			points = serverFlattenArc(op.cx, op.cy, op.r, op.a0, op.a1);
		} else {
			continue;
		}
		if (!points || points.length === 0) continue;
		for (let i = 0; i < points.length; i++) {
			const [x, y] = points[i];
			parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
		}
		if (parts.length > 0) parts.push("|");
	}
	return parts.join(" ").replace(/ \|$/, "");
}

function extractPathDs(svg: string): string {
	const ds: string[] = [];
	const re = /<path\s+[^>]*?d="([^"]*)"[^>]*?>/g;
	let match: RegExpExecArray | null;
	while ((match = re.exec(svg)) !== null) {
		ds.push(match[1]);
	}
	return ds.join(" | ");
}

function assertNoHostileSubstrings(svg: string, label: string): void {
	assert.ok(!svg.includes("<script"), `${label}: must not contain <script`);
	assert.ok(!svg.includes("onload="), `${label}: must not contain onload=`);
	assert.ok(!svg.includes("<foreignObject"), `${label}: must not contain <foreignObject`);
	assert.ok(!/\s(href|xlink:href)\s*=/i.test(svg), `${label}: must not contain href attributes`);
}

function main(): void {
	console.log("1. Fixed ops SVG hash");
	const svg = opsToSvg(FIXTURE_OPS);
	const svgHash = sha256(svg);
	console.log(`  SVG hash: ${svgHash}`);

	console.log("2. Server-side path geometry matches web SVG path data");
	const webPathData = extractPathDs(svg);
	const serverPathData = serverSidePathGeometry(FIXTURE_OPS);
	const webPathHash = sha256(webPathData);
	const serverPathHash = sha256(serverPathData);
	console.log(`  web path hash:    ${webPathHash}`);
	console.log(`  server path hash: ${serverPathHash}`);
	assert.equal(webPathHash, serverPathHash, "web SVG path geometry must match server-side replay");
	console.log("  PASS");

	console.log("3. Determinism: two SVG renders produce identical hashes");
	const svg2 = opsToSvg(FIXTURE_OPS);
	assert.equal(sha256(svg2), svgHash, "opsToSvg must be deterministic");
	console.log("  PASS");

	console.log("4. Hostile and malformed inputs are escaped or rejected without throwing");
	const hostileCases: Op[][] = [
		[{ kind: "stroke", points: [[NaN, 10], [20, 20]], width: 4 }],
		[{ kind: "stroke", points: [[10, 10], [Infinity, 20]], width: 4 }],
		[{ kind: "stroke", points: [[1e12, 10], [20, 20]], width: 4 }],
		[{ kind: "stroke", points: [[10, 10], [20, 20]], width: NaN }],
		[
			{
				kind: "stroke",
				points: [
					[10, 10],
					['" onload="alert(1)', 20],
				],
				width: 4,
			} as unknown as Op,
			{ kind: "stroke", points: [[30, 30], [40, 40]], width: 4 },
		],
	];
	for (const ops of hostileCases) {
		let result: string;
		try {
			result = opsToSvg(ops);
		} catch (error) {
			assert.fail(`opsToSvg threw on hostile input: ${error}`);
		}
		assertNoHostileSubstrings(result, "hostile");
	}
	console.log("  PASS");

	console.log("5. Dispatch map includes canvas -> CanvasStep");
	assert.equal(STEP_DISPATCH.canvas, "CanvasStep", "STEP_DISPATCH must map canvas to CanvasStep");
	assert.ok(STEP_DISPATCH.reasoning, "STEP_DISPATCH must include reasoning");
	assert.ok(STEP_DISPATCH.tool, "STEP_DISPATCH must include tool");
	console.log("  STEP_DISPATCH.canvas =", STEP_DISPATCH.canvas);
	console.log("  PASS");

	console.log("\nAll web SVG checks passed.");
}

main();

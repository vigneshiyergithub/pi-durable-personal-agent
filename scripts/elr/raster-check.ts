import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { opsToCoverage, rasterizePng, type Op } from "../../src/elr/raster.ts";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const FIXTURE_OPS: Op[] = [
	{ kind: "stroke", points: [[50, 50], [100, 100], [150, 50]], width: 8 },
	{ kind: "arc", cx: 128, cy: 200, r: 60, a0: 0, a1: Math.PI, width: 6 },
	{ kind: "stroke", points: [[200, 200], [220, 180], [240, 200]], width: 4 },
];

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function checkPngMagicAndHeader(png: Uint8Array): void {
	assert.deepEqual(png.slice(0, 8), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "PNG signature");
	const width = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
	const height = (png[20]! << 24) | (png[21]! << 16) | (png[22]! << 8) | png[23]!;
	assert.equal(width, 256, "IHDR width");
	assert.equal(height, 256, "IHDR height");
	console.log(`  PNG signature OK, IHDR ${width}x${height}`);
}

async function runChildHash(ops: Op[]): Promise<string> {
	const tmp = join(tmpdir(), `raster-check-${randomUUID()}`);
	await mkdir(tmp, { recursive: true });
	const childPath = join(tmp, "child.ts");
	await writeFile(
		childPath,
		`import { createHash } from "node:crypto";\n` +
			`import { rasterizePng } from "${join(repoRoot, "src", "elr", "raster.ts").replace(/\\/g, "/")}";\n` +
			`const ops = ${JSON.stringify(ops)};\n` +
			`const png = rasterizePng(ops);\n` +
			`const hash = createHash("sha256").update(png).digest("hex");\n` +
			`console.log(hash);\n`,
	);
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [childPath], { cwd: repoRoot });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("close", (code) => {
			if (code !== 0) return reject(new Error(`child exited ${code}: ${err || out}`));
			resolve(out.trim());
		});
	});
}

function percentile(sorted: number[], q: number): number {
	const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
	return sorted[idx];
}

function runSelfFromTemp(): Promise<void> {
	const selfPath = fileURLToPath(import.meta.url);
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [selfPath], {
			cwd: tmpdir(),
			env: { ...process.env, RASTER_CHECK_NO_SELF_TEST: "1" },
		});
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("close", (code) => {
			if (code !== 0) return reject(new Error(`self-test from ${tmpdir()} exited ${code}: ${err || out}`));
			for (const line of out.trim().split("\n")) console.log(`    ${line}`);
			resolve();
		});
	});
}

function idatBytes(png: Uint8Array): Uint8Array {
	let offset = 8;
	while (offset < png.length) {
		const len = (png[offset]! << 24) | (png[offset + 1]! << 16) | (png[offset + 2]! << 8) | png[offset + 3]!;
		const type = String.fromCharCode(...png.slice(offset + 4, offset + 8));
		if (type === "IDAT") return png.slice(offset + 8, offset + 8 + len);
		if (type === "IEND") break;
		offset += 12 + len;
	}
	throw new Error("IDAT chunk not found");
}

async function main() {
	console.log("1. PNG magic + IHDR 256x256");
	const png1 = rasterizePng(FIXTURE_OPS);
	checkPngMagicAndHeader(png1);
	console.log("  PASS");

	console.log("2. Determinism: two in-process runs + one child process");
	const h1 = sha256(rasterizePng(FIXTURE_OPS));
	const h2 = sha256(rasterizePng(FIXTURE_OPS));
	const h3 = await runChildHash(FIXTURE_OPS);
	console.log(`  in-process #1: ${h1}`);
	console.log(`  in-process #2: ${h2}`);
	console.log(`  child process: ${h3}`);
	assert.equal(h1, h2, "in-process hashes match");
	assert.equal(h1, h3, "in-process and child hashes match");
	console.log("  PASS");

	console.log("3. Arc bounding box check");
	const arcOps: Op[] = [{ kind: "arc", cx: 128, cy: 128, r: 80, a0: 0, a1: 2 * Math.PI, width: 4 }];
	const cov = opsToCoverage(arcOps);
	const w = 256;
	const r = 80;
	const width = 4;
	const min = 128 - r - width / 2;
	const max = 128 + r + width / 2;
	const slack = 2;
	let inside = false;
	for (let y = 0; y < w; y++) {
		for (let x = 0; x < w; x++) {
			const v = cov[y * w + x]!;
			if (v === 0) continue;
			assert.ok(x >= min - slack && x <= max + slack, `ink at (${x},${y}) outside x bbox`);
			assert.ok(y >= min - slack && y <= max + slack, `ink at (${x},${y}) outside y bbox`);
			if (x >= min && x <= max && y >= min && y <= max) inside = true;
		}
	}
	assert.ok(inside, "at least one pixel inside exact bbox");
	console.log(`  exact bbox [${min.toFixed(1)},${max.toFixed(1)}] x [${min.toFixed(1)},${max.toFixed(1)}], slack ${slack}`);
	console.log("  PASS");

	console.log("4. Empty ops -> blank 256x256 PNG");
	const emptyPng = rasterizePng([]);
	checkPngMagicAndHeader(emptyPng);
	const raw = inflateSync(idatBytes(emptyPng));
	assert.equal(raw.length, 256 * 257, "decompressed size");
	let allWhite = true;
	for (let i = 0; i < raw.length; i++) {
		if (i % 257 === 0) {
			assert.equal(raw[i], 0, "filter byte 0");
		} else if (raw[i] !== 255) {
			allWhite = false;
			break;
		}
	}
	assert.ok(allWhite, "all pixels white");
	console.log("  PASS");

	console.log("5. Timing: 60 consecutive rasterizations");
	const times: number[] = [];
	for (let i = 0; i < 60; i++) {
		const start = performance.now();
		rasterizePng(FIXTURE_OPS);
		const end = performance.now();
		times.push(end - start);
	}
	times.sort((a, b) => a - b);
	const p50 = percentile(times, 0.5);
	const p95 = percentile(times, 0.95);
	console.log(`  p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);
	assert.ok(p95 < 20, `p95 ${p95.toFixed(3)} ms >= 20 ms`);
	console.log("  PASS");

	console.log("6. Location independence: full script run from a temp cwd");
	if (process.env.RASTER_CHECK_NO_SELF_TEST) {
		console.log("  (running inside self-test subprocess)");
	} else {
		await runSelfFromTemp();
		console.log("  PASS");
	}

	console.log("\nAll raster checks passed.");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function run() {
	console.log("Checking for banned native image dependencies via npm ls...");
	let npmOutput = "";
	try {
		npmOutput = execFileSync("npm", ["ls", "canvas", "skia-canvas", "sharp"], {
			encoding: "utf8",
			cwd: repoRoot,
		});
	} catch (e) {
		const err = e as { stdout?: string; stderr?: string; message?: string };
		npmOutput = err.stdout ?? "";
		if (err.stderr) npmOutput += "\n" + err.stderr;
		if (!npmOutput.trim()) npmOutput = err.message ?? "";
		// npm exits non-zero when the requested packages are absent; that is expected.
	}
	console.log(npmOutput);

	const installed = /(^|[ /])(canvas|skia-canvas|sharp)@/;
	if (installed.test(npmOutput)) {
		console.error("FAIL: a banned native image dependency is installed.");
		process.exit(1);
	}

	const rasterPath = join(repoRoot, "src", "elr", "raster.ts");
	const rasterSrc = readFileSync(rasterPath, "utf8");
	console.log(`\nGrepping ${rasterPath} for zlib / native image imports...`);
	const lines = rasterSrc.split(/\r?\n/);
	const search = /node:zlib|canvas|skia-canvas|sharp|@napi-rs/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (search.test(line)) {
			console.log(`  ${i + 1}: ${line}`);
		}
	}

	let hasNodeZlibImport = false;
	for (const line of lines) {
		if (/from\s+"node:zlib"/.test(line)) {
			hasNodeZlibImport = true;
		}
	}
	if (!hasNodeZlibImport) {
		console.error("FAIL: src/elr/raster.ts does not import node:zlib.");
		process.exit(1);
	}

	const banned = /from\s+"(canvas|skia-canvas|sharp|@napi-rs\/[^"]+)"/;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (banned.test(line)) {
			console.error(`FAIL: banned import at line ${i + 1}: ${line}`);
			process.exit(1);
		}
	}

	console.log("\nPASS: no native image dependency; PNG encoded with node:zlib");
}

run();

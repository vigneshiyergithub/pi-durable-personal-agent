// ELR M3 benchmark CLI (spec docs/elr-canvas-spec.md §7, §9 M3).
//
//   npm run bench -- --arm A|B|B1 --set T|H|X|X0|smoke --seed N [--driver auto|model|reference]
//                     [--out PATH] [--max-usd N] [--episode-timeout-ms N]
//
// Flags are validated up front and every failure prints one clear line, never a stack trace.
import { parseArgs } from "node:util";
import { BenchError, isArmId, isBenchSetId, ARM_IDS, BENCH_SET_IDS } from "../src/elr/bench/types.ts";
import { runBenchmark } from "./runner.ts";
import { readResults } from "../src/elr/bench/results.ts";
import { buildCalibrationReport, formatCalibrationReport, type SystemOneMode } from "../src/elr/bench/calibration.ts";
import { usesSystemOne } from "../src/elr/bench/arm.ts";
import { systemOneUsesRealClient } from "../src/elr/bench/system-one-run.ts";
import type { BenchDriver } from "../src/elr/bench/episode.ts";

const DRIVERS = ["auto", "model", "reference"] as const;

function fail(message: string): never {
	throw new BenchError("usage", message);
}

function parseSeed(value: string | undefined): number {
	if (value === undefined) return 0;
	if (!/^-?\d+$/.test(value)) fail(`--seed must be an integer, got "${value}"`);
	return Number(value);
}

function parsePositive(value: string | undefined, flag: string, fallback: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) fail(`${flag} must be a positive number, got "${value}"`);
	return parsed;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			arm: { type: "string" },
			set: { type: "string" },
			seed: { type: "string" },
			driver: { type: "string" },
			out: { type: "string" },
			"max-usd": { type: "string" },
			"episode-timeout-ms": { type: "string" },
			report: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
		strict: true,
		allowPositionals: false,
	});

	if (values.help) {
		console.log("usage: npm run bench -- --arm A|B|B1 --set T|H|X|X0|smoke --seed N [--driver auto|model|reference] [--report]");
		console.log("  --report  after the run, print System One accuracy and ECE per label type against the verifier");
		return;
	}
	if (values.arm === undefined) fail(`--arm is required (one of ${ARM_IDS.join(", ")})`);
	if (!isArmId(values.arm)) fail(`unknown arm "${values.arm}" (expected one of ${ARM_IDS.join(", ")})`);
	if (values.set === undefined) fail(`--set is required (one of ${BENCH_SET_IDS.join(", ")})`);
	if (!isBenchSetId(values.set)) fail(`unknown set "${values.set}" (expected one of ${BENCH_SET_IDS.join(", ")})`);
	const driver = (values.driver ?? "auto") as BenchDriver | "auto";
	if (!DRIVERS.includes(driver)) fail(`unknown driver "${values.driver}" (expected one of ${DRIVERS.join(", ")})`);

	const maxUsd = values["max-usd"] !== undefined ? parsePositive(values["max-usd"], "--max-usd", 10) : positiveEnv("BENCH_MAX_USD", 10);
	const episodeTimeoutMs = parsePositive(values["episode-timeout-ms"], "--episode-timeout-ms", 45_000);

	const summary = await runBenchmark({
		arm: values.arm,
		set: values.set,
		seed: parseSeed(values.seed),
		driver,
		maxUsd,
		episodeTimeoutMs,
		...(values.out === undefined ? {} : { resultsPath: values.out }),
	});

	if (values.report) {
		const systemOneMode: SystemOneMode = usesSystemOne(values.arm) ? (systemOneUsesRealClient() ? "real" : "stub") : "off";
		const records = await readResults(summary.resultsPath);
		for (const line of formatCalibrationReport(buildCalibrationReport(records, systemOneMode))) console.log(line);
	}
}

function positiveEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive number, got "${raw}"`);
	return parsed;
}

main().catch((error: unknown) => {
	if (error instanceof BenchError) {
		console.error(`bench: error: ${error.message}`);
		process.exitCode = 1;
		return;
	}
	throw error;
});

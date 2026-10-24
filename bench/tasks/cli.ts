// CLI for the ELR benchmark task generators (spec §9 M2; protected path, D9).
//
//   node bench/tasks/cli.ts --set T --seed 42 --out /tmp/tasks
//   node bench/tasks/cli.ts --set H --seed 7 --print-hash
//   node bench/tasks/cli.ts --configs
//   node bench/tasks/cli.ts --list
//
// `--set` accepts T, H, X, X0 or smoke (spec §7/§9). `--seed` is a number or string (default 0).
// `--out DIR` writes DIR/<set>/manifest.json, DIR/<set>/targets/<id>.png and DIR/<set>/tasks/<id>.json.
// The same (set, seed) writes byte-identical files. `--configs` prints every quirk config and its
// configHash; `--list` lists the sets, their tool, config and task counts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NAMED_CONFIGS, SET_IDS, buildTaskSet, canonicalJson, isSetId, planFor, taskRecord, type QuirkConfig, type SetId } from "./generators.ts";

type Args = { set?: string; seed: string | number; out?: string; printHash: boolean; configs: boolean; list: boolean; help: boolean };

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

function parseSeed(value: string | undefined): string | number {
	if (value === undefined) return 0;
	return /^-?\d+$/.test(value) ? Number(value) : value;
}

function parseArgs(argv: readonly string[]): Args {
	const args: Args = { seed: 0, printHash: false, configs: false, list: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--set":
				args.set = argv[++i];
				break;
			case "--seed":
				args.seed = parseSeed(argv[++i]);
				break;
			case "--out":
				args.out = argv[++i];
				break;
			case "--print-hash":
				args.printHash = true;
				break;
			case "--configs":
				args.configs = true;
				break;
			case "--list":
				args.list = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			default:
				if (arg.startsWith("--")) fail(`unknown option "${arg}"`);
				else fail(`unexpected argument "${arg}"`);
		}
	}
	return args;
}

const USAGE = `usage: node bench/tasks/cli.ts --set <T|H|X|X0|smoke> [--seed N] [--out DIR]
       node bench/tasks/cli.ts --configs
       node bench/tasks/cli.ts --list
       node bench/tasks/cli.ts --help`;

function quirksOf(config: QuirkConfig): string {
	return Object.keys(config)
		.filter((k) => k !== "tool")
		.map((k) => `${k}=${JSON.stringify((config as Record<string, unknown>)[k])}`)
		.join(" ");
}

function printConfigs(): void {
	for (const named of NAMED_CONFIGS) {
		console.log(`config=${named.name} tool=${named.tool} configHash=${named.configHash}`);
		console.log(`  quirks: ${quirksOf(named.config)}`);
	}
}

function printList(): void {
	for (const set of SET_IDS) {
		const plan = planFor(set);
		const named = NAMED_CONFIGS.find((c) => c.config === plan.config)!;
		const count = buildTaskSet(set, 0).tasks.length;
		console.log(
			`set=${set} tool=${plan.tool} config=${named.name} configHash=${named.configHash} ` +
				`replicates=${plan.replicates} tasks=${count} :: ${plan.description}`,
		);
	}
}

function writeSet(set: SetId, seed: string | number, out: string): number {
	const taskSet = buildTaskSet(set, seed);
	const setDir = join(out, set);
	const targetsDir = join(setDir, "targets");
	const tasksDir = join(setDir, "tasks");
	mkdirSync(targetsDir, { recursive: true });
	mkdirSync(tasksDir, { recursive: true });
	for (const task of taskSet.tasks) {
		writeFileSync(join(targetsDir, `${task.id}.png`), task.targetPng);
		writeFileSync(join(tasksDir, `${task.id}.json`), `${canonicalJson(taskRecord(task))}\n`);
	}
	writeFileSync(join(setDir, "manifest.json"), `${canonicalJson(taskSet.manifest)}\n`);
	return taskSet.tasks.length;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (args.configs) {
		printConfigs();
		return;
	}
	if (args.list) {
		printList();
		return;
	}
	if (!args.set) fail("--set is required (T|H|X|X0|smoke); see --help");
	if (!isSetId(args.set)) fail(`unknown set "${args.set}" (expected ${SET_IDS.join(", ")})`);

	const taskSet = buildTaskSet(args.set, args.seed);
	if (args.printHash) {
		console.log(taskSet.manifest.setHash);
		return;
	}
	if (args.out) writeSet(args.set, args.seed, args.out);

	console.log(
		`set=${taskSet.manifest.set} seed=${taskSet.manifest.seed} tool=${taskSet.manifest.tool} ` +
			`configHash=${taskSet.manifest.configHash} tasks=${taskSet.manifest.count} replicates=${taskSet.manifest.replicates}`,
	);
	for (const task of taskSet.tasks) console.log(`target ${task.id} replicate=${task.replicate} seed=${task.seed} sha256=${task.targetHash}`);
	console.log(`setHash=${taskSet.manifest.setHash}`);
}

main();

// Negative control for the ELR M2 fast-boot latency harness (scripts/health-boot-latency.ts).
//
// It proves the harness's measurement actually catches the regression the goal fixes: a reconcile
// awaited inside Agent.open() before the listener comes up. It runs the *same* harness twice — once
// in the default fast mode and once in the forced-sync mode (the single test-only
// AgentOptions.reconcileBeforeListen hook) — and reads only the harness's exit code and its raw
// `health latency:` line. No timing logic lives here.
//
// The fast boot's pre-listen work is independent of transcript size, so the default run uses the
// harness's 3,000-event transcript (tens of ms). The forced-sync run awaits the *real* reconcile,
// whose cost grows with the event count, so the control scales that run's transcript to
// HEALTH_NEGATIVE_EVENTS (default 80000, >= the 3,000-event floor). There is no artificial pause:
// the failure comes from the real reconcile work, just declared ahead of listen().
//
// It exits 0 if and only if the default run passes (exit 0, latency <= budget) AND the forced-sync
// run fails (non-zero exit, latency > budget). If the forced-sync run passes, the measurement would
// not notice the regression and the control exits non-zero with a "not caught" message — e.g. with a
// budget so large that even the forced sync fits:
//
//   node scripts/negative-control-health-boot.ts                              # catches it (exit 0)
//   HEALTH_BUDGET_MS=60000 node scripts/negative-control-health-boot.ts       # not caught (exit 1)
//   HEALTH_NEGATIVE_EVENTS=120000 node scripts/negative-control-health-boot.ts # larger sync margin
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = join(ROOT, "scripts/health-boot-latency.ts");
const BUDGET_MS = Number(process.env.HEALTH_BUDGET_MS ?? "1000");
/** The forced-sync run's transcript size. The harness default (3000) is the floor; scale it until the
 * real awaited reconcile is comfortably over the budget (here ~4.7 s at 80000 events). */
const SYNC_EVENTS = Number(process.env.HEALTH_NEGATIVE_EVENTS ?? "80000");
/** The default run's transcript size: the harness default, where fast boot is tens of ms. */
const FAST_EVENTS = 3000;

if (!Number.isFinite(BUDGET_MS) || BUDGET_MS < 0) {
	console.error(`negative-control: HEALTH_BUDGET_MS must be a non-negative number, got ${process.env.HEALTH_BUDGET_MS}`);
	process.exit(2);
}
if (!Number.isInteger(SYNC_EVENTS) || SYNC_EVENTS < FAST_EVENTS) {
	console.error(
		`negative-control: HEALTH_NEGATIVE_EVENTS must be an integer >= ${FAST_EVENTS}, got ${process.env.HEALTH_NEGATIVE_EVENTS}`,
	);
	process.exit(2);
}

type Mode = "fast" | "sync";
type Run = {
	mode: Mode;
	events: number;
	exitCode: number;
	latencyMs: number;
	output: string;
};

/** Run the single measurement implementation in one mode and parse its raw latency line. */
function runHarness(mode: Mode, events: number): Run {
	const env: NodeJS.ProcessEnv = { ...process.env, HEALTH_BOOT_MODE: mode, HEALTH_BUDGET_MS: String(BUDGET_MS), HEALTH_EVENTS: String(events) };
	const result = spawnSync(process.execPath, [HARNESS], { cwd: ROOT, env, encoding: "utf8", timeout: 180_000 });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
	const match = /health latency: (>\d+|\d+)ms/.exec(output);
	const latencyMs = match === null ? Number.POSITIVE_INFINITY : match[1]!.startsWith(">") ? Number.POSITIVE_INFINITY : Number(match[1]);
	return { mode, events, exitCode: result.status ?? 1, latencyMs, output };
}

function show(run: Run): void {
	console.log(`--- harness output: ${run.mode} mode, ${run.events} events (exit ${run.exitCode}) ---`);
	for (const line of run.output.split("\n")) console.log(`  ${line}`);
}

function label(ms: number): string {
	return ms === Number.POSITIVE_INFINITY ? ">deadline" : `${Math.round(ms)}ms`;
}

console.log(
	`negative-control: running the fast-boot harness (budget ${BUDGET_MS}ms) in fast (${FAST_EVENTS} events) and forced-sync (${SYNC_EVENTS} events) modes ...`,
);
const fast = runHarness("fast", FAST_EVENTS);
const sync = runHarness("sync", SYNC_EVENTS);
show(fast);
show(sync);

// The harness exits 0 exactly when its measured latency is <= budget; a failure is a non-zero exit
// with a latency above the budget.
const fastPassed = fast.exitCode === 0 && fast.latencyMs <= BUDGET_MS;
const syncFailed = sync.exitCode !== 0 && sync.latencyMs > BUDGET_MS;
const caught = fastPassed && syncFailed;
const margin = sync.latencyMs === Number.POSITIVE_INFINITY ? ">" : `${(sync.latencyMs / Math.max(BUDGET_MS, 1)).toFixed(1)}x`;

console.log(
	`control: default ${label(fast.latencyMs)} ${fastPassed ? "PASS" : "FAIL"}, forced-sync ${label(sync.latencyMs)} ${syncFailed ? "FAIL" : "PASS"} (margin ${margin} budget), regression caught=${caught}`,
);

if (!fastPassed) {
	console.error(
		`negative-control: the default (fast) run did not pass (exit ${fast.exitCode}, latency ${label(fast.latencyMs)} vs budget ${BUDGET_MS}ms); cannot conclude the measurement catches the regression`,
	);
	process.exit(1);
}
if (!syncFailed) {
	console.error(
		`negative-control: regression NOT caught: the forced-sync run passed (exit ${sync.exitCode}, latency ${label(sync.latencyMs)} <= budget ${BUDGET_MS}ms), so the measurement would not notice the reconcile being awaited before listen; lower HEALTH_BUDGET_MS below the forced-sync latency or raise HEALTH_NEGATIVE_EVENTS`,
	);
	process.exit(1);
}
process.exit(0);

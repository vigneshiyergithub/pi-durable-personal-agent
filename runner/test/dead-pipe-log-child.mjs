/**
 * Several log lines through the runner's log helper (imported straight from runner/task-runner.mjs — the direct-
 * execution guard keeps that import side-effect free) while the stdout pipe's reader is already gone: each call must
 * be dropped without throwing, and the process must reach this marker with exit code 0 (see runner/test/dead-pipe-log.mjs).
 */
import { log } from "../task-runner.mjs";
import { logLines } from "./log-lines.mjs";

for (const line of logLines) log(line);
log("multi", "part", "call"); // the same parts-joining as the runner's call sites, still silent
process.stderr.write(`SURVIVED: ${logLines.length + 1} log lines through a dead pipe, helper never threw, exits 0\n`);
process.exit(0);

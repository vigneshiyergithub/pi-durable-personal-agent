/**
 * A healthy run's first lines, logged through the current helper from runner/task-runner.mjs (imported with no side
 * effects), compared byte-for-byte against runner/test/fixtures/log-format.txt by runner/test/log-format.mjs.
 */
import { log } from "../task-runner.mjs";
import { logLines } from "./log-lines.mjs";

for (const line of logLines) log(line);

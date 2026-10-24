/**
 * The first lines a healthy attempt logs, as the runner's log path emits them. Shared by the pre-change capture
 * (runner/test/capture-log-format.mjs, which produced the fixture runner/test/fixtures/log-format.txt) and by the
 * current-output check (runner/test/log-format.mjs), so "normal output unchanged" is checked against the same calls.
 * Only the arguments are listed here; both scripts wrap each one in the log helper exactly like the runner does.
 */
export const logLines = [
	"task migrate-dates attempt 1 on pi/tasks-agent@agent/do-the-thing",
	"using preinstalled opencode 1.19.3",
	"cloned at 9b4cf81",
	"opencode finished (exit 0, $0.041)",
	"verify: npm ci --no-audit --no-fund",
	"proof: the log path survives a closed pipe",
	"proofs: 1/1 exit 0",
	"evidence ready: 1 commit(s), verify exit 0, proofs 1/1 exit 0, report done, bundle 9 KB",
	"evidence sent: 1 commit(s), verify exit 0",
];

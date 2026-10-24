#!/usr/bin/env bash
# The previous attempt's proof 5 (verify command + runner proofs + dependency check) failed with exit 1 and its output
# could not say which step failed: the whole chain was one opaque invocation whose captured output ended mid-build, and
# the trailing dependency check (`! git diff --quiet HEAD -- …`) compared the working tree against HEAD, so it depended
# on the tree being clean at that moment and said nothing about the base branch.
#
# This script is that proof, made attributable: every step is echoed as `STEP i/N: name`, each step's detail output
# goes to its own log, on success the step prints `ok` with exit 0 (and the tail of the output so it stays visible),
# and on failure the script prints `STEP i FAILED (exit C)` plus the failing step's tail — so a re-run says exactly
# which step failed and why, even when the evidence keeps only a few thousand bytes. The chain splits the runner
# proofs out of the install/build steps, so a slow web build can no longer be conflated with a failing check.
# The dependency check is the base-branch form: the lockfiles must be untouched versus origin/master and the
# dependencies/devDependencies entries of package.json / web/package.json must be identical to origin/master's
# (asserted on the entries, since package.json legitimately gained npm script lines and thus a file diff).
# Exits non-zero exactly when some step fails, with that step's exit code.

set -uo pipefail

LOGDIR="$(mktemp -d)"
trap 'rm -rf "$LOGDIR"' EXIT
TOTAL=10

# run_step <n> <name> <command...>: runs the step, prints its banner and outcome. The exit code is captured from the
# command itself, not after an `if` (an if with no else branch returns 0 and would clobber it).
run_step() {
	local n="$1" name="$2"; shift 2
	local log="$LOGDIR/step$n.log"
	echo "STEP $n/$TOTAL: $name"
	"$@" >"$log" 2>&1
	local code=$?
	if [ "$code" -eq 0 ]; then
		echo "STEP $n/$TOTAL ok: $name (exit 0)"
		tail -n 3 "$log" | sed 's/^/  /'
		return 0
	fi
	echo "STEP $n FAILED (exit $code): $name — last 40 lines:"
	tail -n 40 "$log" | sed 's/^/  /'
	exit "$code"
}

# ── the project's verify command, each part its own attributable step ──
run_step 1 "npm ci (root)"              npm ci --no-audit --no-fund
run_step 2 "npm ci (web)"               npm --prefix web ci --no-audit --no-fund
run_step 3 "npm run typecheck"          npm run typecheck
run_step 4 "npm run build:web"          npm run build:web
run_step 5 "smoke (no OPENROUTER key)"  env OPENROUTER_API_KEY= node --max-old-space-size=1024 scripts/smoke.ts

# ── the runner proofs, each its own step, split from the slow install/build steps ──
run_step 6 "pipe-survival (own log streams keep the blanket guard)" node runner/test/pipe-survival.mjs
run_step 7 "dead-pipe-log (log helper never throws on a dead pipe)" node runner/test/dead-pipe-log.mjs
run_step 8 "log-format (output unchanged)"                          node runner/test/log-format.mjs
run_step 9 "log-epipe + stdin-epipe + child-stdio-epipe, each with its --self-test, plus the placement check" bash -c '
	node runner/test/log-epipe.test.mjs && node runner/test/log-epipe.test.mjs --self-test &&
	node runner/test/stdin-epipe.test.mjs && node runner/test/stdin-epipe.test.mjs --self-test &&
	node runner/test/child-stdio-epipe.test.mjs &&
	bash runner/test/child-stdio-guard-placement.sh
'

run_step 10 "dependency files vs origin/master (base-branch form)" bash -c '
	set -euo pipefail
	git diff --quiet origin/master...HEAD -- package-lock.json web/package-lock.json
	echo "ok: package-lock.json and web/package-lock.json untouched versus origin/master"
	node -e "
		const { execFileSync } = require(\"node:child_process\");
		const entries = (p) => JSON.stringify({ dependencies: p.dependencies ?? {}, devDependencies: p.devDependencies ?? {} });
		for (const file of [\"package.json\", \"web/package.json\"]) {
			const base = JSON.parse(execFileSync(\"git\", [\"show\", \"origin/master:\" + file], { maxBuffer: 10 * 2 ** 20 }));
			const current = JSON.parse(require(\"node:fs\").readFileSync(file));
			if (entries(base) !== entries(current)) {
				console.error(\"FAIL: dependency entries of \" + file + \" differ from origin/master\");
				process.exit(1);
			}
			console.log(\"ok: dependency entries of \" + file + \" identical to origin/master\");
		}
	"
'

exit 0

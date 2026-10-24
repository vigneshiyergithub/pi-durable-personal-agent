#!/usr/bin/env bash
# Placement proof for the child-stdio guard, as a script file so the proof command is a single plain invocation
# (bash runner/test/child-stdio-guard-placement.sh) with no nested quoting — the inline `bash -c '…'` form with
# single-quoted greps and parentheses once failed to parse at the merge gate (exit 2, syntax error) and never ran
# the checks at all.
#
# Asserts exactly what the criterion requires, each check exiting 0 only when it holds:
#   - guardedCapture(child.stdout) count == 2 and guardedCapture(child.stderr) count == 2 in runner/task-runner.mjs,
#     i.e. both spawn paths (run() and runOpencode()) capture the child's streams through the NARROW guard, which
#     drops only the dead-pipe class and rethrows everything else;
#   - the blanket no-op guard is no longer on any child stream (guarded(child.… count == 0) — a non-dead-pipe error
#     on a captured child stream must surface, not vanish;
#   - no bare child.stdout.on("data" / child.stderr.on("data" capture left, i.e. nothing reads a child stream
#     without the guard;
#   - the blanket guard is still on the runner's OWN streams (guarded(process.stdout) / guarded(process.stderr)),
#     so a dead log pipe can never become an uncaught exception;
#   - the dead-pipe codes are defined exactly once and both narrow guards (guardedCapture and feedStdin) share the
#     isDeadPipe predicate — no second definition of the class;
#   - no relative sibling import, i.e. the runner is still a single self-contained file;
# then runs the behavioural evidence runner/test/child-stdio-epipe.test.mjs, so the placement check and the
# behaviour are in one output. Exits 0 exactly when all of it holds.

set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
runner="$here/../task-runner.mjs"

expect_count() {
	needle="$1"
	expected="$2"
	actual="$(grep -cF -- "$needle" "$runner" || true)"
	if [ "$actual" -ne "$expected" ]; then
		echo "FAIL: expected $expected occurrence(s) of $needle in runner/task-runner.mjs, found $actual" >&2
		exit 1
	fi
	echo "ok: $needle x $actual"
}

expect_count 'guardedCapture(child.stdout)' 2
expect_count 'guardedCapture(child.stderr)' 2
expect_count 'guarded(child.stdout)' 0
expect_count 'guarded(child.stderr)' 0
expect_count 'child.stdout.on("data"' 0
expect_count 'child.stderr.on("data"' 0
expect_count 'guarded(process.stdout)' 1
expect_count 'guarded(process.stderr)' 1
expect_count 'function isDeadPipe' 1
expect_count '"EPIPE"' 1
expect_count '"ECONNRESET"' 1
expect_count '"ERR_STREAM_DESTROYED"' 1
expect_count '"ERR_STREAM_WRITE_AFTER_END"' 1
expect_count '!isDeadPipe(error)) throw error' 3

if grep -qE 'from "\.[^"]*"' "$runner"; then
	echo "FAIL: runner/task-runner.mjs has a relative sibling import, so it is no longer self-contained" >&2
	exit 1
fi
echo "ok: no relative sibling import (single self-contained file)"

node "$here/child-stdio-epipe.test.mjs"

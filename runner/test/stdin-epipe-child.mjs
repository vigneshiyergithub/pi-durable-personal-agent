/**
 * The child both halves of runner/test/stdin-epipe.test.mjs spawn. One file on purpose: the same three stdin writes,
 * the same grandchild shapes, the same marker and exit path, so the only variable across the two cases is the writer:
 *
 *   UNGUARDED=1   the bare `stdin.end(input)` the runner had before the guard — no 'error' listener, no
 *                 writable/destroyed check, no try/catch. The incident's exact shape.
 *   otherwise     the runner's own stdin-write path, imported straight from runner/task-runner.mjs — not a copy.
 *
 * Sequence, in every case:
 *   1. alive        spawn a `cat` the way the runner's run() does (stdio pipes), feed it, and check the input is
 *                   received verbatim — the alive case must keep its behaviour: same input written.
 *   2. exited       spawn a sleeper, SIGKILL it, wait for its close, then feed its stdin.
 *   3. reader-gone  spawn a shell that has already closed its end of the stdin pipe (fd 0 → /dev/null) and sleeps,
 *                   then feed its stdin — this is the uncaught `write EPIPE` the guard suppresses (observed on this
 *                   Node: a write after the child is reaped is silently no-opped, so the raw EPIPE comes from the
 *                   closed reader, exactly like the closed log pipe of the incident).
 * A pause before the marker gives every asynchronous stream error its chance to kill the process; the unguarded
 * writer dies inside it, so it never prints the marker.
 */
import { spawn } from "node:child_process";

const feed = process.env.UNGUARDED === "1" ? (stdin, input) => stdin.end(input ?? "") : (await import("../task-runner.mjs")).feedStdin;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const closeOf = (child) => new Promise((resolve) => child.on("close", resolve));

// 1. alive: the input must still reach a live child, verbatim.
const alive = spawn("cat", [], { stdio: ["pipe", "pipe", "pipe"] });
let echoed = "";
alive.stdout.on("data", (d) => (echoed += d));
feed(alive.stdin, "ping-alive");
await closeOf(alive);
if (echoed !== "ping-alive") {
	process.stderr.write(`ALIVE-FAIL: cat received ${JSON.stringify(echoed)}\n`);
	process.exit(1);
}
process.stderr.write("ALIVE-OK: the live child received the input verbatim\n");

// 2. the child is already gone (SIGKILL, reaped): the write must not kill the writer.
const exited = spawn("sleep", ["30"], { stdio: ["pipe", "pipe", "pipe"] });
exited.kill("SIGKILL");
await closeOf(exited);
feed(exited.stdin, "too late");

// 3. the reader hung up while the child lives on: the asynchronous EPIPE case.
const readerGone = spawn("sh", ["-c", "exec 0</dev/null; echo ready; exec sleep 5"], { stdio: ["pipe", "pipe", "pipe"] });
readerGone.stdout.resume();
await new Promise((resolve) => readerGone.stdout.once("data", resolve));
feed(readerGone.stdin, "into the void");
await pause(150); // an asynchronous stream error fires within a tick or two; let it kill the writer if it can
readerGone.kill("SIGKILL");

process.stderr.write("SURVIVED: three stdin writes (alive, exited child, gone reader) and reached the final marker\n");
process.exit(0);

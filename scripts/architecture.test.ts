import assert from "node:assert/strict";
import { it } from "node:test";
// @ts-expect-error Single-file JavaScript runner ships without TypeScript declarations.
import { attemptBudgets, captureTail, createOpencodeParser } from "../runner/task-runner.mjs";
import { partitionLegacyJobs } from "../src/agui.ts";

it("parses a long OpenCode stream without losing early cost/session or retaining tool output", () => {
 const parser = createOpencodeParser(1024);
 parser.push('{"sessionID":"session-1","type":"step_finish","part":{"cost":0.25}}\n');
 for (let i = 0; i < 10000; i++) parser.push('{"type":"tool","part":{"text":"large irrelevant output"}}\n');
 parser.push('x'.repeat(2048)); // oversized event split across chunks must be discarded through its newline
 parser.push('\n{"type":"text","part":{"text":"final report"}}\n');
 parser.push('{"type":"step_finish","part":{"cost":0.75}}');
 const result = parser.finish();
 assert.equal(result.sessionId, "session-1");
 assert.equal(result.cost, 1);
 assert.equal(result.text, "final report\n");
 assert.equal(captureTail("x".repeat(10000), "last", 128).length, 128);
 assert.ok(captureTail("x".repeat(10000), "last", 128).endsWith("last"));
});

it("uses a single end-to-end deadline and reserves verification time after setup", () => {
 assert.deepEqual(attemptBudgets(1000, 40, 61000), { deadline: 2401000, codingMs: 2040000 });
 assert.equal(attemptBudgets(1000, 40, 2401001).codingMs, 0);
 assert.equal(attemptBudgets(0, 4, 0).codingMs, 180000);
});

it("separates legacy scheduled job turns including their tools/results from owner history", () => {
 const owner = { id: "o", role: "user", content: "My request" };
 const reply = { id: "a", role: "assistant", content: "Owner reply" };
 const job = { id: "j", role: "user", content: "[job job-123] Check goals" };
 const tool = { id: "t", role: "tool", content: "status" };
 const outcome = { id: "r", role: "assistant", content: "NO_REPLY" };
 const next = { id: "n", role: "user", content: "Next request" };
 assert.deepEqual(partitionLegacyJobs([{ id: "partial", role: "assistant", content: "unattributed partial turn" }, owner, reply, job, tool, outcome, next]), { owner: [owner, reply, next], jobs: [job, tool, outcome] });
});

it("receives incremental bundles with validated prerequisites and still supports legacy full bundles", async () => {
 const { mkdtemp, mkdir, writeFile, stat, rm } = await import("node:fs/promises");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { execFile } = await import("node:child_process");
 const { promisify } = await import("node:util");
 const { randomBytes } = await import("node:crypto");
 const { receiveBundle } = await import("../src/sandbox.ts");
 const root = await mkdtemp(join(tmpdir(), "incremental-bundle-"));
 const work = join(root, "work"), receiver = join(root, "receiver");
 await mkdir(work); await mkdir(receiver);
 const run = (cwd: string) => (...args: string[]) => promisify(execFile)("git", args, { cwd });
 const git = run(work), receive = run(receiver);
 try {
  await git("init", "--quiet", "--initial-branch=main");
  await git("config", "user.name", "Test"); await git("config", "user.email", "test@example.invalid");
  await writeFile(join(work,"history.bin"), randomBytes(256*1024));
  await git("add", "."); await git("commit", "--quiet", "-m", "base");
  const base = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(join(work,"change.txt"), "tested change");
  await git("add", "."); await git("commit", "--quiet", "-m", "change");
  const head = (await git("rev-parse", "HEAD")).stdout.trim();
  const incremental = join(root,"incremental.bundle"), full = join(root,"full.bundle");
  await git("bundle", "create", incremental, "HEAD", `^${base}`);
  await git("bundle", "create", full, "HEAD");
  assert.ok((await stat(incremental)).size < (await stat(full)).size / 10);
  await receive("init", "--quiet", "--bare", "repo.git");
  await assert.rejects(receiveBundle(receive, incremental, "agent/change", work), /prerequisite|commits/i);
  assert.equal(await receiveBundle(receive, incremental, "agent/change", work, base, head), head);
  await assert.rejects(receiveBundle(receive, incremental, "agent/mismatch", work, base, "b".repeat(40)), /verified commit/);
  assert.equal((await receive("--git-dir","repo.git","show","agent/change:change.txt")).stdout, "tested change");
  await assert.rejects(receive("--git-dir","repo.git","show-ref","--verify","refs/heads/main"));
  await assert.rejects(receiveBundle(receive, incremental, "main", work, base), /only agent/);
  await assert.rejects(receiveBundle(receive, incremental, "agent/change", work, "../other"), /invalid bundle/);
  assert.equal(await receiveBundle(receive, full, "agent/legacy", work), head);
 } finally { await rm(root,{recursive:true,force:true}); }
});

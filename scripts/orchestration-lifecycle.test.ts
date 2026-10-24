import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Evidence, Goal, OrchestraClients } from "../src/orchestra.ts";

it("durable lifecycle: cleanup retries, physical capacity, evidence replay, outages and thread isolation", async () => {
 process.env.DATA_DIR = await mkdtemp(join(tmpdir(), "agent-lifecycle-"));
 process.env.OPENROUTER_API_KEY = "unused";
 const { Agent } = await import("../src/agent.ts");
 const { Orchestrator, budgetedAttempts } = await import("../src/orchestra.ts");
 const { Jobs, HostState } = await import("../src/state.ts");
 const { config } = await import("../src/config.ts");
 const agent = await Agent.open();
 const admissions: Array<{ thread: typeof agent.root.id; content: string }> = [];
 agent.submit = (async (conversation, content, requestId) => { admissions.push({ thread: conversation.id, content }); return { id: requestId, wait: async () => ({ status: "done" }) } as never; });
 let beforeCreated: (() => Promise<void>) | undefined;
 let launchFails = false;
 let launched = 0, pushFails = false, pushes = 0, destroyFails = false, keyFails = false;
 const vars = new Map<string, Record<string, string>>();
 const services = new Set<string>(), deletedKeys: string[] = [];
 const clients: OrchestraClients = {
  missingSetup: async () => [],
  railway: {
   launch: async (_name, variables, _command, onCreated) => { const serviceId = `service-${++launched}`; services.add(serviceId); vars.set(serviceId, variables); await beforeCreated?.(); await onCreated?.(serviceId); if (launchFails) throw new Error("invalid image fixture"); return { serviceId, deploymentId: `deploy-${launched}` }; },
   destroy: async (id) => { if (destroyFails) throw new Error("temporary delete failure"); services.delete(id); },
   logs: async () => "", list: async () => [...services].map((id) => ({ id, name: id })),
  },
  github: { ...agent.orchestrator["clients"].github, org: async () => "fixture-org", token: async () => "read-token", pushBundle: async () => { pushes++; if (pushFails) throw new Error("GitHub unavailable"); return "a".repeat(40); } } as OrchestraClients["github"],
  keys: { create: async () => ({ hash: `key-${launched + 1}`, key: "model-key" }), delete: async (hash) => { if (keyFails) throw new Error("temporary key deletion failure"); deletedKeys.push(hash); } },
 };
 agent.orchestrator.useClients(clients);
 const o = agent.orchestrator;
 const goal = async (title: string) => {
  const g = await o.createGoal({ projectId: "fixture", title, description: "fixture", acceptance: ["works"] }, `create:${title}`);
  await o.proposePlan(g.id, [{ title, instructions: "fixture", acceptance: ["works"] }]);
  await o.approve(g.id);
  return g.id;
 };
 await o["mutate"]((s) => { s.projects.push({ id: "fixture", repo: "fixture-org/app", base: "main", merge: "owner", description: "fixture", createdAt: new Date().toISOString() }); });
 const getGoal = async (id: string): Promise<Goal> => (await o.state()).goals.find((g) => g.id === id)!;
 const payload: Evidence = { commits: ["a change"], diff: "", diffStat: "", diffTruncated: false, durationMs: 5, bundle: "ZmFrZQ==" };
 try {
  const { ensureReportJob, CEO_REPORT_JOB } = await import("../src/office.ts");
  const { reconcileReports, restoreJob } = await import("../src/schedule-policy.ts");
  await agent.root.commit(async (tx) => {
   const doc = await tx.doc(Jobs, agent.root.id);
   doc.jobs.push({ id: "custom-report", prompt: "Write today's report with save_report", everyMinutes: 1440, nextRunAt: new Date().toISOString(), createdBy: "user" });
   reconcileReports(doc);
  }, context);
  assert.equal((await agent.harness.snapshot(Jobs, agent.root.id, context))!.archived?.length, 1, "archived duplicates must survive a durable commit");
  await agent.root.commit(async (tx) => restoreJob(await tx.doc(Jobs, agent.root.id), CEO_REPORT_JOB), context);
  assert.ok((await agent.harness.snapshot(Jobs, agent.root.id, context))!.jobs.some((j) => j.id === CEO_REPORT_JOB && j.purpose === "general"), "restore survives a durable commit");
  await agent.root.commit(async (tx) => {
   const doc = await tx.doc(Jobs, agent.root.id);
   doc.jobs = doc.jobs.filter((j) => j.id !== CEO_REPORT_JOB);
   doc.archived = [];
   delete doc.archiveVersion;
  }, context);
  await agent.root.commit((tx) => ensureReportJob(tx, agent.root.id), context);
  const repaired = await agent.harness.snapshot(Jobs, agent.root.id, context);
  assert.match(repaired!.archived![0]!.reason, /Recovered default/);
  assert.equal(repaired!.jobs.length, 1, "repair keeps the custom report as the only active schedule");
  await agent.root.commit((tx) => ensureReportJob(tx, agent.root.id), context);
  assert.equal((await agent.harness.snapshot(Jobs, agent.root.id, context))!.archived!.length, 1, "repair is idempotent");
  await agent.root.commit(async (tx) => { (await tx.doc(Jobs, agent.root.id)).jobs = [{ id: "ceo-daily-report", prompt: "Write today's CEO report with save_report", everyMinutes: 1440, nextRunAt: new Date().toISOString(), createdBy: "agent" }]; }, context);

  await agent.root.commit(async (tx) => {
   const doc = await tx.doc(Jobs, agent.root.id);
   assert.ok(doc.jobs.some((j) => j.id === CEO_REPORT_JOB));
   doc.jobs = doc.jobs.filter((j) => j.id !== CEO_REPORT_JOB);
  }, context);
  await agent.root.commit((tx) => ensureReportJob(tx, agent.root.id), context);
  assert.ok(!(await agent.harness.snapshot(Jobs, agent.root.id, context))!.jobs.some((j) => j.id === CEO_REPORT_JOB), "cancelled seed stays cancelled on boot reconciliation");
  const invalid = await o.createGoal({ projectId: "fixture", title: "Invalid plan", description: "fixture", acceptance: ["works"] }, "create:invalid");
  const rejected = await o.proposePlan(invalid.id, [
   { title: "Same deliverable", instructions: "fixture", acceptance: ["works"] },
   { title: "same deliverable!", instructions: "fixture", acceptance: ["works"] },
  ]);
  assert.match(rejected, /not approved or queued/);
  assert.equal((await getGoal(invalid.id)).status, "planning");
  assert.equal((await getGoal(invalid.id)).approval, undefined);
  await assert.rejects(o.approve(invalid.id), /not awaiting approval/);
  await o.cancel(invalid.id, "fixture");
  const guarded = await goal("Preflight launch guard");
  await o["mutate"]((s) => { s.goals.find((g) => g.id === guarded)!.tasks[0]!.estimatedDiffChars = config.reviewDiffChars + 1; });
  const launchesBeforeGuard = launched;
  await o.dispatch();
  assert.equal(launched, launchesBeforeGuard, "preflight blocks before spending on a container");
  assert.equal((await getGoal(guarded)).tasks[0]!.attempts.length, 0);
  assert.equal((await getGoal(guarded)).status, "blocked");
  await o.cancel(guarded, "fixture");
  assert.notEqual(agent.jobs.id, agent.root.id);
  assert.equal((await agent.thread("jobs")).id, agent.jobs.id);
  await assert.rejects(agent.thread(String(agent.reflector.id)), /unknown thread/);

  const jobTools = (await agent.jobs.agent(context)).tools;
  for (const allowed of ["create_goal", "save_report", "goal_status", "message_foreman"]) assert.ok(jobTools.some((tool) => tool.name === allowed), `Jobs keeps ${allowed}`);
  for (const forbidden of ["approve_plan", "set_project_verify", "create_project", "retire_goal", "veto_merge"]) assert.ok(!jobTools.some((tool) => tool.name === forbidden), `Jobs cannot ${forbidden}`);
  const jobApi = { conversationId: agent.jobs.id, taskId: 123456, commit: (fn: never) => agent.root.commit(fn, context), snapshot: (...args: never[]) => (agent.harness.snapshot as Function)(...args) };
  await jobTools.find((tool) => tool.name === "create_goal")!.execute({ projectId: "fixture", title: "Scheduled goal", description: "Authorized scheduled work", acceptance: ["works"] } as never, jobApi as never, context);
  const scheduled = (await o.state()).goals.find((g) => g.title === "Scheduled goal")!;
  assert.ok(scheduled, "scheduled jobs can still create goals");
  await o.proposePlan(scheduled.id, [{ title: "Scheduled task", instructions: "fixture", acceptance: ["works"] }]);
  const ownerTools = (await agent.root.agent(context)).tools;
  await assert.rejects(ownerTools.find((tool) => tool.name === "approve_plan")!.execute({ goalId: scheduled.id, code: (await getGoal(scheduled.id)).approval!.code } as never, jobApi as never, context), /only the owner/);
  await jobTools.find((tool) => tool.name === "save_report")!.execute({ title: "Scheduled daily report", markdown: "Report fixture" } as never, jobApi as never, context);
  const { Reports } = await import("../src/office.ts");
  assert.equal((await agent.harness.snapshot(Reports, agent.root.id, context))!.reports[0]!.title, "Scheduled daily report");
  await o.cancel(scheduled.id, "fixture");
  const savedJobsId = agent.jobs.id;
  const first = await goal("First");
  const second = await goal("Second");
  const third = await goal("Third");
  await o.dispatch();
  assert.equal(launched, 2);
  const a = (await getGoal(first)).tasks[0]!.attempts[0]!;
  const token = vars.get(a.sandbox!.serviceId!)!.TASK_TOKEN!;
  const before = pushes;
  await o.runnerEvidence((await getGoal(first)).tasks[0]!.id, a.n, token, payload);
  let current = (await getGoal(first)).tasks[0]!.attempts[0]!;
  assert.ok(current.pendingEvidence);
  const acceptedAt = current.finishedAt;
  assert.equal(current.evidence, undefined);
  assert.equal(pushes, before, "acknowledgement does not wait on GitHub");
  assert.ok((await readFile(join(config.dataDir, "evidence", current.pendingEvidence.file))).length);
  await o.runnerEvidence((await getGoal(first)).tasks[0]!.id, a.n, token, payload);
  await assert.rejects(o.runnerEvidence((await getGoal(first)).tasks[0]!.id, a.n, token, { ...payload, durationMs: 6 }), /conflicting/);
  destroyFails = true; keyFails = true;
  await o.safetyTick();
  await o.dispatch();
  assert.equal(launched, 2, "completed workers with failed teardown still occupy capacity");
  pushFails = true;
  await o.processEvidence();
  current = (await getGoal(first)).tasks[0]!.attempts[0]!;
  assert.ok(current.pendingEvidence?.retryAfter, "artifact delivery backs off instead of recoding");
  assert.equal(current.evidence, undefined);
  assert.equal((await getGoal(first)).tasks[0]!.attempts.length, 1);
  pushFails = false;
  destroyFails = false;
  keyFails = true;
  await o.safetyTick();
  current = (await getGoal(first)).tasks[0]!.attempts[0]!;
  assert.equal(current.sandbox?.serviceDestroyed, true);
  assert.equal(current.sandbox?.cleaned, false);
  keyFails = false;
  await o.safetyTick();
  assert.equal((await getGoal(first)).tasks[0]!.attempts[0]!.sandbox?.cleaned, true);
  assert.ok(deletedKeys.includes(a.sandbox!.keyHash!));
  // A fresh orchestrator has no in-memory queue, and still recovers the artifact from the durable document.
  const recovered = new Orchestrator(agent, clients);
  await recovered["mutate"]((s) => { delete s.goals.find((g) => g.id === first)!.tasks[0]!.attempts[0]!.pendingEvidence!.retryAfter; });
  await recovered.processEvidence();
  current = (await getGoal(first)).tasks[0]!.attempts[0]!;
  assert.equal(current.pendingEvidence, undefined);
  assert.equal(current.evidence?.pushed, "a".repeat(40));
  assert.equal(current.finishedAt, acceptedAt, "delivery latency must not inflate observed container runtime");
  await o.cancel(first, "fixture");
  await o.cancel(second, "fixture");
  await o.dispatch();
  assert.equal(launched, 3);
  const t = (await getGoal(third)).tasks[0]!;
  const live = t.attempts.at(-1)!;
  const providerEvidence = { ...payload, bundle: undefined, commits: [], coderUnavailable: "quota exhausted" };
  await o.runnerEvidence(t.id, live.n, vars.get(live.sandbox!.serviceId!)!.TASK_TOKEN!, providerEvidence);
  await o.processEvidence();
  await o.safetyTick();
  const unavailable = (await getGoal(third)).tasks[0]!;
  assert.equal(unavailable.attempts.length, 1, "failed provider execution remains attributable");
  assert.equal(budgetedAttempts(unavailable), 0);
  assert.equal(unavailable.attempts[0]!.sandbox?.cleaned, true);
  assert.ok((await o.state()).launchCooldownUntil! > Date.now());
  await o.cancel(third, "fixture");
  // A pause can win before Railway returns a newly created resource; it must remain tracked for cleanup.
  await o["mutate"]((s) => { s.launchCooldownUntil = 0; });
  const racing = await goal("Pause before registration");
  beforeCreated = async () => { await o.pause(racing, "fixture race"); };
  await o.dispatch();
  beforeCreated = undefined;
  const paused = (await getGoal(racing)).tasks[0]!.attempts.at(-1)!;
  assert.equal(paused.sandbox?.cleaned, true);
  assert.equal(services.has(paused.sandbox!.serviceId!), false);
  assert.equal(budgetedAttempts((await getGoal(racing)).tasks[0]!), 0);
  await o.cancel(racing, "fixture");
  const broken = await goal("Repeated deployment error");
  launchFails = true;
  for (let i = 0; i < 3; i++) {
   await o["mutate"]((s) => { s.launchCooldownUntil = 0; delete s.goals.find((g) => g.id === broken)!.tasks[0]!.retryAfter; });
   await o.dispatch();
  }
  assert.equal((await getGoal(broken)).status, "blocked");
  assert.equal((await getGoal(broken)).tasks[0]!.status, "escalated");
  assert.equal((await getGoal(broken)).tasks[0]!.attempts.length, 3);
  assert.equal(budgetedAttempts((await getGoal(broken)).tasks[0]!), 0);
  launchFails = false;
  await o.retry(broken, (await getGoal(broken)).tasks[0]!.id, "configuration fixed");
  await o.dispatch();
  assert.equal((await getGoal(broken)).tasks[0]!.attempts.at(-1)!.n, 4);
  await o.cancel(broken, "fixture");
  // Recurring project watches do not invoke models on unchanged state; reminders always do.
  const fingerprint = await agent.orchestraFingerprint();
  const originalRevision = process.env.RAILWAY_GIT_COMMIT_SHA;
  process.env.RAILWAY_GIT_COMMIT_SHA = "new-deployment-fixture";
  assert.notEqual(await agent.orchestraFingerprint(), fingerprint, "deployments wake project watches");
  if (originalRevision === undefined) delete process.env.RAILWAY_GIT_COMMIT_SHA;
  else process.env.RAILWAY_GIT_COMMIT_SHA = originalRevision;
  await agent.root.commit(async (tx) => { (await tx.doc(Jobs, agent.root.id)).jobs = [
   { id: "watch", prompt: "watch projects", everyMinutes: 5, nextRunAt: new Date(0).toISOString(), createdBy: "user", runOnChange: true, lastFingerprint: fingerprint },
   { id: "reminder", prompt: "time reminder", everyMinutes: 5, nextRunAt: new Date(0).toISOString(), createdBy: "user" },
  ]; }, context);
  const count = admissions.length;
  await agent["fireDueJobs"]();
  assert.equal(admissions.length, count + 1);
  assert.equal(admissions.at(-1)!.thread, savedJobsId);
  assert.match(admissions.at(-1)!.content, /time reminder/);
  assert.equal((await agent.harness.snapshot(Jobs, agent.root.id, context))!.jobs.find((j) => j.id === "watch")!.skippedRuns, 1);
  assert.equal((await agent.harness.snapshot(HostState, agent.root.id, context))!.jobsId, savedJobsId);
  // Reflection is long-running work; it must never hold the scheduling tick open.
  const originalReflect = agent.maybeReflect;
  agent.maybeReflect = async () => new Promise<string | undefined>(() => {});
  await Promise.race([agent.tick(), new Promise((_, reject) => setTimeout(() => reject(new Error("tick blocked on reflection")), 300))]);
  agent.maybeReflect = originalReflect;
  await new Promise((resolve) => setImmediate(resolve));
 } finally { await agent.close(); }
});

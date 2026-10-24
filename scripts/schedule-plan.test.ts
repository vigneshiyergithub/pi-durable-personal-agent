import assert from "node:assert/strict";
import { it } from "node:test";
import { reconcileReports, restoreJob } from "../src/schedule-policy.ts";
import { checkPlan, planErrors } from "../src/plan-preflight.ts";
import type { Job, JobsState } from "../src/state.ts";
const report = (id: string): Job => ({ id, prompt: "Write today's report and save it with save_report", everyMinutes: 1440, nextRunAt: "2030-01-01T00:00:00.000Z", createdBy: "agent" });
it("daily report dedupe preserves latest custom instructions and timing, with reversible archive", () => {
 const custom = { ...report("custom-new"), prompt: "Write today's report and save it with save_report. Why, impact and decisions." };
 const doc: JobsState = { jobs: [report("custom-old"), custom, report("ceo-daily-report"), { ...report("blog"), prompt: "Daily blog post" }] };
 reconcileReports(doc);
 assert.deepEqual(doc.jobs, [custom, { ...report("blog"), prompt: "Daily blog post" }]);
 assert.equal(doc.archived?.length, 2);
 assert.equal(doc.reportSeeded, true);
 reconcileReports(doc);
 assert.equal(doc.archived?.length, 2);
 restoreJob(doc, "custom-old");
 reconcileReports(doc);
 assert.equal(doc.jobs.length, 3);
 assert.equal(doc.jobs.at(-1)?.purpose, "general");
 assert.throws(() => restoreJob(doc, "missing"), /no archived/);
});
it("explicit separate reports and non-daily schedules are preserved", () => {
 const doc: JobsState = { jobs: [{ ...report("separate"), purpose: "general" }, { ...report("weekly"), everyMinutes: 10080 }] };
 reconcileReports(doc);
 assert.equal(doc.jobs.length, 2);
 assert.equal(doc.archived, undefined);
});
const task = (title: string, extra = {}) => ({ title, instructions: "Implement and verify this outcome", acceptance: ["npm test exits 0"], ...extra });
it("preflight rejects duplicate deliverables, missing/forward dependencies and over-budget plans", () => {
 assert.match(planErrors(checkPlan([], 100)), /at least one/);
 assert.match(planErrors(checkPlan([task("Implement API"), task("implement api!")], 100)), /Duplicate unfinished/);
 assert.match(planErrors(checkPlan([task("A", { key: "a", dependsOn: ["b"] }), task("B", { key: "b", dependsOn: ["a"] })], 100)), /must precede/);
 assert.match(planErrors(checkPlan([task("A", { dependsOn: ["missing"] })], 100)), /Missing dependency/);
 assert.match(planErrors(checkPlan([task("A", { key: "a" }), task("B", { key: "a" })], 100)), /Duplicate task key/);
 assert.match(planErrors(checkPlan([task("A", { estimatedDiffChars: 60 }), task("B", { estimatedDiffChars: 41 })], 100)), /exceeds/);
 assert.match(planErrors(checkPlan([task("A", { estimatedDiffChars: NaN })], 100)), /integer/);
 assert.match(planErrors(checkPlan([task("A", { acceptance: [" "] })], 100)), /non-empty/);
});
it("preflight accepts ordered prerequisites and exact budget; uncertainty stays advisory", () => {
 const check = checkPlan([task("Survey", { key: "survey", estimatedDiffChars: 0 }), task("Implement", { dependsOn: ["survey"], estimatedDiffChars: 100 })], 100);
 assert.equal(planErrors(check), "");
 assert.equal(check.estimatedDiffChars, 100);
 const uncertain = checkPlan([task("A", { acceptance: ["works"] })], 100);
 assert.equal(planErrors(uncertain), "");
 assert.equal(uncertain.issues.filter((i) => i.severity === "warning").length, 2);
 assert.equal(planErrors(checkPlan([task("A", { status: "accepted" }), task("A")], 100)), "", "corrective work may revisit accepted tasks");
});

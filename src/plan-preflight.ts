export type PlannedTask = {
 title: string; instructions: string; acceptance: string[];
 key?: string; dependsOn?: string[]; estimatedDiffChars?: number;
};
export type PlanCheck = { at: string; budget: number; estimatedDiffChars: number; issues: Array<{ severity: "error" | "warning"; task: number; message: string }> };
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Deterministic admission checks. Semantic uncertainty is advisory, never a guessed veto. */
export function checkPlan(tasks: Array<PlannedTask & { id?: string; status?: string }>, budget: number): PlanCheck {
 const issues: PlanCheck["issues"] = [];
 const add = (severity: "error" | "warning", task: number, message: string) => issues.push({ severity, task, message });
 if (!tasks.length) add("error", 0, "A plan needs at least one task.");
 const keys = new Map<string, number>();
 tasks.forEach((task, i) => {
  if (task.id) {
   if (keys.has(task.id)) add("error", i + 1, `Task ID collides with another task key: ${task.id}`);
   else keys.set(task.id, i);
  }
  if (task.key) {
   if (keys.has(task.key)) add("error", i + 1, `Duplicate task key: ${task.key}`);
   else keys.set(task.key, i);
  }
 });
 const titles = new Set<string>();
 let estimatedDiffChars = 0;
 tasks.forEach((task, i) => {
  if (task.status === "cancelled") return;
  const n = i + 1;
  if (!task.title.trim() || !task.instructions.trim() || !task.acceptance.length || task.acceptance.some((a) => !a.trim())) add("error", n, "Title, instructions and non-empty acceptance criteria are required.");
  // Completed work can legitimately be revisited in a later corrective task.
  if (task.status !== "accepted") {
   const title = normalize(task.title);
   if (titles.has(title)) add("error", n, "Duplicate unfinished deliverable title; combine it or describe the distinct outcome.");
   titles.add(title);
  }
  for (const dependency of task.dependsOn ?? []) {
   const index = keys.get(dependency);
   if (index === undefined) add("error", n, `Missing dependency: ${dependency}`);
   else if (index >= i) add("error", n, `Dependency ${dependency} must precede this task (self references and cycles are invalid).`);
   else if (tasks[index]!.status === "cancelled") add("error", n, `Dependency ${dependency} was cancelled.`);
  }
  if (task.estimatedDiffChars !== undefined) {
   if (!Number.isSafeInteger(task.estimatedDiffChars) || task.estimatedDiffChars < 0) add("error", n, "Diff estimate must be a non-negative integer.");
   else estimatedDiffChars += task.estimatedDiffChars;
  } else if (task.status !== "accepted") add("warning", n, "Diff scope is unestimated; include implementation, tests and documentation.");
  if (task.acceptance.some((a) => /^(?:works?|done|correct|passes?|looks? good)[.!\s]*$/i.test(a.trim()))) add("warning", n, "Acceptance is vague; name observable evidence or a command and expected result.");
 });
 if (estimatedDiffChars > budget) add("error", 0, `Declared cumulative diff ${estimatedDiffChars} exceeds the ${budget}-character review budget. Re-scope the goal; keep tests with their implementation.`);
 return { at: new Date().toISOString(), budget, estimatedDiffChars, issues };
}
export const planErrors = (check: PlanCheck): string => check.issues.filter((i) => i.severity === "error").map((i) => `${i.task ? `Task ${i.task}: ` : ""}${i.message}`).join("\n");

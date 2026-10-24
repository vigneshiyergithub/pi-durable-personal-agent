import type { Job, JobsState } from "./state.ts";

/** Conservative compatibility for the existing daily CEO report schedules. */
export function isDailyReport(job: Job): boolean {
 if (job.purpose) return job.purpose === "daily-report";
 return job.id === "ceo-daily-report" || (job.everyMinutes === 1440 && /\bsave_report\b/i.test(job.prompt) && /\b(?:today['’]s|daily|CEO)\s+(?:CEO\s+)?report\b/i.test(job.prompt));
}

/** Creation order is durable. Prefer the newest custom instructions over the boot seed. */
export function reconcileReports(doc: JobsState, at = new Date().toISOString()): void {
 const reports = doc.jobs.filter(isDailyReport);
 if (!reports.length) return;
 doc.reportSeeded = true;
 const keep = reports.filter((j) => j.id !== "ceo-daily-report").at(-1) ?? reports.at(-1)!;
 const remove = new Set(reports.filter((j) => j.id !== keep.id).map((j) => j.id));
 const duplicates = doc.jobs.filter((j) => remove.has(j.id));
 if (duplicates.length) doc.archived = [...(doc.archived ?? []), ...duplicates.map((job) => ({ job: JSON.parse(JSON.stringify(job)), at, reason: `Replaced by daily report ${keep.id}` }))];
 doc.jobs = doc.jobs.filter((j) => !remove.has(j.id));
}

/** Restores as an explicitly separate schedule so reconciliation cannot archive it again. */
export function restoreJob(doc: JobsState, id: string, at = Date.now()): void {
 const index = doc.archived?.findIndex((entry) => entry.job.id === id) ?? -1;
 if (index < 0) throw new Error("no archived job");
 const entry = doc.archived![index]!;
 if (doc.jobs.some((job) => job.id === id)) throw new Error("job is already scheduled");
 const job = JSON.parse(JSON.stringify(entry.job)) as Job;
 job.purpose = "general";
 delete job.lastFingerprint;
 if (Date.parse(job.nextRunAt) < at) job.nextRunAt = new Date(at + (job.everyMinutes ?? 10) * 60_000).toISOString();
 doc.jobs.push(job);
 doc.archived!.splice(index, 1);
}

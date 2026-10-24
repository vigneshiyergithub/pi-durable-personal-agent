// Scheduled jobs run as ordinary turns in the transcript: a "[job …]" prompt, then the agent's work and its answer.
// Most runs end in NO_REPLY (nothing worth telling the owner). The chat shows only runs that produced an outcome;
// every run, silent or not, is listed under Jobs.

import type { Job } from "./api.ts"
import type { Step, Turn } from "./turns.ts"

const NO_REPLY = /^\s*NO_REPLY\s*\.?\s*$/

export type JobRun = {
  kind: "job_run"
  id: string
  jobId: string
  prompt: string
  steps: Step[]
  /** The agent's last text, unless it was NO_REPLY. */
  reply?: string
  /** True once the run has an answer and that answer was NO_REPLY (or nothing at all). */
  silent: boolean
}

/** The first sentence of a job prompt, as its name: "Crash-loop monitor for the agent container". */
export function jobTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0]
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line
  return sentence.replace(/[.:]$/, "").trim()
}

/** Folds each job turn and the agent turn that answered it into one JobRun; other turns pass through unchanged. */
export function foldJobRuns(turns: readonly Turn[], live = false): Array<Turn | JobRun> {
  const out: Array<Turn | JobRun> = []
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]
    if (turn.kind !== "job") {
      out.push(turn)
      continue
    }
    const next = turns[i + 1]
    const steps = next?.kind === "agent" ? next.steps : []
    if (next?.kind === "agent") i++
    const last = [...steps].reverse().find((s) => s.kind === "text")
    const lastText = last?.kind === "text" ? last.text.trim() : ""
    // The newest run may still be streaming; it is not silent until it has finished.
    const finished = !(live && i >= turns.length - 1)
    out.push({
      kind: "job_run",
      id: turn.id,
      jobId: turn.jobId,
      prompt: turn.text,
      steps,
      reply: lastText && !NO_REPLY.test(lastText) ? lastText : undefined,
      silent: finished && (!lastText || NO_REPLY.test(lastText)),
    })
  }
  return out
}

export const isJobRun = (item: Turn | JobRun): item is JobRun => item.kind === "job_run"

/** Every run per job id, newest first. */
export function runsByJob(runs: readonly JobRun[]): Map<string, JobRun[]> {
  const byJob = new Map<string, JobRun[]>()
  for (const run of [...runs].reverse()) byJob.set(run.jobId, [...(byJob.get(run.jobId) ?? []), run])
  return byJob
}

/** "every 10m", "every 1.5h", "every day". */
export function cadence(job: Job): string | undefined {
  const m = job.everyMinutes
  if (!m) return undefined
  if (m % 1440 === 0) return m === 1440 ? "every day" : `every ${m / 1440} days`
  return m >= 60 ? `every ${+(m / 60).toFixed(1)}h` : `every ${m}m`
}

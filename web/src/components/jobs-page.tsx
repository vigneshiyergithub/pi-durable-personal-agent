import * as React from "react"
import { useAgent } from "@copilotkit/react-core/v2"
import { AlarmClockIcon, ChevronDownIcon } from "lucide-react"
import { toast } from "sonner"

import { api, type Job, type Status } from "@/lib/api"
import { cadence, foldJobRuns, isJobRun, type JobRun, jobTitle, runsByJob } from "@/lib/jobs"
import { draftForOwner } from "@/lib/owner-thread"
import { fromNow } from "@/lib/time"
import { type AguiMessage, toTurns } from "@/lib/turns"
import { cn } from "@/lib/utils"
import { ShowMore } from "@/components/board"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

const RUNS_PREVIEW = 5
const overdue = (iso: string) => Date.parse(iso) < Date.now() - 60_000
const setBy = (job: Job) => (job.createdBy === "user" ? "you" : `the ${job.createdBy}`)

function whenLine(job: Job) {
  return overdue(job.nextRunAt) ? `Overdue · was due ${fromNow(job.nextRunAt)}` : `Next ${fromNow(job.nextRunAt)}`
}

/** Every scheduled run lives in the "jobs" thread; this reads it (live while a run streams) and folds it into runs. */
function useJobRuns() {
  const { agent } = useAgent({ agentId: "jobs" })
  const [history, setHistory] = React.useState<AguiMessage[]>([])
  React.useEffect(() => {
    let active = true
    const refresh = () => api<{ messages: AguiMessage[] }>("/api/messages?thread=jobs").then((data) => { if (active) setHistory(data.messages) }).catch(() => {})
    void refresh()
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh() }, 15_000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const messages = (agent.isRunning ? agent.messages : history) as unknown as AguiMessage[]
  return React.useMemo(() => foldJobRuns(toTurns(messages), agent.isRunning).filter(isJobRun), [messages, agent.isRunning])
}

export function JobsPage({
  status,
  selected,
  onSelect,
  onChanged,
  onAsk,
}: {
  status: Status | undefined
  selected?: string
  onSelect: (id: string) => void
  onChanged: () => void
  onAsk: () => void
}) {
  const runs = useJobRuns()
  const byJob = React.useMemo(() => runsByJob(runs), [runs])
  const jobs = React.useMemo(() => [...(status?.jobs ?? [])].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)), [status])
  const job = jobs.find((j) => j.id === selected) ?? jobs[0]
  const repeating = jobs.filter((j) => j.everyMinutes).length
  const archived = status?.archivedJobs ?? []

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
      <section aria-label="Jobs" className="flex shrink-0 flex-col gap-3.5 border-b p-4 sm:p-6 lg:w-[420px] lg:overflow-y-auto lg:border-r lg:border-b-0">
        <div className="flex flex-col">
          <h1 className="text-[22px] font-semibold">Jobs</h1>
          <span className="text-muted-foreground">
            {status ? `${repeating} repeating${jobs.length - repeating ? ` · ${jobs.length - repeating} one-time` : ""} · quiet unless something changes` : "Loading…"}
          </span>
        </div>
        {!status ? (
          <Skeleton className="h-40 w-full rounded-xl" />
        ) : jobs.length === 0 ? (
          <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
            <AlarmClockIcon className="size-4" />
            Nothing scheduled. Try “remind me tomorrow at 9am to call mum” in the general thread.
          </div>
        ) : (
          jobs.map((j) => {
            const jobRuns = byJob.get(j.id) ?? []
            const told = jobRuns.filter((r) => r.reply).length
            const every = cadence(j)
            return (
              <button
                key={j.id}
                type="button"
                onClick={() => onSelect(j.id)}
                aria-current={j.id === job?.id || undefined}
                className={cn(
                  "flex flex-col gap-1 rounded-xl border px-3.5 py-3 text-left",
                  j.id === job?.id ? "border-ring bg-raised" : "border-transparent hover:bg-card",
                )}
              >
                <span className="line-clamp-2 text-[13px] font-semibold">{jobTitle(j.prompt)}</span>
                <span className={cn("text-xs text-muted-foreground", overdue(j.nextRunAt) && "text-tone-amber")}>
                  {[whenLine(j), every ?? "once", jobRuns.length ? `${jobRuns.length} recent runs` : "", told ? `told you ${told}×` : ""].filter(Boolean).join(" · ")}
                </span>
              </button>
            )
          })
        )}
        {archived.length > 0 && (
          <Collapsible className="mt-2 flex flex-col gap-2">
            <CollapsibleTrigger className="group flex items-center gap-1.5 self-start text-xs font-semibold text-muted-foreground hover:text-foreground">
              <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-aria-expanded:rotate-0" />
              Archived schedules · {archived.length}
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-2">
              {archived.map(({ job: a, reason }) => (
                <ArchivedJob key={a.id} job={a} reason={reason} onChanged={onChanged} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>
      {job && <JobDetail key={job.id} job={job} runs={byJob.get(job.id) ?? []} onChanged={onChanged} onAsk={onAsk} />}
    </div>
  )
}

function JobDetail({ job, runs, onChanged, onAsk }: { job: Job; runs: JobRun[]; onChanged: () => void; onAsk: () => void }) {
  const [saving, setSaving] = React.useState(false)
  const [allRuns, setAllRuns] = React.useState(false)
  const title = jobTitle(job.prompt)
  const facts: Array<[string, string]> = [
    ["Schedule", cadence(job)?.replace(/^every/, "Every") ?? "Once"],
    [overdue(job.nextRunAt) ? "Was due" : "Next run", `${fromNow(job.nextRunAt)} · ${new Date(job.nextRunAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`],
    ["Recent runs", String(runs.length)],
    ["Set up by", setBy(job)],
  ]
  if (job.runOnChange) facts.push(["Skipped, unchanged", String(job.skippedRuns ?? 0)])

  async function watch(enabled: boolean) {
    setSaving(true)
    try {
      await api(`/api/jobs/${job.id}/watch`, { method: "POST", body: JSON.stringify({ enabled }) })
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="Job detail" className="flex min-w-0 flex-1 flex-col gap-5 p-4 sm:px-8 sm:py-6 lg:overflow-y-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex max-w-[640px] flex-col gap-1">
          <h2 className="text-[19px] font-semibold">{title}</h2>
          <span className="text-muted-foreground">{whenLine(job)}</span>
        </div>
        <button
          type="button"
          onClick={() => { draftForOwner(`About the job "${title}" (${job.id}): `); onAsk() }}
          className="h-10 rounded-[10px] border border-border-strong px-3.5 text-[13px] hover:bg-accent"
        >
          Change it in chat
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-3">
        {facts.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-0.5 rounded-xl border px-3.5 py-3">
            <span className="text-xs text-muted-foreground">{k}</span>
            <span className="font-semibold">{v}</span>
          </div>
        ))}
      </div>
      {job.everyMinutes && (
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5" title="For checks of this agent’s goals and tasks. Leave off for reminders and external checks.">
          <input type="checkbox" checked={Boolean(job.runOnChange)} disabled={saving} onChange={(e) => void watch(e.target.checked)} className="size-4 accent-foreground" />
          <span>Only run when project state changes</span>
          {saving && <Spinner className="size-3.5" />}
        </label>
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-muted-foreground">Recent runs</h3>
        {runs.length === 0 ? (
          <span className="text-[13px] text-subtle">Runs will appear here.</span>
        ) : (
          (allRuns ? runs : runs.slice(0, RUNS_PREVIEW)).map((run) => <RunRow key={run.id} run={run} />)
        )}
        {runs.length > RUNS_PREVIEW && (
          <ShowMore expanded={allRuns} hidden={runs.length - RUNS_PREVIEW} onToggle={() => setAllRuns((v) => !v)} />
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[13px] font-semibold text-muted-foreground">Prompt</h3>
        <div className="rounded-[10px] border px-3.5 py-3 font-mono text-xs break-words whitespace-pre-wrap text-soft">{job.prompt}</div>
      </section>
    </section>
  )
}

function RunRow({ run }: { run: JobRun }) {
  const tools = run.steps.filter((s) => s.kind === "tool")
  const names = [...new Set(tools.map((s) => (s.kind === "tool" ? s.name : "")))].join(", ")
  const meta = tools.length ? `${tools.length} tool call${tools.length === 1 ? "" : "s"}${names ? ` · ${names}` : ""}` : ""
  return (
    <Collapsible className="rounded-[10px] bg-card text-[13px]">
      <CollapsibleTrigger disabled={!run.reply} className="group flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left">
        <span className="min-w-0 flex-1">
          {run.reply ? <span className="text-tone-green">Told you</span> : run.silent ? "No update needed" : <span className="inline-flex items-center gap-1.5"><Spinner className="size-3" /> Running</span>}
        </span>
        <span className="truncate font-mono text-xs text-muted-foreground">{meta}</span>
        {run.reply && <ChevronDownIcon className="size-3.5 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />}
      </CollapsibleTrigger>
      {run.reply && <CollapsibleContent className="border-t px-3 py-2.5 break-words whitespace-pre-wrap">{run.reply}</CollapsibleContent>}
    </Collapsible>
  )
}

function ArchivedJob({ job, reason, onChanged }: { job: Job; reason: string; onChanged: () => void }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-[13px]">
      <span className="font-medium">{jobTitle(job.prompt)}</span>
      <span className="text-xs text-muted-foreground">{reason}</span>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Original prompt</summary>
        <p className="mt-1 font-mono whitespace-pre-wrap">{job.prompt}</p>
      </details>
      <button
        type="button"
        className="h-8 self-start rounded-lg border border-border-strong px-3 text-xs hover:bg-accent"
        onClick={async () => {
          try {
            await api(`/api/jobs/${job.id}/restore`, { method: "POST" })
            onChanged()
            toast.success("Restored as a separate schedule")
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error))
          }
        }}
      >
        Restore separate schedule
      </button>
    </div>
  )
}

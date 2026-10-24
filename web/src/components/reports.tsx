import * as React from "react"
import { ChevronDownIcon, FileTextIcon } from "lucide-react"

import { api } from "@/lib/api"
import { type Report, type Role } from "@/lib/office"
import { type OrchestraState } from "@/lib/orchestra"
import { type ScoreBoard, type Scorecards } from "@/lib/scorecards"
import { fromNow } from "@/lib/time"
import { Markdown } from "@/components/markdown"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

// Insights → Reports: the agent's daily CEO reports, the last week in numbers, and who plays which role.

const WEEK_MS = 7 * 24 * 3_600_000
const percent = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`)
const reportDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-2xl border p-3">
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  )
}

// One row per model: its value for the window, or "—" when there is nothing to divide by.
function ModelRows({ rows }: { rows: Array<[string, string]> }) {
  if (rows.length === 0) return <span className="text-sm text-muted-foreground">—</span>
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map(([model, value]) => (
        <li key={model} className="flex items-baseline justify-between gap-3">
          <span className="truncate font-mono text-xs text-muted-foreground">{model}</span>
          <span className="font-medium tabular-nums">{value}</span>
        </li>
      ))}
    </ul>
  )
}

function LastWeek({ orchestra, scorecards }: { orchestra: OrchestraState; scorecards: Scorecards | undefined }) {
  const since = Date.now() - WEEK_MS
  const recent = (iso: string) => Date.parse(iso) >= since
  const events = orchestra.events.filter((e) => recent(e.at))
  const incidents = orchestra.incidents ?? []

  // A goal's updatedAt is the closest we have to when it finished.
  const done = orchestra.goals.filter((g) => g.status === "done" && recent(g.updatedAt)).length
  const merges = events.filter((e) => e.text.includes("is merged") || e.text.includes("was merged by you")).length
  const vetoes = events.filter((e) => e.text.includes("vetoed")).length
  const rollbacks = incidents.filter((i) => i.kind === "p0" && i.rollbackUrl && recent(i.at)).length
  const openIncidents = incidents.filter((i) => i.status === "open").length

  const week: ScoreBoard | undefined = scorecards?.windows["7d"].total
  const acceptance: Array<[string, string]> = Object.entries(week?.coder ?? {}).map(([model, s]) => [
    model,
    percent(s.firstAttemptAcceptance),
  ])
  const approvals: Array<[string, string]> = Object.entries(week?.reviewer ?? {}).map(([model, r]) => [model, String(r.approvals)])

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="goals done" value={done} />
        <Stat label="merges" value={merges} />
        <Stat label="vetoes" value={vetoes} />
        <Stat label="rollbacks" value={rollbacks} />
        <Stat label="open incidents" value={openIncidents} />
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Coder first-attempt acceptance</CardTitle>
            <CardDescription>Last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ModelRows rows={acceptance} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Reviewer approvals</CardTitle>
            <CardDescription>Last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ModelRows rows={approvals} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

// A table does not fit a 380px column, so each role is a stacked card: name and model first, the job second.
function Team({ roles }: { roles: Role[] }) {
  if (roles.length === 0) return <p className="text-sm text-muted-foreground">No roles listed yet.</p>
  return (
    <ul className="flex flex-col gap-2">
      {roles.map((role) => (
        <li key={role.role} className="flex min-w-0 flex-col gap-1 rounded-2xl border p-3">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-sm font-medium capitalize">{role.role}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{role.model}</span>
          </div>
          <p className="text-xs break-words text-muted-foreground">{role.does}</p>
        </li>
      ))}
    </ul>
  )
}

function Reports({ reports }: { reports: Report[] }) {
  if (reports.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileTextIcon />
          </EmptyMedia>
          <EmptyTitle>No report yet.</EmptyTitle>
          <EmptyDescription>The agent writes one daily.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const [latest, ...older] = reports
  return (
    <div className="flex flex-col gap-3">
      <Collapsible defaultOpen className="flex min-w-0 flex-col rounded-2xl border">
        <CollapsibleTrigger className="group flex min-w-0 items-start gap-2 px-4 py-3 text-left">
          <ChevronDownIcon className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform -rotate-90 group-aria-expanded:rotate-0" />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium break-words">{latest.title}</span>
            <span className="text-xs text-muted-foreground" title={new Date(latest.at).toLocaleString()}>
              {reportDate(latest.at)} · {fromNow(latest.at)}
            </span>
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t px-4 py-3 text-sm">
          <Markdown>{latest.markdown}</Markdown>
        </CollapsibleContent>
      </Collapsible>
      {older.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-[13px] font-semibold text-muted-foreground">Earlier · {older.length}</h3>
            {older.map((report) => (
              <Collapsible key={report.id} className="rounded-2xl border">
                <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left text-sm">
                  <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform -rotate-90 group-aria-expanded:rotate-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">{report.title}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{reportDate(report.at)}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="border-t px-4 py-3 text-sm">
                  <Markdown>{report.markdown}</Markdown>
                </CollapsibleContent>
              </Collapsible>
            ))}
        </section>
      )}
    </div>
  )
}

type Loaded = { scorecards?: Scorecards; reports?: Report[]; roles?: Role[]; error?: string }

export function ReportsPage({ orchestra }: { orchestra: OrchestraState | undefined }) {
  const [data, setData] = React.useState<Loaded>({})
  React.useEffect(() => {
    let active = true
    const load = async () => {
      const [scorecards, reports, roles] = await Promise.allSettled([
        api<Scorecards>("/api/scorecards"),
        api<{ reports: Report[] }>("/api/reports").then((r) => r.reports),
        api<{ roles: Role[] }>("/api/roles").then((r) => r.roles),
      ])
      if (!active) return
      setData((prev) => ({
        scorecards: scorecards.status === "fulfilled" ? scorecards.value : prev.scorecards,
        reports: reports.status === "fulfilled" ? reports.value : prev.reports,
        roles: roles.status === "fulfilled" ? roles.value : prev.roles,
        error: reports.status === "rejected" ? String(reports.reason instanceof Error ? reports.reason.message : reports.reason) : undefined,
      }))
    }
    void load()
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), 60_000)
    return () => { active = false; clearInterval(timer) }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">CEO reports</h2>
        {data.reports ? <Reports reports={data.reports} /> : data.error ? <p className="text-sm text-tone-red">{data.error}</p> : <Skeleton className="h-32 w-full" />}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Last 7 days</h2>
        {orchestra ? <LastWeek orchestra={orchestra} scorecards={data.scorecards} /> : <Skeleton className="h-40 w-full" />}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">The team</h2>
        {data.roles ? <Team roles={data.roles} /> : <Skeleton className="h-24 w-full" />}
      </section>
    </div>
  )
}

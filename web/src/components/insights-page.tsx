import type { OrchestraState } from "@/lib/orchestra"
import { type InsightsView, INSIGHTS_VIEWS } from "@/lib/route"
import { failed } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import { LabPanel } from "@/components/lab-panel"
import { type MonitorView, MONITOR_VIEWS, TelemetryMeta, TelemetryPage, useTelemetry } from "@/components/monitor"
import { ReportsPage } from "@/components/reports"
import { ScorecardsPanel } from "@/components/scorecards-panel"

const LABELS: Record<InsightsView, string> = {
  overview: "Overview",
  activity: "Activity",
  cost: "Spend",
  coding: "Coding model",
  models: "Models & tools",
  reflector: "Reflector",
  containers: "Containers",
  scores: "Coders",
  reports: "Reports",
  lab: "Lab",
}

const isTelemetry = (view: InsightsView): view is MonitorView => (MONITOR_VIEWS as readonly string[]).includes(view)

// Insights: how the agent is doing. Health, activity and spend come from /api/telemetry; Coders is the scorecards,
// Reports the daily CEO reports, Lab the benchmark runs.
export function InsightsPage({ view, onView, orchestra }: { view: InsightsView; onView: (view: InsightsView) => void; orchestra: OrchestraState | undefined }) {
  const { data, error, loading, load } = useTelemetry()
  const meta: Partial<Record<InsightsView, { text: string; bad?: boolean }>> = {}
  if (data) {
    const fails = data.activity.filter(failed).length
    if (fails) meta.activity = { text: `${fails} fail${fails === 1 ? "" : "s"}`, bad: true }
    if (data.spend.capUsd > 0) meta.cost = { text: `${Math.round((data.spend.totalUsd / data.spend.capUsd) * 100)}%` }
    const live = data.containers.filter((c) => c.state !== "removed").length
    if (live) meta.containers = { text: String(live) }
    if (data.passes.length) meta.reflector = { text: String(data.passes.length) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label="Insights sections"
        className="no-scrollbar flex shrink-0 gap-1 overflow-x-auto border-b px-4 py-2 lg:w-[220px] lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:px-3 lg:py-6"
      >
        {INSIGHTS_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            aria-current={view === v ? "page" : undefined}
            onClick={() => onView(v)}
            className={cn(
              "flex h-[38px] shrink-0 items-center justify-between gap-3 rounded-lg px-3 text-left whitespace-nowrap",
              view === v ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {LABELS[v]}
            {meta[v] && <span className={cn("hidden text-xs lg:inline", meta[v]!.bad ? "text-tone-red" : "text-subtle")}>{meta[v]!.text}</span>}
          </button>
        ))}
      </nav>
      <section className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-[18px] p-4 sm:px-8 sm:py-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="text-[22px] font-semibold">{LABELS[view]}</h1>
            {isTelemetry(view) && <TelemetryMeta data={data} loading={loading} onRefresh={load} />}
          </div>
          {isTelemetry(view) ? (
            <TelemetryPage view={view} data={data} error={error} go={onView} />
          ) : view === "scores" ? (
            <ScorecardsPanel orchestra={orchestra} />
          ) : view === "reports" ? (
            <ReportsPage orchestra={orchestra} />
          ) : (
            <LabPanel />
          )}
        </div>
      </section>
    </div>
  )
}

import * as React from "react"
import { CopilotKitProvider, HttpAgent, useAgent } from "@copilotkit/react-core/v2"
import { ThemeProvider } from "next-themes"

import { toast } from "sonner"

import { api, type AuthState, type Status, Unauthorized } from "@/lib/api"
import { boardColumns, isClosed } from "@/lib/board"
import { jobTitle } from "@/lib/jobs"
import { needsOwner, type OrchestraState } from "@/lib/orchestra"
import { type InsightsView, type Page, type Route, useRoute } from "@/lib/route"
import { fromNow } from "@/lib/time"
import { cn } from "@/lib/utils"
import { AgentOrb } from "@/components/agent-orb"
import { ArtifactsPanel } from "@/components/artifacts-panel"
import { Board } from "@/components/board"
import { CommandPalette, type PaletteItem } from "@/components/command-palette"
import { GoalDrawer } from "@/components/goal-drawer"
import { InsightsPage } from "@/components/insights-page"
import { JobsPage } from "@/components/jobs-page"
import { Login } from "@/components/login"
import { MemoryPage } from "@/components/memory-page"
import { SettingsPage } from "@/components/settings-page"
import { Spinner } from "@/components/ui/spinner"
import { Toaster } from "@/components/ui/sonner"

export default function App() {
  const [auth, setAuth] = React.useState<AuthState>()
  const check = React.useCallback(() => {
    api<AuthState>("/api/auth/state")
      .then(setAuth)
      .catch(() => setAuth({ enrolled: true, authenticated: false, bootstrap: false }))
  }, [])
  React.useEffect(check, [check])

  const signOut = React.useCallback(() => {
    try { sessionStorage.removeItem("agent-draft:owner"); sessionStorage.removeItem("agent-draft:jobs") } catch { /* Storage is optional. */ }
    void api("/api/auth/logout", { method: "POST" }).finally(check)
  }, [check])

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
      {!auth ? (
        <div className="flex min-h-dvh items-center justify-center bg-background">
          <Spinner />
        </div>
      ) : auth.authenticated ? (
        <Workspace onSignOut={signOut} onSessionLost={check} />
      ) : (
        <Login state={auth} onSignedIn={check} />
      )}
      <Toaster position="top-center" />
    </ThemeProvider>
  )
}

function Workspace({ onSignOut, onSessionLost }: { onSignOut: () => void; onSessionLost: () => void }) {
  // CopilotKit talks AG-UI straight to the agent's /api/agui endpoint; the session cookie authenticates it.
  const agent = React.useMemo(() => new HttpAgent({ url: "/api/agui", threadId: "owner" }), [])
  const jobs = React.useMemo(() => new HttpAgent({ url: "/api/agui", threadId: "jobs" }), [])
  const agents = React.useMemo(() => ({ default: agent, jobs }), [agent, jobs])

  return (
    <CopilotKitProvider selfManagedAgents={agents} agentId="default">
      <Shell onSignOut={onSignOut} onSessionLost={onSessionLost} />
    </CopilotKitProvider>
  )
}

const NAV: Array<{ page: Page; label: string }> = [
  { page: "board", label: "Board" },
  { page: "jobs", label: "Jobs" },
  { page: "memory", label: "Memory" },
  { page: "artifacts", label: "Artifacts" },
  { page: "insights", label: "Insights" },
  { page: "settings", label: "Settings" },
]

const INSIGHTS_PALETTE: Array<[InsightsView, string]> = [
  ["overview", "Overview"],
  ["activity", "Activity"],
  ["cost", "Spend"],
  ["coding", "Coding model"],
  ["scores", "Coders"],
  ["reflector", "Reflector"],
  ["containers", "Containers"],
  ["reports", "Reports"],
  ["lab", "Lab"],
]

const chip = "inline-flex h-7 items-center rounded-full px-2.5 text-xs whitespace-nowrap"

function Shell({ onSignOut, onSessionLost }: { onSignOut: () => void; onSessionLost: () => void }) {
  const { agent } = useAgent({ agentId: "default" })
  const [status, setStatus] = React.useState<Status>()
  const [route, go] = useRoute()
  const [palette, setPalette] = React.useState(false)

  // Back to sign-in only when the session is rejected twice in a row, so one stray response never logs you out.
  const rejected = React.useRef(0)
  const loadStatus = React.useCallback(() => {
    api<Status>("/api/status")
      .then((next) => {
        rejected.current = 0
        setStatus(next)
      })
      .catch((error) => {
        if (!(error instanceof Unauthorized)) return
        if (++rejected.current >= 2) onSessionLost()
        else setTimeout(loadStatus, 2_000)
      })
  }, [onSessionLost])

  React.useEffect(() => {
    loadStatus()
    const timer = setInterval(() => document.visibilityState === "visible" && loadStatus(), 20_000)
    return () => clearInterval(timer)
  }, [loadStatus])

  // Goals move while you watch: poll the orchestrator and toast what happened since the last look.
  const [orchestra, setOrchestra] = React.useState<OrchestraState>()
  const seen = React.useRef<string | undefined>(undefined)
  const loadOrchestra = React.useCallback(() => {
    api<OrchestraState>("/api/orchestra")
      .then((next) => {
        const fresh = seen.current === undefined ? [] : next.events.filter((e) => e.at > seen.current!)
        for (const event of fresh.slice(-3)) toast(event.text.split("\n")[0], { description: event.text.split("\n").slice(1).join("\n") || undefined })
        seen.current = next.events.at(-1)?.at ?? seen.current ?? ""
        setOrchestra(next)
      })
      .catch(() => {})
  }, [])
  React.useEffect(() => {
    loadOrchestra()
    const timer = setInterval(() => document.visibilityState === "visible" && loadOrchestra(), 8_000)
    return () => clearInterval(timer)
  }, [loadOrchestra])
  const refreshAll = React.useCallback(() => {
    loadStatus()
    loadOrchestra()
  }, [loadStatus, loadOrchestra])

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        setPalette((open) => !open)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const running = agent.isRunning
  const needing = React.useMemo(
    () => (orchestra?.goals ?? []).filter(needsOwner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [orchestra],
  )
  const openGoal = React.useCallback((id: string) => go({ page: "board", goal: id }), [go])
  const openGeneral = React.useCallback(() => go({ page: "board", goal: "general" }), [go])
  const nextJob = React.useMemo(() => [...(status?.jobs ?? [])].sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0], [status])

  const paletteItems = React.useMemo<PaletteItem[]>(() => {
    const columns = boardColumns(orchestra)
    const goal = (kind: string) => (g: OrchestraState["goals"][number]) => ({ id: `goal-${g.id}`, label: g.title, kind, run: () => openGoal(g.id) })
    const page = (label: string, target: Route, kind = "Page") => ({ id: `page-${label}`, label, kind, run: () => go(target) })
    return [
      ...columns.needs.map(goal("Needs you")),
      ...columns.planning.map(goal("Planning")),
      ...columns.building.map(goal("Building")),
      { id: "general", label: "General thread", kind: "Thread", run: openGeneral },
      { id: "new", label: "New goal", kind: "Action", run: () => openGoal("new") },
      page("Board", { page: "board" }),
      page("Jobs", { page: "jobs" }),
      ...(status?.jobs ?? []).map((j) => ({ id: `job-${j.id}`, label: jobTitle(j.prompt), kind: "Job", run: () => go({ page: "jobs", job: j.id }) })),
      page("Memory", { page: "memory" }),
      page("Artifacts", { page: "artifacts" }),
      ...INSIGHTS_PALETTE.map(([view, label]) => page(label, { page: "insights", view }, "Insights")),
      page("Settings", { page: "settings" }),
      ...columns.shipped.map(goal("Shipped")),
      ...(orchestra?.goals ?? []).filter((g) => isClosed(g) && !columns.shipped.includes(g)).map(goal("Closed")),
    ]
  }, [orchestra, status, go, openGoal, openGeneral])

  const health = running
    ? { label: "Working", className: "bg-tone-blue-soft text-tone-blue", dot: "animate-pulse" }
    : status?.pauseAll
      ? { label: "Maintenance", className: "bg-tone-amber-soft text-tone-amber", dot: "" }
      : status
        ? { label: "Healthy", className: "bg-tone-green-soft text-tone-green", dot: "" }
        : { label: "Connecting", className: "bg-secondary text-muted-foreground", dot: "animate-pulse" }

  return (
    <div className="flex h-dvh flex-col bg-background text-[14px] text-foreground">
      <header className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 border-b bg-surface px-4 py-3 sm:px-6">
        <button type="button" onClick={() => go({ page: "board" })} className="flex items-center gap-2.5">
          <AgentOrb size={28} active={running} />
          <span className="font-semibold">Personal agent</span>
        </button>
        <nav aria-label="Sections" className="order-last flex w-full gap-1 overflow-x-auto no-scrollbar md:order-none md:w-auto">
          {NAV.map((n) => (
            <button
              key={n.page}
              type="button"
              aria-current={route.page === n.page ? "page" : undefined}
              onClick={() => go(n.page === "insights" ? { page: "insights", view: "overview" } : ({ page: n.page } as Route))}
              className={cn(
                "flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3",
                route.page === n.page ? "bg-secondary font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {n.label}
              {n.page === "board" && needing.length > 0 && (
                <span aria-label={`${needing.length} need you`} className="rounded-full bg-attention px-1.5 text-[11px] font-semibold text-[#0B0B0C]">
                  {needing.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="hidden h-9 items-center gap-5 rounded-lg border border-input bg-card px-3 text-[13px] text-muted-foreground hover:text-foreground sm:flex"
        >
          Search or jump <span className="font-mono text-[11px]">⌘K</span>
        </button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => go({ page: "insights", view: "overview" })} className={cn(chip, health.className)}>
            <span className={cn("mr-1.5 size-1.5 rounded-full bg-current", health.dot)} />
            {health.label}
          </button>
          {status && (
            <button type="button" onClick={() => go({ page: "insights", view: "cost" })} className={cn(chip, "hidden bg-secondary text-soft sm:inline-flex", status.spendUsd >= status.maxSpendUsd * 0.8 && "text-tone-amber")}>
              ${status.spendUsd.toFixed(2)} of ${status.maxSpendUsd}
            </button>
          )}
          {nextJob && (
            <button type="button" onClick={() => go({ page: "jobs", job: nextJob.id })} className={cn(chip, "hidden bg-secondary text-soft lg:inline-flex")}>
              Next job {fromNow(nextJob.nextRunAt)}
            </button>
          )}
        </div>
      </header>
      {status?.pauseAll && (
        <div role="status" className="shrink-0 border-b border-attention/30 bg-tone-amber-soft px-4 py-2 text-xs text-tone-amber sm:px-6">
          <span className="font-semibold">Paused for maintenance.</span> Goals, coding containers, scheduled jobs and reflection
          are on hold; chat still works. Everything paused resumes where it left off when maintenance ends.
        </div>
      )}
      <main className="min-h-0 flex-1">
        {route.page === "board" ? (
          <Board
            state={orchestra}
            selected={route.goal}
            onOpen={openGoal}
            drawer={
              route.goal && (
                <GoalDrawer
                  id={route.goal}
                  state={orchestra}
                  needing={needing}
                  onClose={() => go({ page: "board" })}
                  onOpen={openGoal}
                  onChanged={refreshAll}
                  onRunSettled={refreshAll}
                />
              )
            }
          />
        ) : route.page === "jobs" ? (
          <JobsPage status={status} selected={route.job} onSelect={(job) => go({ page: "jobs", job })} onChanged={refreshAll} onAsk={openGeneral} />
        ) : route.page === "memory" ? (
          <MemoryPage status={status} onAsk={openGeneral} />
        ) : route.page === "artifacts" ? (
          <div className="h-full overflow-y-auto">
            <section aria-label="Artifacts" className="mx-auto flex w-full max-w-[960px] flex-col gap-[18px] p-4 sm:px-8 sm:py-6">
              <div className="flex flex-col">
                <h1 className="text-[22px] font-semibold">Artifacts</h1>
                <span className="text-muted-foreground">Everything the agent has made: canvas, blog, reports and more</span>
              </div>
              <ArtifactsPanel />
            </section>
          </div>
        ) : route.page === "insights" ? (
          <InsightsPage view={route.view} onView={(view) => go({ page: "insights", view })} orchestra={orchestra} />
        ) : (
          <SettingsPage status={status} orchestra={orchestra} onChanged={refreshAll} onSignOut={onSignOut} onSignedOut={onSessionLost} />
        )}
      </main>
      <CommandPalette open={palette} items={paletteItems} onClose={() => setPalette(false)} />
    </div>
  )
}

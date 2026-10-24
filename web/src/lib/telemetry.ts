// Numeric resource observations mirror src/runner-resources.ts.
export const RESOURCE_PHASES = ["toolchain", "clone", "coding", "report-recovery", "verification", "proofs", "packaging"] as const
export type ResourcePhase = (typeof RESOURCE_PHASES)[number]
export type RunnerPhaseResources = {
  name: ResourcePhase
  startedMs: number
  durationMs: number
  samples: number
  peakRunnerRssBytes: number
  peakContainerMemoryBytes?: number
  cpuMs?: number
  outputBytes: number
}
export type RunnerResources = {
  version: 1
  intervalMs: number
  elapsedMs: number
  phase?: ResourcePhase
  runnerRssBytes: number
  peakRunnerRssBytes: number
  containerMemoryBytes?: number
  peakContainerMemoryBytes?: number
  cpuMs?: number
  outputBytes: number
  bundleBytes?: number
  phases: RunnerPhaseResources[]
}

// Mirrors src/telemetry.ts (GET /api/telemetry) for the Monitor view.

export type Source = "chat" | "job" | "reflector" | "foreman" | "reviewer"

export type TurnSummary = {
  id: string
  at: string
  source: Source
  title: string
  goalId?: string
  durationMs: number
  costUsd: number
  models: string[]
  toolCalls: number
  toolErrors: Array<{ name: string; detail: string }>
  modelError?: string
  tools: Record<string, number>
}

type KindToday = { calls: number; input: number; output: number; costUsd: number }

export type Telemetry = {
  generatedAt: string
  windowDays: number
  timezone: string
  health: {
    startedAt: string
    version: string | null
    serverErrors: number
    harnessReports: number
    scheduling: string
    liveTasks: number
    queuedSubmissions: number
    telegram: { enabled: boolean; polledAt: string | null; error: string | null }
    pauseAll: boolean
    /** Container total (as Railway bills it) where Linux exposes it, else null; this process; peaks since boot. */
    memory?: { processMb: number; heapMb: number; containerMb: number | null; peakProcessMb: number; peakContainerMb: number | null }
    reflecting: boolean
    lastReflectAt: string | null
    reflectEveryHours: number
    failuresLastHour: number
    toolErrorsLastHour: number
  }
  spend: {
    totalUsd: number
    capUsd: number
    lifetime: { root: number; reflector: number; foreman: number; reviewer: number; coders: number }
    todayUsd: number
    todayCodersUsd: number
    lastHourUsd: number
    days: Array<{ day: string; root: number; reflector: number; goals: number; coders: number }>
    today: { root: KindToday; reflector: KindToday; goals: KindToday }
    topTurns: TurnSummary[]
  }
  models: Array<{ model: string; kinds: string[]; calls: number; errors: number; p50Ms?: number; p95Ms?: number; costUsd: number }>
  tools: Array<{ name: string; calls: number; errors: number; p95Ms?: number; lastError?: string }>
  activity: TurnSummary[]
  events: Array<{ at: string; goalId?: string; text: string }>
  incidents: Array<{
    id: string
    at: string
    goalId: string
    goalTitle: string
    kind: "p0" | "revert_failed" | "false_alarm"
    detail: string
    status: "open" | "healed" | "retired"
    rollbackUrl?: string
  }>
  passes: Array<{
    at: string
    durationMs: number
    costUsd: number
    models: string[]
    toolCalls: number
    changes: Array<{ tool: string; target: string; note: string; error?: string }>
    report: string
    error?: string
  }>
  containers: Array<{
    name: string
    goalId: string
    goal: string
    task: string
    attempt: number
    model?: string
    state: "running" | "cleanup" | "removed"
    startedAt: string
    heartbeatAt: string
    resources?: RunnerResources
    resourcesAt?: string
    finishedAt?: string
    costUsd?: number
    unbudgeted?: boolean
    evidencePending?: boolean
    evidenceRetryAt?: string
    verdict?: "accept" | "revise" | "escalate"
    error?: string
  }>
  coding: Coding
  goalTitles: Record<string, string>
  jobs: number
  skills: { total: number; broken: number }
}

export type CodingTotals = {
  requests: number
  input: number
  output: number
  cached: number
  errors: number
  limitHits: number
  /** Only when the provider reports prices; OpenCode Go is a plan, so usually null. */
  costUsd: number | null
}

export type Coding = {
  provider: "openrouter" | "opencode-go"
  chain: string[]
  skipped: Array<{ model: string; until: string }>
  firstSeen: string | null
  lastSeen: string | null
  windows: Array<{ label: string } & CodingTotals>
  models: Array<{ model: string; p50Ms?: number; p95Ms?: number; ttfbP50Ms?: number } & CodingTotals>
  days: Array<{ day: string; requests: number; input: number; output: number; cached: number; errors: number }>
  attempts: Array<
    {
      task: string
      attempt: number
      taskTitle?: string
      goalId?: string
      goalTitle?: string
      startedAt: string
      lastAt: string
      models: string[]
      estimatedUsd?: number
    } & CodingTotals
  >
  errors: Array<{ at: string; task: string; attempt: number; model: string; status: number; error?: string; fallbacks?: Array<{ model: string; status: number }> }>
}

export const usd = (n: number) => (n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(0)}`)

export function duration(ms: number | undefined): string {
  if (ms === undefined) return "—"
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m ${Math.round((ms % 60_000) / 1_000)}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const tokens = (n: number) => (n < 1_000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1_000)}k` : `${(n / 1_000_000).toFixed(1)}M`)

export const clock = (iso: string) => {
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

export const failed = (turn: TurnSummary) => turn.toolErrors.length > 0 || Boolean(turn.modelError)

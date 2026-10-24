import * as React from "react"
import { RefreshCwIcon } from "lucide-react"

import { RunnerResourceDetails } from "@/components/runner-resources"
import { api } from "@/lib/api"
import { fromNow } from "@/lib/time"
import { clock, type Coding, type CodingTotals, duration, failed, type Source, type Telemetry, type TurnSummary, tokens, usd } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

// The Monitor: an observability page for the agent itself. Overview first (vitals, recent activity, spend, models,
// containers, incidents), then one page per concern. Every number comes from /api/telemetry, which derives it from the
// durable transcripts and the orchestrator; nothing here is estimated.

export const MONITOR_VIEWS = ["overview", "activity", "cost", "coding", "models", "reflector", "containers"] as const
export type MonitorView = (typeof MONITOR_VIEWS)[number]

// Series colours: one per spender, used the same way on every chart and bar.
const SERIES = {
  root: { label: "Your conversation", className: "bg-foreground/70", fill: "fill-foreground/70" },
  reflector: { label: "Reflector", className: "bg-violet-500", fill: "fill-violet-500" },
  goals: { label: "Foremen & reviewers", className: "bg-sky-500", fill: "fill-sky-500" },
  coders: { label: "Coders (OpenCode est.)", className: "bg-amber-500", fill: "fill-amber-500" },
} as const

// ── Small building blocks ────────────────────────────────────────────────────────────────────────────────────────────

function Card({ title, sub, className, children, action }: { title: string; sub?: React.ReactNode; className?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-xl border bg-card", className)}>
      <header className="flex min-w-0 items-center justify-between gap-2 px-4 pt-3.5 pb-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="flex min-w-0 items-center gap-2">
          {sub && <span className="truncate text-xs text-muted-foreground">{sub}</span>}
          {action}
        </div>
      </header>
      {children}
    </section>
  )
}

type Tone = "ok" | "warn" | "bad" | "idle"
const TONE: Record<Tone, string> = {
  ok: "text-tone-green",
  warn: "text-tone-amber",
  bad: "text-tone-red",
  idle: "text-muted-foreground",
}

function State({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", TONE[tone])}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {children}
    </span>
  )
}

function Vital({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-card px-3.5 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-w-0 font-mono text-lg break-words font-medium tabular-nums">{children}</div>
    </div>
  )
}

function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground", className)}>{children}</span>
}

function Table({ head, children }: { head: Array<string | { label: string; num?: boolean }>; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h) => {
              const { label, num } = typeof h === "string" ? { label: h, num: false } : h
              return (
                <th key={label} className={cn("px-4 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground", num ? "text-right" : "text-left")}>
                  {label}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className="[&_td]:border-t [&_td]:px-4 [&_td]:py-2 [&_td]:whitespace-nowrap">{children}</tbody>
      </table>
    </div>
  )
}

const Num = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <td className={cn("text-right font-mono tabular-nums", className)}>{children}</td>
)

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 pb-4 text-sm text-muted-foreground">{children}</p>
}

// ── Activity ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const FILTERS = ["all", "chat", "job", "reflector", "goals", "failures"] as const
type Filter = (typeof FILTERS)[number]
const FILTER_LABELS: Record<Filter, string> = { all: "All", chat: "Chat", job: "Jobs", reflector: "Reflector", goals: "Goals", failures: "Failures" }
const SOURCE_LABEL: Record<Source, string> = { chat: "chat", job: "job", reflector: "reflector", foreman: "foreman", reviewer: "reviewer" }

const matches = (turn: TurnSummary, filter: Filter) =>
  filter === "all" ||
  (filter === "failures" ? failed(turn) : filter === "goals" ? turn.source === "foreman" || turn.source === "reviewer" : turn.source === filter)

function turnTitle(turn: TurnSummary, goals: Record<string, string>) {
  if (turn.source === "reflector") return "Reflector pass"
  if (turn.source === "foreman" || turn.source === "reviewer") {
    const goal = turn.goalId ? goals[turn.goalId] : undefined
    const what = turn.title.match(/^\[(\w+)\]/)?.[1] ?? (turn.source === "reviewer" ? "review" : "turn")
    return `${turn.source === "reviewer" ? "Reviewer" : "Foreman"} ${what}${goal ? ` · ${goal}` : ""}`
  }
  return turn.title || "(empty message)"
}

function EventRow({ turn, goals }: { turn: TurnSummary; goals: Record<string, string> }) {
  const [open, setOpen] = React.useState(false)
  const bad = failed(turn)
  const notable = Object.entries(turn.tools).sort((a, b) => b[1] - a[1]).slice(0, 4)
  return (
    <article
      className={cn(
        "relative grid grid-cols-[68px_minmax(0,1fr)_auto] gap-x-3 border-t px-4 py-2.5 max-sm:grid-cols-[minmax(0,1fr)_auto]",
        bad && "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-red-500",
      )}
    >
      <time className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums max-sm:hidden" title={new Date(turn.at).toLocaleString()}>
        {clock(turn.at)}
      </time>
      <div className="min-w-0">
        <button type="button" className="block max-w-full text-left text-sm font-medium break-words hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {turnTitle(turn, goals)}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Tag>{SOURCE_LABEL[turn.source]}</Tag>
          {turn.models.map((m) => (
            <Tag key={m}>{m}</Tag>
          ))}
          <span>
            {turn.toolCalls} tool call{turn.toolCalls === 1 ? "" : "s"}
            {notable.length > 0 && ` · ${notable.map(([name, n]) => (n > 1 ? `${name}×${n}` : name)).join(", ")}`}
          </span>
          <span className="sm:hidden">· {clock(turn.at)}</span>
        </div>
        {bad && (
          <div className="mt-1 text-xs break-words text-tone-red">
            {turn.modelError ? `Model: ${turn.modelError}` : `${turn.toolErrors[0]!.name} failed: ${turn.toolErrors[0]!.detail}`}
            {turn.toolErrors.length > 1 && ` (+${turn.toolErrors.length - 1} more)`}
          </div>
        )}
        {open && (
          <div className="mt-2 flex flex-col gap-1.5 rounded-md bg-muted/60 p-2.5 font-mono text-xs break-words">
            <span>{new Date(turn.at).toLocaleString()}</span>
            {turn.toolErrors.map((e, i) => (
              <span key={i} className="text-tone-red">
                {e.name}: {e.detail}
              </span>
            ))}
            {Object.entries(turn.tools).length > 0 && (
              <span className="text-muted-foreground">
                tools: {Object.entries(turn.tools).map(([name, n]) => `${name}×${n}`).join(", ")}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="text-right font-mono text-xs leading-5 whitespace-nowrap text-muted-foreground tabular-nums">
        {duration(turn.durationMs)}
        <br />
        {usd(turn.costUsd)}
      </div>
    </article>
  )
}

function ActivityFeed({ data, limit }: { data: Telemetry; limit?: number }) {
  const [filter, setFilter] = React.useState<Filter>("all")
  const shown = data.activity.filter((t) => matches(t, filter))
  const list = limit ? shown.slice(0, limit) : shown
  const count = (f: Filter) => data.activity.filter((t) => matches(t, f)).length
  return (
    <>
      <div className="flex flex-wrap gap-1.5 px-4 pb-2.5" role="group" aria-label="Filter activity">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs transition-colors",
              filter === f ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground",
              f === "failures" && filter !== f && count(f) > 0 && "text-tone-red",
            )}
          >
            {FILTER_LABELS[f]} <span className="font-mono tabular-nums opacity-70">{count(f)}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty>Nothing here in the last {data.windowDays} days.</Empty>
      ) : (
        list.map((turn) => <EventRow key={turn.id} turn={turn} goals={data.goalTitles} />)
      )}
    </>
  )
}

// ── Spend ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Bar({ value, className }: { value: number; className?: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", className)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

function SpendSummary({ data }: { data: Telemetry }) {
  const { spend } = data
  const pct = (spend.totalUsd / Math.max(spend.capUsd, 0.01)) * 100
  const life = spend.lifetime
  const rows = [
    { key: "root", value: life.root },
    { key: "reflector", value: life.reflector },
    { key: "goals", value: life.foreman + life.reviewer },
    { key: "coders", value: life.coders },
  ] as const
  const max = Math.max(...rows.map((r) => r.value), 0.0001)
  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <div className="font-mono text-2xl font-medium tabular-nums">
        {usd(spend.totalUsd)} <span className="text-sm text-muted-foreground">of {usd(spend.capUsd)} cap</span>
      </div>
      <div role="img" aria-label={`${Math.round(pct)} percent of the spend cap used`}>
        <Bar value={pct} className={pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-foreground/70"} />
      </div>
      <p className="font-mono text-xs text-muted-foreground tabular-nums">
        today {usd(spend.todayUsd)} · last hour {usd(spend.lastHourUsd)} · {Math.round(pct)}% of cap used
      </p>
      <div className="mt-1 flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1 text-[13px]">
            <span className="flex items-center gap-2">
              <span className={cn("size-2 rounded-sm", SERIES[r.key].className)} />
              {SERIES[r.key].label}
            </span>
            <span className="font-mono tabular-nums">{usd(r.value)}</span>
            <div className="col-span-2">
              <Bar value={(r.value / max) * 100} className={SERIES[r.key].className} />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        All time. The cap counts the agent's own model calls. Coders run on their own per-attempt keys or the OpenCode Go plan; their figure is OpenCode's own estimate from list prices (see Coding model for metered usage).
      </p>
    </div>
  )
}

type Series = { key: string; label: string; className: string; fill: string }

/** Days as stacked bars, one segment per series, with a round axis, hover readout and an average line of text. */
function StackedDays<D extends { day: string }>({
  days,
  series,
  value,
  format,
  unit,
  name,
}: {
  days: D[]
  series: Series[]
  value: (day: D, key: string) => number
  format: (n: number) => string
  unit: string
  name: string
}) {
  const totals = days.map((d) => series.reduce((s, k) => s + value(d, k.key), 0))
  const top = Math.max(...totals, Number.EPSILON)
  // A round axis maximum: 1, 2 or 5 times a power of ten.
  const magnitude = 10 ** Math.floor(Math.log10(top))
  const axis = [1, 2, 5, 10].map((m) => m * magnitude).find((v) => v >= top) ?? top
  const W = 520
  const H = 200
  const left = 44
  const bottom = 172
  const plot = bottom - 12
  const slot = (W - left - 8) / days.length
  const [hover, setHover] = React.useState<number>()
  const label = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  const shown = hover ?? days.length - 1
  const average = totals.reduce((s, v) => s + v, 0) / days.length
  const peak = totals.indexOf(Math.max(...totals))
  return (
    <div className="flex flex-col gap-2 px-4 pb-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-mono tabular-nums">
          {hover === undefined ? "Today" : label(days[shown]!.day)} · <b className="font-medium">{format(totals[shown]!)}</b>
          {hover !== undefined && series.length > 1 && (
            <span className="text-muted-foreground"> ({series.map((k) => format(value(days[shown]!, k.key))).join(" + ")})</span>
          )}
        </span>
        <span className="flex flex-wrap gap-3 text-muted-foreground">
          {series.map((k) => (
            <span key={k.key} className="flex items-center gap-1.5">
              <span className={cn("size-2 rounded-sm", k.className)} /> {k.label}
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full max-w-[560px]" role="img" aria-label={`${name} over ${days.length} days`} onMouseLeave={() => setHover(undefined)}>
        {[0, 0.5, 1].map((f) => {
          const y = bottom - f * plot
          return (
            <g key={f}>
              <line x1={left} x2={W - 4} y1={y} y2={y} className={f === 0 ? "stroke-muted-foreground/60" : "stroke-border"} strokeWidth={1} />
              <text x={left - 6} y={y + 4} textAnchor="end" className="fill-muted-foreground font-mono text-[11px]">
                {format(axis * f)}
              </text>
            </g>
          )
        })}
        {days.map((d, i) => {
          const w = slot * 0.62
          const x = left + i * slot + (slot - w) / 2
          let y = bottom
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} opacity={hover === undefined || hover === i ? 1 : 0.45}>
              <rect x={left + i * slot} y={0} width={slot} height={bottom} fill="transparent" />
              {series.map((k) => {
                const h = (value(d, k.key) / axis) * plot
                if (h <= 0) return null
                y -= h
                return <rect key={k.key} x={x} y={y} width={w} height={Math.max(h, 1)} rx={1.5} className={k.fill} />
              })}
              <title>{`${label(d.day)}: ${format(totals[i]!)}`}</title>
            </g>
          )
        })}
        {[0, Math.floor(days.length / 2), days.length - 1].map((i) => (
          <text key={i} x={left + i * slot + slot / 2} y={H - 8} textAnchor={i === days.length - 1 ? "end" : i === 0 ? "start" : "middle"} className="fill-muted-foreground font-mono text-[11px]">
            {i === days.length - 1 ? "Today" : label(days[i]!.day)}
          </text>
        ))}
      </svg>
      <p className="text-xs text-muted-foreground">
        Average {format(average)} {unit}/day.{totals[peak]! > 0 && ` Highest ${label(days[peak]!.day)}, ${format(totals[peak]!)}.`}
      </p>
    </div>
  )
}

function DailyChart({ data }: { data: Telemetry }) {
  const keys = ["root", "reflector", "goals", "coders"] as const
  return (
    <StackedDays
      days={data.spend.days}
      series={keys.map((key) => ({ key, ...SERIES[key] }))}
      value={(d, key) => d[key as (typeof keys)[number]]}
      format={usd}
      unit="spent"
      name="Daily spend"
    />
  )
}

// ── Coding model (OpenCode Go, metered at the agent's proxy) ─────────────────────────────────────────────────────────

const cachedShare = (t: Pick<CodingTotals, "input" | "cached">) => (t.input ? `${Math.round((t.cached / t.input) * 100)}%` : "—")

function CodingGlance({ coding }: { coding: Coding }) {
  if (coding.provider !== "opencode-go") return <Empty>Coders use OpenRouter keys, capped per attempt. Usage metering covers OpenCode Go.</Empty>
  const [fiveH, day] = coding.windows
  return (
    <div className="flex flex-col gap-2 px-4 pb-4 text-[13px]">
      <div className="grid grid-cols-2 gap-2">
        {[fiveH!, day!].map((w) => (
          <div key={w.label} className="rounded-lg bg-muted/50 px-3 py-2">
            <div className="text-xs text-muted-foreground">Last {w.label}</div>
            <div className="font-mono font-medium tabular-nums">{w.requests} req</div>
            <div className="font-mono text-xs text-muted-foreground tabular-nums">
              {tokens(w.input)} in · {tokens(w.output)} out
            </div>
          </div>
        ))}
      </div>
      <ChainStatus coding={coding} />
    </div>
  )
}

function ChainStatus({ coding }: { coding: Coding }) {
  return (
    <ol className="flex flex-col gap-1">
      {coding.chain.map((model, i) => {
        const skipped = coding.skipped.find((s) => s.model === model)
        return (
          <li key={model} className="flex items-center justify-between gap-2 text-[13px]">
            <span className="min-w-0 truncate font-mono text-xs">
              <span className="text-muted-foreground">{i + 1}.</span> {model}
            </span>
            {skipped ? <State tone="warn">At limit, back {fromNow(skipped.until)}</State> : <State tone="ok">{i === 0 ? "Primary" : "Fallback ready"}</State>}
          </li>
        )
      })}
    </ol>
  )
}

const TOKEN_SERIES: Series[] = [
  { key: "fresh", label: "Input (uncached)", className: "bg-sky-500", fill: "fill-sky-500" },
  { key: "cached", label: "Input (cached)", className: "bg-sky-500/40", fill: "fill-sky-500/40" },
  { key: "output", label: "Output", className: "bg-amber-500", fill: "fill-amber-500" },
]

function CodingPage({ data }: { data: Telemetry }) {
  const c = data.coding
  if (c.provider !== "opencode-go") {
    return (
      <Card title="Coding model" sub="OpenRouter">
        <Empty>
          Coders run on OpenRouter with a key capped per attempt, so their spend shows on the Cost page. This page meters OpenCode Go usage
          through the agent's proxy; set CODER_PROVIDER=opencode-go to use it.
        </Empty>
      </Card>
    )
  }
  const hits = c.windows[1]!.limitHits
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5" aria-label="Usage by window">
        {c.windows.map((w) => (
          <Vital key={w.label} label={`Last ${w.label}`}>
            {tokens(w.input + w.output)} <span className="text-xs text-muted-foreground">tok · {w.requests} req</span>
          </Vital>
        ))}
        <Vital label="Limit hits (24h)">
          <span className={cn(hits > 0 && TONE.warn)}>{hits}</span>{" "}
          <span className="text-xs text-muted-foreground">{c.windows[1]!.errors} errors</span>
        </Vital>
      </section>
      {c.firstSeen === null && (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          No coding requests metered yet. The meter starts with this deploy; the next task attempt will show up here.
        </p>
      )}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card title="Model chain" sub="tried in order; a model at its limit is skipped for 10 min">
          <div className="px-4 pb-4">
            <ChainStatus coding={c} />
          </div>
        </Card>
        <Card title="Daily tokens" sub={`last ${data.windowDays} days · ${data.timezone}`}>
          <StackedDays
            days={c.days}
            series={TOKEN_SERIES}
            value={(d, key) => (key === "fresh" ? Math.max(0, d.input - d.cached) : key === "cached" ? d.cached : d.output)}
            format={tokens}
            unit="tokens"
            name="Daily coding tokens"
          />
        </Card>
      </div>
      <Card title="Models" sub="last 7 days · latency per request">
        {c.models.length === 0 ? (
          <Empty>No requests in the last 7 days.</Empty>
        ) : (
          <Table
            head={[
              "Model",
              { label: "Req", num: true },
              { label: "In", num: true },
              { label: "Cached", num: true },
              { label: "Out", num: true },
              { label: "p50", num: true },
              { label: "p95", num: true },
              { label: "First byte", num: true },
              { label: "Err", num: true },
              { label: "Limits", num: true },
            ]}
          >
            {c.models.map((m) => (
              <tr key={m.model}>
                <td className="font-mono text-xs">{m.model}</td>
                <Num>{m.requests}</Num>
                <Num>{tokens(m.input)}</Num>
                <Num>{cachedShare(m)}</Num>
                <Num>{tokens(m.output)}</Num>
                <Num>{duration(m.p50Ms)}</Num>
                <Num>{duration(m.p95Ms)}</Num>
                <Num>{duration(m.ttfbP50Ms)}</Num>
                <Num className={m.errors ? TONE.bad : undefined}>{m.errors}</Num>
                <Num className={m.limitHits ? TONE.warn : undefined}>{m.limitHits}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="By attempt" sub="latest 20 · OpenCode's own cost estimate alongside">
        {c.attempts.length === 0 ? (
          <Empty>No attempts metered yet.</Empty>
        ) : (
          <Table head={["Attempt", "Models", { label: "Req", num: true }, { label: "In", num: true }, { label: "Out", num: true }, { label: "Err", num: true }, { label: "Est.", num: true }, { label: "Last", num: true }]}>
            {c.attempts.map((a) => (
              <tr key={`${a.task}-${a.attempt}`}>
                <td className="max-w-[18rem] truncate" title={[a.goalTitle, a.taskTitle].filter(Boolean).join(" · ")}>
                  <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                    {a.task}#{a.attempt}
                  </span>
                  {a.taskTitle ?? ""}
                </td>
                <td className="font-mono text-xs text-muted-foreground">{a.models.join(", ")}</td>
                <Num>{a.requests}</Num>
                <Num>{tokens(a.input)}</Num>
                <Num>{tokens(a.output)}</Num>
                <Num className={a.errors ? TONE.bad : undefined}>{a.errors}</Num>
                <Num>{a.estimatedUsd === undefined ? "—" : usd(a.estimatedUsd)}</Num>
                <Num>{clock(a.lastAt)}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Errors and fallbacks" sub="latest 12">
        {c.errors.length === 0 ? (
          <Empty>None.</Empty>
        ) : (
          c.errors.map((e, i) => (
            <div key={i} className="grid grid-cols-[68px_minmax(0,1fr)] gap-3 border-t px-4 py-2.5 text-[13px]">
              <time className="font-mono text-xs text-muted-foreground tabular-nums">{clock(e.at)}</time>
              <div className="min-w-0 break-words">
                <span className="font-mono text-xs">
                  {e.task}#{e.attempt} · {e.model} · {e.status}
                </span>
                {e.fallbacks?.map((f) => (
                  <div key={f.model} className={cn("text-xs", TONE.warn)}>
                    {f.model} returned {f.status}, fell back
                  </div>
                ))}
                {e.error && <div className={cn("text-xs", TONE.bad)}>{e.error}</div>}
              </div>
            </div>
          ))
        )}
      </Card>
    </div>
  )
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function Vitals({ data }: { data: Telemetry }) {
  const h = data.health
  const tg = h.telegram
  const tgAge = tg.polledAt ? Date.now() - Date.parse(tg.polledAt) : Infinity
  const nextReflect = h.lastReflectAt && h.reflectEveryHours > 0 ? new Date(Date.parse(h.lastReflectAt) + h.reflectEveryHours * 3_600_000).toISOString() : undefined
  const healthy = h.serverErrors === 0 && h.harnessReports === 0 && h.scheduling === "running"
  return (
    <section className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5" aria-label="Health">
      <Vital label="Status">
        {h.pauseAll ? (
          <State tone="warn">Paused (PAUSE_ALL)</State>
        ) : healthy ? (
          <State tone="ok">Healthy</State>
        ) : (
          <State tone={h.scheduling === "running" ? "warn" : "bad"}>
            {h.scheduling !== "running" ? `Harness ${h.scheduling}` : `${h.serverErrors + h.harnessReports} issues since boot`}
          </State>
        )}
      </Vital>
      {h.memory && (
        <Vital label="Memory">
          <span title={`this process ${h.memory.processMb} MB (heap ${h.memory.heapMb} MB), peak ${h.memory.peakProcessMb} MB`}>
            {h.memory.containerMb ?? h.memory.processMb} MB
          </span>
          <div className="text-xs font-normal text-muted-foreground">peak {h.memory.peakContainerMb ?? h.memory.peakProcessMb} MB since boot</div>
        </Vital>
      )}
      <Vital label="Telegram">
        {!tg.enabled ? (
          <State tone="idle">Not configured</State>
        ) : tg.error ? (
          <State tone="bad">
            <span className="truncate" title={tg.error}>Error</span>
          </State>
        ) : tgAge < 120_000 ? (
          <State tone="ok">Polling</State>
        ) : (
          <State tone="warn">{tg.polledAt ? `Quiet ${fromNow(tg.polledAt)}` : "Not polled yet"}</State>
        )}
      </Vital>
      <Vital label="Harness">
        <span className="text-sm">
          {h.liveTasks} task{h.liveTasks === 1 ? "" : "s"} · {h.queuedSubmissions} queued
        </span>
      </Vital>
      <Vital label="Spend today">
        {usd(data.spend.todayUsd)} <span className="text-xs text-muted-foreground">{usd(data.spend.lastHourUsd)}/h</span>
      </Vital>
      <Vital label="Failures (1h)">
        <span className={cn(h.failuresLastHour > 0 && TONE.bad)}>{h.failuresLastHour}</span>{" "}
        <span className="text-xs text-muted-foreground">{h.toolErrorsLastHour} tool errors</span>
      </Vital>
      <Vital label="Reflector">
        <span className="text-sm">
          {h.reflecting ? (
            <State tone="warn">Running</State>
          ) : !nextReflect ? (
            "not scheduled"
          ) : Date.parse(nextReflect) < Date.now() ? (
            <State tone="warn">Due {fromNow(nextReflect)}</State>
          ) : (
            `next ${fromNow(nextReflect)}`
          )}
        </span>
      </Vital>
    </section>
  )
}

function ModelsTable({ data, compact }: { data: Telemetry; compact?: boolean }) {
  if (data.models.length === 0) return <Empty>No model calls in the last 24 hours.</Empty>
  return (
    <Table head={["Model", { label: "Calls", num: true }, ...(compact ? [] : [{ label: "p50", num: true }]), { label: "p95", num: true }, { label: "Err", num: true }, ...(compact ? [] : [{ label: "Cost", num: true }])]}>
      {data.models.map((m) => {
        const rate = m.calls ? m.errors / m.calls : 0
        return (
          <tr key={m.model}>
            <td>
              {m.model} <span className="text-xs text-muted-foreground">{m.kinds.join(", ")}</span>
            </td>
            <Num>{m.calls}</Num>
            {!compact && <Num>{duration(m.p50Ms)}</Num>}
            <Num>{duration(m.p95Ms)}</Num>
            <Num className={rate > 0.1 ? TONE.bad : rate > 0 ? TONE.warn : undefined}>{Math.round(rate * 100)}%</Num>
            {!compact && <Num>{usd(m.costUsd)}</Num>}
          </tr>
        )
      })}
    </Table>
  )
}

const CONTAINER_TONE = { running: "ok", cleanup: "warn", removed: "idle" } as const
const CONTAINER_LABEL = { running: "Running", cleanup: "Awaiting cleanup", removed: "Removed" } as const

function ContainerRows({ data, limit }: { data: Telemetry; limit?: number }) {
  const list = limit ? data.containers.slice(0, limit) : data.containers
  if (list.length === 0) return <Empty>No coding containers yet.</Empty>
  return (
    <div>
      {list.map((c) => (
        <div key={`${c.name}-${c.startedAt}`}>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-t px-4 py-2 text-[13px] max-sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0">
              <div className="truncate font-mono text-xs">{c.name}</div>
              <div className="truncate text-xs text-muted-foreground" title={`${c.goal} · ${c.task}`}>
                {c.task}
                {c.verdict && ` · ${c.verdict}`}
                {c.unbudgeted && " · No coding retry used"}
                {c.evidencePending && " · Evidence delivery queued"}
                {c.costUsd !== undefined && ` · ${usd(c.costUsd)}`}
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-1"><State tone={CONTAINER_TONE[c.state]}>{CONTAINER_LABEL[c.state]}</State>{c.error && <State tone="bad">Execution failed</State>}</div>
            <span className="font-mono text-xs text-muted-foreground tabular-nums max-sm:hidden">
              {duration((c.finishedAt ? Date.parse(c.finishedAt) : Date.now()) - Date.parse(c.startedAt))}
            </span>
          </div>
          {!limit && c.error && <p className="px-4 pb-2 text-xs break-words text-destructive">{c.error}{c.evidenceRetryAt && ` · Next delivery retry ${clock(c.evidenceRetryAt)}`}</p>}
          {!limit && <RunnerResourceDetails resources={c.resources} running={c.state === "running"} reportedAt={c.resourcesAt ?? c.heartbeatAt} />}
        </div>
      ))}
    </div>
  )
}

function Incidents({ data }: { data: Telemetry }) {
  const open = data.incidents.filter((i) => i.status === "open").length
  return (
    <Card title="Incidents" sub={`${open} open · ${data.incidents.length} total`} className="lg:col-span-2">
      {data.incidents.length === 0 ? (
        <Empty>No post-merge incidents.</Empty>
      ) : (
        data.incidents.slice(0, 8).map((i) => (
          <div key={i.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-3 border-t px-4 py-2.5 text-[13px]">
            <span className={cn("mt-1.5 size-2 rounded-full", i.status === "open" ? "bg-red-500" : i.status === "healed" ? "bg-emerald-500" : "bg-muted-foreground/50")} />
            <div className="min-w-0 break-words">
              {i.kind === "p0" ? "P0 after merge" : i.kind === "revert_failed" ? "Revert failed" : "False alarm"} · {i.goalTitle}
              <small className="mt-0.5 block font-mono text-xs text-muted-foreground">
                {i.detail.slice(0, 200)} · {i.status} · {clock(i.at)}
                {i.rollbackUrl && (
                  <>
                    {" · "}
                    <a href={i.rollbackUrl} target="_blank" rel="noreferrer" className="underline">
                      revert PR
                    </a>
                  </>
                )}
              </small>
            </div>
          </div>
        ))
      )}
    </Card>
  )
}

function Overview({ data, go }: { data: Telemetry; go: (view: MonitorView) => void }) {
  const live = data.containers.filter((c) => c.state !== "removed").length
  const more = (view: MonitorView, label: string) => (
    <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => go(view)}>
      {label}
    </button>
  )
  return (
    <div className="flex flex-col gap-4">
      <Vitals data={data} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card title="Activity" sub={`last ${data.windowDays} days · ${data.activity.length} turns`} action={more("activity", "All")}>
          <ActivityFeed data={data} limit={8} />
        </Card>
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Spend" action={more("cost", "Details")}>
            <SpendSummary data={data} />
          </Card>
          <Card title="Coding model" sub={data.coding.provider === "opencode-go" ? "OpenCode Go" : "OpenRouter"} action={more("coding", "Details")}>
            <CodingGlance coding={data.coding} />
          </Card>
          <Card title="Models" sub="last 24 hours" action={more("models", "Details")}>
            <ModelsTable data={data} compact />
          </Card>
          <Card title="Containers" sub={`${live} live`} action={more("containers", "All")}>
            <ContainerRows data={data} limit={4} />
          </Card>
        </div>
        <Incidents data={data} />
      </div>
    </div>
  )
}

function CostPage({ data }: { data: Telemetry }) {
  const t = data.spend.today
  const rows = [
    { label: SERIES.root.label, ...t.root },
    { label: SERIES.reflector.label, ...t.reflector },
    { label: SERIES.goals.label, ...t.goals },
  ]
  return (
    <div className="grid items-start gap-4 xl:grid-cols-2">
      <Card title="Total" sub={`cap ${usd(data.spend.capUsd)} · new work stops at the cap`}>
        <SpendSummary data={data} />
      </Card>
      <Card title="Daily spend" sub={`last ${data.windowDays} days · ${data.timezone}`}>
        <DailyChart data={data} />
      </Card>
      <Card title="Today" sub="by conversation kind">
        <Table head={["Kind", { label: "Calls", num: true }, { label: "In tok", num: true }, { label: "Out tok", num: true }, { label: "Cost", num: true }]}>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>{r.label}</td>
              <Num>{r.calls}</Num>
              <Num>{tokens(r.input)}</Num>
              <Num>{tokens(r.output)}</Num>
              <Num>{usd(r.costUsd)}</Num>
            </tr>
          ))}
          <tr>
            <td>{SERIES.coders.label}</td>
            <Num>—</Num>
            <Num>—</Num>
            <Num>—</Num>
            <Num>{usd(data.spend.todayCodersUsd)}</Num>
          </tr>
        </Table>
      </Card>
      <Card title="Most expensive turns" sub="today">
        {data.spend.topTurns.length === 0 ? (
          <Empty>No turns today.</Empty>
        ) : (
          <Table head={["Turn", "Model", { label: "Time", num: true }, { label: "Cost", num: true }]}>
            {data.spend.topTurns.map((turn) => (
              <tr key={turn.id}>
                <td className="max-w-[16rem] truncate" title={turnTitle(turn, data.goalTitles)}>
                  <span className="mr-1.5">
                    <Tag>{SOURCE_LABEL[turn.source]}</Tag>
                  </span>
                  {turnTitle(turn, data.goalTitles)}
                </td>
                <td className="text-muted-foreground">{turn.models.join(", ")}</td>
                <Num>{clock(turn.at)}</Num>
                <Num>{usd(turn.costUsd)}</Num>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

function ModelsPage({ data }: { data: Telemetry }) {
  return (
    <div className="grid items-start gap-4">
      <Card title="Models" sub="last 24 hours · latency per model call">
        <ModelsTable data={data} />
      </Card>
      <Card title="Tools" sub="last 24 hours · failing first">
        {data.tools.length === 0 ? (
          <Empty>No tool calls in the last 24 hours.</Empty>
        ) : (
          <Table head={["Tool", { label: "Calls", num: true }, { label: "Errors", num: true }, { label: "p95", num: true }, "Last error"]}>
            {data.tools.map((t) => (
              <tr key={t.name}>
                <td className="font-mono text-xs">{t.name}</td>
                <Num>{t.calls}</Num>
                <Num className={t.errors > 0 ? TONE.bad : undefined}>{t.errors}</Num>
                <Num>{duration(t.p95Ms)}</Num>
                <td className="max-w-[28rem] truncate text-xs text-muted-foreground" title={t.lastError}>
                  {t.lastError ?? ""}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  )
}

const CHANGE_LABEL: Record<string, string> = {
  skill_save: "skill",
  skill_rollback: "rollback",
  skill_remove: "removed skill",
  memory: "memory",
  schedule_job: "job",
  cancel_job: "cancelled job",
  notify: "told you",
}

function ReflectorPage({ data }: { data: Telemetry }) {
  const passes = data.passes
  const changes = passes.reduce((n, p) => n + p.changes.filter((c) => c.tool !== "notify" && !c.error).length, 0)
  const rejected = passes.reduce((n, p) => n + p.changes.filter((c) => c.error).length, 0)
  const cost = passes.reduce((s, p) => s + p.costUsd, 0)
  const h = data.health
  return (
    <div className="flex flex-col gap-4">
      <section className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5">
        <Vital label={`Passes, ${data.windowDays} days`}>{passes.length}</Vital>
        <Vital label="Changes made">
          <span className={TONE.ok}>{changes}</span>
        </Vital>
        <Vital label="Changes that failed">
          <span className={rejected ? TONE.bad : undefined}>{rejected}</span>
        </Vital>
        <Vital label="Cost">{usd(cost)}</Vital>
        <Vital label="Schedule">
          <span className="text-sm">{h.reflectEveryHours > 0 ? `every ${h.reflectEveryHours}h` : "off"}</span>
        </Vital>
      </section>
      {passes.length === 0 ? (
        <Card title="Passes">
          <Empty>No reflector passes in the last {data.windowDays} days.</Empty>
        </Card>
      ) : (
        passes.map((p) => (
          <Card key={p.at} title={new Date(p.at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} sub={`${duration(p.durationMs)} · ${p.models.join(", ")} · ${usd(p.costUsd)}`}>
            <div className="flex flex-col gap-2.5 px-4 pb-4">
              {p.error && <p className={cn("text-xs", TONE.bad)}>Model error: {p.error}</p>}
              {p.changes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No changes. {p.toolCalls} tool calls.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {p.changes.map((c, i) => (
                    <li key={i} className="min-w-0 rounded-lg border px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">
                          {CHANGE_LABEL[c.tool] ?? c.tool}
                          {c.target && `: ${c.target}`}
                        </span>
                        {c.error ? <State tone="bad">Failed</State> : <State tone="ok">Applied</State>}
                      </div>
                      {c.note && <p className="mt-1 text-xs break-words text-muted-foreground">{c.note}</p>}
                      {c.error && <p className={cn("mt-1 font-mono text-xs break-words", TONE.bad)}>{c.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
              {p.report && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Report</summary>
                  <p className="mt-2 break-words whitespace-pre-wrap">{p.report}</p>
                </details>
              )}
            </div>
          </Card>
        ))
      )}
    </div>
  )
}

function ContainersPage({ data }: { data: Telemetry }) {
  const by = (state: string) => data.containers.filter((c) => c.state === state).length
  return (
    <Card title="Coding containers" sub={`${by("running")} running · ${by("cleanup")} awaiting cleanup · latest 30`}>
      <ContainerRows data={data} />
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        One container per task attempt, in the sandbox project. Finished containers are deleted; a sweep removes anything left over.
      </p>
    </Card>
  )
}

// ── The pages ────────────────────────────────────────────────────────────────────────────────────────────────────

/** /api/telemetry, re-read every 30 s while the tab is visible. */
export function useTelemetry() {
  const [data, setData] = React.useState<Telemetry>()
  const [error, setError] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const load = React.useCallback(() => {
    setLoading(true)
    api<Telemetry>("/api/telemetry")
      .then((next) => {
        setData(next)
        setError(undefined)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false))
  }, [])
  React.useEffect(() => {
    load()
    const timer = setInterval(() => document.visibilityState === "visible" && load(), 30_000)
    return () => clearInterval(timer)
  }, [load])
  return { data, error, loading, load }
}

/** "deployed 9d7a58c · up 1h 45m · updated 7:10 PM" and a refresh button. */
export function TelemetryMeta({ data, loading, onRefresh }: { data: Telemetry | undefined; loading: boolean; onRefresh: () => void }) {
  return (
    <span className="flex items-center gap-2 font-mono text-xs text-subtle">
      {data && (
        <>
          {data.health.version ? `deployed ${data.health.version.slice(0, 7)} · ` : ""}up {duration(Date.now() - Date.parse(data.health.startedAt))} · updated{" "}
          {new Date(data.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
        </>
      )}
      <Button size="icon-xs" variant="ghost" aria-label="Refresh" disabled={loading} onClick={onRefresh}>
        {loading ? <Spinner /> : <RefreshCwIcon />}
      </Button>
    </span>
  )
}

/** One telemetry page's body. */
export function TelemetryPage({ view, data, error, go }: { view: MonitorView; data: Telemetry | undefined; error?: string; go: (view: MonitorView) => void }) {
  if (!data) {
    if (error) return <p className={cn("text-sm", TONE.bad)}>Couldn't load telemetry: {error}</p>
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }
  switch (view) {
    case "overview":
      return <Overview data={data} go={go} />
    case "activity":
      return (
        <Card title="Every turn" sub={`last ${data.windowDays} days · newest first`}>
          <ActivityFeed data={data} />
        </Card>
      )
    case "cost":
      return <CostPage data={data} />
    case "coding":
      return <CodingPage data={data} />
    case "models":
      return <ModelsPage data={data} />
    case "reflector":
      return <ReflectorPage data={data} />
    default:
      return <ContainersPage data={data} />
  }
}

import * as React from "react"

import { api } from "@/lib/api"
import { fromNow } from "@/lib/time"
import { PanelSection } from "@/components/panel-section"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"

type LabRun = { id: string; arm: string; set: string; seed: number | null; date: string | null; totalCostUsd: number; episodes: number; status: string }
type LabCurve = { id: string; label: string; scores: number[] }
type LabNode = { id: string; statement: string }
type LabData = { runs: LabRun[]; curves: LabCurve[]; knowledge: Record<string, LabNode[]> }

// boundary-F lives in 0..1, so the sparkline's y domain is fixed and curves from different runs compare.
function Spark({ scores }: { scores: number[] }) {
  const step = 100 / Math.max(scores.length - 1, 1)
  const points = scores.map((f, i) => `${(i * step).toFixed(1)},${(22 - f * 20).toFixed(1)}`).join(" ")
  return (
    <svg viewBox="0 0 100 24" className="h-6 w-full" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-tone-violet" />
    </svg>
  )
}

const Blank = ({ what }: { what: string }) => <p className="py-6 text-sm text-muted-foreground">{what}</p>

// The Lab: what the benchmark actually measured — runs, learning curves and knowledge by status,
// all read from the recorded results JSONL and the journal on each fetch, nothing invented here.
// `initial` is proof-only (bench/proofs.ts lab-render): it renders the real component with the
// payload the real server served, without a browser. The app never passes it and keeps fetching.
export function LabPanel({ initial }: { initial?: LabData }) {
  const [data, setData] = React.useState<LabData | undefined>(initial)
  const [failed, setFailed] = React.useState<string>()

  React.useEffect(() => {
    if (initial) return
    let live = true
    api<LabData>("/api/elr/lab")
      .then((next) => {
        if (!live) return
        setData(next)
        setFailed(undefined)
      })
      .catch((err: unknown) => {
        if (live) setFailed(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [initial])

  if (failed && !data) return <p className="text-sm text-destructive">{failed}</p>
  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const statuses = Object.entries(data.knowledge).sort(([a], [b]) => a.localeCompare(b))
  const nodes = statuses.reduce((n, [, group]) => n + group.length, 0)

  return (
    <div className="flex flex-col gap-4">
      <PanelSection title="Benchmark runs" summary={`${data.runs.length}`} defaultOpen>
        {data.runs.length === 0 ? (
          <Blank what="No runs yet. `npm run bench` records one JSONL file per run; they are listed here." />
        ) : (
          <div className="flex flex-col gap-2">
            {data.runs.map((run) => (
              <div key={run.id} className="flex items-center gap-2 rounded-xl border p-2.5 text-sm">
                <Badge variant="outline" className="font-mono text-[11px]">
                  {run.arm || "?"}·{run.set || "?"}·s{run.seed ?? "?"}
                </Badge>
                <Badge variant={run.status === "complete" ? "secondary" : "destructive"} className="text-[11px]">
                  {run.status}
                </Badge>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                  {run.episodes} ep · ${run.totalCostUsd.toFixed(4)} · {run.date ? fromNow(run.date) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Learning curves" summary="boundary-F per episode" defaultOpen>
        {data.curves.length === 0 ? (
          <Blank what="No recorded episodes. Curves are drawn only from recorded run results." />
        ) : (
          <div className="flex flex-col gap-2">
            {data.curves.map((curve) => {
              const first = curve.scores[0]
              const last = curve.scores.at(-1)
              return (
                <div key={`${curve.id}:${curve.label}`} className="flex min-w-0 flex-col gap-1 rounded-xl border p-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-[11px]">{curve.label}</span>
                    {first !== undefined && last !== undefined && (
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {first.toFixed(2)} → {last.toFixed(2)}
                      </span>
                    )}
                  </div>
                  <Spark scores={curve.scores} />
                  <p className="text-[11px] text-muted-foreground">{curve.scores.length} episodes</p>
                </div>
              )
            })}
          </div>
        )}
      </PanelSection>

      <PanelSection title="Knowledge by status" summary={nodes > 0 ? `${nodes}` : undefined} defaultOpen>
        {nodes === 0 ? (
          <Blank what="No knowledge recorded yet. Nodes appear here grouped by status as the journal fills." />
        ) : (
          <div className="flex flex-col gap-3">
            {statuses.map(([status, group]) => (
              <div key={status} className="flex min-w-0 flex-col gap-1.5">
                <Badge variant="secondary" className="w-fit text-[11px]">
                  {status} · {group.length}
                </Badge>
                {group.map((node) => (
                  <p key={node.id} className="rounded-xl border p-2.5 text-sm break-words">
                    {node.statement}
                  </p>
                ))}
              </div>
            ))}
          </div>
        )}
      </PanelSection>
    </div>
  )
}

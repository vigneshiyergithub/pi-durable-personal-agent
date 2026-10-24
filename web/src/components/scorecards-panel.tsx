import * as React from "react"
import { GaugeIcon, TriangleAlertIcon } from "lucide-react"

import { api } from "@/lib/api"
import type { OrchestraState } from "@/lib/orchestra"
import type { ScoreBoard, ScoreWindow, Scorecards } from "@/lib/scorecards"
import { PanelSection } from "@/components/panel-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

const WINDOWS: Array<{ value: ScoreWindow; label: string }> = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "all", label: "All time" },
]

const percent = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`)
const dollars = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`)
const decimal = (n: number | null, unit = "") => (n === null ? "—" : `${n.toFixed(1)}${unit}`)

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      <span className="shrink-0 font-medium tabular-nums">{value}</span>
    </div>
  )
}

function ModelGroup({ model, children }: { model: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {/* The server files attempts that predate model tracking under "unknown"; say what that means. */}
      {model === "unknown" ? (
        <Badge variant="outline" className="max-w-full text-[11px] text-muted-foreground" title="Attempts recorded before the model was tracked">
          Model not recorded
        </Badge>
      ) : (
        <Badge variant="outline" className="max-w-full font-mono text-[11px] break-all whitespace-normal">
          {model}
        </Badge>
      )}
      {children}
    </div>
  )
}

function isEmpty(board: ScoreBoard) {
  return Object.keys(board.coder).length === 0 && Object.keys(board.reviewer).length === 0 && board.foreman.verdicts === 0
}

export function ScorecardsPanel({ orchestra }: { orchestra: OrchestraState | undefined }) {
  const [data, setData] = React.useState<Scorecards>()
  const [error, setError] = React.useState<string>()
  const [range, setRange] = React.useState<ScoreWindow>("30d")
  const [projectId, setProjectId] = React.useState("all")

  // The orchestrator state moves while you watch; re-read the scorecards whenever it changes.
  React.useEffect(() => {
    let live = true
    api<Scorecards>("/api/scorecards")
      .then((next) => {
        if (!live) return
        setData(next)
        setError(undefined)
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      live = false
    }
  }, [orchestra])

  if (error && !data) {
    return (
      <p className="flex items-center gap-2 text-sm text-destructive">
        <TriangleAlertIcon className="size-4" /> {error}
      </p>
    )
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  const windowScores = data.windows[range]
  const projectIds = Object.keys(windowScores.byProject)
  const board = projectId === "all" ? windowScores.total : windowScores.byProject[projectId] ?? windowScores.total
  const coderModels = Object.keys(board.coder).length
  const reviewerModels = Object.keys(board.reviewer).length

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="xs"
              variant={range === w.value ? "default" : "outline"}
              aria-pressed={range === w.value}
              onClick={() => setRange(w.value)}
            >
              {w.label}
            </Button>
          ))}
        </div>
        {projectIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Project">
            {["all", ...projectIds].map((id) => (
              <Button
                key={id}
                size="xs"
                variant={projectId === id ? "default" : "outline"}
                aria-pressed={projectId === id}
                onClick={() => setProjectId(id)}
              >
                {id === "all" ? "All projects" : id}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isEmpty(board) ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GaugeIcon />
            </EmptyMedia>
            <EmptyTitle>No scorecards yet</EmptyTitle>
            <EmptyDescription>Once goals run, their coders, foreman and reviewer are scored here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <PanelSection
            title="Coders"
            summary={`${coderModels} model${coderModels === 1 ? "" : "s"}`}
            defaultOpen
          >
            <div className="flex flex-col gap-4">
              {coderModels === 0 && <p className="text-sm text-muted-foreground">No finished attempts.</p>}
              {Object.entries(board.coder).map(([model, s]) => (
                <ModelGroup key={model} model={model}>
                  <Row label="Attempts" value={s.attempts} />
                  <Row label="First-attempt acceptance" value={percent(s.firstAttemptAcceptance)} />
                  <Row label="Attempts per accepted task" value={decimal(s.attemptsPerAcceptedTask)} />
                  <Row label="Missing report" value={percent(s.missingReportRate)} />
                  <Row label="Proof pass rate" value={percent(s.proofPassRate)} />
                  <Row label="Cost per accepted task" value={dollars(s.costPerAcceptedTask)} />
                  <Row label="Median duration" value={decimal(s.medianDurationMin, " min")} />
                </ModelGroup>
              ))}
            </div>
          </PanelSection>

          <PanelSection
            title="Foreman"
            summary={`${board.foreman.verdicts} verdict${board.foreman.verdicts === 1 ? "" : "s"}`}
            defaultOpen
          >
            <div className="flex flex-col gap-1.5">
              <Row label="Verdicts" value={board.foreman.verdicts} />
              <Row label="Escalation rate" value={percent(board.foreman.escalationRate)} />
              <Row label="Revise rate" value={percent(board.foreman.reviseRate)} />
              <Row label="Accepts overruled by reviewer" value={percent(board.foreman.acceptsOverruledByReviewer)} />
            </div>
          </PanelSection>

          <PanelSection
            title="Reviewers"
            summary={`${reviewerModels} model${reviewerModels === 1 ? "" : "s"}`}
          >
            <div className="flex flex-col gap-4">
              {reviewerModels === 0 && <p className="text-sm text-muted-foreground">No finished reviews.</p>}
              {Object.entries(board.reviewer).map(([model, s]) => (
                <ModelGroup key={model} model={model}>
                  <Row label="Goals reviewed" value={s.goalsReviewed} />
                  <Row label="Rounds" value={s.rounds} />
                  <Row label="Approvals" value={s.approvals} />
                  <Row label="Changes requested" value={s.changesRequested} />
                  <Row
                    label="Findings (blocker / major / minor)"
                    value={`${s.findings.blocker} / ${s.findings.major} / ${s.findings.minor}`}
                  />
                  <Row label="Approved, then vetoed or blocked" value={s.approvedButVetoedOrBlocked} />
                </ModelGroup>
              ))}
            </div>
          </PanelSection>
        </>
      )}

      <p className="text-xs text-muted-foreground">
        Advisory only: computed from the orchestrator's state on each read, never stored.
      </p>
    </div>
  )
}

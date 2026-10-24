import * as React from "react"
import {
  ActivityIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  GitMergeIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldXIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Goal, Holdouts, Observe } from "@/lib/orchestra"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"

const REVIEW_STATUS: Record<NonNullable<Goal["review"]>["status"], { label: string; tone: string }> = {
  pending: { label: "Queued", tone: "text-muted-foreground" },
  running: { label: "Reviewing", tone: "text-tone-violet" },
  approved: { label: "Approved", tone: "text-tone-green" },
  changes_requested: { label: "Changes requested", tone: "text-tone-amber" },
  failed: { label: "Review failed", tone: "text-destructive" },
}

const SEVERITY: Record<"blocker" | "major" | "minor", { className: string; variant?: "destructive" | "outline" }> = {
  blocker: { className: "", variant: "destructive" },
  major: { className: "border-attention/40 bg-tone-amber-soft text-tone-amber", variant: "outline" },
  minor: { className: "text-muted-foreground", variant: "outline" },
}

// Re-renders once a second while `active`, so the veto countdown stays live.
function useNow(active: boolean) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function formatRemaining(ms: number) {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, "0")}`
}

export function ReviewBlock({ review }: { review: NonNullable<Goal["review"]> }) {
  const status = REVIEW_STATUS[review.status]
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-background/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">Independent review</span>
        <span className={cn("font-medium", status.tone)}>{status.label}</span>
        <Badge variant="outline">round {review.round}</Badge>
        <Badge variant="outline">{review.model}</Badge>
        {review.headSha && <Badge variant="outline" className="font-mono">{review.headSha.slice(0, 7)}</Badge>}
      </div>
      {review.summary && <p className="text-muted-foreground">{review.summary}</p>}
      {review.findings && review.findings.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {review.findings.map((finding, index) => (
            <li key={index} className="flex flex-wrap items-start gap-1.5">
              <Badge variant={SEVERITY[finding.severity].variant} className={SEVERITY[finding.severity].className}>
                {finding.severity}
              </Badge>
              {finding.file && <span className="font-mono text-muted-foreground">{finding.file}</span>}
              <span className="min-w-0 flex-1">{finding.note}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const HOLDOUT_STATUS: Record<Holdouts["status"], string> = {
  pending: "examiner starting",
  running: "examiner writing",
  ready: "written",
  failed: "examiner failed",
}

/** The examiner's hidden checks, in full: the owner is the only one who sees the commands. */
export function HoldoutsBlock({ goal, holdouts }: { goal: Goal; holdouts: Holdouts }) {
  const results = new Map((holdouts.lastRun?.results ?? []).map((r) => [r.index, r]))
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-background/60 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">Holdouts</span>
        <span className="text-muted-foreground">{HOLDOUT_STATUS[holdouts.status]}</span>
        <Badge variant="outline">{holdouts.model}</Badge>
        {holdouts.lastRun && (
          <Badge variant="outline" className={holdouts.lastRun.passed ? "text-tone-green" : "text-destructive"}>
            {holdouts.lastRun.passed ? "passed" : "failed"}
            {holdouts.lastRun.headSha && ` at ${holdouts.lastRun.headSha.slice(0, 7)}`}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground">Hidden from the coder and the foreman. They run on the branch head before review.</p>
      {holdouts.checks && holdouts.checks.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {holdouts.checks.map((check, index) => {
            const result = results.get(index)
            const passed = result && result.exitCode === 0 && !result.timedOut
            return (
              <li key={index} className="flex items-start gap-2">
                {!result ? (
                  <span className="mt-px size-3.5 shrink-0" />
                ) : passed ? (
                  <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-tone-green" aria-label="Holdout passed" />
                ) : (
                  <CircleXIcon className="mt-px size-3.5 shrink-0 text-destructive" aria-label="Holdout failed" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="break-words">
                    #{check.criterionIndex} {goal.acceptance[check.criterionIndex]}
                  </span>
                  <code className="font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">{check.command}</code>
                  {result && !passed && result.output && (
                    <pre className="max-h-40 overflow-auto rounded bg-muted p-1.5 font-mono text-[11px] whitespace-pre-wrap">{result.output}</pre>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {holdouts.uncheckable && holdouts.uncheckable.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium">Not checkable by a command (judge these yourself)</span>
          <ul className="flex flex-col gap-1 text-muted-foreground">
            {holdouts.uncheckable.map((u) => (
              <li key={u.criterionIndex}>
                #{u.criterionIndex} {goal.acceptance[u.criterionIndex]}: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

export function GateBlock({ gate }: { gate: NonNullable<Goal["gate"]> }) {
  const passed = gate.checks.every((check) => check.ok)
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-background/60 p-3 text-xs">
      <div className="flex items-center gap-1.5">
        {passed ? <ShieldCheckIcon className="size-4 text-tone-green" /> : <ShieldXIcon className="size-4 text-destructive" />}
        <span className="font-medium">Merge gate</span>
        <span className="text-muted-foreground">{passed ? "all checks passed" : "not ready"}</span>
      </div>
      <ul className="flex flex-col gap-1">
        {gate.checks.map((check) => (
          <li key={check.name} className="flex items-start gap-2">
            {check.ok ? (
              <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-tone-green" aria-label="passed" />
            ) : (
              <CircleXIcon className="mt-px size-3.5 shrink-0 text-destructive" aria-label="failed" />
            )}
            <span className="flex min-w-0 flex-col">
              <span>{check.name}</span>
              <span className="text-muted-foreground">{check.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function MergeBlock({ goal, onChanged }: { goal: Goal; onChanged: () => void }) {
  const merge = goal.merge
  const waiting = merge?.status === "waiting"
  const mergeAt = merge?.mergeAt ? Date.parse(merge.mergeAt) : undefined
  const now = useNow(waiting)
  const [busy, setBusy] = React.useState(false)
  if (!merge) return null

  const PrLink = (
    <a href={merge.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
      PR #{merge.pr} <ExternalLinkIcon className="size-3" />
    </a>
  )

  if (!waiting) {
    // A rolled-back merge is reverted in production, so it must not read as a success.
    const rolledBack = goal.status === "rolled_back"
    const tone =
      merge.status === "merged" && !rolledBack
        ? "bg-tone-green-soft text-tone-green"
        : merge.status === "vetoed"
          ? "bg-tone-amber-soft text-tone-amber"
          : "bg-destructive/10 text-destructive"
    const label = rolledBack
      ? "Merged, then rolled back"
      : merge.status === "merged"
        ? "Merged"
        : merge.status === "vetoed"
          ? "Vetoed"
          : "Merge blocked"
    return (
      <p className={cn("flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-sm", tone)}>
        <GitMergeIcon className="size-4" />
        <span className="font-medium">{label}.</span>
        {PrLink}
        {merge.note && <span className="text-xs opacity-80">{merge.note}</span>}
      </p>
    )
  }

  const remaining = mergeAt === undefined ? undefined : mergeAt - now
  const due = remaining !== undefined && remaining <= 0

  async function veto() {
    if (!window.confirm(`Veto the merge of "${goal.title}"? The agent will not merge this PR.`)) return
    const reason = window.prompt("Why are you vetoing? (optional)")
    if (reason === null) return
    setBusy(true)
    try {
      const { message } = await api<{ message: string }>(`/api/goals/${goal.id}/veto`, {
        method: "POST",
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      })
      toast.success(message)
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border border-attention/40 bg-tone-amber-soft p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-1.5 font-medium text-tone-amber">
            <ShieldAlertIcon className="size-4" />
            {due ? "Merging now…" : `Merging in ${formatRemaining(remaining ?? 0)}`}
          </span>
          <span className="text-xs text-muted-foreground">{PrLink} is ready. You can veto before it merges.</span>
        </div>
        <Button size="sm" variant="destructive" onClick={() => void veto()} disabled={busy}>
          {busy ? <Spinner /> : <ShieldXIcon />} Veto merge
        </Button>
      </div>
    </section>
  )
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

function ObserveChecks({ checks }: { checks: Observe["checks"] }) {
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {checks.map((check, index) => (
        <li key={`${check.at}-${check.name}-${index}`} className="flex items-start gap-2">
          {check.ok ? (
            <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-tone-green" aria-label="passed" />
          ) : (
            <CircleXIcon className="mt-px size-3.5 shrink-0 text-destructive" aria-label="failed" />
          )}
          <span className="flex min-w-0 flex-col">
            <span>{check.name}</span>
            <span className="text-muted-foreground">{check.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

// Post-merge watch on production. Renders the live window, then the outcome.
export function ObserveBlock({ observe }: { observe: Observe }) {
  const observing = observe.result === undefined
  const now = useNow(observing)
  const sha = (
    <Badge variant="outline" className="font-mono">
      {observe.mergeSha.slice(0, 7)}
    </Badge>
  )
  const latest = [...observe.checks].reverse().slice(0, 6)
  const checksToggle = observe.checks.length > 0 && (
    <Collapsible className="text-xs">
      <CollapsibleTrigger className="underline underline-offset-2 opacity-80">
        Checks ({observe.checks.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <ObserveChecks checks={[...observe.checks].reverse()} />
      </CollapsibleContent>
    </Collapsible>
  )

  if (observe.result === "healthy") {
    const minutes = Math.round((Date.parse(observe.until) - Date.parse(observe.startedAt)) / 60000)
    return (
      <section className="flex flex-col gap-2 rounded-xl bg-tone-green-soft px-3 py-2 text-sm text-tone-green">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldCheckIcon className="size-4" />
          <span className="font-medium">Observed {minutes} min, healthy.</span>
          {sha}
        </div>
        {checksToggle}
      </section>
    )
  }

  if (observe.result === "warnings") {
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-attention/40 bg-tone-amber-soft p-3 text-sm text-tone-amber">
        <div className="flex flex-wrap items-center gap-2">
          <ShieldAlertIcon className="size-4" />
          <span className="font-medium">Observed with warnings.</span>
          {sha}
        </div>
        <ul className="flex list-disc flex-col gap-1 pl-4 text-xs">
          {observe.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
        {observe.followUpGoalId && (
          <p className="text-xs">
            Follow-up goal: <span className="font-mono">{observe.followUpGoalId}</span>
          </p>
        )}
        {checksToggle}
      </section>
    )
  }

  if (observe.result === "rolled_back") {
    return (
      <section className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2 font-medium text-destructive">
          <ShieldXIcon className="size-4" />
          <span>Rolled back after the merge.</span>
          {sha}
        </div>
        {observe.p0 && <p className="text-xs">{observe.p0}</p>}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          {observe.rollback && (
            <a
              href={observe.rollback.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              Revert PR #{observe.rollback.pr} <ExternalLinkIcon className="size-3" />
            </a>
          )}
          {observe.followUpGoalId && (
            <span>
              Fix goal: <span className="font-mono">{observe.followUpGoalId}</span>
            </span>
          )}
        </div>
        {checksToggle}
      </section>
    )
  }

  if (observe.result === "superseded") {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <ActivityIcon className="size-3.5" />
        Observation handed to a newer merge.
        {sha}
      </p>
    )
  }

  const remaining = Date.parse(observe.until) - now
  const deployed = observe.deployedAt !== undefined
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-sky-500/40 bg-tone-blue-soft p-3 text-sm">
      <div className="flex flex-col gap-0.5">
        <span className="flex items-center gap-1.5 font-medium text-tone-blue">
          <ActivityIcon className="size-4" />
          {remaining <= 0 ? "Finishing the watch…" : `Watching production for ${formatRemaining(remaining)}`}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {deployed ? <span>Deployed ✓ at {clock(observe.deployedAt!)}</span> : <span>Waiting for the deploy…</span>}
          <span>·</span>
          <span className="font-mono">{observe.mergeSha.slice(0, 7)}</span>
          {observe.boots > 0 && (
            <>
              <span>·</span>
              <span>
                {observe.boots} agent restart{observe.boots === 1 ? "" : "s"}
              </span>
            </>
          )}
        </span>
      </div>
      {observe.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-tone-amber">
          {observe.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      {latest.length > 0 && <ObserveChecks checks={latest} />}
    </section>
  )
}

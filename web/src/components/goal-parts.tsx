import * as React from "react"
import {
  ArchiveIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleHelpIcon,
  CircleXIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  SearchCheckIcon,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Attempt, Goal, GoalStatus, Proof, Task, TaskStatus } from "@/lib/orchestra"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Spinner } from "@/components/ui/spinner"

export const GOAL_STATUS: Record<GoalStatus, { label: string; tone: string }> = {
  planning: { label: "Planning", tone: "bg-tone-blue-soft text-tone-blue" },
  awaiting_approval: { label: "Needs approval", tone: "bg-tone-amber-soft text-tone-amber" },
  active: { label: "In progress", tone: "bg-tone-violet-soft text-tone-violet" },
  blocked: { label: "Needs you", tone: "bg-tone-amber-soft text-tone-amber" },
  reviewing: { label: "Independent review", tone: "bg-tone-violet-soft text-tone-violet" },
  delivering: { label: "Delivering", tone: "bg-tone-blue-soft text-tone-blue" },
  merging: { label: "Veto window", tone: "bg-tone-amber-soft text-tone-amber" },
  observing: { label: "Observing production", tone: "bg-tone-blue-soft text-tone-blue" },
  rolled_back: { label: "Rolled back", tone: "bg-destructive/15 text-destructive" },
  done: { label: "Done", tone: "bg-tone-green-soft text-tone-green" },
  cancelled: { label: "Cancelled", tone: "bg-muted text-muted-foreground" },
  paused: { label: "Paused", tone: "bg-tone-grey-soft text-tone-grey" },
  retired: { label: "Retired", tone: "bg-muted text-muted-foreground" },
}

// Goals the owner can pause: nothing new starts while paused. Paused goals resume to pausedFrom.
const PAUSABLE: GoalStatus[] = ["planning", "awaiting_approval", "active", "blocked", "reviewing", "delivering", "merging"]

// Goals the owner can retire (close) after a false alarm or once the work is finished.
const RETIRABLE: GoalStatus[] = ["blocked", "rolled_back", "observing", "paused"]

// Statuses that count as finished: the panel lists these apart from open goals.
const FINISHED: GoalStatus[] = ["done", "cancelled", "retired"]

const TASK_ICON: Record<TaskStatus, { icon: LucideIcon; className: string; label: string }> = {
  pending: { icon: CircleDashedIcon, className: "text-muted-foreground", label: "Pending" },
  queued: { icon: CircleDotIcon, className: "text-tone-blue", label: "Queued for your machine" },
  running: { icon: LoaderCircleIcon, className: "animate-spin text-tone-violet", label: "Coding agent at work" },
  review: { icon: SearchCheckIcon, className: "text-tone-violet", label: "Foreman reviewing evidence" },
  accepted: { icon: CircleCheckIcon, className: "text-tone-green", label: "Accepted" },
  escalated: { icon: CircleHelpIcon, className: "text-tone-amber", label: "Waiting for you" },
  cancelled: { icon: CircleXIcon, className: "text-muted-foreground", label: "Cancelled" },
}

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}

export function ProofRow({ proof }: { proof: Proof }) {
  const passed = proof.exitCode === 0 && !proof.timedOut
  return (
    <Collapsible className="rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-muted/50">
        {passed ? (
          <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-tone-green" aria-label="Proof passed" />
        ) : (
          <CircleXIcon className="mt-px size-3.5 shrink-0 text-destructive" aria-label="Proof failed" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="break-words">{proof.criterion}</span>
          <code className="font-mono text-[11px] break-all whitespace-pre-wrap text-muted-foreground">{proof.command}</code>
        </span>
        <span className={cn("shrink-0 text-[11px]", passed ? "text-tone-green" : "text-destructive")}>
          {passed ? "pass" : proof.timedOut ? "timed out" : `exit ${proof.exitCode}`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 pb-2">
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>expect: {proof.expect}</CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-40">
            {proof.output.slice(-3000) || "(no output)"}
          </CodeBlockContent>
        </CodeBlock>
      </CollapsibleContent>
    </Collapsible>
  )
}

// One attempt at a task. The header states the outcome in a line; the evidence opens on demand. Only the newest attempt starts open.
function AttemptView({ attempt, defaultOpen }: { attempt: Attempt; defaultOpen: boolean }) {
  const e = attempt.evidence
  const verdict = attempt.verdict
  const outcome = verdict
    ? verdict.decision === "accept"
      ? "accepted"
      : verdict.decision === "revise"
        ? "sent back"
        : "escalated"
    : attempt.error
      ? "error"
      : attempt.pendingEvidence ? "evidence queued" : attempt.unbudgeted ? "stopped" : e
        ? "reviewing"
        : "running"
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex min-w-0 flex-col gap-2 rounded-xl border bg-background/60 p-3 text-xs">
      <CollapsibleTrigger className="group flex min-w-0 flex-wrap items-center gap-1.5 text-left">
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform -rotate-90 group-aria-expanded:rotate-0" />
        <Badge variant="outline">execution {attempt.n}</Badge>
        {attempt.unbudgeted && <Badge variant="outline">No coding retry used</Badge>}
        <span className="min-w-0 truncate text-muted-foreground">{attempt.coder}</span>
        {e?.costUsd !== undefined && <span className="text-muted-foreground">${e.costUsd.toFixed(2)}</span>}
        <span className={cn("text-muted-foreground", attempt.error && "text-destructive")}>· {outcome}</span>
        {!e && !attempt.error && <span className="text-muted-foreground">started {ago(attempt.claimedAt)}</span>}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex min-w-0 flex-col gap-2">
        {e && <span className="text-muted-foreground">{Math.round(e.durationMs / 60000)} min</span>}
      {attempt.error && <p className="text-destructive">{attempt.error}</p>}
      {e && (
        <>
          {e.report ? (
            <p>
              <span className="font-medium">Coder says ({e.report.status}):</span> {e.report.summary}
            </p>
          ) : (
            <p className="text-destructive">No report. {e.agentError}</p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={e.commits.length ? "secondary" : "destructive"}>
              {e.commits.length} commit{e.commits.length === 1 ? "" : "s"}
            </Badge>
            {e.verify ? (
              <Badge
                variant={e.verify.exitCode === 0 ? "secondary" : "destructive"}
                className="h-auto max-w-full text-left break-all whitespace-normal"
              >
                {e.verify.command}: {e.verify.exitCode === 0 ? "passed" : `exit ${e.verify.exitCode}`}
              </Badge>
            ) : (
              <Badge variant="outline">no verify command</Badge>
            )}
          </div>
          {e.proofs && e.proofs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground">
                Proofs: {e.proofs.filter((p) => p.exitCode === 0 && !p.timedOut).length}/{e.proofs.length} passed
              </span>
              {e.proofs.map((proof, index) => (
                <ProofRow key={index} proof={proof} />
              ))}
            </div>
          )}
          {e.diffStat && (
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle>diff --stat</CodeBlockTitle>
              </CodeBlockHeader>
              <CodeBlockContent wrap className="max-h-40">
                {e.diffStat}
              </CodeBlockContent>
            </CodeBlock>
          )}
          {e.verify && e.verify.exitCode !== 0 && (
            <CodeBlock size="sm">
              <CodeBlockHeader>
                <CodeBlockTitle>verify output</CodeBlockTitle>
              </CodeBlockHeader>
              <CodeBlockContent wrap className="max-h-40">
                {e.verify.output.slice(-3000)}
              </CodeBlockContent>
            </CodeBlock>
          )}
        </>
      )}
      {verdict && (
        <p
          className={cn(
            "rounded-lg px-2.5 py-1.5",
            verdict.decision === "accept" && "bg-tone-green-soft text-tone-green",
            verdict.decision === "revise" && "bg-tone-violet-soft text-tone-violet",
            verdict.decision === "escalate" && "bg-tone-amber-soft text-tone-amber",
          )}
        >
          <span className="font-medium">
            Foreman: {verdict.decision === "accept" ? "accepted" : verdict.decision === "revise" ? "sent back" : "escalated"}.
          </span>{" "}
          {verdict.feedback}
        </p>
      )}
      </CollapsibleContent>
    </Collapsible>
  )
}

export function TaskRow({ task, index }: { task: Task; index: number }) {
  const { icon: Icon, className, label } = TASK_ICON[task.status]
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-start gap-2.5 rounded-lg px-1 py-1.5 text-left hover:bg-muted/50">
        <Icon className={cn("mt-0.5 size-4 shrink-0", className)} aria-label={label} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className={cn("text-sm", task.status === "cancelled" && "line-through opacity-60")}>
            {index + 1}. {task.title}
          </span>
          <span className="text-xs text-muted-foreground">
            {label}
            {task.attempts.length > 0 && ` · ${task.attempts.filter((a) => !a.unbudgeted).length}/${task.maxAttempts} coding attempts · ${task.attempts.length} executions`} · {task.coder}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 pt-1 pb-2 pl-7">
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">{task.instructions}</p>
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {task.acceptance.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
        {[...task.attempts].reverse().map((attempt, i) => (
          <AttemptView key={attempt.n} attempt={attempt} defaultOpen={i === 0} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

// Pause, resume, retire and cancel: the owner's controls over a goal's lifecycle.
export function GoalActions({ goal, onChanged }: { goal: Goal; onChanged: () => void }) {
  const [busy, setBusy] = React.useState<string>()
  if (FINISHED.includes(goal.status)) return null

  async function act(action: "approve" | "cancel" | "pause" | "resume" | "retire") {
    if (action === "cancel" && !window.confirm(`Cancel "${goal.title}"? A running task is stopped.`)) return
    let init: RequestInit = { method: "POST" }
    if (action === "pause" || action === "retire") {
      const reason = window.prompt(action === "pause" ? "Why pause? (optional)" : "Why retire? e.g. false alarm, work is merged")
      if (reason === null) return
      init = { method: "POST", body: JSON.stringify({ reason: reason.trim() || undefined }) }
    }
    setBusy(action)
    try {
      const { message } = await api<{ message: string }>(`/api/goals/${goal.id}/${action}`, init)
      toast.success(message)
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      {goal.status === "paused" && (
        <Button size="sm" onClick={() => void act("resume")} disabled={busy !== undefined}>
          {busy === "resume" ? <Spinner /> : <PlayIcon />} Resume
        </Button>
      )}
      {PAUSABLE.includes(goal.status) && (
        <Button size="sm" variant="outline" onClick={() => void act("pause")} disabled={busy !== undefined}>
          {busy === "pause" ? <Spinner /> : <PauseIcon />} Pause
        </Button>
      )}
      {RETIRABLE.includes(goal.status) && (
        <Button size="sm" variant="outline" onClick={() => void act("retire")} disabled={busy !== undefined}>
          {busy === "retire" ? <Spinner /> : <ArchiveIcon />} Retire
        </Button>
      )}
      <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => void act("cancel")} disabled={busy !== undefined}>
        {busy === "cancel" ? <Spinner /> : <CircleXIcon />} Cancel goal
      </Button>
    </div>
  )
}

/** Approve the foreman's plan. */
export async function approvePlan(goal: Goal, onChanged: () => void) {
  try {
    const { message } = await api<{ message: string }>(`/api/goals/${goal.id}/approve`, { method: "POST" })
    toast.success(message)
    onChanged()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  }
}

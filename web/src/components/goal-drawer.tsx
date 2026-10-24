import * as React from "react"
import { ArrowUpIcon, ExternalLinkIcon, XIcon } from "lucide-react"

import { askReason, repoName, STATUS_LINE, tasksDone } from "@/lib/board"
import type { Goal, OrchestraState } from "@/lib/orchestra"
import { needsOwner } from "@/lib/orchestra"
import { useSendToOwner } from "@/lib/owner-thread"
import { clock } from "@/lib/telemetry"
import { cn } from "@/lib/utils"
import { Chat } from "@/components/chat/chat"
import { GateBlock, HoldoutsBlock, MergeBlock, ObserveBlock, ReviewBlock } from "@/components/goal-delivery"
import { approvePlan, GoalActions, TaskRow } from "@/components/goal-parts"
import { Spinner } from "@/components/ui/spinner"

type Tab = "thread" | "tasks" | "evidence"

// The drawer beside the Board. It holds one goal (thread, tasks, evidence), the general thread, or the new-goal form.
// Below lg it covers the screen.
export function GoalDrawer({
  id,
  state,
  needing,
  onClose,
  onOpen,
  onChanged,
  onRunSettled,
}: {
  id: string
  state: OrchestraState | undefined
  needing: Goal[]
  onClose: () => void
  onOpen: (id: string) => void
  onChanged: () => void
  onRunSettled: () => void
}) {
  const goal = state?.goals.find((g) => g.id === id)
  const escape = React.useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape" && !(event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)) onClose()
  }, [onClose])

  let header: { kicker: string; title: string; status: string; statusClass: string }
  if (id === "general") header = { kicker: "You & agent", title: "General thread", status: "Anything not tied to a goal", statusClass: "text-muted-foreground" }
  else if (id === "new") header = { kicker: "Plan with the foreman", title: "New goal", status: "Nothing runs until you approve the plan", statusClass: "text-muted-foreground" }
  else if (goal) {
    const line = STATUS_LINE[goal.status]
    header = { kicker: `${repoName(goal, state)} · ${goal.branch}`, title: goal.title, status: line.label, statusClass: line.className }
  } else header = { kicker: "", title: state ? "Goal not found" : "Loading…", status: state ? "It may have been removed." : "", statusClass: "text-muted-foreground" }

  return (
    <aside
      aria-label={header.title}
      onKeyDown={escape}
      className="fixed inset-0 z-40 flex flex-col bg-panel lg:static lg:z-auto lg:w-[min(520px,42vw)] lg:min-w-[400px] lg:shrink-0 lg:border-l"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          {header.kicker && <span className="truncate font-mono text-[11px] text-subtle" title={header.kicker}>{header.kicker}</span>}
          <h2 className="text-base leading-snug font-semibold">{header.title}</h2>
          {header.status && <span className={cn("text-xs", header.statusClass)}>{header.status}</span>}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      {id === "general" ? (
        <div className="min-h-0 flex-1">
          <Chat onRunSettled={onRunSettled} needing={needing} />
        </div>
      ) : id === "new" ? (
        <NewGoal state={state} onSent={() => onOpen("general")} />
      ) : goal ? (
        <GoalView key={goal.id} goal={goal} state={state!} onChanged={onChanged} onSent={() => onOpen("general")} />
      ) : null}
    </aside>
  )
}

function GoalView({ goal, state, onChanged, onSent }: { goal: Goal; state: OrchestraState; onChanged: () => void; onSent: () => void }) {
  const [tab, setTab] = React.useState<Tab>("thread")
  const [draft, setDraft] = React.useState("")
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const send = useSendToOwner()
  const { total } = tasksDone(goal)

  const startDraft = (text: string) => {
    setTab("thread")
    setDraft(text)
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(text.length, text.length)
    })
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft("")
    await send(`About the goal "${goal.title}" (${goal.id}): ${text}`)
    onSent()
  }

  const tabs: Array<[Tab, string]> = [["thread", "Thread"], ["tasks", `Tasks · ${total}`], ["evidence", "Evidence"]]
  return (
    <>
      <div role="tablist" aria-label="Goal views" className="flex shrink-0 gap-1 border-b px-5 pb-3">
        {tabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              "h-8 rounded-lg px-3 text-[13px]",
              tab === value ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-5" role="tabpanel">
        {tab === "thread" ? (
          <Thread goal={goal} state={state} onChanged={onChanged} onDraft={startDraft} />
        ) : tab === "tasks" ? (
          goal.tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{goal.status === "planning" ? "The foreman is drafting tasks." : "No tasks."}</p>
          ) : (
            <div className="flex flex-col">
              {goal.tasks.map((task, index) => (
                <TaskRow key={task.id} task={task} index={index} />
              ))}
            </div>
          )
        ) : (
          <Evidence goal={goal} onChanged={onChanged} />
        )}
      </div>
      <form onSubmit={(event) => void submit(event)} className="mx-4 mb-4 flex shrink-0 items-end gap-2 rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-3.5">
        <label htmlFor="goal-reply" className="sr-only">Reply on this goal</label>
        <textarea
          ref={inputRef}
          id="goal-reply"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder="Reply on this goal…"
          className="max-h-40 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-sm outline-none field-sizing-content"
        />
        <button type="submit" aria-label="Send" disabled={!draft.trim()} className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground disabled:opacity-40">
          <ArrowUpIcon className="size-4" />
        </button>
      </form>
      <p className="-mt-2 mb-3 shrink-0 px-5 text-[11px] text-subtle">Replies go to your agent in the general thread, tagged with this goal.</p>
    </>
  )
}

// The goal's story: what you asked for, what the orchestrator recorded along the way, and the decision it needs now.
function Thread({ goal, state, onChanged, onDraft }: { goal: Goal; state: OrchestraState; onChanged: () => void; onDraft: (text: string) => void }) {
  const events = state.events.filter((e) => e.goalId === goal.id)
  let lastLabel = ""
  return (
    <>
      <span className="text-xs text-subtle">You · {clock(goal.createdAt)}</span>
      <div className="max-w-[85%] self-end rounded-[14px_14px_4px_14px] bg-accent px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap">
        {goal.description || goal.title}
      </div>
      {events.length === 0 && goal.status === "planning" && (
        <span className="flex h-7 items-center gap-2 self-start rounded-full border px-2.5 text-xs text-muted-foreground">
          <Spinner className="size-3" /> Foreman drafting a plan
        </span>
      )}
      {events.map((event, index) => {
        const label = `Agent · ${clock(event.at)}`
        const showLabel = label !== lastLabel
        lastLabel = label
        const [first, ...rest] = event.text.split("\n")
        return (
          <React.Fragment key={`${event.at}-${index}`}>
            {showLabel && <span className="text-xs text-subtle">{label}</span>}
            <p className="text-sm break-words text-foreground/90">
              {first}
              {rest.length > 0 && <span className="mt-1 block text-xs whitespace-pre-wrap text-muted-foreground">{rest.join("\n")}</span>}
            </p>
          </React.Fragment>
        )
      })}
      {goal.summary && goal.status === "done" && <p className="text-sm break-words text-foreground/90">{goal.summary}</p>}
      <Decision goal={goal} onChanged={onChanged} onDraft={onDraft} />
    </>
  )
}

function DecisionCard({ title, children, actions }: { title: string; children?: React.ReactNode; actions: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-attention bg-card">
      <div className="border-b px-3.5 py-3 text-[13px] font-semibold">{title}</div>
      {children}
      <div className="flex flex-wrap gap-2 border-t px-3.5 py-2.5">{actions}</div>
    </div>
  )
}

const primary = "h-10 rounded-[10px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
const secondary = "h-10 rounded-[10px] border border-border-strong px-3.5 text-[13px] text-foreground hover:bg-accent inline-flex items-center gap-1.5 no-underline"

// The one thing a goal needs from the owner right now, with the button that does it.
function Decision({ goal, onChanged, onDraft }: { goal: Goal; onChanged: () => void; onDraft: (text: string) => void }) {
  const [busy, setBusy] = React.useState(false)
  const holdouts = goal.holdouts
  const failedRun = holdouts?.lastRun && !holdouts.lastRun.passed ? holdouts.lastRun : undefined
  const waived = new Set((holdouts?.waived ?? []).map((w) => w.index))
  const candidates = (holdouts?.checks ?? [])
    .map((check, index) => ({ check, index, result: failedRun?.results.find((r) => r.index === index) }))
    .filter(({ index }) => !waived.has(index))
  const [picked, setPicked] = React.useState<Set<number>>(
    () => new Set(candidates.filter((c) => c.result && (c.result.exitCode !== 0 || c.result.timedOut)).map((c) => c.index)),
  )

  if (goal.merge?.status === "waiting") return <MergeBlock goal={goal} onChanged={onChanged} />

  if (goal.status === "awaiting_approval") {
    const tasks = goal.tasks.filter((t) => t.status !== "cancelled")
    const errors = goal.preflight?.issues.filter((i) => i.severity === "error").length ?? 0
    return (
      <DecisionCard
        title="Approve the plan?"
        actions={
          <>
            <button type="button" className={primary} disabled={busy} onClick={async () => { setBusy(true); await approvePlan(goal, onChanged); setBusy(false) }}>
              {busy && <Spinner />} Approve plan
            </button>
            <button type="button" className={secondary} onClick={() => onDraft("Change the plan: ")}>Ask for changes</button>
          </>
        }
      >
        <ol className="flex flex-col gap-1 px-3.5 py-3 text-[13px]">
          {tasks.slice(0, 8).map((task, i) => <li key={task.id}>{i + 1}. {task.title}</li>)}
          {tasks.length > 8 && <li className="text-muted-foreground">+{tasks.length - 8} more in Tasks</li>}
        </ol>
        {goal.preflight && (
          <p className={cn("px-3.5 pb-3 text-xs", errors ? "text-tone-red" : "text-muted-foreground")}>
            Preflight: {errors} error{errors === 1 ? "" : "s"} · {goal.preflight.issues.length - errors} warning{goal.preflight.issues.length - errors === 1 ? "" : "s"}
          </p>
        )}
      </DecisionCard>
    )
  }

  if (failedRun && needsOwner(goal) && candidates.length > 0) {
    const chosen = [...picked].sort((a, b) => a - b).map((i) => `#${i}`)
    return (
      <DecisionCard
        title="Which holdouts should I waive?"
        actions={
          <>
            <button
              type="button"
              className={primary}
              disabled={chosen.length === 0}
              onClick={() => onDraft(`Waive holdout${chosen.length === 1 ? "" : "s"} ${chosen.join(", ")}. Reason: `)}
            >
              {chosen.length ? `Waive ${chosen.join(", ")}` : "Select checks to waive"}
            </button>
            <button type="button" className={secondary} onClick={() => onDraft("Don't waive. Fix this instead: ")}>Direct a fix instead</button>
          </>
        }
      >
        {goal.question && <p className="px-3.5 pt-3 text-[13px] text-muted-foreground">{askReason(goal)}</p>}
        <div className="flex flex-col p-1.5">
          {candidates.map(({ check, index, result }) => {
            const passed = result && result.exitCode === 0 && !result.timedOut
            return (
              <label key={index} className="flex min-h-10 cursor-pointer items-center gap-2.5 px-2">
                <input
                  type="checkbox"
                  checked={picked.has(index)}
                  onChange={() => setPicked((all) => { const next = new Set(all); if (next.has(index)) next.delete(index); else next.add(index); return next })}
                  className="size-4 accent-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-[13px]" title={check.command}>#{index} · {check.expect}</span>
                <span className={cn("shrink-0 text-xs", !result ? "text-muted-foreground" : passed ? "text-tone-green" : result.timedOut ? "text-tone-amber" : "text-tone-red")}>
                  {!result ? "Not run" : passed ? "Passed" : result.timedOut ? "Timed out" : "Failed"}
                </span>
              </label>
            )
          })}
        </div>
        <p className="px-3.5 pb-3 text-[11px] text-subtle">This drafts the waiver for you to confirm; the agent records it with your reason.</p>
      </DecisionCard>
    )
  }

  if (goal.merge && goal.merge.status === "blocked" && goal.merge.url && !["done", "cancelled", "retired"].includes(goal.status)) {
    return (
      <DecisionCard
        title={`Merge PR #${goal.merge.pr}?`}
        actions={
          <>
            <a href={goal.merge.url} target="_blank" rel="noreferrer" className={primary + " no-underline"}>Review and merge <ExternalLinkIcon className="size-3.5" /></a>
            <button type="button" className={secondary} onClick={() => onDraft("Before merging, ")}>Direct a change</button>
          </>
        }
      >
        {goal.gate && (
          <ul className="flex flex-wrap gap-1.5 px-3.5 py-3">
            {goal.gate.checks.map((check) => (
              <li key={check.name} title={check.detail} className={cn("rounded-full px-2 py-0.5 text-xs", check.ok ? "bg-tone-green-soft text-tone-green" : "bg-tone-amber-soft text-tone-amber")}>
                {check.ok ? "✓" : "!"} {check.name}
              </li>
            ))}
          </ul>
        )}
        {goal.merge.note && <p className="px-3.5 pb-3 text-xs text-muted-foreground">{goal.merge.note}</p>}
      </DecisionCard>
    )
  }

  const reason = askReason(goal)
  if (reason) {
    return (
      <DecisionCard
        title={goal.question ? "The foreman asks" : "Waiting on you"}
        actions={<button type="button" className={primary} onClick={() => onDraft("")}>Answer</button>}
      >
        <p className="px-3.5 py-3 text-[13px] break-words whitespace-pre-wrap text-foreground/90">{goal.question ?? reason}</p>
      </DecisionCard>
    )
  }
  return null
}

function Fact({ label, value, className }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex justify-between gap-3 rounded-[10px] bg-card px-3 py-2.5">
      <span className="text-[13px] text-soft">{label}</span>
      <span className={cn("text-right text-xs", className)}>{value}</span>
    </div>
  )
}

function Evidence({ goal, onChanged }: { goal: Goal; onChanged: () => void }) {
  const p = goal.preflight
  const errors = p?.issues.filter((i) => i.severity === "error").length ?? 0
  return (
    <>
      {p && (
        <Fact
          label="Plan preflight"
          value={`${errors} errors · ${p.issues.length - errors} warnings · ${p.estimatedDiffChars.toLocaleString()} / ${p.budget.toLocaleString()} chars`}
          className={errors ? "text-tone-red" : "text-tone-green"}
        />
      )}
      {p?.issues.map((issue, i) => (
        <p key={i} className="px-1 text-xs text-muted-foreground">{issue.severity === "error" ? "Fix" : "Check"}{issue.task ? ` task ${issue.task}` : ""}: {issue.message}</p>
      ))}
      {goal.holdouts && <HoldoutsBlock goal={goal} holdouts={goal.holdouts} />}
      {goal.review && <ReviewBlock review={goal.review} />}
      {goal.gate && <GateBlock gate={goal.gate} />}
      {goal.merge && <MergeBlock goal={goal} onChanged={onChanged} />}
      {goal.observe && <ObserveBlock observe={goal.observe} />}
      {goal.delivery?.status === "done" && goal.delivery.result && goal.status !== "rolled_back" && (
        <Fact
          label="Delivered"
          value={goal.delivery.result.startsWith("http") ? <a href={goal.delivery.result} target="_blank" rel="noreferrer">{goal.delivery.result}</a> : goal.delivery.result}
        />
      )}
      {goal.closed && <Fact label="Closed by you" value={goal.closed.reason} className="text-muted-foreground" />}
      {!p && !goal.holdouts && !goal.review && !goal.gate && !goal.merge && !goal.observe && (
        <p className="text-sm text-muted-foreground">Evidence appears as tasks finish: preflight, hidden holdouts, review, gate and merge.</p>
      )}
      <div className="mt-2 border-t pt-4">
        <GoalActions goal={goal} onChanged={onChanged} />
      </div>
    </>
  )
}

function NewGoal({ state, onSent }: { state: OrchestraState | undefined; onSent: () => void }) {
  const [what, setWhat] = React.useState("")
  const projects = state?.projects ?? []
  const [repo, setRepo] = React.useState(projects[0]?.repo ?? "new")
  const send = useSendToOwner()
  const field = "rounded-[10px] border border-input bg-card px-3 text-sm text-foreground outline-none focus:border-border-strong"

  async function plan() {
    const text = what.trim()
    if (!text) return
    const where = repo === "new" ? "in a new project you create" : `in ${repo}`
    await send(`New goal ${where}: ${text}\n\nHave the foreman plan it and show me the plan before any code is written.`)
    onSent()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
      <label htmlFor="ng-what" className="text-[13px] font-semibold">What should the agent get done?</label>
      <textarea id="ng-what" rows={5} value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Describe the outcome, not the steps…" className={cn(field, "resize-y py-2.5")} />
      <label htmlFor="ng-repo" className="text-[13px] font-semibold">Repository</label>
      <select id="ng-repo" value={repo} onChange={(e) => setRepo(e.target.value)} className={cn(field, "h-10")}>
        {projects.map((p) => <option key={p.id} value={p.repo}>{p.repo}</option>)}
        <option value="new">A new project</option>
      </select>
      <span className="text-xs text-muted-foreground">The foreman plans it first. You'll see the plan on the Board before any code is written.</span>
      <button type="button" disabled={!what.trim()} onClick={() => void plan()} className={cn(primary, "self-start px-4")}>
        Plan it
      </button>
    </div>
  )
}

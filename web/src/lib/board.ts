// How a goal reads on the Board: which column it sits in, the one-line preview on its card, its tags, and what (if
// anything) it needs from the owner.

import type { Goal, GoalStatus, OrchestraState } from "./orchestra.ts"
import { needsOwner } from "./orchestra.ts"

export type Column = "needs" | "planning" | "building" | "shipped"
export type Tone = "red" | "amber" | "green" | "grey" | "blue" | "violet"
export type Tag = { label: string; tone: Tone }

export const TONE_CLASS: Record<Tone, string> = {
  red: "bg-tone-red-soft text-tone-red",
  amber: "bg-tone-amber-soft text-tone-amber",
  green: "bg-tone-green-soft text-tone-green",
  grey: "bg-tone-grey-soft text-tone-grey",
  blue: "bg-tone-blue-soft text-tone-blue",
  violet: "bg-tone-violet-soft text-tone-violet",
}

export const COLUMNS: Array<{ id: Column; name: string; className: string; empty: string }> = [
  { id: "needs", name: "Needs you", className: "text-attention-fg", empty: "Nothing needs you." },
  { id: "planning", name: "Planning", className: "text-soft", empty: "Nothing being planned." },
  { id: "building", name: "Building", className: "text-link", empty: "Foreman idle." },
  { id: "shipped", name: "Shipped · 7d", className: "text-ok", empty: "Nothing shipped this week." },
]

export const SHIPPED_DAYS = 7
const CLOSED: GoalStatus[] = ["done", "cancelled", "retired"]
export const isClosed = (goal: Goal) => CLOSED.includes(goal.status)

/** When a closed goal closed: the owner's close time if there is one, else its last update. */
const closedAt = (goal: Goal) => goal.closed?.at ?? goal.updatedAt

export function columnOf(goal: Goal): Column | undefined {
  if (needsOwner(goal) || goal.status === "rolled_back") return "needs"
  if (goal.status === "planning") return "planning"
  if (goal.status === "done") return Date.parse(closedAt(goal)) >= Date.now() - SHIPPED_DAYS * 86_400_000 ? "shipped" : undefined
  if (isClosed(goal)) return undefined
  return "building"
}

export const STATUS_LINE: Record<GoalStatus, { label: string; className: string }> = {
  planning: { label: "Foreman is drafting a plan", className: "text-muted-foreground" },
  awaiting_approval: { label: "Plan ready, waiting for your approval", className: "text-attention-fg" },
  active: { label: "Coding", className: "text-link" },
  blocked: { label: "Waiting on your call", className: "text-attention-fg" },
  reviewing: { label: "Independent review", className: "text-link" },
  delivering: { label: "Gate and delivery", className: "text-link" },
  merging: { label: "Veto window: merging soon", className: "text-attention-fg" },
  observing: { label: "Merged, watching production", className: "text-link" },
  rolled_back: { label: "Rolled back after merge", className: "text-tone-red" },
  done: { label: "Done", className: "text-ok" },
  cancelled: { label: "Cancelled", className: "text-muted-foreground" },
  paused: { label: "Paused", className: "text-muted-foreground" },
  retired: { label: "Retired", className: "text-muted-foreground" },
}

/** The first sentence of the foreman's question, without the goal title it usually opens with. */
export function concise(question: string, title: string): string {
  let text = question.trim()
  for (const quoted of [`"${title}"`, `“${title}”`, title]) if (text.startsWith(quoted)) text = text.slice(quoted.length)
  text = text.replace(/^[\s:,.\-–—]+/, "")
  const sentence = /^[\s\S]+?[.!?](?=\s+[A-Z(]|\s*$)/.exec(text)?.[0] ?? text
  const clipped = sentence.length > 200 ? `${sentence.slice(0, 199).trimEnd()}…` : sentence
  return clipped.charAt(0).toUpperCase() + clipped.slice(1)
}

/** Why a waiting goal is stuck, in a sentence. Undefined when it is not waiting on the owner. */
export function askReason(goal: Goal): string | undefined {
  if (goal.status === "rolled_back") return goal.observe?.p0 ? `Rolled back: ${concise(goal.observe.p0, goal.title)}` : "Rolled back after merge."
  if (!needsOwner(goal)) return undefined
  if (goal.status === "awaiting_approval") {
    const tasks = goal.tasks.filter((t) => t.status !== "cancelled").length
    return `The plan${tasks ? ` (${tasks} task${tasks === 1 ? "" : "s"})` : ""} is ready. Nothing starts until you approve it.`
  }
  if (goal.question) return concise(goal.question, goal.title)
  const failed = goal.gate?.checks.filter((c) => !c.ok) ?? []
  if (failed.length) return `The merge gate failed: ${failed.map((c) => c.name).join(", ")}.`
  if (goal.review?.status === "changes_requested") return "The independent reviewer requested changes."
  return "The foreman stopped and is waiting for you."
}

export const tasksDone = (goal: Goal) => {
  const counted = goal.tasks.filter((t) => t.status !== "cancelled")
  return { accepted: counted.filter((t) => t.status === "accepted").length, total: counted.length }
}

export function preview(goal: Goal): string {
  const ask = askReason(goal)
  if (ask) return ask
  switch (goal.status) {
    case "planning":
      return "Foreman drafting a plan"
    case "active": {
      const running = goal.tasks.find((t) => t.status === "running" || t.status === "review")
      return running ? `Coder: ${running.title}` : "Tasks queued"
    }
    case "reviewing":
      return `Independent review${goal.review ? ` · round ${goal.review.round}` : ""}`
    case "delivering":
      return "Running the merge gate"
    case "merging":
      return goal.merge ? `PR #${goal.merge.pr} merges unless you veto` : "Merging"
    case "observing":
      return "Merged · watching production"
    case "paused":
      return goal.pausedFrom ? `Paused · resumes as ${goal.pausedFrom.replace("_", " ")}` : "Paused"
    case "done":
      return goal.merge?.status === "merged" ? `PR #${goal.merge.pr} merged` : goal.summary ? concise(goal.summary, goal.title) : "Done"
    default:
      return STATUS_LINE[goal.status].label
  }
}

export function tags(goal: Goal): Tag[] {
  const out: Tag[] = []
  const lastRun = goal.holdouts?.lastRun
  if (goal.status === "awaiting_approval") out.push({ label: "plan ready", tone: "amber" })
  if (goal.status === "rolled_back") out.push({ label: "rolled back", tone: "red" })
  if (lastRun && goal.holdouts?.checks?.length) {
    const passed = lastRun.results.filter((r) => r.exitCode === 0 && !r.timedOut).length
    out.push({ label: `Holdouts ${passed}/${lastRun.results.length}`, tone: lastRun.passed ? "green" : "red" })
  }
  if (goal.review?.status === "changes_requested") out.push({ label: `changes ×${goal.review.round}`, tone: "amber" })
  if (goal.gate) {
    const ok = goal.gate.checks.filter((c) => c.ok).length
    out.push({ label: `${ok}/${goal.gate.checks.length} gates`, tone: ok === goal.gate.checks.length ? "green" : "red" })
  }
  if (goal.merge?.status === "merged" && goal.status !== "rolled_back") out.push({ label: "merged", tone: "green" })
  else if (goal.merge?.status === "waiting") out.push({ label: "veto window", tone: "amber" })
  if (goal.status === "paused") out.push({ label: "paused", tone: "grey" })
  const { accepted, total } = tasksDone(goal)
  if (total > 0 && goal.status !== "done") out.push({ label: `${accepted}/${total} tasks`, tone: "grey" })
  return out
}

/** The short repository name a goal works in, e.g. "pi-durable-personal-agent". */
export function repoName(goal: Goal, state: OrchestraState | undefined): string {
  const repo = state?.projects.find((p) => p.id === goal.projectId)?.repo
  return repo ? repo.split("/").pop()! : goal.projectId
}

/** Goals grouped by column, waiting goals newest first and the rest in creation order so cards hold still. */
export function boardColumns(state: OrchestraState | undefined): Record<Column, Goal[]> {
  const out: Record<Column, Goal[]> = { needs: [], planning: [], building: [], shipped: [] }
  for (const goal of state?.goals ?? []) {
    const column = columnOf(goal)
    if (column) out[column].push(goal)
  }
  out.needs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  out.planning.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  out.building.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  out.shipped.sort((a, b) => closedAt(b).localeCompare(closedAt(a)))
  return out
}

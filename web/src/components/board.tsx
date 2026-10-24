import * as React from "react"

import { boardColumns, COLUMNS, type Column, preview, repoName, tags, TONE_CLASS } from "@/lib/board"
import type { Goal, OrchestraState } from "@/lib/orchestra"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

// The Board: every open goal as a card in the column that says what it is waiting on: you, the foreman's plan, the
// builders, or nothing (shipped this week). Opening a card shows its thread beside the board.
export function Board({
  state,
  selected,
  onOpen,
  drawer,
}: {
  state: OrchestraState | undefined
  selected?: string
  onOpen: (id: string) => void
  drawer?: React.ReactNode
}) {
  const columns = React.useMemo(() => boardColumns(state), [state])
  const open = columns.needs.length + columns.planning.length + columns.building.length

  return (
    <div className="flex h-full min-h-0">
      <section aria-label="Goals board" className="flex min-w-0 flex-1 flex-col gap-[18px] overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col">
            <h1 className="text-[22px] font-semibold">Board</h1>
            <span className="text-muted-foreground">
              {state ? `${open} goal${open === 1 ? "" : "s"} open · ${columns.needs.length} need${columns.needs.length === 1 ? "s" : ""} you` : "Loading goals…"}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onOpen("general")}
              className={cn(
                "h-9 rounded-lg border border-input px-3 text-[13px] text-soft hover:bg-accent",
                selected === "general" && "border-attention bg-raised text-foreground",
              )}
            >
              General thread
            </button>
            <button
              type="button"
              onClick={() => onOpen("new")}
              className="h-9 rounded-lg bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:opacity-90"
            >
              + New goal
            </button>
          </div>
        </div>

        {!state ? (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3.5">
            {COLUMNS.map((c) => (
              <Skeleton key={c.id} className="h-32 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] items-start gap-3.5">
            {COLUMNS.map((column) => (
              <BoardColumn key={column.id} column={column} goals={columns[column.id]} state={state} selected={selected} onOpen={onOpen} />
            ))}
          </div>
        )}
      </section>
      {drawer}
    </div>
  )
}

function BoardColumn({
  column,
  goals,
  state,
  selected,
  onOpen,
}: {
  column: (typeof COLUMNS)[number]
  goals: Goal[]
  state: OrchestraState
  selected?: string
  onOpen: (id: string) => void
}) {
  // Shipped grows every day, so it shows the newest few; the open goal stays visible even when it is further down.
  const [expanded, setExpanded] = React.useState(false)
  const limit = column.id === "shipped" ? SHIPPED_PREVIEW : Infinity
  const shown = expanded ? goals : goals.filter((goal, index) => index < limit || goal.id === selected)
  const hidden = goals.length - Math.min(goals.length, limit)
  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex items-center justify-between px-1">
        <h2 className={cn("text-[13px] font-semibold", column.className)}>{column.name}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{goals.length}</span>
      </div>
      {goals.length === 0 ? (
        <div className="rounded-xl border border-dashed p-3.5 text-xs text-muted-foreground">{column.empty}</div>
      ) : (
        shown.map((goal) => (
          <GoalCard key={goal.id} goal={goal} column={column.id} repo={repoName(goal, state)} selected={selected === goal.id} onOpen={() => onOpen(goal.id)} />
        ))
      )}
      {hidden > 0 && <ShowMore expanded={expanded} hidden={hidden} onToggle={() => setExpanded((v) => !v)} />}
    </div>
  )
}

const SHIPPED_PREVIEW = 5

/** "Show 17 more" / "Show less" under a capped list. */
export function ShowMore({ expanded, hidden, onToggle }: { expanded: boolean; hidden: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className="h-9 rounded-lg border border-dashed text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
    >
      {expanded ? "Show less" : `Show ${hidden} more`}
    </button>
  )
}

function GoalCard({ goal, column, repo, selected, onOpen }: { goal: Goal; column: Column; repo: string; selected: boolean; onOpen: () => void }) {
  const dim = goal.status === "paused"
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected || undefined}
      className={cn(
        "flex flex-col gap-2 rounded-xl p-3 text-left transition-colors",
        selected
          ? "border-[1.5px] border-attention bg-raised"
          : dim
            ? "border border-dashed border-border-strong bg-transparent hover:bg-card"
            : "border border-input bg-card hover:border-border-strong",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="truncate font-mono text-[11px] text-subtle">{repo}</span>
        {column === "needs" && <span aria-label="Needs you" className="size-2 shrink-0 rounded-full bg-attention" />}
      </span>
      <span className="text-[13px] leading-snug font-semibold">{goal.title}</span>
      <span className="line-clamp-3 text-xs text-muted-foreground">{preview(goal)}</span>
      {tags(goal).length > 0 && (
        <span className="flex flex-wrap gap-1">
          {tags(goal).map((tag) => (
            <span key={tag.label} className={cn("rounded-full px-[7px] py-px text-[11px]", TONE_CLASS[tag.tone])}>
              {tag.label}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

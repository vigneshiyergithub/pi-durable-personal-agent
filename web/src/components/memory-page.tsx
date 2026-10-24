import * as React from "react"

import type { Status } from "@/lib/api"
import { MEMORY_KINDS, type MemoryEntry, type MemoryKind, memoryDate, parseMemory } from "@/lib/memory"
import { draftForOwner } from "@/lib/owner-thread"
import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"

// Tag colours per kind, in the Board's tag palette.
const KIND_TONE: Record<MemoryKind, string> = {
  rule: "bg-tone-amber-soft text-tone-amber",
  preference: "bg-tone-violet-soft text-tone-violet",
  project: "bg-tone-blue-soft text-tone-blue",
  fact: "bg-tone-grey-soft text-tone-grey",
}

// `code` spans in memory text, without pulling a full markdown renderer into every entry.
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <code key={i} className="rounded-sm bg-muted px-1 py-px font-mono text-[0.85em] break-all">{part.slice(1, -1)}</code>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

function MemoryCard({ entry, onAsk }: { entry: MemoryEntry; onAsk: () => void }) {
  const [expanded, setExpanded] = React.useState(false)
  const [overflows, setOverflows] = React.useState(false)
  const ref = React.useRef<HTMLParagraphElement>(null)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [entry.text, expanded])
  const quote = entry.topic ? `${entry.topic}: ${entry.text}` : entry.text
  const ask = (text: string) => { draftForOwner(text); onAsk() }
  return (
    <article className="flex flex-col gap-2 rounded-[14px] border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-px text-[11px] font-semibold", KIND_TONE[entry.kind])}>{MEMORY_KINDS[entry.kind].label}</span>
        {entry.topic && <span className="min-w-0 font-semibold break-words">{entry.topic}</span>}
        {entry.date && <span className="ml-auto text-xs text-subtle">{memoryDate(entry.date)}</span>}
      </div>
      <p ref={ref} className={cn("break-words text-soft", !expanded && "line-clamp-4")}>
        <InlineCode text={entry.text} />
      </p>
      <div className="flex gap-3 text-xs">
        {overflows && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="text-muted-foreground hover:text-foreground">
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
        <button type="button" onClick={() => ask(`Update this memory: "${quote}" → `)} className="text-link hover:underline">Edit</button>
        <button type="button" onClick={() => ask(`Forget this memory: "${quote}"`)} className="text-muted-foreground hover:text-foreground">Forget</button>
      </div>
    </article>
  )
}

export function MemoryPage({ status, onAsk }: { status: Status | undefined; onAsk: () => void }) {
  const entries = React.useMemo(() => parseMemory(status?.memory ?? ""), [status?.memory])
  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<MemoryKind | "all">("all")
  const needle = query.trim().toLowerCase()
  const shown = entries
    .filter((e) => (kind === "all" || e.kind === kind) && (!needle || `${e.topic ?? ""} ${e.text}`.toLowerCase().includes(needle)))
    // Newest first; undated lines (from before entries were dated) go last, in file order.
    .sort((a, b) => (a.date && b.date ? b.date.localeCompare(a.date) || b.id - a.id : a.date ? -1 : b.date ? 1 : b.id - a.id))
  const count = (k: MemoryKind) => entries.filter((e) => e.kind === k).length
  const every = status?.reflectEveryHours

  return (
    <div className="h-full overflow-y-auto">
      <section aria-label="Memory" className="mx-auto flex w-full max-w-[960px] flex-col gap-[18px] p-4 sm:px-8 sm:py-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col">
            <h1 className="text-[22px] font-semibold">Memory</h1>
            <span className="text-muted-foreground">
              {entries.length} memor{entries.length === 1 ? "y" : "ies"} the agent works from{every ? ` · tidied by the reflector every ${every} h` : ""}
            </span>
          </div>
          <label htmlFor="mem-search" className="sr-only">Search memories</label>
          <input
            id="mem-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${entries.length} memories`}
            className="h-10 w-[280px] max-w-full rounded-[10px] border border-input bg-card px-3 outline-none focus:border-border-strong"
          />
        </div>
        <div role="group" aria-label="Filter" className="flex flex-wrap gap-1.5">
          {(["all", ...Object.keys(MEMORY_KINDS)] as Array<MemoryKind | "all">).map((k) => {
            const n = k === "all" ? entries.length : count(k)
            return (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                disabled={k !== "all" && n === 0}
                onClick={() => setKind(k)}
                className={cn(
                  "h-8 rounded-full px-3 text-[13px] disabled:opacity-40",
                  kind === k ? "bg-primary font-semibold text-primary-foreground" : "border border-input text-soft hover:bg-accent",
                )}
              >
                {k === "all" ? "All" : `${MEMORY_KINDS[k].label}s`} {n}
              </button>
            )
          })}
        </div>
        {!status ? (
          <Skeleton className="h-28 w-full rounded-[14px]" />
        ) : entries.length === 0 ? (
          <p className="rounded-[14px] border border-dashed p-5 text-sm text-muted-foreground">A blank slate. Tell the agent about yourself and it will remember across conversations.</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing matches{needle ? ` “${query.trim()}”` : ""}.</p>
        ) : (
          shown.map((entry) => <MemoryCard key={entry.id} entry={entry} onAsk={onAsk} />)
        )}
        {entries.length > 0 && <span className="text-xs text-subtle">Edit and Forget draft the change in the general thread; the agent updates MEMORY.md when you send it.</span>}
      </section>
    </div>
  )
}

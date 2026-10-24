import * as React from "react"

import { cn } from "@/lib/utils"

export type PaletteItem = { id: string; label: string; kind: string; run: () => void }

// ⌘K: jump to a goal, job or page by typing part of its name. Arrow keys move, Enter opens, Esc closes.
export function CommandPalette({ open, items, onClose }: { open: boolean; items: PaletteItem[]; onClose: () => void }) {
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  const needle = query.trim().toLowerCase()
  const shown = needle ? items.filter((i) => `${i.label} ${i.kind}`.toLowerCase().includes(needle)) : items
  const clamped = Math.min(active, Math.max(shown.length - 1, 0))

  React.useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${clamped}"]`)?.scrollIntoView({ block: "nearest" })
  }, [clamped])

  if (!open) return null
  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    item.run()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Jump to" className="w-[560px] max-w-full overflow-hidden rounded-2xl border border-input bg-card shadow-2xl">
        <div className="flex items-center gap-2 border-b py-2 pr-2 pl-4">
          <label htmlFor="palette-input" className="sr-only">Jump to</label>
          <input
            id="palette-input"
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0) }}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); onClose() }
              else if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, shown.length - 1)) }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
              else if (e.key === "Enter") { e.preventDefault(); choose(shown[clamped]) }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={shown[clamped] ? `palette-${shown[clamped].id}` : undefined}
            placeholder="Jump to a goal, job or page…"
            className="h-10 min-w-0 flex-1 bg-transparent outline-none"
          />
          <button type="button" onClick={onClose} className="h-8 rounded-lg border border-input px-2.5 text-xs text-muted-foreground hover:text-foreground">Esc</button>
        </div>
        <div ref={listRef} id="palette-list" role="listbox" className="flex max-h-[min(420px,60vh)] flex-col overflow-y-auto p-2">
          {shown.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</p>
          ) : (
            shown.map((item, index) => (
              <button
                key={item.id}
                id={`palette-${item.id}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={index === clamped}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(item)}
                className={cn("flex min-h-10 items-center justify-between gap-3 rounded-lg px-3 text-left", index === clamped && "bg-accent")}
              >
                <span className="min-w-0 truncate">{item.label}</span>
                <span className="shrink-0 text-xs text-subtle">{item.kind}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

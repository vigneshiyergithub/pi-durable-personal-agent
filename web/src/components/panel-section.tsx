import * as React from "react"
import { ChevronDownIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

// A collapsible block for the side panel. The header always shows a one-line summary, so a closed section still
// tells you what is inside. Bodies grow to their full height: the tab itself scrolls, so there is never a scroll
// region inside a scroll region.
export function PanelSection({
  title,
  summary,
  defaultOpen = false,
  action,
  children,
}: {
  title: string
  summary?: React.ReactNode
  defaultOpen?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left">
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground transition-transform -rotate-90 group-aria-expanded:rotate-0" />
          <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
          {summary && <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>}
        </CollapsibleTrigger>
        {action}
      </div>
      <CollapsibleContent className="pt-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

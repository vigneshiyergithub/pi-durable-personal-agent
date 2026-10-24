import * as React from "react"
import { ImageIcon } from "lucide-react"

import { opsToSvg, type Op } from "@/lib/elrSvg"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"

export type CanvasStepProps = {
  id: string
  canvasId: string
  ops: Op[]
}

export function CanvasStep({ canvasId, ops }: CanvasStepProps) {
  const strokeCount = ops.filter((op) => op.kind === "stroke" || op.kind === "arc").length
  const hasOps = strokeCount > 0
  const svg = React.useMemo(() => opsToSvg(ops), [ops])

  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <ImageIcon />
            </TraceIcon>
            <TraceTitle>Canvas view</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Canvas <span className="font-mono text-xs">{canvasId}</span> · {strokeCount} stroke
              {strokeCount === 1 ? "" : "s"}
            </p>
            {hasOps ? (
              <div
                className="max-w-[256px] overflow-hidden rounded border bg-white"
                // Safe: opsToSvg builds the markup with explicit escaping; no raw op data is interpolated.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <p className="text-sm italic text-muted-foreground">No strokes on this canvas.</p>
            )}
          </div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

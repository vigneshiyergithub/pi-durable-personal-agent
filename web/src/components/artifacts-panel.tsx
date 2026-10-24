import * as React from "react"

import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

type Artifact = {
  id: string
  title: string
  kind: string
  description: string
  // null only when the server could not resolve the link (e.g. the canvas access token or the blog
  // address is not configured); the server never emits a broken or placeholder URL.
  url: string | null
  available: boolean
  reason?: string
  added?: string
}
export type ArtifactsData = { source: string; skipped: number; entries: Artifact[] }

// The Artifacts quick-access section: one row per artefact the agent has made (canvas, blog, and
// everything the agent adds to DATA_DIR/artifacts.json later), fetched once per mount from the
// session-authenticated /api/artifacts endpoint, so the list is never public and never baked into
// the build. Zero entries is an empty state, a failed fetch is a plain error with a retry.
//
// Mobile-first CSS approach: the section is a single flex column (`flex flex-col`), so at 360px the
// rows stack vertically with no fixed widths and `min-w-0` on every holder — nothing can force
// horizontal scrolling. Long URLs wrap instead of overflow: they are visible text styled with
// `break-all` plus `overflow-wrap:anywhere`, which wraps at any character, so even a token-bearing
// canvas URL stays inside its card. Tap targets are at least 44px: the "Open" anchor is a full-width
// flex row with `min-h-[44px]`, and so is the retry button.
export function ArtifactsPanel({ initial, initialError }: { initial?: ArtifactsData; initialError?: string }) {
  const [data, setData] = React.useState<ArtifactsData | undefined>(initial)
  const [failed, setFailed] = React.useState<string | undefined>(initialError)
  const [loading, setLoading] = React.useState(false)

  // The promise is always settled inside this callback, so a failed request is the error state and
  // never an unhandled rejection; Retry re-runs the same load. The pending flag only matters for
  // the second fetch (Retry), so the mount-time fetch sets no state synchronously in an effect.
  const load = React.useCallback((retried: boolean) => {
    if (retried) setLoading(true)
    api<ArtifactsData>("/api/artifacts")
      .then((next) => {
        setData(next)
        setFailed(undefined)
      })
      .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }, [])
  React.useEffect(() => {
    // `initial`/`initialError` are proof-only (scripts/artifacts-web.ts): they render the real
    // component with fixture data or a simulated failed request, without a browser. The app never
    // passes them and keeps fetching.
    if (initial || initialError) return
    load(false)
  }, [initial, initialError, load])

  if (failed && !data) {
    return (
      <div role="alert" className="flex flex-col gap-3">
        <p className="break-words text-sm text-destructive">Couldn&apos;t load artifacts: {failed}</p>
        <Button className="min-h-[44px] self-start" variant="outline" disabled={loading} onClick={() => load(true)}>
          Retry
        </Button>
      </div>
    )
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading artifacts…</p>
  }
  if (data.entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No artefacts yet.</p>
  }

  // Link safety, in depth behind the server's own filtering: only site-relative paths (the
  // token-gated canvas link the server composed for this session) and absolute http(s) URLs become
  // anchors; anything else renders the unavailable note instead of a dead link. The server has
  // already refused every non-http(s) URL, so this is a second, fail-closed gate.
  const linkable = (url: string): boolean => url.startsWith("/") || url.startsWith("http://") || url.startsWith("https://")
  const refused = data.entries.filter((entry) => !entry.url || !linkable(entry.url)).length + data.skipped

  return (
    <div className="flex flex-col gap-2">
      {refused > 0 && <p className="break-words text-xs text-muted-foreground">{refused} skipped (malformed or unavailable).</p>}
      <ul className="flex flex-col gap-2">
        {data.entries.map((entry) => {
          const url = entry.url && linkable(entry.url) ? entry.url : null
          return (
            <li key={entry.id} className="flex min-w-0 flex-col gap-1.5 rounded-xl border p-3">
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{entry.title}</span>
                <Badge variant="outline" className="shrink-0 font-mono text-[11px]">
                  {entry.kind}
                </Badge>
              </div>
              {entry.description && <p className="break-words text-sm text-muted-foreground">{entry.description}</p>}
              {url ? (
                <>
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-h-[44px] items-center text-sm font-medium underline-offset-2 hover:underline"
                  >
                    Open {entry.title} ↗
                  </a>
                  {/* The plain URL as visible, selectable text, so it can be copied on a phone. */}
                  <p className="min-w-0 font-mono text-[11px] break-all text-muted-foreground" style={{ overflowWrap: "anywhere" }}>
                    {url}
                  </p>
                </>
              ) : (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Link unavailable{entry.reason ? ` — ${entry.reason}` : "."}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// The page lives in the URL hash so reloads and links land on the same place:
//   #board            the goals board          #board/<goalId>  a goal open in the drawer
//   #board/general    the general thread       #board/new       the new-goal form
//   #jobs/<jobId>     a scheduled job          #memory          memory
//   #artifacts        everything the agent has made
//   #insights/<view>  one Insights page        #settings        agent settings
// Old #monitor/<view> links still work and open the matching Insights page.
import * as React from "react"

export const INSIGHTS_VIEWS = ["overview", "activity", "cost", "coding", "models", "reflector", "containers", "scores", "reports", "lab"] as const
export type InsightsView = (typeof INSIGHTS_VIEWS)[number]

export type Route =
  | { page: "board"; goal?: string }
  | { page: "jobs"; job?: string }
  | { page: "memory" }
  | { page: "artifacts" }
  | { page: "insights"; view: InsightsView }
  | { page: "settings" }

export type Page = Route["page"]

export function parseRoute(hash: string): Route {
  const [page, rest] = hash.replace(/^#\/?/, "").split("/", 2) as [string, string | undefined]
  const id = rest ? decodeURIComponent(rest) : undefined
  switch (page) {
    case "jobs":
      return { page: "jobs", job: id }
    case "memory":
      return { page: "memory" }
    case "artifacts":
      return { page: "artifacts" }
    case "settings":
      return { page: "settings" }
    case "insights":
    case "monitor": {
      const view = (INSIGHTS_VIEWS as readonly string[]).includes(id ?? "") ? (id as InsightsView) : "overview"
      return { page: "insights", view }
    }
    default:
      return { page: "board", goal: page === "board" ? id : undefined }
  }
}

export function routeHash(route: Route): string {
  switch (route.page) {
    case "board":
      return route.goal ? `#board/${encodeURIComponent(route.goal)}` : "#board"
    case "jobs":
      return route.job ? `#jobs/${encodeURIComponent(route.job)}` : "#jobs"
    case "insights":
      return `#insights/${route.view}`
    default:
      return `#${route.page}`
  }
}

export function useRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = React.useState(() => parseRoute(location.hash))
  React.useEffect(() => {
    const sync = () => setRoute(parseRoute(location.hash))
    window.addEventListener("hashchange", sync)
    return () => window.removeEventListener("hashchange", sync)
  }, [])
  const go = React.useCallback((next: Route) => {
    const hash = routeHash(next)
    if (hash !== location.hash) history.pushState(null, "", hash)
    setRoute(next)
  }, [])
  return [route, go]
}

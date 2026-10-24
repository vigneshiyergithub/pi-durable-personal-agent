// Talks to the agent's HTTP API. Auth is the owner's passkey session: an HttpOnly cookie the browser sends on its own,
// so no secret ever lives in JavaScript or localStorage.

export class Unauthorized extends Error {}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  })
  if (response.status === 401) throw new Unauthorized("Please sign in")
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body as T
}

export type AuthState = { enrolled: boolean; authenticated: boolean; bootstrap: boolean }

export type Skill = { name: string; tools: string[]; description: string; error?: string }
export type Job = {
  id: string
  prompt: string
  nextRunAt: string
  everyMinutes?: number
  runOnChange?: boolean
  skippedRuns?: number
  createdBy: "user" | "agent" | "reflector"
}
export type Status = {
  model: string
  reflectModel: string
  spendUsd: number
  maxSpendUsd: number
  lastReflectAt: string | null
  reflectEveryHours: number
  reflecting: boolean
  /** PAUSE_ALL maintenance: goals paused, no scheduled jobs or reflection; chat still works. */
  pauseAll?: boolean
  memory: string
  skills: Skill[]
  jobs: Job[]
  archivedJobs?: Array<{ job: Job; at: string; reason: string }>
}

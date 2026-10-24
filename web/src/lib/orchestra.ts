// Mirrors src/orchestra.ts (the server's goal/task state) for the web app.

export type CoderKind = "claude" | "codex" | "opencode"
export type TaskStatus = "pending" | "queued" | "running" | "review" | "accepted" | "escalated" | "cancelled"
export type GoalStatus =
  | "planning"
  | "awaiting_approval"
  | "active"
  | "blocked"
  | "reviewing"
  | "delivering"
  | "merging"
  | "observing"
  | "rolled_back"
  | "done"
  | "cancelled"
  | "paused"
  | "retired"

export type Proof = { criterionIndex?: number; criterion: string; command: string; expect: string; exitCode: number; output: string; timedOut: boolean }

export type Evidence = {
  report?: {
    status: "done" | "partial" | "blocked"
    summary: string
    changes: string[]
    tests: Array<{ command: string; passed: boolean; notes: string }>
    risks: string[]
    questions: string[]
  }
  agentError?: string
  commits: string[]
  diffStat: string
  diff: string
  diffTruncated: boolean
  verify?: { command: string; exitCode: number; output: string; timedOut: boolean }
  proofs?: Proof[]
  costUsd?: number
  durationMs: number
}

export type Attempt = {
  unbudgeted?: boolean
  pendingEvidence?: { retryAfter?: string }
  n: number
  coder: CoderKind
  claimedAt: string
  heartbeatAt: string
  finishedAt?: string
  evidence?: Evidence
  verdict?: { decision: "accept" | "revise" | "escalate"; feedback: string; at: string }
  error?: string
}

export type Task = {
  id: string
  title: string
  instructions: string
  acceptance: string[]
  coder: CoderKind
  status: TaskStatus
  maxAttempts: number
  attempts: Attempt[]
  guidance?: string
  kind?: "sync" | "holdout" // queued by the orchestrator itself; "holdout" runs the hidden checks with no coder
}

// Hidden checks an examiner wrote from the goal's criteria before any code; only the owner sees the commands.
export type Holdouts = {
  status: "pending" | "running" | "ready" | "failed"
  model: string
  checks?: Array<{ criterionIndex: number; command: string; expect: string }>
  uncheckable?: Array<{ criterionIndex: number; reason: string }>
  at?: string
  waived?: Array<{ index: number; reason: string; at: string }> // checks the owner waived; they no longer count
  lastRun?: { headSha?: string; at: string; passed: boolean; results: Array<{ index: number; exitCode: number; output: string; timedOut: boolean }> }
}

// Post-merge observation window: production is watched after the agent merges.
export type Observe = {
  mergeSha: string // the squash commit merged into the base branch
  startedAt: string
  until: string // when the window ends (if healthy)
  deployedAt?: string // when production first reported mergeSha
  boots: number // agent restarts seen since the merge
  checks: Array<{ at: string; name: string; ok: boolean; detail: string }> // latest ~20, newest last
  warnings: string[]
  p0?: string // why it was rolled back
  rollback?: { pr: number; url: string; at: string }
  followUpGoalId?: string // the fix or investigate goal it created
  result?: "healthy" | "rolled_back" | "warnings" | "superseded"
}

export type Goal = {
  preflight?: { at: string; budget: number; estimatedDiffChars: number; issues: Array<{ severity: "error" | "warning"; task: number; message: string }> }
  id: string
  projectId: string
  title: string
  description: string
  acceptance: string[]
  status: GoalStatus
  pausedFrom?: GoalStatus // the status it returns to on resume
  pausedAt?: string
  closed?: { at: string; reason: string; by: "owner" } // set by retire; a merged goal becomes "done" with this, others "retired"
  branch: string
  tasks: Task[]
  createdAt: string
  updatedAt: string
  question?: string
  summary?: string
  delivery?: { status: "queued" | "running" | "done" | "failed"; result?: string }
  review?: {
    status: "pending" | "running" | "approved" | "changes_requested" | "failed"
    round: number
    model: string
    headSha?: string
    summary?: string
    findings?: Array<{ severity: "blocker" | "major" | "minor"; file?: string; note: string }>
    at?: string
  }
  holdouts?: Holdouts
  gate?: { checks: Array<{ name: string; ok: boolean; detail: string }>; at: string }
  merge?: {
    pr: number
    url: string
    status: "waiting" | "merged" | "vetoed" | "blocked"
    mergeAt?: string
    headSha?: string
    note?: string
  }
  observe?: Observe
}

// A post-merge incident: a P0 that triggered a revert, a revert that failed, or a P0 that proved to be a false alarm.
export type Incident = {
  id: string
  at: string
  goalId: string
  goalTitle: string
  kind: "p0" | "revert_failed" | "false_alarm"
  detail: string // the P0 reason / failure / why it was a false alarm
  mergeSha?: string
  rollbackUrl?: string // the revert PR, when a revert landed
  status: "open" | "healed" | "retired"
  note?: string // e.g. the owner's retire reason
}

export type OrchestraState = {
  goals: Goal[]
  projects: Array<{ id: string; repo: string; base: string; verify?: string; merge: "owner" | "veto" | "agent"; description: string }>
  events: Array<{ at: string; goalId?: string; text: string }>
  incidents?: Incident[]
}

const CLOSED: GoalStatus[] = ["done", "cancelled", "retired"]

/** A goal is waiting on the owner when it is open and blocked, awaiting plan approval, or asking a question. */
export const needsOwner = (goal: Goal) =>
  !CLOSED.includes(goal.status) && (goal.status === "blocked" || goal.status === "awaiting_approval" || Boolean(goal.question))

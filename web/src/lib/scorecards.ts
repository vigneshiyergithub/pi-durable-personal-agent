// Mirrors src/scorecards.ts (GET /api/scorecards) for the web app. Rates are 0..1, or null when there is nothing to divide by.

export type ScoreWindow = "7d" | "30d" | "all"

export type CoderScore = {
  attempts: number
  firstAttemptAcceptance: number | null
  attemptsPerAcceptedTask: number | null
  missingReportRate: number | null
  proofPassRate: number | null
  costPerAcceptedTask: number | null
  medianDurationMin: number | null
}

export type ForemanScore = {
  verdicts: number
  escalationRate: number | null
  reviseRate: number | null
  acceptsOverruledByReviewer: number | null
}

export type ReviewerScore = {
  goalsReviewed: number
  rounds: number
  approvals: number
  changesRequested: number
  findings: { blocker: number; major: number; minor: number }
  approvedButVetoedOrBlocked: number
}

export type ScoreBoard = {
  coder: Record<string, CoderScore>
  foreman: ForemanScore
  reviewer: Record<string, ReviewerScore>
}

export type Scorecards = {
  generatedAt: string
  windows: Record<ScoreWindow, { total: ScoreBoard; byProject: Record<string, ScoreBoard> }>
}

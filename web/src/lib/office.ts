// Mirrors the server's CEO office endpoints: GET /api/reports and GET /api/roles.

// The daily CEO report the agent writes. Newest first, at most 30.
export type Report = { id: string; at: string; title: string; markdown: string; goalIds: string[] }

// One line of the team table: which model plays which role, and what it does.
export type Role = { role: "agent" | "reflector" | "foreman" | "coder" | "reviewer"; model: string; does: string }

// MEMORY.md is a list of one-line entries: `- [2026-10-19] (rule) Deployment: never bind 8080`. Older lines may lack the
// kind, the topic or even the bullet; they are still parsed, and their kind is inferred from the words they use.

export type MemoryKind = "rule" | "preference" | "project" | "fact"

export type MemoryEntry = { id: number; date?: string; kind: MemoryKind; topic?: string; text: string }

export const MEMORY_KINDS: Record<MemoryKind, { label: string; tone: string }> = {
  rule: { label: "Rule", tone: "bg-tone-amber-soft text-tone-amber" },
  preference: { label: "Preference", tone: "bg-tone-violet-soft text-tone-violet" },
  project: { label: "Project", tone: "bg-tone-blue-soft text-tone-blue" },
  fact: { label: "Fact", tone: "bg-muted text-muted-foreground" },
}

const KIND = /^\((rule|preference|project|fact)\)\s*/i
const DATE = /^\[(\d{4}-\d{2}-\d{2})\]\s*/
// A topic is a short label before the first colon: "Deployment:", "Owner's rule on coder models:".
// A dot inside the label is fine ("Correction (from src/orchestra.ts):"); a dot ending a sentence is not.
const TOPIC = /^((?:[^:.\n]|\.(?=\S)){2,48}):\s+/

function infer(topic: string | undefined, text: string): MemoryKind {
  const head = `${topic ?? ""} ${text.slice(0, 80)}`
  if (/\brule\b|\bnever\b|\balways\b|\bmust\b|correction/i.test(head)) return "rule"
  if (/\b(likes|prefers|preference|wants)\b/i.test(head)) return "preference"
  if (/\b(goal|project|milestone|repo)\b/i.test(head)) return "project"
  return "fact"
}

export function parseMemory(markdown: string): MemoryEntry[] {
  const entries: MemoryEntry[] = []
  for (const raw of markdown.split("\n")) {
    let line = raw.trim().replace(/^[-*]\s+/, "")
    if (!line || /^#+\s/.test(line)) continue
    const date = DATE.exec(line)?.[1]
    if (date) line = line.replace(DATE, "")
    const kind = KIND.exec(line)?.[1]?.toLowerCase() as MemoryKind | undefined
    if (kind) line = line.replace(KIND, "")
    const topicMatch = TOPIC.exec(line)
    const topic = topicMatch?.[1].trim()
    const rest = topicMatch ? line.slice(topicMatch[0].length) : line
    const text = rest.charAt(0).toUpperCase() + rest.slice(1)
    entries.push({ id: entries.length, date, kind: kind ?? infer(topic, text), topic, text })
  }
  return entries
}

export const memoryDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })

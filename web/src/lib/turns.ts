// Groups the flat AG-UI message list into turns: one person message, then everything the agent did in reply
// (reasoning, tool calls with their results, and text), rendered as a single agent message.

import { isValidOp, type Op } from "./elrSvg.ts"

export type AguiMessage = {
  id: string
  role: string
  content?: unknown
  toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }>
  toolCallId?: string
  error?: string
}

export type Step =
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; args: Record<string, unknown>; argsText: string; result?: string; error: boolean }
  | { kind: "text"; id: string; text: string }
  | { kind: "canvas"; id: string; canvasId: string; ops: Op[] }

/** Runtime map of step kinds to the React component that renders them. */
export const STEP_DISPATCH: Record<Step["kind"], string> = {
  reasoning: "ReasoningRow",
  tool: "ToolRow",
  canvas: "CanvasStep",
  text: "TextRow",
}

/** view_canvas mirrors the canvas ops as a fenced `json elr-canvas-ops` block in its tool result. */
const OPS_BLOCK = /```json[ \t]+elr-canvas-ops[ \t]*\r?\n([\s\S]*?)\r?\n```/
const MAX_REPLAYED_OPS = 1000

/**
 * Defensively parse the mirrored canvas ops out of a view_canvas tool result. Returns undefined for
 * anything malformed, absent, or oversized — it never throws — so a bad payload simply produces no
 * canvas step.
 */
function parseCanvasOps(result: string | undefined): { canvasId: string; ops: Op[] } | undefined {
  if (!result) return undefined
  const match = OPS_BLOCK.exec(result)
  if (!match) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== "object") return undefined
  const { canvasId, ops: rawOps } = parsed as { canvasId?: unknown; ops?: unknown }
  if (typeof canvasId !== "string" || !Array.isArray(rawOps) || rawOps.length > MAX_REPLAYED_OPS) return undefined
  const ops: Op[] = []
  for (const raw of rawOps) {
    if (!isValidOp(raw)) return undefined
    ops.push(raw)
  }
  return { canvasId, ops }
}

export type Turn =
  | { kind: "user"; id: string; text: string }
  | { kind: "job"; id: string; jobId: string; text: string }
  | { kind: "agent"; id: string; steps: Step[] }

export function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part) => (part?.type === "text" ? part.text : "")).join("")
  return ""
}

const parse = (text: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text || "{}")
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

const JOB = /^\[job ([\w-]+)\] ([\s\S]*?)(?:\n\(Your final answer is sent[\s\S]*)?$/

export function toTurns(messages: readonly AguiMessage[]): Turn[] {
  const results = new Map<string, AguiMessage>()
  for (const message of messages) if (message.role === "tool" && message.toolCallId) results.set(message.toolCallId, message)

  const turns: Turn[] = []
  let agent: Extract<Turn, { kind: "agent" }> | undefined
  const agentTurn = (id: string) => {
    if (!agent) {
      agent = { kind: "agent", id, steps: [] }
      turns.push(agent)
    }
    return agent
  }

  for (const message of messages) {
    if (message.role === "user") {
      agent = undefined
      const text = textOf(message.content)
      const job = JOB.exec(text)
      turns.push(job ? { kind: "job", id: message.id, jobId: job[1], text: job[2].trim() } : { kind: "user", id: message.id, text })
    } else if (message.role === "reasoning") {
      const text = textOf(message.content)
      if (text) agentTurn(message.id).steps.push({ kind: "reasoning", id: message.id, text })
    } else if (message.role === "assistant") {
      const turn = agentTurn(message.id)
      const text = textOf(message.content)
      if (text) turn.steps.push({ kind: "text", id: message.id, text })
      for (const call of message.toolCalls ?? []) {
        const result = results.get(call.id)
        const resultText = result ? textOf(result.content) : undefined
        turn.steps.push({
          kind: "tool",
          id: call.id,
          name: call.function.name,
          args: parse(call.function.arguments),
          argsText: call.function.arguments,
          result: resultText,
          error: Boolean(result?.error) || Boolean(resultText?.startsWith("Error:")),
        })
        if (call.function.name === "view_canvas" && resultText !== undefined) {
          const canvas = parseCanvasOps(resultText)
          if (canvas) turn.steps.push({ kind: "canvas", id: `${call.id}:canvas`, canvasId: canvas.canvasId, ops: canvas.ops })
        }
      }
    }
  }
  return turns
}

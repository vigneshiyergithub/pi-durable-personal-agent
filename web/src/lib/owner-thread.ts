// Everything the owner says goes through one durable conversation (the "owner" thread): goal replies, new goals and
// waivers are messages the agent acts on with its own tools. These helpers send one, or leave a draft to confirm.
import * as React from "react"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { toast } from "sonner"

import { compose } from "./compose.ts"

/** Puts text in the general thread's composer, whether or not the thread is on screen yet. */
export function draftForOwner(text: string) {
  try {
    sessionStorage.setItem("agent-draft:owner", text)
  } catch {
    // Storage may be disabled; the compose event still reaches a mounted composer.
  }
  compose(text)
}

/** Sends a message on the owner thread. While a reply is still running, it leaves the text as a draft instead. */
export function useSendToOwner() {
  const { agent } = useAgent({ agentId: "default" })
  const { copilotkit } = useCopilotKit()
  return React.useCallback(
    async (text: string): Promise<"sent" | "drafted"> => {
      const content = text.trim()
      if (agent.isRunning) {
        draftForOwner(content)
        toast("The agent is still replying", { description: "Your message is waiting in the general thread." })
        return "drafted"
      }
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content })
      copilotkit.runAgent({ agent }).catch((error: unknown) => {
        draftForOwner(content)
        toast.error(error instanceof Error ? error.message : String(error))
      })
      return "sent"
    },
    [agent, copilotkit],
  )
}

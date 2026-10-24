import * as React from "react"
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2"
import { AlarmClockIcon, ArrowUpIcon, ChevronRightIcon, SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { COMPOSE_EVENT, compose } from "@/lib/compose"
import { foldJobRuns, type JobRun, jobTitle } from "@/lib/jobs"
import type { Goal } from "@/lib/orchestra"
import { type AguiMessage, type Step, toTurns, type Turn } from "@/lib/turns"
import { cn } from "@/lib/utils"
import { AgentOrb } from "@/components/agent-orb"
import { Steps } from "@/components/chat/steps"
import { Markdown } from "@/components/markdown"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { Skeleton } from "@/components/ui/skeleton"

// The conversation with the agent, built for the Board's drawer. It sizes itself by its own width (container queries),
// not the window's, so it reads the same in a 400px drawer on a wide screen as on a phone: user messages are bubbles,
// the agent's replies are plain text, and the work behind a reply folds into one "Worked · N steps" chip.

type Thread = "owner" | "jobs"

const readDraft = (thread: string) => { try { return sessionStorage.getItem(`agent-draft:${thread}`) ?? "" } catch { return "" } }
const saveDraft = (thread: string, text: string) => { try { sessionStorage.setItem(`agent-draft:${thread}`, text) } catch { /* Storage may be disabled; in-memory editing still works. */ } }

const clipTitle = (title: string, max = 22) => (title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title)

type Suggestion = { label: string; text: string; send: boolean }

/** Starter chips, from what the owner actually asks day to day: a rundown first, then a verdict on the goal that is waiting on the owner, if there is one. */
function suggestionsFor(needing: Goal[]): Suggestion[] {
  const chips: Suggestion[] = [
    { label: "Give me a rundown", text: "Give me a rundown", send: true },
    { label: "What needs me?", text: "What needs me?", send: true },
  ]
  const top = needing[0]
  if (top) {
    // Verdicts are consequential, so they land in the composer for the owner to confirm with Enter.
    chips.push(
      { label: `Approve “${clipTitle(top.title)}”`, text: `Approve "${top.title}"`, send: false },
      { label: `Reject “${clipTitle(top.title)}”`, text: `Reject "${top.title}" because `, send: false },
    )
  } else {
    chips.push({ label: "What shipped since yesterday?", text: "What shipped since yesterday?", send: true })
  }
  return chips
}

const STARTERS: Array<[string, string]> = [
  ["Plan a task", "Make a plan for "],
  ["Investigate", "Investigate this issue: "],
  ["Set a reminder", "Remind me to "],
]

type ToolOutput = { toolCallId: string; trimStart?: number; append?: string; set?: string }

/** Splits an agent turn into runs of steps (one work chip) and text replies, in order. */
function segments(steps: Step[]): Array<{ kind: "steps"; steps: Step[] } | { kind: "text"; id: string; text: string }> {
  const out: Array<{ kind: "steps"; steps: Step[] } | { kind: "text"; id: string; text: string }> = []
  for (const step of steps) {
    if (step.kind === "text") out.push({ kind: "text", id: step.id, text: step.text })
    else if (out.at(-1)?.kind === "steps") (out.at(-1) as { steps: Step[] }).steps.push(step)
    else out.push({ kind: "steps", steps: [step] })
  }
  return out
}

function greeting(): string {
  const hour = new Date().getHours()
  return hour < 5 ? "Up late?" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"
}

export function Chat({ onRunSettled, needing = [] }: { onRunSettled: () => void; needing?: Goal[] }) {
  const [thread, setThread] = React.useState<Thread>("owner")
  React.useEffect(() => {
    const owner = (event: Event) => { saveDraft("owner", (event as CustomEvent<string>).detail); setThread("owner") }
    window.addEventListener(COMPOSE_EVENT, owner)
    return () => window.removeEventListener(COMPOSE_EVENT, owner)
  }, [])
  const tabs: Array<[Thread, string]> = [["owner", "You & agent"], ["jobs", "Jobs"]]
  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="Conversations"
        className="flex shrink-0 gap-1 border-b px-5 pb-3"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const next = thread === "owner" ? "jobs" : "owner"
          setThread(next)
          event.currentTarget.querySelector<HTMLButtonElement>(`#thread-${next}`)?.focus()
        }}
      >
        {tabs.map(([value, label]) => (
          <button
            key={value}
            id={`thread-${value}`}
            type="button"
            role="tab"
            aria-selected={thread === value}
            aria-controls="conversation-panel"
            tabIndex={thread === value ? 0 : -1}
            onClick={() => setThread(value)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px]",
              thread === value ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "jobs" && <AlarmClockIcon className="size-3.5" />}
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1" id="conversation-panel" role="tabpanel" aria-labelledby={`thread-${thread}`}>
        <MessageScrollerProvider key={thread} autoScroll defaultScrollPosition="end">
          <ChatThread thread={thread} onRunSettled={onRunSettled} needing={needing} />
        </MessageScrollerProvider>
      </div>
    </div>
  )
}

function ChatThread({ thread, onRunSettled, needing }: { thread: Thread; onRunSettled: () => void; needing: Goal[] }) {
  const { agent } = useAgent({ agentId: thread === "owner" ? "default" : "jobs" })
  const { scrollToEnd } = useMessageScroller()
  const { copilotkit } = useCopilotKit()
  const [loaded, setLoaded] = React.useState(false)
  const [draft, setDraft] = React.useState(() => readDraft(thread))
  React.useEffect(() => { saveDraft(thread, draft) }, [draft, thread])
  const [liveOutput, setLiveOutput] = React.useState<Record<string, string>>({})
  const [notice, setNotice] = React.useState<string>()
  const formRef = React.useRef<HTMLFormElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  const running = agent.isRunning
  const messages = agent.messages as unknown as AguiMessage[]
  const turns = React.useMemo(() => toTurns(messages), [messages])
  // Scheduled runs that ended in NO_REPLY are routine: they live under Jobs, not in the conversation.
  const items = React.useMemo(() => foldJobRuns(turns, running).filter((t) => thread === "jobs" || t.kind !== "job_run"), [turns, running, thread])

  // History lives on the server (the durable transcript); hydrate CopilotKit's agent from it.
  const refresh = React.useCallback(async () => {
    const { messages: history } = await api<{ messages: AguiMessage[] }>(`/api/messages?thread=${thread}`)
    if (agent.isRunning) return
    const current = agent.messages as unknown as AguiMessage[]
    if (history.length !== current.length || history.at(-1)?.id !== current.at(-1)?.id) {
      agent.setMessages(history as never)
    }
  }, [agent, thread])

  React.useEffect(() => {
    refresh()
      .catch((error) => toast.error(`Could not load the conversation: ${error.message}`))
      .finally(() => setLoaded(true))
    // Pick up what arrives from Telegram and scheduled jobs while this page is open.
    const timer = setInterval(() => document.visibilityState === "visible" && void refresh().catch(() => {}), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  React.useEffect(() => {
    const { unsubscribe } = agent.subscribe({
      onEvent: ({ event }) => {
        if (event.type !== "CUSTOM") return
        const { name, value } = event as unknown as { name: string; value: Record<string, unknown> }
        if (name === "tool_output") {
          const out = value as ToolOutput
          setLiveOutput((all) => {
            const before = all[out.toolCallId] ?? ""
            const next = out.set ?? before.slice(out.trimStart ?? 0) + (out.append ?? "")
            return { ...all, [out.toolCallId]: next }
          })
        } else if (name === "retry") {
          setNotice(`The model hiccuped, retrying (attempt ${value.attempt})…`)
        } else if (name === "compaction") {
          setNotice(value.status === "started" ? "Tidying up older context…" : undefined)
        }
      },
      onRunFailed: ({ error }) => {
        // Stopping a run aborts its stream on purpose; that is not an error worth a toast.
        if (error.name === "AbortError" || /abort/i.test(error.message)) return
        toast.error(error.message)
      },
      onRunErrorEvent: ({ event }) => {
        toast.error((event as { message?: string }).message ?? "The run failed")
      },
      onRunFinalized: () => {
        setNotice(undefined)
        setLiveOutput({})
        onRunSettled()
        // Swap the streamed messages for the durable transcript (stable ids, final tool results), then land on the reply.
        setTimeout(() => {
          refresh()
            .then(() => requestAnimationFrame(() => scrollToEnd()))
            .catch(() => {})
        }, 300)
      },
    })
    return unsubscribe
  }, [agent, onRunSettled, refresh, scrollToEnd])

  // Other parts of the page can start a message for the owner to finish (e.g. Edit on a memory card).
  React.useEffect(() => {
    const onCompose = (event: Event) => {
      const text = (event as CustomEvent<string>).detail
      if (thread !== "owner") return
      setDraft(text)
      focusEnd(text.length)
    }
    window.addEventListener(COMPOSE_EVENT, onCompose)
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose)
  }, [thread])

  function focusEnd(at: number) {
    setTimeout(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(at, at)
    }, 0)
  }

  async function send(text: string) {
    const content = text.trim()
    if (!content || running) return
    setDraft("")
    agent.addMessage({ id: crypto.randomUUID(), role: "user", content })
    try {
      await copilotkit.runAgent({ agent })
    } catch (error) {
      setDraft((current) => current || content)
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  async function stop() {
    try {
      await api("/api/stop", { method: "POST", body: JSON.stringify({ thread }) })
    } finally {
      agent.abortRun()
    }
  }

  const last = items.at(-1)
  const lastAgentTurn = last?.kind === "agent" || last?.kind === "job_run" ? last.id : undefined
  const awaitingFirstToken = running && last?.kind === "user"
  // Only the message just sent anchors the scroller, and only while its reply runs. The scroller treats any anchor it
  // hasn't seen as a new message and scrolls the first such one to the top. When the list is replaced (the durable
  // transcript swapped in after a run, or a scheduled job arriving on the 15 s refresh), every message element remounts.
  // If every user message were an anchor, that jumped the view up to the oldest one.
  const sendingId = running ? items.findLast((t) => t.kind === "user")?.id : undefined
  const suggestions = thread === "owner" ? suggestionsFor(needing) : [{ label: "Review scheduled jobs", text: "Review my scheduled jobs and their recent results.", send: true }]
  const pick = (s: Suggestion) => (s.send ? void send(s.text) : compose(s.text))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {!loaded ? (
          <div className="flex flex-col gap-4 p-5">
            <Skeleton className="ml-auto h-10 w-3/5 rounded-2xl" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
          </div>
        ) : items.length === 0 ? (
          <EmptyState thread={thread} suggestions={suggestions} onPick={pick} />
        ) : (
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent aria-busy={running} className="mx-auto w-full max-w-3xl gap-5 px-5 pt-5 pb-4">
                {items.map((turn) => (
                  <TurnView key={turn.id} turn={turn} streaming={running && turn.id === lastAgentTurn} anchor={turn.id === sendingId} liveOutput={liveOutput} />
                ))}
                {awaitingFirstToken && (
                  <MessageScrollerItem messageId="pending">
                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                      <AgentOrb size={16} active />
                      <span className="shimmer">Working on it…</span>
                    </span>
                  </MessageScrollerItem>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        )}
      </div>

      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4">
        {notice && <p className="text-center text-xs text-muted-foreground">{notice}</p>}
        {items.length > 0 && !running && (
          <div className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4">
            {suggestions.map((s) => (
              <button
                key={s.label}
                type="button"
                title={s.text}
                onClick={() => pick(s)}
                className="h-7 shrink-0 rounded-full border px-2.5 text-xs whitespace-nowrap text-muted-foreground hover:border-border-strong hover:text-foreground"
              >
                {s.label}
              </button>
            ))}
          </div>
        )}
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault()
            void send(draft)
          }}
          className="flex items-end gap-2 rounded-xl border border-input bg-card py-1.5 pr-1.5 pl-3.5 focus-within:border-border-strong"
        >
          <label htmlFor={`composer-${thread}`} className="sr-only">Message</label>
          <textarea
            ref={textareaRef}
            id={`composer-${thread}`}
            rows={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={thread === "jobs" ? "Ask about scheduled work…" : "Message your agent…"}
            className="field-sizing-content max-h-48 min-h-10 min-w-0 flex-1 resize-none bg-transparent py-2.5 text-sm outline-none"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                formRef.current?.requestSubmit()
              }
            }}
          />
          {running ? (
            <button type="button" aria-label="Stop" onClick={() => void stop()} className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground">
              <SquareIcon className="size-3.5 fill-current" />
            </button>
          ) : (
            <button type="submit" aria-label="Send" disabled={!draft.trim()} className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground disabled:opacity-40">
              <ArrowUpIcon className="size-4" />
            </button>
          )}
        </form>
        <div className="flex items-center gap-3 px-1 text-[11px] text-subtle">
          {thread === "owner" && (
            <>
              <span className="shrink-0">Start with</span>
              <div className="no-scrollbar flex min-w-0 gap-2 overflow-x-auto">
                {STARTERS.map(([label, prefix]) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => { setDraft((text) => prefix + text); focusEnd(prefix.length + draft.length) }}
                    className="shrink-0 whitespace-nowrap text-muted-foreground hover:text-foreground"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          )}
          <span className="ml-auto hidden shrink-0 @md:inline">Enter to send · Shift+Enter for a new line</span>
        </div>
      </div>
    </div>
  )
}

/** The work behind a reply, folded into one chip; it stays open while the reply is still running. */
function WorkChip({ steps, running, liveOutput }: { steps: Step[]; running: boolean; liveOutput: Record<string, string> }) {
  const [open, setOpen] = React.useState<boolean>()
  const expanded = open ?? running
  const tools = steps.filter((s) => s.kind === "tool").length
  const label = running ? "Working" : tools ? `Worked · ${tools} step${tools === 1 ? "" : "s"}` : "Thought it through"
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="inline-flex h-7 max-w-full items-center gap-1 self-start rounded-full border px-2.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground"
      >
        <ChevronRightIcon className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")} />
        <span className={cn("truncate", running && "shimmer")}>{label}</span>
      </button>
      {expanded && (
        <div className="min-w-0 rounded-xl border bg-card/60 px-3 py-2">
          <Steps steps={steps} running={running} liveOutput={liveOutput} />
        </div>
      )}
    </div>
  )
}

function TurnView({ turn, streaming, anchor, liveOutput }: { turn: Turn | JobRun; streaming: boolean; anchor: boolean; liveOutput: Record<string, string> }) {
  if (turn.kind === "user") {
    return (
      <MessageScrollerItem messageId={turn.id} scrollAnchor={anchor} className="flex justify-end">
        <div className="max-w-[85%] rounded-[14px_14px_4px_14px] bg-accent px-3.5 py-2.5 text-sm break-words whitespace-pre-wrap">{turn.text}</div>
      </MessageScrollerItem>
    )
  }

  // A scheduled run that produced something: one line naming the job, what it did (folded), then the outcome.
  if (turn.kind === "job_run" || turn.kind === "job") {
    const prompt = turn.kind === "job_run" ? turn.prompt : turn.text
    const work = turn.kind === "job_run" ? turn.steps.filter((s) => s.kind !== "text") : []
    const reply = turn.kind === "job_run" ? turn.reply : undefined
    return (
      <MessageScrollerItem messageId={turn.id} className="flex min-w-0 flex-col gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-subtle" title={prompt}>
          <AlarmClockIcon className="size-3.5 shrink-0 text-tone-amber" />
          <span className="min-w-0 truncate">{jobTitle(prompt)}</span>
        </span>
        {work.length > 0 && <WorkChip steps={work} running={streaming && !reply} liveOutput={liveOutput} />}
        {reply ? (
          <div className="min-w-0 text-sm"><Markdown streaming={streaming}>{reply}</Markdown></div>
        ) : streaming ? (
          <span className="shimmer text-sm text-muted-foreground">Running…</span>
        ) : (
          <span className="text-xs text-muted-foreground">No update needed.</span>
        )}
      </MessageScrollerItem>
    )
  }

  const parts = segments(turn.steps)
  const lastText = [...parts].reverse().find((p) => p.kind === "text")
  return (
    <MessageScrollerItem messageId={turn.id} className="flex min-w-0 flex-col gap-2.5">
      {parts.map((part, index) =>
        part.kind === "steps" ? (
          <WorkChip key={index} steps={part.steps} running={streaming && index === parts.length - 1} liveOutput={liveOutput} />
        ) : (
          <div key={part.id} className="min-w-0 text-sm text-foreground/90">
            <Markdown streaming={streaming && part === lastText}>{part.text}</Markdown>
          </div>
        ),
      )}
    </MessageScrollerItem>
  )
}

function EmptyState({ thread, suggestions, onPick }: { thread: Thread; suggestions: Suggestion[]; onPick: (s: Suggestion) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-6 text-center">
      <AgentOrb size={48} />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold">{thread === "jobs" ? "No scheduled runs yet" : `${greeting()}.`}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {thread === "jobs"
            ? "Scheduled work and its results land here."
            : "I run around the clock, remember what matters to you, and teach myself new skills when I need them."}
        </p>
      </div>
      <div className="flex max-w-md flex-wrap justify-center gap-1.5">
        {suggestions.map((s) => (
          <button key={s.label} type="button" title={s.text} onClick={() => onPick(s)} className="h-8 rounded-full border px-3 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground">
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

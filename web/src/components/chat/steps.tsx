import * as React from "react"
import {
  AlarmClockIcon,
  BrainIcon,
  CalendarXIcon,
  CircleCheckIcon,
  FileTextIcon,
  FolderGit2Icon,
  ListIcon,
  LoaderCircleIcon,
  PencilIcon,
  SendIcon,
  SparklesIcon,
  TargetIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import type { Step } from "@/lib/turns"
import { CanvasStep } from "@/components/chat/CanvasStep"
import { Badge } from "@/components/ui/badge"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace"

type ToolStep = Extract<Step, { kind: "tool" }>

const str = (value: unknown) => (typeof value === "string" ? value : "")
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max)}…` : text)
const when = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })
}

/** How each of the agent's own tools reads in the transcript: an icon, and a title while running and once done. */
function describe(step: ToolStep): { icon: LucideIcon; running: string; done: string; highlight?: boolean } {
  const a = step.args
  switch (step.name) {
    case "bash":
      return { icon: TerminalIcon, running: `Running ${clip(str(a.command))}`, done: `Ran ${clip(str(a.command))}` }
    case "read":
      return { icon: FileTextIcon, running: `Reading ${str(a.path)}`, done: `Read ${str(a.path)}` }
    case "write":
      return { icon: PencilIcon, running: `Writing ${str(a.path)}`, done: `Wrote ${str(a.path)}` }
    case "edit":
      return { icon: PencilIcon, running: `Editing ${str(a.path)}`, done: `Edited ${str(a.path)}` }
    case "skill_save":
      return { icon: SparklesIcon, running: `Teaching itself “${str(a.name)}”`, done: `Learned a new skill: ${str(a.name)}`, highlight: true }
    case "skill_rollback":
      return { icon: Undo2Icon, running: `Rolling back ${str(a.name)}`, done: `Rolled back ${str(a.name)}` }
    case "skill_remove":
      return { icon: Undo2Icon, running: `Removing ${str(a.name)}`, done: `Removed skill ${str(a.name)}` }
    case "skill_list":
      return { icon: ListIcon, running: "Checking its skills", done: "Checked its skills" }
    case "memory":
      return a.action === "replace"
        ? { icon: BrainIcon, running: "Reorganising memory", done: "Reorganised its memory", highlight: true }
        : { icon: BrainIcon, running: "Remembering", done: `Remembered: ${clip(str(a.content), 70)}`, highlight: true }
    case "schedule_job":
      return { icon: AlarmClockIcon, running: "Scheduling", done: a.at ? `Scheduled for ${when(str(a.at))}` : "Scheduled a reminder", highlight: true }
    case "list_jobs":
      return { icon: ListIcon, running: "Checking the schedule", done: "Checked the schedule" }
    case "cancel_job":
      return { icon: CalendarXIcon, running: "Cancelling a job", done: `Cancelled ${str(a.id)}` }
    case "notify":
      return { icon: SendIcon, running: "Messaging you on Telegram", done: "Sent you a Telegram message" }
    case "list_projects":
      return { icon: FolderGit2Icon, running: "Checking your projects", done: "Checked your projects and worker" }
    case "create_goal":
      return { icon: TargetIcon, running: "Opening a goal", done: `Opened a goal: ${clip(str(a.title), 60)}`, highlight: true }
    case "approve_plan":
      return { icon: CircleCheckIcon, running: "Approving the plan", done: "Approved the plan: coding agents are on it", highlight: true }
    case "goal_status":
      return { icon: ListIcon, running: "Checking progress", done: "Checked progress on your goals" }
    case "message_foreman":
      return { icon: SendIcon, running: "Briefing the foreman", done: "Briefed the foreman" }
    case "cancel_goal":
      return { icon: CalendarXIcon, running: "Cancelling the goal", done: "Cancelled the goal" }
    case "recent_activity":
      return { icon: ListIcon, running: "Reading recent activity", done: "Read recent activity" }
    default:
      return { icon: WrenchIcon, running: `Using ${step.name}`, done: `Used ${step.name}` }
  }
}

/** Titles for failed calls of tools whose success title would read wrong when red. */
const FAILED: Record<string, string> = {
  skill_save: "A new skill didn't load",
  skill_rollback: "Couldn't roll back",
  memory: "Couldn't update memory",
  schedule_job: "Couldn't schedule that",
  cancel_job: "Couldn't cancel the job",
  notify: "Couldn't send the Telegram message",
  create_goal: "Couldn't open the goal",
  approve_plan: "Couldn't approve the plan",
}

function Output({ title, children }: { title?: string; children: string }) {
  return (
    <CodeBlock size="sm">
      {title && (
        <CodeBlockHeader>
          <CodeBlockTitle>{title}</CodeBlockTitle>
        </CodeBlockHeader>
      )}
      <CodeBlockContent wrap className="max-h-72">
        {children}
      </CodeBlockContent>
    </CodeBlock>
  )
}

function ToolDetail({ step, live }: { step: ToolStep; live?: string }) {
  const output = step.result ?? live ?? ""
  if (step.name === "skill_save") {
    return (
      <div className="flex flex-col gap-2">
        {str(step.args.description) && <p className="text-sm text-muted-foreground">{str(step.args.description)}</p>}
        <Output title={`${str(step.args.name)}.mjs`}>{str(step.args.code)}</Output>
        {output && <p className="text-xs text-muted-foreground">{output}</p>}
      </div>
    )
  }
  if (step.name === "bash") return <Output>{output || "…"}</Output>
  if (step.name === "memory" || step.name === "notify") {
    return <p className="text-sm whitespace-pre-wrap text-muted-foreground">{str(step.args.content) || str(step.args.message)}</p>
  }
  if (step.name === "schedule_job") {
    const every = typeof step.args.everyMinutes === "number" ? step.args.everyMinutes : undefined
    return (
      <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        <p className="whitespace-pre-wrap">{str(step.args.prompt)}</p>
        {every && <Badge variant="secondary">repeats every {every >= 60 ? `${every / 60} h` : `${every} min`}</Badge>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {step.argsText && step.argsText !== "{}" && <Output title="input">{JSON.stringify(step.args, null, 2)}</Output>}
      {output && <Output title="output">{output}</Output>}
    </div>
  )
}

function ToolRow({ step, running, live }: { step: ToolStep; running: boolean; live?: string }) {
  const [open, setOpen] = React.useState<boolean>()
  const { icon: Icon, running: runningTitle, done, highlight } = describe(step)
  const pending = step.result === undefined
  const active = pending && running
  const failed = step.error || (pending && !running)
  const title = active ? runningTitle : failed ? (FAILED[step.name] ?? `${done.replace(/^(Ran|Used|Read|Wrote|Edited)\b/, "Failed:")}`) : done

  return (
    <TraceCollapsible open={open ?? (active && step.name === "bash" && Boolean(live))} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={active ? "running" : failed ? "error" : undefined}>
          <TraceIcon className={highlight && !active && !failed ? "text-tone-amber" : undefined}>
            {active ? <LoaderCircleIcon className="animate-spin" /> : <Icon />}
          </TraceIcon>
          <TraceTitle className={highlight && !active && !failed ? "text-foreground" : undefined}>{title}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <ToolDetail step={step} live={live} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = React.useState<boolean>()
  return (
    <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>{running ? <LoaderCircleIcon className="animate-spin" /> : <CircleCheckIcon />}</TraceIcon>
          <TraceTitle>{running ? "Thinking" : "Thought it through"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="text-sm whitespace-pre-wrap text-muted-foreground">{text}</TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function CanvasRow({ step }: { step: Extract<Step, { kind: "canvas" }> }) {
  return <CanvasStep id={step.id} canvasId={step.canvasId} ops={step.ops} />
}

export function Steps({
  steps,
  running,
  liveOutput,
}: {
  steps: Step[]
  running: boolean
  liveOutput: Record<string, string>
}) {
  const last = steps.at(-1)
  return (
    <Trace>
      {steps.map((step) =>
        step.kind === "reasoning" ? (
          <ReasoningRow key={step.id} text={step.text} running={running && step === last} />
        ) : step.kind === "tool" ? (
          <ToolRow key={step.id} step={step} running={running} live={liveOutput[step.id]} />
        ) : step.kind === "canvas" ? (
          <CanvasRow key={step.id} step={step} />
        ) : null,
      )}
    </Trace>
  )
}

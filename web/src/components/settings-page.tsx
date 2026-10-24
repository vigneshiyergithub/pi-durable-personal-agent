import * as React from "react"
import { ChevronDownIcon, LogOutIcon } from "lucide-react"
import { useTheme } from "next-themes"
import { toast } from "sonner"

import { api, type Status } from "@/lib/api"
import type { OrchestraState } from "@/lib/orchestra"
import { fromNow } from "@/lib/time"
import { cn } from "@/lib/utils"
import { SandboxSetup } from "@/components/sandbox-setup"
import { SecuritySettings } from "@/components/security-settings"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"

const box = "flex flex-col gap-3 rounded-[14px] border p-[18px]"

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border p-4">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

export function SettingsPage({
  status,
  orchestra,
  onChanged,
  onSignOut,
  onSignedOut,
}: {
  status: Status | undefined
  orchestra: OrchestraState | undefined
  onChanged: () => void
  onSignOut: () => void
  onSignedOut: () => void
}) {
  const [reflecting, setReflecting] = React.useState(false)
  const { theme, setTheme } = useTheme()

  async function reflect() {
    setReflecting(true)
    const id = toast.loading("Reflecting on recent work…", { description: "Reviewing, fixing skills, tidying memory." })
    try {
      const { report } = await api<{ report?: string }>("/api/reflect", { method: "POST" })
      toast.success("Reflection finished", { id, description: report ? report.slice(0, 280) : "Nothing to change." })
      onChanged()
    } catch (error) {
      toast.error("Reflection failed", { id, description: error instanceof Error ? error.message : String(error) })
    } finally {
      setReflecting(false)
    }
  }

  if (!status) {
    return (
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-4 sm:px-8 sm:py-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full rounded-[14px]" />
        <Skeleton className="h-40 w-full rounded-[14px]" />
      </div>
    )
  }

  const nextReflect =
    status.lastReflectAt && status.reflectEveryHours > 0
      ? new Date(Date.parse(status.lastReflectAt) + status.reflectEveryHours * 3_600_000).toISOString()
      : undefined
  const broken = status.skills.filter((s) => s.error).length
  const busy = reflecting || status.reflecting

  return (
    <div className="h-full overflow-y-auto">
      <section aria-label="Settings" className="mx-auto flex w-full max-w-[880px] flex-col gap-4 p-4 sm:px-8 sm:py-6">
        <h1 className="text-[22px] font-semibold">Agent settings</h1>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border bg-card p-[18px]">
          <div className="flex max-w-[520px] flex-col gap-0.5">
            <span className="font-semibold">Self-improvement · every {status.reflectEveryHours} h</span>
            <span className="text-[13px] text-muted-foreground">
              Reviews recent work, repairs or writes skills, and tidies memory.{" "}
              {status.lastReflectAt ? `Last ${fromNow(status.lastReflectAt)}` : "Not run yet"}
              {nextReflect ? ` · next ${fromNow(nextReflect)}` : ""}.
            </span>
          </div>
          <button type="button" disabled={busy} onClick={() => void reflect()} className="inline-flex h-10 items-center gap-2 rounded-[10px] border border-border-strong px-3.5 text-[13px] hover:bg-accent disabled:opacity-60">
            {busy && <Spinner />} Reflect now
          </button>
        </div>

        {orchestra && <SandboxSetup state={orchestra} />}

        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-3">
          <Tile label="Chat model"><span className="font-mono text-[13px] break-all">{status.model}</span></Tile>
          <Tile label="Reflection model"><span className="font-mono text-[13px] break-all">{status.reflectModel}</span></Tile>
          <Tile label="Monthly spend cap">
            <span className="font-semibold">${status.maxSpendUsd}</span>
            <span className="text-xs text-subtle">${status.spendUsd.toFixed(2)} used · new work pauses at the cap</span>
          </Tile>
          <Tile label="Theme">
            <div className="flex gap-1" role="group" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)} className={cn("h-8 rounded-lg px-2.5 text-[13px] capitalize", theme === t ? "bg-secondary font-semibold" : "text-muted-foreground hover:text-foreground")}>
                  {t}
                </button>
              ))}
            </div>
          </Tile>
        </div>

        <div className={box}>
          <span className="font-semibold">Skills · {status.skills.length - broken} active{broken ? ` · ${broken} broken` : ""}</span>
          {status.skills.length === 0 ? (
            <span className="text-[13px] text-muted-foreground">No skills yet. Ask for something it can't do yet, and it will write itself a skill.</span>
          ) : (
            status.skills.map((skill) => (
              <Collapsible key={skill.name} className="rounded-[10px] bg-card">
                <CollapsibleTrigger className="group flex w-full items-center gap-2 px-3 py-2.5 text-left">
                  <ChevronDownIcon className="size-3.5 shrink-0 -rotate-90 text-muted-foreground transition-transform group-aria-expanded:rotate-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{skill.name}</span>
                  <span className={cn("rounded-full px-2 py-px text-[11px]", skill.error ? "bg-tone-red-soft text-tone-red" : "bg-tone-green-soft text-tone-green")}>{skill.error ? "broken" : "active"}</span>
                </CollapsibleTrigger>
                <CollapsibleContent className="flex flex-col gap-2 px-3 pb-3 pl-8 text-[13px]">
                  {skill.description && <p className="text-muted-foreground">{skill.description}</p>}
                  {skill.error && <p className="font-mono text-xs break-words text-tone-red">{skill.error}</p>}
                  {skill.tools.length > 0 && <p className="font-mono text-xs text-subtle">{skill.tools.join(" · ")}</p>}
                </CollapsibleContent>
              </Collapsible>
            ))
          )}
        </div>

        <div className={box}>
          <span className="font-semibold">Security · sign-in and sessions</span>
          <SecuritySettings onSignedOut={onSignedOut} />
          <button type="button" onClick={onSignOut} className="inline-flex h-10 items-center gap-2 self-start rounded-[10px] border border-border-strong px-3.5 text-[13px] hover:bg-accent">
            <LogOutIcon className="size-4" /> Sign out
          </button>
        </div>
      </section>
    </div>
  )
}

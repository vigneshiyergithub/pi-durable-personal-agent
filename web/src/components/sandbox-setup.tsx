import * as React from "react"
import { CircleCheckIcon, CircleDashedIcon, ContainerIcon, FolderGit2Icon, GitBranchIcon, ShieldCheckIcon } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { OrchestraState } from "@/lib/orchestra"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

type Setup = {
  missing: string[]
  githubApp: { slug: string; org: string | null; installed: boolean } | null
  publicUrl: string | null
}

/** Sends the browser to GitHub with a pre-filled app manifest; GitHub returns the app's key straight to the agent. */
function submitManifest(action: string, manifest: string) {
  const form = document.createElement("form")
  form.method = "post"
  form.action = action
  const input = document.createElement("input")
  input.type = "hidden"
  input.name = "manifest"
  input.value = manifest
  form.append(input)
  document.body.append(form)
  form.submit()
}

/** Where coding tasks run, and what is still missing before they can. */
export function SandboxSetup({ state }: { state: OrchestraState }) {
  const [setup, setSetup] = React.useState<Setup>()
  const [org, setOrg] = React.useState("")
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    const load = () => void api<Setup>("/api/setup").then(setSetup).catch(() => {})
    load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [])

  async function createApp() {
    setBusy(true)
    try {
      const { action, manifest } = await api<{ action: string; manifest: string }>("/api/setup/github-app", {
        method: "POST",
        body: JSON.stringify({ org: org.trim() }),
      })
      submitManifest(action, manifest)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  const ready = setup && setup.missing.length === 0
  const needsApp = setup && !setup.githubApp
  return (
    <div className="flex flex-col gap-3 rounded-2xl border p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <ContainerIcon className="size-4 text-muted-foreground" />
        Coding tasks run in throwaway containers
        {setup && (
          <Badge variant={ready ? "secondary" : "outline"} className="ml-auto">
            {ready ? "ready" : "setup needed"}
          </Badge>
        )}
      </div>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0" />
        Each attempt gets a fresh container, a read-only token for one repo and a capped model key, all deleted afterwards. Only
        the agent pushes, and only to agent/ branches.
      </p>

      {setup && setup.missing.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {["the Railway sandbox project", "an OpenRouter management key", "the GitHub App", "the agent's public URL"].map((item) => {
            const missing = setup.missing.includes(item)
            return (
              <li key={item} className="flex items-center gap-2">
                {missing ? <CircleDashedIcon className="size-4 text-tone-amber" /> : <CircleCheckIcon className="size-4 text-tone-green" />}
                <span className={missing ? "" : "text-muted-foreground"}>{item[0]!.toUpperCase() + item.slice(1)}</span>
              </li>
            )
          })}
          {setup.missing
            .filter((m) => m.startsWith("installing"))
            .map((m) => (
              <li key={m} className="flex items-center gap-2">
                <CircleDashedIcon className="size-4 text-tone-amber" />
                {m[0]!.toUpperCase() + m.slice(1)}
              </li>
            ))}
        </ul>
      )}

      {needsApp && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            Create a free GitHub org for the agent first, then enter its name. GitHub shows you the app's permissions before
            anything is created.
          </p>
          <InputGroup>
            <InputGroupAddon>
              <GitBranchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="your-agent-org" value={org} onChange={(e) => setOrg(e.target.value)} aria-label="GitHub org" />
            <InputGroupAddon align="inline-end">
              <InputGroupButton variant="default" size="xs" disabled={busy || !org.trim()} onClick={() => void createApp()}>
                {busy ? <Spinner /> : null} Create GitHub App
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </div>
      )}
      {setup?.githubApp && !setup.githubApp.installed && (
        <Button size="sm" variant="outline" render={<a href={`https://github.com/apps/${setup.githubApp.slug}/installations/new`} target="_blank" rel="noreferrer" />}>
          <GitBranchIcon /> Install {setup.githubApp.slug} on your org
        </Button>
      )}

      {state.projects.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          {state.projects.map((p) => (
            <div key={p.id} className="flex min-w-0 items-start gap-2 text-sm">
              <FolderGit2Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              {/* Repo above its merge policy, so neither is ever cut off. */}
              <span className="flex min-w-0 flex-col">
                <span className="break-all">{p.repo}</span>
                <span className="text-xs text-muted-foreground">
                  {p.merge === "owner" ? "You merge" : p.merge === "veto" ? "Agent merges, you can veto" : "Agent merges"}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

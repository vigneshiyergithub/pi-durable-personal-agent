import * as React from "react"
import { FingerprintIcon, FileKeyIcon, KeyRoundIcon, LogOutIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { addPasskey, RecoveryCodes } from "@/components/login"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

type Security = {
  passkeys: Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null }>
  recoveryCodesLeft: number
  activeSessions: number
  bearerTokenEnabled: boolean
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "never")

/** Passkeys, recovery codes and sessions. */
export function SecuritySettings({ onSignedOut }: { onSignedOut: () => void }) {
  const [security, setSecurity] = React.useState<Security>()
  const [busy, setBusy] = React.useState<string>()
  const [codes, setCodes] = React.useState<string[]>()
  const keyInput = React.useRef<HTMLInputElement>(null)
  const load = React.useCallback(() => void api<Security>("/api/auth/security").then(setSecurity).catch(() => {}), [])
  React.useEffect(load, [load])

  async function act(name: string, action: () => Promise<void>) {
    setBusy(name)
    try {
      await action()
      load()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!/NotAllowedError/.test(message)) toast.error(message)
    } finally {
      setBusy(undefined)
    }
  }

  if (!security) return null
  return (
    <div className="flex flex-col gap-3">
      {security.bearerTokenEnabled && (
        <p className="flex items-start gap-2 rounded-xl bg-tone-amber-soft px-3 py-2 text-xs text-tone-amber">
          <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          The old access token still works. Once your passkeys are set up, remove AUTH_TOKEN from Railway to turn it off.
        </p>
      )}
      {security.passkeys.map((p) => (
        <div key={p.id} className="flex items-center gap-2 text-sm">
          <FingerprintIcon className="size-4 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{p.name}</span>
            <span className="text-xs text-muted-foreground">added {when(p.createdAt)} · last used {when(p.lastUsedAt)}</span>
          </span>
          {security.passkeys.length > 1 && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${p.name}`}
              disabled={busy !== undefined}
              onClick={() => window.confirm(`Remove "${p.name}"?`) && void act("remove", () => api(`/api/auth/passkeys/${p.id}`, { method: "DELETE" }))}
            >
              <Trash2Icon />
            </Button>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" disabled={busy !== undefined} onClick={() => void act("add", async () => {
          await addPasskey(window.prompt("Name this passkey", "Another device") || "Passkey")
          toast.success("Passkey added")
        })}>
          {busy === "add" ? <Spinner /> : <FingerprintIcon />} Add a passkey
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== undefined} onClick={() => window.confirm("Replace all recovery codes? The old ones stop working.") && void act("codes", async () => {
          setCodes((await api<{ recoveryCodes: string[] }>("/api/auth/recovery-codes", { method: "POST" })).recoveryCodes)
        })}>
          <KeyRoundIcon /> New recovery codes ({security.recoveryCodesLeft} left)
        </Button>
        <Button size="xs" variant="outline" disabled={busy !== undefined} onClick={() => keyInput.current?.click()}>
          {busy === "key" ? <Spinner /> : <FileKeyIcon />} Replace GitHub App key
        </Button>
        <input
          ref={keyInput}
          type="file"
          accept=".pem"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (!file) return
            void act("key", async () => {
              const { message } = await api<{ message: string }>("/api/setup/github-app/key", {
                method: "POST",
                body: JSON.stringify({ privateKey: await file.text() }),
              })
              toast.success(message)
            })
          }}
        />
        <Button size="xs" variant="ghost" className="text-muted-foreground" disabled={busy !== undefined} onClick={() => window.confirm("Sign out on every device?") && void act("out", async () => {
          await api("/api/auth/logout-all", { method: "POST" })
          onSignedOut()
        })}>
          <LogOutIcon /> Sign out everywhere ({security.activeSessions})
        </Button>
      </div>
      <Dialog open={codes !== undefined} onOpenChange={(open) => !open && setCodes(undefined)}>
        <DialogContent>
          <DialogHeader className="sr-only">
            <DialogTitle>Recovery codes</DialogTitle>
          </DialogHeader>
          {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(undefined)} />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

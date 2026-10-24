import * as React from "react"
import { startAuthentication, startRegistration } from "@simplewebauthn/browser"
import { ArrowRightIcon, CopyIcon, DownloadIcon, FingerprintIcon, KeyRoundIcon, LifeBuoyIcon } from "lucide-react"
import { motion } from "motion/react"
import { toast } from "sonner"

import { api, type AuthState } from "@/lib/api"
import { AgentOrb } from "@/components/agent-orb"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

/** Adds a passkey on this device. With `bootstrapToken`, it is the very first one (proved with the legacy token). */
export async function addPasskey(name: string, bootstrapToken?: string): Promise<{ recoveryCodes?: string[] }> {
  const headers: Record<string, string> = bootstrapToken ? { authorization: `Bearer ${bootstrapToken}` } : {}
  const options = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/api/auth/register/options", { method: "POST", headers })
  const response = await startRegistration({ optionsJSON: options })
  return api("/api/auth/register/verify", { method: "POST", headers, body: JSON.stringify({ response, name }) })
}

const deviceName = () => {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Mac/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : "This device"
  return `${os} passkey`
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n")
  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <div>
        <h2 className="text-lg font-semibold">Save your recovery codes</h2>
        <p className="text-sm text-muted-foreground">
          If you lose your passkey, each code signs you in once so you can add a new one. They are shown only now; keep them in a
          password manager.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 rounded-2xl border bg-muted/40 p-4 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}>
          <CopyIcon /> Copy
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const a = document.createElement("a")
            a.href = URL.createObjectURL(new Blob([`Personal agent recovery codes (each works once)\n\n${text}\n`], { type: "text/plain" }))
            a.download = "agent-recovery-codes.txt"
            a.click()
          }}
        >
          <DownloadIcon /> Download
        </Button>
        <Button size="sm" className="ml-auto" onClick={onDone}>
          I saved them <ArrowRightIcon />
        </Button>
      </div>
    </div>
  )
}

export function Login({ state, onSignedIn }: { state: AuthState; onSignedIn: () => void }) {
  const [mode, setMode] = React.useState<"passkey" | "recovery" | "enrol">(state.enrolled ? "passkey" : "enrol")
  const [value, setValue] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [codes, setCodes] = React.useState<string[]>()

  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError(undefined)
    try {
      await action()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(/NotAllowedError|timed out|not allowed/i.test(message) ? "Cancelled or timed out. Try again." : message)
    } finally {
      setBusy(false)
    }
  }

  const signIn = () =>
    run(async () => {
      const options = await api<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/api/auth/login/options", { method: "POST" })
      const response = await startAuthentication({ optionsJSON: options })
      await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ response }) })
      onSignedIn()
    })

  const recover = () =>
    run(async () => {
      const { remaining } = await api<{ remaining: number }>("/api/auth/recover", { method: "POST", body: JSON.stringify({ code: value }) })
      toast.success(`Signed in with a recovery code (${remaining} left). Add a new passkey under Agent → Security.`)
      onSignedIn()
    })

  const enrol = () =>
    run(async () => {
      const result = await addPasskey(deviceName(), value.trim())
      if (result.recoveryCodes) setCodes(result.recoveryCodes)
      else onSignedIn()
    })

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        {codes ? (
          <RecoveryCodes codes={codes} onDone={onSignedIn} />
        ) : (
          <>
            <AgentOrb size={64} />
            <div className="flex flex-col gap-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">Your agent</h1>
              <p className="text-sm text-muted-foreground">
                {mode === "passkey" && "Sign in with your passkey."}
                {mode === "recovery" && "Enter one of your recovery codes."}
                {mode === "enrol" && (state.bootstrap ? "Set up a passkey. Prove it's you with your current access token, once." : "Passkey setup isn't available. Set AUTH_TOKEN on the agent to enrol.")}
              </p>
            </div>

            {mode === "passkey" && (
              <Button size="lg" className="w-full" onClick={() => void signIn()} disabled={busy}>
                {busy ? <Spinner /> : <FingerprintIcon />} Sign in with passkey
              </Button>
            )}

            {(mode === "recovery" || (mode === "enrol" && state.bootstrap)) && (
              <form
                className="w-full"
                onSubmit={(e) => {
                  e.preventDefault()
                  void (mode === "recovery" ? recover() : enrol())
                }}
              >
                <InputGroup className="rounded-2xl">
                  <InputGroupAddon>{mode === "recovery" ? <LifeBuoyIcon /> : <KeyRoundIcon />}</InputGroupAddon>
                  <InputGroupInput
                    type={mode === "recovery" ? "text" : "password"}
                    autoFocus
                    placeholder={mode === "recovery" ? "XXXX-XXXX-XXXX" : "Current AUTH_TOKEN"}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    aria-label={mode === "recovery" ? "Recovery code" : "Access token"}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton type="submit" size="xs" variant="default" disabled={busy || !value.trim()}>
                      {busy ? <Spinner /> : mode === "recovery" ? "Sign in" : <><FingerprintIcon /> Create passkey</>}
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
              </form>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {state.enrolled && (
              <button className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={() => { setMode(mode === "recovery" ? "passkey" : "recovery"); setError(undefined); setValue("") }}>
                {mode === "recovery" ? "Use my passkey instead" : "Lost your passkey? Use a recovery code"}
              </button>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}

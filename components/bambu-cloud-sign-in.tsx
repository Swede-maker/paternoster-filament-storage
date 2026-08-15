"use client"

import { useState } from "react"
import { Loader2, Check, LogOut } from "lucide-react"
import { Button } from "./ui/button"
import { Field, Input, Segmented } from "./ui/field"
import {
  bambuCloudLogin,
  bambuCloudVerify,
  bambuCloudTfa,
  bambuCloudDevices,
  type BambuRegion,
  type BambuCloudDevice,
  type BambuTokens,
} from "@/lib/bambu"

/** The data a completed cloud sign-in yields for one chosen printer. */
export type BambuCloudLink = {
  region: BambuRegion
  email: string
  token: string
  uid: string
  /** Present when the account supports silent refresh. */
  refreshToken?: string
  /** Epoch-ms hint of when `token` stops working. */
  expiresAt?: number
  serial: string
  deviceName: string
}

type Step = "credentials" | "verify" | "tfa" | "devices"

/**
 * Self-contained Bambu cloud sign-in flow. Handles region select, email/password,
 * an optional email verification code or 2FA code, then lists the account's
 * printers and calls `onLinked` with the chosen one. The password is only used to
 * obtain a token and is never stored or surfaced.
 */
export function BambuCloudSignIn({
  linkedEmail,
  onLinked,
  onSignOut,
}: {
  /** When already signed in, show the summary + sign-out instead of the form. */
  linkedEmail?: string
  onLinked: (link: BambuCloudLink) => void
  onSignOut?: () => void
}) {
  const [step, setStep] = useState<Step>("credentials")
  const [region, setRegion] = useState<BambuRegion>("global")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [tfaKey, setTfaKey] = useState("")
  const [tokens, setTokens] = useState<BambuTokens | null>(null)
  const [devices, setDevices] = useState<BambuCloudDevice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (linkedEmail) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-success/40 bg-success/10 p-3">
        <div className="flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-success" />
          <span className="text-foreground">
            Signed in as <span className="font-medium">{linkedEmail}</span>
          </span>
        </div>
        {onSignOut && (
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOut className="mr-1.5 h-3.5 w-3.5" />
            Sign out
          </Button>
        )}
      </div>
    )
  }

  async function afterToken(t: BambuTokens) {
    setTokens(t)
    setBusy(true)
    setError(null)
    const res = await bambuCloudDevices(region, t.token)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setDevices(res.devices)
    setStep("devices")
  }

  async function handleLogin() {
    setBusy(true)
    setError(null)
    const res = await bambuCloudLogin(region, email.trim(), password)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if ("token" in res) return afterToken(res)
    if ("needVerify" in res) {
      setStep("verify")
      return
    }
    if ("needTfa" in res) {
      setTfaKey(res.tfaKey)
      setStep("tfa")
      return
    }
  }

  async function handleVerify() {
    setBusy(true)
    setError(null)
    const res = await bambuCloudVerify(region, email.trim(), password, code.trim())
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if ("token" in res) return afterToken(res)
    setError("Verification did not return a token")
  }

  async function handleTfa() {
    setBusy(true)
    setError(null)
    const res = await bambuCloudTfa(region, tfaKey, code.trim())
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    if ("token" in res) return afterToken(res)
    setError("2FA did not return a token")
  }

  return (
    <div className="space-y-4 rounded-lg border border-border bg-background/40 p-3">
      {step === "credentials" && (
        <>
          <Field label="Account region">
            <Segmented
              className="w-full [&>button]:flex-1"
              value={region}
              onChange={(v) => setRegion(v as BambuRegion)}
              options={[
                { value: "global", label: "Global" },
                { value: "china", label: "China" },
              ]}
            />
          </Field>
          <Field label="Bambu account email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              spellCheck={false}
              autoComplete="username"
            />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Your Bambu account password"
              autoComplete="current-password"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && email && password && !busy) {
                  handleLogin()
                }
              }}
            />
          </Field>
          <Button onClick={handleLogin} disabled={busy || !email.trim() || !password} className="w-full">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Sign in
          </Button>
          <p className="text-xs text-muted-foreground">
            Your password is used once to get an access token and is never stored. Only the token is saved so the
            printer stays linked.
          </p>
        </>
      )}

      {(step === "verify" || step === "tfa") && (
        <>
          <Field label={step === "verify" ? "Email verification code" : "Authenticator (2FA) code"}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Enter the 6-digit code"
              inputMode="numeric"
              className="font-mono"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229 && code.trim() && !busy) {
                  step === "verify" ? handleVerify() : handleTfa()
                }
              }}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            {step === "verify"
              ? `Bambu emailed a code to ${email || "your account"}. Enter it to finish signing in.`
              : "Enter the current code from your authenticator app."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setCode("")
                setError(null)
                setStep("credentials")
              }}
            >
              Back
            </Button>
            <Button
              onClick={step === "verify" ? handleVerify : handleTfa}
              disabled={busy || !code.trim()}
              className="flex-1"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Verify
            </Button>
          </div>
        </>
      )}

      {step === "devices" && (
        <>
          <p className="text-sm text-foreground">Choose the printer to link:</p>
          {devices.length === 0 ? (
            <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              No printers are bound to this account. Add the printer in the Bambu Handy app first, then try again.
            </p>
          ) : (
            <div className="space-y-2">
              {devices.map((d) => (
                <button
                  key={d.serial}
                  type="button"
                  onClick={() =>
                    tokens &&
                    onLinked({
                      region,
                      email: email.trim(),
                      token: tokens.token,
                      uid: tokens.uid,
                      refreshToken: tokens.refreshToken,
                      expiresAt: tokens.expiresAt,
                      serial: d.serial,
                      deviceName: d.name,
                    })
                  }
                  className="flex w-full items-center justify-between rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
                >
                  <span>
                    <span className="block text-sm font-medium text-foreground">{d.name}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {d.serial}
                      {d.model ? ` · ${d.model}` : ""}
                    </span>
                  </span>
                  <span
                    className={`h-2.5 w-2.5 rounded-full ${d.online ? "bg-success" : "bg-muted-foreground/40"}`}
                    aria-label={d.online ? "online" : "offline"}
                  />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

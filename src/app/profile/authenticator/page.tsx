"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import { OtpInputField, SecurityFlowShell } from "@/components/profile-security-flow"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"

export default function AuthenticatorSetupPage() {
  const router = useRouter()
  const { user, loading, setUserDirect } = useAuth()
  const [setup, setSetup] = React.useState<{ secret: string; uri: string } | null>(null)
  const [step, setStep] = React.useState<"scan" | "verify">("scan")
  const [code, setCode] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!user && !loading) router.replace("/login?redirect=/profile/authenticator")
  }, [user, loading, router])

  async function startSetup() {
    if (!user) return toast.error("Authentication required")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/totp/setup", { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to start authenticator setup")
      setSetup({ secret: String(data.secret), uri: String(data.uri) })
      setStep("scan")
      setCode("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to start authenticator setup")
    } finally {
      setSubmitting(false)
    }
  }

  async function confirmSetup(event: React.FormEvent) {
    event.preventDefault()
    if (!setup) return toast.error("Generate the QR code first")
    if (code.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/totp/setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to enable authenticator")
      setUserDirect(data.user)
      toast.success("Authenticator app enabled")
      router.replace("/profile")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to enable authenticator")
    } finally {
      setSubmitting(false)
    }
  }

  if (!user) return null

  return (
    <SecurityFlowShell
      title="Set up authenticator"
      description="Add an authenticator app as a verification method for your account."
    >
      {!setup ? (
        <FieldGroup>
          <Field>
            <FieldLabel>Authenticator app</FieldLabel>
            <FieldDescription>
              Generate a QR code and scan it with Google Authenticator, 1Password, Authy, or a compatible app.
            </FieldDescription>
          </Field>
          <Field>
            <Button type="button" onClick={() => void startSetup()} disabled={submitting}>
              {submitting ? "Generating..." : "Generate QR code"}
            </Button>
          </Field>
        </FieldGroup>
      ) : step === "scan" ? (
        <FieldGroup>
          <Field className="items-center text-center">
            <div className="mx-auto flex aspect-square w-full max-w-72 items-center justify-center rounded-3xl border bg-white p-3 shadow-sm">
              {/* QR image is generated from an otpauth URI for authenticator app setup. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt="Authenticator QR code"
                className="aspect-square h-full w-full object-contain"
                src={`https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(setup.uri)}`}
              />
            </div>
            <FieldDescription className="max-w-xs text-center">
              Scan this QR code with your authenticator app.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Manual setup key</FieldLabel>
            <div className="break-all rounded-2xl border bg-muted/30 p-3 font-mono text-sm leading-6">
              {setup.secret}
            </div>
            <FieldDescription>
              Use this key only if your app cannot scan the QR code.
            </FieldDescription>
          </Field>
          <Field className="grid gap-3 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => void startSetup()}
              disabled={submitting}
            >
              Regenerate
            </Button>
            <Button type="button" onClick={() => setStep("verify")} disabled={!setup}>
              Next
            </Button>
          </Field>
        </FieldGroup>
      ) : (
        <form onSubmit={confirmSetup}>
          <FieldGroup>
            <OtpInputField displayTarget="your authenticator app" code={code} setCode={setCode} />
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={() => setStep("scan")}>
                Back
              </Button>
              <Button type="submit" disabled={submitting || code.length !== 6}>
                Enable authenticator
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
    </SecurityFlowShell>
  )
}

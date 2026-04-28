"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { useAuth } from "@/components/auth-provider"
import {
  OtpInputField,
  SecurityFlowShell,
} from "@/components/profile-security-flow"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"

type VerificationMethod = "authenticator" | "email" | "sms"

function passwordIsStrong(value: string) {
  return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)
}

export default function ChangePasswordPage() {
  const router = useRouter()
  const { user, loading, setUserDirect } = useAuth()
  const [step, setStep] = React.useState<"verify" | "password">("verify")
  const [method, setMethod] = React.useState<VerificationMethod>("email")
  const [code, setCode] = React.useState("")
  const [codeSent, setCodeSent] = React.useState(false)
  const [showVerificationMethods, setShowVerificationMethods] = React.useState(false)
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!user && !loading) router.replace("/login?redirect=/profile/change-password")
  }, [user, loading, router])

  React.useEffect(() => {
    if (!user) return
    setMethod(user.totpEnabled ? "authenticator" : "email")
  }, [user])

  if (!user) return null

  const methods: Array<{ id: VerificationMethod; label: string }> = [
    ...(user.totpEnabled ? [{ id: "authenticator" as const, label: "Authenticator app" }] : []),
    { id: "email" as const, label: "Email OTP" },
    ...(user.mobileVerified && user.mobileNumber ? [{ id: "sms" as const, label: "SMS OTP" }] : []),
  ]

  async function sendCode(nextMethod: VerificationMethod = method) {
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-change/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: nextMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to send verification code")
      setMethod(nextMethod)
      setCode("")
      setCodeSent(true)
      setShowVerificationMethods(false)
      toast.success("Verification code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send verification code")
    } finally {
      setSubmitting(false)
    }
  }

  function selectAuthenticator() {
    setMethod("authenticator")
    setCode("")
    setCodeSent(true)
    setShowVerificationMethods(false)
  }

  async function continueAfterCode(event: React.FormEvent) {
    event.preventDefault()
    if (code.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-change/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Verification code is invalid")
      setStep("password")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification code is invalid")
    } finally {
      setSubmitting(false)
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    if (!passwordIsStrong(password)) {
      return toast.error("Use 8+ characters with uppercase, lowercase, and a number")
    }
    if (password !== confirmPassword) return toast.error("Passwords do not match")

    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-change/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, code, password }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to change password")
      setUserDirect(data.user)
      toast.success("Password changed")
      router.replace("/profile")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to change password")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <SecurityFlowShell
      title="Change password"
      description="Verify your identity first, then choose a new password."
    >
      {step === "verify" ? (
        <form onSubmit={continueAfterCode}>
          <FieldGroup>
            {showVerificationMethods ? (
              <Field>
                <FieldLabel className="justify-center text-center">Verification methods</FieldLabel>
                <div className="flex flex-col gap-2">
                  {methods.map((availableMethod) => (
                    <Button
                      key={availableMethod.id}
                      type="button"
                      variant="outline"
                      className="rounded-xl"
                      onClick={() =>
                        availableMethod.id === "authenticator"
                          ? selectAuthenticator()
                          : void sendCode(availableMethod.id)
                      }
                      disabled={submitting}
                    >
                      {availableMethod.label}
                    </Button>
                  ))}
                </div>
              </Field>
            ) : method !== "authenticator" && !codeSent ? (
              <>
                <Field>
                  <Button type="button" onClick={() => void sendCode()} disabled={submitting}>
                    Send {method === "sms" ? "SMS" : "email"} code
                  </Button>
                </Field>
                <Field>
                  <button
                    type="button"
                    className="text-center text-sm underline underline-offset-4"
                    onClick={() => setShowVerificationMethods(true)}
                  >
                    View other verification methods
                  </button>
                </Field>
              </>
            ) : (
              <>
                <OtpInputField
                  displayTarget={
                    method === "authenticator"
                      ? "your authenticator app"
                      : method === "sms"
                        ? user.mobileNumber
                        : user.email
                  }
                  code={code}
                  setCode={setCode}
                />
                <Field>
                  <Button type="submit" disabled={submitting || code.length !== 6}>
                    Continue
                  </Button>
                </Field>
                <Field>
                  <button
                    type="button"
                    className="text-center text-sm underline underline-offset-4"
                    onClick={() => setShowVerificationMethods(true)}
                  >
                    View other verification methods
                  </button>
                </Field>
              </>
            )}
          </FieldGroup>
        </form>
      ) : (
        <form onSubmit={changePassword}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>Use 8+ characters with uppercase, lowercase, and a number.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-password">Re-enter password</FieldLabel>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </Field>
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={() => setStep("verify")}>
                Back
              </Button>
              <Button type="submit" disabled={submitting || !password || password !== confirmPassword}>
                Change password
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
    </SecurityFlowShell>
  )
}

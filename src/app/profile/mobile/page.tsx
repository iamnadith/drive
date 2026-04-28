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
import { Input } from "@/components/ui/input"

export default function MobileVerificationPage() {
  const router = useRouter()
  const { user, loading, setUserDirect } = useAuth()
  const [step, setStep] = React.useState<"number" | "code">("number")
  const [mobileNumber, setMobileNumber] = React.useState("")
  const [code, setCode] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  React.useEffect(() => {
    if (!user && !loading) router.replace("/login?redirect=/profile/mobile")
  }, [user, loading, router])

  React.useEffect(() => {
    setMobileNumber(user?.mobileNumber ?? "")
  }, [user])

  function normalizeMobileInput(value: string) {
    const digits = value.replace(/\D/g, "").replace(/^0/, "")
    return digits.startsWith("94") ? `+${digits}` : `+94${digits}`
  }

  function mobileIsValid(value: string) {
    return /^\+947\d{8}$/.test(normalizeMobileInput(value))
  }

  async function sendCode(event: React.FormEvent) {
    event.preventDefault()
    if (!mobileIsValid(mobileNumber)) {
      return toast.error("Enter a valid Sri Lankan mobile number")
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/mobile/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileNumber }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to send SMS code")
      setMobileNumber(String(data.mobileNumber || mobileNumber))
      setCode("")
      setStep("code")
      toast.success("SMS verification code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send SMS code")
    } finally {
      setSubmitting(false)
    }
  }

  async function confirmCode(event: React.FormEvent) {
    event.preventDefault()
    if (!mobileIsValid(mobileNumber)) {
      return toast.error("Enter a valid Sri Lankan mobile number")
    }
    if (code.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/mobile/setup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobileNumber, code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify SMS code")
      setUserDirect(data.user)
      toast.success("Mobile verification enabled")
      router.replace("/profile")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify SMS code")
    } finally {
      setSubmitting(false)
    }
  }

  if (!user) return null

  return (
    <SecurityFlowShell
      title="Mobile verification"
      description="Add a Sri Lankan mobile number for SMS verification codes."
    >
      {step === "number" ? (
        <form onSubmit={sendCode}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="mobile-number">Mobile number</FieldLabel>
              <div className="grid grid-cols-[72px_1fr] gap-2">
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">+94</div>
                <Input
                  id="mobile-number"
                  inputMode="tel"
                  placeholder="7XXXXXXXX"
                  value={mobileNumber.replace(/^\+?94/, "")}
                  onChange={(event) => setMobileNumber(normalizeMobileInput(event.target.value))}
                />
              </div>
              <FieldDescription>SMS messages are sent through Text.lk.</FieldDescription>
            </Field>
            <Field>
              <Button type="submit" disabled={submitting || !mobileIsValid(mobileNumber)}>
                Send SMS code
              </Button>
            </Field>
          </FieldGroup>
        </form>
      ) : (
        <form onSubmit={confirmCode}>
          <FieldGroup>
            <OtpInputField displayTarget={mobileNumber} code={code} setCode={setCode} />
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={() => setStep("number")}>
                Back
              </Button>
              <Button type="submit" disabled={submitting || code.length !== 6}>
                Verify mobile
              </Button>
            </Field>
          </FieldGroup>
        </form>
      )}
    </SecurityFlowShell>
  )
}

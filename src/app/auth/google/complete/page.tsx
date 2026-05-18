"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ClipboardPaste, GalleryVerticalEnd } from "lucide-react"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp"

type VerificationMethod = "authenticator" | "email" | "sms"
type GoogleStep = "loading" | "totp" | "verify" | "methods" | "error"

function normalizeMethod(value: unknown): VerificationMethod {
  return value === "authenticator" || value === "sms" ? value : "email"
}

function normalizeMethods(value: unknown): VerificationMethod[] {
  if (!Array.isArray(value)) return ["email"]
  const methods = value.map(normalizeMethod)
  return Array.from(new Set(methods))
}

export default function GoogleCompletePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { setUserDirect } = useAuth()
  const [step, setStep] = React.useState<GoogleStep>("loading")
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [methods, setMethods] = React.useState<VerificationMethod[]>([])
  const [email, setEmail] = React.useState("")
  const [totpCode, setTotpCode] = React.useState("")
  const [otpMethod, setOtpMethod] = React.useState<"email" | "sms">("email")
  const [otpCode, setOtpCode] = React.useState("")

  const redirectTo = searchParams.get("redirect") || "/"
  const busy = submitting

  const finishSignIn = React.useCallback(
    (user: AuthUser) => {
      setUserDirect(user)
      toast.success("Logged in")
      router.replace(redirectTo)
    },
    [redirectTo, router, setUserDirect]
  )

  const goBackToLogin = React.useCallback(() => {
    const url = new URL("/login", window.location.origin)
    if (redirectTo !== "/") url.searchParams.set("redirect", redirectTo)
    router.replace(url.toString())
  }, [redirectTo, router])

  const startOtpVerification = React.useCallback(
    async (nextMethod: "email" | "sms") => {
      setSubmitting(true)
      try {
        const res = await fetch("/api/auth/google/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "send", method: nextMethod }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Unable to send code")
        setOtpMethod(nextMethod)
        setOtpCode("")
        setStep("verify")
        toast.success("Verification code sent")
        return true
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unable to send code"
        setError(message)
        toast.error(message)
        return false
      } finally {
        setSubmitting(false)
      }
    },
    []
  )

  React.useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        if (searchParams.get("verify") === "1") {
          const res = await fetch("/api/auth/google/verify")
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? "Unable to load verification")
          if (cancelled) return

          const nextMethods = normalizeMethods(data.methods)
          const defaultMethod = normalizeMethod(data.defaultMethod)
          setMethods(nextMethods)
          setEmail(String(data.email || ""))

          if (defaultMethod === "authenticator" && nextMethods.includes("authenticator")) {
            setStep("totp")
          } else {
            const sent = await startOtpVerification(defaultMethod === "sms" ? "sms" : "email")
            if (!sent && !cancelled) setStep("error")
          }
          return
        }

        const res = await fetch("/api/auth/me")
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.error ?? "Unable to complete sign in")
        }

        if (data.user) {
          if (!cancelled) finishSignIn(data.user as AuthUser)
        } else if (!cancelled) {
          setError("You are not signed in.")
          setStep("error")
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to complete sign in")
          setStep("error")
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [finishSignIn, searchParams, startOtpVerification])

  async function verifyTotpCode(event: React.FormEvent) {
    event.preventDefault()
    if (totpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/google/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify",
          method: "authenticator",
          code: totpCode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify authenticator code")
      finishSignIn(data.user as AuthUser)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to verify authenticator code")
    } finally {
      setSubmitting(false)
    }
  }

  async function verifyOtpCode(event: React.FormEvent) {
    event.preventDefault()
    if (otpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/google/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "verify",
          method: otpMethod,
          code: otpCode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify login")
      finishSignIn(data.user as AuthUser)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to verify login")
    } finally {
      setSubmitting(false)
    }
  }

  const hasOtherMethods = methods.some((item) => item === "email" || item === "sms")
  const title =
    step === "loading"
      ? "Finishing Google sign-in"
      : step === "error"
        ? "Google sign-in failed"
        : "Verify your login"

  if (step === "loading") {
    return (
      <div className="auth-flow-bg page-under-header flex flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
        <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
          <div className="flex size-8 items-center justify-center rounded-2xl">
            <GalleryVerticalEnd className="size-6" />
          </div>
          <h1 className="text-xl font-bold">{title}</h1>
          <FieldDescription>Please wait while we prepare your account.</FieldDescription>
        </div>
      </div>
    )
  }

  return (
    <div className="auth-flow-bg page-under-header flex flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-8 items-center justify-center rounded-2xl">
              <GalleryVerticalEnd className="size-6" />
            </div>
            <h1 className="text-xl font-bold">{title}</h1>
            <FieldDescription>
              {step === "error" ? error : "Enter your verification code to continue."}
            </FieldDescription>
          </div>

          {step === "error" ? (
            <Button type="button" variant="outline" onClick={goBackToLogin}>
              Back to login
            </Button>
          ) : null}

          {step === "totp" ? (
            <form onSubmit={verifyTotpCode}>
              <FieldGroup>
                <OtpInputField
                  displayTarget="your authenticator app"
                  code={totpCode}
                  setCode={setTotpCode}
                />
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" variant="outline" onClick={goBackToLogin}>
                    Back
                  </Button>
                  <Button type="submit" loading={busy} disabled={totpCode.length !== 6}>
                    Verify 2FA
                  </Button>
                </Field>
                {hasOtherMethods ? (
                  <Field>
                    <button
                      type="button"
                      className="text-center text-sm underline underline-offset-4"
                      onClick={() => setStep("methods")}
                    >
                      View other verification methods
                    </button>
                  </Field>
                ) : null}
              </FieldGroup>
            </form>
          ) : null}

          {step === "methods" ? (
            <VerificationMethodList
              methods={methods}
              onAuthenticator={() => {
                setTotpCode("")
                setStep("totp")
              }}
              onEmail={() => void startOtpVerification("email")}
              onSms={() => void startOtpVerification("sms")}
              disabled={busy}
            />
          ) : null}

          {step === "verify" ? (
            <form onSubmit={verifyOtpCode}>
              <OtpFields
                code={otpCode}
                setCode={setOtpCode}
                displayTarget={otpMethod === "sms" ? "your mobile number" : email}
                submitting={busy}
                submitText="Verify login"
                onBack={() => {
                  if (methods.includes("authenticator")) {
                    setStep("totp")
                    return
                  }
                  goBackToLogin()
                }}
              />
            </form>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function VerificationMethodList({
  methods,
  onAuthenticator,
  onEmail,
  onSms,
  disabled,
}: {
  methods: VerificationMethod[]
  onAuthenticator: () => void
  onEmail: () => void
  onSms: () => void
  disabled: boolean
}) {
  return (
    <Field>
      <FieldLabel className="justify-center text-center">Verification methods</FieldLabel>
      <div className="flex flex-col gap-2">
        {methods.includes("authenticator") ? (
          <Button type="button" variant="outline" className="rounded-xl" onClick={onAuthenticator} disabled={disabled}>
            Authenticator app
          </Button>
        ) : null}
        {methods.includes("email") ? (
          <Button type="button" variant="outline" className="rounded-xl" onClick={onEmail} disabled={disabled}>
            Email verification code
          </Button>
        ) : null}
        {methods.includes("sms") ? (
          <Button type="button" variant="outline" className="rounded-xl" onClick={onSms} disabled={disabled}>
            SMS verification code
          </Button>
        ) : null}
      </div>
    </Field>
  )
}

function OtpFields({
  code,
  setCode,
  displayTarget,
  submitting,
  submitText,
  onBack,
}: {
  code: string
  setCode: (value: string) => void
  displayTarget?: string
  submitting: boolean
  submitText: string
  onBack: () => void
}) {
  return (
    <FieldGroup>
      <OtpInputField displayTarget={displayTarget} code={code} setCode={setCode} />
      <Field className="grid gap-3 sm:grid-cols-2">
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" loading={submitting} disabled={code.length !== 6}>
          {submitText}
        </Button>
      </Field>
    </FieldGroup>
  )
}

function OtpInputField({
  displayTarget,
  code,
  setCode,
}: {
  displayTarget?: string
  code: string
  setCode: (value: string) => void
}) {
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const pasteCaptureRef = React.useRef<HTMLInputElement | null>(null)
  const isAuthenticator = displayTarget === "your authenticator app"

  function submitAfterPaste(input: HTMLInputElement | null, nextCode: string) {
    if (nextCode.length !== 6) return
    window.setTimeout(() => input?.form?.requestSubmit(), 50)
  }

  function applyPastedCode(nextCode: string) {
    setCode(nextCode)
    const input = inputRef.current
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    setter?.call(input, nextCode)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
    submitAfterPaste(input, nextCode)
  }

  function handlePaste(event: React.ClipboardEvent<HTMLElement>) {
    const nextCode = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6)
    if (!nextCode) return
    event.preventDefault()
    applyPastedCode(nextCode)
  }

  function handlePasteCaptureChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextCode = event.target.value.replace(/\D/g, "").slice(0, 6)
    event.target.value = ""
    if (nextCode) applyPastedCode(nextCode)
  }

  async function pasteCode() {
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        const nextCode = text.replace(/\D/g, "").slice(0, 6)
        if (nextCode) applyPastedCode(nextCode)
        return
      } catch {
        // iOS can block Clipboard API reads; keep a real input focused for native paste/autofill.
      }
    }
    pasteCaptureRef.current?.focus()
    pasteCaptureRef.current?.select()
  }

  return (
    <Field className="items-center text-center">
      <FieldLabel htmlFor="otp-code" className="justify-center text-center">
        Verification code
      </FieldLabel>
      <FieldDescription className="text-center">
        {isAuthenticator
          ? "Enter the 6-digit code from your authenticator app."
          : `Enter the 6-digit code sent to ${displayTarget || "your account"}.`}
      </FieldDescription>
      <InputOTP
        ref={inputRef}
        maxLength={6}
        id="otp-code"
        required
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="one-time-code"
        value={code}
        onChange={(value) => setCode(value.replace(/\D/g, ""))}
        onPaste={handlePaste}
        containerClassName="mx-auto flex w-fit max-w-full items-center justify-center gap-[clamp(0.25rem,1.5vw,0.5rem)]"
      >
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-[clamp(2rem,11vw,2.75rem)] *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator className="mx-[clamp(0.25rem,1.5vw,0.5rem)]" />
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-[clamp(2rem,11vw,2.75rem)] *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      <div className="relative mx-auto h-8 w-fit">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 rounded-full px-3 text-xs"
          tabIndex={-1}
          aria-hidden="true"
        >
          <ClipboardPaste className="h-3.5 w-3.5" />
          Paste code
        </Button>
        <input
          ref={pasteCaptureRef}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          aria-label="Paste verification code"
          className="absolute inset-0 h-full w-full cursor-pointer rounded-full opacity-0"
          onClick={() => void pasteCode()}
          onPaste={handlePaste}
          onChange={handlePasteCaptureChange}
        />
      </div>
    </Field>
  )
}

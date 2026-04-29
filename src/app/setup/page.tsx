"use client"

import * as React from "react"
import Link from "next/link"
import { GalleryVerticalEnd } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { OtpInputField } from "@/components/profile-security-flow"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type SetupStep = "email" | "firstName" | "lastName" | "username" | "password" | "verify"
type Availability = "idle" | "checking" | "available" | "taken" | "invalid"

export default function SetupPage() {
  const router = useRouter()
  const { setUserDirect } = useAuth()
  const [step, setStep] = React.useState<SetupStep>("email")
  const [email, setEmail] = React.useState("")
  const [firstName, setFirstName] = React.useState("")
  const [lastName, setLastName] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [verificationEmail, setVerificationEmail] = React.useState("")
  const [otpCode, setOtpCode] = React.useState("")
  const [usernameStatus, setUsernameStatus] = React.useState<Availability>("idle")
  const [usernameMessage, setUsernameMessage] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  function isEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  }

  function usernameIsValid(value: string) {
    return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}$/.test(value)
  }

  function nameIsValid(value: string) {
    return value.trim().length >= 2 && value.trim().length <= 80
  }

  function passwordIsStrong(value: string) {
    return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)
  }

  React.useEffect(() => {
    if (step !== "username") return
    const nextUsername = username.trim()
    if (!nextUsername) {
      setUsernameStatus("idle")
      setUsernameMessage("")
      return
    }
    if (!usernameIsValid(nextUsername)) {
      setUsernameStatus("invalid")
      setUsernameMessage("Use 3-30 letters, numbers, dots, dashes, or underscores")
      return
    }

    setUsernameStatus("checking")
    setUsernameMessage("Checking username...")
    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/username-available?username=${encodeURIComponent(nextUsername)}`, {
          signal: controller.signal,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Unable to check username")
        setUsernameStatus(data.available ? "available" : "taken")
        setUsernameMessage(data.available ? "Username is available" : "Username is already taken")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setUsernameStatus("invalid")
        setUsernameMessage(error instanceof Error ? error.message : "Unable to check username")
      }
    }, 350)

    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [step, username])

  async function continueFromEmail(event: React.FormEvent) {
    event.preventDefault()
    const nextEmail = email.trim().toLowerCase()
    if (!isEmail(nextEmail)) return toast.error("Enter a valid email address")

    setSubmitting(true)
    try {
      const res = await fetch(`/api/users/email-available?email=${encodeURIComponent(nextEmail)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to check email")
      if (!data.available) return toast.error("Email already in use")
      setEmail(nextEmail)
      setStep("firstName")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to check email")
    } finally {
      setSubmitting(false)
    }
  }

  function continueFromName(event: React.FormEvent) {
    event.preventDefault()
    if (step === "firstName") {
      if (!nameIsValid(firstName)) return toast.error("Enter a valid first name")
      setStep("lastName")
      return
    }
    if (lastName.trim() && !nameIsValid(lastName)) return toast.error("Enter a valid last name")
    setStep("username")
  }

  async function continueFromUsername(event: React.FormEvent) {
    event.preventDefault()
    const nextUsername = username.trim()
    if (!usernameIsValid(nextUsername)) {
      return toast.error("Use 3-30 letters, numbers, dots, dashes, or underscores")
    }
    if (usernameStatus === "checking") return toast.error("Wait for username check to finish")
    if (usernameStatus === "taken") return toast.error("Username is already taken")
    if (usernameStatus === "invalid") return toast.error(usernameMessage || "Choose another username")

    setSubmitting(true)
    try {
      const res = await fetch(`/api/users/username-available?username=${encodeURIComponent(nextUsername)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to check username")
      if (!data.available) return toast.error("Username is already taken")
      setUsername(nextUsername)
      setStep("password")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to check username")
    } finally {
      setSubmitting(false)
    }
  }

  async function createSuperAdmin(event: React.FormEvent) {
    event.preventDefault()
    if (!passwordIsStrong(password)) {
      return toast.error("Use 8+ characters with uppercase, lowercase, and a number")
    }
    if (password !== confirmPassword) return toast.error("Passwords do not match")

    setSubmitting(true)
    try {
      const res = await fetch("/api/setup/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${firstName.trim()} ${lastName.trim()}`.trim(),
          username: username.trim(),
          email: email.trim(),
          password,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to create Super Admin")
      setVerificationEmail(String(data.email || email.trim()))
      setOtpCode("")
      setStep("verify")
      toast.success("Verification code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create Super Admin")
    } finally {
      setSubmitting(false)
    }
  }

  async function verifySetupCode(event: React.FormEvent) {
    event.preventDefault()
    if (otpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verificationEmail, code: otpCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify email")
      setUserDirect(data.user as AuthUser)
      toast.success("Email verified")
      router.replace("/")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify email")
    } finally {
      setSubmitting(false)
    }
  }

  async function resendSetupCode() {
    if (!verificationEmail) return toast.error("Create the Super Admin account first")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: verificationEmail, purpose: "signup" }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to resend verification code")
      setOtpCode("")
      toast.success("Verification code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to resend verification code")
    } finally {
      setSubmitting(false)
    }
  }

  function handleGoogleSetup() {
    const url = new URL("/api/auth/google/login", window.location.origin)
    url.searchParams.set("mode", "setup")
    url.searchParams.set("redirect", "/")
    window.location.href = url.toString()
  }

  const title =
    step === "email"
      ? "Initialize Drive"
      : step === "verify"
        ? "Verify Super Admin"
        : "Create Super Admin"
  const description =
    step === "email"
      ? "Start with the email for the first Super Admin account."
      : step === "verify"
        ? `Enter the verification code sent to ${verificationEmail}.`
        : "Set up the first account that controls this workspace."

  return (
    <main className="auth-flow-bg flex min-h-svh flex-col items-center justify-center p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <Link href="/setup" className="flex flex-col items-center gap-2 font-medium">
              <div className="flex size-8 items-center justify-center rounded-2xl">
                <GalleryVerticalEnd className="size-6" />
              </div>
              <span className="sr-only">Drive</span>
            </Link>
            <h1 className="text-balance text-xl font-bold">{title}</h1>
            <FieldDescription className="text-pretty">{description}</FieldDescription>
          </div>

          {step === "email" ? (
            <form onSubmit={continueFromEmail}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setup-email">Email</FieldLabel>
                  <Input
                    id="setup-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <Field>
                  <Button type="submit" loading={submitting}>
                    Continue
                  </Button>
                </Field>
                <FieldSeparator>Or</FieldSeparator>
                <Field>
                  <Button type="button" variant="outline" onClick={handleGoogleSetup}>
                    Google
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          ) : null}

          {(step === "firstName" || step === "lastName") ? (
            <form onSubmit={continueFromName}>
              <FieldGroup>
                {step === "firstName" ? (
                  <Field>
                    <FieldLabel htmlFor="setup-first-name">First name</FieldLabel>
                    <Input
                      id="setup-first-name"
                      autoComplete="given-name"
                      required
                      value={firstName}
                      onChange={(event) => setFirstName(event.target.value)}
                    />
                  </Field>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="setup-last-name">Last name</FieldLabel>
                    <Input
                      id="setup-last-name"
                      autoComplete="family-name"
                      value={lastName}
                      onChange={(event) => setLastName(event.target.value)}
                    />
                  </Field>
                )}
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setStep(step === "firstName" ? "email" : "firstName")}
                  >
                    Back
                  </Button>
                  <Button type="submit">Continue</Button>
                </Field>
              </FieldGroup>
            </form>
          ) : null}

          {step === "username" ? (
            <form onSubmit={continueFromUsername}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setup-username">Username</FieldLabel>
                  <Input
                    id="setup-username"
                    autoComplete="username"
                    required
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                  {usernameMessage ? (
                    <FieldDescription
                      className={cn(
                        usernameStatus === "available" && "text-emerald-600",
                        (usernameStatus === "taken" || usernameStatus === "invalid") && "text-destructive"
                      )}
                    >
                      {usernameMessage}
                    </FieldDescription>
                  ) : null}
                </Field>
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" variant="outline" onClick={() => setStep("lastName")}>
                    Back
                  </Button>
                  <Button type="submit" loading={submitting} disabled={usernameStatus === "checking"}>
                    Continue
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          ) : null}

          {step === "password" ? (
            <form onSubmit={createSuperAdmin}>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="setup-password">Password</FieldLabel>
                  <Input
                    id="setup-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                  <FieldDescription>Use 8+ characters with uppercase, lowercase, and a number.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="setup-confirm-password">Confirm password</FieldLabel>
                  <Input
                    id="setup-confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                  {confirmPassword && password !== confirmPassword ? (
                    <FieldDescription className="text-destructive">Passwords do not match.</FieldDescription>
                  ) : null}
                </Field>
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" variant="outline" onClick={() => setStep("username")}>
                    Back
                  </Button>
                  <Button
                    type="submit"
                    loading={submitting}
                    disabled={!password || password !== confirmPassword}
                  >
                    Create account
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          ) : null}

          {step === "verify" ? (
            <form onSubmit={verifySetupCode}>
              <FieldGroup>
                <OtpInputField displayTarget={verificationEmail} code={otpCode} setCode={setOtpCode} />
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" variant="outline" onClick={() => void resendSetupCode()} loading={submitting}>
                    Resend
                  </Button>
                  <Button
                    type="submit"
                    loading={submitting}
                    disabled={otpCode.length !== 6}
                  >
                    Verify
                  </Button>
                </Field>
              </FieldGroup>
            </form>
          ) : null}

          <FieldDescription className="px-6 text-center">
            This creates the first Super Admin for this Drive workspace.
          </FieldDescription>
        </div>
      </div>
    </main>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { CheckCircle2, CircleDashed, Database, GalleryVerticalEnd, Mail, RefreshCw, ServerCog, ShieldCheck, TriangleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { OtpInputField } from "@/components/profile-security-flow"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { CloudflareWorkerHosting } from "@/components/dashboard/cloudflare-worker-hosting"
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
type SetupStatus = {
  hasSuperAdmin: boolean
  workersReady: boolean
  setupStep: "requirements" | "workers" | "account" | "complete"
  readiness: { ready: boolean; capabilities: { google: boolean; sms: boolean }; requirements: Array<{ id: string; label: string; description: string; configured: boolean; variables: string[]; error?: string }> }
}

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
  const [systemStatus, setSystemStatus] = React.useState<SetupStatus | null>(null)
  const [statusError, setStatusError] = React.useState("")
  const [workersCompleted, setWorkersCompleted] = React.useState(false)

  const loadSystemStatus = React.useCallback(async () => {
    try {
      const response = await fetch("/api/setup/status", { cache: "no-store" })
      const value = await response.json()
      if (!response.ok) throw new Error(value.error || "Unable to inspect setup status")
      setSystemStatus(value as SetupStatus); setStatusError("")
    } catch (error) { setStatusError(error instanceof Error ? error.message : "Unable to inspect setup status") }
  }, [])
  React.useEffect(() => { void loadSystemStatus() }, [loadSystemStatus])

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

  if (!systemStatus) return <main className="auth-flow-bg page-under-header flex items-center justify-center p-4"><Card className="w-full max-w-lg"><CardHeader><CardTitle>Inspecting this installation</CardTitle><CardDescription>Checking environment, database, and Worker readiness.</CardDescription></CardHeader><CardContent><Progress value={34} /></CardContent>{statusError ? <CardFooter><p className="text-sm text-destructive">{statusError}</p></CardFooter> : null}</Card></main>

  const stage = systemStatus.setupStep
  const stageIndex = stage === "requirements" ? 1 : stage === "workers" ? 2 : 3
  if (stage === "requirements" || stage === "workers" || stage === "complete") {
    const configuredCount = systemStatus.readiness.requirements.filter((item) => item.configured).length
    return <main className="auth-flow-bg page-under-header min-h-screen p-4 sm:p-6 lg:p-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 rounded-3xl border bg-card/80 p-5 shadow-sm backdrop-blur sm:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex items-start gap-3"><div className="flex size-11 items-center justify-center rounded-2xl border bg-background"><ShieldCheck /></div><div><Badge variant="outline">Drive control plane</Badge><h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Workspace setup</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">A verified path from infrastructure to Workers to the first administrator.</p></div></div>
            <Button variant="outline" onClick={() => void loadSystemStatus()}><RefreshCw data-icon="inline-start" />Recheck</Button>
          </div>
          <Progress value={(stageIndex / 3) * 100} />
          <div className="grid gap-3 sm:grid-cols-3">{[["1", "Environment"], ["2", "Workers"], ["3", "Account"]].map(([number, label], index) => <div key={number} className="flex items-center gap-3 rounded-xl border bg-background/60 p-3"><Badge variant={stageIndex >= index + 1 ? "default" : "secondary"}>{number}</Badge><span className="text-sm font-medium">{label}</span></div>)}</div>
        </header>

        {stage === "requirements" ? <Card><CardHeader><CardTitle className="flex items-center gap-2"><Database />Required environment</CardTitle><CardDescription>{configuredCount} of {systemStatus.readiness.requirements.length} requirements are ready. Add missing variables in Vercel, redeploy, then recheck.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{systemStatus.readiness.requirements.map((item) => <Card key={item.id}><CardHeader className="pb-3"><div className="flex items-start justify-between gap-3"><CardTitle className="text-base">{item.label}</CardTitle>{item.configured ? <CheckCircle2 className="text-primary" /> : <TriangleAlert className="text-destructive" />}</div><CardDescription>{item.description}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2"><Badge variant={item.configured ? "default" : "destructive"}>{item.configured ? "Configured" : "Required"}</Badge>{item.variables.map((variable) => <code key={variable} className="rounded-md bg-muted px-2 py-1 text-xs">{variable}</code>)}{item.error ? <p className="text-xs text-destructive">{item.error}</p> : null}</CardContent></Card>)}</CardContent><CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>Optional:</span><Badge variant="outline">Google {systemStatus.readiness.capabilities.google ? "available" : "not configured"}</Badge><Badge variant="outline">SMS {systemStatus.readiness.capabilities.sms ? "available" : "not configured"}</Badge></div><Button onClick={() => void loadSystemStatus()} disabled={!systemStatus.readiness.ready}>Continue to Workers</Button></CardFooter></Card> : null}

        {stage === "workers" ? <><Card><CardHeader><CardTitle className="flex items-center gap-2"><ServerCog />Worker foundation</CardTitle><CardDescription>Existing Workers are verified and reused. Missing or unhealthy Workers are repaired without duplicating healthy scripts.</CardDescription></CardHeader><CardContent><div className="grid gap-3 sm:grid-cols-3"><p className="flex items-center gap-2 text-sm"><CheckCircle2 className="text-primary" />Backend first</p><p className="flex items-center gap-2 text-sm"><CircleDashed />File Scanner second</p><p className="flex items-center gap-2 text-sm"><CircleDashed />Migration third</p></div></CardContent></Card><CloudflareWorkerHosting onboarding onReady={() => setWorkersCompleted(true)} />{workersCompleted ? <Card><CardHeader><CardTitle>Worker foundation is ready</CardTitle><CardDescription>All three deployments exist and passed authenticated verification.</CardDescription></CardHeader><CardFooter className="justify-end"><Button onClick={() => void loadSystemStatus()}>Continue to account</Button></CardFooter></Card> : null}</> : null}

        {stage === "complete" ? <Card><CardHeader><CardTitle>Setup is healthy</CardTitle><CardDescription>Required services and all three Workers passed reconciliation.</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-2"><p className="flex items-center gap-2 text-sm"><Mail />Email gateway ready</p><p className="flex items-center gap-2 text-sm"><ServerCog />Workers verified</p></CardContent><CardFooter><Button asChild><Link href="/">Return to Drive</Link></Button></CardFooter></Card> : null}
      </div>
    </main>
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
    <main className="auth-flow-bg page-under-header flex flex-col items-center justify-center p-4 sm:p-6 md:p-10">
      <div className="auth-flow-panel w-full max-w-sm rounded-3xl p-5 backdrop-blur sm:p-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <Link href="/setup" className="flex flex-col items-center gap-2 font-medium">
              <div className="flex size-8 items-center justify-center rounded-2xl">
                <GalleryVerticalEnd className="size-6" />
              </div>
              <span className="sr-only">Drive</span>
            </Link>
            <Badge variant="outline">Step 3 of 3 · Account</Badge>
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
                {systemStatus.readiness.capabilities.google ? <><FieldSeparator>Or</FieldSeparator><Field>
                  <Button type="button" variant="outline" onClick={handleGoogleSetup}>
                    Google
                  </Button>
                </Field></> : null}
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

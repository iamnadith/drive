"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRight, Check, CheckCircle2, Cloud, Database, GalleryVerticalEnd, KeyRound, LockKeyhole, Mail, RefreshCw, ServerCog, ShieldCheck, Smartphone, TriangleAlert } from "lucide-react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { OtpInputField } from "@/components/profile-security-flow"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
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

  if (!systemStatus) return <main className="auth-flow-bg flex min-h-svh items-center justify-center p-4"><Card className="w-full max-w-lg"><CardHeader><CardTitle>Inspecting this installation</CardTitle><CardDescription>Checking environment, database, and Worker readiness.</CardDescription></CardHeader><CardContent className="flex flex-col gap-4"><Progress value={34} />{statusError ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Readiness check failed</AlertTitle><AlertDescription>{statusError}</AlertDescription></Alert> : null}</CardContent></Card></main>

  const stage = systemStatus.setupStep
  const stageIndex = stage === "requirements" ? 1 : stage === "workers" ? 2 : 3
  if (stage === "requirements" || stage === "workers" || stage === "complete") {
    const configuredCount = systemStatus.readiness.requirements.filter((item) => item.configured).length
    return <main className="auth-flow-bg min-h-svh px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex max-w-3xl flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground"><ShieldCheck />Drive control plane</div>
            <h1 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">Prepare your workspace</h1>
            <p className="text-pretty text-base text-muted-foreground sm:text-lg">Connect the services Drive needs, deploy its Worker layer, then create the first administrator.</p>
          </div>
          <Button variant="outline" onClick={() => void loadSystemStatus()}><RefreshCw data-icon="inline-start" />Refresh status</Button>
        </header>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm"><span className="font-medium">Step {stageIndex} of 3</span><span className="text-muted-foreground">{stageIndex === 1 ? "Environment" : stageIndex === 2 ? "Cloudflare Workers" : "Complete"}</span></div>
          <Progress value={(stageIndex / 3) * 100} />
          <div className="grid grid-cols-3 gap-2">{[["1", "Environment"], ["2", "Workers"], ["3", "Account"]].map(([number, label], index) => <div key={number} className={cn("flex items-center gap-2 rounded-2xl px-3 py-2 text-sm", stageIndex === index + 1 ? "bg-foreground text-background" : "text-muted-foreground")}><span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs">{stageIndex > index + 1 ? <Check /> : number}</span><span className="hidden font-medium sm:inline">{label}</span></div>)}</div>
        </div>

        {stage === "requirements" ? <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Card className="overflow-hidden py-0">
            <CardHeader className="border-b px-5 py-5 sm:px-7 sm:py-6"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="flex gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary"><Database /></div><div><CardTitle>Required services</CardTitle><CardDescription className="mt-1">Every item below must be ready before Worker deployment.</CardDescription></div></div><Badge variant={systemStatus.readiness.ready ? "default" : "secondary"}>{configuredCount} / {systemStatus.readiness.requirements.length} ready</Badge></div></CardHeader>
            <CardContent className="p-0"><ItemGroup>{systemStatus.readiness.requirements.map((item, index) => <React.Fragment key={item.id}>{index > 0 ? <Separator /> : null}<Item className="rounded-none border-0 px-5 py-4 sm:px-7"><ItemMedia variant="icon">{item.configured ? <CheckCircle2 /> : <TriangleAlert />}</ItemMedia><ItemContent><ItemTitle>{item.label}</ItemTitle><p className="text-sm text-muted-foreground">{item.description}</p><div className="mt-1 flex flex-wrap gap-1.5">{item.variables.map((variable) => <Badge key={variable} variant="outline" className="font-mono font-normal">{variable}</Badge>)}</div>{item.error ? <p className="mt-1 text-sm text-destructive">{item.error}</p> : null}</ItemContent><ItemActions><Badge variant={item.configured ? "default" : "destructive"}>{item.configured ? "Ready" : "Missing"}</Badge></ItemActions></Item></React.Fragment>)}</ItemGroup></CardContent>
            <CardFooter className="flex flex-col items-stretch gap-3 border-t px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-7"><p className="text-sm text-muted-foreground">Update Vercel variables, redeploy, then refresh this check.</p><Button onClick={() => void loadSystemStatus()} disabled={!systemStatus.readiness.ready}>Continue to Workers<ArrowRight data-icon="inline-end" /></Button></CardFooter>
          </Card>

          <div className="flex flex-col gap-6">
            <Card className="py-0"><CardHeader className="px-5 pt-5"><CardTitle className="text-base">Optional integrations</CardTitle><CardDescription>Detected automatically. They never block setup.</CardDescription></CardHeader><CardContent className="px-3 pb-3"><ItemGroup><Item><ItemMedia variant="icon"><KeyRound /></ItemMedia><ItemContent><ItemTitle>Google sign-in</ItemTitle><p className="text-xs text-muted-foreground">GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET</p></ItemContent><ItemActions><Badge variant={systemStatus.readiness.capabilities.google ? "default" : "outline"}>{systemStatus.readiness.capabilities.google ? "Configured" : "Optional"}</Badge></ItemActions></Item><Separator /><Item><ItemMedia variant="icon"><Smartphone /></ItemMedia><ItemContent><ItemTitle>SMS gateway</ItemTitle><p className="text-xs text-muted-foreground">TEXTLK_API_TOKEN</p></ItemContent><ItemActions><Badge variant={systemStatus.readiness.capabilities.sms ? "default" : "outline"}>{systemStatus.readiness.capabilities.sms ? "Configured" : "Optional"}</Badge></ItemActions></Item></ItemGroup></CardContent></Card>
            <Alert><LockKeyhole /><AlertTitle>Secrets stay server-side</AlertTitle><AlertDescription>Values are checked for availability and connectivity. Their contents are never returned to this page.</AlertDescription></Alert>
          </div>
        </div> : null}

        {stage === "workers" ? <div className="flex flex-col gap-6"><Card className="py-0"><CardHeader className="border-b px-5 py-5 sm:px-7 sm:py-6"><div className="flex gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary"><Cloud /></div><div><CardTitle>Cloudflare Worker layer</CardTitle><CardDescription className="mt-1">Healthy deployments are reused. Only missing or unhealthy infrastructure is repaired.</CardDescription></div></div></CardHeader><CardContent className="grid gap-0 p-0 sm:grid-cols-3">{[["01", "Backend Orchestrator", "Coordinates scheduled work"], ["02", "File Scanner", "Discovers and verifies files"], ["03", "Migration Orchestrator", "Dispatches migration jobs"]].map(([number, label, copy], index) => <div key={number} className={cn("flex gap-3 px-5 py-4 sm:px-6", index > 0 && "border-t sm:border-t-0 sm:border-l")}><Badge variant="outline" className="h-fit">{number}</Badge><div><p className="text-sm font-medium">{label}</p><p className="mt-1 text-xs text-muted-foreground">{copy}</p></div></div>)}</CardContent></Card><CloudflareWorkerHosting onboarding onReady={() => setWorkersCompleted(true)} />{workersCompleted ? <Alert><CheckCircle2 /><AlertTitle>Worker foundation is ready</AlertTitle><AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span>All three deployments passed authenticated verification.</span><Button onClick={() => void loadSystemStatus()}>Continue to account<ArrowRight data-icon="inline-end" /></Button></AlertDescription></Alert> : null}</div> : null}

        {stage === "complete" ? <Card className="mx-auto w-full max-w-2xl text-center"><CardHeader className="items-center"><div className="flex size-12 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Check /></div><CardTitle className="mt-2 text-2xl">Workspace ready</CardTitle><CardDescription>Required services and all three Workers passed reconciliation.</CardDescription></CardHeader><CardContent className="flex flex-wrap justify-center gap-2"><Badge variant="outline"><Mail />Email ready</Badge><Badge variant="outline"><ServerCog />Workers verified</Badge></CardContent><CardFooter className="justify-center"><Button asChild><Link href="/">Open Drive<ArrowRight data-icon="inline-end" /></Link></Button></CardFooter></Card> : null}
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
    <main className="auth-flow-bg flex min-h-svh items-center px-4 py-6 sm:px-6 sm:py-10 lg:px-10">
      <div className="mx-auto grid w-full max-w-5xl items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <Card className="justify-between overflow-hidden py-0">
          <CardHeader className="px-6 pt-7 sm:px-8 sm:pt-9">
            <div className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><GalleryVerticalEnd /></div>
            <Badge variant="outline" className="mt-6 w-fit">Final step</Badge>
            <CardTitle className="mt-2 text-3xl">Your infrastructure is ready.</CardTitle>
            <CardDescription className="mt-2 max-w-md text-base">Create the first Super Admin to start managing Drive. This account owns workspace access and configuration.</CardDescription>
          </CardHeader>
          <CardContent className="px-3 pb-3 sm:px-5 sm:pb-5">
            <ItemGroup>
              <Item><ItemMedia variant="icon"><Database /></ItemMedia><ItemContent><ItemTitle>Environment connected</ItemTitle><p className="text-xs text-muted-foreground">Database, SSL, email, and application origin verified</p></ItemContent><ItemActions><CheckCircle2 /></ItemActions></Item>
              <Separator />
              <Item><ItemMedia variant="icon"><ServerCog /></ItemMedia><ItemContent><ItemTitle>Workers online</ItemTitle><p className="text-xs text-muted-foreground">Backend, scanner, and migration services verified</p></ItemContent><ItemActions><CheckCircle2 /></ItemActions></Item>
              <Separator />
              <Item><ItemMedia variant="icon"><KeyRound /></ItemMedia><ItemContent><ItemTitle>Google sign-in</ItemTitle><p className="text-xs text-muted-foreground">Optional identity provider</p></ItemContent><ItemActions><Badge variant={systemStatus.readiness.capabilities.google ? "default" : "outline"}>{systemStatus.readiness.capabilities.google ? "Configured" : "Not enabled"}</Badge></ItemActions></Item>
              <Separator />
              <Item><ItemMedia variant="icon"><Smartphone /></ItemMedia><ItemContent><ItemTitle>SMS verification</ItemTitle><p className="text-xs text-muted-foreground">Optional mobile gateway</p></ItemContent><ItemActions><Badge variant={systemStatus.readiness.capabilities.sms ? "default" : "outline"}>{systemStatus.readiness.capabilities.sms ? "Configured" : "Not enabled"}</Badge></ItemActions></Item>
            </ItemGroup>
          </CardContent>
        </Card>

        <Card className="py-0">
          <div className="flex flex-col gap-6 p-5 sm:p-7">
          <div className="flex flex-col items-center gap-2 text-center">
            <Badge variant="secondary">Step 3 of 3 · Account</Badge>
            <h1 className="text-balance text-2xl font-semibold">{title}</h1>
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

          <FieldDescription className="text-center">
            This creates the first Super Admin for this Drive workspace.
          </FieldDescription>
          </div>
        </Card>
      </div>
    </main>
  )
}

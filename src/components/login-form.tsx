"use client"

import * as React from "react"
import Link from "next/link"
import { ClipboardPaste, GalleryVerticalEnd } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { cn } from "@/lib/utils"

type Mode = "login" | "signup" | "reset"
type LoginStep = "email" | "password" | "totp" | "verify"
type SignupStep = "email" | "verify" | "firstName" | "lastName" | "username" | "password"
type ResetStep = "email" | "code" | "password"
type VerificationMethod = "authenticator" | "email" | "sms"

export function LoginForm({
  className,
  initialMode = "login",
  ...props
}: React.ComponentProps<"div"> & { initialMode?: Mode }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { login, user, loading, setUserDirect } = useAuth()

  const [mode, setMode] = React.useState<Mode>(initialMode)
  const [loginStep, setLoginStep] = React.useState<LoginStep>("email")
  const [loginEmail, setLoginEmail] = React.useState("")
  const [loginPassword, setLoginPassword] = React.useState("")
  const [totpCode, setTotpCode] = React.useState("")
  const [showVerificationMethods, setShowVerificationMethods] = React.useState(false)
  const [loginMethods, setLoginMethods] = React.useState<string[]>(["email"])
  const [otpMethod, setOtpMethod] = React.useState<"email" | "sms">("email")
  const [otpEmail, setOtpEmail] = React.useState("")
  const [otpCode, setOtpCode] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)

  const [signupStep, setSignupStep] = React.useState<SignupStep>("email")
  const [signupEmail, setSignupEmail] = React.useState("")
  const [verifiedSignupUser, setVerifiedSignupUser] = React.useState<AuthUser | null>(null)
  const [firstName, setFirstName] = React.useState("")
  const [lastName, setLastName] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [usernameStatus, setUsernameStatus] = React.useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle")
  const [usernameMessage, setUsernameMessage] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")

  const [resetStep, setResetStep] = React.useState<ResetStep>("email")
  const [resetIdentifier, setResetIdentifier] = React.useState("")
  const [resetLookupEmail, setResetLookupEmail] = React.useState("")
  const [resetMethods, setResetMethods] = React.useState<string[]>(["email"])
  const [resetMethod, setResetMethod] = React.useState<VerificationMethod>("email")
  const [showResetMethods, setShowResetMethods] = React.useState(false)
  const [resetCode, setResetCode] = React.useState("")
  const [resetPassword, setResetPassword] = React.useState("")
  const [resetConfirmPassword, setResetConfirmPassword] = React.useState("")

  React.useEffect(() => {
    if (user && !loading) router.replace(searchParams.get("redirect") || "/")
  }, [user, loading, router, searchParams])

  function isEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  }

  function passwordIsStrong(value: string) {
    return value.length >= 8 && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)
  }

  function usernameIsValid(value: string) {
    return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,29}$/.test(value)
  }

  function nameIsValid(value: string) {
    return value.trim().length >= 2 && value.trim().length <= 80
  }

  React.useEffect(() => {
    if (mode !== "signup" || signupStep !== "username") return

    const nextUsername = username.trim()
    if (!nextUsername) {
      setUsernameStatus("idle")
      setUsernameMessage("")
      return
    }
    if (nextUsername.includes("@")) {
      setUsernameStatus("invalid")
      setUsernameMessage("Username cannot be an email address")
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
        if (data.available) {
          setUsernameStatus("available")
          setUsernameMessage("Username is available")
        } else {
          setUsernameStatus("taken")
          setUsernameMessage("Username is already taken")
        }
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
  }, [mode, signupStep, username])

  function switchMode(nextMode: Mode) {
    setMode(nextMode)
    setLoginStep("email")
    setSignupStep("email")
    setResetStep("email")
    setOtpEmail("")
    setOtpCode("")
    setResetCode("")
    setShowResetMethods(false)
    setVerifiedSignupUser(null)
  }

  function handleGoogleLogin(nextMode: "login" | "signup") {
    const redirectTo = searchParams.get("redirect") || "/"
    const url = new URL("/api/auth/google/login", window.location.origin)
    url.searchParams.set("mode", nextMode)
    url.searchParams.set("redirect", redirectTo)
    window.location.href = url.toString()
  }

  async function submitLoginEmail(event: React.FormEvent) {
    event.preventDefault()
    const identifier = loginEmail.trim()
    if (!identifier) return toast.error("Enter your email or username")
    if (identifier.includes("@") && !isEmail(identifier)) {
      return toast.error("Enter a valid email address")
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/auth/identifier?identifier=${encodeURIComponent(identifier)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to check account")
      if (!data.exists) {
        toast.error(identifier.includes("@") ? "No account found with that email" : "No account found with that username")
        return
      }
      setLoginStep("password")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to check account")
    } finally {
      setSubmitting(false)
    }
  }

  async function submitLoginPassword(event: React.FormEvent) {
    event.preventDefault()
    if (!loginPassword) return toast.error("Enter your password")
    setSubmitting(true)
    try {
      const result = await login(loginEmail.trim(), loginPassword)
      if (result.requiresTotp) {
        setLoginMethods(result.methods ?? ["authenticator", "email"])
        setTotpCode("")
        setShowVerificationMethods(false)
        setLoginStep("totp")
        return
      }
      if (result.requiresOtp) {
        setLoginMethods(result.methods ?? ["email"])
        setOtpMethod(result.method === "sms" ? "sms" : "email")
        setOtpEmail(result.email || loginEmail.trim())
        setOtpCode("")
        setLoginStep("verify")
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function verifyTotpCode(event: React.FormEvent) {
    event.preventDefault()
    if (totpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/verify-totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: loginEmail.trim(),
          password: loginPassword,
          code: totpCode,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify authenticator code")
      setUserDirect(data.user as AuthUser)
      toast.success("Logged in")
      router.replace(searchParams.get("redirect") || "/")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify authenticator code")
    } finally {
      setSubmitting(false)
    }
  }

  async function startLoginVerification(method: "email" | "sms") {
    setSubmitting(true)
    try {
      const result = await login(loginEmail.trim(), loginPassword, method)
      if (result.requiresOtp) {
        setOtpMethod(method)
        setOtpEmail(result.email || "")
        setOtpCode("")
        setLoginStep("verify")
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function verifyLoginCode(event: React.FormEvent) {
    event.preventDefault()
    if (otpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/verify-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: otpEmail, code: otpCode, method: otpMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify login")
      setUserDirect(data.user as AuthUser)
      toast.success("Logged in")
      router.replace(searchParams.get("redirect") || "/")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify login")
    } finally {
      setSubmitting(false)
    }
  }

  async function startSignup(event: React.FormEvent) {
    event.preventDefault()
    if (!isEmail(signupEmail.trim())) return toast.error("Enter a valid email")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/signup/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signupEmail.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to send verification code")
      setOtpEmail(String(data.email || signupEmail.trim()))
      setOtpCode("")
      setSignupStep("verify")
      toast.success("Verification code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send verification code")
    } finally {
      setSubmitting(false)
    }
  }

  async function verifySignupCode(event: React.FormEvent) {
    event.preventDefault()
    if (otpCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: otpEmail, code: otpCode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify email")
      setVerifiedSignupUser(data.user as AuthUser)
      setFirstName("")
      setSignupStep("firstName")
      toast.success("Email verified")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify email")
    } finally {
      setSubmitting(false)
    }
  }

  async function submitSignupDetail(event: React.FormEvent) {
    event.preventDefault()
    if (signupStep === "firstName") {
      if (!nameIsValid(firstName)) return toast.error("Enter a valid first name")
      setSignupStep("lastName")
      return
    }
    if (signupStep === "lastName") {
      if (lastName.trim() && !nameIsValid(lastName)) return toast.error("Enter a valid last name")
      setSignupStep("username")
      return
    }
    if (signupStep === "username") {
      if (!username.trim()) return toast.error("Choose a username")
      if (username.includes("@")) return toast.error("Username cannot be an email address")
      if (!usernameIsValid(username.trim())) {
        return toast.error("Use 3-30 letters, numbers, dots, dashes, or underscores")
      }
      if (usernameStatus === "checking") return toast.error("Wait for username check to finish")
      if (usernameStatus === "taken") return toast.error("Username already in use")
      if (usernameStatus === "invalid") return toast.error(usernameMessage || "Choose another username")
      setSubmitting(true)
      try {
        const res = await fetch(`/api/users/username-available?username=${encodeURIComponent(username.trim())}`)
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Unable to check username")
        if (!data.available) return toast.error("Username already in use")
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to check username")
        return
      } finally {
        setSubmitting(false)
      }
      setSignupStep("password")
      return
    }
  }

  async function finishSignup(event: React.FormEvent) {
    event.preventDefault()
    if (!verifiedSignupUser) return toast.error("Verify your email first")
    if (!passwordIsStrong(password)) {
      return toast.error("Use 8+ characters with uppercase, lowercase, and a number")
    }
    if (password !== confirmPassword) return toast.error("Passwords do not match")

    setSubmitting(true)
    try {
      const fullName = `${firstName.trim()} ${lastName.trim()}`.trim()
      const res = await fetch(`/api/users/${verifiedSignupUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fullName,
          username: username.trim(),
          password,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to create account")
      setUserDirect(data.user as AuthUser)
      toast.success("Account created")
      router.replace("/")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create account")
    } finally {
      setSubmitting(false)
    }
  }

  async function sendResetCode(event: React.FormEvent) {
    event.preventDefault()
    if (!resetIdentifier.trim()) return toast.error("Enter your email or username")
    await startResetVerification()
  }

  async function startResetVerification(nextMethod?: VerificationMethod) {
    const identifier = resetIdentifier.trim()
    if (!identifier) return toast.error("Enter your email or username")
    if (identifier.includes("@") && !isEmail(identifier)) return toast.error("Enter a valid email address")
    if (!identifier.includes("@") && !usernameIsValid(identifier)) {
      return toast.error("Enter a valid username")
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, method: nextMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to send reset code")
      const selectedMethod =
        data.method === "sms" ? "sms" : data.method === "authenticator" ? "authenticator" : "email"
      setResetLookupEmail(String(data.email || ""))
      setResetMethods(Array.isArray(data.methods) ? data.methods.map(String) : [selectedMethod])
      setResetMethod(selectedMethod)
      setResetCode("")
      setShowResetMethods(false)
      setResetStep("code")
      if (data.sent) toast.success("Reset code sent")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to send reset code")
    } finally {
      setSubmitting(false)
    }
  }

  async function submitResetCode(event: React.FormEvent) {
    event.preventDefault()
    if (resetCode.length !== 6) return toast.error("Enter the 6-digit code")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-reset/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetLookupEmail, code: resetCode, method: resetMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify reset code")
      setResetStep("password")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to verify reset code")
    } finally {
      setSubmitting(false)
    }
  }

  async function resetPasswordSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (resetCode.length !== 6) return toast.error("Verify the 6-digit code first")
    if (!passwordIsStrong(resetPassword)) {
      return toast.error("Use 8+ characters with uppercase, lowercase, and a number")
    }
    if (resetPassword !== resetConfirmPassword) return toast.error("Passwords do not match")
    setSubmitting(true)
    try {
      const res = await fetch("/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: resetLookupEmail, code: resetCode, password: resetPassword, method: resetMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to reset password")
      toast.success("Password reset. Sign in with your new password.")
      setLoginEmail(resetIdentifier.trim())
      setLoginPassword("")
      switchMode("login")
      setLoginStep("password")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to reset password")
    } finally {
      setSubmitting(false)
    }
  }

  const busy = loading || submitting
  const title =
    mode === "signup"
      ? signupStep === "email"
        ? "Create your account"
        : signupStep === "verify"
          ? "Verify your email"
          : "Finish your account"
      : mode === "reset"
        ? "Reset your password"
        : loginStep === "email"
          ? "Welcome to Drive"
          : loginStep === "password"
            ? "Enter your password"
            : "Verify your login"

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex flex-col items-center gap-2 text-center">
        <Link href="/" className="flex flex-col items-center gap-2 font-medium">
          <div className="flex size-8 items-center justify-center rounded-md">
            <GalleryVerticalEnd className="size-6" />
          </div>
          <span className="sr-only">Drive</span>
        </Link>
        <h1 className="text-xl font-bold">{title}</h1>
        <FieldDescription>
          {mode === "login" ? (
            <>Don&apos;t have an account? <button type="button" className="underline underline-offset-4" onClick={() => switchMode("signup")}>Sign up</button></>
          ) : mode === "signup" ? (
            <>Already have an account? <button type="button" className="underline underline-offset-4" onClick={() => switchMode("login")}>Login</button></>
          ) : (
            <>Remember your password? <button type="button" className="underline underline-offset-4" onClick={() => switchMode("login")}>Login</button></>
          )}
        </FieldDescription>
      </div>

      {mode === "login" && loginStep === "email" ? (
        <form onSubmit={submitLoginEmail}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="login-email">Email or username</FieldLabel>
              <Input id="login-email" autoComplete="username" required value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} />
            </Field>
            <Field>
              <Button type="submit" disabled={busy}>{busy ? "Checking..." : "Login"}</Button>
            </Field>
            <FieldSeparator>Or</FieldSeparator>
            <GoogleButton onClick={() => handleGoogleLogin("login")} />
          </FieldGroup>
        </form>
      ) : null}

      {mode === "login" && loginStep === "password" ? (
        <form onSubmit={submitLoginPassword}>
          <FieldGroup>
            <Field>
              <FieldLabel>Account</FieldLabel>
              <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{loginEmail}</div>
            </Field>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <button type="button" className="text-sm underline underline-offset-4" onClick={() => switchMode("reset")}>
                  Forgot password?
                </button>
              </div>
              <Input id="login-password" type="password" autoComplete="current-password" required value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} />
            </Field>
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={() => setLoginStep("email")}>Back</Button>
              <Button type="submit" disabled={busy}>{busy ? "Checking..." : "Continue"}</Button>
            </Field>
          </FieldGroup>
        </form>
      ) : null}

      {mode === "login" && loginStep === "verify" ? (
        <form onSubmit={verifyLoginCode}>
          <OtpFields
            code={otpCode}
            setCode={setOtpCode}
            displayTarget={isEmail(loginEmail.trim()) ? loginEmail.trim() : undefined}
            submitting={busy}
            submitText="Verify login"
            onBack={() => setLoginStep("password")}
          />
        </form>
      ) : null}

      {mode === "login" && loginStep === "totp" ? (
        <form onSubmit={verifyTotpCode}>
          <FieldGroup>
            {showVerificationMethods ? (
              <VerificationMethodList
                methods={loginMethods}
                onAuthenticator={() => {
                  setTotpCode("")
                  setShowVerificationMethods(false)
                }}
                onEmail={() => void startLoginVerification("email")}
                onSms={() => void startLoginVerification("sms")}
                disabled={busy}
              />
            ) : (
              <>
                <OtpInputField
                  displayTarget="your authenticator app"
                  code={totpCode}
                  setCode={setTotpCode}
                />
                <Field className="grid gap-3 sm:grid-cols-2">
                  <Button type="button" variant="outline" onClick={() => setLoginStep("password")}>Back</Button>
                  <Button type="submit" disabled={busy || totpCode.length !== 6}>Verify 2FA</Button>
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
      ) : null}

      {mode === "signup" && signupStep === "email" ? (
        <form onSubmit={startSignup}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="signup-email">Email</FieldLabel>
              <Input id="signup-email" type="email" autoComplete="email" required value={signupEmail} onChange={(event) => setSignupEmail(event.target.value)} />
            </Field>
            <Field>
              <Button type="submit" disabled={busy}>{busy ? "Sending..." : "Create account"}</Button>
            </Field>
            <FieldSeparator>Or</FieldSeparator>
            <GoogleButton onClick={() => handleGoogleLogin("signup")} />
          </FieldGroup>
        </form>
      ) : null}

      {mode === "signup" && signupStep === "verify" ? (
        <form onSubmit={verifySignupCode}>
          <OtpFields
            code={otpCode}
            setCode={setOtpCode}
            displayTarget={signupEmail.trim()}
            submitting={busy}
            submitText="Confirm email"
            onBack={() => setSignupStep("email")}
          />
        </form>
      ) : null}

      {mode === "signup" && ["firstName", "lastName", "username"].includes(signupStep) ? (
        <form onSubmit={submitSignupDetail}>
          <FieldGroup>
            {signupStep === "firstName" ? (
              <Field>
                <FieldLabel htmlFor="first-name">First name</FieldLabel>
                <Input id="first-name" autoComplete="given-name" required value={firstName} onChange={(event) => setFirstName(event.target.value)} />
              </Field>
            ) : null}
            {signupStep === "lastName" ? (
              <Field>
                <FieldLabel htmlFor="last-name">Last name</FieldLabel>
                <Input id="last-name" autoComplete="family-name" value={lastName} onChange={(event) => setLastName(event.target.value)} />
              </Field>
            ) : null}
            {signupStep === "username" ? (
              <Field>
                <FieldLabel htmlFor="signup-username">Username</FieldLabel>
                <Input id="signup-username" autoComplete="username" required value={username} onChange={(event) => setUsername(event.target.value)} />
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
            ) : null}
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setSignupStep(signupStep === "username" ? "lastName" : signupStep === "lastName" ? "firstName" : "verify")
                }
              >
                Back
              </Button>
              <Button type="submit" disabled={busy}>Continue</Button>
            </Field>
          </FieldGroup>
        </form>
      ) : null}

      {mode === "signup" && signupStep === "password" ? (
        <form onSubmit={finishSignup}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="signup-password">Password</FieldLabel>
              <Input id="signup-password" type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
              <FieldDescription>Use 8+ characters with uppercase, lowercase, and a number.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="confirm-password">Confirm password</FieldLabel>
              <Input id="confirm-password" type="password" autoComplete="new-password" required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </Field>
            <Field className="grid gap-3 sm:grid-cols-2">
              <Button type="button" variant="outline" onClick={() => setSignupStep("username")}>Back</Button>
              <Button type="submit" disabled={busy}>{busy ? "Creating..." : "Create account"}</Button>
            </Field>
          </FieldGroup>
        </form>
      ) : null}

      {mode === "reset" ? (
        <form onSubmit={resetStep === "email" ? sendResetCode : resetStep === "code" ? submitResetCode : resetPasswordSubmit}>
          <FieldGroup>
            {resetStep === "email" ? (
              <Field>
                <FieldLabel htmlFor="reset-email">Email or username</FieldLabel>
                <Input id="reset-email" autoComplete="username" required value={resetIdentifier} onChange={(event) => setResetIdentifier(event.target.value)} />
              </Field>
            ) : null}
            {resetStep === "code" ? (
              showResetMethods ? (
                <VerificationMethodList
                  methods={resetMethods}
                  onAuthenticator={() => {
                    setResetMethod("authenticator")
                    setResetCode("")
                    setShowResetMethods(false)
                  }}
                  onEmail={() => void startResetVerification("email")}
                  onSms={() => void startResetVerification("sms")}
                  disabled={busy}
                />
              ) : (
                <>
                  <OtpInputField
                    displayTarget={
                      resetMethod === "authenticator"
                        ? "your authenticator app"
                        : resetMethod === "sms"
                          ? "your mobile number"
                          : resetLookupEmail || (isEmail(resetIdentifier.trim()) ? resetIdentifier.trim() : undefined)
                    }
                    code={resetCode}
                    setCode={setResetCode}
                  />
                  <Field>
                    <button
                      type="button"
                      className="text-center text-sm underline underline-offset-4"
                      onClick={() => setShowResetMethods(true)}
                    >
                      View other verification methods
                    </button>
                  </Field>
                </>
              )
            ) : null}
            {resetStep === "password" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="reset-password">New password</FieldLabel>
                  <Input id="reset-password" type="password" autoComplete="new-password" required value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="reset-confirm-password">Confirm new password</FieldLabel>
                  <Input id="reset-confirm-password" type="password" autoComplete="new-password" required value={resetConfirmPassword} onChange={(event) => setResetConfirmPassword(event.target.value)} />
                </Field>
              </>
            ) : null}
            {!(resetStep === "code" && showResetMethods) ? (
              <Field className="grid gap-3 sm:grid-cols-2">
                {resetStep !== "email" ? (
                  <Button type="button" variant="outline" onClick={() => setResetStep(resetStep === "password" ? "code" : "email")}>
                    Back
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={busy || (resetStep === "code" && resetCode.length !== 6)}
                  className={resetStep === "email" ? "sm:col-span-2" : ""}
                >
                  {resetStep === "email" ? "Send reset code" : resetStep === "code" ? "Verify code" : "Reset password"}
                </Button>
              </Field>
            ) : null}
          </FieldGroup>
        </form>
      ) : null}

      <FieldDescription className="px-6 text-center">
        By continuing, you agree to our <Link href="#">Terms of Service</Link>{" "}
        and <Link href="#">Privacy Policy</Link>.
      </FieldDescription>
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
  methods: string[]
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
        <Button type="button" variant="outline" onClick={onBack}>Back</Button>
        <Button type="submit" disabled={submitting || code.length !== 6}>{submitText}</Button>
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
  const target = displayTarget
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  function applyPastedCode(nextCode: string) {
    setCode(nextCode)
    const input = inputRef.current
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    setter?.call(input, nextCode)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
  }
  async function pasteCode() {
    inputRef.current?.focus()
    if (navigator.clipboard?.readText) {
      try {
        const text = await navigator.clipboard.readText()
        const nextCode = text.replace(/\D/g, "").slice(0, 6)
        if (nextCode) applyPastedCode(nextCode)
        return
      } catch {
        // Browser blocked clipboard access. Focus the OTP field so manual paste works.
      }
    }
    toast.message("Paste into the focused code field with Ctrl+V.")
  }
  return (
    <Field className="items-center text-center">
      <FieldLabel htmlFor="otp-code" className="justify-center text-center">
        Verification code
      </FieldLabel>
      <FieldDescription className="text-center">
        Enter the 6-digit code sent to {target ? target : "your account"}.
      </FieldDescription>
      <InputOTP
        ref={inputRef}
        maxLength={6}
        id="otp-code"
        required
        value={code}
        onChange={setCode}
        containerClassName="mx-auto flex w-fit items-center justify-center gap-2"
      >
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-11 *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={0} />
          <InputOTPSlot index={1} />
          <InputOTPSlot index={2} />
        </InputOTPGroup>
        <InputOTPSeparator className="mx-2" />
        <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-12 *:data-[slot=input-otp-slot]:w-11 *:data-[slot=input-otp-slot]:text-xl">
          <InputOTPSlot index={3} />
          <InputOTPSlot index={4} />
          <InputOTPSlot index={5} />
        </InputOTPGroup>
      </InputOTP>
      <Button type="button" variant="ghost" size="sm" className="mx-auto h-8 rounded-full px-3 text-xs" onClick={() => void pasteCode()}>
        <ClipboardPaste className="h-3.5 w-3.5" />
        Paste code
      </Button>
    </Field>
  )
}

function GoogleButton({ onClick }: { onClick: () => void }) {
  return (
    <Field>
      <Button variant="outline" type="button" onClick={onClick}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path
            d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
            fill="currentColor"
          />
        </svg>
        Google
      </Button>
    </Field>
  )
}

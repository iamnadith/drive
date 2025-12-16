"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"

export default function SignupPage() {
  const router = useRouter()
  const { signup, user, loading } = useAuth()
  const [firstName, setFirstName] = React.useState("")
  const [lastName, setLastName] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [usernameStatus, setUsernameStatus] = React.useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle")
  const [usernameHint, setUsernameHint] = React.useState<string>("")
  const [emailHint, setEmailHint] = React.useState<string>("")
  const [passwordHint, setPasswordHint] = React.useState<string>("")
  const [passwordStrong, setPasswordStrong] = React.useState(false)
  const [emailStatus, setEmailStatus] = React.useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle")

  function isValidEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  }

  function evaluatePassword(value: string) {
    if (!value) {
      setPasswordHint("")
      setPasswordStrong(false)
      return
    }
    const lengthOk = value.length >= 8
    const hasUpper = /[A-Z]/.test(value)
    const hasLower = /[a-z]/.test(value)
    const hasNumber = /[0-9]/.test(value)

    const strong = lengthOk && hasUpper && hasLower && hasNumber
    setPasswordStrong(strong)

    if (!lengthOk) {
      setPasswordHint("Password should be at least 8 characters long.")
    } else if (!(hasUpper && hasLower)) {
      setPasswordHint("Use both uppercase and lowercase letters.")
    } else if (!hasNumber) {
      setPasswordHint("Add at least one number.")
    } else {
      setPasswordHint("Strong password.")
    }
  }

  React.useEffect(() => {
    if (user && !loading) {
      router.replace("/")
    }
  }, [user, loading, router])

  React.useEffect(() => {
    const value = email.trim()
    if (!value || !isValidEmail(value)) {
      return
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/email-available?email=${encodeURIComponent(value)}`,
          { signal: controller.signal }
        )
        const data = await res.json()
        if (!res.ok) {
          setEmailStatus("error")
          setEmailHint(data.error ?? "Unable to check email")
          return
        }
        if (data.available) {
          setEmailStatus("available")
          setEmailHint("Email is available")
        } else {
          setEmailStatus("taken")
          setEmailHint("That email is already registered")
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setEmailStatus("error")
          setEmailHint("Unable to check email")
        }
      }
    }, 400)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [email])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim()) {
      toast.error("Please choose a username")
      return
    }
    if (usernameStatus === "taken") {
      toast.error("That username is already taken")
      return
    }
    if (!isValidEmail(email.trim())) {
      toast.error("Please enter a valid email address")
      return
    }
    if (emailStatus === "taken") {
      toast.error("That email is already registered")
      return
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match")
      return
    }
    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim()
    await signup(fullName || "New User", email, password, username.trim())
  }

  function handleGoogleSignup() {
    const url = new URL(
      "/api/auth/google/login",
      typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"
    )
    url.searchParams.set("mode", "signup")
    url.searchParams.set("redirect", "/")
    window.location.href = url.toString()
  }

  React.useEffect(() => {
    const value = username.trim()
    if (!value) {
      setUsernameStatus("idle")
      setUsernameHint("")
      return
    }
    setUsernameStatus("checking")
    setUsernameHint("Checking username availability…")

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/username-available?username=${encodeURIComponent(
            value
          )}`,
          { signal: controller.signal }
        )
        const data = await res.json()
        if (!res.ok) {
          setUsernameStatus("error")
          setUsernameHint(data.error ?? "Unable to check username")
          return
        }
        if (data.available) {
          setUsernameStatus("available")
          setUsernameHint("Username is available")
        } else {
          setUsernameStatus("taken")
          setUsernameHint("Username is already taken")
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setUsernameStatus("error")
          setUsernameHint("Unable to check username")
        }
      }
    }, 400)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [username])

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Create an account</CardTitle>
          <CardDescription>
            Enter your information below to create your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <FieldGroup className="gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="first-name">First name</FieldLabel>
                  <Input
                    id="first-name"
                    type="text"
                    autoComplete="given-name"
                    placeholder="John"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="last-name">Last name</FieldLabel>
                  <Input
                    id="last-name"
                    type="text"
                    autoComplete="family-name"
                    placeholder="Doe"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="username">Username</FieldLabel>
                <Input
                  id="username"
                  type="text"
                  autoComplete="username"
                  placeholder="johndoe"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
                {usernameStatus !== "idle" && (
                  <FieldDescription
                    className={
                      usernameStatus === "available"
                        ? "text-emerald-500"
                        : usernameStatus === "taken"
                        ? "text-destructive"
                        : undefined
                    }
                  >
                    {usernameHint}
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  placeholder="m@example.com"
                  required
                  value={email}
                  onChange={(e) => {
                    const value = e.target.value
                    setEmail(value)
                    if (!value.trim()) {
                      setEmailHint("")
                      setEmailStatus("idle")
                    } else if (!isValidEmail(value.trim())) {
                      setEmailHint("Please enter a valid email address.")
                      setEmailStatus("error")
                    } else {
                      // Valid format; availability will be checked in an effect
                      setEmailStatus("checking")
                      setEmailHint("Checking email availability…")
                    }
                  }}
                />
                <FieldDescription>
                  We&apos;ll use this to contact you. We will not share your
                  email with anyone else.
                </FieldDescription>
                {emailHint && (
                  <FieldDescription className="text-destructive">
                    {emailHint}
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => {
                    const value = e.target.value
                    setPassword(value)
                    evaluatePassword(value)
                  }}
                />
                {passwordHint && (
                  <FieldDescription
                    className={
                      passwordStrong ? "text-emerald-500" : "text-destructive"
                    }
                  >
                    {passwordHint}
                  </FieldDescription>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="confirm-password">
                  Confirm password
                </FieldLabel>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                />
                <FieldDescription>
                  Please confirm your password.
                </FieldDescription>
                {confirmPassword &&
                  password &&
                  confirmPassword !== password && (
                    <FieldDescription className="text-destructive">
                      Passwords do not match.
                    </FieldDescription>
                  )}
              </Field>
              <FieldGroup className="gap-4">
                <Field>
                  <div className="space-y-3">
                    <Button type="submit" className="w-full" disabled={loading}>
                      Create account
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      className="w-full"
                      onClick={handleGoogleSignup}
                    >
                      Sign up with Google
                    </Button>
                  </div>
                  <FieldDescription className="px-6 text-center">
                    Already have an account?{" "}
                    <button
                      type="button"
                      className="underline underline-offset-4"
                      onClick={() => router.push("/login")}
                    >
                      Sign in
                    </button>
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

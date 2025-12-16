"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"

export default function SetupPage() {
  const router = useRouter()
  const { setUserDirect } = useAuth()
  const [firstName, setFirstName] = React.useState("")
  const [lastName, setLastName] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [passwordHint, setPasswordHint] = React.useState<string>("")
  const [passwordStrong, setPasswordStrong] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [usernameStatus, setUsernameStatus] = React.useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle")
  const [usernameHint, setUsernameHint] = React.useState("")

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

    // Strong = length + mixed case + number (no special char required)
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

  function isValidEmail(value: string) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const fullName = `${firstName.trim()} ${lastName.trim()}`.trim()
    if (!fullName || !username.trim() || !email.trim()) {
      toast.error("All fields are required")
      return
    }
    if (!isValidEmail(email.trim())) {
      toast.error("Please enter a valid email address")
      return
    }
    if (usernameStatus === "taken") {
      toast.error("That username is already taken")
      return
    }
    if (!passwordStrong) {
      toast.error("Please choose a stronger password")
      return
    }
    if (password !== confirmPassword) {
      toast.error("Passwords do not match")
      return
    }
    setLoading(true)
    try {
      const res = await fetch("/api/setup/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fullName,
          username: username.trim(),
          email,
          password,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? "Unable to create Super Admin")
        return
      }
      // Log in the newly created Super Admin in the client-side auth state.
      if (data.user) {
        setUserDirect(data.user)
      }
      toast.success("Super Admin created")
      router.replace("/")
    } catch {
      toast.error("Unable to create Super Admin")
    } finally {
      setLoading(false)
    }
  }

  function handleGoogleSetup() {
    const url = new URL(
      "/api/auth/google/login",
      typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"
    )
    url.searchParams.set("mode", "setup")
    url.searchParams.set("redirect", "/")
    window.location.href = url.toString()
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className={cn("flex flex-col gap-6 w-full max-w-lg")}>
        <Card>
          <CardHeader className="text-center">
            <CardTitle className="text-xl">Create Super Admin</CardTitle>
            <CardDescription>
              No Super Admin exists yet. Create the initial Super Admin account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit}>
              <FieldGroup>
                <Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
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
                    </div>
                    <div>
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
                    </div>
                  </div>
                </Field>
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
                  {usernameStatus !== "idle" && usernameHint && (
                    <FieldDescription
                      className={
                        usernameStatus === "available"
                          ? "text-emerald-500"
                          : usernameStatus === "taken"
                          ? "text-destructive"
                          : "text-muted-foreground"
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
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>
                <Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                    </Field>
                  </div>
                  <FieldDescription>
                    Must be at least 8 characters long and include upper and
                    lower case letters and a number.
                  </FieldDescription>
                  {passwordHint && (
                    <FieldDescription
                      className={
                        passwordStrong
                          ? "text-emerald-500"
                          : "text-destructive"
                      }
                    >
                      {passwordHint}
                    </FieldDescription>
                  )}
                  {confirmPassword &&
                    password &&
                    confirmPassword !== password && (
                      <FieldDescription className="text-destructive">
                        Passwords do not match.
                      </FieldDescription>
                    )}
                </Field>
                <Field>
                  <Button type="submit" disabled={loading}>
                    {loading ? "Creating..." : "Create Super Admin"}
                  </Button>
                  <FieldDescription className="text-center">
                    This account will have full control over the panel.
                  </FieldDescription>
                </Field>
                <Field>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleGoogleSetup}
                  >
                    Use Google account
                  </Button>
                  <FieldDescription className="text-center">
                    Create the initial Super Admin using your Google login.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  BadgeCheck,
  Cloud,
  ImagePlus,
  KeyRound,
  Link2,
  LockKeyhole,
  Phone,
  Save,
  Shield,
  Smartphone,
  Trash2,
  UserRound,
} from "lucide-react"
import { toast } from "sonner"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/components/auth-provider"
import { cn } from "@/lib/utils"

function initials(name: string, email: string) {
  const source = name.trim() || email.split("@")[0] || "User"
  return source
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("")
}

function roleLabel(role: string) {
  if (role === "superadmin") return "Super Admin"
  if (role === "admin") return "Admin"
  return "User"
}

function formatQuota(usedMb: number, limitMb: number) {
  if (!limitMb || limitMb <= 0) return `${usedMb} MB used of Unlimited`
  return `${usedMb} / ${limitMb} MB`
}

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === "string") resolve(result)
      else reject(new Error("Unable to read file"))
    }
    reader.onerror = () => reject(new Error("Unable to read file"))
    reader.readAsDataURL(file)
  })
}

async function resizeImageToUnderLimit(
  file: File,
  maxBytes = 2 * 1024 * 1024,
  maxDimension = 512
): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file)
  const approxBytes = Math.ceil((dataUrl.length * 3) / 4)
  if (approxBytes <= maxBytes) return dataUrl

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas")
        const ctx = canvas.getContext("2d")
        if (!ctx) {
          reject(new Error("Canvas not supported"))
          return
        }

        const scale = Math.min(1, maxDimension / Math.max(img.width, img.height))
        const width = Math.max(1, Math.floor(img.width * scale))
        const height = Math.max(1, Math.floor(img.height * scale))

        canvas.width = width
        canvas.height = height
        ctx.drawImage(img, 0, 0, width, height)

        let quality = 0.9
        let output = canvas.toDataURL("image/jpeg", quality)
        while (output.length * 0.75 > maxBytes && quality > 0.4) {
          quality -= 0.1
          output = canvas.toDataURL("image/jpeg", quality)
        }
        resolve(output)
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Resize failed"))
      }
    }
    img.onerror = () => reject(new Error("Unable to load image"))
    img.src = dataUrl
  })
}

export default function ProfilePage() {
  const { user, updateSelf, loading, setUserDirect } = useAuth()
  const router = useRouter()
  const [name, setName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [username, setUsername] = React.useState("")
  const [profileImageUrl, setProfileImageUrl] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [usernameStatus, setUsernameStatus] = React.useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle")
  const [emailStatus, setEmailStatus] = React.useState<"idle" | "checking" | "available" | "taken" | "invalid">("idle")
  const [saving, setSaving] = React.useState(false)
  const avatarFileRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    if (!user && !loading) router.replace("/login?redirect=/profile")
  }, [user, loading, router])

  React.useEffect(() => {
    setName(user?.name ?? "")
    setEmail(user?.email ?? "")
    setUsername(user?.username ?? "")
    setProfileImageUrl(user?.profileImageUrl ?? "")
    setPassword("")
  }, [user])

  React.useEffect(() => {
    if (!user) return
    const nextUsername = username.trim()
    if (!nextUsername || nextUsername === (user.username ?? "")) {
      setUsernameStatus("idle")
      return
    }
    if (nextUsername.includes("@")) {
      setUsernameStatus("invalid")
      return
    }

    setUsernameStatus("checking")
    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/username-available?username=${encodeURIComponent(nextUsername)}`, {
          signal: controller.signal,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Unable to check username")
        setUsernameStatus(data.available ? "available" : "taken")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setUsernameStatus("invalid")
      }
    }, 350)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [user, username])

  React.useEffect(() => {
    if (!user) return
    const nextEmail = email.trim().toLowerCase()
    if (!nextEmail || nextEmail === user.email.toLowerCase()) {
      setEmailStatus("idle")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      setEmailStatus("invalid")
      return
    }

    setEmailStatus("checking")
    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/users/email-available?email=${encodeURIComponent(nextEmail)}`, {
          signal: controller.signal,
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? "Unable to check email")
        setEmailStatus(data.available ? "available" : "taken")
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setEmailStatus("invalid")
      }
    }, 350)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [email, user])

  if (!user) return null

  const quotaPercent =
    user.quotaLimitMb && user.quotaLimitMb > 0
      ? Math.min(100, Math.round((user.quotaUsedMb / user.quotaLimitMb) * 100))
      : 0
  const isGoogleLinked = Boolean(user.googleLinked)
  const hasLocalPassword = user.passwordSource !== "google-generated"
  const avatarSrc = profileImageUrl || user.profileImageUrl || ""
  const dirty =
    name !== user.name ||
    email !== user.email ||
    username !== (user.username ?? "") ||
    profileImageUrl !== (user.profileImageUrl ?? "")
  async function saveProfile(event?: React.FormEvent) {
    event?.preventDefault()
    if (!name.trim()) return toast.error("Name is required")
    if (!email.trim()) return toast.error("Email is required")
    if (usernameStatus === "checking" || emailStatus === "checking") {
      return toast.error("Wait for availability checks to finish")
    }
    if (usernameStatus === "taken") return toast.error("Username is already taken")
    if (emailStatus === "taken") return toast.error("Email is already in use")
    if (usernameStatus === "invalid" || emailStatus === "invalid") {
      return toast.error("Fix account detail errors before saving")
    }

    setSaving(true)
    try {
      await updateSelf({
        name: name.trim(),
        username: username.trim() || undefined,
        email: email.trim(),
        profileImageUrl: profileImageUrl.trim(),
      })
    } finally {
      setSaving(false)
    }
  }

  async function disableTotp() {
    setSaving(true)
    try {
      const res = await fetch("/api/auth/totp/setup", { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to remove authenticator app")
      setUserDirect(data.user)
      toast.success("Authenticator app removed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove authenticator app")
    } finally {
      setSaving(false)
    }
  }

  async function setTwoFactorEnabled(enabled: boolean) {
    setSaving(true)
    try {
      const res = await fetch("/api/auth/2fa", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to update 2FA")
      setUserDirect(data.user)
      toast.success(enabled ? "2FA enabled" : "2FA disabled")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update 2FA")
    } finally {
      setSaving(false)
    }
  }

  async function removeMobileNumber() {
    setSaving(true)
    try {
      const res = await fetch("/api/auth/mobile/setup", { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to remove mobile number")
      setUserDirect(data.user)
      toast.success("Mobile verification removed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove mobile number")
    } finally {
      setSaving(false)
    }
  }

  function handleLinkGoogle() {
    const url = new URL(
      "/api/auth/google/login",
      typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"
    )
    url.searchParams.set("mode", "link")
    url.searchParams.set("redirect", "/profile")
    window.location.href = url.toString()
  }

  async function handleUnlinkGoogle() {
    if (!hasLocalPassword && !password) {
      toast.error("Add a password before unlinking Google.")
      return
    }

    setSaving(true)
    try {
      await updateSelf({
        googleLinked: false,
        password: password || undefined,
      })
      setPassword("")
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file")
      return
    }

    try {
      const dataUrl = await resizeImageToUnderLimit(file)
      setProfileImageUrl(dataUrl)
    } catch {
      toast.error("Unable to process image. Please try a smaller file.")
    }
  }

  return (
    <main className="page-under-header px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
      <form onSubmit={(event) => void saveProfile(event)} className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <section className="rounded-3xl border bg-card p-5 shadow-sm sm:p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:text-left">
              <div className="group relative w-fit">
                <Avatar className="h-20 w-20 rounded-2xl border sm:h-24 sm:w-24">
                  <AvatarImage src={avatarSrc} />
                  <AvatarFallback className="rounded-2xl text-xl">{initials(user.name, user.email)}</AvatarFallback>
                </Avatar>
                <div className="absolute inset-x-1 bottom-1 flex justify-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100">
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="h-8 w-8 rounded-full shadow"
                    onClick={() => avatarFileRef.current?.click()}
                  >
                    <ImagePlus className="h-4 w-4" />
                  </Button>
                  {avatarSrc ? (
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="h-8 w-8 rounded-full shadow"
                      onClick={() => setProfileImageUrl("")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
                <input
                  ref={avatarFileRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleAvatarFileChange}
                />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
                  <h1 className="truncate text-2xl font-semibold tracking-tight">{user.name}</h1>
                  <Badge variant="secondary" className="rounded-full">{roleLabel(user.role)}</Badge>
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{user.email}</p>
                <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
                  <Badge variant={user.emailVerified ? "default" : "outline"} className="rounded-full">
                    <BadgeCheck className="h-3 w-3" />
                    {user.emailVerified ? "Verified" : "Unverified"}
                  </Badge>
                  <Badge variant={user.twoFactorEnabled ? "default" : "outline"} className="rounded-full">
                    <Shield className="h-3 w-3" />
                    {user.twoFactorEnabled ? "2FA on" : "2FA off"}
                  </Badge>
                  <Badge variant={isGoogleLinked ? "default" : "outline"} className="rounded-full">
                    <Link2 className="h-3 w-3" />
                    {isGoogleLinked ? "Google linked" : "Local sign-in"}
                  </Badge>
                </div>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 lg:min-w-72">
              {dirty ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full rounded-xl"
                  onClick={() => {
                    setName(user.name)
                    setEmail(user.email)
                    setUsername(user.username ?? "")
                    setProfileImageUrl(user.profileImageUrl ?? "")
                  }}
                >
                  Discard
                </Button>
              ) : null}
              <Button
                type="submit"
                loading={saving}
                disabled={!dirty || loading}
                className={cn("w-full rounded-xl", !dirty && "sm:col-span-2")}
              >
                {!saving ? <Save className="h-4 w-4" /> : null}
                Save changes
              </Button>
            </div>
          </div>
        </section>

        {!user.twoFactorEnabled ? (
          <section className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between sm:p-5">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <div className="font-medium">2FA is off</div>
                <p className="text-sm opacity-80">Enable 2FA to require verification for password and Google sign-in.</p>
              </div>
            </div>
            <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" onClick={() => void setTwoFactorEnabled(true)} loading={saving}>
              <Shield className="h-4 w-4" />
              Enable 2FA
            </Button>
          </section>
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_420px]">
          <Card className="rounded-3xl py-0">
            <CardHeader className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
              <CardTitle className="flex items-center gap-2 text-base">
                <UserRound className="h-4 w-4 text-muted-foreground" />
                Profile
              </CardTitle>
              <CardDescription>Edit the basic account details people see in the app.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 px-5 pb-5 sm:px-6 sm:pb-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="profile-name">Display name</Label>
                  <Input
                    id="profile-name"
                    required
                    className="rounded-xl"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="profile-username">Username</Label>
                  <Input
                    id="profile-username"
                    className="rounded-xl"
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                  {usernameStatus !== "idle" ? (
                    <p className={cn(
                      "text-xs",
                      usernameStatus === "available" && "text-emerald-600",
                      (usernameStatus === "taken" || usernameStatus === "invalid") && "text-destructive",
                      usernameStatus === "checking" && "text-muted-foreground"
                    )}>
                      {usernameStatus === "checking"
                        ? "Checking username..."
                        : usernameStatus === "available"
                          ? "Username is available"
                          : usernameStatus === "taken"
                            ? "Username is already taken"
                            : "Choose a different username"}
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="profile-email">Email</Label>
                  <Input
                    id="profile-email"
                    type="email"
                    required
                    className="rounded-xl"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                  {email !== user.email ? (
                    <p className={cn(
                      "text-xs",
                      emailStatus === "available" && "text-emerald-600",
                      (emailStatus === "taken" || emailStatus === "invalid") && "text-destructive",
                      emailStatus === "checking" && "text-muted-foreground"
                    )}>
                      {emailStatus === "checking"
                        ? "Checking email..."
                        : emailStatus === "available"
                          ? "Email is available. Saving will unlink Google sign-in until the new email is verified."
                          : emailStatus === "taken"
                            ? "Email is already in use"
                            : "Enter a valid email address"}
                    </p>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card className="rounded-3xl py-0">
              <CardHeader className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Cloud className="h-4 w-4 text-muted-foreground" />
                  Storage
                </CardTitle>
                <CardDescription>{formatQuota(user.quotaUsedMb, user.quotaLimitMb)}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 px-5 pb-5 sm:px-6 sm:pb-6">
                {user.quotaLimitMb > 0 ? (
                  <>
                    <Progress value={quotaPercent} />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{quotaPercent}% used</span>
                      <span>{Math.max(0, user.quotaLimitMb - user.quotaUsedMb)} MB free</span>
                    </div>
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed p-3 text-sm text-muted-foreground">
                    This account has unlimited quota.
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="rounded-3xl py-0">
              <CardHeader className="px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  Security
                </CardTitle>
                <CardDescription>Password, 2FA, and connected sign-in methods.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5 px-5 pb-5 sm:px-6 sm:pb-6">
                <section className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                      <Shield className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div className="min-w-0">
                        <h2 className="text-sm font-medium">Two-factor verification</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {user.twoFactorEnabled
                            ? "Verification is required for direct and Google sign-in."
                            : "Turn on verification for direct and Google sign-in."}
                        </p>
                      </div>
                    </div>
                    <Switch
                      className="shrink-0"
                      checked={Boolean(user.twoFactorEnabled)}
                      onCheckedChange={(checked) => void setTwoFactorEnabled(checked)}
                      disabled={saving}
                      aria-label="Enable two-factor verification"
                    />
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <LockKeyhole className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div>
                        <h2 className="text-sm font-medium">{hasLocalPassword ? "Password" : "Add password"}</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Verify with an available method before changing it.
                        </p>
                      </div>
                    </div>
                    <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" asChild>
                      <Link href="/profile/change-password">
                      Change password
                      </Link>
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="space-y-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-start gap-3">
                      <Smartphone className="mt-0.5 h-4 w-4 text-muted-foreground" />
                      <div>
                        <h2 className="text-sm font-medium">Authenticator app</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {user.totpEnabled ? "Configured as a verification method." : "Add a 6-digit code from an authenticator app."}
                        </p>
                      </div>
                    </div>
                    {user.totpEnabled ? (
                      <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" onClick={() => void disableTotp()} loading={saving}>
                        Remove
                      </Button>
                    ) : (
                      <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" asChild>
                        <Link href="/profile/authenticator">
                        Set up
                        </Link>
                      </Button>
                    )}
                  </div>
                </section>

                <Separator />

                <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <Phone className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    <div className="min-w-0">
                      <h2 className="text-sm font-medium">Mobile SMS</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {user.mobileVerified && user.mobileNumber ? user.mobileNumber : "Add a +94 number for SMS OTP."}
                      </p>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {user.mobileVerified ? (
                      <Button type="button" variant="outline" className="rounded-xl" onClick={() => void removeMobileNumber()} loading={saving}>
                        Remove
                      </Button>
                    ) : null}
                    <Button type="button" variant="outline" className="rounded-xl" asChild>
                      <Link href="/profile/mobile">
                      {user.mobileVerified ? "Change" : "Add"}
                      </Link>
                    </Button>
                  </div>
                </section>

                <Separator />

                <section className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    {isGoogleLinked ? (
                      <Link2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    ) : (
                      <KeyRound className="mt-0.5 h-4 w-4 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <h2 className="text-sm font-medium">Google sign-in</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {isGoogleLinked ? "Connected." : "Not connected."}
                      </p>
                      {isGoogleLinked && !hasLocalPassword ? (
                        <p className="mt-2 text-xs text-destructive">Add a password before unlinking Google.</p>
                      ) : null}
                    </div>
                  </div>
                  {!isGoogleLinked ? (
                    <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" onClick={handleLinkGoogle} loading={saving} disabled={loading}>
                      Link Google
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" className="w-full rounded-xl sm:w-auto" onClick={() => void handleUnlinkGoogle()} loading={saving} disabled={loading}>
                      Unlink
                    </Button>
                  )}
                </section>
              </CardContent>
            </Card>
          </div>
        </div>
      </form>
    </main>
  )
}

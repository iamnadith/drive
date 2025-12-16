"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@/components/auth-provider"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { toast } from "sonner"

export default function ProfilePage() {
  const { user, updateSelf, loading } = useAuth()
  const router = useRouter()
  const [name, setName] = React.useState(user?.name ?? "")
  const [email, setEmail] = React.useState(user?.email ?? "")
  const [profileImageUrl, setProfileImageUrl] = React.useState(
    user?.profileImageUrl ?? ""
  )
  const [password, setPassword] = React.useState("")

  React.useEffect(() => {
    if (!user && !loading) {
      router.replace("/login?redirect=/profile")
    }
  }, [user, loading, router])

  React.useEffect(() => {
    setName(user?.name ?? "")
    setEmail(user?.email ?? "")
    setProfileImageUrl(user?.profileImageUrl ?? "")
  }, [user])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await updateSelf({
      name,
      email,
      profileImageUrl,
      password: password || undefined,
    })
    setPassword("")
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
    if (!user) return

    const hasLocalPassword = user.passwordSource !== "google-generated"

    if (!hasLocalPassword && !password) {
      toast.error(
        "Please add a password in the password field before unlinking Google."
      )
      return
    }

    try {
      await updateSelf({
        googleLinked: false,
        password: password || undefined,
      })
      setPassword("")
    } catch {
      // error toast handled in updateSelf
    }
  }

  if (!user) {
    return null
  }

  const quotaLabel =
    user.quotaLimitMb && user.quotaLimitMb > 0
      ? `${user.quotaUsedMb} / ${user.quotaLimitMb} MB`
      : `${user.quotaUsedMb} MB used of Unlimited`

  async function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result === "string") {
          resolve(result)
        } else {
          reject(new Error("Unable to read file"))
        }
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

    // If already under limit, just use it.
    const approxBytes = Math.ceil((dataUrl.length * 3) / 4)
    if (approxBytes <= maxBytes) {
      return dataUrl
    }

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

          let width = img.width
          let height = img.height

          const scale = Math.min(1, maxDimension / Math.max(width, height))
          width = Math.max(1, Math.floor(width * scale))
          height = Math.max(1, Math.floor(height * scale))

          canvas.width = width
          canvas.height = height
          ctx.drawImage(img, 0, 0, width, height)

          let quality = 0.9
          let output = canvas.toDataURL("image/jpeg", quality)

          while (
            output.length * 0.75 > maxBytes &&
            quality > 0.4
          ) {
            quality -= 0.1
            output = canvas.toDataURL("image/jpeg", quality)
          }

          resolve(output)
        } catch (err) {
          reject(err instanceof Error ? err : new Error("Resize failed"))
        }
      }
      img.onerror = () => reject(new Error("Unable to load image"))
      img.src = dataUrl
    })
  }

  async function handleAvatarFileChange(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0]
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

  const isGoogleLinked = !!user.googleLinked
  const hasLocalPassword = user.passwordSource !== "google-generated"

  return (
    <div className="flex flex-1 items-center justify-center">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>
            Update your personal details and password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="flex items-center gap-4">
              <Avatar className="h-12 w-12 rounded-lg">
                <AvatarImage src={profileImageUrl || user.profileImageUrl} />
                <AvatarFallback className="rounded-lg">
                  {user.name.substring(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="space-y-1 text-sm">
                <p className="font-medium">{user.name}</p>
                <p className="text-muted-foreground">
                  Quota: {quotaLabel}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="avatar">Profile picture URL (optional)</Label>
              <Input
                id="avatar"
                placeholder="https://example.com/avatar.png"
                value={profileImageUrl}
                onChange={(e) => setProfileImageUrl(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="avatar-upload">Profile picture upload</Label>
              <Input
                id="avatar-upload"
                type="file"
                accept="image/*"
                onChange={handleAvatarFileChange}
              />
              <p className="text-xs text-muted-foreground">
                Choose an image file to upload as your profile picture.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">
                {hasLocalPassword ? "New password" : "Add password"}
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <div className="space-y-2 border-t pt-4 mt-4">
              <Label>Google account</Label>
              <p className="text-sm text-muted-foreground">
                {isGoogleLinked
                  ? "Your account is currently linked with a Google login."
                  : "You can link your account with a Google login for easier sign-in."}
              </p>
              <div className="flex gap-2">
                {!isGoogleLinked ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleLinkGoogle}
                    disabled={loading}
                  >
                    Link Google account
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleUnlinkGoogle}
                    disabled={loading}
                  >
                    Unlink Google account
                  </Button>
                )}
              </div>
              {isGoogleLinked && !hasLocalPassword && (
                <p className="text-xs text-destructive">
                  Before unlinking, you must add a password above. Enter a
                  password, then click &quot;Unlink Google account&quot;.
                </p>
              )}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              Save changes
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

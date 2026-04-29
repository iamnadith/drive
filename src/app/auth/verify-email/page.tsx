"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { MailCheck } from "lucide-react"
import { toast } from "sonner"

import { type AuthUser, useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"

export default function VerifyEmailPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { setUserDirect } = useAuth()
  const [email, setEmail] = React.useState(searchParams.get("email") ?? "")
  const [code, setCode] = React.useState("")
  const [loading, setLoading] = React.useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify email")
      setUserDirect(data.user as AuthUser)
      toast.success("Email verified")
      router.replace("/")
    } catch (error) {
      toast.error(
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "Unable to verify email")
          : "Unable to verify email"
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-flow-bg min-h-svh">
      <div className="mx-auto flex min-h-svh w-full max-w-md items-center p-4 sm:p-6">
        <form className="auth-flow-panel w-full rounded-3xl p-5 backdrop-blur sm:p-6" onSubmit={handleSubmit}>
          <div className="mb-5 flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border bg-primary/10">
              <MailCheck className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-semibold">Email verification</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Enter the 6-digit code sent to your email address.
              </p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="verify-email">Email</Label>
              <Input
                id="verify-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="verify-code">Verification code</Label>
              <InputOTP maxLength={6} id="verify-code" required value={code} onChange={setCode}>
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
            </div>
            <Button
              type="submit"
              className="w-full"
              loading={loading}
              disabled={code.length !== 6}
            >
              Verify
            </Button>
          </div>
        </form>
      </div>
    </main>
  )
}

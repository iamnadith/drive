"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { ClipboardPaste } from "lucide-react"
import { toast } from "sonner"
import { useAuth } from "@/components/auth-provider"
import { Button } from "@/components/ui/button"
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp"

export default function GoogleCompletePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { setUserDirect } = useAuth()
  const [error, setError] = React.useState<string | null>(null)
  const [verifying, setVerifying] = React.useState(false)
  const [methods, setMethods] = React.useState<string[]>([])
  const [method, setMethod] = React.useState("authenticator")
  const [code, setCode] = React.useState("")
  const [email, setEmail] = React.useState("")
  const otpInputRef = React.useRef<HTMLInputElement | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
        if (searchParams.get("verify") === "1") {
          const res = await fetch("/api/auth/google/verify")
          const data = await res.json()
          if (!res.ok) throw new Error(data.error ?? "Unable to load verification")
          setMethods(Array.isArray(data.methods) ? data.methods.map(String) : ["email"])
          setMethod(String(data.defaultMethod || "email"))
          setEmail(String(data.email || ""))
          setVerifying(true)
          return
        }

        const res = await fetch("/api/auth/me")
        const data = await res.json()
        if (!res.ok) {
          throw new Error(data.error ?? "Unable to complete sign in")
        }

        if (data.user) {
          setUserDirect(data.user)
          const redirectTo = searchParams.get("redirect") || "/"
          router.replace(redirectTo)
        } else {
          setError("You are not signed in.")
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Unable to complete sign in")
      }
    })()
  }, [router, searchParams, setUserDirect])

  async function sendCode(nextMethod = method) {
    try {
      const res = await fetch("/api/auth/google/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", method: nextMethod }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to send code")
      toast.success("Verification code sent")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to send code")
    }
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault()
    try {
      const res = await fetch("/api/auth/google/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "verify", method, code }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "Unable to verify")
      setUserDirect(data.user)
      router.replace(searchParams.get("redirect") || "/")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Unable to verify")
    }
  }

  function applyPastedCode(nextCode: string) {
    setCode(nextCode)
    const input = otpInputRef.current
    if (!input) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
    setter?.call(input, nextCode)
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.focus()
  }

  async function pasteCode() {
    otpInputRef.current?.focus()
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

  if (verifying) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <form onSubmit={verifyCode} className="w-full max-w-sm space-y-5 rounded-3xl border bg-card p-6 shadow-sm">
          <div className="space-y-2 text-center">
            <p className="text-lg font-medium">Verify Google sign-in</p>
            <p className="text-sm text-muted-foreground">Choose a verification method for {email}.</p>
          </div>
          <div className="grid gap-2">
            {methods.map((item) => (
              <Button
                key={item}
                type="button"
                variant={method === item ? "default" : "outline"}
                className="rounded-xl"
                onClick={() => {
                  setMethod(item)
                  setCode("")
                }}
              >
                {item === "authenticator" ? "Authenticator app" : item === "sms" ? "SMS OTP" : "Email OTP"}
              </Button>
            ))}
          </div>
          {method !== "authenticator" ? (
            <Button type="button" variant="outline" className="w-full rounded-xl" onClick={() => void sendCode()}>
              Send {method === "sms" ? "SMS" : "email"} code
            </Button>
          ) : null}
          <div className="space-y-2">
            <div className="text-center text-sm font-medium">Verification code</div>
            <InputOTP ref={otpInputRef} id="google-otp-code" maxLength={6} value={code} onChange={(value) => setCode(value.replace(/\D/g, ""))} containerClassName="justify-center">
              <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-11 *:data-[slot=input-otp-slot]:w-10">
                <InputOTPSlot index={0} />
                <InputOTPSlot index={1} />
                <InputOTPSlot index={2} />
              </InputOTPGroup>
              <InputOTPSeparator />
              <InputOTPGroup className="*:data-[slot=input-otp-slot]:h-11 *:data-[slot=input-otp-slot]:w-10">
                <InputOTPSlot index={3} />
                <InputOTPSlot index={4} />
                <InputOTPSlot index={5} />
              </InputOTPGroup>
            </InputOTP>
            <Button type="button" variant="ghost" size="sm" className="mx-auto h-8 rounded-full px-3 text-xs" onClick={() => void pasteCode()}>
              <ClipboardPaste className="h-3.5 w-3.5" />
              Paste code
            </Button>
          </div>
          <Button type="submit" className="w-full rounded-xl" disabled={code.length !== 6}>
            Verify sign-in
          </Button>
        </form>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="space-y-4 text-center">
        {!error ? (
          <>
            <p className="text-lg font-medium">
              Finishing Google sign-in&hellip;
            </p>
            <p className="text-sm text-muted-foreground">
              Please wait while we prepare your account.
            </p>
          </>
        ) : (
          <>
            <p className="text-lg font-medium text-destructive">
              Google sign-in failed
            </p>
            <p className="text-sm text-muted-foreground">{error}</p>
            <button
              type="button"
              className="mt-4 text-sm underline underline-offset-4"
              onClick={() => router.replace("/login")}
            >
              Back to login
            </button>
          </>
        )}
      </div>
    </div>
  )
}


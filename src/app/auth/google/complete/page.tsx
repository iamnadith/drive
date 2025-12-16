"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useAuth } from "@/components/auth-provider"

export default function GoogleCompletePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { setUserDirect } = useAuth()
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    ;(async () => {
      try {
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
      } catch (err: any) {
        setError(err?.message ?? "Unable to complete sign in")
      }
    })()
  }, [router, searchParams, setUserDirect])

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


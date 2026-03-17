"use client"

import * as React from "react"
import { useSearchParams } from "next/navigation"

export default function GitHubCompletePage() {
  const searchParams = useSearchParams()
  const status = searchParams.get("status") === "connected" ? "connected" : "error"

  React.useEffect(() => {
    if (typeof window === "undefined") return

    const origin = window.location.origin
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: "github-oauth", status }, origin)
      window.close()
    }
  }, [status])

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="space-y-3 text-center">
        <p className="text-lg font-medium">
          {status === "connected" ? "GitHub connected" : "GitHub connection failed"}
        </p>
        <p className="text-sm text-muted-foreground">
          {status === "connected"
            ? "You can close this window and continue adding the worker."
            : "Close this window and try the connection again."}
        </p>
      </div>
    </div>
  )
}

"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

type Props = { children: React.ReactNode }
type SetupSignal = { hasSuperAdmin?: boolean; setupRequired?: boolean }

export const WORKER_FAILURE_EVENT = "drive:worker-failure"

export function SuperAdminGate({ children }: Props) {
  const router = useRouter()
  const pathname = usePathname()

  React.useEffect(() => {
    let cancelled = false
    let checking = false

    const inspectInBackground = async (forceWorkers = false) => {
      if (checking) return
      checking = true
      try {
        const response = await fetch(`/api/setup/status${forceWorkers ? "?forceWorkers=1" : ""}`, { cache: "no-store" })
        const status = await response.json() as SetupSignal
        if (cancelled || !response.ok) return
        if (status.setupRequired === true && pathname !== "/setup") router.replace("/setup")
        else if (status.hasSuperAdmin === true && status.setupRequired === false && pathname === "/setup") router.replace("/")
      } catch {
        // Infrastructure readiness is not a rendering dependency. Keep the
        // current page usable and let a later Worker failure retry.
      } finally {
        checking = false
      }
    }

    const nativeFetch = window.fetch.bind(window)
    const monitoredFetch: typeof window.fetch = async (...args) => {
      const response = await nativeFetch(...args)
      if (response.headers.get("X-Drive-Worker-Failure") === "1") {
        window.dispatchEvent(new Event(WORKER_FAILURE_EVENT))
      }
      return response
    }
    window.fetch = monitoredFetch

    const knownSetupState = document.cookie.match(/(?:^|; )drive_setup_required=([^;]+)/)?.[1]
    if (!knownSetupState || pathname === "/setup") void inspectInBackground()
    const onWorkerFailure = () => { void inspectInBackground(true) }
    window.addEventListener(WORKER_FAILURE_EVENT, onWorkerFailure)
    return () => {
      cancelled = true
      window.removeEventListener(WORKER_FAILURE_EVENT, onWorkerFailure)
      if (window.fetch === monitoredFetch) window.fetch = nativeFetch
    }
  }, [pathname, router])

  return <>{children}</>
}

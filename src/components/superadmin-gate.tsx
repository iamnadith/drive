"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

type Props = {
  children: React.ReactNode
}

export function SuperAdminGate({ children }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const [checked, setChecked] = React.useState(false)
  const [hasSuperAdmin, setHasSuperAdmin] = React.useState<boolean | null>(null)
  const [setupRequired, setSetupRequired] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/setup/status")
        const data = await res.json()
        if (!cancelled && res.ok) {
          setHasSuperAdmin(!!data.hasSuperAdmin)
          setSetupRequired(data.setupRequired === true)
          setChecked(true)
        }
      } catch {
        if (!cancelled) {
          setHasSuperAdmin(true)
          setChecked(true)
        }
      }
    })()
    const timer = window.setInterval(() => {
      void fetch("/api/setup/status", { cache: "no-store" }).then((res) => res.json()).then((data) => {
        if (!cancelled) { setHasSuperAdmin(!!data.hasSuperAdmin); setSetupRequired(data.setupRequired === true); setChecked(true) }
      }).catch(() => undefined)
    }, 60_000)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  React.useEffect(() => {
    if (!checked || hasSuperAdmin === null) return

    // If no super admin exists, everything redirects to /setup
    if ((!hasSuperAdmin || setupRequired) && pathname !== "/setup") {
      router.replace("/setup")
      return
    }

    // If super admin exists, /setup should not be accessible
    if (hasSuperAdmin && !setupRequired && pathname === "/setup") {
      router.replace("/")
    }
  }, [checked, hasSuperAdmin, setupRequired, pathname, router])

  // While checking, or while redirecting away from /setup when no superadmin,
  // render nothing to avoid flashing other pages.
  if (!checked) {
    return null
  }

  if ((!hasSuperAdmin || setupRequired) && pathname !== "/setup") {
    return null
  }

  if (hasSuperAdmin && !setupRequired && pathname === "/setup") {
    return null
  }

  return <>{children}</>
}


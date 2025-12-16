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

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch("/api/setup/status")
        const data = await res.json()
        if (!cancelled && res.ok) {
          setHasSuperAdmin(!!data.hasSuperAdmin)
          setChecked(true)
        }
      } catch {
        if (!cancelled) {
          setHasSuperAdmin(true)
          setChecked(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  React.useEffect(() => {
    if (!checked || hasSuperAdmin === null) return

    // If no super admin exists, everything redirects to /setup
    if (!hasSuperAdmin && pathname !== "/setup") {
      router.replace("/setup")
      return
    }

    // If super admin exists, /setup should not be accessible
    if (hasSuperAdmin && pathname === "/setup") {
      router.replace("/")
    }
  }, [checked, hasSuperAdmin, pathname, router])

  // While checking, or while redirecting away from /setup when no superadmin,
  // render nothing to avoid flashing other pages.
  if (!checked) {
    return null
  }

  if (!hasSuperAdmin && pathname !== "/setup") {
    return null
  }

  if (hasSuperAdmin && pathname === "/setup") {
    return null
  }

  return <>{children}</>
}


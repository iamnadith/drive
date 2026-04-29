"use client"

import * as React from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card"
import { useAuth } from "@/components/auth-provider"
import { HardDrive, Shield, Users, LogOut } from "lucide-react"
import { toast } from "sonner"

export default function HomePage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading, setUserDirect } = useAuth()

  const forbidden = searchParams.get("forbidden")

  const [shownForbiddenToast, setShownForbiddenToast] = React.useState(false)
  const [needsSuperAdmin, setNeedsSuperAdmin] = React.useState(false)

  React.useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch("/api/setup/status")
        const data = await res.json()
        if (res.ok) {
          setNeedsSuperAdmin(!data.hasSuperAdmin)
        }
      } catch {
        // ignore; if this fails we just don't show the prompt
      }
    })()
  }, [])

  React.useEffect(() => {
    if (loading) return
    if (forbidden === "dashboard" && !shownForbiddenToast) {
      if (!user || (user.role !== "admin" && user.role !== "superadmin")) {
        toast.error(
          "Only admin or super admin users can access the dashboard"
        )
      }
      setShownForbiddenToast(true)
      router.replace("/")
    }
  }, [forbidden, shownForbiddenToast, user, loading, router])

  const handleDashboardClick = () => {
    if (!user) {
      router.push("/login?redirect=/dashboard/overview")
      return
    }
    router.push("/dashboard/overview")
  }

  return (
    <main className="flex min-h-svh min-w-0 items-center justify-center bg-[radial-gradient(circle_at_top,var(--muted),transparent_34rem)] p-4 sm:p-6">
      <Card className="w-full max-w-2xl rounded-3xl">
        <CardHeader className="space-y-4 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
            <HardDrive className="h-6 w-6 text-primary" />
          </div>
          <div className="space-y-2">
            <CardTitle className="text-balance text-2xl font-bold tracking-tight sm:text-3xl">
              Cloud Storage Panel
            </CardTitle>
            <CardDescription className="text-pretty text-base">
              Secure, role-based control panel for your R2 storage and migrations.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {needsSuperAdmin && !user && (
            <div className="rounded-2xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <p className="font-medium">Super admin required</p>
              <p className="mt-1 text-xs text-destructive/80">
                No super admin account exists yet. Create a super admin user to
                manage this panel.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => router.push("/signup")}
                >
                  Create super admin
                </Button>
              </div>
            </div>
          )}
          <>
              <div className="grid w-full gap-3 sm:grid-cols-3">
                {!user && (
                  <>
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => router.push("/login")}
                    >
                      Log in
                    </Button>
                    <Button
                      className="w-full"
                      onClick={() => router.push("/signup")}
                    >
                      Sign up
                    </Button>
                  </>
                )}
                {user && (user.role === "admin" || user.role === "superadmin") && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={handleDashboardClick}
                  >
                    Overview
                  </Button>
                )}
                {user && (
                  <Button
                    variant="outline"
                    className="w-full flex items-center justify-center gap-2"
                    onClick={async () => {
      // Client-only logout; session is stored in localStorage
      setUserDirect(null)
                      router.push("/")
                    }}
                  >
                    <LogOut className="h-4 w-4" />
                    Logout
                  </Button>
                )}
              </div>
              <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
                <div className="min-w-0 rounded-2xl border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                  <Shield className="mt-0.5 h-4 w-4 text-primary" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">Role-based access</p>
                    <p>Only admin and super admin users can see and open the dashboard.</p>
                  </div>
                  </div>
                </div>
                <div className="min-w-0 rounded-2xl border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                  <Users className="mt-0.5 h-4 w-4 text-primary" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">User accounts</p>
                    <p>Sign up with email and password, then manage your profile.</p>
                  </div>
                  </div>
                </div>
                <div className="min-w-0 rounded-2xl border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                  <HardDrive className="mt-0.5 h-4 w-4 text-primary" />
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">Admin tools</p>
                    <p>Admins and super admins can manage users, quotas and storage in the dashboard.</p>
                  </div>
                  </div>
                </div>
              </div>
            </>
        </CardContent>
      </Card>
    </main>
  )
}

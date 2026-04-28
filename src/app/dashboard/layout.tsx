"use client"

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar"
import { AppSidebar } from "@/components/app-sidebar"
import { Separator } from "@/components/ui/separator"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { useAuth } from "@/components/auth-provider"

type Crumb = { label: string; href?: string }

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()
  const router = useRouter()
  const { user, loading } = useAuth()

  const crumbs = React.useMemo<Crumb[]>(() => {
    const base: Crumb[] = [{ label: "Dashboard", href: "/dashboard/overview" }]
    if (!pathname) return [...base, { label: "Overview" }]

    if (pathname === "/dashboard" || pathname.startsWith("/dashboard/overview")) {
      return [...base, { label: "Overview" }]
    }

    if (pathname.startsWith("/dashboard/analytics")) {
      return [...base, { label: "Analytics" }]
    }

    if (pathname.startsWith("/dashboard/activity")) {
      return [...base, { label: "Activity" }]
    }

    if (pathname.startsWith("/dashboard/storage")) {
      return [...base, { label: "Storage" }]
    }

    if (pathname.startsWith("/dashboard/accounts")) {
      return [...base, { label: "Accounts" }]
    }

    if (pathname.startsWith("/dashboard/users")) {
      return [...base, { label: "Users" }]
    }

    if (pathname.startsWith("/dashboard/migrations")) {
      const parts = pathname.split("/").filter(Boolean)
      const sub = parts[2] ?? ""

      if (!sub) {
        return [...base, { label: "Migrations" }]
      }

      if (sub === "history") {
        return [...base, { label: "Migrations", href: "/dashboard/migrations" }, { label: "History" }]
      }

      // /dashboard/migrations/[id]
      return [...base, { label: "Migrations", href: "/dashboard/migrations" }, { label: sub }]
    }

    if (pathname.startsWith("/dashboard/agents") || pathname.startsWith("/dashboard/workers")) {
      return [...base, { label: "Workers" }]
    }

    return [...base, { label: "Dashboard" }]
  }, [pathname])

  React.useEffect(() => {
    if (loading) return
    if (!user || user.role === "user") {
      router.replace("/?forbidden=dashboard")
    }
  }, [user, loading, router])

  if (loading || !user || user.role === "user") {
    return null
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 transition-[width,height] ease-linear group-has-[[data-collapsible=icon]]/sidebar-wrapper:h-12">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 h-4" />
            <Breadcrumb>
              <BreadcrumbList>
                {crumbs.map((c, index) => {
                  const isLast = index === crumbs.length - 1
                  return (
                    <React.Fragment key={`${c.label}-${index}`}>
                      {index > 0 ? <BreadcrumbSeparator className="hidden md:block" /> : null}
                      <BreadcrumbItem className={index === 0 ? "hidden md:block" : undefined}>
                        {isLast || !c.href ? (
                          <BreadcrumbPage>{c.label}</BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink href={c.href}>{c.label}</BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </React.Fragment>
                  )
                })}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4 pt-4">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}

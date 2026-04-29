import * as React from "react"

import { cn } from "@/lib/utils"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

function DashboardPage({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dashboard-page"
      className={cn("min-w-0 space-y-4 sm:space-y-5", className)}
      {...props}
    />
  )
}

function DashboardPageHeader({
  actions,
  children,
  className,
  description,
  title,
}: {
  actions?: React.ReactNode
  children?: React.ReactNode
  className?: string
  description?: React.ReactNode
  title: React.ReactNode
}) {
  return (
    <div
      data-slot="dashboard-page-header"
      className={cn(
        "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-balance text-xl font-semibold tracking-tight sm:text-2xl">
          {title}
        </h1>
        {description ? (
          <p className="mt-1 max-w-3xl text-pretty text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        {children}
      </div>
      {actions ? <DashboardActions>{actions}</DashboardActions> : null}
    </div>
  )
}

function DashboardActions({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dashboard-actions"
      className={cn(
        "flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end [&_[data-slot=button]]:h-9",
        className
      )}
      {...props}
    />
  )
}

function DashboardFilterGrid({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dashboard-filter-grid"
      className={cn(
        "grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_repeat(4,minmax(140px,0.65fr))]",
        className
      )}
      {...props}
    />
  )
}

function DashboardPanel({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dashboard-panel"
      className={cn("min-w-0 overflow-hidden rounded-3xl border bg-card", className)}
      {...props}
    />
  )
}

function DashboardPageSkeleton({
  cards = 4,
  rows = 6,
}: {
  cards?: number
  rows?: number
}) {
  return (
    <DashboardPage>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-[min(32rem,80vw)]" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: cards }).map((_, index) => (
          <Card key={index}>
            <CardHeader className="space-y-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: rows }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </DashboardPage>
  )
}

export {
  DashboardActions,
  DashboardFilterGrid,
  DashboardPage,
  DashboardPageHeader,
  DashboardPageSkeleton,
  DashboardPanel,
}

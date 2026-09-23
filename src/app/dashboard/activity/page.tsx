"use client"

import * as React from "react"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { DashboardActivitySkeleton } from "@/components/dashboard/loading-skeletons"
import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell"
import { DashboardSearchFilterToolbar, type SearchFilterOption } from "@/components/dashboard/search-filter-toolbar"
import { formatLastSyncedAt } from "@/lib/dashboard-format"
import { useDashboardResource } from "@/hooks/use-dashboard-resource"

type ActivityEvent = {
  id: string
  occurredAt: string
  actorUserId?: string
  actorName?: string
  actorEmail?: string
  actorRole?: string
  action: string
  entityType: string
  entityId?: string
  entityLabel?: string
  summary: string
  detail?: string
  outcome: "success" | "failed" | "warning" | "info"
  ipAddress?: string
  requestId?: string
  userAgent?: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  metadata?: Record<string, unknown>
  undoable: boolean
  undoStatus: "not_undoable" | "available" | "undone" | "expired" | "failed"
  undoReason?: string
}

type ActivityResponse = {
  events: ActivityEvent[]
  facets?: { actions: string[]; entityTypes: string[] }
  nextCursor: string | null
  hasMore: boolean
  totalCount: number
  totalPages: number
  generatedAt: string
}

const ALL = "__all__"
const pageSizeOptions = [25, 50, 100]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatRelative(value?: string | null): string {
  if (!value) return "Never"
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return "Unknown"
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function formatDateTime(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatAction(value: string): string {
  return value
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function outcomeVariant(outcome: ActivityEvent["outcome"]): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "failed") return "destructive"
  if (outcome === "success") return "default"
  if (outcome === "warning") return "secondary"
  return "outline"
}

function undoLabel(event: ActivityEvent) {
  if (event.undoStatus === "available") return "Undo available"
  if (event.undoStatus === "undone") return "Undone"
  if (event.undoStatus === "failed") return "Undo failed"
  if (event.undoStatus === "expired") return "Undo expired"
  return "Locked"
}

function compactJson(value: unknown): string {
  if (!isRecord(value)) return "None"
  return JSON.stringify(value, null, 2)
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words text-sm">{value}</dd>
    </div>
  )
}

export default function ActivityPage() {
  const [selected, setSelected] = React.useState<ActivityEvent | null>(null)
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [undoConfirmation, setUndoConfirmation] = React.useState<ActivityEvent | null>(null)
  const [activeRowId, setActiveRowId] = React.useState<string | null>(null)
  const [undoingId, setUndoingId] = React.useState<string | null>(null)
  const [cursorStack, setCursorStack] = React.useState<string[]>([])
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [filters, setFilters] = React.useState({
    q: "",
    action: ALL,
    entityType: ALL,
    outcome: ALL,
    undoable: ALL,
    from: "",
    to: "",
    limit: 25,
  })
  const deferredQuery = React.useDeferredValue(filters.q.trim())
  const clearSelectedTimeoutRef = React.useRef<number | null>(null)

  const clearSelectedCleanup = React.useCallback(() => {
    if (clearSelectedTimeoutRef.current === null) return
    window.clearTimeout(clearSelectedTimeoutRef.current)
    clearSelectedTimeoutRef.current = null
  }, [])

  React.useEffect(() => {
    if (detailOpen && selected) {
      setActiveRowId(selected.id)
      return
    }

    if (!activeRowId) return

    const timeout = window.setTimeout(() => {
      setActiveRowId((current) => (current === activeRowId ? null : current))
    }, 220)

    return () => window.clearTimeout(timeout)
  }, [activeRowId, detailOpen, selected])

  React.useEffect(() => {
    clearSelectedCleanup()
    if (detailOpen || !selected) return

    clearSelectedTimeoutRef.current = window.setTimeout(() => {
      setSelected((current) => (current?.id === selected.id ? null : current))
      clearSelectedTimeoutRef.current = null
    }, 220)

    return () => clearSelectedCleanup()
  }, [clearSelectedCleanup, detailOpen, selected])

  React.useEffect(() => {
    return () => {
      clearSelectedCleanup()
    }
  }, [clearSelectedCleanup])

  const queryString = React.useMemo(() => {
    const params = new URLSearchParams()
    params.set("limit", String(filters.limit))
    if (cursor) params.set("cursor", cursor)
    if (deferredQuery) params.set("q", deferredQuery)
    if (filters.action !== ALL) params.set("action", filters.action)
    if (filters.entityType !== ALL) params.set("entityType", filters.entityType)
    if (filters.outcome !== ALL) params.set("outcome", filters.outcome)
    if (filters.undoable !== ALL) params.set("undoable", filters.undoable)
    if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`)
    if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`)
    return params.toString()
  }, [cursor, deferredQuery, filters.action, filters.entityType, filters.from, filters.limit, filters.outcome, filters.to, filters.undoable])

  const {
    data,
    error,
    loading,
    refreshing,
    refresh,
  } = useDashboardResource<ActivityResponse>({
    key: `dashboard-activity:${queryString}`,
    refreshIntervalMs: 20_000,
    staleTimeMs: 8_000,
    fetcher: async ({ signal }) => {
      const res = await fetch(`/api/activity?${queryString}`, {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load activity"
        throw new Error(message)
      }
      return json as ActivityResponse
    },
  })

  const resetPagination = React.useCallback(() => {
    setCursor(null)
    setCursorStack([])
  }, [])

  const updateFilter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => {
    resetPagination()
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const resetFilters = () => {
    resetPagination()
    setFilters({ q: "", action: ALL, entityType: ALL, outcome: ALL, undoable: ALL, from: "", to: "", limit: 25 })
  }

  const undoActivity = async (event: ActivityEvent) => {
    setUndoingId(event.id)
    try {
      const res = await fetch(`/api/activity/${event.id}/undo`, { method: "POST" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to undo activity"
        throw new Error(message)
      }
      toast.success("Undo completed")
      setSelected((current) => current?.id === event.id
        ? { ...current, undoable: false, undoStatus: "undone", undoReason: "This activity has already been undone." }
        : current)
      await refresh({ background: true, force: true })
    } catch (caught) {
      const message =
        typeof caught === "object" && caught !== null && "message" in caught
          ? String((caught as { message?: unknown }).message ?? "Undo failed")
          : "Undo failed"
      toast.error(message)
    } finally {
      setUndoingId(null)
    }
  }

  const events = data?.events ?? []
  const actions = data?.facets?.actions ?? Array.from(new Set(events.map((event) => event.action))).sort()
  const entityTypes = data?.facets?.entityTypes ?? Array.from(new Set(events.map((event) => event.entityType))).sort()
  const activityFilters: SearchFilterOption[] = [
    { key: "action", label: "Action", type: "select", defaultValue: ALL, options: [{ value: ALL, label: "All actions" }, ...actions.map((action) => ({ value: action, label: formatAction(action) }))] },
    { key: "entityType", label: "Entity", type: "select", defaultValue: ALL, options: [{ value: ALL, label: "All entities" }, ...entityTypes.map((entity) => ({ value: entity, label: formatAction(entity) }))] },
    { key: "outcome", label: "Status", type: "select", defaultValue: ALL, options: [
      { value: ALL, label: "All statuses" },
      { value: "success", label: "Success" },
      { value: "failed", label: "Failed" },
      { value: "warning", label: "Warning" },
      { value: "info", label: "Info" },
    ] },
    { key: "undoable", label: "Undo", type: "select", defaultValue: ALL, options: [
      { value: ALL, label: "All undo states" },
      { value: "true", label: "Undo available" },
      { value: "false", label: "Locked" },
    ] },
    { key: "limit", label: "Results per page", type: "select", defaultValue: "25", options: pageSizeOptions.map((size) => ({ value: String(size), label: `${size} per page` })) },
    { key: "from", label: "From date", type: "date", defaultValue: "" },
    { key: "to", label: "To date", type: "date", defaultValue: "" },
  ]
  const currentPage = cursorStack.length + 1
  const totalPages = Math.max(1, data?.totalPages ?? 1)
  const totalCount = Math.max(0, data?.totalCount ?? 0)
  const activeFilterCount = [
    filters.q.trim(),
    filters.action !== ALL,
    filters.entityType !== ALL,
    filters.outcome !== ALL,
    filters.undoable !== ALL,
    filters.from,
    filters.to,
  ].filter(Boolean).length

  if (loading && !data) {
    return <DashboardActivitySkeleton />
  }

  const goToPage = (page: number) => {
    if (page < 1 || page === currentPage) return
    if (page === 1) {
      setCursor(null)
      setCursorStack([])
      return
    }
    const nextStack = cursorStack.slice(0, page - 1)
    setCursorStack(nextStack)
    setCursor(nextStack[page - 2] ?? null)
  }

  const getVisiblePages = (maxButtons: number) => {
    if (totalPages <= maxButtons) {
      return Array.from({ length: totalPages }, (_, index) => index + 1)
    }
    let start = Math.max(1, currentPage - Math.floor((maxButtons - 1) / 2))
    let end = start + maxButtons - 1
    if (end > totalPages) {
      end = totalPages
      start = Math.max(1, end - maxButtons + 1)
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index)
  }

  const mobilePages = getVisiblePages(3)
  const desktopPages = getVisiblePages(5)
  const recordsLabel = `${totalCount} Record${totalCount === 1 ? "" : "s"}`

  const goToNextPage = () => {
    if (!data?.nextCursor) return
    setCursorStack((stack) => [...stack, data.nextCursor!])
    setCursor(data.nextCursor)
  }

  return (
    <DashboardPage className="dashboard-motion-stage">
      <DashboardPageHeader
        className="dashboard-motion-item"
        title="Activity"
        description={formatLastSyncedAt(data?.generatedAt)}
        actions={
          <DashboardSearchFilterToolbar
            searchValue={filters.q}
            onSearchChange={(value) => updateFilter("q", value)}
            searchPlaceholder="Search"
            onRefresh={() => void refresh({ background: true, force: true })}
            refreshing={refreshing}
            refreshLabel="Sync activity"
            countSearch
            filters={activityFilters}
            filterValues={{
              action: filters.action,
              entityType: filters.entityType,
              outcome: filters.outcome,
              undoable: filters.undoable,
              limit: String(filters.limit),
              from: filters.from,
              to: filters.to,
            }}
            onFilterChange={(key, value) => {
              if (key === "action") updateFilter("action", value)
              else if (key === "entityType") updateFilter("entityType", value)
              else if (key === "outcome") updateFilter("outcome", value)
              else if (key === "undoable") updateFilter("undoable", value)
              else if (key === "limit") updateFilter("limit", Number(value))
              else if (key === "from") updateFilter("from", value)
              else if (key === "to") updateFilter("to", value)
            }}
            onClear={resetFilters}
            title="Activity filters"
            description="Narrow activity by action, entity, status, undo state, date, and page size."
          />
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Activity refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="dashboard-motion-item dashboard-motion-delay-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="text-sm font-medium text-muted-foreground">{recordsLabel}</div>
          {activeFilterCount > 0 ? (
            <Button variant="outline" size="sm" onClick={resetFilters}>
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 py-0">
        <CardContent className="p-0">
          {loading && !data ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-16 w-full" />
              ))}
            </div>
          ) : events.length === 0 ? (
            <div className="flex min-h-64 items-center justify-center p-6 text-sm text-muted-foreground">
              No matching activity.
            </div>
          ) : (
            <ul className="divide-y">
              {events.map((event, index) => (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => {
                      clearSelectedCleanup()
                      setActiveRowId(event.id)
                      setSelected(event)
                      setDetailOpen(true)
                    }}
                    className={`group block w-full px-4 pt-2.5 pb-0 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset md:px-0 md:pt-3 md:pb-3 ${
                      index === events.length - 1 ? "-mb-4 md:mb-0" : ""
                    } ${
                      activeRowId === event.id
                        ? "bg-primary/[0.085] shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.4),inset_3px_0_0_hsl(var(--primary)/0.9)]"
                        : ""
                    }`}
                  >
                    <div className="grid gap-3 xl:grid-cols-[148px_minmax(0,1fr)_196px_auto] xl:items-start">
                      <div className="text-sm">
                        <div className="flex items-center justify-between gap-3 xl:block">
                          <div>
                            <div className="font-medium text-foreground">{formatRelative(event.occurredAt)}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</div>
                          </div>
                          <div className="flex flex-wrap gap-2 xl:hidden">
                            <Badge variant={outcomeVariant(event.outcome)}>{event.outcome}</Badge>
                            {event.undoStatus !== "available" ? (
                              <Badge variant="outline">{undoLabel(event)}</Badge>
                            ) : null}
                          </div>
                        </div>
                        <div className="mt-2 hidden text-[11px] uppercase tracking-[0.16em] text-muted-foreground xl:block">
                          {formatAction(event.action)}
                        </div>
                      </div>

                      <div className="min-w-0">
                        <div className="text-sm font-medium leading-5">{event.summary}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          <span className="truncate">{event.entityLabel ?? event.entityType}</span>
                          <span className="hidden xl:inline">/</span>
                          <span className="truncate">{event.actorName ?? "System"}</span>
                        </div>
                        {event.detail ? (
                          <div className="mt-1 line-clamp-2 text-xs leading-4.5 text-muted-foreground">
                            {event.detail}
                          </div>
                        ) : null}
                        <div className="mt-0 flex items-center justify-between gap-1.5 xl:hidden">
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-4 text-muted-foreground">
                            <span>{formatAction(event.action)}</span>
                            <span>•</span>
                            <span className="truncate">{event.actorEmail ?? event.ipAddress ?? "Background process"}</span>
                          </div>
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent text-muted-foreground/80 transition-[transform,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:border-border/55 group-hover:bg-muted/45 group-hover:text-foreground group-focus-visible:border-border/55 group-focus-visible:bg-muted/45 group-focus-visible:text-foreground group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5">
                            <ChevronRight className="h-3.5 w-3.5" />
                          </span>
                        </div>
                      </div>

                      <div className="hidden min-w-0 text-sm xl:block">
                        <div className="truncate font-medium">{event.actorName ?? "System"}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {event.actorEmail ?? event.ipAddress ?? "Background process"}
                        </div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {formatAction(event.action)} / {event.entityType}
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 xl:flex-col xl:items-end xl:justify-start">
                        <div className="hidden flex-wrap justify-end gap-2 xl:flex">
                          <Badge variant={outcomeVariant(event.outcome)}>{event.outcome}</Badge>
                          {event.undoStatus !== "available" ? (
                            <Badge variant="outline">{undoLabel(event)}</Badge>
                          ) : null}
                        </div>
                        <div className="hidden xl:flex xl:justify-end">
                          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-transparent bg-transparent text-muted-foreground/80 transition-[transform,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:border-border/55 group-hover:bg-muted/45 group-hover:text-foreground group-focus-visible:border-border/55 group-focus-visible:bg-muted/45 group-focus-visible:text-foreground group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5">
                            <ChevronRight className="h-4 w-4" />
                          </span>
                        </div>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>

        <div className="border-t px-4 pb-4 pt-2.5 md:p-4">
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="justify-self-start">
              <button
                type="button"
                disabled={currentPage === 1 || loading}
                onClick={() => {
                  goToPage(currentPage - 1)
                }}
                aria-label="Previous page"
                className="flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-full border border-border/60 bg-background/80 p-0 text-muted-foreground shadow-sm backdrop-blur-sm transition-[border-color,background-color,color,box-shadow,opacity] hover:border-border hover:bg-muted/50 hover:text-foreground hover:shadow-md disabled:pointer-events-none disabled:opacity-50 md:hidden"
              >
                <span className="flex h-full w-full items-center justify-center">
                  <ChevronLeft className="block h-[0.9rem] w-[0.9rem] shrink-0 stroke-[2.35]" />
                </span>
              </button>
              <Button
                variant="outline"
                disabled={currentPage === 1 || loading}
                onClick={() => {
                  goToPage(currentPage - 1)
                }}
                className="hidden justify-self-start md:inline-flex md:h-9 md:min-w-0 md:rounded-full md:px-3 border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
                aria-label="Previous page"
              >
                <ChevronLeft className="h-4 w-4" />
                <span>Previous</span>
              </Button>
            </div>
            <div className="justify-self-center">
              <div className="flex items-center justify-center gap-1.5 md:hidden">
                {mobilePages.map((page) => (
                  page === currentPage ? (
                    <button
                      key={`mobile-${page}`}
                      type="button"
                      aria-current="page"
                      disabled
                      className="flex h-8 w-8 min-h-8 min-w-8 max-h-8 max-w-8 shrink-0 items-center justify-center rounded-full border border-white bg-white p-0 text-sm font-medium leading-none text-black opacity-100"
                    >
                      {page}
                    </button>
                  ) : (
                    <Button
                      key={`mobile-${page}`}
                      variant="outline"
                      disabled={loading}
                      onClick={() => (page === currentPage + 1 && data?.nextCursor ? goToNextPage() : goToPage(page))}
                      className="h-8 w-8 min-h-8 min-w-8 max-h-8 max-w-8 shrink-0 rounded-full [border-radius:9999px] border border-border/70 bg-background/85 p-0 text-center text-sm font-medium leading-none shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
                    >
                      {page}
                    </Button>
                  )
                ))}
              </div>
              <div className="hidden items-center justify-center gap-1.5 md:flex">
                {desktopPages.map((page) => (
                  page === currentPage ? (
                    <button
                      key={`desktop-${page}`}
                      type="button"
                      aria-current="page"
                      disabled
                      className="flex h-8 w-8 min-h-8 min-w-8 max-h-8 max-w-8 shrink-0 items-center justify-center rounded-full border border-white bg-white p-0 text-sm font-medium leading-none text-black opacity-100"
                    >
                      {page}
                    </button>
                  ) : (
                    <Button
                      key={`desktop-${page}`}
                      variant="outline"
                      disabled={loading}
                      onClick={() => (page === currentPage + 1 && data?.nextCursor ? goToNextPage() : goToPage(page))}
                      className="h-8 w-8 min-h-8 min-w-8 max-h-8 max-w-8 shrink-0 rounded-full [border-radius:9999px] border border-border/70 bg-background/85 p-0 text-center text-sm font-medium leading-none shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
                    >
                      {page}
                    </Button>
                  )
                ))}
              </div>
            </div>
            <div className="justify-self-end">
              <button
                type="button"
                disabled={!data?.nextCursor || loading}
                onClick={() => {
                  if (!data?.nextCursor) return
                  setCursorStack((stack) => [...stack, data.nextCursor!])
                  setCursor(data.nextCursor)
                }}
                aria-label="Next page"
                className="flex h-8 w-8 min-h-8 min-w-8 items-center justify-center rounded-full border border-border/60 bg-background/80 p-0 text-muted-foreground shadow-sm backdrop-blur-sm transition-[border-color,background-color,color,box-shadow,opacity] hover:border-border hover:bg-muted/50 hover:text-foreground hover:shadow-md disabled:pointer-events-none disabled:opacity-50 md:hidden"
              >
                <span className="flex h-full w-full items-center justify-center">
                  <ChevronRight className="block h-[0.9rem] w-[0.9rem] shrink-0 stroke-[2.35]" />
                </span>
              </button>
              <Button
                variant="outline"
                disabled={!data?.nextCursor || loading}
                onClick={() => {
                  if (!data?.nextCursor) return
                  setCursorStack((stack) => [...stack, data.nextCursor!])
                  setCursor(data.nextCursor)
                }}
                className="hidden justify-self-end md:inline-flex md:h-9 md:min-w-0 md:rounded-full md:px-3 border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
                aria-label="Next page"
              >
                <span>Next</span>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </Card>

      <Dialog
        open={detailOpen}
        onOpenChange={(open) => {
          clearSelectedCleanup()
          if (open) {
            if (selected) setActiveRowId(selected.id)
            setDetailOpen(true)
            return
          }
          setDetailOpen(false)
        }}
      >
        {selected ? (
          <DialogContent className="flex max-h-[min(88dvh,52rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0">
            <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
              <DialogHeader className="gap-3 pr-8">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{formatAction(selected.action)}</Badge>
                  <Badge variant={outcomeVariant(selected.outcome)}>{formatAction(selected.outcome)}</Badge>
                  <Badge variant="secondary">{formatAction(selected.entityType)}</Badge>
                </div>
                <div className="grid gap-1">
                  <DialogTitle className="text-xl">{selected.summary}</DialogTitle>
                  <DialogDescription>
                    {formatDateTime(selected.occurredAt)} · {formatRelative(selected.occurredAt)}
                  </DialogDescription>
                </div>
              </DialogHeader>

              <div className="mt-5 rounded-lg border bg-card p-4">
                <h3 className="text-sm font-medium">Activity details</h3>
                {selected.detail ? (
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{selected.detail}</p>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">No additional description was recorded.</p>
                )}
              </div>

              <section className="mt-5">
                <h3 className="text-sm font-medium">Who and what</h3>
                <dl className="mt-3 grid gap-x-6 gap-y-4 rounded-lg border bg-card p-4 sm:grid-cols-2">
                  <DetailRow label="User" value={selected.actorName ?? "System or worker"} />
                  <DetailRow label="Email" value={selected.actorEmail ?? "Not recorded"} />
                  <DetailRow label="Role" value={selected.actorRole ?? "Not recorded"} />
                  <DetailRow label="Entity" value={selected.entityLabel ?? selected.entityType} />
                  <DetailRow label="Entity ID" value={selected.entityId ?? "Not recorded"} />
                  <DetailRow label="IP address" value={selected.ipAddress ?? "Not recorded"} />
                  <DetailRow label="Request ID" value={selected.requestId ?? "Not recorded"} />
                  <DetailRow label="User agent" value={selected.userAgent ?? "Not recorded"} />
                </dl>
              </section>

              <section className="mt-5">
                <h3 className="text-sm font-medium">Change record</h3>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div className="min-w-0 rounded-lg border bg-card p-4">
                    <p className="text-sm font-medium">Before</p>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">{compactJson(selected.before)}</pre>
                  </div>
                  <div className="min-w-0 rounded-lg border bg-card p-4">
                    <p className="text-sm font-medium">After</p>
                    <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">{compactJson(selected.after)}</pre>
                  </div>
                </div>
              </section>

              {selected.metadata && Object.keys(selected.metadata).length > 0 ? (
                <section className="mt-5">
                  <h3 className="text-sm font-medium">Additional context</h3>
                  <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">{compactJson(selected.metadata)}</pre>
                </section>
              ) : null}

              <section className="mt-5 rounded-lg border bg-muted/20 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Undo</h3>
                  <Badge variant={selected.undoStatus === "available" ? "secondary" : "outline"}>{undoLabel(selected)}</Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {selected.undoReason ?? (selected.undoStatus === "available"
                    ? "This change can be reversed while its current state still matches the recorded change."
                    : "No safe undo action is available for this activity.")}
                </p>
              </section>
            </div>

            <Separator />
            <DialogFooter className="p-4 sm:px-6">
              {selected.undoStatus === "available" ? (
                <Button
                  variant="destructive"
                  disabled={undoingId === selected.id}
                  onClick={() => setUndoConfirmation(selected)}
                >
                  <RotateCcw data-icon="inline-start" />
                  Undo change
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setDetailOpen(false)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        ) : null}
      </Dialog>

      <AlertDialog open={Boolean(undoConfirmation)} onOpenChange={(open) => !open && setUndoConfirmation(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this activity?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoConfirmation?.action === "migration.created"
                ? "This permanently removes the draft migration and its bucket rows. This cannot be undone."
                : "This will reverse the recorded change if the current data still matches the state required for a safe undo."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(undoingId)}>Keep change</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={Boolean(undoingId)}
              onClick={(event) => {
                event.preventDefault()
                if (!undoConfirmation) return
                const eventToUndo = undoConfirmation
                setUndoConfirmation(null)
                void undoActivity(eventToUndo)
              }}
            >
              Confirm undo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DashboardPage>
  )
}


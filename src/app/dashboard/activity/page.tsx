"use client"

import * as React from "react"
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { DashboardActivitySkeleton } from "@/components/dashboard/loading-skeletons"
import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell"
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
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  metadata?: Record<string, unknown>
  undoable: boolean
  undoStatus: "not_undoable" | "available" | "undone" | "expired" | "failed"
  undoReason?: string
}

type ActivityResponse = {
  events: ActivityEvent[]
  nextCursor: string | null
  hasMore: boolean
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
  const [filtersOpen, setFiltersOpen] = React.useState(false)
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
  const actions = Array.from(new Set(events.map((event) => event.action))).sort()
  const entityTypes = Array.from(new Set(events.map((event) => event.entityType))).sort()
  const currentPage = cursorStack.length + 1
  const totalKnownPages = currentPage + (data?.nextCursor ? 1 : 0)
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
    if (totalKnownPages <= maxButtons) {
      return Array.from({ length: totalKnownPages }, (_, index) => index + 1)
    }
    let start = Math.max(1, currentPage - Math.floor((maxButtons - 1) / 2))
    let end = start + maxButtons - 1
    if (end > totalKnownPages) {
      end = totalKnownPages
      start = Math.max(1, end - maxButtons + 1)
    }
    return Array.from({ length: end - start + 1 }, (_, index) => start + index)
  }

  const mobilePages = getVisiblePages(3)
  const desktopPages = getVisiblePages(5)

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
        description={
          <>
            Recent user and system activity. Last refreshed{" "}
            {formatRelative(data?.generatedAt)}.
          </>
        }
        actions={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-[320px] sm:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filters.q}
                onChange={(event) => updateFilter("q", event.target.value)}
                placeholder="Search"
                className="h-10 pl-9"
              />
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setFiltersOpen(true)}
              aria-label="Open filters"
              className="h-10 min-h-10 w-10 min-w-10 shrink-0 aspect-square rounded-full [border-radius:9999px] p-0 border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
            >
              <SlidersHorizontal className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void refresh({ background: true, force: true })}
              disabled={refreshing}
              aria-busy={refreshing || undefined}
              className="h-10 min-h-10 w-10 min-w-10 shrink-0 aspect-square rounded-full [border-radius:9999px] p-0 border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
            >
              {refreshing ? <Spinner className="size-4" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
          </div>
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
          <Badge variant={activeFilterCount ? "secondary" : "outline"}>{activeFilterCount} active</Badge>
          {activeFilterCount > 0 ? (
            <Button variant="outline" size="sm" onClick={resetFilters}>
              <X className="h-4 w-4" />
              Clear
            </Button>
          ) : null}
        </div>
        <div className="shrink-0 text-sm text-muted-foreground">Page {cursorStack.length + 1} / {events.length} shown</div>
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
              {events.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(event)}
                    className={`group block w-full px-4 py-2.5 text-left transition-[background-color,border-color,box-shadow,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset md:px-0 md:py-3 ${
                      selected?.id === event.id ? "bg-muted/45 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.65)]" : ""
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
                        <div className="mt-1.5 flex items-center justify-between gap-2 xl:hidden">
                          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{formatAction(event.action)}</span>
                            <span>•</span>
                            <span className="truncate">{event.actorEmail ?? event.ipAddress ?? "Background process"}</span>
                          </div>
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-transparent bg-transparent text-muted-foreground/80 transition-[transform,background-color,border-color,color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:border-border/55 group-hover:bg-muted/45 group-hover:text-foreground group-focus-visible:border-border/55 group-focus-visible:bg-muted/45 group-focus-visible:text-foreground group-hover:translate-x-0.5 group-focus-visible:translate-x-0.5">
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

        <div className="border-t p-4">
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
            <Button
              variant="outline"
              disabled={currentPage === 1 || loading}
              onClick={() => {
                goToPage(currentPage - 1)
              }}
              className="justify-self-start border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
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
            <Button
              variant="outline"
              disabled={!data?.nextCursor || loading}
              onClick={() => {
                if (!data?.nextCursor) return
                setCursorStack((stack) => [...stack, data.nextCursor!])
                setCursor(data.nextCursor)
              }}
              className="justify-self-end border border-border/70 bg-background/85 shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Filters</DialogTitle>
            <DialogDescription>
              Narrow the activity stream by action, entity, status, undo state, date, and page size.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Select value={filters.action} onValueChange={(value) => updateFilter("action", value)}>
              <SelectTrigger className="h-10 w-full">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {actions.map((action) => (
                  <SelectItem key={action} value={action}>{formatAction(action)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filters.entityType} onValueChange={(value) => updateFilter("entityType", value)}>
              <SelectTrigger className="h-10 w-full">
                <SelectValue placeholder="Entity" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All entities</SelectItem>
                {entityTypes.map((entity) => (
                  <SelectItem key={entity} value={entity}>{formatAction(entity)}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={filters.outcome} onValueChange={(value) => updateFilter("outcome", value)}>
              <SelectTrigger className="h-10 w-full">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
                <SelectItem value="info">Info</SelectItem>
              </SelectContent>
            </Select>

            <Select value={filters.undoable} onValueChange={(value) => updateFilter("undoable", value)}>
              <SelectTrigger className="h-10 w-full">
                <SelectValue placeholder="Undo" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All undo states</SelectItem>
                <SelectItem value="true">Undo available</SelectItem>
                <SelectItem value="false">Locked</SelectItem>
              </SelectContent>
            </Select>

            <Select value={String(filters.limit)} onValueChange={(value) => updateFilter("limit", Number(value))}>
              <SelectTrigger className="h-10 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>{size} per page</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative">
              <CalendarDays className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                aria-label="Activity from date"
                type="date"
                value={filters.from}
                onChange={(event) => updateFilter("from", event.target.value)}
                className="h-10 pl-9"
              />
            </div>

            <Input
              aria-label="Activity to date"
              type="date"
              value={filters.to}
              onChange={(event) => updateFilter("to", event.target.value)}
              className="h-10"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetFilters}>
              <X className="h-4 w-4" />
              Clear
            </Button>
            <Button onClick={() => setFiltersOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto duration-300 data-[state=closed]:slide-out-to-bottom-2 data-[state=closed]:zoom-out-[0.985] data-[state=open]:slide-in-from-bottom-3 data-[state=open]:zoom-in-[0.985] sm:max-w-3xl">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>{selected.summary}</DialogTitle>
                <DialogDescription>
                  {formatAction(selected.action)} / {formatDateTime(selected.occurredAt)}
                </DialogDescription>
              </DialogHeader>

              <dl className="grid gap-3 sm:grid-cols-2">
                <DetailRow label="Actor" value={selected.actorName ?? "System"} />
                <DetailRow label="Contact" value={selected.actorEmail ?? selected.ipAddress ?? "Background process"} />
                <DetailRow label="Entity" value={selected.entityLabel ?? selected.entityType} />
                <DetailRow label="Entity type" value={selected.entityType} />
                <DetailRow label="Status" value={<Badge variant={outcomeVariant(selected.outcome)}>{selected.outcome}</Badge>} />
                <DetailRow label="Undo" value={`${undoLabel(selected)}${selected.undoReason ? `: ${selected.undoReason}` : ""}`} />
              </dl>

              <div className="rounded-md border bg-muted/25 p-3 text-sm">
                {selected.detail ?? "No additional detail."}
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Before</Label>
                  <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">{compactJson(selected.before)}</pre>
                </div>
                <div className="space-y-2">
                  <Label>After</Label>
                  <pre className="max-h-64 overflow-auto rounded-md border bg-background p-3 text-xs">{compactJson(selected.after)}</pre>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setSelected(null)}>Close</Button>
                <Button
                  loading={undoingId === selected.id}
                  disabled={selected.undoStatus !== "available"}
                  onClick={() => void undoActivity(selected)}
                >
                  {undoingId !== selected.id ? <RotateCcw className="h-4 w-4" /> : null}
                  Undo
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}


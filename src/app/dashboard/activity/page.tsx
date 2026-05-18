"use client"

import * as React from "react"
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Eye,
  RotateCcw,
  Search,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import {
  DashboardFilterGrid,
  DashboardPage,
  DashboardPageHeader,
  DashboardPageSkeleton,
} from "@/components/dashboard/page-shell"

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
  const [data, setData] = React.useState<ActivityResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<ActivityEvent | null>(null)
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

  const buildParams = React.useCallback(() => {
    const params = new URLSearchParams()
    params.set("limit", String(filters.limit))
    if (cursor) params.set("cursor", cursor)
    if (filters.q.trim()) params.set("q", filters.q.trim())
    if (filters.action !== ALL) params.set("action", filters.action)
    if (filters.entityType !== ALL) params.set("entityType", filters.entityType)
    if (filters.outcome !== ALL) params.set("outcome", filters.outcome)
    if (filters.undoable !== ALL) params.set("undoable", filters.undoable)
    if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`)
    if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`)
    return params
  }, [cursor, filters])

  const loadActivity = React.useCallback(
    async (quiet = false, signal?: AbortSignal) => {
      if (quiet) setRefreshing(true)
      else setLoading(true)
      try {
        const res = await fetch(`/api/activity?${buildParams().toString()}`, {
          cache: "no-store",
          signal,
        })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message =
            isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load activity"
          throw new Error(message)
        }
        setData(json as ActivityResponse)
        setError(null)
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return
        const message =
          typeof caught === "object" && caught !== null && "message" in caught
            ? String((caught as { message?: unknown }).message ?? "Unable to load activity")
            : "Unable to load activity"
        setError(message)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [buildParams]
  )

  React.useEffect(() => {
    const controller = new AbortController()
    void loadActivity(false, controller.signal)
    return () => controller.abort()
  }, [loadActivity])

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
      await loadActivity(true)
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
    return <DashboardPageSkeleton rows={8} />
  }

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Activity"
        description={
          <>
            Recent user and system activity. Last refreshed{" "}
            {formatRelative(data?.generatedAt)}.
          </>
        }
        actions={
        <Button
          variant="outline"
          loading={refreshing}
          onClick={() => void loadActivity(true)}
          disabled={refreshing}
        >
          Refresh
        </Button>
        }
      />

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Activity refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="py-0">
        <CardHeader className="border-b px-4 py-3">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="text-base">Filters</CardTitle>
             <div className="flex flex-wrap items-center gap-2">
              <Badge variant={activeFilterCount ? "secondary" : "outline"}>{activeFilterCount} active</Badge>
              <Button variant="outline" size="sm" onClick={resetFilters}>
                <X className="h-4 w-4" />
                Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4">
          <DashboardFilterGrid className="xl:grid-cols-[minmax(280px,1.5fr)_repeat(4,minmax(140px,1fr))_112px]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={filters.q}
                onChange={(event) => updateFilter("q", event.target.value)}
                placeholder="Search activity"
                className="h-10 pl-9"
              />
            </div>

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
                  <SelectItem key={size} value={String(size)}>{size}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </DashboardFilterGrid>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:max-w-md">
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
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="border-b px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">Activity List</CardTitle>
            <div className="text-sm text-muted-foreground">
              Page {cursorStack.length + 1} / {events.length} shown
            </div>
          </div>
        </CardHeader>

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
                <li key={event.id} className="px-4 py-3">
                  <div className="grid gap-3 xl:grid-cols-[160px_minmax(0,1fr)_180px_120px_88px] xl:items-center">
                    <div className="text-sm">
                      <div className="font-medium">{formatRelative(event.occurredAt)}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{formatDateTime(event.occurredAt)}</div>
                    </div>

                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{event.summary}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {formatAction(event.action)} / {event.entityLabel ?? event.entityType}
                      </div>
                    </div>

                    <div className="min-w-0 text-sm">
                      <div className="truncate">{event.actorName ?? "System"}</div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {event.actorEmail ?? event.ipAddress ?? "Background process"}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Badge variant={outcomeVariant(event.outcome)}>{event.outcome}</Badge>
                      <Badge variant={event.undoStatus === "available" ? "secondary" : "outline"}>{undoLabel(event)}</Badge>
                    </div>

                    <div className="flex justify-start lg:justify-end">
                      <Button size="sm" variant="ghost" onClick={() => setSelected(event)}>
                        <Eye className="h-4 w-4" />
                        View
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>

        <div className="flex flex-col gap-3 border-t p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {loading ? "Loading" : `${events.length} activities on this page`}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={cursorStack.length === 0 || loading}
              onClick={() => {
                const nextStack = cursorStack.slice(0, -1)
                setCursor(nextStack[nextStack.length - 1] ?? null)
                setCursorStack(nextStack)
              }}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={!data?.nextCursor || loading}
              onClick={() => {
                if (!data?.nextCursor) return
                setCursorStack((stack) => [...stack, data.nextCursor!])
                setCursor(data.nextCursor)
              }}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
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

"use client"

import * as React from "react"
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Clock,
  KeyRound,
  Search,
  Server,
  ShieldAlert,
} from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DashboardDataTable } from "@/components/dashboard/data-table"
import {
  DashboardFilterGrid,
  DashboardPage,
  DashboardPageHeader,
  DashboardPageSkeleton,
} from "@/components/dashboard/page-shell"

const ALL = "__all__"

type UsageEvent = {
  id: string
  occurredAt: string
  action: string
  objectKey?: string
  status?: number
  outcome: string
  ipAddress?: string
  projectId?: string
  projectName?: string
  keyName?: string
  keyPrefix?: string
}

type UsageResponse = {
  summary: {
    total: number
    success: number
    failed: number
    rateLimited: number
    uniqueKeys: number
    uniqueProjects: number
  }
  byAction: Array<{ action: string; count: number }>
  byProject: Array<{ projectId: string; name: string; count: number }>
  events: UsageEvent[]
  nextCursor: string | null
  generatedAt: string
}

function formatNumber(value: number) {
  return Intl.NumberFormat().format(value)
}

function formatAction(value: string) {
  return value
    .split(/[._-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

function formatRelative(value?: string | null) {
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

function outcomeVariant(outcome: string, status?: number): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "failed" || (status && status >= 500)) return "destructive"
  if (status === 429) return "secondary"
  if (outcome === "success") return "default"
  return "outline"
}

function StatCard({
  title,
  value,
  detail,
  icon: Icon,
}: {
  title: string
  value: string
  detail: string
  icon: React.ComponentType<{ className?: string }>
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-center justify-between px-4 py-3 pb-1.5 lg:px-4 lg:py-3 lg:pb-1.5">
        <CardTitle className="text-[13px] font-normal leading-4 text-muted-foreground">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 lg:px-4 lg:pb-3">
        <div className="text-xl font-bold leading-none tabular-nums sm:text-2xl">{value}</div>
        <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export default function ApiUsagePage() {
  const [data, setData] = React.useState<UsageResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [cursor, setCursor] = React.useState<string | null>(null)
  const [cursorStack, setCursorStack] = React.useState<string[]>([])
  const [filters, setFilters] = React.useState({
    projectId: "",
    action: ALL,
    outcome: ALL,
    from: "",
    to: "",
    limit: 50,
  })

  const buildParams = React.useCallback(() => {
    const params = new URLSearchParams()
    params.set("limit", String(filters.limit))
    if (cursor) params.set("cursor", cursor)
    if (filters.projectId.trim()) params.set("projectId", filters.projectId.trim())
    if (filters.action !== ALL) params.set("action", filters.action)
    if (filters.outcome !== ALL) params.set("outcome", filters.outcome)
    if (filters.from) params.set("from", `${filters.from}T00:00:00.000Z`)
    if (filters.to) params.set("to", `${filters.to}T23:59:59.999Z`)
    return params
  }, [cursor, filters])

  const loadUsage = React.useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await fetch(`/api/projects/usage?${buildParams().toString()}`, {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load API usage"
        throw new Error(message)
      }
      setData(json as UsageResponse)
      setError(null)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return
      const message =
        caught instanceof Error ? caught.message : "Unable to load API usage"
      setError(message)
      toast.error(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [buildParams])

  React.useEffect(() => {
    const controller = new AbortController()
    void loadUsage(false, controller.signal)
    return () => controller.abort()
  }, [loadUsage])

  const resetPagination = () => {
    setCursor(null)
    setCursorStack([])
  }

  const updateFilter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => {
    resetPagination()
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const actions = data?.byAction.map((item) => item.action) ?? []
  const summary = data?.summary
  const successRate =
    summary && summary.total > 0
      ? Math.round((summary.success / summary.total) * 1000) / 10
      : 0

  const eventColumns: ColumnDef<UsageEvent>[] = [
    {
      accessorKey: "occurredAt",
      header: "Time",
      cell: ({ row }) => (
        <div className="flex items-center gap-2 whitespace-nowrap text-sm">
          <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {formatDateTime(row.original.occurredAt)}
        </div>
      ),
    },
    { accessorKey: "action", header: "Action", cell: ({ row }) => formatAction(row.original.action) },
    {
      id: "project",
      header: "Project",
      cell: ({ row }) => (
        <div className="min-w-36">
          <div className="max-w-44 truncate">{row.original.projectName ?? "-"}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{row.original.projectId ?? ""}</div>
        </div>
      ),
    },
    {
      id: "key",
      header: "Key",
      cell: ({ row }) => (
        <div className="min-w-32">
          <div className="max-w-36 truncate">{row.original.keyName ?? "-"}</div>
          <div className="font-mono text-xs text-muted-foreground">{row.original.keyPrefix ? `${row.original.keyPrefix}...` : ""}</div>
        </div>
      ),
    },
    { accessorKey: "objectKey", header: "Object", cell: ({ row }) => <span className="block max-w-60 truncate font-mono text-xs">{row.original.objectKey ?? "-"}</span> },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <Badge variant={outcomeVariant(row.original.outcome, row.original.status)}>{row.original.status ?? row.original.outcome}</Badge>,
    },
    { accessorKey: "ipAddress", header: "IP", cell: ({ row }) => <span className="text-xs text-muted-foreground">{row.original.ipAddress ?? "-"}</span> },
  ]

  if (loading && !data) {
    return <DashboardPageSkeleton rows={7} />
  }

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
      <DashboardPageHeader
        title="API Usage"
        description={
          <>
            Track public project API calls, keys, projects, errors, and rate
            limits. Last refreshed {formatRelative(data?.generatedAt)}.
          </>
        }
        actions={
        <Button
          variant="outline"
          loading={refreshing}
          onClick={() => void loadUsage(true)}
          disabled={refreshing}
        >
          Refresh
        </Button>
        }
      />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>API usage refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="dashboard-motion-item dashboard-motion-delay-1 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          title="Total Requests"
          value={formatNumber(summary?.total ?? 0)}
          detail={`${successRate}% success rate`}
          icon={BarChart3}
        />
        <StatCard
          title="Failed Requests"
          value={formatNumber(summary?.failed ?? 0)}
          detail={`${formatNumber(summary?.rateLimited ?? 0)} rate limited`}
          icon={ShieldAlert}
        />
        <StatCard
          title="API Keys"
          value={formatNumber(summary?.uniqueKeys ?? 0)}
          detail="Unique keys in this range"
          icon={KeyRound}
        />
        <StatCard
          title="Projects"
          value={formatNumber(summary?.uniqueProjects ?? 0)}
          detail="Projects receiving API traffic"
          icon={Server}
        />
      </div>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 gap-0 py-0">
        <CardHeader className="px-4 py-3 pb-2 lg:px-4 lg:py-3">
          <CardTitle className="text-sm font-semibold">Filter API events</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 pt-0">
          <DashboardFilterGrid className="grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={filters.projectId}
                onChange={(event) => updateFilter("projectId", event.target.value)}
                placeholder="Project ID"
                className="pl-9"
              />
            </div>
            <Select value={filters.action} onValueChange={(value) => updateFilter("action", value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All actions</SelectItem>
                {actions.map((action) => (
                  <SelectItem key={action} value={action}>
                    {formatAction(action)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filters.outcome} onValueChange={(value) => updateFilter("outcome", value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All outcomes</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="warning">Warning</SelectItem>
              </SelectContent>
            </Select>
            <Select value={String(filters.limit)} onValueChange={(value) => updateFilter("limit", Number(value))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[25, 50, 100, 200].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input type="date" aria-label="From date" value={filters.from} onChange={(event) => updateFilter("from", event.target.value)} />
            <Input type="date" aria-label="To date" value={filters.to} onChange={(event) => updateFilter("to", event.target.value)} />
            <Button className="w-full" variant="outline" onClick={() => {
              resetPagination()
              setFilters({ projectId: "", action: ALL, outcome: ALL, from: "", to: "", limit: 50 })
            }}>Clear filters</Button>
          </DashboardFilterGrid>
        </CardContent>
      </Card>

      <div className="dashboard-motion-item dashboard-motion-delay-2 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data?.byAction ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No API events yet.</div>
            ) : (
              data?.byAction.map((item) => (
                <div key={item.action} className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0">
                  <span>{formatAction(item.action)}</span>
                  <Badge variant="secondary">{formatNumber(item.count)}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top Projects</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data?.byProject ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No project traffic yet.</div>
            ) : (
              data?.byProject.map((item) => (
                <div key={item.projectId} className="flex items-center justify-between gap-3 border-b py-2 text-sm last:border-0">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item.name}</div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{item.projectId}</div>
                  </div>
                  <Badge variant="secondary">{formatNumber(item.count)}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="dashboard-motion-item dashboard-motion-delay-3">
        <DashboardDataTable
          data={data?.events ?? []}
          columns={eventColumns}
          pageSize={Math.max(filters.limit, data?.events.length ?? 0)}
          minWidth="1080px"
          loading={loading && !data}
          emptyState="No API usage events found."
          header={
            <div>
              <h2 className="text-sm font-semibold">Recent API Events</h2>
              <p className="mt-1 text-xs text-muted-foreground">Latest project API activity. Results are loaded {filters.limit} at a time.</p>
            </div>
          }
          paginationContent={<div className="flex items-center justify-between gap-3">
          <span>API event results</span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
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
              size="sm"
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
          </div>}
        />
      </div>
    </DashboardPage>
  )
}

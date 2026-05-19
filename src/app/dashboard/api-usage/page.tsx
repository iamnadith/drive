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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 lg:px-5 lg:pt-5">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="lg:px-5 lg:pb-5">
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
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

  if (loading && !data) {
    return <DashboardPageSkeleton rows={7} />
  }

  return (
    <DashboardPage>
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

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>API usage refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <DashboardFilterGrid className="xl:grid-cols-[minmax(220px,1fr)_repeat(3,160px)_120px]">
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
            <Button
              variant="outline"
              onClick={() => {
                resetPagination()
                setFilters({ projectId: "", action: ALL, outcome: ALL, from: "", to: "", limit: 50 })
              }}
            >
              Clear
            </Button>
          </DashboardFilterGrid>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:max-w-md">
            <Input type="date" value={filters.from} onChange={(event) => updateFilter("from", event.target.value)} />
            <Input type="date" value={filters.to} onChange={(event) => updateFilter("to", event.target.value)} />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Top Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data?.byAction ?? []).length === 0 ? (
              <div className="text-sm text-muted-foreground">No API events yet.</div>
            ) : (
              data?.byAction.map((item) => (
                <div key={item.action} className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm">
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
                <div key={item.projectId} className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm">
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

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent API Events</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Project</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Object</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    Loading API usage...
                  </TableCell>
                </TableRow>
              ) : (data?.events ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No API usage events found.
                  </TableCell>
                </TableRow>
              ) : (
                data?.events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell>
                      <div className="flex items-center gap-2 text-sm">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                        {formatDateTime(event.occurredAt)}
                      </div>
                    </TableCell>
                    <TableCell>{formatAction(event.action)}</TableCell>
                    <TableCell>
                      <div className="max-w-44 truncate">{event.projectName ?? "-"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{event.projectId ?? ""}</div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-36 truncate">{event.keyName ?? "-"}</div>
                      <div className="font-mono text-xs text-muted-foreground">{event.keyPrefix ? `${event.keyPrefix}...` : ""}</div>
                    </TableCell>
                    <TableCell className="max-w-60 truncate font-mono text-xs">
                      {event.objectKey ?? "-"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={outcomeVariant(event.outcome, event.status)}>
                        {event.status ?? event.outcome}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{event.ipAddress ?? "-"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t p-4">
          <div className="text-sm text-muted-foreground">
            Page {cursorStack.length + 1}
          </div>
          <div className="flex flex-wrap gap-2">
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
    </DashboardPage>
  )
}

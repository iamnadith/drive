"use client"

import * as React from "react"
import {
  AlertTriangle,
  BarChart3,
  Clock,
  KeyRound,
  Server,
  ShieldAlert,
} from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { DashboardDataTable } from "@/components/dashboard/data-table"
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardPageSkeleton,
} from "@/components/dashboard/page-shell"
import { DashboardSearchFilterToolbar, type SearchFilterOption } from "@/components/dashboard/search-filter-toolbar"
import { formatLastSyncedAt } from "@/lib/dashboard-format"

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

const rankingChartConfig = {
  requests: { label: "Requests", color: "var(--chart-1)" },
} satisfies ChartConfig

function RankingChartCard({
  title,
  description,
  emptyMessage,
  rows,
}: {
  title: string
  description: string
  emptyMessage: string
  rows: Array<{ name: string; requests: number }>
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-3 pb-1.5 lg:px-4 lg:py-3 lg:pb-1.5">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="px-3 pb-3 pt-2">
        {rows.length === 0 ? (
          <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : (
          <ChartContainer config={rankingChartConfig} className="h-[240px] w-full">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid horizontal={false} />
              <XAxis type="number" allowDecimals={false} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={132}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: string) => value.length > 18 ? `${value.slice(0, 17)}…` : value}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
              <Bar dataKey="requests" fill="var(--color-requests)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
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

  const goToUsagePage = (pageIndex: number) => {
    if (pageIndex < 0 || pageIndex > cursorStack.length + 1) return
    if (pageIndex <= cursorStack.length) {
      setCursorStack((stack) => stack.slice(0, pageIndex))
      setCursor(pageIndex === 0 ? null : cursorStack[pageIndex - 1] ?? null)
      return
    }
    if (!data?.nextCursor) return
    setCursorStack((stack) => [...stack, data.nextCursor!])
    setCursor(data.nextCursor)
  }

  const updateFilter = <K extends keyof typeof filters>(key: K, value: (typeof filters)[K]) => {
    resetPagination()
    setFilters((current) => ({ ...current, [key]: value }))
  }

  const actions = data?.byAction.map((item) => item.action) ?? []
  const usageFilters: SearchFilterOption[] = [
    {
      key: "action",
      label: "Action",
      type: "select",
      defaultValue: ALL,
      options: [{ value: ALL, label: "All actions" }, ...actions.map((action) => ({ value: action, label: formatAction(action) }))],
    },
    {
      key: "outcome",
      label: "Outcome",
      type: "select",
      defaultValue: ALL,
      options: [
        { value: ALL, label: "All outcomes" },
        { value: "success", label: "Success" },
        { value: "failed", label: "Failed" },
        { value: "warning", label: "Warning" },
      ],
    },
    {
      key: "limit",
      label: "Results per page",
      type: "select",
      defaultValue: "50",
      options: [25, 50, 100, 200].map((size) => ({ value: String(size), label: String(size) })),
    },
    { key: "from", label: "From date", type: "date", defaultValue: "" },
    { key: "to", label: "To date", type: "date", defaultValue: "" },
  ]
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
        description={formatLastSyncedAt(data?.generatedAt)}
        actions={
          <DashboardSearchFilterToolbar
            searchValue={filters.projectId}
            searchPlaceholder="Search project ID..."
            countSearch
            searchWidthClassName="sm:w-[220px]"
            onRefresh={() => void loadUsage(true)}
            refreshing={refreshing}
            refreshLabel="Sync API usage"
            onSearchChange={(value) => updateFilter("projectId", value)}
            filters={usageFilters}
            filterValues={{
              action: filters.action,
              outcome: filters.outcome,
              limit: String(filters.limit),
              from: filters.from,
              to: filters.to,
            }}
            onFilterChange={(key, value) => {
              if (key === "limit") updateFilter("limit", Number(value))
              else if (key === "action") updateFilter("action", value)
              else if (key === "outcome") updateFilter("outcome", value)
              else if (key === "from") updateFilter("from", value)
              else if (key === "to") updateFilter("to", value)
            }}
            onClear={() => {
              resetPagination()
              setFilters({ projectId: "", action: ALL, outcome: ALL, from: "", to: "", limit: 50 })
            }}
            title="Filter API usage"
            description="Narrow API activity by project, action, result, or date range."
          />
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

      <div className="dashboard-motion-item dashboard-motion-delay-3">
        <DashboardDataTable
          data={data?.events ?? []}
          columns={eventColumns}
          pageSize={filters.limit}
          minWidth="1080px"
          loading={loading && !data}
          emptyState="No API usage events found."
          serverPagination={{
            pageIndex: cursorStack.length,
            pageCount: cursorStack.length + 1 + (data?.nextCursor ? 1 : 0),
            onPageChange: goToUsagePage,
          }}
        />
      </div>

      <div className="dashboard-motion-item dashboard-motion-delay-4 grid gap-4 xl:grid-cols-2">
        <RankingChartCard
          title="Top Actions"
          description="Request volume grouped by API action."
          emptyMessage="No API events yet."
          rows={(data?.byAction ?? []).slice(0, 8).map((item) => ({ name: formatAction(item.action), requests: item.count }))}
        />
        <RankingChartCard
          title="Top Projects"
          description="Projects generating the most API requests."
          emptyMessage="No project traffic yet."
          rows={(data?.byProject ?? []).slice(0, 8).map((item) => ({ name: item.name, requests: item.count }))}
        />
      </div>
    </DashboardPage>
  )
}

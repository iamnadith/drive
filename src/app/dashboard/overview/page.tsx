"use client"

import * as React from "react"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  Server,
} from "lucide-react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
} from "recharts"
import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"

type OverviewResponse = {
  generatedAt: string
  activeAccount: {
    label: string
    email: string
    syncStatus?: string
    lastSyncedAt?: string
  } | null
  metrics: {
    storageBytes: number
    objects: number
    buckets: number
    accounts: number
    activeMigrations: number
    workers: number
    onlineWorkers: number
    attentionItems: number
  }
  series: Array<{
    date: string
    storageBytes: number
    objects: number
    transferredObjects: number
    failedObjects: number
    verifyIssues: number
  }>
  activeAccountSeries: Array<{
    date: string
    accountId: string
    accountLabel: string
    buckets: number
    storageBytes: number
    objects: number
    capturedAt: string
  }>
  recentActivity: Array<{
    id: string
    at: string
    title: string
    detail: string
    status: string
    href?: string
  }>
  syncHealth: {
    partial: boolean
    warnings: string[]
    staleBucketStats: boolean
    bucketStatsUpdatedAt: string | null
    unsyncedAccounts: number
    accountSyncErrors: number
    bucketStatsErrors: number
  }
}

type UsageRange = "7d" | "30d" | "90d"

const platformUsageChartConfig = {
  storageGb: {
    label: "Storage (GB)",
    color: "var(--primary)",
  },
  objectsK: {
    label: "Objects (K)",
    color: "var(--primary)",
  },
} satisfies ChartConfig

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatNumber(value: number | undefined): string {
  if (!value || value <= 0) return "0"
  return Intl.NumberFormat().format(value)
}

function formatCompact(value: number | undefined): string {
  if (!value || value <= 0) return "0"
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`
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

function formatRefreshTime(value?: string | null): string {
  if (!value) return "Never"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toLowerCase()
  if (normalized.includes("failed") || normalized.includes("error")) return "destructive"
  if (normalized === "completed" || normalized === "ok" || normalized === "online") return "default"
  if (normalized === "running" || normalized === "verifying" || normalized === "syncing") return "secondary"
  return "outline"
}

function SummaryCard({
  title,
  value,
  detail,
  icon: Icon,
  warning,
}: {
  title: string
  value: string
  detail: string
  icon: React.ComponentType<{ className?: string }>
  warning?: boolean
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${warning ? "text-amber-500" : "text-muted-foreground"}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

function PlatformUsageChart({ series }: { series: OverviewResponse["activeAccountSeries"] }) {
  const isMobile = useIsMobile()
  const [timeRange, setTimeRange] = React.useState<UsageRange>("90d")

  React.useEffect(() => {
    if (isMobile) setTimeRange("7d")
  }, [isMobile])

  const chartData = React.useMemo(() => {
    const referenceTime = series.reduce((latest, item) => {
      const time = Date.parse(item.date)
      return Number.isFinite(time) ? Math.max(latest, time) : latest
    }, 0)
    const referenceDate = referenceTime > 0 ? new Date(referenceTime) : new Date()
    const daysToSubtract = timeRange === "30d" ? 30 : timeRange === "7d" ? 7 : 90
    const startDate = new Date(referenceDate)
    startDate.setDate(startDate.getDate() - daysToSubtract)

    return series
      .filter((item) => {
        const date = new Date(item.date)
        return Number.isFinite(date.getTime()) && date >= startDate
      })
      .map((item) => ({
        ...item,
        storageGb: Number((item.storageBytes / 1024 / 1024 / 1024).toFixed(2)),
        objectsK: Number((item.objects / 1000).toFixed(2)),
      }))
  }, [series, timeRange])

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Storage Usage</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">
            Storage and objects for current and previous active accounts over time.
          </span>
          <span className="@[540px]/card:hidden">Active account history</span>
        </CardDescription>
        <CardAction>
          <ToggleGroup
            type="single"
            value={timeRange}
            onValueChange={(value) => {
              if (value) setTimeRange(value as UsageRange)
            }}
            variant="outline"
            className="hidden *:data-[slot=toggle-group-item]:px-4! @[767px]/card:flex"
          >
            <ToggleGroupItem value="90d">Last 3 months</ToggleGroupItem>
            <ToggleGroupItem value="30d">Last 30 days</ToggleGroupItem>
            <ToggleGroupItem value="7d">Last 7 days</ToggleGroupItem>
          </ToggleGroup>
          <Select value={timeRange} onValueChange={(value) => setTimeRange(value as UsageRange)}>
            <SelectTrigger
              className="flex w-40 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
              size="sm"
              aria-label="Select chart range"
            >
              <SelectValue placeholder="Last 3 months" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="90d" className="rounded-lg">
                Last 3 months
              </SelectItem>
              <SelectItem value="30d" className="rounded-lg">
                Last 30 days
              </SelectItem>
              <SelectItem value="7d" className="rounded-lg">
                Last 7 days
              </SelectItem>
            </SelectContent>
          </Select>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {chartData.length === 0 ? (
          <div className="flex h-[250px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            No active account usage history yet
          </div>
        ) : (
          <ChartContainer config={platformUsageChartConfig} className="aspect-auto h-[250px] w-full">
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="fillStorage" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-storageGb)" stopOpacity={1} />
                  <stop offset="95%" stopColor="var(--color-storageGb)" stopOpacity={0.1} />
                </linearGradient>
                <linearGradient id="fillObjects" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-objectsK)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-objectsK)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value) =>
                  new Date(value).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) =>
                      new Date(value).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    }
                    indicator="dot"
                  />
                }
              />
              <Area
                dataKey="objectsK"
                type="natural"
                fill="url(#fillObjects)"
                stroke="var(--color-objectsK)"
                stackId="a"
              />
              <Area
                dataKey="storageGb"
                type="natural"
                fill="url(#fillStorage)"
                stroke="var(--color-storageGb)"
                stackId="a"
              />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

export default function OverviewPage() {
  const [data, setData] = React.useState<OverviewResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const loadOverview = React.useCallback(async (quiet = false, signal?: AbortSignal) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const res = await fetch("/api/dashboard/analytics?range=all", {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load overview"
        throw new Error(message)
      }
      setData(json as OverviewResponse)
      setError(null)
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return
      const message =
        typeof caught === "object" && caught !== null && "message" in caught
          ? String((caught as { message?: unknown }).message ?? "Unable to load overview")
          : "Unable to load overview"
      setError(message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    const controller = new AbortController()
    void loadOverview(false, controller.signal)
    return () => controller.abort()
  }, [loadOverview])

  React.useEffect(() => {
    const refreshIfActive = () => {
      if (document.visibilityState === "visible") void loadOverview(true)
    }
    const interval = window.setInterval(refreshIfActive, 5_000)
    window.addEventListener("focus", refreshIfActive)
    document.addEventListener("visibilitychange", refreshIfActive)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener("focus", refreshIfActive)
      document.removeEventListener("visibilitychange", refreshIfActive)
    }
  }, [loadOverview])

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-36" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-52" />
      </div>
    )
  }

  const metrics = data?.metrics
  const accountName = data?.activeAccount?.label || data?.activeAccount?.email || "No active account"
  const healthy = metrics ? metrics.attentionItems === 0 && !data?.syncHealth.partial : false

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Retained analytics summary with active account <span className="font-medium text-foreground">{accountName}</span>. Last refreshed at {formatRefreshTime(data?.generatedAt)}.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void loadOverview(true)} disabled={refreshing}>
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/analytics">
              Analytics <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Overview refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {data?.syncHealth.partial || data?.syncHealth.staleBucketStats ? (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Some live data needs attention</AlertTitle>
          <AlertDescription>
            {data.syncHealth.staleBucketStats
              ? `Bucket stats are incomplete or unavailable. Last bucket update: ${formatRelative(data.syncHealth.bucketStatsUpdatedAt)}. `
              : ""}
            {data.syncHealth.warnings.slice(0, 1).join(" ")}
          </AlertDescription>
        </Alert>
      ) : null}

      {metrics ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              title="Active Storage"
              value={formatBytes(metrics.storageBytes)}
              detail={`${formatNumber(metrics.buckets)} active account buckets`}
              icon={HardDrive}
            />
            <SummaryCard
              title="Active Objects"
              value={formatCompact(metrics.objects)}
              detail={`${formatNumber(metrics.objects)} active account objects`}
              icon={Database}
            />
            <SummaryCard
              title="Migrations"
              value={formatNumber(metrics.activeMigrations)}
              detail="Currently running or verifying"
              icon={Server}
            />
            <SummaryCard
              title="Health"
              value={healthy ? "Good" : formatNumber(metrics.attentionItems)}
              detail={healthy ? "No dashboard attention items" : "Items need review"}
              icon={healthy ? CheckCircle2 : AlertTriangle}
              warning={!healthy}
            />
          </div>

          <PlatformUsageChart series={data.activeAccountSeries ?? []} />

          <div className="grid gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>Latest live events.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.recentActivity.slice(0, 4).length === 0 ? (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No recent activity
                  </div>
                ) : (
                  data.recentActivity.slice(0, 4).map((activity) => (
                    <Link
                      key={activity.id}
                      href={activity.href ?? "/dashboard/analytics"}
                      className="block rounded-md border p-3 transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{activity.title}</div>
                          <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{activity.detail}</div>
                        </div>
                        <Badge variant={statusVariant(activity.status)}>{activity.status}</Badge>
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
              <div className="border-t p-4">
                <Button asChild variant="outline" className="w-full">
                  <Link href="/dashboard/activity">
                    View all activity <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  )
}

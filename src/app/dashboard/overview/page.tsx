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
import { DashboardOverviewSkeleton } from "@/components/dashboard/loading-skeletons"
import { useDashboardResource } from "@/hooks/use-dashboard-resource"
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

type RecentActivityItem = {
  id: string
  occurredAt: string
  action: string
  entityType: string
  entityLabel?: string
  summary: string
  detail?: string
  outcome: "success" | "failed" | "warning" | "info"
}

type ActivityResponse = {
  events: RecentActivityItem[]
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

const DASHBOARD_ANALYTICS_CACHE_KEY = "dashboard-analytics:range=all"

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

function formatRefreshTime(value?: string | null): string {
  if (!value) return "Never"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })
}

function outcomeVariant(outcome: RecentActivityItem["outcome"]): "default" | "secondary" | "destructive" | "outline" {
  if (outcome === "failed") return "destructive"
  if (outcome === "success") return "default"
  if (outcome === "warning") return "secondary"
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
    <Card className="@container/card pb-0 sm:pb-0.5">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-0 md:gap-1">
        <CardTitle className="leading-none md:leading-tight">Storage Usage</CardTitle>
        <CardDescription className="-mt-1 leading-none md:mt-0 md:leading-tight">
          <span className="hidden @[540px]/card:block">
            Storage and objects for current and previous active accounts over time.
          </span>
          <span className="@[540px]/card:hidden">Active account history</span>
        </CardDescription>
        <CardAction className="col-start-2 row-start-1 mt-0 justify-self-end self-start">
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
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 28 }}>
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
                height={40}
                tickMargin={12}
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
  const {
    data,
    error,
    loading,
    refreshing,
    refresh: refreshOverview,
  } = useDashboardResource<OverviewResponse>({
    key: DASHBOARD_ANALYTICS_CACHE_KEY,
    refreshIntervalMs: 20_000,
    staleTimeMs: 10_000,
    fetcher: async ({ signal, force }) => {
      const res = await fetch(`/api/dashboard/analytics?range=all${force ? "&refresh=1" : ""}`, {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load overview"
        throw new Error(message)
      }
      return json as OverviewResponse
    },
  })
  const {
    data: recentActivityData,
    error: activityError,
    loading: activityLoading,
    refreshing: activityRefreshing,
    refresh: refreshRecentActivity,
  } = useDashboardResource<RecentActivityItem[]>({
    key: "dashboard-overview-activity",
    refreshIntervalMs: 15_000,
    staleTimeMs: 8_000,
    fetcher: async ({ signal }) => {
      const res = await fetch("/api/activity?limit=4", {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load recent activity"
        throw new Error(message)
      }
      const events = isRecord(json) && Array.isArray((json as ActivityResponse).events) ? (json as ActivityResponse).events : []
      return events.filter((event): event is RecentActivityItem => {
        if (!isRecord(event)) return false
        return (
          typeof event.id === "string" &&
          typeof event.occurredAt === "string" &&
          typeof event.action === "string" &&
          typeof event.entityType === "string" &&
          typeof event.summary === "string" &&
          typeof event.outcome === "string"
        )
      }).slice(0, 4)
    },
  })

  const recentActivity = recentActivityData ?? []
  const isRefreshing = refreshing || activityRefreshing

  if (loading && !data) {
    return <DashboardOverviewSkeleton />
  }

  const metrics = data?.metrics
  const accountName = data?.activeAccount?.label || data?.activeAccount?.email || "No active account"
  const healthy = metrics ? metrics.attentionItems === 0 && !data?.syncHealth.partial : false

  return (
    <div className="dashboard-motion-stage space-y-6">
      <div className="dashboard-motion-item mb-[0.7rem] grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
        <div className="-mt-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <div className="mt-px flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <span>Active account: <span className="font-medium text-foreground">{accountName}</span></span>
            <span className="hidden md:inline">-</span>
            <span>Last refreshed at {formatRefreshTime(data?.generatedAt)}</span>
            {isRefreshing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
          </div>
        </div>
        <div className="flex justify-end gap-2 self-start">
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh overview"
            className="border border-border/70 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]"
            onClick={() => {
              void refreshOverview({ background: true, force: true })
              void refreshRecentActivity({ background: true, force: true })
            }}
            disabled={isRefreshing}
          >
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
          </Button>
          <Button asChild size="sm" className="border border-border/60 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
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
          <div className="dashboard-motion-item dashboard-motion-delay-1 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

          <div className="dashboard-motion-item dashboard-motion-delay-2">
            <PlatformUsageChart series={data.activeAccountSeries ?? []} />
          </div>

          <div className="dashboard-motion-item dashboard-motion-delay-3 grid gap-4">
            <Card className="overflow-hidden gap-0 py-0">
              <CardHeader className="border-b flex min-h-16 items-center px-4 py-2.5 pb-0 sm:min-h-0 sm:px-5 md:px-4 md:py-2">
                <div className="flex w-full items-center justify-between gap-3 md:gap-2">
                  <div className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
                    <CardTitle className="text-base">Recent Activity</CardTitle>
                    <CardDescription className="text-xs">Latest four actions from the feed.</CardDescription>
                  </div>
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 rounded-full border border-border/70 bg-background/70 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] self-center hover:bg-muted/70"
                  >
                    <Link href="/dashboard/activity">
                      View all <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {activityLoading && recentActivity.length === 0 ? (
                  <div className="space-y-2 p-3.5 sm:p-5">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="h-16 rounded-xl border border-dashed" />
                    ))}
                  </div>
                ) : activityError ? (
                  <div className="p-3.5 sm:p-5">
                    <div className="rounded-xl border border-dashed p-3.5 text-sm text-muted-foreground">
                      {activityError}
                    </div>
                  </div>
                ) : recentActivity.length === 0 ? (
                  <div className="p-3.5 sm:p-5">
                    <div className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">
                      No recent activity
                    </div>
                  </div>
                ) : (
                  <ul className="divide-y">
                    {recentActivity.map((activity) => (
                      <li key={activity.id} className="md:py-3 md:first:pt-0 md:last:pb-0">
                        <Link
                          href="/dashboard/activity"
                          className="group relative block px-4 py-2.5 outline-none transition-[background-color,box-shadow] hover:bg-muted/40 active:bg-muted/60 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/20 md:px-4 md:py-0 md:hover:bg-muted/30"
                        >
                          <ArrowRight className="absolute right-4 top-2.5 h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 md:hidden" />
                          <div className="grid gap-2.5 md:grid-cols-[144px_minmax(0,1fr)_auto] md:items-center md:gap-4">
                            <div className="flex items-center justify-between gap-3 md:block md:self-stretch md:border-r md:border-border/60 md:pr-4">
                              <div className="flex items-center gap-2 md:mb-2">
                                <span
                                  className={`h-2 w-2 rounded-full ${
                                    activity.outcome === "failed"
                                      ? "bg-destructive"
                                      : activity.outcome === "success"
                                        ? "bg-primary"
                                        : activity.outcome === "warning"
                                          ? "bg-amber-500"
                                          : "bg-muted-foreground"
                                  }`}
                                />
                                <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                                  {formatAction(activity.action)}
                                </span>
                              </div>
                              <div className="hidden text-[11px] leading-4 text-muted-foreground md:block">
                                <div className="font-medium text-foreground">{formatRelative(activity.occurredAt)}</div>
                                <div className="mt-0.5">{formatDateTime(activity.occurredAt)}</div>
                              </div>
                            </div>
                            <div className="min-w-0 pr-6 md:pr-0">
                              <div className="text-sm font-medium leading-5 md:text-[15px] md:leading-6">
                                {activity.summary}
                              </div>
                              <div className="mt-1 text-[11px] leading-4 text-muted-foreground md:text-xs">
                                <span>{activity.entityLabel ?? activity.entityType}</span>
                                {activity.detail ? (
                                  <span className="hidden md:inline">
                                    {" "} - {activity.detail}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-3 md:self-stretch md:flex-col md:items-end md:justify-between md:gap-1">
                              <div className="text-[11px] leading-4 text-muted-foreground md:hidden">
                                <div className="font-medium text-foreground">{formatRelative(activity.occurredAt)}</div>
                                <div className="mt-0.5 truncate">{formatDateTime(activity.occurredAt)}</div>
                              </div>
                              <ArrowRight className="hidden h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 md:block" />
                              <Badge
                                variant={outcomeVariant(activity.outcome)}
                                className="h-6 rounded-full px-2 text-[10px] capitalize"
                              >
                                {activity.outcome}
                              </Badge>
                            </div>
                          </div>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  )
}

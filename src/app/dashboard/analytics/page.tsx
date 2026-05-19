"use client"

import * as React from "react"
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  Server,
  ShieldAlert,
  TrendingUp,
  Users,
  Wrench,
} from "lucide-react"
import Link from "next/link"
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DashboardAnalyticsSkeleton } from "@/components/dashboard/loading-skeletons"
import { useDashboardResource } from "@/hooks/use-dashboard-resource"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useIsMobile } from "@/hooks/use-mobile"

type RangeKey = "7d" | "30d" | "90d"

type OverviewResponse = {
  generatedAt: string
  activeAccount: {
    id: string
    label: string
    email: string
    status: string
    lastSyncedAt?: string
    syncStatus?: string
  } | null
  metrics: {
    storageBytes: number
    objects: number
    buckets: number
    accounts: number
    activeAccounts: number
    users: number
    activeUsers: number
    migrations: number
    activeMigrations: number
    failedMigrations: number
    workers: number
    onlineWorkers: number
    repairJobs: number
    activeRepairJobs: number
    failedRepairJobs: number
    failureRecords: number
    verificationDiffs: number
    attentionItems: number
  }
  series: Array<{
    date: string
    storageBytes: number
    objects: number
    createdMigrations: number
    completedMigrations: number
    transferredObjects: number
    failedObjects: number
    verifyIssues: number
    activeRepairs: number
  }>
  breakdowns: {
    migrations: Record<string, number>
    accounts: Record<string, number>
    workers: Record<string, number>
    repairs: Record<string, number>
    bucketStats: Record<string, number>
  }
  topBuckets: Array<{
    id: string
    accountLabel: string
    name: string
    objects: number
    bytes: number
    status: string
    error?: string
    updatedAt?: string
  }>
  attentionItems: Array<{
    id: string
    severity: string
    title: string
    detail: string
    href?: string
    at: string
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

const usageChartConfig = {
  storageGb: {
    label: "Storage (GB)",
    color: "var(--primary)",
  },
  objectsK: {
    label: "Objects (K)",
    color: "var(--primary)",
  },
} satisfies ChartConfig

const migrationChartConfig = {
  createdMigrations: {
    label: "Created",
    color: "var(--primary)",
  },
  completedMigrations: {
    label: "Completed",
    color: "var(--primary)",
  },
} satisfies ChartConfig

const transferChartConfig = {
  transferredObjects: {
    label: "Transferred",
    color: "var(--primary)",
  },
  failedObjects: {
    label: "Failed",
    color: "hsl(var(--destructive))",
  },
  verifyIssues: {
    label: "Verify issues",
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
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toLowerCase()
  if (normalized.includes("failed") || normalized.includes("error") || normalized === "critical") return "destructive"
  if (normalized === "completed" || normalized === "ok" || normalized === "online") return "default"
  if (normalized === "running" || normalized === "verifying" || normalized === "syncing" || normalized === "warning") return "secondary"
  return "outline"
}

function withChartFields(series: OverviewResponse["series"]) {
  return series.map((point) => ({
    ...point,
    storageGb: Number((point.storageBytes / 1024 / 1024 / 1024).toFixed(2)),
    objectsK: Number((point.objects / 1000).toFixed(2)),
  }))
}

function filterByRange<T extends { date: string }>(items: T[], range: RangeKey): T[] {
  const latest = items.reduce((max, item) => {
    const time = Date.parse(item.date)
    return Number.isFinite(time) ? Math.max(max, time) : max
  }, 0)
  const reference = latest > 0 ? new Date(latest) : new Date()
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90
  const start = new Date(reference)
  start.setDate(start.getDate() - days)
  return items.filter((item) => {
    const date = new Date(item.date)
    return Number.isFinite(date.getTime()) && date >= start
  })
}

function RangeAction({
  value,
  onChange,
  className,
}: {
  value: RangeKey
  onChange: (value: RangeKey) => void
  className?: string
}) {
  return (
    <CardAction className={className}>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as RangeKey)
        }}
        variant="outline"
        className="hidden *:data-[slot=toggle-group-item]:h-8! *:data-[slot=toggle-group-item]:px-3! @[767px]/card:flex"
      >
        <ToggleGroupItem value="90d">Last 3 months</ToggleGroupItem>
        <ToggleGroupItem value="30d">Last 30 days</ToggleGroupItem>
        <ToggleGroupItem value="7d">Last 7 days</ToggleGroupItem>
      </ToggleGroup>
      <Select value={value} onValueChange={(next) => onChange(next as RangeKey)}>
        <SelectTrigger
          className="flex h-8 w-32 **:data-[slot=select-value]:block **:data-[slot=select-value]:truncate @[767px]/card:hidden"
          size="sm"
          aria-label="Select chart range"
        >
          <SelectValue placeholder="Last 3 months" />
        </SelectTrigger>
        <SelectContent className="rounded-xl">
          <SelectItem value="90d" className="rounded-lg">Last 3 months</SelectItem>
          <SelectItem value="30d" className="rounded-lg">Last 30 days</SelectItem>
          <SelectItem value="7d" className="rounded-lg">Last 7 days</SelectItem>
        </SelectContent>
      </Select>
    </CardAction>
  )
}

function UsageChart({ data }: { data: ReturnType<typeof withChartFields> }) {
  const isMobile = useIsMobile()
  const [range, setRange] = React.useState<RangeKey>("90d")
  React.useEffect(() => {
    if (isMobile) setRange("7d")
  }, [isMobile])
  const chartData = React.useMemo(() => filterByRange(data, range), [data, range])
  return (
    <Card className="@container/card gap-0 py-0">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1 px-4 pt-4.5 pb-2 sm:px-6 md:gap-1.5 md:px-4 md:pt-2.5 md:pb-2">
        <CardTitle className="text-base leading-none">Storage and Objects</CardTitle>
        <CardDescription className="text-[11px] leading-3.5 md:text-xs md:leading-4">Active account storage and object totals over time.</CardDescription>
        <RangeAction
          value={range}
          onChange={setRange}
          className="col-start-2 row-start-1 row-span-2 mt-0 self-start justify-self-end"
        />
      </CardHeader>
      <CardContent className="px-1.5 pt-3 pb-0 sm:px-4 sm:pt-3 sm:pb-1 md:px-3">
        <ChartContainer config={usageChartConfig} className="aspect-auto h-[252px] w-full sm:h-[272px]">
          <AreaChart data={chartData} margin={{ top: 14, right: 8, left: 0, bottom: 22 }}>
            <defs>
              <linearGradient id="fillStorageAnalytics" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-storageGb)" stopOpacity={1} />
                <stop offset="95%" stopColor="var(--color-storageGb)" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="fillObjectsAnalytics" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-objectsK)" stopOpacity={0.75} />
                <stop offset="95%" stopColor="var(--color-objectsK)" stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} height={48} tickMargin={18} minTickGap={32} tickFormatter={(value) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Area dataKey="objectsK" type="natural" fill="url(#fillObjectsAnalytics)" stroke="var(--color-objectsK)" stackId="a" />
            <Area dataKey="storageGb" type="natural" fill="url(#fillStorageAnalytics)" stroke="var(--color-storageGb)" stackId="a" />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function MigrationChart({ data }: { data: ReturnType<typeof withChartFields> }) {
  const [range, setRange] = React.useState<RangeKey>("90d")
  const chartData = React.useMemo(() => filterByRange(data, range), [data, range])
  return (
    <Card className="@container/card gap-0 py-0">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1 px-4 pt-4.5 pb-2 sm:px-6 md:gap-1.5 md:px-4 md:pt-2.5 md:pb-2">
        <CardTitle className="text-base leading-none">Migration Activity</CardTitle>
        <CardDescription className="text-[11px] leading-3.5 md:text-xs md:leading-4">Created and completed migrations across the selected period.</CardDescription>
        <RangeAction value={range} onChange={setRange} className="col-start-2 row-start-1 row-span-2 mt-0 self-start justify-self-end" />
      </CardHeader>
      <CardContent className="px-1.5 pt-3 sm:px-4 sm:pt-3 md:px-3">
        <ChartContainer config={migrationChartConfig} className="aspect-auto h-[240px] w-full sm:h-[260px]">
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 28 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} height={40} tickMargin={12} minTickGap={32} tickFormatter={(value) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
            <YAxis tickLine={false} axisLine={false} width={32} allowDecimals={false} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Bar dataKey="createdMigrations" fill="var(--color-createdMigrations)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="completedMigrations" fill="var(--color-completedMigrations)" fillOpacity={0.45} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function TransferChart({ data }: { data: ReturnType<typeof withChartFields> }) {
  const [range, setRange] = React.useState<RangeKey>("90d")
  const chartData = React.useMemo(() => filterByRange(data, range), [data, range])
  return (
    <Card className="@container/card gap-0 py-0">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1 px-4 pt-4.5 pb-2 sm:px-6 md:gap-1.5 md:px-4 md:pt-2.5 md:pb-2">
        <CardTitle className="text-base leading-none">Transfer Health</CardTitle>
        <CardDescription className="text-[11px] leading-3.5 md:text-xs md:leading-4">Transferred objects, failures, and verification issues from migration progress.</CardDescription>
        <RangeAction value={range} onChange={setRange} className="col-start-2 row-start-1 row-span-2 mt-0 self-start justify-self-end" />
      </CardHeader>
      <CardContent className="px-1.5 pt-3 sm:px-4 sm:pt-3 md:px-3">
        <ChartContainer config={transferChartConfig} className="aspect-auto h-[240px] w-full sm:h-[260px]">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 28 }}>
            <defs>
              <linearGradient id="fillTransferredAnalytics" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-transferredObjects)" stopOpacity={0.9} />
                <stop offset="95%" stopColor="var(--color-transferredObjects)" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="fillFailedAnalytics" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-failedObjects)" stopOpacity={0.55} />
                <stop offset="95%" stopColor="var(--color-failedObjects)" stopOpacity={0.08} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} height={40} tickMargin={12} minTickGap={32} tickFormatter={(value) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Area dataKey="failedObjects" type="natural" fill="url(#fillFailedAnalytics)" stroke="var(--color-failedObjects)" stackId="a" />
            <Area dataKey="verifyIssues" type="natural" fill="var(--color-verifyIssues)" fillOpacity={0.12} stroke="var(--color-verifyIssues)" stackId="a" />
            <Area dataKey="transferredObjects" type="natural" fill="url(#fillTransferredAnalytics)" stroke="var(--color-transferredObjects)" stackId="a" />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}

function KpiCard({
  title,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  title: string
  value: string
  detail: string
  icon: React.ComponentType<{ className?: string }>
  tone?: "default" | "warning" | "success"
}) {
  const iconClass =
    tone === "warning"
      ? "text-amber-500"
      : tone === "success"
        ? "text-green-500"
        : "text-muted-foreground"
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row items-start justify-between gap-3 px-4 py-3 pb-1.5 lg:px-3 lg:py-1 lg:pb-0">
        <CardTitle className="text-[13px] font-medium leading-4">{title}</CardTitle>
        <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0 lg:px-3 lg:pb-1">
        <div className="text-xl font-bold leading-none tabular-nums sm:text-2xl">{value}</div>
        <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const {
    data,
    error,
    loading,
    refreshing,
    refresh,
  } = useDashboardResource<OverviewResponse>({
    key: "dashboard-analytics",
    refreshIntervalMs: 20_000,
    fetcher: async ({ signal, force }) => {
      const res = await fetch(`/api/dashboard/analytics?range=all${force ? "&refresh=1" : ""}`, {
        cache: "no-store",
        signal,
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string"
            ? json.error
            : "Unable to load dashboard analytics"
        throw new Error(message)
      }
      return json as OverviewResponse
    },
  })

  const chartData = React.useMemo(() => withChartFields(data?.series ?? []), [data?.series])
  const migrationCompletionRate = React.useMemo(() => {
    if (!data || data.metrics.migrations === 0) return 0
    const completed = data.breakdowns.migrations.completed ?? 0
    return Math.max(0, Math.min(100, (completed / data.metrics.migrations) * 100))
  }, [data])

  if (!data) {
    return <DashboardAnalyticsSkeleton />
  }

  const metrics = data?.metrics
  const syncHealth = data?.syncHealth
  const activeAccountName = data?.activeAccount?.label || data?.activeAccount?.email || "No active account"

  return (
    <div className="dashboard-motion-stage space-y-4 md:space-y-5">
      <div className="dashboard-motion-item grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <span>Active account: <span className="font-medium text-foreground">{activeAccountName}</span></span>
            <span className="hidden md:inline">-</span>
            <span>Last refreshed at {formatRefreshTime(data?.generatedAt)}</span>
            {refreshing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : null}
          </div>
        </div>
        <Button variant="outline" size="icon" className="h-8 w-8 self-start" onClick={() => void refresh({ background: true, force: true })} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Analytics refresh failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {syncHealth?.partial || syncHealth?.staleBucketStats ? (
        <Alert>
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Live data is degraded</AlertTitle>
          <AlertDescription>
            {syncHealth.staleBucketStats
              ? `Bucket stats are incomplete or unavailable. Last bucket update: ${formatRelative(syncHealth.bucketStatsUpdatedAt)}. `
              : ""}
            {syncHealth.warnings.slice(0, 2).join(" ")}
          </AlertDescription>
        </Alert>
      ) : null}

      {metrics ? (
        <>
          <div className="dashboard-motion-item grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard title="Active Storage" value={formatBytes(metrics.storageBytes)} detail={`${formatNumber(metrics.buckets)} active account buckets`} icon={HardDrive} />
            <KpiCard title="Active Objects" value={formatCompact(metrics.objects)} detail={`${formatNumber(metrics.objects)} active account objects`} icon={Database} />
            <KpiCard title="Accounts" value={`${metrics.activeAccounts}/${metrics.accounts}`} detail={`${syncHealth?.unsyncedAccounts ?? 0} unsynced, ${syncHealth?.accountSyncErrors ?? 0} errors`} icon={Server} />
            <KpiCard title="Users" value={formatNumber(metrics.activeUsers)} detail={`${formatNumber(metrics.users)} total users`} icon={Users} />
            <KpiCard title="Active Migrations" value={formatNumber(metrics.activeMigrations)} detail={`${formatNumber(metrics.migrations)} total migrations`} icon={Activity} tone={metrics.activeMigrations > 0 ? "success" : "default"} />
            <KpiCard title="Workers Online" value={`${metrics.onlineWorkers}/${metrics.workers}`} detail={`${(data?.breakdowns.workers.offline ?? 0) + (data?.breakdowns.workers.error ?? 0)} unavailable`} icon={CheckCircle2} tone={metrics.onlineWorkers > 0 ? "success" : "default"} />
            <KpiCard title="Repair Jobs" value={formatNumber(metrics.activeRepairJobs)} detail={`${formatNumber(metrics.failedRepairJobs)} failed, ${formatNumber(metrics.repairJobs)} total`} icon={Wrench} tone={metrics.failedRepairJobs > 0 ? "warning" : "default"} />
            <KpiCard title="Attention" value={formatNumber(metrics.attentionItems)} detail={`${formatNumber(metrics.failedMigrations)} migration issues`} icon={AlertTriangle} tone={metrics.attentionItems > 0 ? "warning" : "default"} />
          </div>

          <div className="dashboard-motion-item grid gap-3 xl:grid-cols-2">
            <UsageChart data={chartData} />
            <MigrationChart data={chartData} />
            <div className="xl:col-span-2">
              <TransferChart data={chartData} />
            </div>
          </div>

          <div className="dashboard-motion-item grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] xl:items-start">
            <Card className="xl:sticky xl:top-4 xl:self-start">
              <CardHeader className="gap-1 pb-2 md:px-4">
                <CardTitle className="text-base">Buckets</CardTitle>
                <CardDescription className="text-xs leading-4">All active account buckets with current storage, objects, and sync status.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-1.5 md:px-4">
                {data.topBuckets.length === 0 ? (
                  <EmptyLine text="No bucket stats yet" />
                ) : (
                  data.topBuckets.map((bucket) => (
                    <Link
                      key={bucket.id}
                      href={`/dashboard/analytics/buckets/${encodeURIComponent(bucket.name)}`}
                      className="group relative block rounded-xl border px-3 py-2 transition-colors hover:bg-muted/50 active:bg-muted/60 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-2"
                    >
                      <ArrowRight className="absolute top-2 right-3 h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 md:hidden" />
                      <div className="grid gap-1.5 md:hidden">
                        <div className="min-w-0 pr-6">
                          <div className="truncate text-sm font-medium">{bucket.name}</div>
                          <div className="truncate text-[11px] leading-4 text-muted-foreground">{bucket.accountLabel}</div>
                        </div>
                        <div className="grid grid-cols-2 gap-1.5 text-sm">
                          <div>
                            <div className="font-medium">{formatBytes(bucket.bytes)}</div>
                            <div className="text-[11px] text-muted-foreground">storage</div>
                          </div>
                          <div>
                            <div className="font-medium">{formatCompact(bucket.objects)}</div>
                            <div className="text-[11px] text-muted-foreground">objects</div>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="text-[11px] text-muted-foreground md:hidden">
                            {bucket.updatedAt ? formatRelative(bucket.updatedAt) : ""}
                          </div>
                          <Badge variant={statusVariant(bucket.status)}>{bucket.status}</Badge>
                        </div>
                      </div>
                      <div className="hidden min-w-0 md:block">
                        <div className="truncate text-sm font-medium">{bucket.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">{bucket.accountLabel}</div>
                      </div>
                      <div className="hidden text-sm md:block md:text-right">
                        <div className="font-medium">{formatBytes(bucket.bytes)}</div>
                        <div className="text-[11px] text-muted-foreground">storage</div>
                      </div>
                      <div className="hidden text-sm md:block md:text-right">
                        <div className="font-medium">{formatCompact(bucket.objects)}</div>
                        <div className="text-[11px] text-muted-foreground">objects</div>
                      </div>
                      <div className="hidden items-center justify-end gap-2 md:flex">
                        <Badge variant={statusVariant(bucket.status)}>{bucket.status}</Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </Link>
                  ))
                )}
              </CardContent>
            </Card>

            <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
              <SystemHealthCard data={data} completionRate={migrationCompletionRate} />
              <AttentionQueueCard items={data.attentionItems} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}

function SystemHealthCard({ data, completionRate }: { data: OverviewResponse; completionRate: number }) {
  return (
    <Card>
      <CardHeader className="gap-1 pb-2 md:px-4">
        <CardTitle className="text-base">System Health</CardTitle>
        <CardDescription className="text-xs leading-4">Operational status across migrations, workers, bucket stats, and repair jobs.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 md:px-4">
        <div className="space-y-2 rounded-xl border p-3">
          <div className="flex items-center justify-between text-sm">
            <span>Migration completion</span>
            <span className="font-medium">{completionRate.toFixed(1)}%</span>
          </div>
          <Progress value={completionRate} className="h-2" />
        </div>
        <div className="grid gap-2.5 md:grid-cols-2">
          <Breakdown title="Migrations" values={data.breakdowns.migrations} />
          <Breakdown title="Workers" values={data.breakdowns.workers} />
          <Breakdown title="Bucket stats" values={data.breakdowns.bucketStats} />
          <Breakdown title="Repair jobs" values={data.breakdowns.repairs} />
        </div>
      </CardContent>
    </Card>
  )
}

function AttentionQueueCard({ items }: { items: OverviewResponse["attentionItems"] }) {
  if (items.length === 0) return null

  return (
    <Card>
      <CardHeader className="gap-1 pb-2 md:px-4">
        <CardTitle className="text-base">Attention Queue</CardTitle>
        <CardDescription className="text-xs leading-4">Failures, stale sync, and verification records that need review.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5 md:px-4">
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href ?? "/dashboard/overview"}
            className="grid gap-2 rounded-xl border px-3 py-2.5 transition-colors hover:bg-muted/50 active:bg-muted/60 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{item.title}</div>
              <div className="line-clamp-1 text-[11px] text-muted-foreground">{item.detail}</div>
            </div>
            <div className="text-[11px] text-muted-foreground md:text-right">{formatRelative(item.at)}</div>
            <Badge variant={statusVariant(item.severity)}>{item.severity}</Badge>
          </Link>
        ))}
      </CardContent>
    </Card>
  )
}

function Breakdown({ title, values }: { title: string; values: Record<string, number> }) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1])
  return (
    <div className="space-y-2 rounded-xl border px-3 py-2.5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{formatNumber(entries.reduce((sum, [, count]) => sum + count, 0))} total</div>
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-muted-foreground">No records</div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([status, count]) => (
            <Badge key={status} variant={statusVariant(status)}>
              {status}: {formatNumber(count)}
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyLine({
  text,
  icon: Icon = Database,
}: {
  text: string
  icon?: React.ComponentType<{ className?: string }>
}) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-2 rounded-xl border border-dashed px-3 text-sm text-muted-foreground">
      <Icon className="h-4 w-4" />
      {text}
    </div>
  )
}

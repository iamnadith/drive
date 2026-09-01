"use client"

import * as React from "react"
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  Server,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import Link from "next/link"
import type { DateRange } from "react-day-picker"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { DashboardOverviewSkeleton } from "@/components/dashboard/loading-skeletons"
import { useDashboardResource } from "@/hooks/use-dashboard-resource"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
    hasSnapshot: boolean
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

type UsageRange = "30d" | "90d" | "180d" | "365d" | "all" | "custom"
type UsageMetric = "storage" | "objects"

const platformUsageChartConfig = {
  storageGb: {
    label: "Storage (GB)",
    color: "var(--primary)",
  },
  objects: {
    label: "Objects",
    color: "var(--muted-foreground)",
  },
} satisfies ChartConfig

const usageRangeDays: Record<Exclude<UsageRange, "all" | "custom">, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
}

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

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
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
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 max-sm:px-3 max-sm:pt-1.5 lg:px-5 lg:pt-5">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${warning ? "text-amber-500" : "text-muted-foreground"}`} />
      </CardHeader>
      <CardContent className="max-sm:px-3 max-sm:pb-1.5 lg:px-5 lg:pb-5">
        <div className="text-2xl font-semibold tracking-tight tabular-nums max-sm:text-[1.25rem]">{value}</div>
        <p className="mt-0 text-[11px] text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

type StorageMetrics = Pick<OverviewResponse["metrics"], "storageBytes" | "objects">

function UsageMetricSelector({
  value,
  onValueChange,
  storageBytes,
  objects,
}: {
  value: UsageMetric
  onValueChange: (value: UsageMetric) => void
  storageBytes: number
  objects: number
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Current inventory</p>
          <p className="mt-0.5 text-xs leading-4 text-muted-foreground">
            Latest live totals from the active account
          </p>
        </div>
        <Badge variant="secondary" className="shrink-0 rounded-full px-2.5 text-[10px]">
          Live
        </Badge>
      </div>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue) onValueChange(nextValue as UsageMetric)
        }}
        variant="outline"
        spacing={2}
        className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1"
        aria-label="Select storage history metric"
      >
        <ToggleGroupItem
          value="storage"
          className="min-h-24 w-full flex-col items-start justify-between gap-2 rounded-2xl px-3.5 py-3 text-left data-[state=on]:border-primary/40 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-medium">
              <HardDrive className="size-4 text-muted-foreground" />
              Storage
            </span>
            <span className="text-[10px] text-muted-foreground">Capacity</span>
          </span>
          <span className="text-[1.45rem] font-semibold tracking-tight tabular-nums">
            {formatBytes(storageBytes)}
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="objects"
          className="min-h-24 w-full flex-col items-start justify-between gap-2 rounded-2xl px-3.5 py-3 text-left data-[state=on]:border-primary/40 data-[state=on]:bg-background data-[state=on]:shadow-sm"
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-xs font-medium">
              <Database className="size-4 text-muted-foreground" />
              Objects
            </span>
            <span className="text-[10px] text-muted-foreground">Count</span>
          </span>
          <span className="text-[1.45rem] font-semibold tracking-tight tabular-nums">
            {formatNumber(objects)}
          </span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  )
}

type StorageHistoryControlsProps = {
  timeRange: UsageRange
  onTimeRangeChange: (value: UsageRange) => void
  isMobile: boolean
  visibleDateRangeLabel: string
  datePickerOpen: boolean
  onDatePickerOpenChange: (open: boolean) => void
  visibleDateRange: DateRange | undefined
  datePickerDraft: DateRange | undefined
  onDatePickerDraftChange: (range: DateRange | undefined) => void
  historyBounds: { from: Date; to: Date } | undefined
  minimumSelectableDays: number
  datePickerDraftDays: number
  datePickerDraftIsValid: boolean
  onApplyDateRange: (range: DateRange) => void
}

function StorageHistoryControls({
  timeRange,
  onTimeRangeChange,
  isMobile,
  visibleDateRangeLabel,
  datePickerOpen,
  onDatePickerOpenChange,
  visibleDateRange,
  datePickerDraft,
  onDatePickerDraftChange,
  historyBounds,
  minimumSelectableDays,
  datePickerDraftDays,
  datePickerDraftIsValid,
  onApplyDateRange,
}: StorageHistoryControlsProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-border/60 pb-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-sm font-medium">Usage history</p>
        <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
          {visibleDateRangeLabel}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2 sm:justify-end">
        <ToggleGroup
          type="single"
          value={timeRange}
          onValueChange={(value) => {
            if (value) onTimeRangeChange(value as UsageRange)
          }}
          variant="outline"
          size="sm"
          className="hidden rounded-xl border bg-muted/30 p-1 md:flex"
          aria-label="Select history range"
        >
          <ToggleGroupItem
            value="90d"
            aria-label="Last 3 months"
            title="Last 3 months"
            className="h-7 rounded-lg border-0 px-3 text-xs shadow-none data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            3M
          </ToggleGroupItem>
          <ToggleGroupItem
            value="180d"
            aria-label="Last 6 months"
            title="Last 6 months"
            className="h-7 rounded-lg border-0 px-3 text-xs shadow-none data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            6M
          </ToggleGroupItem>
          <ToggleGroupItem
            value="365d"
            aria-label="Last 12 months"
            title="Last 12 months"
            className="h-7 rounded-lg border-0 px-3 text-xs shadow-none data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            12M
          </ToggleGroupItem>
          <ToggleGroupItem
            value="all"
            aria-label="All time"
            title="All time"
            className="h-7 rounded-lg border-0 px-3 text-xs shadow-none data-[state=on]:bg-background data-[state=on]:shadow-sm"
          >
            All
          </ToggleGroupItem>
        </ToggleGroup>
        <Select
          value={timeRange}
          onValueChange={(value) => {
            if (value !== "custom") onTimeRangeChange(value as UsageRange)
          }}
        >
          <SelectTrigger
            className="h-8 min-w-0 flex-1 rounded-xl px-2.5 text-xs md:hidden"
            size="sm"
            aria-label="Select history range"
          >
            <SelectValue placeholder="Last 3 months" />
          </SelectTrigger>
          <SelectContent className="rounded-xl">
            <SelectItem value="30d" className="rounded-lg">
              Last 1 month
            </SelectItem>
            <SelectItem value="90d" className="rounded-lg">
              Last 3 months
            </SelectItem>
            <SelectItem value="180d" className="rounded-lg">
              Last 6 months
            </SelectItem>
            <SelectItem value="365d" className="rounded-lg">
              Last 12 months
            </SelectItem>
            <SelectItem value="all" className="rounded-lg">
              All time
            </SelectItem>
            {timeRange === "custom" ? (
              <SelectItem value="custom" className="rounded-lg">
                Custom range
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
        <Popover
          open={datePickerOpen}
          onOpenChange={(open) => {
            onDatePickerOpenChange(open)
            if (open) onDatePickerDraftChange(visibleDateRange)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-xl px-2.5 text-xs tabular-nums md:flex-none"
              aria-label={`Choose date range, currently ${visibleDateRangeLabel}`}
            >
              <CalendarDays data-icon="inline-start" />
              <span className="truncate">{visibleDateRangeLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align={isMobile ? "center" : "end"}
            sideOffset={8}
            className="w-[calc(100vw-2rem)] max-w-fit overflow-hidden rounded-2xl p-0 shadow-xl"
          >
            <div className="border-b px-4 py-3">
              <p className="text-sm font-semibold">Choose a date range</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isMobile ? "Minimum 1 month" : "Minimum 3 months"}
              </p>
            </div>
            <Calendar
              mode="range"
              selected={datePickerDraft}
              defaultMonth={datePickerDraft?.from ?? historyBounds?.from}
              numberOfMonths={isMobile ? 1 : 2}
              min={Math.max(0, minimumSelectableDays - 1)}
              disabled={
                historyBounds
                  ? [{ before: historyBounds.from }, { after: historyBounds.to }]
                  : undefined
              }
              onSelect={onDatePickerDraftChange}
              className="p-3"
            />
            <div className="flex items-center justify-between gap-3 border-t bg-muted/20 px-3 py-2.5">
              <p className="min-w-0 truncate text-xs tabular-nums text-muted-foreground">
                {datePickerDraft?.from && datePickerDraft.to
                  ? `${datePickerDraftDays} days selected`
                  : "Select start and end dates"}
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-lg px-2.5 text-xs"
                  onClick={() => {
                    onDatePickerDraftChange(visibleDateRange)
                    onDatePickerOpenChange(false)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 rounded-lg px-3 text-xs"
                  disabled={!datePickerDraftIsValid || !datePickerDraft?.from || !datePickerDraft.to}
                  onClick={() => {
                    if (!datePickerDraft?.from || !datePickerDraft.to || !datePickerDraftIsValid) return
                    onApplyDateRange(datePickerDraft)
                    onDatePickerOpenChange(false)
                  }}
                >
                  Apply
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

function PlatformUsageChart({
  series,
  metrics,
}: {
  series: OverviewResponse["activeAccountSeries"]
  metrics: StorageMetrics
}) {
  const isMobile = useIsMobile()
  const [timeRange, setTimeRange] = React.useState<UsageRange>("90d")
  const [usageMetric, setUsageMetric] = React.useState<UsageMetric>("storage")
  const [datePickerOpen, setDatePickerOpen] = React.useState(false)
  const [datePickerDraft, setDatePickerDraft] = React.useState<DateRange | undefined>()
  const [pendingDateRange, setPendingDateRange] = React.useState<{
    from: string
    to: string
  } | null>(null)
  const [navigatorSelection, setNavigatorSelection] = React.useState<{
    key: string
    startIndex: number
    endIndex: number
  } | null>(null)
  const chartInteractionRef = React.useRef<HTMLDivElement>(null)
  const touchGestureRef = React.useRef<{
    distance?: number
    lastX?: number
  }>({})

  React.useEffect(() => {
    setTimeRange((current) => {
      if (isMobile && current === "90d") return "30d"
      if (!isMobile && current === "30d") return "90d"
      return current
    })
  }, [isMobile])

  const chartData = React.useMemo(() => {
    const validSeries = series
      .filter((item) => Number.isFinite(Date.parse(item.date)))
      .sort((a, b) => a.date.localeCompare(b.date))
    if (validSeries.length === 0) return []

    const referenceTime = Date.parse(validSeries[validSeries.length - 1].date)
    const firstSnapshot = validSeries.find(
      (item) => item.hasSnapshot ?? item.accountId !== "logical-storage"
    )
    if ((timeRange === "all" || timeRange === "custom") && !firstSnapshot) return []

    const startTime =
      timeRange === "all" || timeRange === "custom"
        ? Date.parse(firstSnapshot!.date)
        : referenceTime - (usageRangeDays[timeRange] - 1) * 86_400_000
    const chartPoints = []
    let sourceIndex = -1

    for (let dayTime = startTime; dayTime <= referenceTime; dayTime += 86_400_000) {
      const date = new Date(dayTime).toISOString().slice(0, 10)
      while (sourceIndex + 1 < validSeries.length && validSeries[sourceIndex + 1].date <= date) {
        sourceIndex += 1
      }
      const source = sourceIndex >= 0 ? validSeries[sourceIndex] : undefined
      const hasSnapshot = Boolean(
        source && (source.hasSnapshot ?? source.accountId !== "logical-storage")
      )
      const storageBytes = hasSnapshot ? source?.storageBytes ?? 0 : 0

      chartPoints.push({
        date,
        storageBytes,
        storageGb: Number((storageBytes / 1024 / 1024 / 1024).toFixed(2)),
        objects: hasSnapshot ? source?.objects ?? 0 : 0,
      })
    }

    const maxStorageGb = Math.max(...chartPoints.map((point) => point.storageGb), 0)
    const maxObjects = Math.max(...chartPoints.map((point) => point.objects), 0)

    return chartPoints.map((point) => ({
      ...point,
      storageGb: maxStorageGb > 0 ? Number(((point.storageGb / maxStorageGb) * 100).toFixed(3)) : 0,
      objects: maxObjects > 0 ? Number(((point.objects / maxObjects) * 100).toFixed(3)) : 0,
      rawObjects: point.objects,
    }))
  }, [series, timeRange])
  const enableChartNavigation = chartData.length > 1
  const navigatorKey = `${timeRange}:${chartData[0]?.date ?? "empty"}:${chartData.at(-1)?.date ?? "empty"}`
  const visibleStartIndex =
    navigatorSelection?.key === navigatorKey ? navigatorSelection.startIndex : 0
  const visibleEndIndex =
    navigatorSelection?.key === navigatorKey
      ? navigatorSelection.endIndex
      : Math.max(0, chartData.length - 1)
  const visibleChartData = chartData.slice(visibleStartIndex, visibleEndIndex + 1)
  const minimumRangeDays = isMobile ? 30 : 90
  const visibleDateRange = React.useMemo<DateRange | undefined>(() => {
    const from = chartData[visibleStartIndex]?.date
    const to = chartData[visibleEndIndex]?.date
    if (!from || !to) return undefined
    return {
      from: new Date(`${from}T00:00:00Z`),
      to: new Date(`${to}T00:00:00Z`),
    }
  }, [chartData, visibleEndIndex, visibleStartIndex])
  const visibleDateRangeLabel = React.useMemo(() => {
    if (!visibleDateRange?.from || !visibleDateRange.to) return "Dates"

    const from = visibleDateRange.from
    const to = visibleDateRange.to
    const sameYear = from.getUTCFullYear() === to.getUTCFullYear()
    const shortDate = (date: Date, includeYear = false) => date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(includeYear ? { year: "numeric" as const } : {}),
      timeZone: "UTC",
    })

    return sameYear
      ? `${shortDate(from)} - ${shortDate(to)}`
      : `${shortDate(from, true)} - ${shortDate(to, true)}`
  }, [visibleDateRange])
  const historyBounds = React.useMemo(() => {
    const dates = series
      .map((item) => item.date)
      .filter((date) => Number.isFinite(Date.parse(date)))
      .sort()
    if (dates.length === 0) return undefined
    return {
      from: new Date(`${dates[0]}T00:00:00Z`),
      to: new Date(`${dates[dates.length - 1]}T00:00:00Z`),
    }
  }, [series])
  const selectableHistoryDays = historyBounds
    ? Math.floor((historyBounds.to.getTime() - historyBounds.from.getTime()) / 86_400_000) + 1
    : minimumRangeDays
  const minimumSelectableDays = Math.min(minimumRangeDays, selectableHistoryDays)
  const datePickerDraftDays =
    datePickerDraft?.from && datePickerDraft.to
      ? Math.floor((datePickerDraft.to.getTime() - datePickerDraft.from.getTime()) / 86_400_000) + 1
      : 0
  const datePickerDraftIsValid = datePickerDraftDays >= minimumSelectableDays

  React.useEffect(() => {
    if (!pendingDateRange || timeRange !== "custom" || chartData.length === 0) return
    const startIndex = chartData.findIndex((point) => point.date >= pendingDateRange.from)
    const reverseEndIndex = [...chartData]
      .reverse()
      .findIndex((point) => point.date <= pendingDateRange.to)
    const endIndex = reverseEndIndex < 0 ? chartData.length - 1 : chartData.length - 1 - reverseEndIndex
    if (startIndex < 0 || endIndex < startIndex) return
    setNavigatorSelection({ key: navigatorKey, startIndex, endIndex })
    setPendingDateRange(null)
  }, [chartData, navigatorKey, pendingDateRange, timeRange])

  const updateChartViewport = React.useCallback(
    (mode: "pan" | "zoom", delta: number) => {
      const total = chartData.length
      if (total === 0) return

      const startIndex =
        navigatorSelection?.key === navigatorKey ? navigatorSelection.startIndex : 0
      const endIndex =
        navigatorSelection?.key === navigatorKey
          ? navigatorSelection.endIndex
          : Math.max(0, total - 1)
      const windowSize = endIndex - startIndex + 1
      const moveToCustomRange = (nextStart: number, nextEnd: number) => {
        const from = chartData[nextStart]?.date
        const to = chartData[nextEnd]?.date
        if (!from || !to) return

        if (timeRange === "custom") {
          setNavigatorSelection({ key: navigatorKey, startIndex: nextStart, endIndex: nextEnd })
          return
        }

        setPendingDateRange({ from, to })
        setNavigatorSelection(null)
        setTimeRange("custom")
      }

      if (mode === "pan") {
        const step = Math.max(1, Math.round(windowSize * 0.08)) * Math.sign(delta)
        const nextStart = Math.min(Math.max(0, startIndex + step), total - windowSize)
        if (nextStart !== startIndex) {
          moveToCustomRange(nextStart, nextStart + windowSize - 1)
          return
        }

        if (timeRange !== "custom" && delta < 0 && historyBounds) {
          const currentFrom = Date.parse(chartData[startIndex].date)
          const currentTo = Date.parse(chartData[endIndex].date)
          const historyStart = historyBounds.from.getTime()
          const shift = Math.min(
            currentFrom - historyStart,
            Math.max(1, Math.round(windowSize * 0.08)) * 86_400_000
          )
          if (shift > 0) {
            setPendingDateRange({
              from: new Date(currentFrom - shift).toISOString().slice(0, 10),
              to: new Date(currentTo - shift).toISOString().slice(0, 10),
            })
            setNavigatorSelection(null)
            setTimeRange("custom")
          }
        }
        return
      }

      const minimumWindow = Math.min(minimumRangeDays, total)
      const scale = delta > 0 ? 1.18 : 0.84
      const nextWindowSize = Math.min(
        total,
        Math.max(minimumWindow, Math.round(windowSize * scale))
      )

      if (delta > 0 && nextWindowSize === total) {
        if (timeRange === "custom") {
          setNavigatorSelection(null)
          setPendingDateRange(null)
          setTimeRange("all")
          return
        }

        if (historyBounds) {
          const currentFrom = Date.parse(chartData[startIndex].date)
          const currentTo = Date.parse(chartData[endIndex].date)
          const historyStart = historyBounds.from.getTime()
          const expansion = Math.max(1, Math.round(windowSize * 0.18)) * 86_400_000
          const nextFrom = Math.max(historyStart, currentFrom - expansion)
          if (nextFrom < currentFrom) {
            setPendingDateRange({
              from: new Date(nextFrom).toISOString().slice(0, 10),
              to: new Date(currentTo).toISOString().slice(0, 10),
            })
            setNavigatorSelection(null)
            setTimeRange("custom")
            return
          }
        }
        if (timeRange !== "all") {
          setNavigatorSelection(null)
          setPendingDateRange(null)
          setTimeRange("all")
          return
        }
      }

      const center = startIndex + (windowSize - 1) / 2
      const nextStart = Math.min(
        Math.max(0, Math.round(center - (nextWindowSize - 1) / 2)),
        total - nextWindowSize
      )
      if (nextWindowSize !== windowSize) {
        moveToCustomRange(nextStart, nextStart + nextWindowSize - 1)
      }
    },
    [chartData, historyBounds, minimumRangeDays, navigatorKey, navigatorSelection, timeRange]
  )

  React.useEffect(() => {
    const chart = chartInteractionRef.current
    if (!chart || !enableChartNavigation) return

    const handleWheel = (event: WheelEvent) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
      if (delta === 0) return
      event.preventDefault()
      updateChartViewport(event.ctrlKey || event.metaKey ? "zoom" : "pan", delta)
    }

    chart.addEventListener("wheel", handleWheel, { passive: false })
    return () => chart.removeEventListener("wheel", handleWheel)
  }, [enableChartNavigation, updateChartViewport])

  return (
    <Card className="overflow-hidden gap-0 py-0">
      <CardHeader className="border-b bg-muted/10 px-4 py-5 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl border bg-background/70 shadow-sm">
              <HardDrive className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Storage overview
              </p>
              <CardTitle className="mt-1 text-lg leading-tight">Storage Usage</CardTitle>
              <CardDescription className="mt-1 max-w-2xl leading-5">
                Logical storage history across migrations, without counting copied data twice.
              </CardDescription>
            </div>
          </div>
          <Badge variant="outline" className="hidden shrink-0 rounded-full px-2.5 text-[10px] sm:inline-flex">
            Logical inventory
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-0 p-0 lg:grid-cols-[minmax(15rem,0.34fr)_minmax(0,1fr)]">
        <section className="flex flex-col gap-6 border-b p-4 sm:p-6 lg:border-b-0 lg:border-r">
          <UsageMetricSelector
            value={usageMetric}
            onValueChange={setUsageMetric}
            storageBytes={metrics.storageBytes}
            objects={metrics.objects}
          />
          <div className="mt-auto flex flex-col gap-2.5 rounded-2xl border bg-muted/20 p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium">How this is counted</p>
              <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px]">
                Deduplicated
              </Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              One logical object is counted once, even when a migration copies it between accounts.
            </p>
          </div>
        </section>
        <section className="min-w-0 p-4 sm:p-6">
          <StorageHistoryControls
            timeRange={timeRange}
            onTimeRangeChange={setTimeRange}
            isMobile={isMobile}
            visibleDateRangeLabel={visibleDateRangeLabel}
            datePickerOpen={datePickerOpen}
            onDatePickerOpenChange={setDatePickerOpen}
            visibleDateRange={visibleDateRange}
            datePickerDraft={datePickerDraft}
            onDatePickerDraftChange={setDatePickerDraft}
            historyBounds={historyBounds}
            minimumSelectableDays={minimumSelectableDays}
            datePickerDraftDays={datePickerDraftDays}
            datePickerDraftIsValid={datePickerDraftIsValid}
            onApplyDateRange={(range) => {
              if (!range.from || !range.to) return
              const from = toLocalDateKey(range.from)
              const to = toLocalDateKey(range.to)
              setPendingDateRange({
                from: from <= to ? from : to,
                to: from <= to ? to : from,
              })
              setNavigatorSelection(null)
              setTimeRange("custom")
            }}
          />
          {chartData.length === 0 ? (
            <Empty className="mt-4 min-h-[280px] rounded-2xl border bg-muted/10 px-6 py-10">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Database />
                </EmptyMedia>
                <EmptyTitle>No storage history yet</EmptyTitle>
                <EmptyDescription>
                  Run a bucket sync to start tracking logical storage over time.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
            <div
              ref={chartInteractionRef}
              role="region"
              aria-label="Interactive storage history chart"
              tabIndex={enableChartNavigation ? 0 : -1}
              className="rounded-2xl [touch-action:pan-y] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onDoubleClick={() => setNavigatorSelection(null)}
              onKeyDown={(event) => {
                if (!enableChartNavigation) return
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault()
                  updateChartViewport("pan", event.key === "ArrowLeft" ? -1 : 1)
                } else if (event.key === "+" || event.key === "=") {
                  event.preventDefault()
                  updateChartViewport("zoom", -1)
                } else if (event.key === "-") {
                  event.preventDefault()
                  updateChartViewport("zoom", 1)
                }
              }}
              onTouchStart={(event) => {
                if (!enableChartNavigation) return
                if (event.touches.length === 2) {
                  const [first, second] = Array.from(event.touches)
                  touchGestureRef.current = {
                    distance: Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY),
                  }
                } else if (event.touches.length === 1) {
                  touchGestureRef.current = { lastX: event.touches[0].clientX }
                }
              }}
              onTouchMove={(event) => {
                if (!enableChartNavigation) return
                if (event.touches.length === 2) {
                  event.preventDefault()
                  const [first, second] = Array.from(event.touches)
                  const distance = Math.hypot(
                    second.clientX - first.clientX,
                    second.clientY - first.clientY
                  )
                  const previousDistance = touchGestureRef.current.distance
                  if (previousDistance && Math.abs(distance - previousDistance) >= 6) {
                    updateChartViewport("zoom", distance > previousDistance ? -1 : 1)
                    touchGestureRef.current.distance = distance
                  }
                } else if (event.touches.length === 1) {
                  const currentX = event.touches[0].clientX
                  const previousX = touchGestureRef.current.lastX
                  if (previousX !== undefined && Math.abs(previousX - currentX) >= 10) {
                    updateChartViewport("pan", previousX - currentX)
                    touchGestureRef.current.lastX = currentX
                  }
                }
              }}
              onTouchEnd={(event) => {
                touchGestureRef.current =
                  event.touches.length === 1 ? { lastX: event.touches[0].clientX } : {}
              }}
            >
              <ChartContainer
                config={platformUsageChartConfig}
                className="aspect-auto h-[300px] w-full overflow-hidden rounded-2xl border border-border/50 bg-muted/10 px-1 pt-3"
              >
                <BarChart
                  accessibilityLayer
                  data={visibleChartData}
                  margin={{ top: 8, right: 8, left: 8, bottom: 8 }}
                  barCategoryGap="12%"
                  barGap={3}
                >
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
                  <YAxis hide domain={[0, 100]} />
                  <ChartTooltip
                    cursor={{ fill: "var(--muted)", radius: 10 }}
                    content={
                      <ChartTooltipContent
                        className="rounded-2xl bg-popover/95 px-3 py-2 shadow-lg backdrop-blur-xl"
                        labelFormatter={(value) =>
                          new Date(value).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })
                        }
                        formatter={(_value, name, item) => {
                          const isStorage = name === "storageGb"
                          return (
                            <>
                              <div
                                className="size-2.5 shrink-0 rounded-[2px]"
                                style={{ backgroundColor: item.color }}
                              />
                              <div className="flex flex-1 items-center justify-between gap-4">
                                <span className="text-muted-foreground">
                                  {isStorage ? "Storage" : "Objects"}
                                </span>
                                <span className="font-mono font-medium tabular-nums text-foreground">
                                  {isStorage
                                    ? formatBytes(Number(item.payload?.storageBytes ?? 0))
                                    : formatNumber(Number(item.payload?.rawObjects ?? 0))}
                                </span>
                              </div>
                            </>
                          )
                        }}
                        indicator="dot"
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar
                    dataKey={usageMetric === "storage" ? "storageGb" : "objects"}
                    fill={
                      usageMetric === "storage"
                        ? "var(--color-storageGb)"
                        : "var(--color-objects)"
                    }
                    radius={0}
                    maxBarSize={22}
                  />
                </BarChart>
              </ChartContainer>
            </div>
            {enableChartNavigation ? (
              <p className="text-center text-xs text-muted-foreground">
                Scroll or swipe to move through time. Hold Ctrl while scrolling, or pinch, to zoom. Showing{" "}
                {new Date(chartData[visibleStartIndex]?.date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                {" to "}
                {new Date(chartData[visibleEndIndex]?.date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
                .
              </p>
            ) : null}
          </div>
          )}
        </section>
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
  const healthy = metrics ? metrics.attentionItems === 0 && !data?.syncHealth.partial : false

  return (
    <div className="dashboard-motion-stage space-y-6">
      <div className="dashboard-motion-item mb-[0.7rem] grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
        <div className="-mt-1 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <div className="mt-px flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground sm:text-sm">
            <span>Logical storage and file history</span>
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
          <div className="dashboard-motion-item dashboard-motion-delay-1 grid grid-cols-2 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              title="Live Storage"
              value={formatBytes(metrics.storageBytes)}
              detail={`${formatNumber(metrics.buckets)} current buckets`}
              icon={HardDrive}
            />
            <SummaryCard
              title="Live Objects"
              value={formatCompact(metrics.objects)}
              detail={`${formatNumber(metrics.objects)} current objects`}
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
            <PlatformUsageChart
              series={data.activeAccountSeries ?? []}
              metrics={metrics}
            />
          </div>

          <div className="dashboard-motion-item dashboard-motion-delay-3 grid gap-4">
            <Card className="overflow-hidden gap-0 py-0">
              <CardHeader className="flex min-h-16 items-center border-b px-4 py-2.5 pb-0 sm:min-h-0 sm:px-5 lg:py-3">
                <div className="flex w-full items-center justify-between gap-3">
                  <div className="min-w-0 flex-1 flex flex-col justify-center gap-0.5">
                    <CardTitle className="text-base">Recent Activity</CardTitle>
                    <CardDescription className="text-xs">Latest four actions from the feed.</CardDescription>
                  </div>
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0 self-center rounded-full border border-border/70 bg-background/70 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:bg-muted/70 lg:rounded-lg"
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
                  <ul className="divide-y lg:grid lg:grid-cols-2 lg:divide-y-0">
                    {recentActivity.map((activity) => (
                      <li
                        key={activity.id}
                        className="lg:border-b lg:odd:border-r lg:[&:nth-last-child(-n+2)]:border-b-0"
                      >
                        <Link
                          href="/dashboard/activity"
                          className="group relative block px-4 py-2.5 outline-none transition-[background-color,box-shadow] hover:bg-muted/40 active:bg-muted/60 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-primary/20 lg:h-full lg:px-5 lg:py-3 lg:hover:bg-muted/30"
                        >
                          <ArrowRight className="absolute right-4 top-2.5 h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 lg:hidden" />
                          <div className="grid gap-2.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:gap-x-4 lg:gap-y-2">
                            <div className="flex items-center justify-between gap-3 lg:col-span-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span
                                  className={`h-2 w-2 shrink-0 rounded-full ${
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
                              <div className="hidden shrink-0 items-center gap-2 text-[11px] text-muted-foreground lg:flex">
                                <span className="font-medium text-foreground">
                                  {formatRelative(activity.occurredAt)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span>{formatDateTime(activity.occurredAt)}</span>
                              </div>
                            </div>
                            <div className="min-w-0 pr-6 lg:pr-0">
                              <div className="text-sm font-medium leading-5 lg:text-[15px] lg:leading-6">
                                {activity.summary}
                              </div>
                              <div className="mt-1 truncate text-[11px] leading-4 text-muted-foreground lg:text-xs">
                                <span>{activity.entityLabel ?? activity.entityType}</span>
                                {activity.detail ? (
                                  <span className="hidden lg:inline">
                                    {" "} - {activity.detail}
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex items-center justify-between gap-3 lg:items-end lg:self-center">
                              <div className="text-[11px] leading-4 text-muted-foreground lg:hidden">
                                <div className="font-medium text-foreground">{formatRelative(activity.occurredAt)}</div>
                                <div className="mt-0.5 truncate">{formatDateTime(activity.occurredAt)}</div>
                              </div>
                              <Badge
                                variant={outcomeVariant(activity.outcome)}
                                className="h-6 rounded-full px-2 text-[10px] capitalize"
                              >
                                {activity.outcome}
                              </Badge>
                              <ArrowRight className="hidden h-3.5 w-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 lg:block" />
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

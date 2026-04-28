"use client"

import * as React from "react"
import { ArrowLeft, Database, File, HardDrive, RefreshCw } from "lucide-react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

type BucketRow = {
  id: string
  accountLabel: string
  name: string
  objects: number
  bytes: number
  status: string
  error?: string
  updatedAt?: string
}

type AnalyticsResponse = {
  activeAccount: { label: string; email: string } | null
  topBuckets: BucketRow[]
}

type ObjectRow = {
  id: string
  key: string
  name: string
  size: number
  uploaded?: string
}

type ObjectsResponse = {
  objects: ObjectRow[]
  folders?: string[]
  nextContinuationToken?: string | null
  isTruncated?: boolean
  error?: string
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

function formatDate(value?: string | null): string {
  if (!value) return "Unknown"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Unknown"
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  const normalized = status.toLowerCase()
  if (normalized.includes("failed") || normalized.includes("error")) return "destructive"
  if (normalized === "completed" || normalized === "ok" || normalized === "online") return "default"
  if (normalized === "running" || normalized === "syncing" || normalized === "pending") return "secondary"
  return "outline"
}

export default function BucketAnalyticsPage({
  params,
}: {
  params: Promise<{ name: string }>
}) {
  const resolvedParams = React.use(params)
  const bucketName = decodeURIComponent(resolvedParams.name)
  const [analytics, setAnalytics] = React.useState<AnalyticsResponse | null>(null)
  const [objects, setObjects] = React.useState<ObjectsResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(
    async (quiet = false, signal?: AbortSignal) => {
      if (quiet) setRefreshing(true)
      else setLoading(true)
      try {
        const [analyticsRes, objectsRes] = await Promise.all([
          fetch("/api/dashboard/analytics?range=all", { cache: "no-store", signal }),
          fetch(`/api/storage/buckets/${encodeURIComponent(bucketName)}/objects?maxKeys=50`, {
            cache: "no-store",
            signal,
          }),
        ])
        const analyticsJson = await analyticsRes.json().catch(() => ({}))
        const objectsJson = await objectsRes.json().catch(() => ({}))
        setAnalytics(analyticsJson as AnalyticsResponse)
        setObjects(objectsJson as ObjectsResponse)
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [bucketName]
  )

  React.useEffect(() => {
    const controller = new AbortController()
    void load(false, controller.signal)
    return () => controller.abort()
  }, [load])

  const bucket = analytics?.topBuckets.find((entry) => entry.name === bucketName)
  const sampledObjects = objects?.objects ?? []
  const sampleBytes = sampledObjects.reduce((sum, object) => sum + (object.size ?? 0), 0)
  const largestObject = sampledObjects.reduce<ObjectRow | null>(
    (largest, object) => (!largest || object.size > largest.size ? object : largest),
    null
  )

  if (loading && !analytics) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-96" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/dashboard/analytics">
              <ArrowLeft className="h-4 w-4" />
              Analytics
            </Link>
          </Button>
          <div className="space-y-1">
            <h1 className="break-all text-2xl font-semibold tracking-tight">{bucketName}</h1>
            <p className="text-sm text-muted-foreground">
              Bucket analytics for {analytics?.activeAccount?.label || analytics?.activeAccount?.email || "the active account"}.
            </p>
          </div>
        </div>
        <Button variant="outline" size="icon" onClick={() => void load(true)} disabled={refreshing}>
          <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <MetricCard title="Storage" value={formatBytes(bucket?.bytes)} detail={`Updated ${formatDate(bucket?.updatedAt)}`} icon={HardDrive} />
        <MetricCard title="Objects" value={formatCompact(bucket?.objects)} detail={`${formatNumber(bucket?.objects)} tracked objects`} icon={Database} />
        <MetricCard
          title="Sample"
          value={formatBytes(sampleBytes)}
          detail={`${formatNumber(sampledObjects.length)} listed objects${objects?.isTruncated ? ", more available" : ""}`}
          icon={File}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
            <div>
              <CardTitle>Bucket Status</CardTitle>
              <CardDescription>Current stored stats and object listing snapshot.</CardDescription>
            </div>
            <Badge variant={statusVariant(bucket?.status ?? "unknown")}>{bucket?.status ?? "unknown"}</Badge>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="rounded-md border p-4">
            <div className="text-sm text-muted-foreground">Account</div>
            <div className="mt-1 truncate font-medium">{bucket?.accountLabel ?? "Unknown account"}</div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-sm text-muted-foreground">Largest listed object</div>
            <div className="mt-1 truncate font-medium">{largestObject?.key ?? "No objects listed"}</div>
            <div className="text-xs text-muted-foreground">{largestObject ? formatBytes(largestObject.size) : ""}</div>
          </div>
          <div className="rounded-md border p-4">
            <div className="text-sm text-muted-foreground">Stats error</div>
            <div className="mt-1 truncate font-medium">{bucket?.error || objects?.error || "None"}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Objects</CardTitle>
          <CardDescription>First 50 objects from the active bucket listing.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {sampledObjects.length === 0 ? (
            <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No objects returned for this bucket
            </div>
          ) : (
            sampledObjects.map((object) => (
              <div key={object.id} className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_auto_auto]">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{object.key}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(object.uploaded)}</div>
                </div>
                <div className="text-sm font-medium md:text-right">{formatBytes(object.size)}</div>
                <Badge variant="outline">object</Badge>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function MetricCard({
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
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

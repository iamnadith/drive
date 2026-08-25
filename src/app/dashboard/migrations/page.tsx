"use client"

import * as React from "react"
import { AlertCircle, CheckCircle2, Clock, ExternalLink, Plus, RefreshCw, Play, X } from "lucide-react"
import { useRouter } from "next/navigation"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Account = {
  id: string
  label: string
  email: string
  status: "active" | "available" | "disabled"
}

type BucketSummary = {
  id: string
  name: string
  objects: number
  bytes: number
  statsStatus?: string
  statsError?: string
}

type Migration = {
  id: string
  sourceAccountId: string
  targetAccountId: string
  status: "draft" | "running" | "verifying" | "completed" | "failed" | "canceled"
  options: {
    overwrite?: boolean
    concurrency?: number
    pathPrefix?: string | null
  }
  createdAt: string
  startedAt?: string
  completedAt?: string
  syncStatus?: "idle" | "syncing" | "ok" | "error"
  syncMessage?: string
  summaryItemCount: number
  summaryObjects: number
  summaryBytes: number
  workerSummary: Record<string, unknown>
  detailsCompactedAt?: string
}

type MigrationItem = {
  id: string
  sourceBucket: string
  targetBucket: string
  slurperJobId?: string
  slurperStatus?: string
  progress: Record<string, unknown>
  sourceObjects?: number
  sourceBytes?: number
}

type SlurperProgressResult = {
  objects?: number
  transferredObjects?: number
  skippedObjects?: number
  failedObjects?: number
  status?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function readSlurperResult(progress: Record<string, unknown>): SlurperProgressResult | null {
  const cumulative = progress.slurperCumulative
  if (isRecord(cumulative)) {
    const objects = typeof cumulative.objects === "number" ? cumulative.objects : undefined
    const transferredObjects =
      typeof cumulative.transferredObjects === "number" ? cumulative.transferredObjects : undefined
    const skippedObjects =
      typeof cumulative.skippedObjects === "number" ? cumulative.skippedObjects : undefined
    const failedObjects =
      typeof cumulative.failedObjects === "number" ? cumulative.failedObjects : undefined
    const status = typeof cumulative.status === "string" ? cumulative.status : undefined
    if (objects !== undefined || transferredObjects !== undefined || skippedObjects !== undefined || failedObjects !== undefined || status)
      return { objects, transferredObjects, skippedObjects, failedObjects, status }
  }

  const normalized = progress.slurperNormalized
  if (isRecord(normalized)) {
    const objects = typeof normalized.objects === "number" ? normalized.objects : undefined
    const transferredObjects =
      typeof normalized.transferredObjects === "number" ? normalized.transferredObjects : undefined
    const skippedObjects =
      typeof normalized.skippedObjects === "number" ? normalized.skippedObjects : undefined
    const failedObjects =
      typeof normalized.failedObjects === "number" ? normalized.failedObjects : undefined
    const status = typeof normalized.status === "string" ? normalized.status : undefined
    if (objects !== undefined || transferredObjects !== undefined || skippedObjects !== undefined || failedObjects !== undefined || status)
      return { objects, transferredObjects, skippedObjects, failedObjects, status }
  }

  const slurper = progress.slurper
  if (!isRecord(slurper)) return null
  const result = slurper.result
  if (!isRecord(result)) return null

  const objects = typeof result.objects === "number" ? result.objects : undefined
  const transferredObjects =
    typeof result.transferredObjects === "number" ? result.transferredObjects : undefined
  const skippedObjects =
    typeof result.skippedObjects === "number" ? result.skippedObjects : undefined
  const failedObjects =
    typeof result.failedObjects === "number" ? result.failedObjects : undefined
  const status = typeof result.status === "string" ? result.status : undefined

  return { objects, transferredObjects, skippedObjects, failedObjects, status }
}

function normalizeStatus(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

function isCompletedStatus(value: string | undefined): boolean {
  const s = normalizeStatus(value)
  return (
    s === "completed" ||
    s === "copy_completed" ||
    s === "complete" ||
    s === "finished" ||
    s === "success" ||
    s === "succeeded"
  )
}

function readVerifyStatus(progress: Record<string, unknown>): "pending" | "running" | "ok" | "error" | null {
  if (!isRecord(progress)) return null
  const verify = progress.verify
  if (!isRecord(verify)) return null
  const status = typeof verify.status === "string" ? verify.status : ""
  if (status === "pending" || status === "running" || status === "ok" || status === "error") return status
  return null
}

async function postJsonWithTimeout(input: {
  url: string
  body?: Record<string, unknown>
  timeoutMs?: number
}): Promise<Response> {
  const controller = new AbortController()
  const timeoutMs = Math.max(1_000, Math.min(60_000, input.timeoutMs ?? 12_000))
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input.body ?? {}),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

function formatNumber(value: number | undefined): string {
  if (!value || value <= 0) return "0"
  return Intl.NumberFormat().format(value)
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

function statusBadge(status: string | undefined, syncStatus?: string, syncMessage?: string) {
  const s = String(status ?? "unknown")
  if (s === "verifying" && syncStatus === "error") return <Badge className="bg-red-600">{syncMessage?.toLowerCase().includes("settings sync") ? "Settings sync failed" : "Verification failed"}</Badge>
  if (s === "verifying" && syncMessage?.toLowerCase().includes("syncing settings")) return <Badge className="bg-purple-600">Settings sync</Badge>
  if (s === "completed") return <Badge className="bg-green-600">Completed</Badge>
  if (s === "verifying") return <Badge className="bg-purple-600">Verifying</Badge>
  if (s === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (s === "paused") return <Badge className="bg-yellow-600">Paused</Badge>
  if (s === "failed") return <Badge className="bg-red-600">Failed</Badge>
  if (s === "canceled" || s === "aborted") return <Badge variant="secondary">Canceled</Badge>
  if (s === "draft") return <Badge variant="outline">Draft</Badge>
  if (s === "creating_job") return <Badge className="bg-primary text-primary-foreground">Creating job</Badge>
  if (s === "job_id_pending") return <Badge className="bg-yellow-600">Job pending</Badge>
  if (s === "precheck_failed") return <Badge className="bg-red-600">Precheck failed</Badge>
  if (s.endsWith("_failed") || s.includes("error")) return <Badge className="bg-red-600">Error</Badge>
  return <Badge variant="outline">{s}</Badge>
}

export default function MigrationsPage() {
  const router = useRouter()

  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [migrations, setMigrations] = React.useState<Migration[]>([])
  const [activeMigration, setActiveMigration] = React.useState<Migration | null>(null)
  const [activeItems, setActiveItems] = React.useState<MigrationItem[]>([])
  const [buckets, setBuckets] = React.useState<BucketSummary[]>([])
  const [initialLoading, setInitialLoading] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4500)
    return () => clearTimeout(t)
  }, [error])

  const activeAccount = accounts.find((a) => a.status === "active") ?? null
  const availableTargets = accounts.filter((a) => a.status === "available")

  const [createOpen, setCreateOpen] = React.useState(false)
  const [targetAccountId, setTargetAccountId] = React.useState<string>("")
  const [overwrite, setOverwrite] = React.useState(true)
  const [concurrency, setConcurrency] = React.useState("3")
  const [pathPrefix, setPathPrefix] = React.useState("")
  const [bucketQuery, setBucketQuery] = React.useState("")
  const [selectedBuckets, setSelectedBuckets] = React.useState<Record<string, boolean>>({})
  const [bucketStatsSyncing, setBucketStatsSyncing] = React.useState(false)

  const loadAll = React.useCallback(async () => {
    setError(null)
    try {
      const [accountsRes, migrationsRes, bucketsRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/migrations"),
        fetch("/api/storage/buckets"),
      ])

      const accountsJson: unknown = accountsRes.ok ? await accountsRes.json() : { accounts: [] }
      const migrationsJson: unknown = migrationsRes.ok ? await migrationsRes.json() : { migrations: [] }
      const bucketsJson: unknown = bucketsRes.ok ? await bucketsRes.json() : { buckets: [] }

      const nextAccounts =
        isRecord(accountsJson) && Array.isArray(accountsJson.accounts) ? (accountsJson.accounts as Account[]) : []
      const nextMigrations =
        isRecord(migrationsJson) && Array.isArray(migrationsJson.migrations)
          ? (migrationsJson.migrations as Migration[])
          : []

      setAccounts(nextAccounts)
      setMigrations(nextMigrations)

      const bucketsError =
        isRecord(bucketsJson) && typeof bucketsJson.error === "string" && bucketsJson.error.trim()
          ? bucketsJson.error.trim()
          : null
      if (bucketsError) setError(bucketsError)

      const nextBuckets =
        isRecord(bucketsJson) && Array.isArray(bucketsJson.buckets)
          ? (bucketsJson.buckets as unknown[]).map((b) => {
              const maybe = isRecord(b) ? b : {}
              return {
                id: String(maybe.id ?? maybe.name ?? ""),
                name: String(maybe.name ?? ""),
                objects: typeof maybe.objects === "number" ? (maybe.objects as number) : 0,
                bytes: typeof maybe.bytes === "number" ? (maybe.bytes as number) : 0,
                statsStatus: typeof maybe.statsStatus === "string" ? (maybe.statsStatus as string) : undefined,
                statsError: typeof maybe.statsError === "string" ? (maybe.statsError as string) : undefined,
              } satisfies BucketSummary
            })
          : []
      setBuckets(nextBuckets.filter((b) => b.name.length > 0))

      const current =
        nextMigrations.find((m: Migration) => m.status === "running") ??
        nextMigrations.find((m: Migration) => m.status === "verifying") ??
        nextMigrations.find((m: Migration) => m.status === "draft") ??
        nextMigrations[0] ??
        null

      setActiveMigration(current)
      if (current?.id) {
        const detailsRes = await fetch(`/api/migrations/${encodeURIComponent(current.id)}`)
        const detailsJson: unknown = detailsRes.ok ? await detailsRes.json() : null
        setActiveItems(isRecord(detailsJson) && Array.isArray(detailsJson.items) ? (detailsJson.items as MigrationItem[]) : [])
      } else {
        setActiveItems([])
      }
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to load migrations")
          : "Unable to load migrations"
      setError(message)
    } finally {
      setInitialLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadAll()
  }, [loadAll])

  const needsBucketStats = React.useMemo(() => buckets.some((b) => b.statsStatus && b.statsStatus !== "completed"), [buckets])

  React.useEffect(() => {
    if (!needsBucketStats) return
    let stopped = false

    const tick = async () => {
      if (stopped) return
      setBucketStatsSyncing(true)
      try {
        await fetch("/api/storage/buckets/stats/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxKeysTotal: 5_000 }),
        })
      } catch {
        // ignore
      } finally {
        if (!stopped) setBucketStatsSyncing(false)
      }
      if (!stopped) void loadAll()
    }

    void tick()
    const interval = setInterval(() => void tick(), 3_000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [needsBucketStats, loadAll])

  React.useEffect(() => {
    if (!activeMigration?.id) return

    let cancelled = false
    let es: EventSource | null = null
    let retry = 0

    const connect = () => {
      if (cancelled) return
      try {
        es?.close()
      } catch {
        // ignore
      }

      const streamUrl = `/api/migrations/${encodeURIComponent(activeMigration.id)}/stream`
      es = new EventSource(streamUrl)

      const onSnapshot = (event: MessageEvent) => {
        retry = 0
        try {
          const data: unknown = JSON.parse(String(event.data ?? "{}"))
          if (isRecord(data) && isRecord(data.migration)) setActiveMigration(data.migration as Migration)
          if (isRecord(data) && Array.isArray(data.items)) setActiveItems(data.items as MigrationItem[])
        } catch {
          // ignore
        }
      }

      const onError = () => {
        if (cancelled) return
        try {
          es?.close()
        } catch {
          // ignore
        }
        es = null
        retry += 1
        const delay = Math.min(5_000, 500 + retry * 500)
        setTimeout(connect, delay)
      }

      es.addEventListener("snapshot", onSnapshot)
      es.addEventListener("error", onError)
    }

    connect()
    return () => {
      cancelled = true
      try {
        es?.close()
      } catch {
        // ignore
      }
    }
  }, [activeMigration?.id])

  const syncInFlight = React.useRef(false)
  React.useEffect(() => {
    if (!activeMigration?.id) return
    if (activeMigration.status !== "running" && activeMigration.status !== "verifying" && activeMigration.syncStatus !== "syncing") return

    let stopped = false
    const tick = async () => {
      if (stopped) return
      if (syncInFlight.current) return
      syncInFlight.current = true
      try {
        await postJsonWithTimeout({
          url: `/api/migrations/${encodeURIComponent(activeMigration.id)}/sync`,
          body: { finalizeSettings: true },
          timeoutMs: 10_000,
        }).catch(() => {})
      } catch {
        // ignore
      } finally {
        syncInFlight.current = false
      }
    }

    void tick()
    const interval = setInterval(() => void tick(), 5_000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [activeMigration?.id, activeMigration?.status, activeMigration?.syncStatus])

  const totals = React.useMemo(() => {
    if (activeItems.length === 0 && activeMigration?.detailsCompactedAt) {
      const totalObjects = activeMigration.summaryObjects ?? 0
      return {
        totalObjects,
        transferred: activeMigration.status === "completed" ? totalObjects : 0,
        skipped: 0,
        completed: activeMigration.status === "completed" ? totalObjects : 0,
        percent: activeMigration.status === "completed" ? 100 : 0,
      }
    }
    let totalObjects = 0
    let transferred = 0
    let skipped = 0

    for (const item of activeItems) {
      const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const result = readSlurperResult(item.progress)
      const live = isRecord(progress.live) ? (progress.live as Record<string, unknown>) : null
      const objects = result?.objects
      const transferredObjects = result?.transferredObjects
      const skippedObjects = result?.skippedObjects

      if (live && typeof live.totalObjects === "number") totalObjects += live.totalObjects
      else if (typeof item.sourceObjects === "number") totalObjects += item.sourceObjects
      else if (typeof objects === "number") totalObjects += objects

      if (live && typeof live.transferredObjects === "number") transferred += live.transferredObjects
      else if (typeof transferredObjects === "number") transferred += transferredObjects

      if (live && typeof live.skippedObjects === "number") skipped += live.skippedObjects
      else if (typeof skippedObjects === "number") skipped += skippedObjects
    }

    const completed =
      activeMigration?.status === "completed" && totalObjects > 0
        ? totalObjects
        : totalObjects > 0
          ? Math.min(totalObjects, transferred + skipped)
          : transferred + skipped
    const percent =
      totalObjects > 0
        ? Math.max(0, Math.min(100, (completed / totalObjects) * 100))
        : 0
    return { totalObjects, transferred, skipped, completed, percent }
  }, [activeItems, activeMigration])

  const filteredBuckets = React.useMemo(() => {
    const query = bucketQuery.trim().toLowerCase()
    if (!query) return buckets
    return buckets.filter((b) => b.name.toLowerCase().includes(query))
  }, [bucketQuery, buckets])

  const concurrencyNumber = React.useMemo(() => {
    const n = Number(concurrency)
    if (!Number.isFinite(n)) return 3
    return Math.max(1, Math.min(3, Math.floor(n)))
  }, [concurrency])

  const selectedSummary = React.useMemo(() => {
    const names = Object.entries(selectedBuckets)
      .filter(([, on]) => on)
      .map(([name]) => name)
    const map = new Map(buckets.map((b) => [b.name, b] as const))
    let objects = 0
    let bytes = 0
    for (const name of names) {
      const b = map.get(name)
      if (!b) continue
      objects += b.objects || 0
      bytes += b.bytes || 0
    }
    return { count: names.length, objects, bytes }
  }, [selectedBuckets, buckets])

  const createNewMigration = async () => {
    try {
      const parsedConcurrency = Number(concurrency)
      const chosen = Object.entries(selectedBuckets)
        .filter(([, on]) => on)
        .map(([name]) => name)

      if (
        chosen.length > 0 &&
        typeof window !== "undefined" &&
        !window.confirm(
          `Start a migration for ${chosen.length} selected bucket${chosen.length === 1 ? "" : "s"}?`
        )
      ) {
        return
      }

      setBusyAction("create")
      setError(null)

      const res = await fetch("/api/migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetAccountId,
          overwrite,
          concurrency: Number.isFinite(parsedConcurrency) ? parsedConcurrency : 3,
          pathPrefix: pathPrefix.trim() ? pathPrefix.trim() : undefined,
          includeBuckets: chosen,
        }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage =
        isRecord(json) && typeof json.error === "string" ? json.error : "Unable to create migration"
      if (!res.ok) throw new Error(errorMessage)

      setCreateOpen(false)
      setBucketQuery("")
      setSelectedBuckets({})
      await loadAll()
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to create migration")
          : "Unable to create migration"
      setError(message)
    } finally {
      setBusyAction(null)
    }
  }

  const startMigration = async () => {
    if (!activeMigration?.id) return
    setBusyAction("start")
    setError(null)
    try {
      const res = await fetch(`/api/migrations/${encodeURIComponent(activeMigration.id)}/start?async=1`, {
        method: "POST",
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage =
        isRecord(json) && typeof json.error === "string" ? json.error : "Unable to start migration"
      if (!res.ok) throw new Error(errorMessage)
      await fetch(`/api/migrations/${encodeURIComponent(activeMigration.id)}/sync`, { method: "POST" }).catch(() => {})
      await loadAll()
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to start migration")
          : "Unable to start migration"
      setError(message)
    } finally {
      setBusyAction(null)
    }
  }

  const syncNow = async () => {
    if (!activeMigration?.id) return
    setBusyAction("sync")
    setError(null)
    try {
      const res = await postJsonWithTimeout({
        url: `/api/migrations/${encodeURIComponent(activeMigration.id)}/sync`,
        body: {},
        timeoutMs: 12_000,
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to sync migration"
      if (!res.ok) throw new Error(errorMessage)
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "name" in e && String((e as { name?: unknown }).name) === "AbortError"
          ? ""
          : typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to sync migration")
          : "Unable to sync migration"
      if (message) setError(message)
    } finally {
      setBusyAction(null)
    }
  }

  const retryMigration = async () => {
    if (!activeMigration?.id) return
    setBusyAction("retry_migration")
    setError(null)
    try {
      const res = await postJsonWithTimeout({
        url: `/api/migrations/${encodeURIComponent(activeMigration.id)}/action`,
        body: { action: "retry_migration" },
        timeoutMs: 12_000,
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to retry migration"
      if (!res.ok) throw new Error(errorMessage)
      await fetch(`/api/migrations/${encodeURIComponent(activeMigration.id)}/sync`, { method: "POST" }).catch(() => {})
      await loadAll()
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "name" in e && String((e as { name?: unknown }).name) === "AbortError"
          ? ""
          : typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to retry migration")
          : "Unable to retry migration"
      if (message) setError(message)
    } finally {
      setBusyAction(null)
    }
  }

  const canRunVerifyAll = React.useMemo(() => {
    if (!activeMigration) return false
    if (activeMigration.status !== "completed" && activeMigration.status !== "verifying") return false
    return activeItems.some((item) => {
      if (!isCompletedStatus(item.slurperStatus)) return false
      const v = readVerifyStatus(item.progress)
      return v === null || v === "error"
    })
  }, [activeMigration, activeItems])

  const runVerifyAll = async () => {
    if (!activeMigration?.id) return
    setBusyAction("verify_all")
    setError(null)
    try {
      const res = await postJsonWithTimeout({
        url: `/api/migrations/${encodeURIComponent(activeMigration.id)}/action`,
        body: { action: "verify_all" },
        timeoutMs: 12_000,
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to start verification"
      if (!res.ok) throw new Error(errorMessage)
      await fetch(`/api/migrations/${encodeURIComponent(activeMigration.id)}/sync`, { method: "POST" }).catch(() => {})
      await loadAll()
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "name" in e && String((e as { name?: unknown }).name) === "AbortError"
          ? ""
          : typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to start verification")
          : "Unable to start verification"
      if (message) setError(message)
    } finally {
      setBusyAction(null)
    }
  }

  const hasActiveCard = Boolean(activeMigration)

  if (initialLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-8 w-44" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-36" />
        </div>
        <Skeleton className="h-[220px] w-full" />
        <Skeleton className="h-[260px] w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Migrations</h1>
          <p className="text-sm text-muted-foreground">Cloudflare Super Slurper (Cloudflare-run)</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} disabled={Boolean(busyAction) || !activeAccount || availableTargets.length === 0}>
          <Plus className="h-4 w-4 mr-0" />
          New migration
        </Button>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent
          showCloseButton={false}
          className="!w-[min(96vw,1180px)] sm:!w-[min(96vw,1180px)] !max-w-[1180px] sm:!max-w-[1180px] max-h-[85vh] p-0 overflow-hidden flex flex-col"
        >
          <div className="border-b px-6 py-5">
            <div className="flex items-start justify-between gap-4">
                <DialogHeader className="flex-1">
                  <DialogTitle>Create migration</DialogTitle>
                  <DialogDescription>Pick a destination account and optionally choose buckets to migrate.</DialogDescription>
                </DialogHeader>
              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  className="h-9 px-2.5"
                  onClick={createNewMigration}
                  loading={busyAction === "create"}
                  disabled={
                    busyAction === "create" ||
                    !activeAccount ||
                    availableTargets.length === 0 ||
                    !targetAccountId
                  }
                >
                  Create migration
                </Button>
                <DialogClose asChild>
                  <button
                    type="button"
                    aria-label="Close"
                    className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-destructive/15 text-destructive hover:bg-destructive/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </DialogClose>
              </div>
            </div>
          </div>

          <div className="grid md:grid-cols-6 overflow-hidden flex-1 min-h-0">
            <div className="md:col-span-2 p-6 space-y-5 overflow-auto min-h-0">
              <div className="space-y-2">
                <Label>Destination account</Label>
                <Select value={targetAccountId} onValueChange={setTargetAccountId}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Select destination..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableTargets.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.label} ({a.email})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Source: {activeAccount ? `${activeAccount.label} (${activeAccount.email})` : "No active account"}
                </p>
              </div>

              <Separator />

              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <Label>Overwrite on destination</Label>
                  <p className="text-xs text-muted-foreground">Replace target objects when keys already exist.</p>
                </div>
                <Switch checked={overwrite} onCheckedChange={setOverwrite} />
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>Concurrency</Label>
                  <span className="text-xs text-muted-foreground font-mono">{concurrencyNumber}/3</span>
                </div>
                <div className="flex items-center gap-3">
                  <Slider
                    min={1}
                    max={3}
                    step={1}
                    value={[concurrencyNumber]}
                    onValueChange={(v) => setConcurrency(String(v[0] ?? 3))}
                  />
                  <Input
                    className="w-16 h-10 text-center font-mono"
                    value={String(concurrencyNumber)}
                    onChange={(e) => setConcurrency(e.target.value)}
                    inputMode="numeric"
                  />
                </div>
                <p className="text-xs text-muted-foreground">Cloudflare allows up to 3 concurrent Super Slurper jobs.</p>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label>Path prefix (optional)</Label>
                <Input className="h-11" value={pathPrefix} onChange={(e) => setPathPrefix(e.target.value)} placeholder="e.g. backups/" />
                <p className="text-xs text-muted-foreground">Only migrate objects under this prefix.</p>
              </div>
            </div>

            <div className="md:col-span-4 border-t md:border-t-0 md:border-l p-6 overflow-hidden flex flex-col gap-4 min-h-0">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <Label>Buckets</Label>
                  <p className="text-xs text-muted-foreground">
                    {selectedSummary.count} selected • {formatNumber(selectedSummary.objects)} objects • {formatBytes(selectedSummary.bytes)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const next: Record<string, boolean> = {}
                      for (const b of buckets) next[b.name] = true
                      setSelectedBuckets(next)
                    }}
                  >
                    Select all
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setSelectedBuckets({})}>
                    Clear
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={bucketQuery}
                  onChange={(e) => setBucketQuery(e.target.value)}
                  placeholder="Search buckets..."
                  className="h-11 flex-1"
                />
                {needsBucketStats ? (
                  <div className="text-xs text-muted-foreground">
                    {bucketStatsSyncing ? "Calculating bucket stats..." : "Waiting for bucket stats..."}
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border overflow-hidden flex-1 min-h-0">
                <ScrollArea className="h-full pr-2" hideScrollbar>
                  <Table className="table-fixed w-full min-w-[620px]">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="sticky top-0 z-10 bg-background w-[48px]" />
                        <TableHead className="sticky top-0 z-10 bg-background">Bucket</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background w-[120px] text-center">Objects</TableHead>
                        <TableHead className="sticky top-0 z-10 bg-background w-[120px] text-center">Size</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredBuckets.map((b) => {
                        const checked = Boolean(selectedBuckets[b.name])
                        return (
                          <TableRow
                            key={b.name}
                            className="cursor-pointer hover:bg-muted/40"
                            onClick={() => {
                              setSelectedBuckets((prev) => {
                                const next = { ...prev }
                                if (next[b.name]) delete next[b.name]
                                else next[b.name] = true
                                return next
                              })
                            }}
                          >
                            <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) => {
                                  setSelectedBuckets((prev) => {
                                    const next = { ...prev }
                                    if (v) next[b.name] = true
                                    else delete next[b.name]
                                    return next
                                  })
                                }}
                              />
                            </TableCell>
                            <TableCell className="font-medium">{b.name}</TableCell>
                            <TableCell className="text-center">
                              <div className="flex flex-col items-center">
                                <span>{formatNumber(b.objects)}</span>
                                {b.statsStatus && b.statsStatus !== "completed" ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    {b.statsStatus === "error" ? "Error" : bucketStatsSyncing ? "Calculating..." : "Pending..."}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-center">
                              <div className="flex flex-col items-center">
                                <span>{formatBytes(b.bytes)}</span>
                                {b.statsStatus && b.statsStatus !== "completed" ? (
                                  <span className="text-[11px] text-muted-foreground">
                                    {b.statsStatus === "error" ? "Error" : bucketStatsSyncing ? "Calculating..." : "Pending..."}
                                  </span>
                                ) : null}
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">
                  Review selection, then create the migration record. If no buckets are selected, starting it will only switch the active account.
                </p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="space-y-6">
        {hasActiveCard ? (
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-4">
                <CardTitle className="text-lg">
                  {activeMigration?.status === "running" || activeMigration?.status === "verifying"
                    ? "Active migration"
                    : "Latest migration"}
                </CardTitle>
                {statusBadge(activeMigration?.status, activeMigration?.syncStatus, activeMigration?.syncMessage)}
              </div>
              <CardDescription>
                {activeMigration ? (
                  <span className="text-xs">
                    ID <span className="font-mono">{activeMigration.id}</span>{" "}
                    {activeMigration.syncMessage ? `- ${activeMigration.syncMessage}` : ""}
                  </span>
                ) : null}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span>Progress</span>
                  <span className="font-medium">{totals.percent.toFixed(1)}%</span>
                </div>
                <Progress value={totals.percent} className="h-2" />
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {formatNumber(totals.transferred)} transferred
                    {totals.skipped > 0 ? `, ${formatNumber(totals.skipped)} skipped` : ""}
                  </span>
                  <span>{formatNumber(totals.totalObjects)} total objects</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={activeMigration?.status === "failed" ? retryMigration : startMigration}
                  loading={busyAction === "start" || busyAction === "retry_migration"}
                  disabled={Boolean(busyAction) || (activeMigration?.status !== "draft" && activeMigration?.status !== "failed")}
                >
                  {busyAction !== "start" && busyAction !== "retry_migration" ? (
                    <Play className="h-4 w-4 mr-0" />
                  ) : null}
                  {activeMigration?.status === "failed" ? "Retry" : "Start"}
                </Button>
                <Button onClick={syncNow} loading={busyAction === "sync"} variant="outline" disabled={Boolean(busyAction)}>
                  {busyAction !== "sync" ? <RefreshCw className="h-4 w-4 mr-0" /> : null}
                  Sync now
                </Button>
                {activeMigration ? (
                  <Button
                    onClick={() => router.push(`/dashboard/migrations/${encodeURIComponent(activeMigration.id)}`)}
                    variant="outline"
                    disabled={Boolean(busyAction)}
                  >
                    <ExternalLink className="h-4 w-4 mr-0" />
                    Details
                  </Button>
                ) : null}
                {canRunVerifyAll ? (
                  <Button onClick={runVerifyAll} loading={busyAction === "verify_all"} variant="outline" disabled={Boolean(busyAction)}>
                    {busyAction !== "verify_all" ? <CheckCircle2 className="h-4 w-4 mr-0" /> : null}
                    Verify all buckets
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-1">
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle className="text-lg">Recent Migrations</CardTitle>
                <CardDescription>Latest 3 migrations.</CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => router.push("/dashboard/migrations/history")}
                disabled={Boolean(busyAction) || migrations.length === 0}
              >
                View all
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {migrations.length === 0 ? (
              <div className="text-sm text-muted-foreground">No migrations yet</div>
            ) : (
              migrations.slice(0, 3).map((m) => {
                const isVerificationFailed = m.status === "verifying" && m.syncStatus === "error"
                const icon =
                  m.status === "completed" ? (
                    <CheckCircle2 className="h-5 w-5 text-green-600" />
                  ) : isVerificationFailed ? (
                    <AlertCircle className="h-5 w-5 text-red-600" />
                  ) : m.status === "verifying" ? (
                    <Clock className="h-5 w-5 text-purple-600" />
                  ) : m.status === "running" ? (
                    <Clock className="h-5 w-5 text-primary" />
                  ) : m.status === "failed" ? (
                    <AlertCircle className="h-5 w-5 text-red-600" />
                  ) : (
                    <Clock className="h-5 w-5 text-muted-foreground" />
                  )
                return (
                  <div key={m.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
                    <div className="flex gap-3">
                      {icon}
                      <div className="space-y-1">
                        <div className="text-sm font-medium">
                          {isVerificationFailed ? "verification_failed" : m.status}
                        </div>
                        <div className="text-xs text-muted-foreground font-mono">{m.id}</div>
                        <div className="text-xs text-muted-foreground">{new Date(m.createdAt).toLocaleString()}</div>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {(m.syncMessage ?? "").trim().length > 0 ? (
                        <div className="text-xs text-muted-foreground line-clamp-2 max-w-[280px] text-right">
                          {m.syncMessage}
                        </div>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => router.push(`/dashboard/migrations/${encodeURIComponent(m.id)}`)}>
                        Details
                      </Button>
                    </div>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}





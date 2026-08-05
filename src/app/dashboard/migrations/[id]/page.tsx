"use client"

import * as React from "react"
import { useParams, useRouter } from "next/navigation"
import {
  AlertCircle,
  CheckCircle2,
  CircleX,
  Clock,
  GripVertical,
  Pause,
  Play,
  RefreshCw,
  ScrollText,
  Square,
  ShieldCheck,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  getBucketDisplayStatusRank,
  getMergedBucketSnapshot,
  getItemDisplayStatus,
  getItemStatus,
  isAbortedStatus,
  isCompletedStatus,
  isFailedLikeStatus,
  isTerminalBucketDisplayStatus,
  isRecord,
  normalizeStatus,
  readLiveBucketState,
  readRepairWorkerState,
  readSlurperResult,
  readVerifyState,
} from "@/lib/migration-bucket-state"
import { cn } from "@/lib/utils"

type Account = {
  id: string
  label: string
  email: string
  status: "active" | "available" | "disabled"
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
    manualCompleted?: boolean
    targetActivatedAt?: string
  }
  createdAt: string
  startedAt?: string
  completedAt?: string
  syncStatus?: "idle" | "syncing" | "ok" | "error"
  syncMessage?: string
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

type FailedObjectDiagnostic = {
  key: string
  message: string
  at?: string | null
  source: {
    exists: boolean | null
    size?: number
    etag?: string
    lastModified?: string
    contentType?: string
    readable?: boolean | null
    error?: string
  }
  destination: {
    exists: boolean | null
    size?: number
    etag?: string
    lastModified?: string
    contentType?: string
    readable?: boolean | null
    error?: string
  }
  diagnosis: {
    category: string
    reason: string
    recommendation: string
  }
  download?: {
    source?: string | null
    destination?: string | null
  }
}

type FailedDiagnosticsBucket = {
  missing?: boolean
  item: {
    id: string
    sourceBucket: string
    targetBucket: string
    jobId?: string | null
  }
  summary: {
    totalFailedEntries: number
    detailedFailedEntries?: number
    cloudflareDetailedEntries?: number
    fallbackDetailedEntries?: number
    inferredDetailedEntries?: number
    missingDetailedEntries?: number
    sourceMissing: number
    sourceAccessIssues: number
    destinationExists: number
    transientOrProviderIssues: number
    unknown: number
  }
  failures: FailedObjectDiagnostic[]
}

type WorkerOption = {
  id: string
  name: string
  provider: "github_actions" | "self_hosted" | "local"
  status: string
  capabilities: string[]
}

type RepairJob = {
  id: string
  migrationId: string
  requestedByAgentId?: string
  claimedByAgentId?: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  mode: "verify_only" | "repair_and_verify"
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  result: Record<string, unknown>
  summary?: string
  error?: string
  claimedAt?: string
  startedAt?: string
  completedAt?: string
  lastHeartbeatAt?: string
  createdAt: string
  updatedAt: string
}

function readRepairTotals(job: RepairJob | null | undefined): {
  transferred: number
  failed: number
  skipped: number
  missing: number
  mismatched: number
} {
  const resultTotals = job && isRecord(job.result) && isRecord(job.result.totals) ? (job.result.totals as Record<string, unknown>) : null
  const progressTotals = job && isRecord(job.progress) && isRecord(job.progress.totals) ? (job.progress.totals as Record<string, unknown>) : null
  const totals = resultTotals ?? progressTotals
  const base = {
    transferred: totals && typeof totals.transferred === "number" ? totals.transferred : 0,
    failed: totals && typeof totals.failed === "number" ? totals.failed : 0,
    skipped: totals && typeof totals.skipped === "number" ? totals.skipped : 0,
    missing: totals && typeof totals.missing === "number" ? totals.missing : 0,
    mismatched: totals && typeof totals.mismatched === "number" ? totals.mismatched : 0,
  }

  const itemTotals = readRepairItems(job).reduce<{
    transferred: number
    failed: number
    skipped: number
    missing: number
    mismatched: number
  }>(
    (sum, item) => ({
      transferred: sum.transferred + (typeof item.transferred === "number" ? item.transferred : 0),
      failed: sum.failed + (typeof item.failed === "number" ? item.failed : 0),
      skipped: sum.skipped + (typeof item.skipped === "number" ? item.skipped : 0),
      missing: sum.missing + (typeof item.finalMissing === "number" ? item.finalMissing : 0),
      mismatched: sum.mismatched + (typeof item.finalMismatched === "number" ? item.finalMismatched : 0),
    }),
    { transferred: 0, failed: 0, skipped: 0, missing: 0, mismatched: 0 }
  )

  return {
    transferred: Math.max(base.transferred, itemTotals.transferred),
    failed: Math.max(base.failed, itemTotals.failed),
    skipped: Math.max(base.skipped, itemTotals.skipped),
    missing: Math.max(base.missing, itemTotals.missing),
    mismatched: Math.max(base.mismatched, itemTotals.mismatched),
  }
}

function readRepairItems(job: RepairJob | null | undefined): Array<Record<string, unknown>> {
  if (!job) return []
  if (isRecord(job.result) && Array.isArray(job.result.items)) return job.result.items.filter(isRecord)
  if (isRecord(job.progress) && Array.isArray(job.progress.itemProgress)) return job.progress.itemProgress.filter(isRecord)
  if (isRecord(job.result) && Array.isArray(job.result.itemProgress)) return job.result.itemProgress.filter(isRecord)
  return []
}

function getEffectiveSourceBytes(
  item: MigrationItem,
  repairResultItem?: Record<string, unknown>,
  repairState?: ReturnType<typeof readRepairWorkerState> | null
): number {
  if (repairResultItem && typeof repairResultItem.sourceBytes === "number") return repairResultItem.sourceBytes
  if (repairState?.details && typeof repairState.details.sourceBytes === "number") return Number(repairState.details.sourceBytes)
  return typeof item.sourceBytes === "number" ? item.sourceBytes : 0
}

function formatNumber(value: number | undefined): string {
  if (!value || value <= 0) return "0"
  return Intl.NumberFormat().format(value)
}

function formatDate(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
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

function statusBadge(
  status: string | undefined,
  opts?: { hadProgress?: boolean; syncStatus?: string }
) {
  const s = String(status ?? "unknown")
  if (s === "verifying" && opts?.syncStatus === "error") {
    return <Badge className="bg-red-600">Verification failed</Badge>
  }
  if (s === "completed") return <Badge className="bg-green-600">Completed</Badge>
  if (s === "verifying") return <Badge className="bg-purple-600">Verifying</Badge>
  if (s === "scanning") return <Badge className="bg-sky-600">Scanning</Badge>
  if (s === "queued") return <Badge variant="secondary">Queued</Badge>
  if (s === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (s === "progress_fetch_failed") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (s === "paused") return <Badge className="bg-yellow-600">Paused</Badge>
  if (s === "failed") return <Badge className="bg-red-600">Failed</Badge>
  if (s === "verification_failed") return <Badge className="bg-red-600">Verification failed</Badge>
  if (s === "no_files") return <Badge className="bg-green-600">Completed</Badge>
  if (s === "canceled" || s === "aborted" || s === "copy_aborted") {
    const hadProgress = Boolean(opts?.hadProgress)
    return <Badge variant="secondary">{hadProgress ? "Aborted" : "Canceled"}</Badge>
  }
  if (s === "draft") return <Badge variant="outline">Draft</Badge>
  if (s === "creating_job") return <Badge className="bg-primary text-primary-foreground">Creating job</Badge>
  if (s === "job_id_pending") return <Badge className="bg-yellow-600">Job pending</Badge>
  if (s === "precheck_failed") return <Badge className="bg-red-600">Precheck failed</Badge>
  if (s.endsWith("_failed") || s.includes("error")) return <Badge className="bg-red-600">Error</Badge>
  return <Badge variant="outline">{s}</Badge>
}

function repairJobBadge(status: RepairJob["status"] | undefined) {
  if (status === "completed") return <Badge className="bg-green-600">Worker completed</Badge>
  if (status === "running") return <Badge className="bg-primary text-primary-foreground">Worker running</Badge>
  if (status === "claimed") return <Badge className="bg-sky-600">Worker claimed</Badge>
  if (status === "pending") return <Badge variant="secondary">Worker queued</Badge>
  if (status === "failed") return <Badge className="bg-red-600">Worker failed</Badge>
  if (status === "canceled") return <Badge variant="outline">Worker aborted</Badge>
  return <Badge variant="outline">No worker run</Badge>
}

function formatRepairMode(mode: RepairJob["mode"] | string | undefined): string {
  if (mode === "repair_and_verify") return "Repair and verify"
  if (mode === "verify_only") return "Verify only"
  if (mode === "repair_only") return "Repair only"
  return String(mode || "-").replace(/_/g, " ")
}

function formatRepairStage(stage: string | undefined): string {
  const value = String(stage || "").trim()
  if (!value) return "-"
  return value.replace(/_/g, " ")
}

function mergeIncomingItem(prev: MigrationItem | undefined, next: MigrationItem): MigrationItem {
  if (!prev) return next

  const prevProgress = isRecord(prev.progress) ? (prev.progress as Record<string, unknown>) : {}
  const nextProgress = isRecord(next.progress) ? (next.progress as Record<string, unknown>) : {}
  const prevLive = readLiveBucketState(prevProgress)
  const nextLive = readLiveBucketState(nextProgress)

  if (!prevLive || !nextLive) return next

  const sameSlurperJob = (prevLive.slurperJobId ?? prev.slurperJobId ?? null) === (nextLive.slurperJobId ?? next.slurperJobId ?? null)
  const sameRepairJob = (prevLive.repairJobId ?? null) === (nextLive.repairJobId ?? null)
  const sameCycle = Boolean(prevLive.slurperJobId || prevLive.repairJobId || nextLive.slurperJobId || nextLive.repairJobId) && sameSlurperJob && sameRepairJob
  if (!sameCycle) return next

  const prevUpdatedAt = prevLive.updatedAt ? Date.parse(prevLive.updatedAt) : NaN
  const nextUpdatedAt = nextLive.updatedAt ? Date.parse(nextLive.updatedAt) : NaN
  if (Number.isFinite(prevUpdatedAt) && Number.isFinite(nextUpdatedAt) && nextUpdatedAt < prevUpdatedAt) {
    return prev
  }

  const mergedLive = {
    ...nextLive,
    totalObjects: nextLive.totalObjects,
    transferredObjects: isTerminalBucketDisplayStatus(nextLive.status)
      ? nextLive.transferredObjects
      : Math.max(prevLive.transferredObjects, nextLive.transferredObjects),
    skippedObjects: isTerminalBucketDisplayStatus(nextLive.status)
      ? nextLive.skippedObjects
      : Math.max(prevLive.skippedObjects, nextLive.skippedObjects),
    failedObjects: isTerminalBucketDisplayStatus(nextLive.status)
      ? nextLive.failedObjects
      : Math.max(prevLive.failedObjects, nextLive.failedObjects),
    verifyIssues: isTerminalBucketDisplayStatus(nextLive.status)
      ? nextLive.verifyIssues
      : Math.max(prevLive.verifyIssues, nextLive.verifyIssues),
  }

  if (isTerminalBucketDisplayStatus(prevLive.status) && !isTerminalBucketDisplayStatus(nextLive.status)) {
    mergedLive.status = prevLive.status
  } else if (
    !isTerminalBucketDisplayStatus(prevLive.status) &&
    !isTerminalBucketDisplayStatus(nextLive.status) &&
    normalizeStatus(nextLive.status) !== "queued" &&
    getBucketDisplayStatusRank(prevLive.status) > getBucketDisplayStatusRank(nextLive.status)
  ) {
    mergedLive.status = prevLive.status
  }

  return {
    ...next,
    progress: {
      ...nextProgress,
      live: {
        ...(nextProgress.live && isRecord(nextProgress.live) ? (nextProgress.live as Record<string, unknown>) : {}),
        ...mergedLive,
      },
    },
  }
}

function mergeIncomingItems(prevItems: MigrationItem[], nextItems: MigrationItem[]): MigrationItem[] {
  const prevById = new Map(prevItems.map((item) => [item.id, item]))
  return nextItems.map((item) => mergeIncomingItem(prevById.get(item.id), item))
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

function mergeItemLogs(item: MigrationItem | null): string {
  if (!item) return "Select a bucket to view logs."
  const logs = isRecord(item.progress) ? (item.progress as Record<string, unknown>).logs : undefined
  if (!logs) {
    const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
    const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
    const verifySamples = isRecord(progress.verifySamples) ? (progress.verifySamples as Record<string, unknown>) : null
    const hasVerifyInfo =
      (typeof progress.error === "string" && progress.error.trim().length > 0) ||
      (verify && typeof verify.status === "string") ||
      Boolean(verifySamples)

    if (hasVerifyInfo) {
      const dump: Record<string, unknown> = {
        status: getItemDisplayStatus(item) ?? getItemStatus(item) ?? null,
        error: progress.error ?? progress.lastError ?? null,
        verify: verify ?? null,
        verifySamples: verifySamples ?? null,
      }
      try {
        return JSON.stringify(dump, null, 2)
      } catch {
        return String(dump)
      }
    }

    return 'No logs fetched yet. Use "Logs" on a bucket row.'
  }
  try {
    return JSON.stringify(logs, null, 2)
  } catch {
    return String(logs)
  }
}

function buildMigrationLogDump(items: MigrationItem[]): string {
  const chunks: string[] = []
  for (const item of items) {
    const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
    const events = Array.isArray(progress.events) ? progress.events : null
    const entry: Record<string, unknown> = {
      bucket: item.sourceBucket,
      jobId: item.slurperJobId ?? null,
      status: getItemDisplayStatus(item) ?? getItemStatus(item) ?? null,
      lastProgressAt: progress.lastProgressAt ?? null,
      stage: progress.stage ?? null,
      error: progress.error ?? progress.lastError ?? null,
      events,
      logs: progress.logs ?? null,
    }

    // Only include entries that have something interesting.
    const hasInteresting =
      Boolean(entry.jobId) ||
      Boolean(entry.error) ||
      Boolean(entry.logs) ||
      String(entry.status ?? "").toLowerCase() === "precheck_failed" ||
      String(entry.status ?? "").toLowerCase().includes("failed") ||
      String(entry.status ?? "").toLowerCase().includes("error")

    if (!hasInteresting) continue

    chunks.push(JSON.stringify(entry, null, 2))
  }

  if (chunks.length === 0) return "No logs yet."
  return chunks.join("\n\n---\n\n")
}

function mergeItemLogsFull(item: MigrationItem | null): string {
  if (!item) return "Select a bucket to view logs."
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const events = Array.isArray(progress.events) ? progress.events : []
  const dump: Record<string, unknown> = {
    bucket: item.sourceBucket,
    jobId: item.slurperJobId ?? null,
    status: getItemDisplayStatus(item) ?? getItemStatus(item) ?? null,
    events,
    cloudflareLogs: progress.logs ?? null,
    slurper: progress.slurper ?? null,
  }
  try {
    return JSON.stringify(dump, null, 2)
  } catch {
    return String(dump)
  }
}

type LogLine = {
  at: number
  atIso: string
  bucket: string
  stage: string
  status: string
  message: string
}

function collectLogLines(items: MigrationItem[]): LogLine[] {
  const lines: LogLine[] = []

  for (const item of items) {
    const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
    const bucket = item.sourceBucket
    const events = Array.isArray(progress.events) ? (progress.events as unknown[]) : []

    for (const event of events) {
      if (!isRecord(event)) continue
      const atIso = typeof event.at === "string" ? event.at : ""
      const at = atIso ? Date.parse(atIso) : NaN
      if (!Number.isFinite(at)) continue
      const stage = typeof event.stage === "string" ? event.stage : ""
      const status = typeof event.status === "string" ? event.status : String(event.status ?? "")
      const message = typeof event.message === "string" ? event.message : ""
      lines.push({ at, atIso, bucket, stage, status, message })
    }

    if (events.length === 0) {
      const stage = typeof progress.stage === "string" ? progress.stage : ""
      const status = String(getItemDisplayStatus(item) ?? getItemStatus(item) ?? "")
      const message =
        typeof progress.error === "string"
          ? (progress.error as string)
          : typeof progress.lastError === "string"
            ? (progress.lastError as string)
            : ""
      if (stage || status || message) {
        const atIso =
          typeof progress.lastProgressAt === "string"
            ? (progress.lastProgressAt as string)
            : new Date().toISOString()
        const at = Date.parse(atIso)
        lines.push({ at, atIso, bucket, stage, status, message })
      }
    }
  }

  lines.sort((a, b) => a.at - b.at)
  return lines
}

function formatLogTime(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso
  return new Date(t).toLocaleString()
}

function ProgressStacked({
  transferredPct,
  skippedPct,
  failedPct,
  unaccountedPct,
}: {
  transferredPct: number
  skippedPct: number
  failedPct: number
  unaccountedPct: number
}) {
  const safeTransferred = Number.isFinite(transferredPct) ? Math.max(0, Math.min(100, transferredPct)) : 0
  const safeSkipped = Number.isFinite(skippedPct) ? Math.max(0, Math.min(100 - safeTransferred, skippedPct)) : 0
  const safeFailed = Number.isFinite(failedPct)
    ? Math.max(0, Math.min(100 - safeTransferred - safeSkipped, failedPct))
    : 0
  const safeUnaccounted = Number.isFinite(unaccountedPct)
    ? Math.max(0, Math.min(100 - safeTransferred - safeSkipped - safeFailed, unaccountedPct))
    : 0
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="flex h-full w-full">
        <div className="h-full bg-primary" style={{ width: `${safeTransferred}%` }} />
        <div className="h-full bg-yellow-500" style={{ width: `${safeSkipped}%` }} />
        <div className="h-full bg-red-500" style={{ width: `${safeFailed}%` }} />
        <div className="h-full bg-muted-foreground/45" style={{ width: `${safeUnaccounted}%` }} />
      </div>
    </div>
  )
}

function formatDiagnosticCategory(category: string | undefined): string {
  const value = String(category || "").trim()
  if (!value) return "Unclassified"
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function diagnosticCategoryTone(category: string | undefined): string {
  return "text-foreground border-border bg-muted/50"
}

function StickyScrollPanel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "min-h-0 overflow-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {children}
    </div>
  )
}

function PinnedScrollableTable({
  children,
  className,
  maxHeightClassName = "max-h-[34rem]",
}: {
  children: React.ReactNode
  className?: string
  maxHeightClassName?: string
}) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const horizontalRef = React.useRef<HTMLDivElement | null>(null)
  const [sizes, setSizes] = React.useState({ scrollWidth: 0, clientWidth: 0 })

  React.useEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const update = () => {
      const next = {
        scrollWidth: Math.max(viewport.scrollWidth, content.scrollWidth),
        clientWidth: viewport.clientWidth,
      }
      setSizes((prev) => (prev.scrollWidth === next.scrollWidth && prev.clientWidth === next.clientWidth ? prev : next))
    }

    update()
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => update()) : null
    resizeObserver?.observe(viewport)
    resizeObserver?.observe(content)
    window.addEventListener("resize", update)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [children])

  const syncFromViewport = React.useCallback(() => {
    if (!viewportRef.current || !horizontalRef.current) return
    if (horizontalRef.current.scrollLeft !== viewportRef.current.scrollLeft) {
      horizontalRef.current.scrollLeft = viewportRef.current.scrollLeft
    }
  }, [])

  const syncFromBar = React.useCallback(() => {
    if (!viewportRef.current || !horizontalRef.current) return
    if (viewportRef.current.scrollLeft !== horizontalRef.current.scrollLeft) {
      viewportRef.current.scrollLeft = horizontalRef.current.scrollLeft
    }
  }, [])

  const showHorizontal = sizes.scrollWidth > sizes.clientWidth + 1

  return (
    <div className={cn("min-h-0", className)}>
      <div
        ref={viewportRef}
        className={cn(
          "overflow-x-scroll overflow-y-auto overscroll-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          maxHeightClassName
        )}
        onScroll={syncFromViewport}
      >
        <div ref={contentRef} className="min-w-fit">
          {children}
        </div>
      </div>
      <div className="sticky bottom-0 z-20 border-t bg-background/95 supports-[backdrop-filter]:bg-background/80">
        {showHorizontal ? (
          <div
            ref={horizontalRef}
            className="overflow-x-scroll overflow-y-hidden px-0 py-0 [scrollbar-width:thin] [scrollbar-color:#0b0b0c_#d4d4d8] dark:[scrollbar-color:#f4f4f5_#27272a] [&::-webkit-scrollbar]:h-3 [&::-webkit-scrollbar-track]:bg-neutral-200 dark:[&::-webkit-scrollbar-track]:bg-neutral-900 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-neutral-950 dark:[&::-webkit-scrollbar-thumb]:bg-neutral-100"
            onScroll={syncFromBar}
          >
            <div style={{ width: sizes.scrollWidth, height: 1 }} />
          </div>
        ) : (
          <div className="h-3" />
        )}
      </div>
    </div>
  )
}

const DIAGNOSTICS_TABLE_GRID_TEMPLATE = "340px 280px 180px 180px 220px 180px minmax(320px, 1fr)"

export default function MigrationDetailsPage() {
  const ACTIVE_SYNC_INTERVAL_MS = 8_000
  const MIN_SYNC_GAP_MS = 6_000
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = typeof params?.id === "string" ? params.id : ""

  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [migration, setMigration] = React.useState<Migration | null>(null)
  const [items, setItems] = React.useState<MigrationItem[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [initialLoading, setInitialLoading] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [busyItemAction, setBusyItemAction] = React.useState<Record<string, string>>({})
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [manualCompleteOpen, setManualCompleteOpen] = React.useState(false)
  const [logsOpen, setLogsOpen] = React.useState(false)
  const [logsItemId, setLogsItemId] = React.useState<string | null>(null)
  const [failedOpen, setFailedOpen] = React.useState(false)
  const [failedItemId, setFailedItemId] = React.useState<string | null>(null)
  const [failedScope, setFailedScope] = React.useState<"single" | "all">("single")
  const [failedLoading, setFailedLoading] = React.useState(false)
  const [failedData, setFailedData] = React.useState<FailedDiagnosticsBucket[]>([])
  const [workersOpen, setWorkersOpen] = React.useState(false)
  const [workersLoading, setWorkersLoading] = React.useState(false)
  const [workers, setWorkers] = React.useState<WorkerOption[]>([])
  const [repairJobs, setRepairJobs] = React.useState<RepairJob[]>([])
  const [selectedWorkerId, setSelectedWorkerId] = React.useState("")
  const [workerMode, setWorkerMode] = React.useState<"verify_only" | "repair_and_verify">("repair_and_verify")
  const [dispatchingWorkerId, setDispatchingWorkerId] = React.useState<string | null>(null)
  const [abortingRepairJobId, setAbortingRepairJobId] = React.useState<string | null>(null)

  const syncInFlight = React.useRef(false)
  const lastSyncAtRef = React.useRef(0)
  const migrationLogsRef = React.useRef<HTMLDivElement | null>(null)
  const bucketLogsRef = React.useRef<HTMLDivElement | null>(null)

  const [migrationLogCols, setMigrationLogCols] = React.useState<{ time: number; bucket: number; stage: number }>({
    time: 170,
    bucket: 150,
    stage: 160,
  })
  const [bucketLogCols, setBucketLogCols] = React.useState<{ time: number; stage: number }>({
    time: 170,
    stage: 180,
  })

  const resizeRef = React.useRef<
    | {
        kind: "migration" | "bucket"
        key: "time" | "bucket" | "stage"
        pointerId: number
        startX: number
        startWidth: number
      }
    | null
  >(null)

  React.useEffect(() => {
    try {
      const raw = localStorage.getItem("drive:migrationLogsCols:v1")
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<typeof migrationLogCols>
        setMigrationLogCols((prev) => ({
          time: typeof parsed.time === "number" ? parsed.time : prev.time,
          bucket: typeof parsed.bucket === "number" ? parsed.bucket : prev.bucket,
          stage: typeof parsed.stage === "number" ? parsed.stage : prev.stage,
        }))
      }
    } catch {
      // ignore
    }

    try {
      const raw = localStorage.getItem("drive:bucketLogsCols:v1")
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<typeof bucketLogCols>
        setBucketLogCols((prev) => ({
          time: typeof parsed.time === "number" ? parsed.time : prev.time,
          stage: typeof parsed.stage === "number" ? parsed.stage : prev.stage,
        }))
      }
    } catch {
      // ignore
    }
  }, [])

  React.useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const active = resizeRef.current
      if (!active) return
      if (e.pointerId !== active.pointerId) return
      const delta = e.clientX - active.startX
      const nextWidth = Math.max(110, active.startWidth + delta)

      if (active.kind === "migration") {
        setMigrationLogCols((prev) => {
          const next = { ...prev, [active.key]: nextWidth } as typeof prev
          try {
            localStorage.setItem("drive:migrationLogsCols:v1", JSON.stringify(next))
          } catch {
            // ignore
          }
          return next
        })
      } else {
        setBucketLogCols((prev) => {
          const next = { ...prev, [active.key]: nextWidth } as typeof prev
          try {
            localStorage.setItem("drive:bucketLogsCols:v1", JSON.stringify(next))
          } catch {
            // ignore
          }
          return next
        })
      }
    }

    const onUp = () => {
      resizeRef.current = null
    }

    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      resizeRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (!error) return
    const t = setTimeout(() => setError(null), 4500)
    return () => clearTimeout(t)
  }, [error])

  const accountLabelById = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts) map.set(a.id, a.label)
    return map
  }, [accounts])

  const dialogLogItem = React.useMemo(
    () => items.find((i) => i.id === logsItemId) ?? null,
    [items, logsItemId]
  )
  const dialogFailedItem = React.useMemo(
    () => items.find((i) => i.id === failedItemId) ?? null,
    [items, failedItemId]
  )
  const missingFailedSelections = React.useMemo(
    () => failedData.filter((group) => group.missing),
    [failedData]
  )

  const logLines = React.useMemo(() => collectLogLines(items), [items])
  const bucketLogLines = React.useMemo(
    () => collectLogLines(dialogLogItem ? [dialogLogItem] : []),
    [dialogLogItem]
  )
  const diagnosticsSummary = React.useMemo(() => {
    return {
      buckets: failedData.length,
      totalFailedEntries: failedData.reduce((sum, group) => sum + (group.summary.totalFailedEntries || 0), 0),
      detailedEntries: failedData.reduce((sum, group) => sum + (group.summary.detailedFailedEntries || 0), 0),
      cloudflareEvidence: failedData.reduce((sum, group) => sum + (group.summary.cloudflareDetailedEntries || 0), 0),
      fallbackEvidence: failedData.reduce((sum, group) => sum + (group.summary.fallbackDetailedEntries || 0), 0),
      inferredEvidence: failedData.reduce((sum, group) => sum + (group.summary.inferredDetailedEntries || 0), 0),
      unresolved: failedData.reduce((sum, group) => sum + (group.summary.missingDetailedEntries || 0), 0),
      sourceMissing: failedData.reduce((sum, group) => sum + (group.summary.sourceMissing || 0), 0),
      sourceAccessIssues: failedData.reduce((sum, group) => sum + (group.summary.sourceAccessIssues || 0), 0),
      destinationExists: failedData.reduce((sum, group) => sum + (group.summary.destinationExists || 0), 0),
      transientIssues: failedData.reduce((sum, group) => sum + (group.summary.transientOrProviderIssues || 0), 0),
    }
  }, [failedData])

  React.useEffect(() => {
    const el = migrationLogsRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [logLines.length])

  React.useEffect(() => {
    const el = bucketLogsRef.current
    if (!el) return
    if (!logsOpen) return
    el.scrollTop = el.scrollHeight
  }, [bucketLogLines.length, logsOpen])

  const latestRepairJob = React.useMemo(() => {
    if (repairJobs.length === 0) return null

    const byUpdatedDesc = [...repairJobs].sort((a, b) => {
      const at = Date.parse(a.updatedAt || a.createdAt || "")
      const bt = Date.parse(b.updatedAt || b.createdAt || "")
      if (Number.isFinite(at) && Number.isFinite(bt)) return bt - at
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
    })

    const active = byUpdatedDesc.find((job) =>
      job.status === "running" || job.status === "claimed" || job.status === "pending"
    )

    return active ?? byUpdatedDesc[0] ?? null
  }, [repairJobs])

  const latestRepairItemsById = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>>()
    for (const item of readRepairItems(latestRepairJob)) {
      const itemId = typeof item.itemId === "string" ? item.itemId : ""
      if (!itemId) continue
      map.set(itemId, item)
    }
    return map
  }, [latestRepairJob])

  const latestRepairItemIds = React.useMemo(() => {
    const ids = new Set<string>()
    const payloadItems =
      isRecord(latestRepairJob?.payload) && Array.isArray(latestRepairJob.payload.items) ? latestRepairJob.payload.items : []
    for (const raw of payloadItems) {
      if (!isRecord(raw)) continue
      const itemId = typeof raw.id === "string" ? raw.id : typeof raw.itemId === "string" ? raw.itemId : ""
      if (itemId) ids.add(itemId)
    }
    for (const itemId of latestRepairItemsById.keys()) ids.add(itemId)
    return ids
  }, [latestRepairItemsById, latestRepairJob])

  const getBucketSnapshot = React.useCallback(
    (item: MigrationItem) =>
      getMergedBucketSnapshot(item, latestRepairItemsById.get(item.id), {
        latestRepairJobId: latestRepairJob?.id,
        latestRepairJobStatus: latestRepairJob?.status,
        repairAppliesToItem: latestRepairItemIds.has(item.id),
        latestRepairJobExists: Boolean(latestRepairJob),
        latestRepairItemCount: latestRepairItemIds.size,
      }),
    [latestRepairItemIds, latestRepairItemsById, latestRepairJob]
  )

  const bucketCounts = React.useMemo(() => {
    let completed = 0
    let failed = 0
    let aborted = 0
    let running = 0
    let scanning = 0
    let verifying = 0

    for (const item of items) {
      const s = getBucketSnapshot(item).displayStatus
      if (normalizeStatus(s) === "scanning") scanning += 1
      else if (normalizeStatus(s) === "verifying") verifying += 1
      else if (isCompletedStatus(s)) completed += 1
      else if (isAbortedStatus(s)) aborted += 1
      else if (isFailedLikeStatus(s)) failed += 1
      else if (normalizeStatus(s)) running += 1
    }

    return { completed, failed, aborted, running, scanning, verifying, total: items.length }
  }, [getBucketSnapshot, items])

  const failedBuckets = React.useMemo(
    () =>
      items.filter((item) => {
        const snapshot = getBucketSnapshot(item)
        const s = String(snapshot.displayStatus ?? getItemStatus(item) ?? "").toLowerCase()
        return snapshot.failed > 0 || snapshot.verifyIssues > 0 || s.includes("failed") || s.includes("error")
      }),
    [getBucketSnapshot, items]
  )

  const totals = React.useMemo(() => {
    let totalObjects = 0
    let transferred = 0
    let skipped = 0
    let copyFailed = 0
    let rawUnaccounted = 0
    let verifyIssues = 0
    let totalBytes = 0

    for (const item of items) {
      const snapshot = getBucketSnapshot(item)
      const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const repairState = readRepairWorkerState(progress)
      const repairResultItem = latestRepairItemsById.get(item.id)
      totalObjects += snapshot.total
      transferred += snapshot.transferred
      skipped += snapshot.skipped
      copyFailed += snapshot.failed
      rawUnaccounted += snapshot.unaccounted
      verifyIssues += snapshot.verifyIssues
      totalBytes += getEffectiveSourceBytes(item, repairResultItem, repairState)
    }

    const resolvedTransferred = totalObjects > 0 ? Math.min(totalObjects, transferred) : transferred
    const resolvedSkipped = totalObjects > 0 ? Math.min(Math.max(0, totalObjects - resolvedTransferred), skipped) : skipped
    const remainingAfterTransferSkip =
      totalObjects > 0 ? Math.max(0, totalObjects - Math.min(totalObjects, resolvedTransferred + resolvedSkipped)) : 0
    const resolvedCopyFailed = totalObjects > 0 ? Math.min(copyFailed, remainingAfterTransferSkip) : copyFailed
    const done = resolvedTransferred + resolvedSkipped + resolvedCopyFailed
    const allBucketsCompleted =
      items.length > 0 &&
      items.every((item) => isCompletedStatus(getBucketSnapshot(item).displayStatus))
    const residualUnaccounted = totalObjects > 0 ? Math.max(0, totalObjects - Math.min(totalObjects, done)) : rawUnaccounted
    const unaccounted = totalObjects > 0 ? Math.min(rawUnaccounted, residualUnaccounted) : rawUnaccounted
    const percent =
      allBucketsCompleted || (migration?.status === "completed" && migration.options?.manualCompleted === true)
        ? 100
        : totalObjects > 0
          ? Math.max(0, Math.min(100, (done / totalObjects) * 100))
          : 0
    const transferredPct = totalObjects > 0 ? Math.max(0, Math.min(100, (resolvedTransferred / totalObjects) * 100)) : 0
    const skippedPct = totalObjects > 0 ? Math.max(0, Math.min(100, (resolvedSkipped / totalObjects) * 100)) : 0
    const copyFailedPct = totalObjects > 0 ? Math.max(0, Math.min(100, (resolvedCopyFailed / totalObjects) * 100)) : 0
    const unaccountedPct = totalObjects > 0 ? Math.max(0, Math.min(100, (unaccounted / totalObjects) * 100)) : 0
    return {
      totalObjects,
      transferred: resolvedTransferred,
      skipped: resolvedSkipped,
      copyFailed: resolvedCopyFailed,
      unaccounted,
      verifyIssues,
      percent,
      transferredPct,
      skippedPct,
      copyFailedPct,
      unaccountedPct,
      totalBytes,
    }
  }, [getBucketSnapshot, items, latestRepairItemsById, migration?.options?.manualCompleted, migration?.status])

  const overviewProgress = totals
  const hasActiveSuperSlurper = React.useMemo(
    () =>
      items.some((item) => {
        const status = normalizeStatus(getBucketSnapshot(item).displayStatus)
        const rawStatus = normalizeStatus(item.slurperStatus)
        if (item.slurperJobId) {
          return ![
            "completed",
            "complete",
            "finished",
            "success",
            "succeeded",
            "failed",
            "error",
            "aborted",
            "canceled",
            "cancelled",
            "copy_completed",
            "copy_failed",
            "copy_aborted",
            "verification_failed",
            "no_files",
          ].includes(status || rawStatus)
        }
        return ["queued", "creating_job", "job_id_pending", "running", "scanning", "verifying"].includes(status || rawStatus)
      }),
    [getBucketSnapshot, items]
  )

  const overviewBadgeStatus = React.useMemo(() => {
    if (migration?.status === "completed" && migration.options?.manualCompleted === true) return "completed"
    if (bucketCounts.scanning > 0) return "scanning"
    if (bucketCounts.running > 0) return "running"
    if (bucketCounts.verifying > 0) return "verifying"
    if (bucketCounts.failed > 0) return "failed"
    if (bucketCounts.aborted > 0 && bucketCounts.completed + bucketCounts.failed + bucketCounts.aborted === bucketCounts.total && bucketCounts.failed === 0)
      return "aborted"
    if (bucketCounts.completed === bucketCounts.total && bucketCounts.total > 0) return "completed"
    return migration?.status ?? "draft"
  }, [bucketCounts, migration?.options?.manualCompleted, migration?.status])

  const effectiveMigrationStatus = React.useMemo(() => {
    if (overviewBadgeStatus === "aborted") return "canceled"
    return overviewBadgeStatus
  }, [overviewBadgeStatus])

  const overviewStatus = React.useMemo(() => {
    const message =
      migration?.status === "completed" && migration.options?.manualCompleted === true
        ? "Migration marked completed manually"
        : bucketCounts.scanning > 0
        ? `${bucketCounts.scanning} bucket${bucketCounts.scanning === 1 ? "" : "s"} scanning`
        : bucketCounts.running > 0
          ? `${bucketCounts.running} bucket${bucketCounts.running === 1 ? "" : "s"} running`
        : bucketCounts.verifying > 0
          ? `${bucketCounts.verifying} bucket${bucketCounts.verifying === 1 ? "" : "s"} verifying`
        : bucketCounts.failed > 0
          ? `${bucketCounts.failed} bucket${bucketCounts.failed === 1 ? "" : "s"} failed`
        : latestRepairJob && (latestRepairJob.status === "pending" || latestRepairJob.status === "claimed" || latestRepairJob.status === "running")
          ? latestRepairJob.summary || "Worker reconciliation in progress"
          : migration?.syncMessage ?? ""

    return {
      message,
      completed: bucketCounts.completed,
      failed: bucketCounts.failed,
      aborted: bucketCounts.aborted,
      pending: bucketCounts.running + bucketCounts.scanning + bucketCounts.verifying,
    }
  }, [bucketCounts, latestRepairJob, migration?.options?.manualCompleted, migration?.status, migration?.syncMessage])

  const loadInitial = React.useCallback(async () => {
    if (!id) return
    setError(null)
    try {
      const [accountsRes, detailsRes] = await Promise.all([fetch("/api/accounts"), fetch(`/api/migrations/${encodeURIComponent(id)}`)])
      const accountsJson: unknown = accountsRes.ok ? await accountsRes.json() : { accounts: [] }
      const detailsJson: unknown = detailsRes.ok ? await detailsRes.json() : null

      const nextAccounts =
        isRecord(accountsJson) && Array.isArray(accountsJson.accounts) ? (accountsJson.accounts as Account[]) : []
      setAccounts(nextAccounts)

      if (!detailsRes.ok) {
        const message =
          isRecord(detailsJson) && typeof detailsJson.error === "string"
            ? detailsJson.error
            : "Unable to load migration"
        throw new Error(message)
      }

      const nextMigration =
        isRecord(detailsJson) && isRecord(detailsJson.migration) ? (detailsJson.migration as Migration) : null
      const nextItems =
        isRecord(detailsJson) && Array.isArray(detailsJson.items) ? (detailsJson.items as MigrationItem[]) : []
      const nextRepairJobs =
        isRecord(detailsJson) && Array.isArray(detailsJson.repairJobs) ? (detailsJson.repairJobs as RepairJob[]) : []
      setMigration(nextMigration)
      setItems((prev) => mergeIncomingItems(prev, nextItems))
      setRepairJobs(nextRepairJobs)
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to load migration")
          : "Unable to load migration"
      setError(message)
    } finally {
      setInitialLoading(false)
    }
  }, [id])

  React.useEffect(() => {
    void loadInitial()
  }, [loadInitial])

  const runMigrationAction = React.useCallback(
    async (action: "pause_all" | "resume_all" | "cancel_migration" | "mark_completed" | "retry_migration") => {
      if (!id) return
      if (busyAction) return
      setBusyAction(action)
      setError(null)
      try {
        const res = await postJsonWithTimeout({
          url: `/api/migrations/${encodeURIComponent(id)}/action`,
          body: { action },
          timeoutMs: 12_000,
        })
        const json: unknown = await res.json().catch(() => ({}))
        const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to run action"
        if (!res.ok) throw new Error(errorMessage)
        // Do not block UI on follow-up fetches; SSE snapshot will update state.
        void fetch(`/api/migrations/${encodeURIComponent(id)}/sync`, { method: "POST" }).catch(() => {})
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "name" in e && String((e as { name?: unknown }).name) === "AbortError"
            ? ""
            : typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Unable to run action")
            : "Unable to run action"
        if (message) setError(message)
      } finally {
        setBusyAction(null)
      }
    },
    [busyAction, id]
  )

  React.useEffect(() => {
    if (!id) return

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

      const streamUrl = `/api/migrations/${encodeURIComponent(id)}/stream`
      es = new EventSource(streamUrl)

      const onSnapshot = (event: MessageEvent) => {
        retry = 0
        try {
          const data: unknown = JSON.parse(String(event.data ?? "{}"))
          if (isRecord(data) && isRecord(data.migration)) setMigration(data.migration as Migration)
          if (isRecord(data) && Array.isArray(data.items)) {
            const nextItems = data.items as MigrationItem[]
            setItems((prev) => mergeIncomingItems(prev, nextItems))
          }
          if (isRecord(data) && Array.isArray(data.repairJobs)) setRepairJobs(data.repairJobs as RepairJob[])
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

      es.addEventListener("snapshot", onSnapshot as EventListener)
      es.addEventListener("error", onError as EventListener)
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
  }, [id])

  React.useEffect(() => {
    if (!id) return
    if (!migration) return
    if (bucketCounts.scanning === 0 && bucketCounts.running === 0 && bucketCounts.verifying === 0) return

    let stopped = false

    const tick = async () => {
      if (stopped) return
      if (syncInFlight.current) return
      if (Date.now() - lastSyncAtRef.current < MIN_SYNC_GAP_MS) return
      syncInFlight.current = true
      try {
        await postJsonWithTimeout({
          url: `/api/migrations/${encodeURIComponent(id)}/sync`,
          body: {},
          timeoutMs: 10_000,
        }).catch(() => {})
        lastSyncAtRef.current = Date.now()
      } finally {
        syncInFlight.current = false
      }
    }

    const timeout = setTimeout(() => void tick(), 1_500)
    const interval = setInterval(() => void tick(), ACTIVE_SYNC_INTERVAL_MS)
    return () => {
      stopped = true
      clearTimeout(timeout)
      clearInterval(interval)
    }
  }, [ACTIVE_SYNC_INTERVAL_MS, MIN_SYNC_GAP_MS, bucketCounts.running, bucketCounts.scanning, bucketCounts.verifying, id, migration])

  const syncNow = async () => {
    if (!id) return
    setBusyAction("sync")
    setError(null)
    try {
      const res = await postJsonWithTimeout({
        url: `/api/migrations/${encodeURIComponent(id)}/sync`,
        body: {},
        timeoutMs: 12_000,
      })
      lastSyncAtRef.current = Date.now()
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

  const startMigration = async () => {
    if (!id) return
    setBusyAction("start")
    setError(null)
    try {
      const res = await fetch(`/api/migrations/${encodeURIComponent(id)}/start?async=1`, { method: "POST" })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to start migration"
      if (!res.ok) throw new Error(errorMessage)
      await fetch(`/api/migrations/${encodeURIComponent(id)}/sync`, { method: "POST" }).catch(() => {})
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

  const deleteMigration = async () => {
    if (!id) return
    setBusyAction("delete")
    setError(null)
    try {
      const res = await fetch(`/api/migrations/${encodeURIComponent(id)}`, { method: "DELETE" })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to delete migration"
      if (!res.ok) throw new Error(errorMessage)
      router.push("/dashboard/migrations")
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to delete migration")
          : "Unable to delete migration"
      setError(message)
    } finally {
      setBusyAction(null)
      setDeleteOpen(false)
    }
  }

  const runItemAction = async (itemId: string, action: "pause" | "resume" | "abort" | "logs" | "retry" | "verify") => {
    if (!id) return
    setError(null)
    setBusyItemAction((prev) => ({ ...prev, [itemId]: action }))
    try {
      const res = await postJsonWithTimeout({
        url: `/api/migrations/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/action`,
        body: { action },
        timeoutMs: 12_000,
      })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to run action"
      if (!res.ok) throw new Error(errorMessage)

      // Do not block UI; SSE snapshot will update state. Kick a best-effort sync.
      void fetch(`/api/migrations/${encodeURIComponent(id)}/sync`, { method: "POST" }).catch(() => {})
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "name" in e && String((e as { name?: unknown }).name) === "AbortError"
          ? ""
          : typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to run action")
        : "Unable to run action"
      if (message) setError(message)
    } finally {
      setBusyItemAction((prev) => {
        const next = { ...prev }
        delete next[itemId]
        return next
      })
    }
  }

  const fetchFailedDiagnosticsForItem = React.useCallback(
    async (itemId: string): Promise<FailedDiagnosticsBucket | null> => {
      if (!id) return null
      const item = items.find((x) => x.id === itemId)
      const res = await fetch(
        `/api/migrations/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/failures?limit=250&refresh=1`
      )
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage =
        isRecord(json) && typeof json.error === "string"
          ? json.error
          : "Unable to load failed object diagnostics"
      if (!res.ok) throw new Error(errorMessage)

      const summary =
        isRecord(json) && isRecord(json.summary)
          ? {
              totalFailedEntries:
                typeof json.summary.totalFailedEntries === "number" ? json.summary.totalFailedEntries : 0,
              detailedFailedEntries:
                typeof json.summary.detailedFailedEntries === "number" ? json.summary.detailedFailedEntries : 0,
              cloudflareDetailedEntries:
                typeof json.summary.cloudflareDetailedEntries === "number" ? json.summary.cloudflareDetailedEntries : 0,
              fallbackDetailedEntries:
                typeof json.summary.fallbackDetailedEntries === "number" ? json.summary.fallbackDetailedEntries : 0,
              inferredDetailedEntries:
                typeof json.summary.inferredDetailedEntries === "number" ? json.summary.inferredDetailedEntries : 0,
              missingDetailedEntries:
                typeof json.summary.missingDetailedEntries === "number" ? json.summary.missingDetailedEntries : 0,
              sourceMissing: typeof json.summary.sourceMissing === "number" ? json.summary.sourceMissing : 0,
              sourceAccessIssues:
                typeof json.summary.sourceAccessIssues === "number" ? json.summary.sourceAccessIssues : 0,
              destinationExists:
                typeof json.summary.destinationExists === "number" ? json.summary.destinationExists : 0,
              transientOrProviderIssues:
                typeof json.summary.transientOrProviderIssues === "number"
                  ? json.summary.transientOrProviderIssues
                  : 0,
              unknown: typeof json.summary.unknown === "number" ? json.summary.unknown : 0,
            }
          : {
              totalFailedEntries: 0,
              detailedFailedEntries: 0,
              cloudflareDetailedEntries: 0,
              fallbackDetailedEntries: 0,
              inferredDetailedEntries: 0,
              missingDetailedEntries: 0,
              sourceMissing: 0,
              sourceAccessIssues: 0,
              destinationExists: 0,
              transientOrProviderIssues: 0,
              unknown: 0,
            }

      const failures =
        isRecord(json) && Array.isArray(json.failures) ? (json.failures as FailedObjectDiagnostic[]) : []

      return {
        missing: isRecord(json) && json.missing === true,
        item: {
          id: itemId,
          sourceBucket:
            isRecord(json) && isRecord(json.item) && typeof json.item.sourceBucket === "string"
              ? json.item.sourceBucket
              : item?.sourceBucket ?? itemId,
          targetBucket: item?.targetBucket ?? "",
          jobId: item?.slurperJobId ?? null,
        },
        summary,
        failures,
      }
    },
    [id, items]
  )

  const openFailedDiagnosticsForSingle = React.useCallback(
    async (itemId: string) => {
      setFailedItemId(itemId)
      setFailedScope("single")
      setFailedOpen(true)
      setFailedData([])
      setFailedLoading(true)
      setError(null)
      try {
        const data = await fetchFailedDiagnosticsForItem(itemId)
        setFailedData(data ? [data] : [])
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Unable to load failed object diagnostics")
            : "Unable to load failed object diagnostics"
        setError(message)
        setFailedData([])
      } finally {
        setFailedLoading(false)
      }
    },
    [fetchFailedDiagnosticsForItem]
  )

  const openFailedDiagnosticsForAll = React.useCallback(
    async (itemIds: string[]) => {
      setFailedItemId(null)
      setFailedScope("all")
      setFailedOpen(true)
      setFailedData([])
      setFailedLoading(true)
      setError(null)
      try {
        const results = await Promise.all(
          itemIds.map(async (itemId) => {
            try {
              return await fetchFailedDiagnosticsForItem(itemId)
            } catch {
              return null
            }
          })
        )
        setFailedData(results.filter((x): x is FailedDiagnosticsBucket => Boolean(x)))
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Unable to load failed object diagnostics")
            : "Unable to load failed object diagnostics"
        setError(message)
        setFailedData([])
      } finally {
        setFailedLoading(false)
      }
    },
    [fetchFailedDiagnosticsForItem]
  )

  const openWorkerDispatch = React.useCallback(async () => {
    setWorkersOpen(true)
    setWorkersLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/workers", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to load workers"
        throw new Error(message)
      }
      const rows =
        isRecord(json) && Array.isArray(json.agents)
          ? (json.agents as WorkerOption[]).filter(
              (worker) =>
                (worker.provider === "github_actions" || worker.provider === "self_hosted" || worker.provider === "local") &&
                Array.isArray(worker.capabilities) &&
                worker.capabilities.includes("repair")
            )
          : []
      setWorkers(rows)
      setSelectedWorkerId(rows[0]?.id ?? "")
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to load workers")
          : "Unable to load workers"
      setError(message)
      setWorkers([])
      setSelectedWorkerId("")
    } finally {
      setWorkersLoading(false)
    }
  }, [])

  const dispatchMigrationWorker = React.useCallback(async () => {
    if (!migration?.id || !selectedWorkerId) return
    setDispatchingWorkerId(selectedWorkerId)
    setError(null)
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(selectedWorkerId)}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          migrationId: migration.id,
          mode: workerMode,
          workflowSupportsRuntimeInputs: true,
        }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          isRecord(json) && typeof json.error === "string" ? json.error : "Unable to dispatch worker"
        throw new Error(message)
      }
      setWorkersOpen(false)
      await loadInitial()
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to dispatch worker")
          : "Unable to dispatch worker"
      setError(message)
    } finally {
      setDispatchingWorkerId(null)
    }
  }, [loadInitial, migration?.id, selectedWorkerId, workerMode])

  const abortRepairJob = React.useCallback(
    async (jobId: string) => {
      setAbortingRepairJobId(jobId)
      setError(null)
      try {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(jobId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "abort" }),
        })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to abort worker job"
          throw new Error(message)
        }
        await loadInitial()
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Unable to abort worker job")
            : "Unable to abort worker job"
        setError(message)
      } finally {
        setAbortingRepairJobId(null)
      }
    },
    [loadInitial]
  )

  if (initialLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-10 w-40" />
        </div>
        <Skeleton className="h-[220px] w-full" />
        <Skeleton className="h-[360px] w-full" />
      </div>
    )
  }

  if (!migration) {
    return (
      <div className="space-y-4">
        <div className="text-sm text-muted-foreground">Migration not found.</div>
        <Button variant="outline" onClick={() => router.push("/dashboard/migrations")}>
          Back to migrations
        </Button>
      </div>
    )
  }

  const activeIcon =
    overviewBadgeStatus === "completed" ? (
      <CheckCircle2 className="h-4 w-4 text-green-600" />
    ) : overviewBadgeStatus === "running" || overviewBadgeStatus === "scanning" || overviewBadgeStatus === "verifying" ? (
      <Clock className="h-4 w-4 text-primary" />
    ) : overviewBadgeStatus === "failed" ? (
      <AlertCircle className="h-4 w-4 text-red-600" />
    ) : (
      <Clock className="h-4 w-4 text-muted-foreground" />
    )

  const sourceLabel = accountLabelById.get(migration.sourceAccountId) ?? migration.sourceAccountId
  const targetLabel = accountLabelById.get(migration.targetAccountId) ?? migration.targetAccountId

  return (
    <div className="space-y-6 max-w-full">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            {activeIcon}
            <span className="truncate">Migration details</span>
          </h1>
          <p className="text-sm text-muted-foreground font-mono truncate">{migration.id}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="destructive" onClick={() => setDeleteOpen(true)} disabled={Boolean(busyAction)}>
            {busyAction === "delete" ? <Spinner className="mr-0" /> : <Trash2 className="h-4 w-4 mr-0" />}
            Delete
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>Overview</span>
            {statusBadge(overviewBadgeStatus, { syncStatus: migration.syncStatus })}
          </CardTitle>
          <CardDescription>
            {sourceLabel} - {targetLabel} - {migration.options.overwrite ? "Overwrite on destination" : "No overwrite"} -{" "}
            {Math.max(1, Math.min(3, migration.options.concurrency ?? 3))} concurrent jobs
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Progress</span>
              <span className="font-mono">{overviewProgress.percent.toFixed(1)}%</span>
            </div>
              <ProgressStacked
                transferredPct={overviewProgress.transferredPct}
                skippedPct={overviewProgress.skippedPct}
                failedPct={overviewProgress.copyFailedPct}
                unaccountedPct={overviewProgress.unaccountedPct}
              />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                {overviewProgress.transferred > 0 ? (
                  <span>
                    {formatNumber(overviewProgress.transferred)} transferred ({overviewProgress.transferredPct.toFixed(1)}%)
                  </span>
                ) : null}
                {overviewProgress.skipped > 0 ? (
                  <span className="text-yellow-500">
                    {formatNumber(overviewProgress.skipped)} skipped objects ({overviewProgress.skippedPct.toFixed(1)}%)
                  </span>
                ) : null}
                {overviewProgress.copyFailed > 0 ? (
                  <span className="text-red-500">
                    {formatNumber(overviewProgress.copyFailed)} copy failed objects ({overviewProgress.copyFailedPct.toFixed(1)}%)
                  </span>
                ) : null}
                {overviewProgress.unaccounted > 0 ? (
                  <span className="text-muted-foreground">
                    {formatNumber(overviewProgress.unaccounted)} not reported by Cloudflare counters ({overviewProgress.unaccountedPct.toFixed(1)}%)
                  </span>
                ) : null}
                {overviewProgress.verifyIssues > 0 ? (
                  <span className="text-red-500">{formatNumber(overviewProgress.verifyIssues)} verification issues</span>
                ) : null}
                {overviewProgress.transferred === 0 && overviewProgress.skipped === 0 && overviewProgress.copyFailed === 0 ? (
                  <span>0 transferred</span>
                ) : null}
              </div>
              <span>
                {formatNumber(overviewProgress.totalObjects)} total objects - {formatBytes(overviewProgress.totalBytes)} source size
              </span>
            </div>
          </div>

          {overviewStatus.message ? (
            <div className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Status:</span> {overviewStatus.message} -{" "}
              {overviewStatus.completed} buckets completed - {overviewStatus.failed} buckets failed - {overviewStatus.aborted} buckets aborted
              {overviewStatus.pending > 0 ? ` - ${overviewStatus.pending} buckets pending` : ""}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {(() => {
              const allBucketsTerminal =
                items.length > 0 &&
                items.every((i) => {
                  const s = getBucketSnapshot(i).displayStatus
                  return isCompletedStatus(s) || isAbortedStatus(s) || isFailedLikeStatus(s)
                })
              const anyRunning = items.some((i) => normalizeStatus(getBucketSnapshot(i).displayStatus) === "running")
              const anyPaused = items.some((i) => Boolean(i.slurperJobId) && String(getItemStatus(i) ?? "").toLowerCase() === "paused")
              const showCancel = !allBucketsTerminal && !["completed", "failed", "canceled"].includes(String(effectiveMigrationStatus))
              const showMarkCompleted =
                allBucketsTerminal && String(effectiveMigrationStatus) !== "completed" && String(effectiveMigrationStatus) !== "verifying"

              return (
                <>
                  <Button
                    onClick={() => {
                      if (effectiveMigrationStatus === "failed") {
                        void runMigrationAction("retry_migration")
                      } else {
                        void startMigration()
                      }
                    }}
                    disabled={Boolean(busyAction) || (effectiveMigrationStatus !== "draft" && effectiveMigrationStatus !== "failed")}
                    variant={effectiveMigrationStatus === "draft" || effectiveMigrationStatus === "failed" ? "default" : "secondary"}
                  >
                    {busyAction === "start" || busyAction === "retry_migration" ? (
                      <Spinner className="mr-0" />
                    ) : (
                      <Play className="h-4 w-4 mr-0" />
                    )}
                    {effectiveMigrationStatus === "failed" ? "Retry" : "Start"}
                  </Button>

                  <Button onClick={syncNow} disabled={Boolean(busyAction)} variant="outline">
                    {busyAction === "sync" ? <Spinner className="mr-0" /> : <RefreshCw className="h-4 w-4 mr-0" />}
                    Sync now
                  </Button>

                  {failedBuckets.length > 0 ? (
                    <Button
                      onClick={() => {
                        void openFailedDiagnosticsForAll(failedBuckets.map((b) => b.id))
                      }}
                      disabled={Boolean(busyAction)}
                      variant="outline"
                    >
                      <AlertCircle className="h-4 w-4 mr-0" />
                      Failed Diagnostics
                    </Button>
                  ) : null}

                  <Button
                    onClick={() => void openWorkerDispatch()}
                    disabled={Boolean(busyAction) || hasActiveSuperSlurper}
                    variant="outline"
                    title={hasActiveSuperSlurper ? "Wait for Super Slurper to finish before running a worker" : "Run with worker"}
                  >
                    <Play className="h-4 w-4 mr-0" />
                    Run with worker
                  </Button>

                  {!allBucketsTerminal && anyRunning ? (
                    <Button
                      onClick={() => void runMigrationAction("pause_all")}
                      disabled={Boolean(busyAction)}
                      variant="outline"
                    >
                      {busyAction === "pause_all" ? <Spinner className="mr-0" /> : <Pause className="h-4 w-4 mr-0" />}
                      Pause
                    </Button>
                  ) : null}

                  {!allBucketsTerminal && anyPaused ? (
                    <Button
                      onClick={() => void runMigrationAction("resume_all")}
                      disabled={Boolean(busyAction)}
                      variant="outline"
                    >
                      {busyAction === "resume_all" ? <Spinner className="mr-0" /> : <Play className="h-4 w-4 mr-0" />}
                      Resume
                    </Button>
                  ) : null}

                  {showCancel ? (
                    <Button
                      onClick={() => void runMigrationAction("cancel_migration")}
                      disabled={Boolean(busyAction)}
                      variant="destructive"
                    >
                      {busyAction === "cancel_migration" ? <Spinner className="mr-0" /> : <CircleX className="h-4 w-4 mr-0" />}
                      Cancel
                    </Button>
                  ) : null}

                  {showMarkCompleted ? (
                    <Button
                      onClick={() => setManualCompleteOpen(true)}
                      disabled={Boolean(busyAction)}
                      variant="secondary"
                    >
                      {busyAction === "mark_completed" ? <Spinner className="mr-0" /> : <CheckCircle2 className="h-4 w-4 mr-0" />}
                      Mark completed
                    </Button>
                  ) : null}
                </>
              )
            })()}
          </div>
        </CardContent>
      </Card>
      {latestRepairJob ? (
        <Card className="gap-2">
          <CardHeader className="pb-1">
            <div className="space-y-1">
                <CardTitle>Worker Overview</CardTitle>
              <CardDescription>Latest worker reconciliation run for this migration.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {(() => {
              const job = latestRepairJob
              const progress = isRecord(job.progress) ? job.progress : {}
              const currentBucket = typeof progress.currentBucket === "string" ? progress.currentBucket : ""
              const stage = typeof progress.stage === "string" ? progress.stage : ""
              const isActive = job.status === "running" || job.status === "claimed" || job.status === "pending"
              const summaryText = job.error || job.summary || "Open the job details page for item progress, logs, and repair results."

              return (
                <div
                  className={cn(
                    "overflow-hidden rounded-2xl border text-sm",
                    isActive ? "border-primary/30 bg-primary/[0.04]" : "bg-muted/15"
                  )}
                >
                  <div className="flex flex-col gap-4 border-b px-4 py-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {repairJobBadge(job.status)}
                        <Badge variant="outline">{formatRepairMode(job.mode)}</Badge>
                        <span className="text-xs text-muted-foreground">Updated {formatDate(job.lastHeartbeatAt || job.updatedAt)}</span>
                      </div>
                      <div className="space-y-1">
                        <div className="font-mono text-[11px] text-muted-foreground">{job.id}</div>
                        <div className={cn("text-sm leading-relaxed", job.error ? "text-red-200" : "text-muted-foreground")}>{summaryText}</div>
                      </div>
                    </div>

                    <div className="flex w-full items-start justify-end lg:w-auto">
                      <div className="flex flex-wrap gap-2">
                        {!["completed", "failed", "canceled"].includes(job.status) ? (
                          <Button
                            variant="outline"
                            disabled={abortingRepairJobId === job.id}
                            onClick={() => void abortRepairJob(job.id)}
                          >
                            {abortingRepairJobId === job.id ? <Spinner className="mr-0" /> : <Square className="h-4 w-4 mr-0" />}
                            Abort
                          </Button>
                        ) : null}
                        <Button
                          variant="outline"
                          onClick={() => router.push(`/dashboard/workers/jobs/${encodeURIComponent(job.id)}`)}
                        >
                          Details
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-px bg-border sm:grid-cols-3 lg:grid-cols-4">
                    <div className="bg-background/80 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Worker</div>
                      <div className="mt-1 truncate font-medium">{job.claimedByAgentId || job.requestedByAgentId || "-"}</div>
                    </div>
                    <div className="bg-background/80 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Stage</div>
                      <div className="mt-1 font-medium">{formatRepairStage(stage)}</div>
                    </div>
                    <div className="bg-background/80 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Bucket</div>
                      <div className="mt-1 truncate font-medium">{currentBucket || "-"}</div>
                    </div>
                    <div className="bg-background/80 px-4 py-3">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Started</div>
                      <div className="mt-1 font-medium">{formatDate(job.startedAt || job.createdAt)}</div>
                    </div>
                  </div>
                </div>
              )
            })()}
          </CardContent>
        </Card>
      ) : null}


      <Card>
        <CardHeader>
          <CardTitle>Buckets</CardTitle>
          <CardDescription>One Cloudflare Super Slurper job per bucket (max 3 running at a time).</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-w-full">
            <div className="rounded-md border">
              <ScrollArea className="h-[520px] max-h-[60vh]" hideScrollbar>
                <Table className="table-fixed w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky top-0 z-10 bg-background w-[260px]">Bucket</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background w-[120px] text-center">Status</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background w-[110px] text-center">Transferred</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background w-[80px] text-center">Total</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background w-[110px] text-center">Size</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background w-[150px] text-center">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                {items.map((item) => {
                  const slurper = readSlurperResult(item.progress)
                  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
                  const repairState = readRepairWorkerState(progress)
                  const repairResultItem = latestRepairItemsById.get(item.id)
                  const snapshot = getBucketSnapshot(item)
                  const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
                  const scanComplete = sourceScanStatus === "completed"
                  const status = String(getItemStatus(item) ?? "").toLowerCase()
                  const displayStatus = snapshot.displayStatus
                  const normalizedDisplayStatus = normalizeStatus(displayStatus)
                  const hasKnownEmpty =
                    typeof item.sourceObjects === "number" &&
                    item.sourceObjects === 0 &&
                    getEffectiveSourceBytes(item, repairResultItem, repairState) === 0
                  const total =
                    displayStatus === "no_files" || hasKnownEmpty
                      ? 0
                      : snapshot.total > 0 || scanComplete
                        ? snapshot.total
                        : undefined
                  const sourceBytes = getEffectiveSourceBytes(item, repairResultItem, repairState)
                  const transferred = snapshot.transferred
                  const skipped = typeof slurper?.skippedObjects === "number" ? slurper.skippedObjects : 0
                  const failed = typeof slurper?.failedObjects === "number" ? slurper.failedObjects : 0
                  const hadProgress = snapshot.transferred > 0 || snapshot.skipped > 0 || snapshot.failed > 0
                  const itemBusy = busyItemAction[item.id]
                  const canPause = Boolean(item.slurperJobId) && status === "running"
                  const canResume = Boolean(item.slurperJobId) && status === "paused"
                  const verifyState = readVerifyState(item.progress)
                  const verifyStatus = verifyState?.status ?? null
                  const canRetryFromVerifyFailure = verifyStatus === "error"
                  const canRetry =
                    canRetryFromVerifyFailure ||
                    normalizedDisplayStatus === "queued" ||
                    normalizedDisplayStatus === "job_id_pending" ||
                    normalizedDisplayStatus.endsWith("_failed") ||
                    normalizedDisplayStatus.includes("failed") ||
                    normalizedDisplayStatus.includes("error")
                  const canAbort =
                    (Boolean(item.slurperJobId) || canRetry) &&
                    !["completed", "aborted", "failed", "verification_failed", "no_files"].includes(normalizedDisplayStatus)
                  const canVerify =
                    isCompletedStatus(displayStatus) && verifyStatus !== "pending" && verifyStatus !== "running"
                  const canInspectFailures =
                    snapshot.failed > 0 || snapshot.verifyIssues > 0 || normalizedDisplayStatus.includes("failed") || normalizedDisplayStatus.includes("error")
                  const lifecycleAction: "pause" | "resume" | "retry" | null = canPause
                    ? "pause"
                    : canRetry
                      ? "retry"
                      : canResume
                        ? "resume"
                        : null
                  const lifecycleBusy =
                    itemBusy === "pause" || itemBusy === "resume" || itemBusy === "retry"
                  const repairFinalMissing =
                    typeof repairResultItem?.finalMissing === "number"
                      ? (repairResultItem.finalMissing as number)
                      : typeof repairState?.details?.finalMissing === "number"
                        ? (repairState.details.finalMissing as number)
                        : undefined
                  const repairFinalMismatched =
                    typeof repairResultItem?.finalMismatched === "number"
                      ? (repairResultItem.finalMismatched as number)
                      : typeof repairState?.details?.finalMismatched === "number"
                        ? (repairState.details.finalMismatched as number)
                        : undefined

                  return (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">
                        <div className="leading-tight">
                          <div className="truncate">{item.sourceBucket}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            <span className="font-mono">{item.id}</span>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="space-y-1">
                          <div>{statusBadge(displayStatus, { hadProgress })}</div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        <div>{formatNumber(transferred)}</div>
                      </TableCell>
                      <TableCell
                        className="text-center font-mono text-xs"
                        title={
                          scanComplete
                            ? "Total from Supabase bucket scan (authoritative)"
                            : displayStatus === "scanning"
                              ? "Scanning source bucket… totals will appear when scan completes"
                              : "Total"
                        }
                      >
                        <div>{typeof total === "number" ? formatNumber(total) : "—"}</div>
                      </TableCell>
                      <TableCell className="text-center font-mono text-xs">
                        {displayStatus === "no_files" ? "0 B" : scanComplete || sourceBytes > 0 ? formatBytes(sourceBytes) : "—"}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="flex justify-center gap-1">
                          <Button
                            size="icon-sm"
                            variant="outline"
                            title={verifyStatus === null ? "Run verification" : "Re-run verification"}
                            aria-label="Verify"
                            disabled={Boolean(itemBusy) || !canVerify}
                            onClick={() => {
                              void runItemAction(item.id, "verify").then(() => void syncNow())
                            }}
                          >
                            {itemBusy === "verify" ? <Spinner /> : <ShieldCheck className="h-4 w-4" />}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            title="View logs"
                            disabled={Boolean(itemBusy)}
                            onClick={() => {
                              setLogsItemId(item.id)
                              setLogsOpen(true)
                              if (bucketCounts.scanning > 0 || bucketCounts.running > 0 || bucketCounts.verifying > 0) {
                                void runItemAction(item.id, "logs")
                              }
                            }}
                          >
                            {itemBusy === "logs" ? <Spinner /> : <ScrollText className="h-4 w-4" />}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            title="Failed Diagnostics"
                            aria-label="Failed Diagnostics"
                            disabled={Boolean(itemBusy) || !canInspectFailures}
                            onClick={() => {
                              void openFailedDiagnosticsForSingle(item.id)
                            }}
                          >
                            <AlertCircle className="h-4 w-4" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            title={
                              lifecycleAction === "pause"
                                ? "Stop"
                                : lifecycleAction === "retry"
                                  ? "Start (retry)"
                                  : lifecycleAction === "resume"
                                    ? "Start"
                                    : "Start/Stop"
                            }
                            aria-label={
                              lifecycleAction === "pause"
                                ? "Stop"
                                : lifecycleAction === "retry"
                                  ? "Start (retry)"
                                  : lifecycleAction === "resume"
                                    ? "Start"
                                    : "Start/Stop"
                            }
                            disabled={Boolean(itemBusy) || lifecycleAction === null}
                            onClick={() => {
                              if (lifecycleAction === "pause") {
                                void runItemAction(item.id, "pause")
                                return
                              }
                              if (lifecycleAction === "retry") {
                                void runItemAction(item.id, "retry").then(() => void syncNow())
                                return
                              }
                              if (lifecycleAction === "resume") {
                                void runItemAction(item.id, "resume")
                              }
                            }}
                          >
                            {lifecycleBusy ? (
                              <Spinner />
                            ) : lifecycleAction === "pause" ? (
                              <Square className="h-4 w-4" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="destructive"
                            title="Abort"
                            aria-label="Abort"
                            disabled={Boolean(itemBusy) || !canAbort}
                            onClick={() => {
                              void runItemAction(item.id, "abort")
                            }}
                          >
                            {itemBusy === "abort" ? <Spinner /> : <CircleX className="h-4 w-4" />}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                  </TableBody>
                </Table>
              </ScrollArea>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Migration Logs</CardTitle>
          <CardDescription>Aggregated logs and errors for this migration.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/20">
            <ScrollArea ref={migrationLogsRef} className="h-[420px]" hideScrollbar>
              {logLines.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">No logs yet.</div>
              ) : (
                <div className="min-w-[900px] p-2 text-xs font-mono">
                  <div className="sticky top-0 z-10 border-b bg-background/80 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                    <div
                      className="grid gap-3 text-[11px] text-muted-foreground select-none"
                      style={{
                        gridTemplateColumns: `${migrationLogCols.time}px ${migrationLogCols.bucket}px ${migrationLogCols.stage}px 1fr`,
                      }}
                    >
                      <div className="relative pr-8">
                        Time
                        <div
                          className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground cursor-col-resize"
                          role="separator"
                          aria-label="Resize Time column"
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            resizeRef.current = {
                              kind: "migration",
                              key: "time",
                              pointerId: e.pointerId,
                              startX: e.clientX,
                              startWidth: migrationLogCols.time,
                            }
                            try {
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </div>
                      <div className="relative pr-8">
                        Bucket
                        <div
                          className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground cursor-col-resize"
                          role="separator"
                          aria-label="Resize Bucket column"
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            resizeRef.current = {
                              kind: "migration",
                              key: "bucket",
                              pointerId: e.pointerId,
                              startX: e.clientX,
                              startWidth: migrationLogCols.bucket,
                            }
                            try {
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </div>
                      <div className="relative pr-8">
                        Stage / Status
                        <div
                          className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground cursor-col-resize"
                          role="separator"
                          aria-label="Resize Stage column"
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            resizeRef.current = {
                              kind: "migration",
                              key: "stage",
                              pointerId: e.pointerId,
                              startX: e.clientX,
                              startWidth: migrationLogCols.stage,
                            }
                            try {
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </div>
                      <div>Message</div>
                    </div>
                  </div>
                  <div className="space-y-1 px-2 py-2">
                    {logLines.map((line, idx) => (
                      <div
                        key={`${line.atIso}-${line.bucket}-${idx}`}
                        className="grid gap-3"
                        style={{
                          gridTemplateColumns: `${migrationLogCols.time}px ${migrationLogCols.bucket}px ${migrationLogCols.stage}px 1fr`,
                        }}
                      >
                        <div className="truncate text-muted-foreground">{formatLogTime(line.atIso)}</div>
                        <div className="truncate">{line.bucket}</div>
                        <div className="truncate text-muted-foreground">
                          {line.stage ? line.stage : "-"}
                          {line.status ? ` - ${line.status}` : ""}
                        </div>
                        <div className="whitespace-pre-wrap break-words">{line.message || "-"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        </CardContent>
      </Card>

      <Dialog open={failedOpen} onOpenChange={setFailedOpen}>
        <DialogContent className="w-[96vw] max-w-[96vw] sm:max-w-[min(96vw,72rem)] h-[88vh] sm:h-[min(88vh,56rem)] overflow-hidden p-0 flex flex-col gap-0">
          <DialogHeader className="shrink-0 border-b bg-background px-6 pt-6 pb-4">
            <DialogTitle>Diagnostics</DialogTitle>
            <DialogDescription className="pt-1 text-sm leading-6 text-muted-foreground">
              {failedScope === "all"
                ? `Review object-level migration failures across ${formatNumber(diagnosticsSummary.buckets)} bucket${diagnosticsSummary.buckets === 1 ? "" : "s"}, including source and destination inspection, evidence quality, and recovery guidance.`
                : dialogFailedItem
                  ? `Review object-level migration failures for ${dialogFailedItem.sourceBucket} -> ${dialogFailedItem.targetBucket}.`
                  : missingFailedSelections.length === 1
                    ? "The selected bucket is no longer available in this migration, so only retained diagnostics can be shown."
                  : "Review object-level migration failures and supporting evidence."}
            </DialogDescription>
          </DialogHeader>
          {failedLoading ? (
            <div className="mx-6 my-6 rounded-2xl border bg-muted/30 p-4 text-sm text-muted-foreground">
              <Spinner className="mr-2 inline-flex" />
              Loading diagnostics...
            </div>
          ) : (
            <div className="min-h-0 flex flex-1 flex-col overflow-auto bg-background px-6 pb-4 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {missingFailedSelections.length > 0 ? (
                <div className="pt-5">
                  <div className="rounded-2xl border bg-muted/30 px-4 py-4 text-sm text-muted-foreground">
                    {missingFailedSelections.length === 1
                      ? "The selected bucket item is no longer present in the current migration snapshot. Diagnostics below only reflect any retained records."
                      : `${formatNumber(missingFailedSelections.length)} selected bucket items are no longer present in the current migration snapshot. Diagnostics below only reflect any retained records.`}
                  </div>
                </div>
              ) : null}
              {failedData.length > 0 ? (
                <div className="shrink-0 space-y-4 pt-5">
                  <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Failure Scope</div>
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <div>
                          <div className="text-3xl font-semibold tracking-tight">{formatNumber(diagnosticsSummary.totalFailedEntries)}</div>
                          <div className="mt-1 text-sm text-muted-foreground">Reported object-level failures</div>
                        </div>
                        <AlertCircle className="h-8 w-8 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Evidence Coverage</div>
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <div>
                          <div className="text-3xl font-semibold tracking-tight">{formatNumber(diagnosticsSummary.detailedEntries)}</div>
                          <div className="mt-1 text-sm text-muted-foreground">Failures with object-level detail</div>
                        </div>
                        <CheckCircle2 className="h-8 w-8 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Outstanding Gaps</div>
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <div>
                          <div className="text-3xl font-semibold tracking-tight">{formatNumber(diagnosticsSummary.unresolved)}</div>
                          <div className="mt-1 text-sm text-muted-foreground">Failures still lacking object evidence</div>
                        </div>
                        <CircleX className="h-8 w-8 text-muted-foreground" />
                      </div>
                    </div>
                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Affected Buckets</div>
                      <div className="mt-3 flex items-end justify-between gap-3">
                        <div>
                          <div className="text-3xl font-semibold tracking-tight">{formatNumber(diagnosticsSummary.buckets)}</div>
                          <div className="mt-1 text-sm text-muted-foreground">Buckets represented in this view</div>
                        </div>
                        <Clock className="h-8 w-8 text-muted-foreground" />
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 lg:grid-cols-[1.3fr_1fr]">
                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-sm font-semibold">Evidence Sources</div>
                      <div className="mt-3 flex flex-wrap gap-2 text-sm">
                        <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                          {formatNumber(diagnosticsSummary.cloudflareEvidence)} Cloudflare log records
                        </div>
                        <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                          {formatNumber(diagnosticsSummary.fallbackEvidence)} verification or worker records
                        </div>
                        <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                          {formatNumber(diagnosticsSummary.inferredEvidence)} inferred from source and destination state
                        </div>
                        <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                          {formatNumber(diagnosticsSummary.unresolved)} unresolved after reconstruction
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border bg-background px-4 py-4">
                      <div className="text-sm font-semibold">Observed Patterns</div>
                      <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <div className="text-lg font-semibold">{formatNumber(diagnosticsSummary.sourceMissing)}</div>
                          <div className="text-muted-foreground">Source missing</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold">{formatNumber(diagnosticsSummary.sourceAccessIssues)}</div>
                          <div className="text-muted-foreground">Source access issues</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold">{formatNumber(diagnosticsSummary.destinationExists)}</div>
                          <div className="text-muted-foreground">Already present in destination</div>
                        </div>
                        <div>
                          <div className="text-lg font-semibold">{formatNumber(diagnosticsSummary.transientIssues)}</div>
                          <div className="text-muted-foreground">Transient or provider-side issues</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="pt-5">
                  <div className="rounded-2xl border bg-background px-4 py-4 text-sm text-muted-foreground">
                    No diagnostics are currently available for this selection.
                  </div>
                </div>
              )}

              <div className="mt-4 min-h-[30rem] overscroll-contain pb-1">
                  {failedData.length === 0 ? (
                    <div className="flex h-full items-center justify-center rounded-2xl border bg-background p-6 text-sm text-muted-foreground">
                      No object-level failure records were identified from logs, verification, worker evidence, or reconstructed source and destination comparisons.
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {failedData.map((group) => (
                        <div key={group.item.id} className="overflow-hidden rounded-2xl border bg-background">
                          <div className="border-b bg-muted/30 px-4 py-4">
                            <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                              <div className="space-y-1">
                                <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Bucket Pair</div>
                                <div className="font-mono text-sm text-foreground">
                                  {group.item.sourceBucket} <span className="text-muted-foreground">{"->"}</span> {group.item.targetBucket}
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {group.item.jobId ? `Job reference: ${group.item.jobId}` : "Job reference unavailable"}
                                </div>
                              </div>
                              <div className="flex flex-wrap gap-2 text-xs">
                                <div className="rounded-full border px-3 py-1.5">
                                  {formatNumber(group.summary.totalFailedEntries)} reported failures
                                </div>
                                <div className="rounded-full border px-3 py-1.5">
                                  {formatNumber(group.summary.detailedFailedEntries || 0)} with detail
                                </div>
                                {group.summary.cloudflareDetailedEntries ? (
                                  <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                                    {formatNumber(group.summary.cloudflareDetailedEntries)} Cloudflare
                                  </div>
                                ) : null}
                                {group.summary.fallbackDetailedEntries ? (
                                  <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                                    {formatNumber(group.summary.fallbackDetailedEntries)} verification or worker
                                  </div>
                                ) : null}
                                {group.summary.inferredDetailedEntries ? (
                                  <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                                    {formatNumber(group.summary.inferredDetailedEntries)} inferred
                                  </div>
                                ) : null}
                                {group.summary.missingDetailedEntries ? (
                                  <div className="rounded-full border bg-muted/40 px-3 py-1.5 text-foreground">
                                    {formatNumber(group.summary.missingDetailedEntries)} unresolved
                                  </div>
                                ) : null}
                              </div>
                            </div>
                          </div>

                          {group.failures.length === 0 && (group.summary.totalFailedEntries || 0) > 0 ? (
                            <div className="border-b bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
                              {formatNumber(group.summary.totalFailedEntries)} failures were reported for this bucket pair, but the system could not reconstruct object identifiers from Cloudflare logs, verification data, worker output, or current source and destination state.
                            </div>
                          ) : null}

                          <PinnedScrollableTable maxHeightClassName="max-h-[22.5rem]">
                            <div className="min-w-[1720px] text-sm">
                              <div
                                className="sticky top-0 z-10 grid border-b bg-background"
                                style={{ gridTemplateColumns: DIAGNOSTICS_TABLE_GRID_TEMPLATE }}
                              >
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Object</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Evidence</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Source State</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Destination State</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Diagnosis</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Downloads</div>
                                <div className="text-foreground h-11 px-3 py-3 font-medium whitespace-nowrap">Recommended Action</div>
                              </div>
                              <div>
                                {group.failures.map((failure, idx) => (
                                  <div
                                    key={`${group.item.id}-${failure.key}-${failure.at ?? ""}-${idx}`}
                                    className="grid border-b transition-colors hover:bg-muted/50"
                                    style={{ gridTemplateColumns: DIAGNOSTICS_TABLE_GRID_TEMPLATE }}
                                  >
                                    <div className="p-3 font-mono text-xs">
                                      <div className="max-w-[320px] break-all text-foreground">{failure.key}</div>
                                    </div>
                                    <div className="p-3 text-xs">
                                      <div className="max-w-[260px] leading-5 text-foreground">{failure.message}</div>
                                      {failure.at ? <div className="mt-2 text-muted-foreground">{failure.at}</div> : null}
                                    </div>
                                    <div className="p-3 text-xs">
                                      {failure.source.exists === true ? (
                                        <div className="space-y-1">
                                          <div className="text-green-600">Exists</div>
                                          <div className="text-muted-foreground">{formatBytes(failure.source.size)}</div>
                                          {failure.source.contentType ? (
                                            <div className="text-muted-foreground">{failure.source.contentType}</div>
                                          ) : null}
                                          {failure.source.readable === true ? (
                                            <div className="text-green-600">Readable</div>
                                          ) : failure.source.readable === false ? (
                                            <div className="text-red-600">Read failed</div>
                                          ) : null}
                                        </div>
                                      ) : failure.source.exists === false ? (
                                        <div className="text-red-600">Missing</div>
                                      ) : (
                                        <div className="space-y-1">
                                          <div className="text-yellow-600">Unknown</div>
                                          {failure.source.error ? <div className="text-muted-foreground break-words">{failure.source.error}</div> : null}
                                        </div>
                                      )}
                                    </div>
                                    <div className="p-3 text-xs">
                                      {failure.destination.exists === true ? (
                                        <div className="space-y-1">
                                          <div className="text-green-600">Exists</div>
                                          <div className="text-muted-foreground">{formatBytes(failure.destination.size)}</div>
                                          {failure.destination.contentType ? (
                                            <div className="text-muted-foreground">{failure.destination.contentType}</div>
                                          ) : null}
                                        </div>
                                      ) : failure.destination.exists === false ? (
                                        <div className="text-muted-foreground">Not found</div>
                                      ) : (
                                        <div className="space-y-1">
                                          <div className="text-yellow-600">Unknown</div>
                                          {failure.destination.error ? <div className="text-muted-foreground break-words">{failure.destination.error}</div> : null}
                                        </div>
                                      )}
                                    </div>
                                    <div className="p-3 text-xs">
                                      <div className={cn("inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium", diagnosticCategoryTone(failure.diagnosis.category))}>
                                        {formatDiagnosticCategory(failure.diagnosis.category)}
                                      </div>
                                      <div className="mt-2 max-w-[200px] break-words text-muted-foreground">{failure.diagnosis.reason}</div>
                                    </div>
                                    <div className="p-3 text-xs">
                                      <div className="flex flex-col gap-1">
                                        {failure.download?.source ? (
                                          <a
                                            className="text-primary hover:underline"
                                            href={failure.download.source}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Download source
                                          </a>
                                        ) : (
                                          <span className="text-muted-foreground">Source n/a</span>
                                        )}
                                        {failure.download?.destination ? (
                                          <a
                                            className="text-primary hover:underline"
                                            href={failure.download.destination}
                                            target="_blank"
                                            rel="noreferrer"
                                          >
                                            Download destination
                                          </a>
                                        ) : (
                                          <span className="text-muted-foreground">Destination n/a</span>
                                        )}
                                      </div>
                                    </div>
                                    <div className="p-3 text-xs">
                                      <div className="max-w-[300px] break-words leading-5">{failure.diagnosis.recommendation}</div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </PinnedScrollableTable>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={logsOpen} onOpenChange={setLogsOpen}>
        <DialogContent className="w-[92vw] sm:max-w-[min(92vw,64rem)]">
          <DialogHeader>
            <DialogTitle>Bucket Logs</DialogTitle>
            <DialogDescription className="truncate">
              {dialogLogItem ? (
                <span className="font-mono">
                  {dialogLogItem.sourceBucket} - {dialogLogItem.slurperJobId ?? "no job"}
                </span>
              ) : (
                "No bucket selected"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/20">
            <ScrollArea ref={bucketLogsRef} className="h-[620px] max-h-[75vh]" hideScrollbar>
              {bucketLogLines.length === 0 ? (
                <div className="p-3 text-sm text-muted-foreground">No logs yet.</div>
              ) : (
                <div className="min-w-[660px] p-2 text-xs font-mono">
                  <div className="sticky top-0 z-10 border-b bg-background/80 px-2 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                    <div
                      className="grid gap-3 text-[11px] text-muted-foreground select-none"
                      style={{ gridTemplateColumns: `${bucketLogCols.time}px ${bucketLogCols.stage}px 1fr` }}
                    >
                      <div className="relative pr-8">
                        Time
                        <div
                          className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground cursor-col-resize"
                          role="separator"
                          aria-label="Resize Time column"
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            resizeRef.current = {
                              kind: "bucket",
                              key: "time",
                              pointerId: e.pointerId,
                              startX: e.clientX,
                              startWidth: bucketLogCols.time,
                            }
                            try {
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </div>
                      <div className="relative pr-8">
                        Stage / Status
                        <div
                          className="absolute right-0 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground/70 hover:bg-muted/40 hover:text-muted-foreground cursor-col-resize"
                          role="separator"
                          aria-label="Resize Stage column"
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            resizeRef.current = {
                              kind: "bucket",
                              key: "stage",
                              pointerId: e.pointerId,
                              startX: e.clientX,
                              startWidth: bucketLogCols.stage,
                            }
                            try {
                              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
                            } catch {
                              // ignore
                            }
                          }}
                        >
                          <GripVertical className="h-4 w-4" />
                        </div>
                      </div>
                      <div>Message</div>
                    </div>
                  </div>
                  <div className="space-y-1 px-2 py-2">
                    {bucketLogLines.map((line, idx) => (
                      <div
                        key={`${line.atIso}-${idx}`}
                        className="grid gap-3"
                        style={{ gridTemplateColumns: `${bucketLogCols.time}px ${bucketLogCols.stage}px 1fr` }}
                      >
                        <div className="truncate text-muted-foreground">{formatLogTime(line.atIso)}</div>
                        <div className="truncate text-muted-foreground">
                          {line.stage ? line.stage : "-"}
                          {line.status ? ` - ${line.status}` : ""}
                        </div>
                        <div className="whitespace-pre-wrap break-words">{line.message || "-"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={workersOpen} onOpenChange={setWorkersOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Run with worker</DialogTitle>
            <DialogDescription>
              Run a worker across all buckets. It scans every bucket, repairs what it can, then verifies destination against source bucket-by-bucket before completion.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Worker</Label>
              <Select value={selectedWorkerId} onValueChange={setSelectedWorkerId} disabled={workersLoading || workers.length === 0}>
                <SelectTrigger>
                  <SelectValue placeholder={workersLoading ? "Loading workers..." : "Select worker"} />
                </SelectTrigger>
                <SelectContent>
                  {workers.map((worker) => (
                    <SelectItem key={worker.id} value={worker.id}>
                      {worker.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Mode</Label>
              <Select value={workerMode} onValueChange={(value) => setWorkerMode(value as typeof workerMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="repair_and_verify">Repair and verify</SelectItem>
                  <SelectItem value="verify_only">Verify only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" disabled={workersLoading || !selectedWorkerId || dispatchingWorkerId === selectedWorkerId} onClick={() => void dispatchMigrationWorker()}>
              {dispatchingWorkerId === selectedWorkerId ? <Spinner className="mr-0" /> : <Play className="h-4 w-4 mr-0" />}
              Dispatch worker
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={manualCompleteOpen} onOpenChange={setManualCompleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark migration completed?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the migration as completed and switch the active Cloudflare account to the migrated target account.
              The previous active account will be disabled. There is no automatic rollback after this switch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyAction)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setManualCompleteOpen(false)
                void runMigrationAction("mark_completed")
              }}
              disabled={Boolean(busyAction)}
            >
              {busyAction === "mark_completed" ? <Spinner className="mr-0" /> : null}
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete migration?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the migration and its stored items from the database. It does not cancel Cloudflare jobs that may already be running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={Boolean(busyAction)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteMigration} disabled={Boolean(busyAction)}>
              {busyAction === "delete" ? <Spinner className="mr-0" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}





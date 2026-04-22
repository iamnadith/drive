"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, ExternalLink, FolderCog, RefreshCw, Workflow } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type RepairJob = {
  id: string
  migrationId: string
  claimedByAgentId?: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  mode: "verify_only" | "repair_only" | "repair_and_verify"
  payload: Record<string, unknown>
  progress: Record<string, unknown>
  result: Record<string, unknown>
  summary?: string
  error?: string
  createdAt: string
  updatedAt: string
  linkedRun?: {
    id: string
    status: string
    payload?: Record<string, unknown>
  } | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatDate(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function formatBytes(value?: number) {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[index]}`
}

function statusBadge(status: string | undefined) {
  const value = String(status ?? "").toLowerCase()
  if (value === "completed" || value === "copied") return <Badge className="bg-green-600">Completed</Badge>
  if (value === "running" || value === "copying") return <Badge className="bg-blue-600">Running</Badge>
  if (value === "claimed") return <Badge className="bg-cyan-600">Claimed</Badge>
  if (value === "pending") return <Badge variant="secondary">Pending</Badge>
  if (value === "failed") return <Badge variant="destructive">Failed</Badge>
  if (value === "canceled") return <Badge variant="outline">Aborted</Badge>
  if (value === "scanning") return <Badge className="bg-sky-600">Scanning</Badge>
  if (value === "verifying") return <Badge className="bg-purple-600">Verifying</Badge>
  return <Badge variant="outline">{value || "Unknown"}</Badge>
}

function readTotals(job: RepairJob | null) {
  const progressTotals = job && isRecord(job.progress.totals) ? job.progress.totals : null
  const resultTotals = job && isRecord(job.result.totals) ? job.result.totals : null
  const source = resultTotals ?? progressTotals
  return {
    transferred: typeof source?.transferred === "number" ? source.transferred : 0,
    failed: typeof source?.failed === "number" ? source.failed : 0,
    skipped: typeof source?.skipped === "number" ? source.skipped : 0,
    missing: typeof source?.missing === "number" ? source.missing : 0,
    mismatched: typeof source?.mismatched === "number" ? source.mismatched : 0,
    completedItems: typeof source?.completedItems === "number" ? source.completedItems : 0,
    failedItems: typeof source?.failedItems === "number" ? source.failedItems : 0,
  }
}

function readItemProgress(job: RepairJob | null) {
  const source = Array.isArray(job?.progress?.itemProgress)
    ? job?.progress?.itemProgress
    : Array.isArray(job?.result?.itemProgress)
      ? job?.result?.itemProgress
      : []
  return source.filter(isRecord) as Array<Record<string, unknown>>
}

function readPayloadItems(job: RepairJob | null) {
  const source = Array.isArray(job?.payload?.items) ? job?.payload?.items : []
  return source.filter(isRecord) as Array<Record<string, unknown>>
}

function readFileEvents(job: RepairJob | null) {
  const source = Array.isArray(job?.progress?.fileEvents)
    ? job?.progress?.fileEvents
    : Array.isArray(job?.result?.fileEvents)
      ? job?.result?.fileEvents
      : []
  return (source.filter(isRecord) as Array<Record<string, unknown>>).sort((a, b) =>
    String(b.updatedAt ?? b.completedAt ?? b.startedAt ?? "").localeCompare(String(a.updatedAt ?? a.completedAt ?? a.startedAt ?? ""))
  )
}

function findActiveFileEvent(fileEvents: Array<Record<string, unknown>>) {
  return (
    fileEvents.find((entry) => {
      const status = String(entry.status ?? "").toLowerCase()
      return status === "copying" || status === "scanning" || status === "verifying"
    }) ?? null
  )
}

function readLogs(job: RepairJob | null) {
  const lines: Array<Record<string, unknown>> = []
  const append = (entry: unknown) => {
    if (isRecord(entry) && typeof entry.message === "string") lines.push(entry)
    else if (typeof entry === "string" && entry.trim()) lines.push({ at: "", message: entry.trim() })
  }
  append(job?.summary)
  append(job?.error)
  const source = Array.isArray(job?.progress?.logs)
    ? job?.progress?.logs
    : Array.isArray(job?.result?.logs)
      ? job?.result?.logs
      : []
  for (const entry of source) append(entry)
  if (Array.isArray(job?.linkedRun?.payload?.githubLogLines)) {
    for (const line of job?.linkedRun?.payload?.githubLogLines ?? []) append(line)
  }
  return lines
}

export default function WorkerJobDetailsPage() {
  const params = useParams<{ id: string }>()
  const jobId = typeof params?.id === "string" ? params.id : ""
  const [job, setJob] = React.useState<RepairJob | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [stoppingGitHubRun, setStoppingGitHubRun] = React.useState(false)

  const loadJob = React.useCallback(
    async (silent = false) => {
      if (!jobId) return
      try {
        if (silent) setRefreshing(true)
        else setLoading(true)
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json.error || "Unable to load repair job")
        setJob((json.job ?? null) as RepairJob | null)
      } catch (error) {
        if (!silent) toast.error(error instanceof Error ? error.message : "Unable to load repair job")
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [jobId]
  )

  React.useEffect(() => {
    void loadJob()
  }, [loadJob])

  React.useEffect(() => {
    if (!job) return
    const active = job.status === "pending" || job.status === "claimed" || job.status === "running"
    const timeout = window.setTimeout(() => {
      void loadJob(true)
    }, active ? 4000 : 15000)
    return () => window.clearTimeout(timeout)
  }, [job, loadJob])

  const totals = React.useMemo(() => readTotals(job), [job])
  const itemProgress = React.useMemo(() => readItemProgress(job), [job])
  const payloadItems = React.useMemo(() => readPayloadItems(job), [job])
  const fileEvents = React.useMemo(() => readFileEvents(job), [job])
  const logs = React.useMemo(() => readLogs(job), [job])
  const currentFileFromProgress = isRecord(job?.progress?.currentFile) ? (job?.progress?.currentFile as Record<string, unknown>) : null
  const activeFileEvent = React.useMemo(() => findActiveFileEvent(fileEvents), [fileEvents])
  const currentFile = currentFileFromProgress ?? activeFileEvent
  const stats = isRecord(job?.progress?.stats) ? (job?.progress?.stats as Record<string, unknown>) : null

  const bucketItems = React.useMemo(() => {
    const byId = new Map<string, Record<string, unknown>>()

    for (const item of payloadItems) {
      const itemId = typeof item.id === "string" ? item.id : typeof item.itemId === "string" ? item.itemId : ""
      if (!itemId) continue
      byId.set(itemId, {
        itemId,
        sourceBucket: typeof item.sourceBucket === "string" ? item.sourceBucket : "-",
        targetBucket: typeof item.targetBucket === "string" ? item.targetBucket : "-",
        stage: "queued",
        status: "pending",
        summary: "Queued for worker scan and verification",
        processedFiles: 0,
        totalFiles: 0,
      })
    }

    for (const item of itemProgress) {
      const itemId = typeof item.itemId === "string" ? item.itemId : ""
      if (!itemId) continue
      byId.set(itemId, {
        ...(byId.get(itemId) ?? {}),
        ...item,
      })
    }

    return Array.from(byId.values())
  }, [itemProgress, payloadItems])

  const totalCandidates = bucketItems.reduce((sum, item) => sum + (typeof item.totalFiles === "number" ? item.totalFiles : 0), 0)
  const processedCandidates = bucketItems.reduce((sum, item) => sum + (typeof item.processedFiles === "number" ? item.processedFiles : 0), 0)
  const overallPct = totalCandidates > 0 ? Math.max(0, Math.min(100, (processedCandidates / totalCandidates) * 100)) : 0
  const currentFilePct =
    currentFile && typeof currentFile.bytesTransferred === "number" && typeof currentFile.bytesTotal === "number" && currentFile.bytesTotal > 0
      ? Math.max(0, Math.min(100, (currentFile.bytesTransferred / currentFile.bytesTotal) * 100))
      : 0
  const currentFileHasByteProgress =
    currentFile && typeof currentFile.bytesTotal === "number" && currentFile.bytesTotal > 0
  const currentFileChecked =
    currentFile && typeof currentFile.checkedObjects === "number" ? currentFile.checkedObjects : undefined
  const currentFileTotalObjects =
    currentFile && typeof currentFile.totalObjects === "number" ? currentFile.totalObjects : undefined
  const currentFileScanned =
    currentFile && typeof currentFile.scannedObjects === "number" ? currentFile.scannedObjects : undefined
  const currentFileObjectPct =
    typeof currentFileChecked === "number" && typeof currentFileTotalObjects === "number" && currentFileTotalObjects > 0
      ? Math.max(0, Math.min(100, (currentFileChecked / currentFileTotalObjects) * 100))
      : 0

  const stopGitHubRun = React.useCallback(async () => {
    if (!jobId) return
    try {
      setStoppingGitHubRun(true)
      const res = await fetch(`/api/repair-jobs/${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop_github_run" }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to stop GitHub run")
      toast.success("GitHub worker run stopped")
      await loadJob(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to stop GitHub run")
    } finally {
      setStoppingGitHubRun(false)
    }
  }, [jobId, loadJob])

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading worker job details...</div>
  }

  if (!job) {
    return <div className="p-6 text-sm text-muted-foreground">Worker job not found.</div>
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Workflow className="h-4 w-4" />
            Worker job overview
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Job {job.id}</h1>
          <p className="text-sm text-muted-foreground">
            Separate live worker execution details for migration {job.migrationId}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/workers/jobs">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back
            </Link>
          </Button>
          <Button variant="outline" onClick={() => void loadJob(true)} disabled={refreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          {typeof job.linkedRun?.payload?.htmlUrl === "string" ? (
            <Button
              variant="outline"
              onClick={() => void stopGitHubRun()}
              disabled={stoppingGitHubRun}
            >
              {stoppingGitHubRun ? "Stopping..." : "Abort"}
            </Button>
          ) : null}
          {typeof job.linkedRun?.payload?.htmlUrl === "string" ? (
            <Button asChild>
              <a href={job.linkedRun.payload.htmlUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="mr-2 h-4 w-4" />
                GitHub run
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Overall progress</CardTitle>
            <CardDescription>Live worker execution progress separate from the migration overview.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                {statusBadge(job.status)}
                <span className="text-muted-foreground">{job.mode}</span>
              </div>
              <span className="font-mono">{overallPct.toFixed(1)}%</span>
            </div>
            <Progress value={overallPct} className="h-2" />
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Processed files</div>
                <div className="mt-1 text-lg font-semibold">{processedCandidates} / {totalCandidates || 0}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Transferred</div>
                <div className="mt-1 text-lg font-semibold">{totals.transferred}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Failed</div>
                <div className="mt-1 text-lg font-semibold">{totals.failed}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Missing</div>
                <div className="mt-1 text-lg font-semibold">{totals.missing}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Mismatched</div>
                <div className="mt-1 text-lg font-semibold">{totals.mismatched}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="text-xs text-muted-foreground">Buckets</div>
                <div className="mt-1 text-lg font-semibold">
                  {totals.completedItems + totals.failedItems} / {Number(stats?.totalBuckets || bucketItems.length || 0)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Current file</CardTitle>
            <CardDescription>Live file currently being scanned, copied, or verified.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {currentFile ? (
              <>
                <div className="space-y-1">
                  <div className="truncate font-mono text-xs">{String(currentFile.key ?? "-")}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{String(currentFile.stage ?? "-")}</span>
                    <span>•</span>
                    <span>{formatBytes(typeof currentFile.size === "number" ? currentFile.size : undefined)}</span>
                  </div>
                </div>
                {currentFileHasByteProgress ? (
                  <>
                    <Progress value={currentFilePct} className="h-2" />
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(typeof currentFile.bytesTransferred === "number" ? currentFile.bytesTransferred : undefined)} /{" "}
                      {formatBytes(typeof currentFile.bytesTotal === "number" ? currentFile.bytesTotal : undefined)}
                    </div>
                  </>
                ) : typeof currentFileChecked === "number" && typeof currentFileTotalObjects === "number" ? (
                  <>
                    <Progress value={currentFileObjectPct} className="h-2" />
                    <div className="text-xs text-muted-foreground">
                      Checked {currentFileChecked} / {currentFileTotalObjects}
                      {typeof currentFile.missing === "number" || typeof currentFile.mismatched === "number"
                        ? ` • Missing ${Number(currentFile.missing || 0)} • Mismatched ${Number(currentFile.mismatched || 0)}`
                        : ""}
                    </div>
                  </>
                ) : typeof currentFileScanned === "number" ? (
                  <div className="text-xs text-muted-foreground">
                    {String(currentFile.scanPhase ?? "scan") === "destination" ? "Destination" : "Source"} scan: {currentFileScanned} object(s)
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">Status: {String(currentFile.status ?? "running")}</div>
                )}
              </>
            ) : (
              <div className="text-sm text-muted-foreground">No file is active right now.</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Live stats</CardTitle>
            <CardDescription>Worker scan, verify, and bucket totals.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Scanned source</span><span>{Number(stats?.scannedSourceObjects || 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Scanned destination</span><span>{Number(stats?.scannedDestinationObjects || 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Verified objects</span><span>{Number(stats?.verifiedObjects || 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Repair candidates</span><span>{Number(stats?.repairCandidates || 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Completed buckets</span><span>{Number(stats?.completedBuckets || 0)}</span></div>
            <div className="flex items-center justify-between"><span className="text-muted-foreground">Failed buckets</span><span>{Number(stats?.failedBuckets || 0)}</span></div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bucket execution</CardTitle>
          <CardDescription>Every migration bucket assigned to this worker job, including already completed and no-file buckets.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {bucketItems.length > 0 ? bucketItems.map((item) => {
            const processed = typeof item.processedFiles === "number" ? item.processedFiles : 0
            const total = typeof item.totalFiles === "number" ? item.totalFiles : 0
            const percent = total > 0 ? Math.max(0, Math.min(100, (processed / total) * 100)) : 0
            return (
              <div key={String(item.itemId ?? Math.random())} className="rounded-xl border p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <FolderCog className="h-4 w-4 text-muted-foreground" />
                      <span className="font-semibold">{String(item.sourceBucket ?? "-")}</span>
                      {statusBadge(typeof item.status === "string" ? item.status : undefined)}
                    </div>
                    <div className="text-xs text-muted-foreground">{String(item.targetBucket ?? "-")}</div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{String(item.stage ?? "-")}</div>
                    <div>{formatDate(typeof item.updatedAt === "string" ? item.updatedAt : undefined)}</div>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span>{String(item.summary ?? "No summary")}</span>
                    <span className="font-mono">{processed}/{total || 0}</span>
                  </div>
                  <Progress value={percent} className="h-2" />
                </div>
                <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3 xl:grid-cols-6">
                  <div>Transferred: {Number(item.transferred || 0)}</div>
                  <div>Failed: {Number(item.failed || 0)}</div>
                  <div>Skipped: {Number(item.skipped || 0)}</div>
                  <div>Missing: {Number(item.finalMissing || item.initialMissing || 0)}</div>
                  <div>Mismatched: {Number(item.finalMismatched || item.initialMismatched || 0)}</div>
                  <div>Scanned: {Number(item.scanSourceCount || 0)} / {Number(item.scanDestinationCount || 0)}</div>
                </div>
              </div>
            )
          }) : <div className="text-sm text-muted-foreground">No bucket telemetry captured yet.</div>}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.4fr,1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">File activity</CardTitle>
            <CardDescription>Captured file-level progress, copy status, sizes, and errors.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="max-h-[720px] overflow-auto rounded-xl border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead className="text-center">Stage</TableHead>
                    <TableHead className="text-center">Status</TableHead>
                    <TableHead className="text-center">Size</TableHead>
                    <TableHead className="text-center">Progress</TableHead>
                    <TableHead>Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fileEvents.length > 0 ? fileEvents.map((file) => {
                    const total = typeof file.bytesTotal === "number" ? file.bytesTotal : typeof file.size === "number" ? file.size : 0
                    const loaded = typeof file.bytesTransferred === "number" ? file.bytesTransferred : 0
                    const percent = total > 0 ? Math.max(0, Math.min(100, (loaded / total) * 100)) : String(file.status ?? "") === "copied" ? 100 : 0
                    return (
                      <TableRow key={`${String(file.itemId ?? "")}:${String(file.key ?? "")}`}>
                        <TableCell>
                          <div className="max-w-[420px] truncate font-mono text-xs">{String(file.key ?? "-")}</div>
                          <div className="text-xs text-muted-foreground">{String(file.bucket ?? "-")}</div>
                        </TableCell>
                        <TableCell className="text-center text-xs">{String(file.stage ?? "-")}</TableCell>
                        <TableCell className="text-center">{statusBadge(typeof file.status === "string" ? file.status : undefined)}</TableCell>
                        <TableCell className="text-center text-xs">{formatBytes(typeof file.size === "number" ? file.size : undefined)}</TableCell>
                        <TableCell className="min-w-[170px]">
                          <div className="space-y-1">
                            <Progress value={percent} className="h-2" />
                            <div className="text-center text-[11px] text-muted-foreground">
                              {formatBytes(loaded)} / {formatBytes(total)}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-red-500">{typeof file.error === "string" ? file.error : "-"}</TableCell>
                      </TableRow>
                    )
                  }) : (
                    <TableRow>
                      <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                        No file activity captured yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Logs</CardTitle>
            <CardDescription>Worker execution messages, failures, and linked run diagnostics.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="max-h-[720px] space-y-2 overflow-auto">
              {logs.length > 0 ? logs.map((entry, index) => (
                <div key={`${index}-${String(entry.at ?? "")}-${String(entry.message ?? "")}`} className="rounded-lg border bg-muted/40 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-xs font-medium">{String(entry.message ?? "-")}</div>
                    <div className="text-[11px] text-muted-foreground">{formatDate(typeof entry.at === "string" ? entry.at : undefined)}</div>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {Object.entries(entry)
                      .filter(([key]) => key !== "message" && key !== "at")
                      .map(([key, value]) => `${key}: ${typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)}`)
                      .join(" • ")}
                  </div>
                </div>
              )) : <div className="text-sm text-muted-foreground">No logs captured yet.</div>}
            </div>
            <div className="rounded-xl border p-3 text-xs text-muted-foreground">
              <div>Created: {formatDate(job.createdAt)}</div>
              <div>Updated: {formatDate(job.updatedAt)}</div>
              <div>Claimed by: {job.claimedByAgentId || "-"}</div>
              <div>Migration: {job.migrationId}</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

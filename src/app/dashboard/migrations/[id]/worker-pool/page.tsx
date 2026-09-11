"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, RefreshCw, Workflow } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type WorkerRun = {
  id: string
  jobId?: string
  agentId: string
  status: string
  instanceId?: string
  currentFile?: Record<string, unknown>
  currentStatus?: string
  lastHeartbeatAt?: string
  completedFiles: number
  failedFiles: number
  completedBytes: number
  createdAt: string
  updatedAt: string
}

type WorkerJob = {
  id: string
  status: string
  progress?: Record<string, unknown>
  result?: Record<string, unknown>
  summary?: string
  error?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function formatDate(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatBytes(value: number) {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`
}

function statusBadge(status?: string) {
  const value = String(status || "").toLowerCase()
  if (value === "completed") return <Badge className="bg-green-600">Completed</Badge>
  if (value === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (value === "claimed") return <Badge className="bg-sky-600">Claimed</Badge>
  if (value === "pending") return <Badge variant="secondary">Pending</Badge>
  if (value === "failed") return <Badge variant="destructive">Failed</Badge>
  return <Badge variant="outline">{value || "Unknown"}</Badge>
}

export default function MigrationWorkerPoolDetailsPage() {
  const params = useParams<{ id: string }>()
  const migrationId = typeof params?.id === "string" ? params.id : ""
  const [runs, setRuns] = React.useState<WorkerRun[]>([])
  const [jobs, setJobs] = React.useState<WorkerJob[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async (silent = false) => {
    if (!migrationId) return
    try {
      if (silent) setRefreshing(true)
      else setLoading(true)
      const response = await fetch(`/api/migrations/${encodeURIComponent(migrationId)}`, { cache: "no-store" })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || "Unable to load migration worker pool")
      const nextRuns = Array.isArray(data.workerRuns) ? data.workerRuns as WorkerRun[] : []
      setRuns(nextRuns)
      const jobResponses = await Promise.all(nextRuns.flatMap((run) => run.jobId ? [fetch(`/api/repair-jobs/${encodeURIComponent(run.jobId)}`, { cache: "no-store" })] : []))
      const nextJobs = await Promise.all(jobResponses.map(async (jobResponse) => {
        if (!jobResponse.ok) return null
        const body = await jobResponse.json().catch(() => ({}))
        return isRecord(body.job) ? body.job as WorkerJob : null
      }))
      setJobs(nextJobs.filter((job): job is WorkerJob => Boolean(job)))
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : "Unable to load migration worker pool")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [migrationId])

  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    if (loading) return
    const active = runs.some((run) => ["pending", "claimed", "running"].includes(run.status))
    const timer = window.setTimeout(() => void load(true), active ? 4000 : 15000)
    return () => window.clearTimeout(timer)
  }, [loading, load, runs])

  const totals = React.useMemo(() => ({
    completedFiles: runs.reduce((sum, run) => sum + Number(run.completedFiles || 0), 0),
    failedFiles: runs.reduce((sum, run) => sum + Number(run.failedFiles || 0), 0),
    completedBytes: runs.reduce((sum, run) => sum + Number(run.completedBytes || 0), 0),
    active: runs.filter((run) => ["pending", "claimed", "running"].includes(run.status)).length,
  }), [runs])

  const telemetry = React.useMemo(() => {
    let totalFiles = 0
    let processedFiles = 0
    let transferred = 0
    let skipped = 0
    let missing = 0
    let mismatched = 0
    const logs: Array<Record<string, unknown>> = []
    const files: Array<Record<string, unknown>> = []
    for (const job of jobs) {
      const source = isRecord(job.result?.totals) ? job.result?.totals : isRecord(job.progress?.totals) ? job.progress?.totals : {}
      transferred += Number(source?.transferred || 0)
      skipped += Number(source?.skipped || 0)
      missing += Number(source?.missing || 0)
      mismatched += Number(source?.mismatched || 0)
      const items = Array.isArray(job.progress?.itemProgress) ? job.progress.itemProgress : []
      for (const item of items) {
        if (!isRecord(item)) continue
        totalFiles += Number(item.totalFiles || 0)
        processedFiles += Number(item.processedFiles || 0)
      }
      const jobLogs = Array.isArray(job.progress?.logs) ? job.progress.logs : []
      for (const entry of jobLogs) if (isRecord(entry)) logs.push({ ...entry, jobId: job.id })
      const jobFiles = Array.isArray(job.progress?.fileEvents)
        ? job.progress.fileEvents
        : Array.isArray(job.result?.fileEvents) ? job.result.fileEvents : []
      for (const entry of jobFiles) if (isRecord(entry)) files.push({ ...entry, jobId: job.id })
    }
    files.sort((a, b) => String(b.updatedAt || b.completedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.completedAt || a.startedAt || "")))
    return { totalFiles, processedFiles, transferred, skipped, missing, mismatched, logs, files }
  }, [jobs])

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading migration worker pool...</div>
  const percent = telemetry.totalFiles > 0 ? Math.min(100, (telemetry.processedFiles / telemetry.totalFiles) * 100) : 0

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Workflow className="h-4 w-4" />Migration worker pool</div>
          <h1 className="text-3xl font-bold tracking-tight">Worker pool details</h1>
          <p className="text-sm text-muted-foreground">Combined live execution details for every worker assigned to this migration.</p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline"><Link href={`/dashboard/migrations/${encodeURIComponent(migrationId)}`}><ArrowLeft className="mr-2 h-4 w-4" />Back</Link></Button>
          <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}><RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />Refresh</Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="xl:col-span-2"><CardHeader><CardTitle className="text-base">Overall progress</CardTitle><CardDescription>Combined progress across the complete migration worker pool.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex justify-between text-sm"><span>{totals.active} active / {runs.length} workers</span><span className="font-mono">{percent.toFixed(1)}%</span></div><Progress value={percent} className="h-2" /><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Processed files</div><div className="mt-1 text-lg font-semibold">{telemetry.processedFiles || totals.completedFiles} / {telemetry.totalFiles || "-"}</div></div><div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Transferred</div><div className="mt-1 text-lg font-semibold">{telemetry.transferred || totals.completedFiles}</div></div><div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">Failed</div><div className="mt-1 text-lg font-semibold">{totals.failedFiles}</div></div></div></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Transfer totals</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><div className="flex justify-between"><span className="text-muted-foreground">Transferred bytes</span><span>{formatBytes(totals.completedBytes)}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Skipped</span><span>{telemetry.skipped}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Missing</span><span>{telemetry.missing}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Mismatched</span><span>{telemetry.mismatched}</span></div></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Pool status</CardTitle></CardHeader><CardContent className="space-y-2 text-sm"><div className="flex justify-between"><span className="text-muted-foreground">Total workers</span><span>{runs.length}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Active</span><span>{totals.active}</span></div><div className="flex justify-between"><span className="text-muted-foreground">Jobs reporting</span><span>{jobs.length}</span></div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">File transfers</CardTitle><CardDescription>Combined live and completed file activity across the migration worker pool.</CardDescription></CardHeader>
        <CardContent>
          <div className="max-h-[720px] overflow-auto rounded-xl border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-background"><TableRow><TableHead>File</TableHead><TableHead>Bucket</TableHead><TableHead className="text-center">Status</TableHead><TableHead className="text-center">Size</TableHead><TableHead className="min-w-[180px] text-center">Progress</TableHead><TableHead>Error</TableHead></TableRow></TableHeader>
              <TableBody>
                {telemetry.files.length ? telemetry.files.map((file, index) => {
                  const total = Number(file.bytesTotal || file.size || 0)
                  const loaded = Number(file.bytesTransferred || (String(file.status) === "copied" ? total : 0))
                  const filePercent = total > 0 ? Math.min(100, (loaded / total) * 100) : 0
                  return <TableRow key={`${String(file.itemId || "")}:${String(file.key || "")}:${index}`}><TableCell><div className="max-w-[420px] truncate font-mono text-xs" title={String(file.key || "")}>{String(file.key || "-")}</div></TableCell><TableCell className="text-xs">{String(file.bucket || file.sourceBucket || "-")}</TableCell><TableCell className="text-center">{statusBadge(typeof file.status === "string" ? file.status : undefined)}</TableCell><TableCell className="text-center text-xs">{formatBytes(Number(file.size || total))}</TableCell><TableCell><div className="space-y-1"><Progress value={filePercent} className="h-2" /><div className="text-center text-[11px] text-muted-foreground">{formatBytes(loaded)} / {formatBytes(total)}</div></div></TableCell><TableCell className="text-xs text-red-500">{String(file.error || "-")}</TableCell></TableRow>
                }) : <TableRow><TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">No file transfers captured yet.</TableCell></TableRow>}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card><CardHeader><CardTitle className="text-base">Combined logs</CardTitle><CardDescription>Live messages from every worker job in the pool.</CardDescription></CardHeader><CardContent><div className="max-h-[620px] space-y-2 overflow-auto">{telemetry.logs.length ? telemetry.logs.map((entry, index) => <div key={`${String(entry.jobId)}-${index}`} className="rounded-lg border bg-muted/40 p-3"><div className="text-xs font-medium">{String(entry.message || "-")}</div><div className="mt-1 text-[11px] text-muted-foreground">Worker job {String(entry.jobId)} · {formatDate(typeof entry.at === "string" ? entry.at : undefined)}</div></div>) : <div className="text-sm text-muted-foreground">No worker logs captured yet.</div>}</div></CardContent></Card>
    </div>
  )
}

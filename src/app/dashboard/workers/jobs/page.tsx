"use client"

import * as React from "react"
import Link from "next/link"
import { Eye, RefreshCw, Square, Trash2, Workflow } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

type RepairJobRow = {
  id: string
  migrationId: string
  claimedByAgentId?: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  mode: "verify_only" | "repair_only" | "repair_and_verify"
  payload?: Record<string, unknown>
  progress?: Record<string, unknown>
  result?: Record<string, unknown>
  summary?: string
  error?: string
  createdAt: string
  updatedAt: string
  linkedRun?: {
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    payload?: Record<string, unknown>
    createdAt: string
    updatedAt: string
  } | null
}

function formatDate(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function jobStatusBadge(status: RepairJobRow["status"]) {
  if (status === "completed") return <Badge>Completed</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  if (status === "running") return <Badge className="bg-blue-600">Running</Badge>
  if (status === "claimed") return <Badge className="bg-cyan-600">Claimed</Badge>
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>
  return <Badge variant="outline">Aborted</Badge>
}

function readLogLines(job: RepairJobRow): string[] {
  const lines: string[] = []
  const pushLine = (value: unknown) => {
    if (typeof value !== "string") return
    const trimmed = value.trim()
    if (!trimmed || lines.includes(trimmed)) return
    lines.push(trimmed)
  }

  pushLine(job.summary)
  pushLine(job.error)
  const payload = job.linkedRun?.payload ?? {}
  if (Array.isArray(payload.githubLogLines)) {
    for (const line of payload.githubLogLines) pushLine(line)
  }
  pushLine(payload.failureReason)

  const items =
    job.result && typeof job.result === "object" && Array.isArray((job.result as { items?: unknown[] }).items)
      ? ((job.result as { items: Array<Record<string, unknown>> }).items)
      : []
  for (const item of items) {
    if (Array.isArray(item.failureSamples)) {
      for (const sample of item.failureSamples.slice(0, 6)) {
        if (sample && typeof sample === "object") {
          const key = typeof sample.key === "string" ? sample.key : "item"
          const error = typeof sample.error === "string" ? sample.error : ""
          pushLine(error ? `${key}: ${error}` : key)
        }
      }
    }
  }

  return lines.slice(0, 12)
}

export default function WorkerJobsPage() {
  const [jobs, setJobs] = React.useState<RepairJobRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [deletingJobId, setDeletingJobId] = React.useState<string | null>(null)
  const [abortingJobId, setAbortingJobId] = React.useState<string | null>(null)

  const loadJobs = React.useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch("/api/repair-jobs", { cache: "no-store" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to load repair jobs")
      setJobs(Array.isArray(json.jobs) ? json.jobs : [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load repair jobs")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  const deleteJob = React.useCallback(async (job: RepairJobRow) => {
    setDeletingJobId(job.id)
    try {
      const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to delete repair job")
      toast.success("Repair job deleted")
      await loadJobs()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete repair job")
    } finally {
      setDeletingJobId(null)
    }
  }, [loadJobs])

  const abortJob = React.useCallback(async (job: RepairJobRow) => {
    setAbortingJobId(job.id)
    try {
      const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "abort" }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to abort repair job")
      toast.success("Repair job aborted")
      await loadJobs()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to abort repair job")
    } finally {
      setAbortingJobId(null)
    }
  }, [loadJobs])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Workflow className="h-4 w-4" />
            Worker repair history
          </div>
          <h1 className="text-3xl font-bold tracking-tight">All Repair Jobs</h1>
          <p className="text-sm text-muted-foreground">Full repair job list with details, abort, and delete actions.</p>
        </div>
        <Button variant="outline" onClick={() => void loadJobs()} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4">
        {jobs.map((job) => (
          <Card key={job.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div>
                <CardTitle className="text-base">Migration {job.migrationId}</CardTitle>
                <CardDescription className="font-mono text-xs">{job.id}</CardDescription>
              </div>
              {jobStatusBadge(job.status)}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <div className="text-muted-foreground">Mode</div>
                  <div className="mt-1">{job.mode}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-muted-foreground">Claimed by</div>
                  <div className="mt-1">{job.claimedByAgentId || "-"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-muted-foreground">Updated</div>
                  <div className="mt-1">{formatDate(job.updatedAt)}</div>
                </div>
              </div>
              <div>{job.summary || job.error || readLogLines(job)[0] || "-"}</div>
              <div className="flex flex-wrap justify-end gap-2">
                {!["completed", "failed", "canceled"].includes(job.status) ? (
                  <Button variant="outline" size="sm" disabled={abortingJobId === job.id} onClick={() => void abortJob(job)}>
                    <Square className="mr-1 h-4 w-4" />
                    {abortingJobId === job.id ? "Aborting..." : "Abort"}
                  </Button>
                ) : null}
                <Button asChild variant="outline" size="sm">
                  <Link href={`/dashboard/workers/jobs/${encodeURIComponent(job.id)}`}>
                    <Eye className="mr-1 h-4 w-4" />
                    Details
                  </Link>
                </Button>
                <Button variant="outline" size="sm" disabled={deletingJobId === job.id} onClick={() => void deleteJob(job)}>
                  <Trash2 className="mr-1 h-4 w-4" />
                  {deletingJobId === job.id ? "Deleting..." : "Delete"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

"use client"

import * as React from "react"
import Link from "next/link"
import { Activity, Bot, CircleDot, Clock3, Copy, Eye, Github, HardDrive, Play, Plus, RefreshCw, Search, Server, Shield, Square, Trash2, Workflow } from "lucide-react"
import { toast } from "sonner"
import { useRouter, useSearchParams } from "next/navigation"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { WorkerPageSkeleton } from "@/components/dashboard/loading-skeletons"
import { cn } from "@/lib/utils"

type AgentProvider = "self_hosted" | "github_actions" | "local"
type AgentStatus = "pending_registration" | "online" | "offline" | "busy" | "dispatch_ready" | "disabled" | "error"
type AgentCapability = "scan" | "verify" | "repair" | "bulk_migrate" | "diagnostics"

type AgentRow = {
  id: string
  name: string
  provider: AgentProvider
  status: AgentStatus
  capabilities: AgentCapability[]
  endpointDomain?: string
  endpointIp?: string
  githubRepoOwner?: string
  githubRepoName?: string
  githubWorkflowFile?: string
  githubRef?: string
  githubRepositoryId?: string
  notes?: string
  lastHeartbeatAt?: string
  lastSeenIp?: string
  lastSeenHost?: string
  lastSeenVersion?: string
  lastError?: string
  createdAt: string
  updatedAt: string
  latestRun?: {
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    externalRunId?: string
    jobReference?: string
    payload?: Record<string, unknown>
    createdAt: string
  } | null
}

type RepairJobRow = {
  id: string
  migrationId: string
  requestedByAgentId?: string
  claimedByAgentId?: string
  status: "pending" | "claimed" | "running" | "completed" | "failed" | "canceled"
  mode: "verify_only" | "repair_only" | "repair_and_verify"
  payload?: Record<string, unknown>
  progress?: Record<string, unknown>
  result?: Record<string, unknown>
  summary?: string
  error?: string
  claimedAt?: string
  startedAt?: string
  completedAt?: string
  lastHeartbeatAt?: string
  createdAt: string
  updatedAt: string
  linkedRun?: {
    id: string
    status: "pending" | "running" | "completed" | "failed" | "canceled"
    runType: string
    summary?: string
    externalRunId?: string
    payload?: Record<string, unknown>
    createdAt: string
    updatedAt: string
  } | null
}

type MigrationRow = {
  id: string
  status: string
  createdAt: string
}

function normalizeAgentRow(input: unknown): AgentRow | null {
  if (typeof input !== "object" || input === null) return null
  const row = input as Record<string, unknown>
  return {
    id: typeof row.id === "string" ? row.id : "",
    name: typeof row.name === "string" ? row.name : "",
    provider:
      row.provider === "github_actions" || row.provider === "self_hosted" || row.provider === "local"
        ? row.provider
        : "self_hosted",
    status:
      row.status === "pending_registration" ||
      row.status === "online" ||
      row.status === "offline" ||
      row.status === "busy" ||
      row.status === "dispatch_ready" ||
      row.status === "disabled" ||
      row.status === "error"
        ? row.status
        : "offline",
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities.filter((value): value is AgentCapability => typeof value === "string") as AgentCapability[]) : [],
    endpointDomain: typeof row.endpointDomain === "string" ? row.endpointDomain : undefined,
    endpointIp: typeof row.endpointIp === "string" ? row.endpointIp : undefined,
    githubRepoOwner: typeof row.githubRepoOwner === "string" ? row.githubRepoOwner : undefined,
    githubRepoName: typeof row.githubRepoName === "string" ? row.githubRepoName : undefined,
    githubWorkflowFile: typeof row.githubWorkflowFile === "string" ? row.githubWorkflowFile : undefined,
    githubRef: typeof row.githubRef === "string" ? row.githubRef : undefined,
    githubRepositoryId: typeof row.githubRepositoryId === "string" ? row.githubRepositoryId : undefined,
    notes: typeof row.notes === "string" ? row.notes : undefined,
    lastHeartbeatAt: typeof row.lastHeartbeatAt === "string" ? row.lastHeartbeatAt : undefined,
    lastSeenIp: typeof row.lastSeenIp === "string" ? row.lastSeenIp : undefined,
    lastSeenHost: typeof row.lastSeenHost === "string" ? row.lastSeenHost : undefined,
    lastSeenVersion: typeof row.lastSeenVersion === "string" ? row.lastSeenVersion : undefined,
    lastError: typeof row.lastError === "string" ? row.lastError : undefined,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    latestRun: typeof row.latestRun === "object" && row.latestRun !== null ? (row.latestRun as AgentRow["latestRun"]) : null,
  }
}

const capabilityOptions: Array<{ value: AgentCapability; label: string }> = [
  { value: "scan", label: "Scan" },
  { value: "verify", label: "Verify" },
  { value: "repair", label: "Repair" },
  { value: "bulk_migrate", label: "Bulk migrate" },
  { value: "diagnostics", label: "Diagnostics" },
]

const defaultCapabilities = capabilityOptions.map((capability) => capability.value)

function formatDate(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getEffectiveStatus(agent: AgentRow): AgentStatus {
  if (agent.provider === "github_actions") {
    if (agent.lastHeartbeatAt) {
      const last = new Date(agent.lastHeartbeatAt).getTime()
      if (Number.isFinite(last) && Date.now() - last <= 90_000) return "online"
    }
    return agent.status === "online" || agent.status === "busy" ? "online" : "offline"
  }
  if (agent.status === "error") return "offline"
  if ((agent.provider === "self_hosted" || agent.provider === "local") && agent.status === "online") {
    if (!agent.lastHeartbeatAt) return "offline"
    const last = new Date(agent.lastHeartbeatAt).getTime()
    if (!Number.isFinite(last)) return "offline"
    if (Date.now() - last > 60_000) return "offline"
  }
  return agent.status
}

function statusBadge(status: AgentStatus) {
  if (status === "online") return <Badge className="bg-green-600">Online</Badge>
  if (status === "busy") return <Badge className="bg-primary text-primary-foreground">Busy</Badge>
  if (status === "dispatch_ready") return <Badge className="bg-cyan-600">Dispatch ready</Badge>
  if (status === "pending_registration") return <Badge variant="secondary">Pending registration</Badge>
  if (status === "offline") return <Badge variant="outline">Offline</Badge>
  if (status === "disabled") return <Badge variant="outline">Disabled</Badge>
  return <Badge variant="destructive">Error</Badge>
}

function providerLabel(provider: AgentProvider): string {
  if (provider === "github_actions") return "GitHub Actions"
  if (provider === "local") return "Local"
  return "Self-hosted"
}

function getWorkerConnectionLabel(worker: Pick<AgentRow, "provider" | "githubRepoOwner" | "githubRepoName" | "lastSeenHost" | "endpointDomain" | "lastSeenIp" | "endpointIp">): string {
  if (worker.provider === "github_actions") {
    return worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner} / ${worker.githubRepoName}` : "-"
  }
  return worker.lastSeenHost || worker.endpointDomain || worker.lastSeenIp || worker.endpointIp || "-"
}

function jobStatusBadge(status: RepairJobRow["status"]) {
  if (status === "completed") return <Badge>Completed</Badge>
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>
  if (status === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (status === "claimed") return <Badge className="bg-cyan-600">Claimed</Badge>
  if (status === "pending") return <Badge variant="secondary">Pending</Badge>
  return <Badge variant="outline">Aborted</Badge>
}

function jobStatusLabel(status: RepairJobRow["status"]): string {
  return status === "canceled" ? "Aborted" : status
}

function agentRunStatusLabel(status?: "pending" | "running" | "completed" | "failed" | "canceled"): string {
  if (!status) return "-"
  return status === "canceled" ? "aborted" : status
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

  const linkedRunPayload = job.linkedRun?.payload ?? {}
  const githubLogLines = Array.isArray(linkedRunPayload.githubLogLines) ? linkedRunPayload.githubLogLines : []
  for (const line of githubLogLines) pushLine(line)
  pushLine(linkedRunPayload.failureReason)

  const resultItems =
    job.result && typeof job.result === "object" && Array.isArray((job.result as { items?: unknown[] }).items)
      ? ((job.result as { items: Array<Record<string, unknown>> }).items)
      : []
  for (const item of resultItems) {
    if (typeof item.summary === "string") pushLine(item.summary)
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

export default function WorkersPage() {
  const ACTIVE_REFRESH_MS = 8_000
  const IDLE_REFRESH_MS = 20_000
  const router = useRouter()
  const searchParams = useSearchParams()
  const [agents, setAgents] = React.useState<AgentRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState<string | null>(null)

  const [name, setName] = React.useState("")
  const [provider, setProvider] = React.useState<AgentProvider>("github_actions")
  const [capabilities, setCapabilities] = React.useState<AgentCapability[]>(defaultCapabilities)
  const [githubRepoOwner, setGithubRepoOwner] = React.useState("")
  const [githubRepoName, setGithubRepoName] = React.useState("")
  const [githubWorkflowFile, setGithubWorkflowFile] = React.useState("")
  const [githubRef, setGithubRef] = React.useState("main")
  const [githubRepositoryId, setGithubRepositoryId] = React.useState("")
  const [githubToken, setGithubToken] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [githubConnected, setGithubConnected] = React.useState(false)
  const [githubSessionReady, setGithubSessionReady] = React.useState(false)
  const [githubRepos, setGithubRepos] = React.useState<Array<{ id: string; owner: string; name: string; fullName: string; defaultBranch?: string }>>([])
  const [githubWorkflows, setGithubWorkflows] = React.useState<Array<{ id: string; name: string; path: string }>>([])
  const [repairJobs, setRepairJobs] = React.useState<RepairJobRow[]>([])
  const [dispatchingAgentId, setDispatchingAgentId] = React.useState<string | null>(null)
  const [deletingWorkerId, setDeletingWorkerId] = React.useState<string | null>(null)
  const [deletingJobId, setDeletingJobId] = React.useState<string | null>(null)
  const [abortingJobId, setAbortingJobId] = React.useState<string | null>(null)
  const [stoppingWorkerId, setStoppingWorkerId] = React.useState<string | null>(null)
  const [dispatchOpen, setDispatchOpen] = React.useState(false)
  const [dispatchAgent, setDispatchAgent] = React.useState<AgentRow | null>(null)
  const [confirmDeleteWorker, setConfirmDeleteWorker] = React.useState<AgentRow | null>(null)
  const [confirmStopWorker, setConfirmStopWorker] = React.useState<AgentRow | null>(null)
  const [dispatchMigrationId, setDispatchMigrationId] = React.useState("")
  const [dispatchSearch, setDispatchSearch] = React.useState("")
  const [dispatchMode, setDispatchMode] = React.useState<"verify_only" | "repair_and_verify">("repair_and_verify")
  const [migrations, setMigrations] = React.useState<MigrationRow[]>([])
  const [loadingMigrations, setLoadingMigrations] = React.useState(false)
  const [selectedWorker, setSelectedWorker] = React.useState<AgentRow | null>(null)
  const [workerDetailsOpen, setWorkerDetailsOpen] = React.useState(false)
  const [workerTokenLoading, setWorkerTokenLoading] = React.useState<string | null>(null)
  const [workerTokenValue, setWorkerTokenValue] = React.useState<string | null>(null)
  const [workerTokenWorkerId, setWorkerTokenWorkerId] = React.useState<string | null>(null)
  const [createdWorkerId, setCreatedWorkerId] = React.useState<string | null>(null)
  const refreshInFlightRef = React.useRef(false)
  const shouldLiveRefresh =
    agents.some((agent) => {
      const status = getEffectiveStatus(agent)
      return status === "online"
    }) ||
    repairJobs.some((job) => !["completed", "failed", "canceled"].includes(job.status)) ||
    dispatchOpen

  const loadAgents = React.useCallback(async (notify = false) => {
    try {
      const res = await fetch("/api/workers", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load workers"
        throw new Error(message)
      }
      const rows =
        typeof json === "object" && json !== null && Array.isArray((json as any).agents)
          ? ((json as any).agents as unknown[]).map(normalizeAgentRow).filter((row): row is AgentRow => Boolean(row?.id))
          : []
      setAgents(rows)
    } catch (error) {
      if (notify) {
        toast.error(error instanceof Error ? error.message : "Unable to load workers")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRepairJobs = React.useCallback(async (notify = false) => {
    try {
      const res = await fetch("/api/repair-jobs", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load repair jobs"
        throw new Error(message)
      }
      setRepairJobs(typeof json === "object" && json !== null && Array.isArray((json as any).jobs) ? (json as any).jobs : [])
    } catch (error) {
      if (notify) {
        toast.error(error instanceof Error ? error.message : "Unable to load repair jobs")
      }
    }
  }, [])

  const refreshAll = React.useCallback(async (notify = false) => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      await Promise.all([loadAgents(notify), loadRepairJobs(notify)])
    } finally {
      refreshInFlightRef.current = false
    }
  }, [loadAgents, loadRepairJobs])

  React.useEffect(() => {
    void refreshAll()
    const refreshIntervalMs = shouldLiveRefresh ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS
    const timer = window.setInterval(() => {
      void refreshAll()
    }, refreshIntervalMs)

    const onFocus = () => void refreshAll()
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshAll()
    }

    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [ACTIVE_REFRESH_MS, IDLE_REFRESH_MS, refreshAll, shouldLiveRefresh])

  React.useEffect(() => {
    const status = searchParams.get("github")
    if (status === "connected") {
      toast.success("GitHub connected")
      setGithubConnected(true)
      setGithubSessionReady(true)
    } else if (status === "error") {
      toast.error("GitHub connection failed")
    }
  }, [searchParams])

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const data = event.data
      if (!data || typeof data !== "object" || (data as { type?: string }).type !== "github-oauth") return

      if ((data as { status?: string }).status === "connected") {
        setGithubConnected(true)
        setGithubSessionReady(true)
        toast.success("GitHub connected")
      } else {
        toast.error("GitHub connection failed")
      }
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  const loadGitHubRepos = React.useCallback(async () => {
    try {
      const res = await fetch("/api/github/repos", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 401) {
          setGithubConnected(false)
          setGithubRepos([])
          return
        }
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load GitHub repositories"
        throw new Error(message)
      }
      setGithubConnected(true)
      setGithubRepos(typeof json === "object" && json !== null && Array.isArray((json as any).repos) ? (json as any).repos : [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load GitHub repositories")
    }
  }, [])

  React.useEffect(() => {
    if (provider !== "github_actions" || !open || !githubSessionReady) return
    void loadGitHubRepos()
  }, [provider, open, loadGitHubRepos, githubSessionReady])

  React.useEffect(() => {
    if (!githubConnected || !githubSessionReady || provider !== "github_actions" || !open) return
    void loadGitHubRepos()
  }, [githubConnected, githubSessionReady, loadGitHubRepos, open, provider])

  React.useEffect(() => {
    if (!githubRepoOwner || !githubRepoName || provider !== "github_actions") {
      setGithubWorkflows([])
      return
    }
    ;(async () => {
      try {
        const res = await fetch(`/api/github/workflows?owner=${encodeURIComponent(githubRepoOwner)}&repo=${encodeURIComponent(githubRepoName)}`, { cache: "no-store" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load GitHub workflows"
          throw new Error(message)
        }
        setGithubWorkflows(typeof json === "object" && json !== null && Array.isArray((json as any).workflows) ? (json as any).workflows : [])
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to load GitHub workflows")
      }
    })()
  }, [githubRepoOwner, githubRepoName, provider])

  const resetForm = React.useCallback(() => {
    setName("")
    setProvider("github_actions")
    setCapabilities(defaultCapabilities)
    setGithubRepoOwner("")
    setGithubRepoName("")
    setGithubWorkflowFile("")
    setGithubRef("main")
    setGithubRepositoryId("")
    setGithubToken("")
    setNotes("")
    setCreatedToken(null)
    setCreatedWorkerId(null)
    setGithubConnected(false)
    setGithubSessionReady(false)
    setGithubRepos([])
    setGithubWorkflows([])
  }, [])

  const loadMigrations = React.useCallback(async () => {
    try {
      setLoadingMigrations(true)
      const res = await fetch("/api/migrations", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load migrations"
        throw new Error(message)
      }
      const rows =
        typeof json === "object" && json !== null && Array.isArray((json as any).migrations)
          ? ((json as any).migrations as MigrationRow[])
          : []
      setMigrations(rows)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load migrations")
    } finally {
      setLoadingMigrations(false)
    }
  }, [])

  const copyText = React.useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`)
    } catch {
      toast.error(`Unable to copy ${label.toLowerCase()}`)
    }
  }, [])

  const loadWorkerToken = React.useCallback(async (worker: AgentRow) => {
    setWorkerTokenLoading(worker.id)
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}/token`, { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load worker token"
        throw new Error(message)
      }
      const token =
        typeof json === "object" && json !== null && typeof (json as any).token === "string"
          ? String((json as any).token)
          : null
      const workerId =
        typeof json === "object" && json !== null && typeof (json as any).workerId === "string"
          ? String((json as any).workerId)
          : worker.id

      setWorkerTokenValue(token)
      setWorkerTokenWorkerId(workerId)
      setSelectedWorker(worker)
      setWorkerDetailsOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load worker token")
    } finally {
      setWorkerTokenLoading(null)
    }
  }, [])

  const startGitHubConnect = React.useCallback(() => {
    const connectUrl = new URL("/api/github/connect?popup=1", window.location.origin).toString()
    const fallbackUrl = new URL("/api/github/connect", window.location.origin).toString()
    const popup = window.open(
      connectUrl,
      "github-worker-connect",
      "popup=yes,width=720,height=760,resizable=yes,scrollbars=yes"
    )

    if (!popup) {
      window.location.href = fallbackUrl
    }
  }, [])

  const toggleCapability = (value: AgentCapability, checked: boolean) => {
    setCapabilities((current) => {
      if (checked) return Array.from(new Set([...current, value]))
      return current.filter((entry) => entry !== value)
    })
  }

  const submit = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/workers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          provider,
          capabilities,
          endpointDomain: "",
          endpointIp: "",
          githubRepoOwner,
          githubRepoName,
          githubWorkflowFile,
          githubRef,
          githubRepositoryId,
          githubToken,
          notes,
        }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to create worker"
        throw new Error(message)
      }
      const created = typeof json === "object" && json !== null && "agent" in json ? ((json as any).agent as AgentRow) : null
      const registrationToken =
        typeof json === "object" && json !== null && typeof (json as any).registrationToken === "string"
          ? String((json as any).registrationToken)
          : null

      if (created) setAgents((current) => [created, ...current])
      setCreatedWorkerId(created?.id ?? null)
      setCreatedToken(provider === "github_actions" ? null : registrationToken)
      toast.success("Worker saved")
      if (provider === "github_actions" || !registrationToken) {
        setOpen(false)
        resetForm()
        await loadAgents()
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to create worker")
    } finally {
      setSaving(false)
    }
  }

  const deleteWorker = React.useCallback(
    async (worker: AgentRow) => {
      setDeletingWorkerId(worker.id)
      try {
        const activeWorkerJobs = repairJobs.filter(
          (job) =>
            !["completed", "failed", "canceled"].includes(job.status) &&
            (job.claimedByAgentId === worker.id || job.requestedByAgentId === worker.id)
        )

        for (const job of activeWorkerJobs) {
          const abortRes = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "abort" }),
          })
          const abortJson: unknown = await abortRes.json().catch(() => ({}))
          if (!abortRes.ok) {
            const message =
              typeof abortJson === "object" && abortJson !== null && "error" in abortJson
                ? String((abortJson as any).error)
                : "Unable to abort worker jobs before deleting the worker"
            throw new Error(message)
          }
        }

        const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to delete worker"
          throw new Error(message)
        }
        toast.success(activeWorkerJobs.length > 0 ? "Worker jobs aborted and worker deleted" : "Worker deleted")
        await loadAgents()
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete worker")
      } finally {
        setDeletingWorkerId(null)
      }
    },
    [loadAgents, loadRepairJobs, repairJobs]
  )

  const viewRepairJob = React.useCallback((jobId: string) => {
    router.push(`/dashboard/workers/jobs/${encodeURIComponent(jobId)}`)
  }, [router])

  const deleteRepairJobRecord = React.useCallback(
    async (job: RepairJobRow) => {
      setDeletingJobId(job.id)
      try {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to delete repair job"
          throw new Error(message)
        }
        toast.success("Repair job deleted")
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete repair job")
      } finally {
        setDeletingJobId(null)
      }
    },
    [loadRepairJobs]
  )

  const abortRepairJobRecord = React.useCallback(
    async (job: RepairJobRow) => {
      setAbortingJobId(job.id)
      try {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(job.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "abort" }),
        })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to abort repair job"
          throw new Error(message)
        }
        toast.success("Repair job aborted")
        await loadRepairJobs()
        await loadAgents()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to abort repair job")
      } finally {
        setAbortingJobId(null)
      }
    },
    [loadAgents, loadRepairJobs]
  )

  const stopGithubWorkerRun = React.useCallback(
    async (worker: AgentRow) => {
      setStoppingWorkerId(worker.id)
      try {
        const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message =
            typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to stop GitHub worker"
          throw new Error(message)
        }
        const abortedCount =
          typeof json === "object" && json !== null && Array.isArray((json as any).abortedJobIds) ? (json as any).abortedJobIds.length : 0
        toast.success(abortedCount > 0 ? `Worker stopped and ${abortedCount} job(s) aborted` : "GitHub worker stop requested")
        await loadRepairJobs()
        await loadAgents()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to stop GitHub worker")
      } finally {
        setStoppingWorkerId(null)
      }
    },
    [loadAgents, loadRepairJobs]
  )

  const totalOnline = agents.filter((agent) => getEffectiveStatus(agent) === "online").length
  const totalGithub = agents.filter((agent) => agent.provider === "github_actions").length
  const totalSelfHosted = agents.filter((agent) => agent.provider === "self_hosted" || agent.provider === "local").length
  const totalWorkers = agents.length
  const activeJobs = repairJobs.filter((job) => !["completed", "failed", "canceled"].includes(job.status)).length
  const pendingRegistration = agents.filter((agent) => getEffectiveStatus(agent) === "pending_registration").length
  const visibleWorkers = agents.slice(0, 3)
  const visibleRepairJobs = repairJobs.slice(0, 3)
  const getWorkerLinkedJobs = React.useCallback(
    (worker: AgentRow) =>
      repairJobs.filter((job) => job.claimedByAgentId === worker.id || job.requestedByAgentId === worker.id),
    [repairJobs]
  )

  const getWorkerActiveLinkedJobs = React.useCallback(
    (worker: AgentRow) => getWorkerLinkedJobs(worker).filter((job) => !["completed", "failed", "canceled"].includes(job.status)),
    [getWorkerLinkedJobs]
  )

  const canStopWorker = React.useCallback(
    (worker: AgentRow) =>
      worker.provider === "github_actions" &&
      (
        getWorkerLinkedJobs(worker).length > 0 ||
        worker.latestRun?.status === "pending" ||
        worker.latestRun?.status === "running"
      ),
    [getWorkerLinkedJobs]
  )
  const filteredMigrations = migrations.filter((migration) => {
    const query = dispatchSearch.trim().toLowerCase()
    if (!query) return true
    return migration.id.toLowerCase().includes(query) || migration.status.toLowerCase().includes(query)
  })

  const openDispatchDialog = React.useCallback((worker: AgentRow) => {
    setDispatchAgent(worker)
    setDispatchMigrationId("")
    setDispatchSearch("")
    setDispatchMode("repair_and_verify")
    setDispatchOpen(true)
    void loadMigrations()
  }, [loadMigrations])

  const handleDispatch = React.useCallback(async () => {
    if (!dispatchAgent) return
    setDispatchingAgentId(dispatchAgent.id)
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(dispatchAgent.id)}/dispatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          migrationId: dispatchMigrationId.trim(),
          mode: dispatchMode,
          workflowSupportsRuntimeInputs: true,
        }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof json === "object" && json !== null && "error" in json
            ? String((json as any).error)
            : "Unable to dispatch GitHub worker"
        throw new Error(message)
      }
      toast.success("Repair job queued and GitHub workflow dispatched")
      setDispatchOpen(false)
      setDispatchMigrationId("")
      setDispatchAgent(null)
      await loadAgents()
      await loadRepairJobs()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to dispatch GitHub worker")
    } finally {
      setDispatchingAgentId(null)
    }
  }, [dispatchAgent, dispatchMigrationId, dispatchMode, loadAgents, loadRepairJobs])

  if (loading && agents.length === 0 && repairJobs.length === 0) {
    return <WorkerPageSkeleton />
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-4 w-4" />
            Worker orchestration
          </div>
          <div className="space-y-1">
            <h1 className="text-3xl font-bold tracking-tight">Workers</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Manage GitHub-triggered and token-based workers, monitor heartbeat health, and keep repair jobs visible from one place.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void refreshAll(true)} disabled={loading}>
            <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
          <Dialog
            open={open}
            onOpenChange={(next) => {
              setOpen(next)
              if (!next) resetForm()
            }}
          >
            <DialogTrigger asChild>
              <Button className="h-8 px-3 text-sm">
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add worker
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[88vh] sm:max-h-[94vh] sm:max-w-3xl flex flex-col rounded-2xl p-0 overflow-hidden">
              <DialogHeader className="border-b px-6 py-5">
                <DialogTitle>Add worker</DialogTitle>
                <DialogDescription>
                  Connect a GitHub worker or register a self-hosted worker without changing the existing migration or account flows.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-6 p-6 pb-6">
                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Worker setup</p>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="worker-name">Worker name</Label>
                        <Input id="worker-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="repair-gh-main" />
                      </div>
                      <div className="space-y-2">
                        <Label>Worker type</Label>
                        <Select value={provider} onValueChange={(value) => setProvider(value as AgentProvider)}>
                          <SelectTrigger className="h-11">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="github_actions">GitHub Actions</SelectItem>
                            <SelectItem value="self_hosted">Self-hosted</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Capabilities</p>
                    <div className="grid gap-2 md:grid-cols-3">
                      {capabilityOptions.map((capability) => (
                        <label key={capability.value} className="flex items-center gap-2 text-sm">
                          <Checkbox
                            checked={capabilities.includes(capability.value)}
                            onCheckedChange={(checked) => toggleCapability(capability.value, checked === true)}
                          />
                          <span>{capability.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>

              {provider === "github_actions" ? (
                <div className="rounded-lg border bg-muted/40 p-4 pb-6 grid gap-4 md:grid-cols-2">
                  <div className="md:col-span-2 flex items-center gap-2">
                    <Button
                      type="button"
                      variant={githubConnected ? "outline" : "default"}
                      onClick={startGitHubConnect}
                    >
                      <Github className="mr-1 h-4 w-4" />
                      {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {githubConnected
                        ? "Connected in a separate window. Repository secrets will be provisioned automatically on save."
                        : "Open a small GitHub window, complete OAuth, and continue this form without interruption."}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label>Repository</Label>
                    <Select
                      value={githubRepoOwner && githubRepoName ? `${githubRepoOwner}/${githubRepoName}` : ""}
                      onValueChange={(value) => {
                        const [owner, repo] = value.split("/")
                        const selected = githubRepos.find((entry) => entry.owner === owner && entry.name === repo)
                        setGithubRepoOwner(owner || "")
                        setGithubRepoName(repo || "")
                        setGithubRepositoryId(selected?.id || "")
                        setGithubRef(selected?.defaultBranch || "main")
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={githubConnected ? "Select repository" : "Connect GitHub first"} />
                      </SelectTrigger>
                      <SelectContent>
                        {githubRepos.map((repo) => (
                          <SelectItem key={repo.id} value={`${repo.owner}/${repo.name}`}>
                            {repo.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Workflow</Label>
                    <Select value={githubWorkflowFile} onValueChange={setGithubWorkflowFile}>
                      <SelectTrigger>
                        <SelectValue placeholder={githubWorkflows.length > 0 ? "Select workflow" : "Choose repository first"} />
                      </SelectTrigger>
                      <SelectContent>
                        {githubWorkflows.map((workflow) => (
                          <SelectItem key={workflow.id} value={workflow.path}>
                            {workflow.name} ({workflow.path})
                          </SelectItem>
                        ))}
                        <SelectItem value=".github/workflows/agent-worker.yml">agent-worker.yml</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="github-ref">Git ref</Label>
                    <Input id="github-ref" value={githubRef} onChange={(e) => setGithubRef(e.target.value)} placeholder="main" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="repo-id">Optional repository id</Label>
                    <Input id="repo-id" value={githubRepositoryId} onChange={(e) => setGithubRepositoryId(e.target.value)} placeholder="123456789" />
                  </div>
                  <div className="space-y-2 md:col-span-2">
                    <Label htmlFor="github-token">Optional fallback GitHub token</Label>
                    <Input
                      id="github-token"
                      type="password"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder="ghp_... or fine-grained token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Usually not needed after GitHub OAuth connect. Keep this only as a server-side fallback.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                  {provider === "local"
                    ? "Local workers register with a token and heartbeat from your own machine."
                    : "Self-hosted workers register with a token."}
                </div>
              )}

                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Region, routing rules, or operational notes." />
                  </div>

              {createdToken ? (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-100">
                  <div className="font-medium">Worker credentials</div>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <div className="rounded-md border border-green-500/20 bg-black/10 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-green-200">Worker ID</div>
                        {createdWorkerId ? (
                          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-green-50 hover:bg-green-500/10" onClick={() => void copyText(createdWorkerId, "Worker ID")}>
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                        ) : null}
                      </div>
                      <div className="mt-1 break-all font-mono text-xs">{createdWorkerId || "-"}</div>
                    </div>
                    <div className="rounded-md border border-green-500/20 bg-black/10 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-xs text-green-200">Token</div>
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-green-50 hover:bg-green-500/10" onClick={() => void copyText(createdToken, "Worker token")}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      <div className="mt-1 break-all font-mono text-xs">{createdToken}</div>
                    </div>
                  </div>
                  <div className="mt-2 text-xs text-green-200">
                    Send heartbeats to <span className="font-mono">/api/workers/&lt;workerId&gt;/heartbeat</span> with this token. It is shown only once.
                  </div>
                </div>
              ) : null}
                </div>
              </div>

              <DialogFooter className="border-t px-6 py-4">
                {createdToken ? (
                  <Button
                    onClick={() => {
                      setOpen(false)
                      resetForm()
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <Button onClick={submit} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <Dialog
        open={workerDetailsOpen}
        onOpenChange={(next) => {
          setWorkerDetailsOpen(next)
          if (!next) {
            setSelectedWorker(null)
            setWorkerTokenValue(null)
            setWorkerTokenWorkerId(null)
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedWorker?.name || "Worker details"}</DialogTitle>
            <DialogDescription>Review the worker id, current connection details, and token.</DialogDescription>
          </DialogHeader>
          {selectedWorker ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Worker ID</div>
                <div className="mt-1 break-all font-mono text-xs">{workerTokenWorkerId || selectedWorker.id}</div>
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => void copyText(workerTokenWorkerId || selectedWorker.id, "Worker ID")}>
                    <Copy className="mr-1 h-4 w-4" />
                    Copy ID
                  </Button>
                </div>
              </div>
                <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Connection</div>
                <div className="mt-1">
                  {getWorkerConnectionLabel(selectedWorker)}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">
                  {selectedWorker.provider === "github_actions"
                    ? `Workflow: ${selectedWorker.githubWorkflowFile || "-"}`
                    : `Last heartbeat: ${formatDate(selectedWorker.lastHeartbeatAt)}`}
                </div>
              </div>
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Registration token</div>
                <div className="mt-1 break-all font-mono text-xs">{workerTokenValue || "No token loaded"}</div>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={workerTokenLoading === selectedWorker.id} onClick={() => void loadWorkerToken(selectedWorker)}>
                    <RefreshCw className={cn("mr-1 h-4 w-4", workerTokenLoading === selectedWorker.id && "animate-spin")} />
                    {workerTokenValue ? "Refresh token" : "Get token"}
                  </Button>
                  {workerTokenValue ? (
                    <Button variant="outline" size="sm" onClick={() => void copyText(workerTokenValue, "Worker token")}>
                      <Copy className="mr-1 h-4 w-4" />
                      Copy token
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Workers</CardTitle>
            <Bot className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalWorkers}</div>
            <p className="text-xs text-muted-foreground">{pendingRegistration} pending registration</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Connected Now</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalOnline}</div>
            <p className="text-xs text-muted-foreground">Online and busy workers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">GitHub-backed</CardTitle>
            <Github className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : totalGithub}</div>
            <p className="text-xs text-muted-foreground">{totalSelfHosted} Self Hosted workers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Queue</CardTitle>
            <Clock3 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{loading ? "-" : activeJobs}</div>
            <p className="text-xs text-muted-foreground">{repairJobs.length} repair jobs total</p>
          </CardContent>
        </Card>
      </div>

          <Dialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
          <DialogContent className="max-h-[92vh] max-w-4xl overflow-hidden p-0">
            <div className="flex max-h-[92vh] min-h-0 flex-col">
              <DialogHeader className="border-b px-6 py-5 pr-16">
                <DialogTitle>Dispatch GitHub worker</DialogTitle>
                <DialogDescription>
                  Queue a repair job and trigger the configured workflow for {dispatchAgent?.name || "the selected worker"}.
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-5">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>Select migration</Label>
                    <p className="text-xs text-muted-foreground">Choose from the migration list instead of entering an ID manually.</p>
                  </div>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={dispatchSearch}
                      onChange={(e) => setDispatchSearch(e.target.value)}
                      placeholder="Search by migration id or status"
                      className="pl-9"
                    />
                  </div>
                    <div className="overflow-hidden rounded-xl border bg-card">
                      <Table className="table-fixed border-b">
                        <colgroup>
                          <col className="w-[46%]" />
                          <col className="w-[18%]" />
                          <col className="w-[36%]" />
                        </colgroup>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead className="h-9 text-xs">Migration ID</TableHead>
                            <TableHead className="h-9 text-center text-xs">Status</TableHead>
                            <TableHead className="h-9 text-center text-xs">Created</TableHead>
                          </TableRow>
                        </TableHeader>
                      </Table>
                      <div className="max-h-[220px] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                        <Table className="table-fixed">
                          <colgroup>
                            <col className="w-[46%]" />
                            <col className="w-[18%]" />
                            <col className="w-[36%]" />
                          </colgroup>
                          <TableBody>
                          {loadingMigrations ? (
                            <TableRow>
                              <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                                Loading migrations...
                              </TableCell>
                            </TableRow>
                          ) : filteredMigrations.length === 0 ? (
                            <TableRow>
                              <TableCell colSpan={3} className="py-8 text-center text-sm text-muted-foreground">
                                No migrations matched your search.
                              </TableCell>
                            </TableRow>
                          ) : (
                              filteredMigrations.map((migration) => (
                                <TableRow
                                  key={migration.id}
                                  data-state={dispatchMigrationId === migration.id ? "selected" : undefined}
                                  className="h-11 cursor-pointer"
                                  onClick={() => setDispatchMigrationId(migration.id)}
                                >
                                  <TableCell className="py-2 align-middle">
                                    <div className="truncate font-mono text-xs" title={migration.id}>
                                      {migration.id}
                                    </div>
                                  </TableCell>
                                  <TableCell className="py-2 text-center align-middle">
                                    <Badge variant="outline">{migration.status}</Badge>
                                  </TableCell>
                                  <TableCell className="py-2 text-center align-middle text-xs text-muted-foreground">
                                    <div className="truncate" title={formatDate(migration.createdAt)}>
                                      {formatDate(migration.createdAt)}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              ))
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="rounded-xl border bg-muted/30 p-3">
                    <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Selected migration</div>
                    <div className="mt-1 break-all font-mono text-xs">{dispatchMigrationId || "No migration selected"}</div>
                  </div>
                </div>

                </div>
              </div>

              <DialogFooter className="border-t px-6 py-4">
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3">
                    <Select value={dispatchMode} onValueChange={(value) => setDispatchMode(value as typeof dispatchMode)}>
                      <SelectTrigger className="h-9 w-[220px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="repair_and_verify">Repair and verify</SelectItem>
                        <SelectItem value="verify_only">Verify only</SelectItem>
                      </SelectContent>
                    </Select>
                    <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Mode</Label>
                  </div>
                  <Button
                    disabled={!dispatchAgent || !dispatchMigrationId.trim() || dispatchingAgentId === dispatchAgent?.id}
                    onClick={() => void handleDispatch()}
                  >
                    {dispatchingAgentId === dispatchAgent?.id ? "Dispatching..." : "Dispatch"}
                  </Button>
                </div>
              </DialogFooter>
            </div>
          </DialogContent>
          </Dialog>

      <Card>
        <CardHeader className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Worker Fleet</CardTitle>
            <CardDescription>Current registration, routing, and runtime signals for the latest three workers.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1">
              <Server className="h-3.5 w-3.5" />
              {totalSelfHosted} Self Hosted
            </Badge>
            <Badge variant="outline" className="gap-1">
              <Github className="h-3.5 w-3.5" />
              {totalGithub} GitHub
            </Badge>
            {agents.length > 3 ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/workers/all">View all</Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-1">
          {!loading && agents.length === 0 ? (
            <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
              No workers configured yet. Add one to register a self-hosted worker or connect a GitHub worker repository.
            </div>
          ) : null}

          {visibleWorkers.map((worker) => {
            const effectiveStatus = getEffectiveStatus(worker)
            const summary = worker.latestRun?.summary || worker.lastError || worker.notes || "No notes yet"
            const linkedWorkerJobs = getWorkerLinkedJobs(worker)
            const activeLinkedWorkerJobs = getWorkerActiveLinkedJobs(worker)

            return (
              <div key={worker.id} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted">
                        {worker.provider === "github_actions" ? <Github className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
                      </div>
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold">{worker.name}</h3>
                          {statusBadge(effectiveStatus)}
                          <Badge variant="outline">{providerLabel(worker.provider)}</Badge>
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">{worker.id}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {(Array.isArray(worker.capabilities) ? worker.capabilities : []).map((capability) => (
                        <Badge key={capability} variant="secondary" className="font-normal">
                          {capabilityOptions.find((option) => option.value === capability)?.label ?? capability}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    {worker.provider === "github_actions" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openDispatchDialog(worker)}
                      >
                        <Play className="mr-1 h-4 w-4" />
                        Dispatch job
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={deletingWorkerId === worker.id}
                      onClick={() => setConfirmDeleteWorker(worker)}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      {deletingWorkerId === worker.id ? "Deleting..." : "Delete"}
                    </Button>
                    {worker.provider === "github_actions" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canStopWorker(worker) || stoppingWorkerId === worker.id}
                        onClick={() => setConfirmStopWorker(worker)}
                      >
                        <Square className="mr-1 h-4 w-4" />
                        {stoppingWorkerId === worker.id ? "Stopping..." : "Stop"}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={workerTokenLoading === worker.id}
                      onClick={() => void loadWorkerToken(worker)}
                    >
                      <Eye className="mr-1 h-4 w-4" />
                      {workerTokenLoading === worker.id ? "Loading..." : "Details"}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Connection</div>
                    <div className="font-medium">{getWorkerConnectionLabel(worker)}</div>
                    <div className="mt-2 text-xs text-muted-foreground">Heartbeat: {formatDate(worker.lastHeartbeatAt)}</div>
                    <div className="text-xs text-muted-foreground">Host: {worker.lastSeenHost || "-"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Repository</div>
                    <div className="font-medium">
                      {worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner}/${worker.githubRepoName}` : "-"}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">Workflow: {worker.githubWorkflowFile || "-"}</div>
                    <div className="text-xs text-muted-foreground">Ref: {worker.githubRef || "-"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Runtime</div>
                    <div className="font-medium">Version: {worker.lastSeenVersion || "-"}</div>
                    <div className="mt-2 text-xs text-muted-foreground">Last seen IP: {worker.lastSeenIp || worker.endpointIp || "-"}</div>
                    <div className="text-xs text-muted-foreground">Created: {formatDate(worker.createdAt)}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                    <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">Latest run</div>
                    <div className="font-medium">
                      {worker.latestRun ? `${worker.latestRun.runType} - ${agentRunStatusLabel(worker.latestRun.status)}` : "No runs yet"}
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">{summary}</div>
                    {worker.provider === "github_actions" ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Linked jobs: {linkedWorkerJobs.length} total, {activeLinkedWorkerJobs.length} active
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <AlertDialog open={!!confirmDeleteWorker} onOpenChange={(open: boolean) => !open && setConfirmDeleteWorker(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete worker?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDeleteWorker
                ? repairJobs.some(
                    (job) =>
                      !["completed", "failed", "canceled"].includes(job.status) &&
                      (job.claimedByAgentId === confirmDeleteWorker.id || job.requestedByAgentId === confirmDeleteWorker.id)
                  )
                  ? "This worker has active jobs. Confirming will abort those jobs first, then stop the GitHub worker run if needed, and finally delete the worker."
                  : "This will remove the worker from the system." 
                : "This will remove the worker from the system."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmDeleteWorker(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault()
                if (!confirmDeleteWorker) return
                void deleteWorker(confirmDeleteWorker).finally(() => setConfirmDeleteWorker(null))
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!confirmStopWorker} onOpenChange={(open: boolean) => !open && setConfirmStopWorker(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop GitHub worker?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmStopWorker
                ? getWorkerActiveLinkedJobs(confirmStopWorker).length > 0
                  ? "This will abort the active jobs linked to this worker and then stop its GitHub Actions workflow run."
                  : "This will stop the GitHub Actions workflow run for this worker. No active linked jobs need to be aborted."
                : "This will stop the GitHub Actions workflow run for this worker."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmStopWorker ? (
            <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="font-medium">Jobs linked to this worker</div>
              {getWorkerLinkedJobs(confirmStopWorker).length === 0 ? (
                <div className="text-muted-foreground">No linked repair jobs were found for this worker.</div>
              ) : (
                getWorkerLinkedJobs(confirmStopWorker).map((job) => (
                  <div key={job.id} className="rounded-md border bg-background p-3">
                    <div className="font-mono text-xs">{job.id}</div>
                    <div className="mt-1">Migration {job.migrationId}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Status: {jobStatusLabel(job.status)} | Mode: {job.mode}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmStopWorker(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.preventDefault()
                if (!confirmStopWorker) return
                void stopGithubWorkerRun(confirmStopWorker).finally(() => setConfirmStopWorker(null))
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Repair Jobs</CardTitle>
              <CardDescription>Latest three repair and verification jobs from the worker queue.</CardDescription>
            </div>
            {repairJobs.length > 3 ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/dashboard/workers/jobs">View all</Link>
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {repairJobs.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">No repair jobs yet.</div>
          ) : (
            <div className="space-y-2">
              {visibleRepairJobs.map((job) => (
                <div key={job.id} className="rounded-xl border p-4 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs text-muted-foreground">{job.id}</div>
                      <div className="mt-2 font-medium">Migration {job.migrationId}</div>
                      <div className="mt-1 text-xs text-muted-foreground">Mode: {job.mode}</div>
                    </div>
                    {jobStatusBadge(job.status)}
                  </div>
                  <div className="mt-3 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                    <div>Claimed by: {job.claimedByAgentId || "-"}</div>
                    <div>Updated: {formatDate(job.updatedAt)}</div>
                  </div>
                  <div className="mt-3">{job.summary || job.error || readLogLines(job)[0] || "-"}</div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2">
                    {!["completed", "failed", "canceled"].includes(job.status) ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={abortingJobId === job.id}
                        onClick={() => void abortRepairJobRecord(job)}
                      >
                        <Square className="mr-1 h-4 w-4" />
                        {abortingJobId === job.id ? "Aborting..." : "Abort"}
                      </Button>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={() => void viewRepairJob(job.id)}>
                      <Eye className="mr-1 h-4 w-4" />
                      Details
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={deletingJobId === job.id}
                      onClick={() => void deleteRepairJobRecord(job)}
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      {deletingJobId === job.id ? "Deleting..." : "Delete"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current model</CardTitle>
          <CardDescription>How entries are identified and how they connect.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-xl border p-4">
            <div className="flex items-center gap-2 font-medium"><Shield className="h-4 w-4" /> Identity</div>
            <div className="mt-2 text-muted-foreground">Self-hosted and local workers use agent id + registration token. IP/domain are descriptive metadata only.</div>
          </div>
          <div className="rounded-xl border p-4">
            <div className="flex items-center gap-2 font-medium"><Workflow className="h-4 w-4" /> GitHub</div>
            <div className="mt-2 text-muted-foreground">GitHub entries store repo, workflow, and ref so the website can dispatch jobs against the configured repository.</div>
          </div>
          <div className="rounded-xl border p-4">
            <div className="flex items-center gap-2 font-medium"><CircleDot className="h-4 w-4" /> Live status</div>
            <div className="mt-2 text-muted-foreground">This page uses adaptive refresh and turns token-based workers offline when heartbeats are stale for more than 60 seconds.</div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}




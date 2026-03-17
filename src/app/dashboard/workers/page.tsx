"use client"

import * as React from "react"
import { Bot, CircleDot, Eye, Github, HardDrive, Play, Plus, RefreshCw, Server, Shield, Square, Trash2, Workflow } from "lucide-react"
import { toast } from "sonner"
import { useSearchParams } from "next/navigation"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Textarea } from "@/components/ui/textarea"

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
}

const capabilityOptions: Array<{ value: AgentCapability; label: string }> = [
  { value: "scan", label: "Scan" },
  { value: "verify", label: "Verify" },
  { value: "repair", label: "Repair" },
  { value: "bulk_migrate", label: "Bulk migrate" },
  { value: "diagnostics", label: "Diagnostics" },
]

function formatDate(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getEffectiveStatus(agent: AgentRow): AgentStatus {
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
  if (status === "busy") return <Badge className="bg-blue-600">Busy</Badge>
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

export default function WorkersPage() {
  const LIVE_REFRESH_MS = 3_000
  const searchParams = useSearchParams()
  const [agents, setAgents] = React.useState<AgentRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [createdToken, setCreatedToken] = React.useState<string | null>(null)

  const [name, setName] = React.useState("")
  const [provider, setProvider] = React.useState<AgentProvider>("github_actions")
  const [capabilities, setCapabilities] = React.useState<AgentCapability[]>(["scan", "verify", "repair"])
  const [endpointDomain, setEndpointDomain] = React.useState("")
  const [endpointIp, setEndpointIp] = React.useState("")
  const [githubRepoOwner, setGithubRepoOwner] = React.useState("")
  const [githubRepoName, setGithubRepoName] = React.useState("")
  const [githubWorkflowFile, setGithubWorkflowFile] = React.useState("")
  const [githubRef, setGithubRef] = React.useState("main")
  const [githubRepositoryId, setGithubRepositoryId] = React.useState("")
  const [githubToken, setGithubToken] = React.useState("")
  const [notes, setNotes] = React.useState("")
  const [githubConnected, setGithubConnected] = React.useState(false)
  const [githubRepos, setGithubRepos] = React.useState<Array<{ id: string; owner: string; name: string; fullName: string; defaultBranch?: string }>>([])
  const [githubWorkflows, setGithubWorkflows] = React.useState<Array<{ id: string; name: string; path: string }>>([])
  const [repairJobs, setRepairJobs] = React.useState<RepairJobRow[]>([])
  const [showAllJobs, setShowAllJobs] = React.useState(false)
  const [selectedJob, setSelectedJob] = React.useState<RepairJobRow | null>(null)
  const [jobDetailsOpen, setJobDetailsOpen] = React.useState(false)
  const [dispatchingAgentId, setDispatchingAgentId] = React.useState<string | null>(null)
  const [deletingWorkerId, setDeletingWorkerId] = React.useState<string | null>(null)
  const [deletingJobId, setDeletingJobId] = React.useState<string | null>(null)
  const [abortingJobId, setAbortingJobId] = React.useState<string | null>(null)
  const [dispatchOpen, setDispatchOpen] = React.useState(false)
  const [dispatchAgent, setDispatchAgent] = React.useState<AgentRow | null>(null)
  const [dispatchMigrationId, setDispatchMigrationId] = React.useState("")
  const [dispatchMode, setDispatchMode] = React.useState<"verify_only" | "repair_only" | "repair_and_verify">("repair_and_verify")
  const refreshInFlightRef = React.useRef(false)

  const loadAgents = React.useCallback(async () => {
    try {
      const res = await fetch("/api/workers", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load workers"
        throw new Error(message)
      }
      const rows = typeof json === "object" && json !== null && Array.isArray((json as any).agents) ? ((json as any).agents as AgentRow[]) : []
      setAgents(rows)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load workers")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRepairJobs = React.useCallback(async () => {
    try {
      const res = await fetch("/api/repair-jobs", { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load repair jobs"
        throw new Error(message)
      }
      setRepairJobs(typeof json === "object" && json !== null && Array.isArray((json as any).jobs) ? (json as any).jobs : [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load repair jobs")
    }
  }, [])

  const refreshAll = React.useCallback(async () => {
    if (refreshInFlightRef.current) return
    refreshInFlightRef.current = true
    try {
      await Promise.all([loadAgents(), loadRepairJobs()])
      if (selectedJob?.id) {
        const res = await fetch(`/api/repair-jobs/${encodeURIComponent(selectedJob.id)}`, { cache: "no-store" })
        const json: unknown = await res.json().catch(() => ({}))
        if (res.ok) {
          const job = typeof json === "object" && json !== null && "job" in json ? ((json as any).job as RepairJobRow) : null
          if (job) setSelectedJob(job)
        }
      }
    } finally {
      refreshInFlightRef.current = false
    }
  }, [loadAgents, loadRepairJobs, selectedJob?.id])

  React.useEffect(() => {
    void refreshAll()
    const timer = window.setInterval(() => {
      void refreshAll()
    }, LIVE_REFRESH_MS)

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
  }, [refreshAll])

  React.useEffect(() => {
    const status = searchParams.get("github")
    if (status === "connected") {
      toast.success("GitHub connected")
    } else if (status === "error") {
      toast.error("GitHub connection failed")
    }
  }, [searchParams])

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
    if (provider !== "github_actions" || !open) return
    void loadGitHubRepos()
  }, [provider, open, loadGitHubRepos])

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
    setCapabilities(["scan", "verify", "repair"])
    setEndpointDomain("")
    setEndpointIp("")
    setGithubRepoOwner("")
    setGithubRepoName("")
    setGithubWorkflowFile("")
    setGithubRef("main")
    setGithubRepositoryId("")
    setGithubToken("")
    setNotes("")
    setCreatedToken(null)
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
          endpointDomain,
          endpointIp,
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
        const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}`, { method: "DELETE" })
        const json: unknown = await res.json().catch(() => ({}))
        if (!res.ok) {
          const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to delete worker"
          throw new Error(message)
        }
        toast.success("Worker deleted")
        await loadAgents()
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete worker")
      } finally {
        setDeletingWorkerId(null)
      }
    },
    [loadAgents, loadRepairJobs]
  )

  const viewRepairJob = React.useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/repair-jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = typeof json === "object" && json !== null && "error" in json ? String((json as any).error) : "Unable to load repair job"
        throw new Error(message)
      }
      const job = typeof json === "object" && json !== null && "job" in json ? ((json as any).job as RepairJobRow) : null
      if (!job) throw new Error("Repair job details are missing")
      setSelectedJob(job)
      setJobDetailsOpen(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load repair job")
    }
  }, [])

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
        if (selectedJob?.id === job.id) {
          setJobDetailsOpen(false)
          setSelectedJob(null)
        }
        toast.success("Repair job deleted")
        await loadRepairJobs()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to delete repair job")
      } finally {
        setDeletingJobId(null)
      }
    },
    [loadRepairJobs, selectedJob]
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
        if (selectedJob?.id === job.id) {
          const updatedJob = typeof json === "object" && json !== null && "job" in json ? ((json as any).job as RepairJobRow) : null
          if (updatedJob) setSelectedJob(updatedJob)
        }
        await loadRepairJobs()
        await loadAgents()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to abort repair job")
      } finally {
        setAbortingJobId(null)
      }
    },
    [loadAgents, loadRepairJobs, selectedJob]
  )

  const totalOnline = agents.filter((agent) => getEffectiveStatus(agent) === "online" || getEffectiveStatus(agent) === "busy").length
  const totalGithub = agents.filter((agent) => agent.provider === "github_actions").length
  const totalSelfHosted = agents.filter((agent) => agent.provider === "self_hosted" || agent.provider === "local").length
  const visibleRepairJobs = showAllJobs ? repairJobs : repairJobs.slice(0, 3)

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Workers
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure GitHub-triggered and self-hosted workers, then track their repair and verification jobs.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => void refreshAll()} disabled={loading}>
            <RefreshCw className="mr-1 h-4 w-4" />
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
              <Button>
                <Plus className="mr-1 h-4 w-4" />
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
                            <SelectItem value="local">Local</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endpoint-domain">Optional domain</Label>
                        <Input id="endpoint-domain" value={endpointDomain} onChange={(e) => setEndpointDomain(e.target.value)} placeholder="worker.example.com" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endpoint-ip">Optional IP</Label>
                        <Input id="endpoint-ip" value={endpointIp} onChange={(e) => setEndpointIp(e.target.value)} placeholder="203.0.113.10" />
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
                      onClick={() => {
                        window.location.href = "/api/github/connect"
                      }}
                    >
                      <Github className="mr-1 h-4 w-4" />
                      {githubConnected ? "Reconnect GitHub" : "Connect GitHub"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {githubConnected ? "Connected. Repository secrets will be provisioned automatically on save." : "Connect once, then select the repository and workflow."}
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
                    : "Self-hosted workers register with a token. IP/domain are optional metadata and not used as identity."}
                </div>
              )}

                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-2">
                    <Label htmlFor="notes">Notes</Label>
                    <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Region, routing rules, or operational notes." />
                  </div>

              {createdToken ? (
                <div className="rounded-md border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-100">
                  <div className="font-medium">Registration token</div>
                  <div className="mt-1 break-all font-mono text-xs">{createdToken}</div>
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
        open={jobDetailsOpen}
        onOpenChange={(next) => {
          setJobDetailsOpen(next)
          if (!next) setSelectedJob(null)
        }}
      >
        <DialogContent className="max-h-[88vh] max-w-3xl overflow-hidden p-0">
          <div className="flex min-h-0 flex-1 flex-col">
            <DialogHeader className="border-b px-6 py-5">
              <DialogTitle>Repair job details</DialogTitle>
              <DialogDescription>
                {selectedJob ? `Review worker execution state for repair job ${selectedJob.id}.` : "Review worker execution state."}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {selectedJob ? (
                <div className="space-y-5 text-sm">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Job id</div>
                      <div className="mt-1 break-all font-mono text-xs">{selectedJob.id}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Migration id</div>
                      <div className="mt-1 break-all font-mono text-xs">{selectedJob.migrationId}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Status</div>
                      <div className="mt-1">{selectedJob.status}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Mode</div>
                      <div className="mt-1">{selectedJob.mode}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Requested by worker</div>
                      <div className="mt-1 break-all font-mono text-xs">{selectedJob.requestedByAgentId || "-"}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Claimed by worker</div>
                      <div className="mt-1 break-all font-mono text-xs">{selectedJob.claimedByAgentId || "-"}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Created</div>
                      <div className="mt-1">{formatDate(selectedJob.createdAt)}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Updated</div>
                      <div className="mt-1">{formatDate(selectedJob.updatedAt)}</div>
                    </div>
                  </div>

                  <div className="rounded-md border p-3">
                    <div className="text-muted-foreground">Summary</div>
                    <div className="mt-1 whitespace-pre-wrap">{selectedJob.summary || "-"}</div>
                  </div>

                  <div className="rounded-md border p-3">
                    <div className="text-muted-foreground">Error</div>
                    <div className="mt-1 whitespace-pre-wrap">{selectedJob.error || "-"}</div>
                  </div>

                  <div className="grid gap-4 md:grid-cols-4">
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Claimed at</div>
                      <div className="mt-1">{formatDate(selectedJob.claimedAt)}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Started at</div>
                      <div className="mt-1">{formatDate(selectedJob.startedAt)}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Completed at</div>
                      <div className="mt-1">{formatDate(selectedJob.completedAt)}</div>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="text-muted-foreground">Heartbeat</div>
                      <div className="mt-1">{formatDate(selectedJob.lastHeartbeatAt)}</div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-muted-foreground">Payload</div>
                      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(selectedJob.payload ?? {}, null, 2)}</pre>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-muted-foreground">Progress</div>
                      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(selectedJob.progress ?? {}, null, 2)}</pre>
                    </div>
                    <div className="rounded-md border p-3">
                      <div className="mb-2 text-muted-foreground">Result</div>
                      <pre className="overflow-x-auto rounded bg-muted p-3 text-xs">{JSON.stringify(selectedJob.result ?? {}, null, 2)}</pre>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
            <DialogFooter className="border-t px-6 py-4">
              {selectedJob && !["completed", "failed", "canceled"].includes(selectedJob.status) ? (
                <Button
                  variant="outline"
                  disabled={abortingJobId === selectedJob.id}
                  onClick={() => void abortRepairJobRecord(selectedJob)}
                >
                  <Square className="mr-1 h-4 w-4" />
                  {abortingJobId === selectedJob.id ? "Aborting..." : "Abort"}
                </Button>
              ) : null}
              <Button variant="outline" onClick={() => setJobDetailsOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Connected now</CardDescription>
            <CardTitle className="text-2xl">{loading ? "-" : totalOnline}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>GitHub-backed</CardDescription>
            <CardTitle className="text-2xl">{loading ? "-" : totalGithub}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Token-based</CardDescription>
            <CardTitle className="text-2xl">{loading ? "-" : totalSelfHosted}</CardTitle>
          </CardHeader>
        </Card>
      </div>

          <Dialog open={dispatchOpen} onOpenChange={setDispatchOpen}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Dispatch GitHub worker</DialogTitle>
                <DialogDescription>
                  Create a repair job and trigger the configured workflow for {dispatchAgent?.name || "the selected worker"}.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="dispatch-migration-id">Migration id</Label>
                  <Input
                    id="dispatch-migration-id"
                    value={dispatchMigrationId}
                    onChange={(e) => setDispatchMigrationId(e.target.value)}
                    placeholder="9d8d6c1d-..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Mode</Label>
                  <Select value={dispatchMode} onValueChange={(value) => setDispatchMode(value as typeof dispatchMode)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="repair_and_verify">Repair and verify</SelectItem>
                      <SelectItem value="repair_only">Repair only</SelectItem>
                      <SelectItem value="verify_only">Verify only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter>
                <Button
                  disabled={!dispatchAgent || !dispatchMigrationId.trim() || dispatchingAgentId === dispatchAgent?.id}
                  onClick={async () => {
                    if (!dispatchAgent) return
                    setDispatchingAgentId(dispatchAgent.id)
                    try {
                      const res = await fetch(`/api/workers/${encodeURIComponent(dispatchAgent.id)}/dispatch`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          migrationId: dispatchMigrationId.trim(),
                          mode: dispatchMode,
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
                  }}
                >
                  {dispatchingAgentId === dispatchAgent?.id ? "Dispatching..." : "Dispatch"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

      <div className="grid gap-4">
        {agents.map((worker) => {
          const effectiveStatus = getEffectiveStatus(worker)
          return (
            <Card key={worker.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-lg flex items-center gap-2">
                                    <div className="md:col-span-2 xl:col-span-4 flex justify-end gap-2">
                  {worker.provider === "github_actions" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDispatchAgent(worker)
                        setDispatchMigrationId("")
                        setDispatchMode("repair_and_verify")
                        setDispatchOpen(true)
                      }}
                    >
                      <Play className="mr-1 h-4 w-4" />
                      Dispatch GitHub worker
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deletingWorkerId === worker.id}
                    onClick={() => void deleteWorker(worker)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {deletingWorkerId === worker.id ? "Deleting..." : "Delete"}
                  </Button>
                </div>
                    {worker.name}
                  </CardTitle>
                  <CardDescription>
                    {providerLabel(worker.provider)} - {worker.capabilities.join(", ") || "No capabilities"}
                  </CardDescription>
                </div>
                {statusBadge(effectiveStatus)}
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="space-y-1 text-sm">
                  <div className="text-muted-foreground">Connection</div>
                  <div>{worker.endpointDomain || worker.endpointIp || "-"}</div>
                  <div className="text-xs text-muted-foreground">Last heartbeat: {formatDate(worker.lastHeartbeatAt)}</div>
                  <div className="text-xs text-muted-foreground">Last seen host: {worker.lastSeenHost || "-"}</div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="text-muted-foreground">GitHub / repo</div>
                  <div>{worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner}/${worker.githubRepoName}` : "-"}</div>
                  <div className="text-xs text-muted-foreground">Workflow: {worker.githubWorkflowFile || "-"}</div>
                  <div className="text-xs text-muted-foreground">Ref: {worker.githubRef || "-"}</div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="text-muted-foreground">Runtime</div>
                  <div>Version: {worker.lastSeenVersion || "-"}</div>
                  <div className="text-xs text-muted-foreground">Last seen IP: {worker.lastSeenIp || worker.endpointIp || "-"}</div>
                  <div className="text-xs text-muted-foreground">Created: {formatDate(worker.createdAt)}</div>
                </div>
                <div className="space-y-1 text-sm">
                  <div className="text-muted-foreground">Latest run</div>
                  <div>{worker.latestRun ? `${worker.latestRun.runType} - ${worker.latestRun.status}` : "No runs yet"}</div>
                  <div className="text-xs text-muted-foreground">{worker.latestRun?.summary || worker.lastError || worker.notes || "-"}</div>
                </div>
                <div className="md:col-span-2 xl:col-span-4 flex justify-end gap-2">
                  {worker.provider === "github_actions" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setDispatchAgent(worker)
                        setDispatchMigrationId("")
                        setDispatchMode("repair_and_verify")
                        setDispatchOpen(true)
                      }}
                    >
                      <Play className="mr-1 h-4 w-4" />
                      Dispatch GitHub worker
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deletingWorkerId === worker.id}
                    onClick={() => void deleteWorker(worker)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {deletingWorkerId === worker.id ? "Deleting..." : "Delete"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}

        {!loading && agents.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-sm text-muted-foreground">
              No workers configured yet. Add one to register a self-hosted worker or connect a GitHub worker repository.
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Repair jobs</CardTitle>
              <CardDescription>Queue and runtime state for worker-based repair and verification jobs.</CardDescription>
            </div>
            {repairJobs.length > 3 ? (
              <Button variant="outline" size="sm" onClick={() => setShowAllJobs((current) => !current)}>
                {showAllJobs ? "Show last 3" : "View all"}
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {repairJobs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No repair jobs yet.</div>
          ) : (
            <div className="space-y-2">
              {visibleRepairJobs.map((job) => (
                <div key={job.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-mono text-xs">{job.id}</div>
                    <Badge variant={job.status === "completed" ? "default" : job.status === "failed" ? "destructive" : "outline"}>
                      {job.status}
                    </Badge>
                  </div>
                  <div className="mt-2 text-muted-foreground">
                    Migration: <span className="font-mono">{job.migrationId}</span> - Mode: {job.mode}
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    Claimed by: {job.claimedByAgentId || "-"} - Updated: {formatDate(job.updatedAt)}
                  </div>
                  <div className="mt-2">{job.summary || job.error || "-"}</div>
                  <div className="mt-3 flex justify-end gap-2">
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
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2 font-medium"><Shield className="h-4 w-4" /> Identity</div>
            <div className="mt-2 text-muted-foreground">Self-hosted and local workers use agent id + registration token. IP/domain are optional metadata only.</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2 font-medium"><Workflow className="h-4 w-4" /> GitHub</div>
            <div className="mt-2 text-muted-foreground">GitHub entries store repo, workflow, and ref so the website can dispatch jobs against the configured repository.</div>
          </div>
          <div className="rounded-md border p-3">
            <div className="flex items-center gap-2 font-medium"><CircleDot className="h-4 w-4" /> Live status</div>
            <div className="mt-2 text-muted-foreground">Heartbeat timestamps are polled every 10 seconds. Online status turns offline when heartbeats go stale.</div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}




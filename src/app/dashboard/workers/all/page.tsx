"use client"

import * as React from "react"
import { Bot, Copy, Eye, Github, HardDrive, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  notes?: string
  lastHeartbeatAt?: string
  lastSeenIp?: string
  lastSeenHost?: string
  lastSeenVersion?: string
}

function formatDate(value?: string) {
  if (!value) return "-"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function getEffectiveStatus(worker: AgentRow): AgentStatus {
  if (worker.provider === "github_actions") {
    return worker.status === "online" || worker.status === "busy" ? "online" : "offline"
  }
  if (worker.status === "error") return "offline"
  if ((worker.provider === "self_hosted" || worker.provider === "local") && worker.status === "online") {
    if (!worker.lastHeartbeatAt) return "offline"
    const last = new Date(worker.lastHeartbeatAt).getTime()
    if (!Number.isFinite(last) || Date.now() - last > 60_000) return "offline"
  }
  return worker.status
}

function providerLabel(provider: AgentProvider) {
  if (provider === "github_actions") return "GitHub Actions"
  if (provider === "local") return "Local"
  return "Self-hosted"
}

function getWorkerConnectionLabel(worker: AgentRow) {
  if (worker.provider === "github_actions") {
    return worker.githubRepoOwner && worker.githubRepoName ? `${worker.githubRepoOwner} / ${worker.githubRepoName}` : "-"
  }
  return worker.lastSeenHost || worker.endpointDomain || worker.lastSeenIp || worker.endpointIp || "-"
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

export default function AllWorkersPage() {
  const [workers, setWorkers] = React.useState<AgentRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [selectedWorker, setSelectedWorker] = React.useState<AgentRow | null>(null)
  const [token, setToken] = React.useState<string | null>(null)
  const [tokenLoading, setTokenLoading] = React.useState<string | null>(null)

  const loadWorkers = React.useCallback(async () => {
    try {
      setLoading(true)
      const res = await fetch("/api/workers", { cache: "no-store" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to load workers")
      setWorkers(Array.isArray(json.agents) ? json.agents : [])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load workers")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadWorkers()
  }, [loadWorkers])

  const copyText = React.useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`)
    } catch {
      toast.error(`Unable to copy ${label.toLowerCase()}`)
    }
  }, [])

  const openDetails = React.useCallback(async (worker: AgentRow) => {
    setSelectedWorker(worker)
    setToken(null)
    setTokenLoading(worker.id)
    try {
      const res = await fetch(`/api/workers/${encodeURIComponent(worker.id)}/token`, { cache: "no-store" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error || "Unable to load worker token")
      setToken(typeof json.token === "string" ? json.token : null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load worker token")
    } finally {
      setTokenLoading(null)
    }
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Bot className="h-4 w-4" />
            Full worker fleet
          </div>
          <h1 className="text-3xl font-bold tracking-tight">All Workers</h1>
          <p className="text-sm text-muted-foreground">Full list of workers with ids, connection details, and token access.</p>
        </div>
        <Button variant="outline" onClick={() => void loadWorkers()} disabled={loading}>
          <RefreshCw className={cn("mr-2 h-4 w-4", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid gap-4">
        {workers.map((worker) => (
          <Card key={worker.id}>
            <CardHeader className="flex flex-row items-start justify-between gap-3">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-lg">
                  {worker.provider === "github_actions" ? <Github className="h-4 w-4" /> : <HardDrive className="h-4 w-4" />}
                  {worker.name}
                </CardTitle>
                <CardDescription>{providerLabel(worker.provider)}</CardDescription>
              </div>
              {statusBadge(getEffectiveStatus(worker))}
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border p-3 text-sm">
                <div className="text-muted-foreground">Worker ID</div>
                <div className="mt-1 break-all font-mono text-xs">{worker.id}</div>
              </div>
              <div className="rounded-lg border p-3 text-sm">
                <div className="text-muted-foreground">Connection</div>
                <div className="mt-1">{getWorkerConnectionLabel(worker)}</div>
                <div className="mt-1 text-xs text-muted-foreground">{worker.provider === "github_actions" ? worker.githubWorkflowFile || "-" : `Heartbeat: ${formatDate(worker.lastHeartbeatAt)}`}</div>
              </div>
              <div className="rounded-lg border p-3 text-sm">
                <div className="text-muted-foreground">Capabilities</div>
                <div className="mt-1">{worker.capabilities.join(", ") || "-"}</div>
                <div className="mt-1 text-xs text-muted-foreground">Ref: {worker.githubRef || "-"}</div>
              </div>
              <div className="rounded-lg border p-3 text-sm">
                <div className="text-muted-foreground">Runtime</div>
                <div className="mt-1">Version: {worker.lastSeenVersion || "-"}</div>
                <div className="mt-1 text-xs text-muted-foreground">{worker.notes || "-"}</div>
              </div>
              <div className="md:col-span-2 xl:col-span-4 flex justify-end">
                <Button variant="outline" size="sm" onClick={() => void openDetails(worker)}>
                  <Eye className="mr-1 h-4 w-4" />
                  View details
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Dialog open={!!selectedWorker} onOpenChange={(open) => !open && setSelectedWorker(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{selectedWorker?.name || "Worker details"}</DialogTitle>
            <DialogDescription>Worker id and token access.</DialogDescription>
          </DialogHeader>
          {selectedWorker ? (
            <div className="space-y-4 text-sm">
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Worker ID</div>
                <div className="mt-1 break-all font-mono text-xs">{selectedWorker.id}</div>
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" size="sm" onClick={() => void copyText(selectedWorker.id, "Worker ID")}>
                    <Copy className="mr-1 h-4 w-4" />
                    Copy ID
                  </Button>
                </div>
              </div>
              <div className="rounded-xl border p-4">
                <div className="text-muted-foreground">Token</div>
                <div className="mt-1 break-all font-mono text-xs">{token || "No token loaded"}</div>
                <div className="mt-3 flex justify-end">
                  <Button variant="outline" size="sm" disabled={tokenLoading === selectedWorker.id || !token} onClick={() => token ? void copyText(token, "Worker token") : undefined}>
                    <Copy className="mr-1 h-4 w-4" />
                    {tokenLoading === selectedWorker.id ? "Loading..." : "Copy token"}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}

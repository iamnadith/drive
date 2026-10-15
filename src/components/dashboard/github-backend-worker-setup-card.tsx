"use client"

import * as React from "react"
import { toast } from "sonner"
import { GitHubWorkerSetup } from "@/components/dashboard/github-worker-setup"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkerRepository } from "@/lib/github-worker-setup"

export function GitHubBackendWorkerSetupCard({ connected, onCreated }: { connected: boolean; onCreated: () => void }) {
  const [repo, setRepo] = React.useState<WorkerRepository | null>(null)
  const [workflow, setWorkflow] = React.useState("")
  const [workerCount, setWorkerCount] = React.useState(1)
  const [busy, setBusy] = React.useState(false)
  const [setupBusy, setSetupBusy] = React.useState(false)
  const [name, setName] = React.useState("GitHub Backend Worker")

  async function register() {
    if (!repo || !workflow) return
    setBusy(true)
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "GitHub Backend Worker",
          category: "worker",
          provider: "github_actions",
          workerKind: "backend",
          capabilities: ["scan", "verify"],
          githubRepoOwner: repo.owner,
          githubRepoName: repo.name,
          githubRepositoryId: repo.id,
          githubWorkflowFile: workflow,
          githubRef: repo.defaultBranch,
          workerCount,
          notes: "GitHub hosted backend scan and verification worker",
        }),
      })
      const result = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(result.error || "Unable to register Backend Worker")
      toast.success("Backend Worker set up and ready for Orchestrator dispatch")
      setRepo(null)
      setWorkflow("")
      onCreated()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Backend Worker setup failed")
    } finally {
      setBusy(false)
    }
  }

  return <Card>
    <CardHeader>
      <CardTitle>GitHub Backend Worker</CardTitle>
      <CardDescription>GitHub hosted runners handle bucket scanning and verification when the Migration Orchestrator has work. The Orchestrator owns migration state and the Neon file queue; database credentials are not placed in GitHub.</CardDescription>
    </CardHeader>
    <CardContent className="grid gap-4 md:grid-cols-2">
      <div className="space-y-2 md:col-span-2">
        <Label htmlFor="backend-worker-name">Worker pool name</Label>
        <Input id="backend-worker-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} />
      </div>
      <GitHubWorkerSetup
        connected={connected}
        workerKind="backend"
        onBusy={setSetupBusy}
        onSelect={(selectedRepo, selectedWorkflow) => { setRepo(selectedRepo); setWorkflow(selectedWorkflow) }}
      />
      {repo && workflow ? <>
        <div className="space-y-2">
          <Label>Repository and workflow</Label>
          <p className="rounded-md border px-3 py-2 text-sm">{repo.fullName} · {workflow}</p>
        </div>
        <div className="space-y-2">
          <Label>Workers per active migration</Label>
          <Select value={String(workerCount)} onValueChange={(value) => setWorkerCount(Number(value))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5].map((count) => <SelectItem key={count} value={String(count)}>{count} worker{count === 1 ? "" : "s"}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <Button type="button" disabled={busy || setupBusy} onClick={() => void register()}>{busy ? "Registering…" : "Register Backend Worker"}</Button>
        </div>
      </> : null}
    </CardContent>
  </Card>
}

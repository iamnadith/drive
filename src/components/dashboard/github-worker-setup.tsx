"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { WorkerRepository } from "@/lib/github-worker-setup"

const STORAGE_KEY = "drive.github-worker-setup"

export function GitHubWorkerSetup({ connected, onSelect, onBusy }: {
  connected: boolean
  onSelect: (repo: WorkerRepository, workflow: string) => void
  onBusy: (busy: boolean) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState("")
  const [candidates, setCandidates] = React.useState<WorkerRepository[]>([])
  const controller = React.useRef<AbortController | null>(null)
  const cursor = React.useRef<string | undefined>(undefined)
  React.useEffect(() => {
    try { cursor.current = sessionStorage.getItem(STORAGE_KEY) || undefined } catch {}
    return () => { controller.current?.abort(); onBusy(false) }
  }, [onBusy])

  async function run(selectedId?: string, restart = false) {
    if (controller.current) return
    if (restart) {
      cursor.current = undefined
      try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
    }
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    onBusy(true)
    setCandidates([])
    setMessage("Looking for the worker repository...")
    try {
      const deadline = Date.now() + 5 * 60 * 1000
      while (Date.now() < deadline) {
        const response = await fetch("/api/github/worker-setup", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cursor: cursor.current, selectedId }), signal: abort.signal,
        })
        const result = await response.json().catch(() => null) as {
          status?: string
          cursor?: unknown
          message?: unknown
          error?: unknown
          repo?: WorkerRepository
          workflow?: unknown
          candidates?: WorkerRepository[]
        } | null
        if (!result || typeof result !== "object") throw new Error("GitHub setup returned an invalid response. Retry to continue.")
        if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "GitHub setup failed. Retry to continue.")
        if (abort.signal.aborted) return
        setMessage(typeof result.message === "string" ? result.message : "Continuing GitHub setup...")
        if (typeof result.cursor === "string" && result.cursor) {
          cursor.current = result.cursor
          try { sessionStorage.setItem(STORAGE_KEY, result.cursor) } catch {}
        }
        if (result.status === "ready" && result.repo && typeof result.workflow === "string" && result.workflow) {
          cursor.current = undefined
          try { sessionStorage.removeItem(STORAGE_KEY) } catch {}
          onSelect(result.repo, result.workflow)
          return
        }
        if (result.status === "ready") throw new Error("GitHub setup did not return a repository workflow. Start fresh and retry.")
        if (result.status === "choose") {
          const nextCandidates = Array.isArray(result.candidates) ? result.candidates : []
          if (nextCandidates.length === 0) throw new Error("GitHub setup returned no repository choices. Start fresh and retry.")
          setCandidates(nextCandidates)
          return
        }
        selectedId = undefined
        await new Promise<void>((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")) }
          const timer = setTimeout(() => { abort.signal.removeEventListener("abort", cancel); resolve() }, 1500)
          abort.signal.addEventListener("abort", cancel, { once: true })
        })
      }
      setMessage("Setup is taking longer than expected. Continue to resume, or update an older fork if its worker files are missing.")
    } catch (error) {
      if (!abort.signal.aborted) setMessage(error instanceof Error ? error.message : "Setup failed. Continue to retry.")
    } finally {
      if (!abort.signal.aborted) { setBusy(false); onBusy(false) }
      controller.current = null
    }
  }

  return <div className="md:col-span-2 flex flex-col gap-3">
    <p className="text-sm text-muted-foreground">Find an existing fork even if it was renamed. If none is found, create a fork in your connected GitHub account and enable its worker workflow.</p>
    <div className="flex gap-2">
      <Button type="button" disabled={!connected || busy} onClick={() => void run()}>{busy ? "Detecting..." : "Detect or continue setup"}</Button>
      <Button type="button" variant="outline" disabled={!connected || busy} onClick={() => void run(undefined, true)}>Start fresh</Button>
    </div>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    {candidates.length > 0 && <Select disabled={busy} onValueChange={(id) => void run(id)}>
      <SelectTrigger aria-label="Detected worker repositories"><SelectValue placeholder="Choose a matching repository" /></SelectTrigger>
      <SelectContent><SelectGroup>{candidates.map((repo) => <SelectItem key={repo.id} value={repo.id}>{repo.fullName}</SelectItem>)}</SelectGroup></SelectContent>
    </Select>}
  </div>
}

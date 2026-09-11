"use client"

import * as React from "react"
import { Cloud, Eye, EyeOff, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

type Mode = "single" | "separate"
type SetupMode = "automatic" | "manual"
type WorkerKey = "backend" | "scanner" | "migration"
type Installation = {
  mode: Mode
  status: "pending" | "running" | "ready" | "failed"
  step: string
  releaseVersion?: string
  error?: string
  tokensSaved?: boolean
  workers: Record<WorkerKey, { accountName?: string; scriptName: string; url?: string; deployed?: boolean; verified?: boolean; phase?: string; deployedAt?: string; verifiedAt?: string; lastCheckedAt?: string; latencyMs?: number; build?: string | number; error?: string }>
}
type Connection = { url: string; secret: string; enabled: boolean; secretConfigured: boolean }

const labels: Record<WorkerKey, string> = { backend: "Backend Orchestrator", scanner: "File Scanner", migration: "Migration Orchestrator" }

export function CloudflareWorkerHosting({ onboarding = false, onReady }: { onboarding?: boolean; onReady?: () => void } = {}) {
  const [setupMode, setSetupMode] = React.useState<SetupMode>("automatic")
  const [mode, setMode] = React.useState<Mode>("single")
  const [token, setToken] = React.useState("")
  const [scannerToken, setScannerToken] = React.useState("")
  const [migrationToken, setMigrationToken] = React.useState("")
  const [tokensVisible, setTokensVisible] = React.useState(false)
  const [installation, setInstallation] = React.useState<Installation | null>(null)
  const [busy, setBusy] = React.useState(false)
  const repairAttempted = React.useRef(false)
  const [connections, setConnections] = React.useState<Record<WorkerKey, Connection>>({
    backend: { url: "", secret: "", enabled: false, secretConfigured: false },
    scanner: { url: "", secret: "", enabled: false, secretConfigured: false },
    migration: { url: "", secret: "", enabled: false, secretConfigured: false },
  })

  const loadConnections = React.useCallback(async () => {
    const [backendResponse, migrationResponse] = await Promise.all([
      fetch("/api/settings/backend-orchestrator", { cache: "no-store" }),
      fetch("/api/settings/migration-orchestrator", { cache: "no-store" }),
    ])
    const backend = await backendResponse.json().catch(() => ({})) as { settings?: Record<string, unknown>; error?: string }
    const migration = await migrationResponse.json().catch(() => ({})) as { settings?: Record<string, unknown>; error?: string }
    if (!backendResponse.ok || !migrationResponse.ok) throw new Error(backend.error || migration.error || "Unable to load Worker connections")
    setConnections({
      backend: { url: String(backend.settings?.orchestratorUrl || ""), secret: String(backend.settings?.sharedSecret || ""), enabled: backend.settings?.enabled === true, secretConfigured: backend.settings?.secretConfigured === true },
      scanner: { url: String(migration.settings?.fileScannerUrl || ""), secret: String(migration.settings?.fileScannerSecret || ""), enabled: migration.settings?.fileScannerEnabled === true, secretConfigured: migration.settings?.fileScannerSecretConfigured === true },
      migration: { url: String(migration.settings?.orchestratorUrl || ""), secret: String(migration.settings?.sharedSecret || ""), enabled: migration.settings?.migrationEnabled === true, secretConfigured: migration.settings?.secretConfigured === true },
    })
  }, [])

  const refresh = React.useCallback(async () => {
    const response = await fetch("/api/workers/cloudflare-install?reconcile=1", { cache: "no-store" })
    const payload = await response.json().catch(() => ({})) as { installation?: Installation; hosting?: { mode?: SetupMode }; error?: string }
    if (!response.ok) throw new Error(payload.error || "Unable to load Cloudflare hosting status")
    setInstallation(payload.installation || null)
    if (payload.installation?.mode) setMode(payload.installation.mode)
    if (onboarding) setSetupMode("automatic")
    else if (payload.hosting?.mode) setSetupMode(payload.hosting.mode)
  }, [onboarding])
  React.useEffect(() => { void (onboarding ? refresh() : Promise.all([refresh(), loadConnections()])).catch(() => undefined) }, [refresh, loadConnections, onboarding])
  React.useEffect(() => {
    if (!busy && installation?.status !== "running") return
    const timer = window.setInterval(() => { void refresh().catch(() => undefined) }, 1500)
    return () => window.clearInterval(timer)
  }, [busy, installation?.status, refresh])
  React.useEffect(() => {
    if (installation?.status === "ready") { repairAttempted.current = false; onReady?.(); return }
    if (installation?.status !== "failed" || !installation.tokensSaved || repairAttempted.current || busy) return
    repairAttempted.current = true
    void deploy(false)
  // deploy is intentionally event-like; installation transitions prevent repeats.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installation?.status, installation?.tokensSaved, busy, onReady])

  const revealTokens = async () => {
    if (tokensVisible) { setToken(""); setScannerToken(""); setMigrationToken(""); setTokensVisible(false); return }
    setBusy(true)
    try {
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reveal_tokens" }) })
      const payload = await response.json().catch(() => ({})) as { tokens?: { mode: Mode; token?: string; backendToken?: string; scannerToken?: string; migrationToken?: string }; error?: string }
      if (!response.ok || !payload.tokens) throw new Error(payload.error || "Unable to reveal saved tokens")
      setMode(payload.tokens.mode); setToken(payload.tokens.token || payload.tokens.backendToken || ""); setScannerToken(payload.tokens.scannerToken || ""); setMigrationToken(payload.tokens.migrationToken || ""); setTokensVisible(true)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to reveal saved tokens") }
    finally { setBusy(false) }
  }

  const saveReplacementTokens = async () => {
    setBusy(true)
    try {
      const body = mode === "single" ? { action: "replace_tokens", mode, token } : { action: "replace_tokens", mode, backendToken: token, scannerToken, migrationToken }
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({})) as { installation?: Installation; error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to replace saved tokens")
      setInstallation(payload.installation || installation); setToken(""); setScannerToken(""); setMigrationToken(""); setTokensVisible(false)
      toast.success("Cloudflare token replaced without redeploying healthy Workers")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to replace saved tokens") }
    finally { setBusy(false) }
  }

  const deploy = async (restart = false) => {
    setBusy(true)
    try {
      const body = mode === "single"
        ? { mode, token, restart }
        : { mode, backendToken: token, scannerToken, migrationToken, restart }
      const response = await fetch("/api/workers/cloudflare-install", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({})) as { installation?: Installation; error?: string }
      if (payload.installation) setInstallation(payload.installation)
      if (!response.ok) throw new Error(payload.error || "Cloudflare Worker installation failed")
      setToken(""); setScannerToken(""); setMigrationToken("")
      if (!onboarding) await loadConnections()
      toast.success("All Cloudflare Workers were deployed, verified and enabled")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Cloudflare Worker installation failed")
      await refresh().catch(() => undefined)
    } finally { setBusy(false) }
  }

  const updateConnection = (worker: WorkerKey, patch: Partial<Connection>) => setConnections((current) => ({ ...current, [worker]: { ...current[worker], ...patch } }))

  const changeSetupMode = async (next: SetupMode) => {
    if (next === setupMode) return
    setBusy(true)
    try {
      const response = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to change hosting mode")
      setSetupMode(next)
      await loadConnections()
      toast.success(next === "automatic" ? "Automatic hosting selected; manual Workers are no longer active" : "Saved manual Worker configuration restored")
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to change hosting mode") }
    finally { setBusy(false) }
  }

  const saveConnection = async (worker: WorkerKey) => {
    setBusy(true)
    try {
      const connection = connections[worker]
      const url = worker === "backend" ? "/api/settings/backend-orchestrator" : "/api/settings/migration-orchestrator"
      const body = worker === "backend"
        ? { orchestratorUrl: connection.url, sharedSecret: connection.secret }
        : worker === "scanner"
          ? { worker: "file", fileScannerUrl: connection.url, fileScannerSecret: connection.secret }
          : { worker: "migration", orchestratorUrl: connection.url, sharedSecret: connection.secret }
      const response = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to save Worker connection")
      const snapshotResponse = await fetch("/api/workers/cloudflare-install", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "manual", refreshManual: true }) })
      if (!snapshotResponse.ok) {
        const snapshotPayload = await snapshotResponse.json().catch(() => ({})) as { error?: string }
        throw new Error(snapshotPayload.error || "Worker was saved but its manual-mode snapshot could not be synchronized")
      }
      await loadConnections(); toast.success(`${labels[worker]} connection saved`)
    } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save Worker connection") }
    finally { setBusy(false) }
  }

  const workerAction = async (worker: WorkerKey, action: "test" | "run" | "toggle") => {
    setBusy(true)
    try {
      const connection = connections[worker]
      const url = worker === "backend" ? "/api/settings/backend-orchestrator" : "/api/settings/migration-orchestrator"
      const options = action === "toggle"
        ? { method: "PATCH", body: JSON.stringify(worker === "backend" ? { enabled: !connection.enabled } : { worker: worker === "scanner" ? "file" : "migration", enabled: !connection.enabled }) }
        : { method: "POST", body: JSON.stringify({ action: worker === "backend" ? action : action === "test" ? `test_${worker === "scanner" ? "file" : "migration"}` : worker === "scanner" ? "run_file" : "run" }) }
      const response = await fetch(url, { ...options, headers: { "Content-Type": "application/json" } })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `${labels[worker]} action failed`)
      await loadConnections(); toast.success(`${labels[worker]} ${action === "toggle" ? connection.enabled ? "disabled" : "enabled" : action === "test" ? "verified" : "cycle completed"}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : `${labels[worker]} action failed`) }
    finally { setBusy(false) }
  }

  return (
    <section className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Cloud className="size-5" />Cloudflare Worker hosting</CardTitle>
          <CardDescription>Choose automatic token deployment or manually connect Workers that are already deployed.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!onboarding ? <ToggleGroup type="single" value={setupMode} onValueChange={(value) => { if (value) void changeSetupMode(value as SetupMode) }} disabled={busy}>
            <ToggleGroupItem value="automatic">Automatic</ToggleGroupItem>
            <ToggleGroupItem value="manual">Manual</ToggleGroupItem>
          </ToggleGroup> : null}
          {setupMode === "automatic" ? <>
          <p className="text-sm text-muted-foreground">Deploy all three Workers automatically. Choose whether they share one Cloudflare account or use separate accounts.</p>
          <ToggleGroup type="single" value={mode} onValueChange={(value) => { if (value) setMode(value as Mode) }} disabled={busy}>
            <ToggleGroupItem value="single">One Cloudflare account</ToggleGroupItem>
            <ToggleGroupItem value="separate">Separate accounts</ToggleGroupItem>
          </ToggleGroup>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="flex flex-col gap-2 lg:col-span-3">
              <Label htmlFor="cf-backend-token">{mode === "single" ? "Cloudflare API token" : "Backend Orchestrator token"}</Label>
              <Input id="cf-backend-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={token} placeholder={installation?.tokensSaved ? "Saved securely - leave blank to reuse" : "Enter token"} onChange={(event) => setToken(event.target.value)} disabled={busy} />
            </div>
            {mode === "separate" ? <>
              <div className="flex flex-col gap-2"><Label htmlFor="cf-scanner-token">File Scanner token</Label><Input id="cf-scanner-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={scannerToken} placeholder={installation?.tokensSaved ? "Saved securely - leave blank to reuse" : "Enter token"} onChange={(event) => setScannerToken(event.target.value)} disabled={busy} /></div>
              <div className="flex flex-col gap-2"><Label htmlFor="cf-migration-token">Migration Orchestrator token</Label><Input id="cf-migration-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={migrationToken} placeholder={installation?.tokensSaved ? "Saved securely - leave blank to reuse" : "Enter token"} onChange={(event) => setMigrationToken(event.target.value)} disabled={busy} /></div>
            </> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {installation?.status !== "ready" ? <Button onClick={() => void deploy(false)} disabled={busy || (!installation?.tokensSaved && (!token || (mode === "separate" && (!scannerToken || !migrationToken))))}>{busy ? "Deploying…" : installation?.status === "failed" || installation?.status === "running" ? "Continue deployment" : "Deploy all Workers"}</Button> : null}
            {installation?.status === "failed" ? <Button variant="outline" onClick={() => void deploy(true)} disabled={busy || (!installation.tokensSaved && (!token || (mode === "separate" && (!scannerToken || !migrationToken))))}>Start fresh</Button> : null}
            <Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw data-icon="inline-start" />Refresh status</Button>
            {installation?.tokensSaved && !onboarding ? <Button variant="outline" onClick={() => void revealTokens()} disabled={busy}>{tokensVisible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}{tokensVisible ? "Hide saved token" : "View saved token"}</Button> : null}
            {installation?.status === "ready" && !onboarding && token && (mode === "single" || (scannerToken && migrationToken)) ? <Button onClick={() => void saveReplacementTokens()} disabled={busy}>Save replacement token</Button> : null}
          </div>
          {installation ? <p className="text-sm">Status: <Badge variant={installation.status === "ready" ? "default" : installation.status === "failed" ? "destructive" : "secondary"}>{installation.status}</Badge> · Step: {installation.step}{installation.releaseVersion ? ` · Release: ${installation.releaseVersion}` : ""}{installation.tokensSaved ? " · Token saved encrypted" : ""}</p> : <p className="text-sm text-muted-foreground">Ready to deploy. No deployment has been recorded yet.</p>}
          {installation?.error ? <p className="text-sm text-destructive">{installation.error}</p> : null}
          <div className="grid gap-4 xl:grid-cols-3">
            {(["backend", "scanner", "migration"] as WorkerKey[]).map((worker) => {
              const current = installation?.workers[worker]
              const phase = current?.phase || (current?.verified ? "verified" : current?.deployed ? "deployed" : "queued")
              return <Card key={worker}><CardHeader className="pb-3"><CardTitle className="text-base">{labels[worker]}</CardTitle><CardDescription>{current?.scriptName || "Waiting for deployment"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-2 text-sm">
                <p className="flex items-center justify-between"><span>Phase</span><Badge variant={phase === "verified" ? "default" : phase === "failed" ? "destructive" : "secondary"}>{phase}</Badge></p>
                <p>Account: {current?.accountName || "—"}</p><p className="truncate" title={current?.url}>URL: {current?.url || "—"}</p>
                <p>Build: {current?.build ?? "—"} · Response: {current?.latencyMs != null ? `${current.latencyMs} ms` : "—"}</p>
                <p>Deployed: {current?.deployedAt ? new Date(current.deployedAt).toLocaleString() : "—"}</p><p>Verified: {current?.verifiedAt ? new Date(current.verifiedAt).toLocaleString() : "—"}</p>
                <p>Checked: {current?.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString() : "—"}</p>
                {current?.error ? <p className="text-destructive">{current.error}</p> : null}
              </CardContent></Card>
            })}
          </div>
          </> : <p className="text-sm text-muted-foreground">Enter the URL and secret for each existing Worker below.</p>}
        </CardContent>
      </Card>
      {setupMode === "manual" ? <div className="grid gap-4 xl:grid-cols-3">
        {(["backend", "scanner", "migration"] as WorkerKey[]).map((worker) => {
          const current = installation?.workers[worker]
          const connection = connections[worker]
          return <Card key={worker}><CardHeader><CardTitle className="text-base">{labels[worker]}</CardTitle><CardDescription>{current?.scriptName || "Manual or not installed"}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3 text-sm">
            <p>Account: {current?.accountName || "—"} · <Badge variant={connection.enabled ? "default" : "secondary"}>{connection.enabled ? "Enabled" : "Disabled"}</Badge></p>
            <div className="flex flex-col gap-1"><Label htmlFor={`${worker}-url`}>Worker URL</Label><Input id={`${worker}-url`} value={connection.url} onChange={(event) => updateConnection(worker, { url: event.target.value })} disabled={busy} /></div>
            <div className="flex flex-col gap-1"><Label htmlFor={`${worker}-secret`}>Worker secret</Label><Input id={`${worker}-secret`} type="password" autoComplete="off" value={connection.secret} onChange={(event) => updateConnection(worker, { secret: event.target.value })} disabled={busy} /></div>
            <p>Deployment: {current?.verified ? "Verified" : current?.deployed ? "Awaiting verification" : connection.url ? "Configured manually" : "Not deployed"}</p>
            <div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => void saveConnection(worker)} disabled={busy || !connection.url || (!connection.secret && !connection.secretConfigured)}>Save</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "test")} disabled={busy || !connection.url || !connection.secretConfigured}>Test</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "toggle")} disabled={busy || !connection.url || !connection.secretConfigured}>{connection.enabled ? "Disable" : "Enable"}</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "run")} disabled={busy || !connection.enabled}>Run now</Button></div>
          </CardContent></Card>
        })}
      </div> : null}
    </section>
  )
}

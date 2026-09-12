"use client"

import * as React from "react"
import { Activity, CheckCircle2, CircleDashed, Cloud, Eye, EyeOff, KeyRound, RefreshCw, ServerCog, TriangleAlert } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Item, ItemActions, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
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
  const [canRevealTokens, setCanRevealTokens] = React.useState(false)
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
    const payload = await response.json().catch(() => ({})) as { installation?: Installation; hosting?: { mode?: SetupMode }; canRevealTokens?: boolean; error?: string }
    if (!response.ok) throw new Error(payload.error || "Unable to load Cloudflare hosting status")
    setInstallation(payload.installation || null)
    setCanRevealTokens(payload.canRevealTokens === true)
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
    const ready = installation?.status === "ready" && installation.tokensSaved === true && (Object.values(installation.workers) as Installation["workers"][WorkerKey][]).every((worker) => worker.deployed && worker.verified && worker.url && worker.deployedAt && worker.verifiedAt && worker.lastCheckedAt)
    if (ready) { repairAttempted.current = false; onReady?.(); return }
    if (installation?.status !== "failed" || !installation.tokensSaved || repairAttempted.current || busy) return
    repairAttempted.current = true
    void deploy(false)
  // deploy is intentionally event-like; installation transitions prevent repeats.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installation, busy, onReady])

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

  const workers = (["backend", "scanner", "migration"] as WorkerKey[])
  const installationReady = installation?.status === "ready" && installation.tokensSaved === true && workers.every((worker) => {
    const current = installation.workers[worker]
    return Boolean(current.deployed && current.verified && current.url && current.deployedAt && current.verifiedAt && current.lastCheckedAt)
  })
  const tokenInputReady = Boolean(token && (mode === "single" || (scannerToken && migrationToken)))

  return (
    <section>
      <Card className="overflow-hidden py-0">
        <CardHeader className="border-b px-5 py-5 sm:px-7 sm:py-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-secondary"><Cloud /></div>
              <div><CardTitle>Cloudflare Worker hosting</CardTitle><CardDescription className="mt-1">Deploy and verify Drive&apos;s three service Workers from one place.</CardDescription></div>
            </div>
            {!onboarding ? <ToggleGroup type="single" variant="outline" value={setupMode} onValueChange={(value) => { if (value) void changeSetupMode(value as SetupMode) }} disabled={busy} aria-label="Worker hosting mode"><ToggleGroupItem value="automatic">Automatic</ToggleGroupItem><ToggleGroupItem value="manual">Manual</ToggleGroupItem></ToggleGroup> : <Badge variant="secondary">Automatic setup</Badge>}
          </div>
        </CardHeader>

        {setupMode === "automatic" ? <>
          <CardContent className="flex flex-col gap-6 px-5 py-5 sm:px-7 sm:py-6">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="flex flex-col gap-4">
                <div><p className="text-sm font-medium">Cloudflare accounts</p><p className="mt-1 text-sm text-muted-foreground">Use one token for every Worker, or isolate each Worker in a separate account.</p></div>
                <ToggleGroup type="single" variant="outline" value={mode} onValueChange={(value) => { if (value) { setMode(value as Mode); setTokensVisible(false); setToken(""); setScannerToken(""); setMigrationToken("") } }} disabled={busy || tokensVisible} aria-label="Cloudflare account layout"><ToggleGroupItem value="single">One account</ToggleGroupItem><ToggleGroupItem value="separate">Separate accounts</ToggleGroupItem></ToggleGroup>
              </div>
              <Item variant="outline"><ItemMedia variant="icon"><KeyRound /></ItemMedia><ItemContent><ItemTitle>API credentials</ItemTitle><p className="text-xs text-muted-foreground">{installation?.tokensSaved ? "Encrypted and saved" : "No token saved"}</p></ItemContent><ItemActions><Badge variant={installation?.tokensSaved ? "default" : "destructive"}>{installation?.tokensSaved ? "Saved" : "Required"}</Badge></ItemActions></Item>
            </div>

            <FieldGroup className={mode === "separate" ? "grid gap-4 lg:grid-cols-3" : undefined}>
              <Field className={mode === "single" ? "max-w-2xl" : undefined}><FieldLabel htmlFor="cf-backend-token">{mode === "single" ? "Cloudflare API token" : "Backend Orchestrator token"}</FieldLabel><Input id="cf-backend-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={token} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setToken(event.target.value)} disabled={busy || tokensVisible} /><FieldDescription>{installation?.tokensSaved ? "A saved token is available for future repairs." : "The token is encrypted before it is stored."}</FieldDescription></Field>
              {mode === "separate" ? <><Field><FieldLabel htmlFor="cf-scanner-token">File Scanner token</FieldLabel><Input id="cf-scanner-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={scannerToken} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setScannerToken(event.target.value)} disabled={busy || tokensVisible} /></Field><Field><FieldLabel htmlFor="cf-migration-token">Migration Orchestrator token</FieldLabel><Input id="cf-migration-token" type={tokensVisible ? "text" : "password"} autoComplete="off" value={migrationToken} placeholder={installation?.tokensSaved ? "Saved securely — leave blank to reuse" : "Paste API token"} onChange={(event) => setMigrationToken(event.target.value)} disabled={busy || tokensVisible} /></Field></> : null}
            </FieldGroup>

            <div className="flex flex-wrap gap-2">
              {!installationReady ? <Button onClick={() => void deploy(false)} disabled={busy || (!installation?.tokensSaved && !tokenInputReady)}>{busy ? "Working…" : installation?.status === "failed" || installation?.status === "running" ? "Repair and continue" : "Deploy Workers"}</Button> : null}
              {installation?.status === "failed" ? <Button variant="outline" onClick={() => void deploy(true)} disabled={busy || (!installation.tokensSaved && !tokenInputReady)}>Start fresh</Button> : null}
              <Button variant="outline" onClick={() => void refresh()} disabled={busy}><RefreshCw data-icon="inline-start" />Check now</Button>
              {installation?.tokensSaved && canRevealTokens ? <Button variant="outline" onClick={() => void revealTokens()} disabled={busy}>{tokensVisible ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}{tokensVisible ? "Hide token" : "View saved token"}</Button> : null}
              {installation?.tokensSaved && !canRevealTokens ? <Badge variant="outline">Create the administrator before revealing saved tokens</Badge> : null}
              {installation?.tokensSaved && canRevealTokens && tokensVisible && tokenInputReady ? <Button onClick={() => void saveReplacementTokens()} disabled={busy}>Save replacement token</Button> : null}
            </div>

            {installation?.error ? <Alert variant="destructive"><TriangleAlert /><AlertTitle>Worker verification failed</AlertTitle><AlertDescription>{installation.error}</AlertDescription></Alert> : installationReady ? <Alert><CheckCircle2 /><AlertTitle>All Workers are live</AlertTitle><AlertDescription>Each script exists in Cloudflare and passed a current authenticated health check.</AlertDescription></Alert> : <Alert><CircleDashed /><AlertTitle>{installation ? "Deployment is not verified" : "Ready for first deployment"}</AlertTitle><AlertDescription>{installation ? `Current step: ${installation.step}${installation.releaseVersion ? ` · Release ${installation.releaseVersion}` : ""}.` : "Enter the required token, then Drive will deploy Workers in dependency order."}</AlertDescription></Alert>}
          </CardContent>

          <Separator />
          <CardContent className="p-0">
            <ItemGroup>{workers.map((worker, index) => {
              const current = installation?.tokensSaved ? installation.workers[worker] : undefined
              const live = Boolean(current?.deployed && current.verified && current.url && current.deployedAt && current.verifiedAt && current.lastCheckedAt)
              const phase = live ? "verified" : current?.phase === "failed" ? "failed" : current?.phase || "not deployed"
              return <React.Fragment key={worker}>{index > 0 ? <Separator /> : null}<Item className="rounded-none border-0 px-5 py-5 sm:px-7"><ItemMedia variant="icon">{live ? <CheckCircle2 /> : phase === "failed" ? <TriangleAlert /> : <ServerCog />}</ItemMedia><ItemContent><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><ItemTitle>{labels[worker]}</ItemTitle><p className="mt-1 text-xs text-muted-foreground">{current?.scriptName || "Waiting for a verified deployment"}</p></div><Badge variant={live ? "default" : phase === "failed" ? "destructive" : "secondary"}>{live ? "Live" : phase}</Badge></div>{current?.url ? <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4"><p className="truncate" title={current.url}>URL <span className="block text-foreground">{current.url}</span></p><p>Cloudflare account <span className="block text-foreground">{current.accountName || "Validated account"}</span></p><p>Last response <span className="block text-foreground">{current.latencyMs != null ? `${current.latencyMs} ms` : "No response recorded"}</span></p><p>Live check <span className="block text-foreground">{current.lastCheckedAt ? new Date(current.lastCheckedAt).toLocaleString() : "Never checked"}</span></p></div> : <p className="mt-2 text-sm text-muted-foreground">No deployed Worker URL exists yet. Account details will appear only after deployment.</p>}{current?.error && current.url ? <p className="mt-2 text-sm text-destructive">{current.error}</p> : null}</ItemContent></Item></React.Fragment>
            })}</ItemGroup>
          </CardContent>
        </> : <CardContent className="flex flex-col gap-6 px-5 py-5 sm:px-7 sm:py-6">
          <Alert><Activity /><AlertTitle>Manual connections</AlertTitle><AlertDescription>Manual mode uses only the URL and shared secret you provide. Cloudflare account names and automatic deployment records do not apply here.</AlertDescription></Alert>
          <div className="grid gap-5 xl:grid-cols-3">{workers.map((worker) => {
            const connection = connections[worker]
            return <Card key={worker} className="shadow-none"><CardHeader><div className="flex items-start justify-between gap-3"><div><CardTitle className="text-base">{labels[worker]}</CardTitle><CardDescription>{connection.url ? "Manual endpoint configured" : "No manual endpoint"}</CardDescription></div><Badge variant={connection.enabled ? "default" : "secondary"}>{connection.enabled ? "Enabled" : "Disabled"}</Badge></div></CardHeader><CardContent><FieldGroup><Field><FieldLabel htmlFor={`${worker}-url`}>Worker URL</FieldLabel><Input id={`${worker}-url`} value={connection.url} placeholder="https://your-worker.workers.dev" onChange={(event) => updateConnection(worker, { url: event.target.value })} disabled={busy} /></Field><Field><FieldLabel htmlFor={`${worker}-secret`}>Shared secret</FieldLabel><Input id={`${worker}-secret`} type="password" autoComplete="off" value={connection.secret} placeholder={connection.secretConfigured ? "Saved securely — leave blank to keep" : "Enter Worker secret"} onChange={(event) => updateConnection(worker, { secret: event.target.value })} disabled={busy} /></Field><Field className="flex-row flex-wrap"><Button size="sm" onClick={() => void saveConnection(worker)} disabled={busy || !connection.url || (!connection.secret && !connection.secretConfigured)}>Save</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "test")} disabled={busy || !connection.url || !connection.secretConfigured}>Test</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "toggle")} disabled={busy || !connection.url || !connection.secretConfigured}>{connection.enabled ? "Disable" : "Enable"}</Button><Button size="sm" variant="outline" onClick={() => void workerAction(worker, "run")} disabled={busy || !connection.enabled}>Run now</Button></Field></FieldGroup></CardContent></Card>
          })}</div>
        </CardContent>}
      </Card>
    </section>
  )
}

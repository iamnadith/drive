"use client"

import * as React from "react"

import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell"
import {
  type AmbientPaletteMode,
  useAmbientTheme,
} from "@/components/ambient-theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export default function DashboardSettingsPage() {
  const {
    activeThemeId,
    themes,
    setActiveThemeId,
    addTheme,
    updateThemeColor,
    updateThemeOrbitCount,
    resetThemes,
  } = useAmbientTheme()
  const [selectedThemeId, setSelectedThemeId] = React.useState(activeThemeId)
  const [paletteMode, setPaletteMode] = React.useState<AmbientPaletteMode>("light")
  const [newThemeName, setNewThemeName] = React.useState("")
  const [orchestratorUrl, setOrchestratorUrl] = React.useState("")
  const [savedOrchestratorUrl, setSavedOrchestratorUrl] = React.useState("")
  const [orchestratorSecret, setOrchestratorSecret] = React.useState("")
  const [savedOrchestratorSecret, setSavedOrchestratorSecret] = React.useState("")
  const [orchestratorEnabled, setOrchestratorEnabled] = React.useState(false)
  const [orchestratorSecretConfigured, setOrchestratorSecretConfigured] = React.useState(false)
  const [orchestratorUpdatedAt, setOrchestratorUpdatedAt] = React.useState("")
  const [orchestratorLoaded, setOrchestratorLoaded] = React.useState(false)
  const [orchestratorState, setOrchestratorState] = React.useState<Record<string, unknown> | null>(null)
  const [orchestratorWorker, setOrchestratorWorker] = React.useState<Record<string, unknown> | null>(null)
  const [orchestratorConnection, setOrchestratorConnection] = React.useState<"unknown" | "connected" | "failed">("unknown")
  const [orchestratorBusy, setOrchestratorBusy] = React.useState(false)
  const [orchestratorMessage, setOrchestratorMessage] = React.useState("")
  const [workerSecret, setWorkerSecret] = React.useState("")
  const [workerSecretConfigured, setWorkerSecretConfigured] = React.useState(false)
  const [workerSecretUpdatedAt, setWorkerSecretUpdatedAt] = React.useState("")
  const [workerSecretLoaded, setWorkerSecretLoaded] = React.useState(false)
  const [workerSecretBusy, setWorkerSecretBusy] = React.useState(false)
  const [workerSecretMessage, setWorkerSecretMessage] = React.useState("")
  const [migrationOrchestratorUrl, setMigrationOrchestratorUrl] = React.useState("")
  const [migrationOrchestratorSavedUrl, setMigrationOrchestratorSavedUrl] = React.useState("")
  const [fileScannerUrl, setFileScannerUrl] = React.useState("")
  const [fileScannerSavedUrl, setFileScannerSavedUrl] = React.useState("")
  const [migrationOrchestratorSecret, setMigrationOrchestratorSecret] = React.useState("")
  const [migrationOrchestratorSavedSecret, setMigrationOrchestratorSavedSecret] = React.useState("")
  const [fileScannerSecret, setFileScannerSecret] = React.useState("")
  const [fileScannerSavedSecret, setFileScannerSavedSecret] = React.useState("")
  const [migrationOrchestratorEnabled, setMigrationOrchestratorEnabled] = React.useState(false)
  const [migrationOrchestratorSecretConfigured, setMigrationOrchestratorSecretConfigured] = React.useState(false)
  const [fileScannerSecretConfigured, setFileScannerSecretConfigured] = React.useState(false)
  const [migrationOrchestratorLoaded, setMigrationOrchestratorLoaded] = React.useState(false)
  const [migrationOrchestratorBusy, setMigrationOrchestratorBusy] = React.useState(false)
  const [migrationOrchestratorMessage, setMigrationOrchestratorMessage] = React.useState("")

  const loadOrchestratorSettings = React.useCallback(async () => {
    const response = await fetch("/api/settings/backend-orchestrator", { cache: "no-store" })
    const payload = await response.json().catch(() => ({})) as {
      settings?: { enabled?: boolean; orchestratorUrl?: string; sharedSecret?: string; secretConfigured?: boolean; updatedAt?: string }
      state?: Record<string, unknown> | null
      worker?: Record<string, unknown> | null
      error?: string
    }
    if (!response.ok) throw new Error(payload.error || "Unable to load Backend Orchestrator settings")
    setOrchestratorEnabled(payload.settings?.enabled === true)
    const savedUrl = payload.settings?.orchestratorUrl ?? ""
    setOrchestratorUrl(savedUrl)
    setSavedOrchestratorUrl(savedUrl)
    setOrchestratorSecretConfigured(payload.settings?.secretConfigured === true)
    setOrchestratorSecret(payload.settings?.sharedSecret ?? "")
    setSavedOrchestratorSecret(payload.settings?.sharedSecret ?? "")
    setOrchestratorUpdatedAt(payload.settings?.updatedAt ?? "")
    const persistedState = payload.state ?? null
    setOrchestratorState(persistedState)
    setOrchestratorWorker(payload.worker ?? null)
    if (persistedState?.last_error) setOrchestratorConnection("failed")
    else if (["idle", "running"].includes(String(persistedState?.status ?? ""))) setOrchestratorConnection("connected")
    else setOrchestratorConnection("unknown")
    setOrchestratorLoaded(true)
  }, [])

  React.useEffect(() => {
    void loadOrchestratorSettings().catch((error) => {
      setOrchestratorLoaded(true)
      setOrchestratorMessage(error instanceof Error ? error.message : String(error))
    })
  }, [loadOrchestratorSettings])

  const loadMigrationWorkerSettings = React.useCallback(async () => {
    const response = await fetch("/api/settings/migration-workers", { cache: "no-store" })
    const payload = await response.json().catch(() => ({})) as { settings?: { sharedSecret?: string; secretConfigured?: boolean; updatedAt?: string }; error?: string }
    if (!response.ok) throw new Error(payload.error || "Unable to load Migration Worker settings")
    setWorkerSecretConfigured(payload.settings?.secretConfigured === true)
    setWorkerSecret(payload.settings?.sharedSecret ?? "")
    setWorkerSecretUpdatedAt(payload.settings?.updatedAt ?? "")
    setWorkerSecretLoaded(true)
  }, [])

  const loadMigrationOrchestratorSettings = React.useCallback(async () => {
    const response = await fetch("/api/settings/migration-orchestrator", { cache: "no-store" })
    const payload = await response.json().catch(() => ({})) as {
      settings?: { enabled?: boolean; orchestratorUrl?: string; fileScannerUrl?: string; sharedSecret?: string; fileScannerSecret?: string; secretConfigured?: boolean; fileScannerSecretConfigured?: boolean }
      error?: string
    }
    if (!response.ok) throw new Error(payload.error || "Unable to load Migration Orchestrator settings")
    const savedUrl = payload.settings?.orchestratorUrl ?? ""
    setMigrationOrchestratorUrl(savedUrl)
    setMigrationOrchestratorSavedUrl(savedUrl)
    const savedFileUrl = payload.settings?.fileScannerUrl ?? ""
    setFileScannerUrl(savedFileUrl)
    setFileScannerSavedUrl(savedFileUrl)
    setMigrationOrchestratorEnabled(payload.settings?.enabled === true)
    setMigrationOrchestratorSecretConfigured(payload.settings?.secretConfigured === true)
    setFileScannerSecretConfigured(payload.settings?.fileScannerSecretConfigured === true)
    setMigrationOrchestratorSecret(payload.settings?.sharedSecret ?? "")
    setMigrationOrchestratorSavedSecret(payload.settings?.sharedSecret ?? "")
    setFileScannerSecret(payload.settings?.fileScannerSecret ?? "")
    setFileScannerSavedSecret(payload.settings?.fileScannerSecret ?? "")
    setMigrationOrchestratorLoaded(true)
  }, [])

  React.useEffect(() => {
    void loadMigrationWorkerSettings().catch((error) => {
      setWorkerSecretLoaded(true)
      setWorkerSecretMessage(error instanceof Error ? error.message : String(error))
    })
    void loadMigrationOrchestratorSettings().catch((error) => {
      setMigrationOrchestratorLoaded(true)
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    })
  }, [loadMigrationOrchestratorSettings, loadMigrationWorkerSettings])

  const saveMigrationWorkerSettings = async () => {
    setWorkerSecretBusy(true)
    setWorkerSecretMessage("")
    try {
      const response = await fetch("/api/settings/migration-workers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sharedSecret: workerSecret }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to save Migration Worker secret")
      setWorkerSecret("")
      await loadMigrationWorkerSettings()
      setWorkerSecretMessage("Shared worker secret saved. Use the same secret for every worker.")
    } catch (error) {
      setWorkerSecretMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setWorkerSecretBusy(false)
    }
  }

  const saveMigrationOrchestratorSettings = async () => {
    setMigrationOrchestratorBusy(true)
    setMigrationOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/migration-orchestrator", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orchestratorUrl: migrationOrchestratorUrl, fileScannerUrl, sharedSecret: migrationOrchestratorSecret, fileScannerSecret }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to save Migration Orchestrator settings")
      setMigrationOrchestratorSecret("")
      await loadMigrationOrchestratorSettings()
      setMigrationOrchestratorMessage("Migration Orchestrator connection settings saved.")
    } catch (error) {
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationOrchestratorBusy(false)
    }
  }

  const testMigrationOrchestrator = async () => {
    setMigrationOrchestratorBusy(true)
    setMigrationOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/migration-orchestrator", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "test" }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Migration Orchestrator connection test failed")
      setMigrationOrchestratorMessage("Migration Orchestrator is reachable and authenticated.")
    } catch (error) {
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationOrchestratorBusy(false)
    }
  }

  const runMigrationOrchestratorNow = async () => {
    setMigrationOrchestratorBusy(true)
    setMigrationOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/migration-orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Migration Orchestrator run failed")
      await loadMigrationOrchestratorSettings()
      setMigrationOrchestratorMessage("Migration Orchestrator cycle completed successfully.")
    } catch (error) {
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationOrchestratorBusy(false)
    }
  }

  const runFileScannerNow = async () => {
    setMigrationOrchestratorBusy(true)
    setMigrationOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/migration-orchestrator", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run_file" }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "File Scanner run failed")
      await loadMigrationOrchestratorSettings()
      setMigrationOrchestratorMessage("File Scanner cycle completed successfully.")
    } catch (error) {
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally { setMigrationOrchestratorBusy(false) }
  }

  const setMigrationOrchestratorActive = async (enabled: boolean) => {
    setMigrationOrchestratorBusy(true)
    setMigrationOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/migration-orchestrator", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `Unable to ${enabled ? "enable" : "disable"} Migration Orchestrator`)
      await loadMigrationOrchestratorSettings()
      setMigrationOrchestratorMessage(`Migration Orchestrator ${enabled ? "enabled" : "disabled"}.`)
    } catch (error) {
      setMigrationOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setMigrationOrchestratorBusy(false)
    }
  }

  const migrationOrchestratorDirty = migrationOrchestratorUrl.trim().replace(/\/$/, "") !== migrationOrchestratorSavedUrl || fileScannerUrl.trim().replace(/\/$/, "") !== fileScannerSavedUrl || migrationOrchestratorSecret !== migrationOrchestratorSavedSecret || fileScannerSecret !== fileScannerSavedSecret

  const saveOrchestratorSettings = async () => {
    setOrchestratorBusy(true)
    setOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/backend-orchestrator", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestratorUrl,
          sharedSecret: orchestratorSecret,
        }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Unable to save Backend Orchestrator settings")
      setOrchestratorSecret("")
      await loadOrchestratorSettings()
      setOrchestratorConnection("unknown")
      setOrchestratorMessage("Connection settings saved. Test the connection before enabling.")
    } catch (error) {
      setOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOrchestratorBusy(false)
    }
  }

  const testOrchestratorConnection = async () => {
    setOrchestratorBusy(true)
    setOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/backend-orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test" }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || "Connection test failed")
      setOrchestratorConnection("connected")
      await loadOrchestratorSettings()
      setOrchestratorMessage("Authenticated connection succeeded. The Backend Orchestrator can reach PostgreSQL.")
    } catch (error) {
      setOrchestratorConnection("failed")
      setOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOrchestratorBusy(false)
    }
  }

  const setOrchestratorActive = async (enabled: boolean) => {
    setOrchestratorBusy(true)
    setOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/backend-orchestrator", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error || `Unable to ${enabled ? "enable" : "disable"} Backend Orchestrator`)
      await loadOrchestratorSettings()
      if (enabled) setOrchestratorConnection("connected")
      setOrchestratorMessage(`Backend Orchestrator ${enabled ? "enabled" : "disabled"}.`)
    } catch (error) {
      setOrchestratorConnection("failed")
      setOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOrchestratorBusy(false)
    }
  }

  const runOrchestratorNow = async () => {
    setOrchestratorBusy(true)
    setOrchestratorMessage("")
    try {
      const response = await fetch("/api/settings/backend-orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string; result?: unknown }
      if (!response.ok) throw new Error(payload.error || "Backend Orchestrator run failed")
      await loadOrchestratorSettings()
      setOrchestratorMessage("Backend Orchestrator cycle completed successfully.")
    } catch (error) {
      setOrchestratorMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setOrchestratorBusy(false)
    }
  }

  React.useEffect(() => {
    if (!themes.some((theme) => theme.id === selectedThemeId)) {
      setSelectedThemeId(activeThemeId)
    }
  }, [activeThemeId, selectedThemeId, themes])

  const selectedTheme =
    themes.find((theme) => theme.id === selectedThemeId) ??
    themes.find((theme) => theme.id === activeThemeId) ??
    themes[0]

  const orchestratorConnectionDirty =
    orchestratorUrl.trim().replace(/\/$/, "") !== savedOrchestratorUrl || orchestratorSecret !== savedOrchestratorSecret

  if (!selectedTheme) {
    return null
  }

  const handleAddPreset = () => {
    const nextId = addTheme(newThemeName)
    setSelectedThemeId(nextId)
    setNewThemeName("")
  }

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Settings"
        description="Customize the ambient theme presets, control orbit count per theme, and set each orbit color independently for light and dark mode."
        actions={
          <Button variant="outline" onClick={resetThemes}>
            Reset presets
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Backend Orchestrator</CardTitle>
          <CardDescription>
            Save the deployed URL and shared secret, verify the authenticated database connection, then enable metrics processing. Account API tokens need Account Analytics read access.
          </CardDescription>
          <CardAction>
            <Badge variant={orchestratorEnabled ? "default" : "secondary"}>
              {!orchestratorLoaded ? "Loading..." : orchestratorEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="orchestrator-url">Backend Orchestrator URL</Label>
            <Input id="orchestrator-url" value={orchestratorUrl} disabled={!orchestratorLoaded} onChange={(event) => setOrchestratorUrl(event.target.value)} placeholder="https://backend-orchestrator.example.workers.dev" />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="orchestrator-secret">Shared secret</Label>
              <Badge variant={orchestratorSecretConfigured ? "outline" : "destructive"}>
                {!orchestratorLoaded ? "Loading..." : orchestratorSecretConfigured ? "Secret saved" : "Secret required"}
              </Badge>
            </div>
            <Input id="orchestrator-secret" type="text" value={orchestratorSecret} disabled={!orchestratorLoaded} onChange={(event) => setOrchestratorSecret(event.target.value)} placeholder="At least 24 characters" />
            <p className="text-xs text-muted-foreground">
              This admin-only page displays the saved secret so it can be copied into the Worker deployment.
            </p>
          </div>
          <div className="rounded-2xl border p-4 text-sm lg:col-span-2">
            <p>Connection: {!orchestratorLoaded ? "Loading saved settings..." : orchestratorConnection === "connected" ? "Connected" : orchestratorConnection === "failed" ? "Failed" : "Not tested"}</p>
            <p className="text-muted-foreground">Last saved: {orchestratorUpdatedAt ? new Date(orchestratorUpdatedAt).toLocaleString() : "Never"}</p>
            <p className="text-muted-foreground">Runtime: {String(orchestratorState?.status ?? "No runtime state")}</p>
            <p className="text-muted-foreground">Worker build: {String(orchestratorWorker?.build ?? "Unknown")}</p>
            <p className="text-muted-foreground">Last completed: {String(orchestratorState?.last_completed_at ?? "Never")}</p>
            <p className="text-muted-foreground">Last error: {String(orchestratorState?.last_error ?? "None")}</p>
          </div>
          {orchestratorMessage ? <p className="text-sm lg:col-span-2">{orchestratorMessage}</p> : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button onClick={saveOrchestratorSettings} disabled={orchestratorBusy || !orchestratorLoaded}>Save connection</Button>
          <Button variant="outline" onClick={testOrchestratorConnection} disabled={orchestratorBusy || !orchestratorLoaded || orchestratorConnectionDirty || !orchestratorUrl || !orchestratorSecretConfigured}>Test connection</Button>
          <Button
            variant={orchestratorEnabled ? "destructive" : "secondary"}
            onClick={() => void setOrchestratorActive(!orchestratorEnabled)}
            disabled={orchestratorBusy || !orchestratorLoaded || (!orchestratorEnabled && orchestratorConnection !== "connected")}
          >
            {orchestratorEnabled ? "Disable" : "Enable"}
          </Button>
          <Button variant="outline" onClick={runOrchestratorNow} disabled={orchestratorBusy || !orchestratorLoaded || !orchestratorEnabled}>Run now</Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Migration workers</CardTitle>
          <CardDescription>
            One shared secret authenticates every migration worker. Each worker still has its own generated id, so concurrent workers can claim and report separate object-shard jobs safely.
          </CardDescription>
          <CardAction>
            <Badge variant={workerSecretConfigured ? "outline" : "destructive"}>
              {!workerSecretLoaded ? "Loading..." : workerSecretConfigured ? "Secret saved" : "Secret required"}
            </Badge>
          </CardAction>
        </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
          <Label htmlFor="migration-worker-secret">Shared worker secret</Label>
          <Input
            id="migration-worker-secret"
            type="text"
            value={workerSecret}
            disabled={!workerSecretLoaded}
            onChange={(event) => setWorkerSecret(event.target.value)}
            placeholder="At least 24 characters"
          />
            </div>
          <p className="text-xs text-muted-foreground">
            This admin-only page displays the common secret. GitHub dispatch synchronizes the URL and secret, then passes each worker&apos;s unique id as a workflow input.
          </p>
          <p className="text-xs text-muted-foreground">Last saved: {workerSecretUpdatedAt ? new Date(workerSecretUpdatedAt).toLocaleString() : "Never"}</p>
          {workerSecretMessage ? <p className="text-sm">{workerSecretMessage}</p> : null}
        </CardContent>
        <CardFooter>
          <Button onClick={saveMigrationWorkerSettings} disabled={workerSecretBusy || !workerSecretLoaded || !workerSecret.trim()}>
            Save worker connection
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Migration Orchestrator</CardTitle>
          <CardDescription>
            The Cloudflare scheduler materializes shared object-shard jobs, requeues stale workers, and reconciles the worker pool. It only processes migrations explicitly created with the migration worker engine.
          </CardDescription>
          <CardAction>
            <Badge variant={migrationOrchestratorEnabled ? "default" : "secondary"}>
              {!migrationOrchestratorLoaded ? "Loading..." : migrationOrchestratorEnabled ? "Enabled" : "Disabled"}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="migration-orchestrator-url">Orchestrator URL</Label>
            <Input id="migration-orchestrator-url" value={migrationOrchestratorUrl} disabled={!migrationOrchestratorLoaded} onChange={(event) => setMigrationOrchestratorUrl(event.target.value)} placeholder="https://migration-orchestrator.example.workers.dev" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="file-scanner-url">File Scanner URL</Label>
            <Input id="file-scanner-url" value={fileScannerUrl} disabled={!migrationOrchestratorLoaded} onChange={(event) => setFileScannerUrl(event.target.value)} placeholder="https://file-scanner.example.workers.dev" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="migration-orchestrator-secret">Migration Orchestrator secret</Label>
            <Input id="migration-orchestrator-secret" type="text" value={migrationOrchestratorSecret} disabled={!migrationOrchestratorLoaded} onChange={(event) => setMigrationOrchestratorSecret(event.target.value)} placeholder="At least 24 characters" />
            <p className="text-xs text-muted-foreground">
              This admin-only page displays the saved secret. Both Workers receive their database configuration at deploy time and operate independently from the panel.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="file-scanner-secret">File Scanner secret</Label>
            <Input id="file-scanner-secret" type="text" value={fileScannerSecret} disabled={!migrationOrchestratorLoaded} onChange={(event) => setFileScannerSecret(event.target.value)} placeholder="At least 24 characters" />
            <p className="text-xs text-muted-foreground">Used to authenticate the File Scanner endpoint and loaded from PostgreSQL.</p>
          </div>
          {migrationOrchestratorMessage ? <p className="text-sm lg:col-span-2">{migrationOrchestratorMessage}</p> : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button onClick={saveMigrationOrchestratorSettings} disabled={migrationOrchestratorBusy || !migrationOrchestratorLoaded}>Save connection</Button>
          <Button variant="outline" onClick={testMigrationOrchestrator} disabled={migrationOrchestratorBusy || !migrationOrchestratorLoaded || migrationOrchestratorDirty || !migrationOrchestratorSecretConfigured}>Test connection</Button>
          <Button variant={migrationOrchestratorEnabled ? "destructive" : "secondary"} onClick={() => void setMigrationOrchestratorActive(!migrationOrchestratorEnabled)} disabled={migrationOrchestratorBusy || !migrationOrchestratorLoaded || (!migrationOrchestratorEnabled && (!migrationOrchestratorUrl || !fileScannerUrl || !migrationOrchestratorSecretConfigured || !fileScannerSecretConfigured))}>
            {migrationOrchestratorEnabled ? "Disable" : "Enable"}
          </Button>
          <Button variant="outline" onClick={runMigrationOrchestratorNow} disabled={migrationOrchestratorBusy || !migrationOrchestratorLoaded || !migrationOrchestratorEnabled}>Run now</Button>
          <Button variant="outline" onClick={runFileScannerNow} disabled={migrationOrchestratorBusy || !migrationOrchestratorLoaded || !migrationOrchestratorEnabled}>Run File Scanner</Button>
        </CardFooter>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Ambient Themes</CardTitle>
            <CardDescription>
              Pick the active preset, or add a new one before editing orbit colors.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
              <div className="space-y-2">
                <Label htmlFor="new-theme-name">New preset</Label>
                <Input
                  id="new-theme-name"
                  value={newThemeName}
                  placeholder="Moonrise"
                  onChange={(event) => setNewThemeName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      handleAddPreset()
                    }
                  }}
                />
              </div>
              <Button className="mt-3 w-full" onClick={handleAddPreset}>
                Add preset
              </Button>
            </div>
            {themes.map((theme) => {
              const isActive = theme.id === activeThemeId
              const isSelected = theme.id === selectedThemeId

              return (
                <div
                  key={theme.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedThemeId(theme.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setSelectedThemeId(theme.id)
                    }
                  }}
                  className={cn(
                    "w-full rounded-3xl border p-4 text-left backdrop-blur-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    isSelected
                      ? "border-foreground/20 bg-foreground/[0.05]"
                      : "border-border/70 bg-background/8 hover:bg-foreground/[0.03]"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{theme.label}</p>
                        {isActive ? <Badge variant="secondary">Live</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {theme.orbitCount} orbit{theme.orbitCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    {!isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveThemeId(theme.id)
                        }}
                      >
                        Apply
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {theme.colors.light.slice(0, theme.orbitCount).map((color, index) => (
                      <span
                        key={`${theme.id}-light-${index}`}
                        className="h-6 w-6 rounded-full border border-black/10"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>{selectedTheme.label} Customizer</CardTitle>
            <CardDescription>
              Adjust the orbit count for this preset and assign a separate color to every orbit in both light and dark mode.
            </CardDescription>
            <CardAction>
              {selectedTheme.id !== activeThemeId ? (
                <Button onClick={() => setActiveThemeId(selectedTheme.id)}>Make active</Button>
              ) : (
                <Badge variant="secondary">Currently active</Badge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
              <div className="space-y-2 rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
                <Label htmlFor="orbit-count">Orbit count</Label>
                <Input
                  id="orbit-count"
                  type="number"
                  min={1}
                  max={8}
                  value={selectedTheme.orbitCount}
                  onChange={(event) => {
                    const nextCount = Number(event.target.value)
                    if (!Number.isFinite(nextCount)) {
                      return
                    }
                    updateThemeOrbitCount(selectedTheme.id, nextCount)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Supports 1 to 8 orbits per preset.
                </p>
              </div>
              <div className="space-y-3 rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
                <p className="text-sm font-medium">Quick preview</p>
                <div className="rounded-3xl border border-border/60 bg-background/10 p-4">
                  <div className="flex flex-wrap gap-3">
                    {selectedTheme.colors[paletteMode]
                      .slice(0, selectedTheme.orbitCount)
                      .map((color, index) => (
                        <div key={`${paletteMode}-${index}`} className="flex items-center gap-2">
                          <span
                            className="h-8 w-8 rounded-full border border-black/10"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-sm text-muted-foreground">Orbit {index + 1}</span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </div>

            <Tabs
              value={paletteMode}
              onValueChange={(value) => setPaletteMode(value as AmbientPaletteMode)}
            >
              <TabsList>
                <TabsTrigger value="light">Light mode</TabsTrigger>
                <TabsTrigger value="dark">Dark mode</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {selectedTheme.colors[paletteMode]
                .slice(0, selectedTheme.orbitCount)
                .map((color, index) => (
                  <div
                    key={`${selectedTheme.id}-${paletteMode}-${index}`}
                    className="rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl"
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">Orbit {index + 1}</p>
                        <p className="text-xs text-muted-foreground">
                          {paletteMode === "light" ? "Light" : "Dark"} palette color
                        </p>
                      </div>
                      <span
                        className="h-8 w-8 rounded-full border border-black/10"
                        style={{ backgroundColor: color }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${paletteMode}-orbit-${index}`}>Hex color</Label>
                      <div className="flex items-center gap-3">
                        <Input
                          id={`${paletteMode}-orbit-${index}`}
                          type="color"
                          value={color}
                          className="h-11 w-16 cursor-pointer p-1"
                          onChange={(event) =>
                            updateThemeColor(
                              selectedTheme.id,
                              paletteMode,
                              index,
                              event.target.value
                            )
                          }
                        />
                        <Input
                          value={color}
                          onChange={(event) =>
                            updateThemeColor(
                              selectedTheme.id,
                              paletteMode,
                              index,
                              event.target.value
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
          <CardFooter>
            <p className="text-sm text-muted-foreground">
              Changes sync to the shared database and the applied preset becomes visible to every user.
            </p>
          </CardFooter>
        </Card>
      </div>
    </DashboardPage>
  )
}

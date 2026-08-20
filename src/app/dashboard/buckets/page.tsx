"use client"

import * as React from "react"
import {
  Braces,
  Check,
  Copy,
  Database,
  Globe2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  TriangleAlert,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/page-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

type CorsRule = {
  id?: string
  allowedOrigins: string[]
  allowedMethods: string[]
  allowedHeaders: string[]
  exposeHeaders: string[]
  maxAgeSeconds?: number
}

type BucketSettings = {
  publicAccess: { enabled: boolean; domain: string | null; bucketId: string | null }
  corsRules: CorsRule[]
}

type BucketDeliverySettings = {
  // Drive delivery authorization; intentionally separate from publicAccess.
  deliveryPublicAccessEnabled: boolean
  mediaAllowedOrigins: string[] | null
}

type BucketRecord = {
  id: string
  accountId: string
  accountLabel: string
  accountStatus: "active" | "available" | "disabled"
  name: string
  createdAt: string | null
  jurisdiction: string
  storageClass: string
  objects: number
  bytes: number
  statsStatus: string
  settings: BucketSettings | null
  deliverySettings: BucketDeliverySettings | null
  settingsError: string | null
}

type ApiResponse = {
  buckets: BucketRecord[]
  activeAccount: { id: string; label: string; status: string }
  summary: { totalBuckets: number; totalObjects: number; totalBytes: number; publicBuckets: number; corsPolicies: number }
  error?: string
}

const HTTP_METHODS = ["GET", "HEAD", "PUT", "POST", "DELETE"]
const WILDCARD_RULE: CorsRule = {
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "HEAD", "PUT", "POST"],
  allowedHeaders: ["*"],
  exposeHeaders: ["ETag"],
}

function formatBytes(value: number) {
  if (!value) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value)
}

function splitList(value: string) {
  return Array.from(new Set(value.split(",").map((item) => item.trim()).filter(Boolean)))
}

function normalizeMediaOrigin(value: string) {
  const input = value.trim()
  if (!input) return { error: "Enter an origin such as https://media.example.com" }
  if (input === "*") return { origin: "*" }
  try {
    const url = new URL(input)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { error: "Only http:// and https:// origins are supported" }
    }
    const isLocalHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    if (url.protocol === "http:" && !isLocalHost) {
      return { error: "Use HTTPS for non-local origins; HTTP is limited to localhost development" }
    }
    if (url.origin === "null" || !url.hostname || url.username || url.password) {
      return { error: "Enter a complete origin without credentials" }
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      return { error: "Use the origin only; remove any path, query, or hash" }
    }
    return { origin: url.origin }
  } catch {
    return { error: "Enter a valid URL origin, including http:// or https://" }
  }
}

function settingsUrl(bucket: BucketRecord) {
  return `/api/buckets/${encodeURIComponent(bucket.accountId)}/${encodeURIComponent(bucket.name)}/settings`
}

function dangerUrl(bucket: BucketRecord) {
  return `/api/buckets/${encodeURIComponent(bucket.accountId)}/${encodeURIComponent(bucket.name)}/danger`
}

export default function BucketsPage() {
  const [data, setData] = React.useState<ApiResponse | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [selected, setSelected] = React.useState<BucketRecord | null>(null)

  const load = React.useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      const response = await fetch("/api/buckets", { cache: "no-store" })
      const payload = (await response.json()) as ApiResponse
      if (!response.ok) throw new Error(payload.error || "Unable to load buckets")
      setData(payload)
      setSelected((current) => current
        ? payload.buckets.find((bucket) => bucket.id === current.id) ?? null
        : null)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load buckets")
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => { void load() }, [load])

  const buckets = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    return (data?.buckets ?? []).filter((bucket) => {
      return !query || bucket.name.toLowerCase().includes(query) || bucket.accountLabel.toLowerCase().includes(query)
    })
  }, [data?.buckets, search])

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-muted-foreground">Loading buckets...</div>
  }

  const summary = data?.summary ?? { totalBuckets: 0, totalObjects: 0, totalBytes: 0, publicBuckets: 0, corsPolicies: 0 }
  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Buckets"
        description={`Review bucket usage and settings for the active account${data?.activeAccount?.label ? `, ${data.activeAccount.label}` : ""}.`}
        actions={
          <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric title="Buckets" value={formatNumber(summary.totalBuckets)} icon={Database} />
        <Metric title="Stored objects" value={formatNumber(summary.totalObjects)} icon={Braces} />
        <Metric title="Storage used" value={formatBytes(summary.totalBytes)} icon={Database} />
        <Metric title="Public URLs" value={`${formatNumber(summary.publicBuckets)} enabled`} icon={Globe2} detail={`${summary.corsPolicies} CORS policies`} />
      </div>

      <Card>
        <CardHeader className="gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base">All buckets</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{buckets.length} of {summary.totalBuckets} buckets</p>
          </div>
          <div className="w-full sm:w-64">
            <div className="relative min-w-0 sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search buckets" className="pl-9" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bucket</TableHead><TableHead>Account</TableHead><TableHead>Usage</TableHead>
                  <TableHead>Public URL</TableHead><TableHead>Drive delivery</TableHead><TableHead>CORS</TableHead><TableHead className="w-16"><span className="sr-only">Manage</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buckets.map((bucket) => (
                  <TableRow key={bucket.id}>
                    <TableCell>
                      <div className="font-medium">{bucket.name}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{bucket.jurisdiction} · {bucket.storageClass}</div>
                    </TableCell>
                    <TableCell><div>{bucket.accountLabel}</div><Badge variant="outline" className="mt-1 capitalize">{bucket.accountStatus}</Badge></TableCell>
                    <TableCell><div>{formatBytes(bucket.bytes)}</div><div className="text-xs text-muted-foreground">{formatNumber(bucket.objects)} objects</div></TableCell>
                    <TableCell>{bucket.settings ? <Badge variant={bucket.settings.publicAccess.enabled ? "default" : "secondary"}>{bucket.settings.publicAccess.enabled ? "Enabled" : "Disabled"}</Badge> : <Badge variant="destructive">Unavailable</Badge>}</TableCell>
                    <TableCell>{bucket.deliverySettings ? <Badge variant={bucket.deliverySettings.deliveryPublicAccessEnabled ? "default" : "secondary"}>{bucket.deliverySettings.deliveryPublicAccessEnabled ? "Enabled" : "API required"}</Badge> : <Badge variant="outline">Unavailable</Badge>}</TableCell>
                    <TableCell>{bucket.settings ? (bucket.settings.corsRules.length > 0 ? "Configured" : "Not set") : "-"}</TableCell>
                    <TableCell>
                      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => setSelected(bucket)}><Settings2 /><span className="sr-only">Manage {bucket.name}</span></Button></TooltipTrigger><TooltipContent>Manage settings</TooltipContent></Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
                {buckets.length === 0 ? <TableRow><TableCell colSpan={7} className="h-28 text-center text-muted-foreground">No buckets match these filters.</TableCell></TableRow> : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <BucketSettingsDialog bucket={selected} onOpenChange={(open) => !open && setSelected(null)} onUpdated={(bucket) => {
        setData((current) => current ? { ...current, buckets: current.buckets.map((item) => item.id === bucket.id ? bucket : item), summary: {
          ...current.summary,
          publicBuckets: current.buckets.reduce((sum, item) => sum + ((item.id === bucket.id ? bucket : item).settings?.publicAccess.enabled ? 1 : 0), 0),
          corsPolicies: current.buckets.reduce((sum, item) => sum + (((item.id === bucket.id ? bucket : item).settings?.corsRules.length ?? 0) > 0 ? 1 : 0), 0),
        } } : current)
        setSelected(bucket)
      }} onDeleted={(bucket) => {
        setData((current) => current ? {
          ...current,
          buckets: current.buckets.filter((item) => item.id !== bucket.id),
          summary: {
            ...current.summary,
            totalBuckets: Math.max(0, current.summary.totalBuckets - 1),
            totalObjects: Math.max(0, current.summary.totalObjects - bucket.objects),
            totalBytes: Math.max(0, current.summary.totalBytes - bucket.bytes),
            publicBuckets: Math.max(0, current.summary.publicBuckets - (bucket.settings?.publicAccess.enabled ? 1 : 0)),
          },
        } : current)
        setSelected(null)
      }} />
    </DashboardPage>
  )
}

function Metric({ title, value, detail, icon: Icon }: { title: string; value: string; detail?: string; icon: React.ComponentType<{ className?: string }> }) {
  return <Card><CardHeader className="flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle><Icon className="size-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-semibold">{value}</div>{detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}</CardContent></Card>
}

function BucketSettingsDialog({ bucket, onOpenChange, onUpdated, onDeleted }: { bucket: BucketRecord | null; onOpenChange: (open: boolean) => void; onUpdated: (bucket: BucketRecord) => void; onDeleted: (bucket: BucketRecord) => void }) {
  const [policy, setPolicy] = React.useState<CorsRule | null>(null)
  const [savingCors, setSavingCors] = React.useState(false)
  const [savingPublic, setSavingPublic] = React.useState(false)
  const [savingDelivery, setSavingDelivery] = React.useState(false)
  const [deliveryOrigins, setDeliveryOrigins] = React.useState<string[]>([])
  const [deliveryOriginInput, setDeliveryOriginInput] = React.useState("")
  const [deliveryOriginError, setDeliveryOriginError] = React.useState<string | null>(null)
  const [dangerAction, setDangerAction] = React.useState<"clear" | "delete" | null>(null)
  const [dangerConfirmation, setDangerConfirmation] = React.useState("")
  const [dangerBusy, setDangerBusy] = React.useState(false)
  const [dangerResult, setDangerResult] = React.useState<string | null>(null)
  React.useEffect(() => {
    setPolicy(bucket?.settings?.corsRules[0] ? { ...bucket.settings.corsRules[0] } : null)
    setDeliveryOrigins(bucket?.deliverySettings?.mediaAllowedOrigins ?? [])
    setDeliveryOriginInput("")
    setDeliveryOriginError(null)
  }, [bucket])

  async function patch(body: Record<string, unknown>) {
    if (!bucket) throw new Error("Bucket is not selected")
    const response = await fetch(settingsUrl(bucket), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const payload = (await response.json()) as { settings?: BucketSettings; deliverySettings?: BucketDeliverySettings; error?: string }
    if (!response.ok || !payload.settings) throw new Error(payload.error || "Unable to update settings")
    const updated = {
      ...bucket,
      settings: payload.settings,
      ...(payload.deliverySettings ? { deliverySettings: payload.deliverySettings } : {}),
      settingsError: null,
    }
    onUpdated(updated)
    return updated
  }

  async function togglePublic(enabled: boolean) {
    setSavingPublic(true)
    try { await patch({ publicAccessEnabled: enabled }); toast.success(`Public development URL ${enabled ? "enabled" : "disabled"}`) }
    catch (error: unknown) { toast.error(error instanceof Error ? error.message : "Unable to update public URL") }
    finally { setSavingPublic(false) }
  }

  async function saveCors() {
    setSavingCors(true)
    try { const updated = await patch({ corsRules: policy ? [policy] : [] }); setPolicy(updated.settings?.corsRules[0] ?? null); toast.success("CORS policy saved") }
    catch (error: unknown) { toast.error(error instanceof Error ? error.message : "Unable to save CORS policy") }
    finally { setSavingCors(false) }
  }

  function addDeliveryOrigin() {
    const result = normalizeMediaOrigin(deliveryOriginInput)
    if (result.error) {
      setDeliveryOriginError(result.error)
      return
    }
    const origin = result.origin
    if (!origin) return
    if (origin !== "*" && deliveryOrigins.includes("*")) {
      setDeliveryOriginError("Remove Any origin (*) before adding specific origins")
      return
    }
    if (origin !== "*" && deliveryOrigins.some((item) => item.toLowerCase() === origin.toLowerCase())) {
      setDeliveryOriginError("That origin is already listed")
      return
    }
    setDeliveryOrigins(origin === "*" ? ["*"] : [...deliveryOrigins, origin])
    setDeliveryOriginInput("")
    setDeliveryOriginError(null)
  }

  async function saveDeliverySettings() {
    if (!bucket) return
    setSavingDelivery(true)
    try {
      const updated = await patch({
        deliveryPublicAccessEnabled: bucket.deliverySettings?.deliveryPublicAccessEnabled === true,
        mediaAllowedOrigins: deliveryOrigins,
      })
      toast.success("Drive public access and media origins saved")
      setDeliveryOrigins(updated.deliverySettings?.mediaAllowedOrigins ?? deliveryOrigins)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to save Drive delivery settings")
    } finally {
      setSavingDelivery(false)
    }
  }

  async function toggleDrivePublicAccess(enabled: boolean) {
    if (!bucket) return
    setSavingDelivery(true)
    try {
      await patch({
        deliveryPublicAccessEnabled: enabled,
        mediaAllowedOrigins: deliveryOrigins,
      })
      toast.success(`Drive public access ${enabled ? "enabled" : "disabled"}`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update Drive public access")
    } finally {
      setSavingDelivery(false)
    }
  }

  async function runDangerAction() {
    if (!bucket || !dangerAction) return
    if (dangerConfirmation !== bucket.name) {
      setDangerResult(`Type ${bucket.name} exactly to confirm this action.`)
      return
    }
    setDangerBusy(true)
    setDangerResult(null)
    try {
      const response = await fetch(dangerUrl(bucket), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: dangerAction,
          bucketName: bucket.name,
          confirmBucketName: dangerConfirmation,
        }),
      })
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
      if (!response.ok) throw new Error(payload.error || payload.message || "Unable to complete bucket action")
      if (dangerAction === "delete") {
        toast.success(`Bucket ${bucket.name} deleted`)
        onDeleted(bucket)
        onOpenChange(false)
      } else {
        toast.success(`Bucket ${bucket.name} cleared`)
        setDangerResult("All objects were removed. The bucket and its settings remain available.")
        onUpdated({ ...bucket, objects: 0, bytes: 0, statsStatus: "completed" })
        setDangerAction(null)
        setDangerConfirmation("")
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unable to complete bucket action"
      setDangerResult(message)
      toast.error(message)
    } finally {
      setDangerBusy(false)
    }
  }

  const publicUrl = bucket?.settings?.publicAccess.enabled && bucket.settings.publicAccess.domain ? `https://${bucket.settings.publicAccess.domain}` : null
  return (
    <Dialog open={Boolean(bucket)} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Bucket settings</DialogTitle><DialogDescription>{bucket ? `${bucket.name} · ${bucket.accountLabel}` : "Manage bucket settings"}</DialogDescription></DialogHeader>
        {bucket?.settings ? <div className="space-y-6">
          <section className="space-y-3 border-b pb-6">
            <div className="flex items-start justify-between gap-4">
              <div><Label className="text-sm font-medium">Public development URL</Label><p className="mt-1 text-sm text-muted-foreground">Expose this bucket through its Cloudflare-managed r2.dev address.</p></div>
              <Switch checked={bucket.settings.publicAccess.enabled} onCheckedChange={(checked) => void togglePublic(checked)} disabled={savingPublic} aria-label="Toggle public development URL" />
            </div>
            {publicUrl ? <div className="flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 p-2"><Globe2 className="size-4 shrink-0 text-muted-foreground" /><a href={publicUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-primary hover:underline">{publicUrl}</a><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={async () => { await navigator.clipboard.writeText(publicUrl); toast.success("Public URL copied") }}><Copy /><span className="sr-only">Copy public URL</span></Button></TooltipTrigger><TooltipContent>Copy URL</TooltipContent></Tooltip></div> : null}
          </section>
          <section className="space-y-4 rounded-md border border-blue-500/30 bg-blue-500/5 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <Label className="text-sm font-medium">Drive public access</Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  Controls public delivery through Drive. This is independent from the Cloudflare Public development URL above; disabling it requires project API authorization.
                </p>
              </div>
              <Switch
                checked={bucket.deliverySettings?.deliveryPublicAccessEnabled === true}
                onCheckedChange={(checked) => void toggleDrivePublicAccess(checked)}
                disabled={savingDelivery || !bucket.deliverySettings}
                aria-label="Toggle Drive public access"
              />
            </div>
            <div className="space-y-2">
              <Label>Drive media allowed origins</Label>
              <p className="text-xs text-muted-foreground">
                These origins are synchronized to Drive delivery and the bucket&apos;s R2 CORS rule. Any origin (*) affects CORS only and does not bypass private API authorization.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={deliveryOriginInput}
                  onChange={(event) => {
                    setDeliveryOriginInput(event.target.value)
                    setDeliveryOriginError(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addDeliveryOrigin()
                    }
                  }}
                  placeholder="https://media.example.com"
                  aria-label="New Drive media origin"
                />
                <Button type="button" variant="outline" onClick={addDeliveryOrigin} className="sm:shrink-0">
                  <Plus /> Add origin
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setDeliveryOrigins(["*"])
                    setDeliveryOriginInput("")
                    setDeliveryOriginError(null)
                  }}
                  disabled={deliveryOrigins.length === 1 && deliveryOrigins[0] === "*"}
                  className="sm:shrink-0"
                >
                  Any origin (*)
                </Button>
              </div>
              {deliveryOriginError ? <p className="text-xs text-destructive">{deliveryOriginError}</p> : null}
              <div className="flex flex-wrap gap-2">
                {deliveryOrigins.length > 0 ? deliveryOrigins.map((origin) => (
                  <div key={origin} className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 font-mono text-xs">
                    <span className="break-all">{origin}</span>
                    <Button type="button" variant="ghost" size="icon" className="ml-1 h-6 w-6" aria-label={`Remove ${origin}`} onClick={() => setDeliveryOrigins((current) => current.filter((item) => item !== origin))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )) : <p className="text-xs text-muted-foreground">No Drive media origins configured.</p>}
              </div>
              <div className="flex justify-end">
                <Button type="button" onClick={() => void saveDeliverySettings()} loading={savingDelivery}>
                  <Check /> Save Drive delivery
                </Button>
              </div>
            </div>
          </section>
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><Label className="text-sm font-medium">CORS policy</Label><p className="mt-1 text-sm text-muted-foreground">Control which origins and methods can access this bucket. CORS does not grant private API access.</p></div><div className="flex gap-2">{!policy ? <Button variant="outline" size="sm" onClick={() => setPolicy({ allowedOrigins: [""], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] })}><Plus /> Add policy</Button> : null}<Button variant="outline" size="sm" onClick={() => setPolicy({ ...WILDCARD_RULE })}><Globe2 /> Any origin (*)</Button></div></div>
            {policy ? <CorsPolicyEditor policy={policy} onChange={setPolicy} onRemove={() => setPolicy(null)} /> : <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No CORS policy configured.</div>}
          </section>
          <section className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
              <div>
                <Label className="text-sm font-medium text-destructive">Danger Zone</Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  These actions permanently change R2 storage. Clearing removes every object but keeps the bucket; deleting removes the bucket, its objects, public URL, and CORS settings.
                </p>
              </div>
            </div>
            {dangerAction ? (
              <div className="space-y-2 rounded-md border border-destructive/30 bg-background p-3">
                <Label htmlFor="danger-bucket-confirmation">
                  Type <span className="font-mono">{bucket.name}</span> to confirm {dangerAction === "clear" ? "clearing this bucket" : "deleting this bucket"}.
                </Label>
                <Input
                  id="danger-bucket-confirmation"
                  value={dangerConfirmation}
                  onChange={(event) => {
                    setDangerConfirmation(event.target.value)
                    setDangerResult(null)
                  }}
                  placeholder={bucket.name}
                  autoComplete="off"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => void runDangerAction()}
                    loading={dangerBusy}
                    disabled={dangerConfirmation !== bucket.name}
                  >
                    {dangerAction === "clear" ? "Clear all objects" : "Delete bucket permanently"}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setDangerAction(null)
                      setDangerConfirmation("")
                      setDangerResult(null)
                    }}
                    disabled={dangerBusy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" className="border-destructive/40 text-destructive hover:bg-destructive/10" onClick={() => setDangerAction("clear")}>
                  <Trash2 className="mr-2 size-4" />
                  Clear bucket
                </Button>
                <Button variant="destructive" onClick={() => setDangerAction("delete")}>
                  <Trash2 className="mr-2 size-4" />
                  Delete bucket
                </Button>
              </div>
            )}
            {dangerResult ? <p className="text-sm text-destructive">{dangerResult}</p> : null}
          </section>
        </div> : bucket ? <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">{bucket.settingsError || "Bucket settings are unavailable."}</div> : null}
        <DialogFooter>{bucket?.settings ? <Button onClick={() => void saveCors()} disabled={savingCors}>{savingCors ? <RefreshCw className="animate-spin" /> : <Check />} Save CORS policy</Button> : null}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CorsPolicyEditor({ policy: rule, onChange, onRemove }: { policy: CorsRule; onChange: (rule: CorsRule) => void; onRemove: () => void }) {
  return <div className="space-y-4 rounded-md border p-4">
    <div className="flex items-center justify-between"><div className="font-medium">Policy</div><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={onRemove}><Trash2 /><span className="sr-only">Remove policy</span></Button></TooltipTrigger><TooltipContent>Remove policy</TooltipContent></Tooltip></div>
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="space-y-2"><div className="flex items-center justify-between gap-2"><Label>Allowed origins</Label><Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...rule, allowedOrigins: ["*"] })}>Any origin (*)</Button></div><Input value={rule.allowedOrigins.join(", ")} onChange={(event) => onChange({ ...rule, allowedOrigins: splitList(event.target.value) })} placeholder="https://example.com, *" /><p className="text-xs text-muted-foreground">Wildcard affects CORS only; it does not grant private bucket or project API access.</p></div>
      <div className="space-y-2"><Label>Allowed headers</Label><Input value={rule.allowedHeaders.join(", ")} onChange={(event) => onChange({ ...rule, allowedHeaders: splitList(event.target.value) })} placeholder="Content-Type, *" /></div>
      <div className="space-y-2"><Label>Exposed headers</Label><Input value={rule.exposeHeaders.join(", ")} onChange={(event) => onChange({ ...rule, exposeHeaders: splitList(event.target.value) })} placeholder="ETag" /></div>
      <div className="space-y-2"><Label>Max age (seconds)</Label><Input type="number" min={0} value={rule.maxAgeSeconds ?? ""} onChange={(event) => onChange({ ...rule, maxAgeSeconds: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="Optional" /></div>
    </div>
    <div className="space-y-2"><Label>Allowed methods</Label><div className="flex flex-wrap gap-3">{HTTP_METHODS.map((method) => <label key={method} className="flex items-center gap-2 text-sm"><Checkbox checked={rule.allowedMethods.includes(method)} onCheckedChange={(checked) => onChange({ ...rule, allowedMethods: checked ? Array.from(new Set([...rule.allowedMethods, method])) : rule.allowedMethods.filter((item) => item !== method) })} />{method}</label>)}</div></div>
  </div>
}

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

function settingsUrl(bucket: BucketRecord) {
  return `/api/buckets/${encodeURIComponent(bucket.accountId)}/${encodeURIComponent(bucket.name)}/settings`
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
                  <TableHead>Public URL</TableHead><TableHead>CORS</TableHead><TableHead className="w-16"><span className="sr-only">Manage</span></TableHead>
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
                    <TableCell>{bucket.settings ? (bucket.settings.corsRules.length > 0 ? "Configured" : "Not set") : "-"}</TableCell>
                    <TableCell>
                      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon" onClick={() => setSelected(bucket)}><Settings2 /><span className="sr-only">Manage {bucket.name}</span></Button></TooltipTrigger><TooltipContent>Manage settings</TooltipContent></Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
                {buckets.length === 0 ? <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">No buckets match these filters.</TableCell></TableRow> : null}
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
      }} />
    </DashboardPage>
  )
}

function Metric({ title, value, detail, icon: Icon }: { title: string; value: string; detail?: string; icon: React.ComponentType<{ className?: string }> }) {
  return <Card><CardHeader className="flex-row items-center justify-between space-y-0 pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle><Icon className="size-4 text-muted-foreground" /></CardHeader><CardContent><div className="text-2xl font-semibold">{value}</div>{detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}</CardContent></Card>
}

function BucketSettingsDialog({ bucket, onOpenChange, onUpdated }: { bucket: BucketRecord | null; onOpenChange: (open: boolean) => void; onUpdated: (bucket: BucketRecord) => void }) {
  const [policy, setPolicy] = React.useState<CorsRule | null>(null)
  const [savingCors, setSavingCors] = React.useState(false)
  const [savingPublic, setSavingPublic] = React.useState(false)
  React.useEffect(() => { setPolicy(bucket?.settings?.corsRules[0] ? { ...bucket.settings.corsRules[0] } : null) }, [bucket])

  async function patch(body: Record<string, unknown>) {
    if (!bucket) throw new Error("Bucket is not selected")
    const response = await fetch(settingsUrl(bucket), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    const payload = (await response.json()) as { settings?: BucketSettings; error?: string }
    if (!response.ok || !payload.settings) throw new Error(payload.error || "Unable to update settings")
    const updated = { ...bucket, settings: payload.settings, settingsError: null }
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
          <section className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><Label className="text-sm font-medium">CORS policy</Label><p className="mt-1 text-sm text-muted-foreground">Control which origins and methods can access this bucket.</p></div><div className="flex gap-2">{!policy ? <Button variant="outline" size="sm" onClick={() => setPolicy({ allowedOrigins: [""], allowedMethods: ["GET"], allowedHeaders: [], exposeHeaders: [] })}><Plus /> Add policy</Button> : null}<Button variant="outline" size="sm" onClick={() => setPolicy({ ...WILDCARD_RULE })}><Globe2 /> Wildcard template</Button></div></div>
            {policy ? <CorsPolicyEditor policy={policy} onChange={setPolicy} onRemove={() => setPolicy(null)} /> : <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No CORS policy configured.</div>}
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
      <div className="space-y-2"><Label>Allowed origins</Label><Input value={rule.allowedOrigins.join(", ")} onChange={(event) => onChange({ ...rule, allowedOrigins: splitList(event.target.value) })} placeholder="https://example.com, *" /></div>
      <div className="space-y-2"><Label>Allowed headers</Label><Input value={rule.allowedHeaders.join(", ")} onChange={(event) => onChange({ ...rule, allowedHeaders: splitList(event.target.value) })} placeholder="Content-Type, *" /></div>
      <div className="space-y-2"><Label>Exposed headers</Label><Input value={rule.exposeHeaders.join(", ")} onChange={(event) => onChange({ ...rule, exposeHeaders: splitList(event.target.value) })} placeholder="ETag" /></div>
      <div className="space-y-2"><Label>Max age (seconds)</Label><Input type="number" min={0} value={rule.maxAgeSeconds ?? ""} onChange={(event) => onChange({ ...rule, maxAgeSeconds: event.target.value === "" ? undefined : Number(event.target.value) })} placeholder="Optional" /></div>
    </div>
    <div className="space-y-2"><Label>Allowed methods</Label><div className="flex flex-wrap gap-3">{HTTP_METHODS.map((method) => <label key={method} className="flex items-center gap-2 text-sm"><Checkbox checked={rule.allowedMethods.includes(method)} onCheckedChange={(checked) => onChange({ ...rule, allowedMethods: checked ? Array.from(new Set([...rule.allowedMethods, method])) : rule.allowedMethods.filter((item) => item !== method) })} />{method}</label>)}</div></div>
  </div>
}

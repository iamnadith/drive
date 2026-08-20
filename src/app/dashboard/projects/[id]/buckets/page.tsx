"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, FolderPlus, KeyRound, Plus, Save, Star, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/page-shell"
import { validateProjectBucketCandidate } from "@/lib/project-bucket-name"

type Project = {
  id: string
  projectId: string
  name: string
  bucketName: string
  status: "active" | "disabled"
  createdAt: string
}

type Bucket = {
  id: string
  name: string
}

type ProjectBucket = {
  bucketName: string
  isPrimary: boolean
  createdAt: string
  mediaAllowedOrigins?: string[]
  deliveryPublicAccessEnabled?: boolean
}

type OriginDraft = {
  origins: string[]
  input: string
  error?: string
}

type BucketMode = "create" | "link"

function formatDate(value?: string) {
  if (!value) return "-"
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "-"
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
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

function originDraftsForBuckets(buckets: ProjectBucket[]) {
  return Object.fromEntries(
    buckets.map((bucket) => [
      bucket.bucketName,
      {
        origins: Array.isArray(bucket.mediaAllowedOrigins)
          ? bucket.mediaAllowedOrigins
          : [],
        input: "",
      } satisfies OriginDraft,
    ])
  ) as Record<string, OriginDraft>
}

function publicDeliveryState(bucket: ProjectBucket) {
  return typeof bucket.deliveryPublicAccessEnabled === "boolean"
    ? bucket.deliveryPublicAccessEnabled
    : undefined
}

export default function ProjectBucketsPage() {
  const params = useParams<{ id: string }>()
  const projectId = params?.id ?? ""

  const [project, setProject] = React.useState<Project | null>(null)
  const [availableBuckets, setAvailableBuckets] = React.useState<Bucket[]>([])
  const [projectBuckets, setProjectBuckets] = React.useState<ProjectBucket[]>([])
  const [loading, setLoading] = React.useState(true)
  const [bucketMode, setBucketMode] = React.useState<BucketMode>("create")
  const [bucketDraftName, setBucketDraftName] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [actingBucketName, setActingBucketName] = React.useState<string | null>(null)
  const [addBucketOpen, setAddBucketOpen] = React.useState(false)
  const [originDrafts, setOriginDrafts] = React.useState<Record<string, OriginDraft>>({})
  const [savingOriginsBucket, setSavingOriginsBucket] = React.useState<string | null>(null)
  const [savingDeliveryBucket, setSavingDeliveryBucket] = React.useState<string | null>(null)

  const loadAll = React.useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [projectRes, projectBucketsRes, availableBucketsRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}`),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/buckets`),
        fetch("/api/storage/buckets"),
      ])

      const [projectData, projectBucketsData, availableBucketsData] = await Promise.all([
        readJson(projectRes),
        readJson(projectBucketsRes),
        readJson(availableBucketsRes),
      ])

      if (!projectRes.ok) throw new Error(String(projectData.error ?? "Unable to load project"))
      if (!projectBucketsRes.ok) throw new Error(String(projectBucketsData.error ?? "Unable to load project buckets"))
      if (!availableBucketsRes.ok) throw new Error(String(availableBucketsData.error ?? "Unable to load buckets"))

      setProject((projectData.project as Project) ?? null)
      const nextProjectBuckets = Array.isArray(projectBucketsData.buckets)
        ? (projectBucketsData.buckets as ProjectBucket[])
        : []
      setProjectBuckets(nextProjectBuckets)
      setOriginDrafts(originDraftsForBuckets(nextProjectBuckets))
      setAvailableBuckets(Array.isArray(availableBucketsData.buckets) ? (availableBucketsData.buckets as Bucket[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load bucket management")
      setProject(null)
      setProjectBuckets([])
      setAvailableBuckets([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  React.useEffect(() => {
    void loadAll()
  }, [loadAll])

  const validation = React.useMemo(
    () =>
      validateProjectBucketCandidate({
        mode: bucketMode,
        rawBucketName: bucketDraftName,
        fallbackProjectName: project?.name ?? "",
        availableBucketNames: availableBuckets.map((bucket) => bucket.name),
        assignedBucketNames: projectBuckets.map((bucket) => bucket.bucketName),
      }),
    [availableBuckets, bucketDraftName, bucketMode, project?.name, projectBuckets]
  )

  const addBucket = async () => {
    if (!project) return
    if (validation.error) {
      toast.error(validation.error)
      return
    }

    setSubmitting(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/buckets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: bucketMode, bucketName: bucketDraftName }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to assign bucket"))
      setProjectBuckets(Array.isArray(data.buckets) ? (data.buckets as ProjectBucket[]) : [])
      setBucketDraftName("")
      setAddBucketOpen(false)
      toast.success(bucketMode === "create" ? "Bucket created and assigned" : "Bucket linked")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to assign bucket")
    } finally {
      setSubmitting(false)
    }
  }

  const setPrimaryBucket = async (bucketName: string) => {
    if (!project) return
    setActingBucketName(bucketName)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/buckets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucketName }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to set primary bucket"))
      setProjectBuckets(Array.isArray(data.buckets) ? (data.buckets as ProjectBucket[]) : [])
      toast.success("Primary bucket updated")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to set primary bucket")
    } finally {
      setActingBucketName(null)
    }
  }

  const unlinkBucket = async (bucketName: string) => {
    if (!project) return
    setActingBucketName(bucketName)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/buckets`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucketName }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to remove bucket"))
      setProjectBuckets(Array.isArray(data.buckets) ? (data.buckets as ProjectBucket[]) : [])
      toast.success("Bucket removed from project")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to remove bucket")
    } finally {
      setActingBucketName(null)
    }
  }

  const setDrivePublicAccess = async (bucketName: string, enabled: boolean) => {
    if (!project) return
    setSavingDeliveryBucket(bucketName)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/buckets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bucketName, deliveryPublicAccessEnabled: enabled }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to update Drive public access"))
      const nextBuckets = Array.isArray(data.buckets) ? (data.buckets as ProjectBucket[]) : []
      setProjectBuckets(nextBuckets)
      setOriginDrafts(originDraftsForBuckets(nextBuckets))
      toast.success(`Drive public access ${enabled ? "enabled" : "disabled"}`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update Drive public access")
    } finally {
      setSavingDeliveryBucket(null)
    }
  }

  const updateOriginDraft = (bucketName: string, update: Partial<OriginDraft>) => {
    setOriginDrafts((current) => ({
      ...current,
      [bucketName]: {
        origins: current[bucketName]?.origins ?? [],
        input: current[bucketName]?.input ?? "",
        ...update,
      },
    }))
  }

  const addMediaOrigin = (bucketName: string) => {
    const draft = originDrafts[bucketName] ?? { origins: [], input: "" }
    const result = normalizeMediaOrigin(draft.input)
    if (result.error) {
      updateOriginDraft(bucketName, { error: result.error })
      return
    }
    const origin = result.origin
    if (!origin) return
    if (draft.origins.includes("*")) {
      updateOriginDraft(bucketName, { error: "Remove Any origin (*) before adding specific origins" })
      return
    }
    if (draft.origins.some((existing) => existing.toLowerCase() === origin.toLowerCase())) {
      updateOriginDraft(bucketName, { error: "That origin is already listed" })
      return
    }
    updateOriginDraft(bucketName, {
      origins: [...draft.origins, origin],
      input: "",
      error: undefined,
    })
  }

  const removeMediaOrigin = (bucketName: string, origin: string) => {
    const draft = originDrafts[bucketName]
    if (!draft) return
    updateOriginDraft(bucketName, {
      origins: draft.origins.filter((candidate) => candidate !== origin),
      error: undefined,
    })
  }

  const saveMediaOrigins = async (bucketName: string) => {
    if (!project) return
    const draft = originDrafts[bucketName] ?? { origins: [], input: "" }
    if (draft.input.trim()) {
      addMediaOrigin(bucketName)
      toast.error("Add or clear the pending origin before saving")
      return
    }
    setSavingOriginsBucket(bucketName)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/buckets`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "media-origins",
          bucketName,
          mediaAllowedOrigins: draft.origins,
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to save media origins"))
      toast.success(`Media origins saved for ${bucketName}`)
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to save media origins")
    } finally {
      setSavingOriginsBucket(null)
    }
  }

  return (
    <DashboardPage>
      <DashboardPageHeader
        title={project ? `${project.name} buckets` : "Project buckets"}
        description="Bucket assignments for this project."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link href="/dashboard/projects">
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to projects
              </Link>
            </Button>
            {project ? (
              <Button variant="outline" asChild>
                <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/keys`}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  API keys
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" loading={loading} onClick={() => void loadAll()}>
              Refresh
            </Button>
          </>
        }
      />

      <Card className="border-border/60 shadow-sm">
        <CardContent className="grid gap-2 p-3 md:grid-cols-3">
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Primary bucket</div>
            <div className="mt-1 font-mono text-xs">{project?.bucketName || "No primary bucket"}</div>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Assigned</div>
            <div className="mt-1 text-base font-semibold">{projectBuckets.length}</div>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Status</div>
            <div className="mt-1">{project ? <Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge> : "-"}</div>
          </div>
        </CardContent>
      </Card>

      <Card className="border-border/60 shadow-sm">
        <CardHeader className="py-3">
          <CardTitle>Assigned buckets</CardTitle>
          <CardDescription>Set primary, open in storage, or remove.</CardDescription>
          <CardAction>
            <Button
              size="sm"
              onClick={() => {
                setBucketMode("create")
                setBucketDraftName("")
                setAddBucketOpen(true)
              }}
            >
              <FolderPlus className="mr-2 h-4 w-4" />
              Add bucket
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2 px-3 pb-3 sm:px-4 sm:pb-4">
          {loading ? (
            Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-16 w-full rounded-xl" />)
          ) : projectBuckets.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
              No buckets assigned yet.
            </div>
          ) : (
            projectBuckets.map((bucket) => (
              <div key={bucket.bucketName} className="rounded-xl border border-border/60 bg-background px-3 py-2.5">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div className="grid flex-1 gap-2 md:grid-cols-[minmax(0,1.4fr)_130px_130px_180px] md:items-center">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{bucket.bucketName}</span>
                        {bucket.isPrimary ? <Badge>Primary</Badge> : null}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">Assigned {formatDate(bucket.createdAt)}</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Role</div>
                      <div className="mt-1 text-muted-foreground">{bucket.isPrimary ? "Primary" : "Secondary"}</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Storage</div>
                      <div className="mt-1 text-muted-foreground">Direct view</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Public delivery</div>
                      <div className="mt-1 flex items-center gap-2">
                        {publicDeliveryState(bucket) === true ? (
                          <Badge variant="default">Enabled</Badge>
                        ) : publicDeliveryState(bucket) === false ? (
                          <Badge variant="secondary">Disabled</Badge>
                        ) : (
                          <Badge variant="outline">Check settings</Badge>
                        )}
                        <Switch
                          checked={publicDeliveryState(bucket) === true}
                          onCheckedChange={(checked) => void setDrivePublicAccess(bucket.bucketName, checked)}
                          disabled={savingDeliveryBucket === bucket.bucketName || publicDeliveryState(bucket) === undefined}
                          aria-label={`Toggle Drive public access for ${bucket.bucketName}`}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/dashboard/storage?bucket=${encodeURIComponent(bucket.bucketName)}`}>
                        Open in storage
                      </Link>
                    </Button>
                    {!bucket.isPrimary ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void setPrimaryBucket(bucket.bucketName)}
                        disabled={actingBucketName === bucket.bucketName}
                      >
                        <Star className="mr-2 h-4 w-4" />
                        Set primary
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void unlinkBucket(bucket.bucketName)}
                      disabled={actingBucketName === bucket.bucketName}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove
                    </Button>
                  </div>
                </div>

                  <div className="mt-3 rounded-lg border border-dashed border-border/70 bg-muted/20 p-3">
                  <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-sm font-medium">Media allowed origins</div>
                      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                      These exact browser origins are synchronized to Drive media responses and the bucket&apos;s R2 CORS policy. Include the scheme and port when needed; do not add a path.
                      </p>
                      <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                        Drive public access is independent from Cloudflare&apos;s Public development URL. When Drive public access is disabled, clients must use project API authorization.
                      </p>
                    </div>
                    <Badge variant="outline">Drive + R2 CORS</Badge>
                  </div>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={originDrafts[bucket.bucketName]?.input ?? ""}
                      onChange={(event) => updateOriginDraft(bucket.bucketName, {
                        input: event.target.value,
                        error: undefined,
                      })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault()
                          addMediaOrigin(bucket.bucketName)
                        }
                      }}
                      placeholder="https://media.example.com"
                      aria-label={`New media origin for ${bucket.bucketName}`}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="sm:shrink-0"
                      onClick={() => addMediaOrigin(bucket.bucketName)}
                    >
                      <Plus className="mr-2 h-4 w-4" />
                      Add origin
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="sm:shrink-0"
                      onClick={() => updateOriginDraft(bucket.bucketName, {
                        origins: ["*"],
                        input: "",
                        error: undefined,
                      })}
                      disabled={(originDrafts[bucket.bucketName]?.origins ?? []).length === 1 &&
                        originDrafts[bucket.bucketName]?.origins[0] === "*"}
                    >
                      Any origin (*)
                    </Button>
                  </div>
                  {originDrafts[bucket.bucketName]?.error ? (
                    <p className="mt-2 text-xs text-destructive">
                      {originDrafts[bucket.bucketName]?.error}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {(originDrafts[bucket.bucketName]?.origins ?? []).length > 0 ? (
                      (originDrafts[bucket.bucketName]?.origins ?? []).map((origin) => (
                        <div key={origin} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-xs">
                          <span className="break-all">{origin}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="ml-1 h-6 w-6 shrink-0"
                            aria-label={`Remove ${origin}`}
                            onClick={() => removeMediaOrigin(bucket.bucketName, origin)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-muted-foreground">No browser origins allowed yet.</p>
                    )}
                  </div>

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">
                      Saving updates both sides of the media CORS contract. Any origin (*) affects CORS only; it does not bypass private Drive API authorization.
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void saveMediaOrigins(bucket.bucketName)}
                      loading={savingOriginsBucket === bucket.bucketName}
                    >
                      <Save className="mr-2 h-4 w-4" />
                      Save origins
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Dialog open={addBucketOpen} onOpenChange={setAddBucketOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add bucket</DialogTitle>
            <DialogDescription>Create a new bucket with the exact entered name or assign an existing one from the active account.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Bucket action</Label>
              <Select value={bucketMode} onValueChange={(value) => setBucketMode(value as BucketMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="create">Create new bucket</SelectItem>
                  <SelectItem value="link">Assign existing bucket</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {bucketMode === "create" ? (
              <div className="space-y-2">
                <Label htmlFor="bucket-name">Bucket name</Label>
                <Input
                  id="bucket-name"
                  value={bucketDraftName}
                  onChange={(event) => setBucketDraftName(event.target.value)}
                  placeholder="Leave blank to use the project name"
                />
                {validation.error ? (
                  <p className="text-sm text-destructive">{validation.error}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Final bucket name: <span className="font-mono">{validation.bucketName || "-"}</span>
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Existing bucket</Label>
                <Select value={bucketDraftName} onValueChange={setBucketDraftName}>
                  <SelectTrigger>
                    <SelectValue placeholder={loading ? "Loading buckets..." : "Select a bucket"} />
                  </SelectTrigger>
                  <SelectContent>
                    {availableBuckets.map((bucket) => (
                      <SelectItem key={bucket.id || bucket.name} value={bucket.name}>
                        {bucket.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {validation.error ? <p className="text-sm text-destructive">{validation.error}</p> : null}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddBucketOpen(false)}>
              Cancel
            </Button>
            <Button onClick={addBucket} loading={submitting} disabled={!!validation.error}>
              {bucketMode === "create" ? "Create and assign" : "Assign bucket"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}

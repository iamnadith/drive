"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, FolderPlus, KeyRound, Star, Trash2 } from "lucide-react"
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
      setProjectBuckets(Array.isArray(projectBucketsData.buckets) ? (projectBucketsData.buckets as ProjectBucket[]) : [])
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
                  <div className="grid flex-1 gap-2 md:grid-cols-[minmax(0,1.4fr)_130px_130px] md:items-center">
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

"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, FolderPlus, KeyRound, MoreHorizontal, RefreshCw, Star, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
  projectCount: number
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
      const nextProjectBuckets = Array.isArray(projectBucketsData.buckets)
        ? (projectBucketsData.buckets as ProjectBucket[])
        : []
      setProjectBuckets(nextProjectBuckets)
      setAvailableBuckets(Array.isArray(availableBucketsData.buckets) ? (availableBucketsData.buckets as Bucket[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load bucket management")
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
      toast.success(data.deliverySyncPending
        ? `${bucketMode === "create" ? "Bucket created and assigned" : "Bucket linked"}; worker synchronization queued`
        : bucketMode === "create" ? "Bucket created and assigned" : "Bucket linked")
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
      toast.success(data.deliverySyncPending
        ? "Bucket removed; the worker will finish removing this project's managed origins"
        : "Bucket removed from project and delivery rules synchronized")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to remove bucket")
    } finally {
      setActingBucketName(null)
    }
  }

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <DashboardPageHeader
          title={project ? `${project.name} / Buckets` : "Project buckets"}
          description={project ? `${projectBuckets.length} assigned / ${project.projectId}` : "Manage the storage assigned to this project."}
          actions={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button variant="outline" size="icon" className="size-9 rounded-full" asChild>
                <Link href="/dashboard/projects" aria-label="Back to projects"><ArrowLeft /></Link>
              </Button>
              {project ? (
                <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/keys`}><KeyRound data-icon="inline-start" /> API keys</Link>
                </Button>
              ) : null}
              <Button variant="outline" size="icon" className="size-9 rounded-full" loading={loading} onClick={() => void loadAll()} aria-label="Refresh buckets">
                <RefreshCw />
              </Button>
              <Button
                size="icon"
                className="size-9 min-w-9 rounded-full sm:h-9 sm:w-auto sm:min-w-0 sm:px-3"
                onClick={() => {
                  setBucketMode("create")
                  setBucketDraftName("")
                  setAddBucketOpen(true)
                }}
                disabled={!project}
              >
                <FolderPlus data-icon="inline-start" />
                <span className="sr-only sm:not-sr-only">Add bucket</span>
              </Button>
            </div>
          }
        >
          {project ? <div className="mt-2"><Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge></div> : null}
        </DashboardPageHeader>
      </div>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 overflow-hidden gap-0 sm:gap-0 md:gap-0">
        <Table className="min-w-[760px] w-full" containerClassName="rounded-b-none max-sm:-mt-3 max-sm:!mx-0 max-sm:!w-full">
          <TableHeader>
            <TableRow className="h-9 border-b">
              <TableHead className="relative min-w-[280px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Bucket<span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" /></TableHead>
              <TableHead className="relative min-w-[130px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Role<span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" /></TableHead>
              <TableHead className="relative min-w-[200px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Assigned<span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" /></TableHead>
              <TableHead className="min-w-[160px] px-2.5 text-right text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && projectBuckets.length === 0 ? (
              Array.from({ length: 5 }).map((_, index) => <TableRow key={index} className="h-[64px]"><TableCell colSpan={4}><Skeleton className="h-10 w-full rounded-xl" /></TableCell></TableRow>)
            ) : projectBuckets.length ? (
              projectBuckets.map((bucket) => (
                <TableRow key={bucket.bucketName} className="h-[64px] border-b last:border-b-0 hover:bg-muted/30">
                  <TableCell className="relative px-2.5 py-2 font-mono text-sm">
                    <span className="block max-w-[320px] truncate">{bucket.bucketName}</span>
                    <span className="mt-1 block font-sans text-xs text-muted-foreground">{bucket.projectCount > 1 ? `Shared across ${bucket.projectCount} projects` : "Used only by this project"}</span>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2">
                    <Badge variant={bucket.isPrimary ? "default" : "secondary"}>{bucket.isPrimary ? "Primary" : "Secondary"}</Badge>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2 text-xs text-muted-foreground">
                    {formatDate(bucket.createdAt)}
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="px-2.5 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" className="rounded-full" asChild>
                        <Link href={`/dashboard/storage?bucket=${encodeURIComponent(bucket.bucketName)}`}>Open storage</Link>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`Actions for ${bucket.bucketName}`}><MoreHorizontal /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            {!bucket.isPrimary ? <DropdownMenuItem onClick={() => void setPrimaryBucket(bucket.bucketName)} disabled={actingBucketName === bucket.bucketName}><Star /> Set as primary</DropdownMenuItem> : null}
                            <DropdownMenuItem variant="destructive" onClick={() => void unlinkBucket(bucket.bucketName)} disabled={actingBucketName === bucket.bucketName}><Trash2 /> Remove from project</DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow><TableCell colSpan={4} className="h-28 text-center text-muted-foreground">No buckets are assigned to this project.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
        <div className="border-t px-3 py-2 text-center text-xs text-muted-foreground">
          {project?.bucketName ? <>Primary bucket: <span className="font-mono text-foreground">{project.bucketName}</span></> : "Choose Add bucket to connect storage."}
        </div>
      </Card>

      <Dialog open={addBucketOpen} onOpenChange={setAddBucketOpen}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add bucket</DialogTitle>
            <DialogDescription>Create a new bucket with the exact entered name or assign an existing one from the active account.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 rounded-lg border bg-muted/40 p-4">
            <div className="flex flex-col gap-2">
              <Label>Bucket action</Label>
              <Select value={bucketMode} onValueChange={(value) => setBucketMode(value as BucketMode)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="create">Create new bucket</SelectItem>
                    <SelectItem value="link">Assign existing bucket</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>

            {bucketMode === "create" ? (
              <div className="flex flex-col gap-2">
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
              <div className="flex flex-col gap-2">
                <Label>Existing bucket</Label>
                <Select value={bucketDraftName} onValueChange={setBucketDraftName}>
                  <SelectTrigger>
                    <SelectValue placeholder={loading ? "Loading buckets..." : "Select a bucket"} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {availableBuckets.map((bucket) => (
                        <SelectItem key={bucket.id || bucket.name} value={bucket.name}>{bucket.name}</SelectItem>
                      ))}
                    </SelectGroup>
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

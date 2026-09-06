"use client"

import * as React from "react"
import Link from "next/link"
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
} from "lucide-react"
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
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
import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell"
import { cn } from "@/lib/utils"

type Project = {
  id: string
  projectId: string
  name: string
  bucketName: string
  status: "active" | "disabled"
  createdAccountLabel?: string
  createdAt: string
  updatedAt?: string
  keyCount?: number
  bucketCount?: number
}

type ProjectSettingsPayload = {
  deliverySettings?: { mediaAllowedOrigins?: string[] | null }
}

type ProjectBucketDeliveryRule = {
  bucketName: string
  projectCount: number
  effectiveMediaAllowedOrigins: string[]
  corsRules: Array<{ id?: string; allowedOrigins: string[]; allowedMethods: string[] }>
  providerStatus: string
  providerLastSyncedAt: string | null
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
    const localHost = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
    if (url.protocol === "http:" && !localHost) {
      return { error: "Use HTTPS for non-local origins; HTTP is limited to localhost development" }
    }
    if (!url.hostname || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return { error: "Use the origin only; remove credentials, paths, queries, and hashes" }
    }
    return { origin: url.origin }
  } catch {
    return { error: "Enter a valid URL origin, including http:// or https://" }
  }
}

function readProjectOrigins(data: Record<string, unknown>) {
  const settings = (data.deliverySettings && typeof data.deliverySettings === "object" ? data.deliverySettings : {}) as ProjectSettingsPayload["deliverySettings"]
  const origins = settings?.mediaAllowedOrigins
  return Array.isArray(origins) ? origins.filter((value): value is string => typeof value === "string") : []
}

export default function ProjectsPage() {
  const PAGE_SIZE = 8
  const [projects, setProjects] = React.useState<Project[]>([])
  const [loading, setLoading] = React.useState(false)
  const [search, setSearch] = React.useState("")
  const [page, setPage] = React.useState(1)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [projectName, setProjectName] = React.useState("")
  const [creatingProject, setCreatingProject] = React.useState(false)

  const [settingsProject, setSettingsProject] = React.useState<Project | null>(null)
  const [settingsName, setSettingsName] = React.useState("")
  const [settingsStatus, setSettingsStatus] = React.useState<"active" | "disabled">("active")
  const [settingsOrigins, setSettingsOrigins] = React.useState<string[]>([])
  const [settingsOriginInput, setSettingsOriginInput] = React.useState("")
  const [settingsOriginError, setSettingsOriginError] = React.useState<string>()
  const [settingsBucketRules, setSettingsBucketRules] = React.useState<ProjectBucketDeliveryRule[]>([])
  const [loadingSettings, setLoadingSettings] = React.useState(false)
  const [savingSettings, setSavingSettings] = React.useState(false)
  const [syncingSettings, setSyncingSettings] = React.useState(false)

  const [deleteTarget, setDeleteTarget] = React.useState<Project | null>(null)
  const [deleteBucket, setDeleteBucket] = React.useState(false)
  const [deletingProject, setDeletingProject] = React.useState(false)

  const loadProjects = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/projects")
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to load projects"))
      setProjects(Array.isArray(data.projects) ? (data.projects as Project[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load projects")
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  const filteredProjects = React.useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return projects

    return projects.filter((project) => {
      return (
        project.name.toLowerCase().includes(query) ||
        project.projectId.toLowerCase().includes(query) ||
        project.bucketName.toLowerCase().includes(query)
      )
    })
  }, [projects, search])

  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / PAGE_SIZE))
  const paginatedProjects = React.useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredProjects.slice(start, start + PAGE_SIZE)
  }, [filteredProjects, page])

  React.useEffect(() => {
    setPage(1)
  }, [search])

  React.useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [page, totalPages])

  const openCreateDialog = () => {
    setProjectName("")
    setCreateOpen(true)
  }

  const openSettingsDialog = async (project: Project) => {
    setSettingsProject(project)
    setSettingsName(project.name)
    setSettingsStatus(project.status)
    setSettingsOrigins([])
    setSettingsOriginInput("")
    setSettingsOriginError(undefined)
    setSettingsBucketRules([])
    setLoadingSettings(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`)
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to load project settings"))
      const loadedProject = data.project as Project | undefined
      if (loadedProject) {
        setSettingsProject((current) => ({ ...loadedProject, bucketCount: current?.bucketCount }))
        setSettingsName(loadedProject.name)
        setSettingsStatus(loadedProject.status)
      }
      setSettingsOrigins(readProjectOrigins(data))
      setSettingsBucketRules(Array.isArray(data.bucketDeliveryRules) ? data.bucketDeliveryRules as ProjectBucketDeliveryRule[] : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load project settings")
    } finally {
      setLoadingSettings(false)
    }
  }

  const addSettingsOrigin = () => {
    const result = normalizeMediaOrigin(settingsOriginInput)
    if (result.error) {
      setSettingsOriginError(result.error)
      return
    }
    const origin = result.origin
    if (!origin) return
    if (settingsOrigins.includes("*")) {
      setSettingsOriginError("Remove Any origin (*) before adding a specific origin")
      return
    }
    if (settingsOrigins.some((existing) => existing.toLowerCase() === origin.toLowerCase())) {
      setSettingsOriginError("That origin is already listed")
      return
    }
    setSettingsOrigins((current) => [...current, origin])
    setSettingsOriginInput("")
    setSettingsOriginError(undefined)
  }

  const createProject = async () => {
    if (!projectName.trim()) {
      toast.error("Project name is required")
      return
    }

    setCreatingProject(true)
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: projectName }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to create project"))
      setCreateOpen(false)
      toast.success("Project created")
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to create project")
    } finally {
      setCreatingProject(false)
    }
  }

  const saveSettings = async () => {
    if (!settingsProject) return
    if (!settingsName.trim()) {
      toast.error("Project name is required")
      return
    }

    setSavingSettings(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(settingsProject.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: settingsName,
          status: settingsStatus,
          mediaAllowedOrigins: settingsOrigins,
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to update project"))
      setSettingsProject((current) => ({ ...(data.project as Project), bucketCount: current?.bucketCount }))
      toast.success(data.deliverySyncPending
        ? "Project policy saved; the worker will finish provider synchronization"
        : "Project delivery policy saved and synchronized")
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update project")
    } finally {
      setSavingSettings(false)
    }
  }

  const syncSettingsPolicy = async () => {
    if (!settingsProject) return
    setSyncingSettings(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(settingsProject.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "syncDelivery" }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to synchronize delivery policy"))
      const count = Number(data.synchronizedBuckets ?? 0)
      toast.success(`Delivery policy verified on ${count} bucket${count === 1 ? "" : "s"}`)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to synchronize delivery policy")
    } finally {
      setSyncingSettings(false)
    }
  }

  const deleteProject = async () => {
    if (!deleteTarget) return
    setDeletingProject(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deleteBucket }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to delete project"))
      setDeleteTarget(null)
      setDeleteBucket(false)
      const keptShared = Number(data.keptSharedBuckets ?? 0)
      toast.success(
        deleteBucket
          ? `Project deleted${keptShared ? `; ${keptShared} shared bucket${keptShared === 1 ? " was" : "s were"} kept` : " with its unshared buckets"}`
          : "Project deleted"
      )
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete project")
    } finally {
      setDeletingProject(false)
    }
  }

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <DashboardPageHeader
          title="Projects"
          description={`${projects.length} project${projects.length === 1 ? "" : "s"} connected to the active account.`}
          actions={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:flex-wrap sm:justify-end">
              <div className="relative h-9 min-w-0 flex-1 sm:w-[220px] sm:flex-none">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search projects..."
                  aria-label="Search projects"
                  className="h-9 w-full pl-8"
                />
              </div>
              <Button
                variant="outline"
                size="icon"
                className="size-9 shrink-0 rounded-full"
                loading={loading}
                onClick={() => void loadProjects()}
                aria-label="Refresh projects"
              >
                <RefreshCw />
              </Button>
              <Button
                size="icon"
                className="size-9 min-w-9 shrink-0 rounded-full sm:h-9 sm:w-auto sm:min-w-0 sm:px-3"
                onClick={openCreateDialog}
              >
                <Plus data-icon="inline-start" />
                <span className="sr-only sm:not-sr-only">New project</span>
              </Button>
            </div>
          }
        />
      </div>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 overflow-hidden gap-0 sm:gap-0 md:gap-0">
        <Table className="min-w-[930px] w-full" containerClassName="rounded-b-none max-sm:-mt-3 max-sm:!mx-0 max-sm:!w-full">
          <TableHeader>
            <TableRow className="h-9 border-b">
              {[
                ["Project", "min-w-[240px]"],
                ["Account", "min-w-[170px]"],
                ["Primary bucket", "min-w-[220px]"],
                ["Buckets", "min-w-[90px]"],
                ["API keys", "min-w-[90px]"],
                ["Status", "min-w-[110px]"],
                ["Actions", "min-w-[170px]"],
              ].map(([label, width], index, items) => (
                <TableHead key={label} className={cn(width, "relative px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground", label === "Actions" && "text-right")}>
                  {label}
                  {index < items.length - 1 ? <span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" /> : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && projects.length === 0 ? (
              Array.from({ length: 6 }).map((_, index) => (
                <TableRow key={index} className="h-[64px]">
                  <TableCell colSpan={7}><Skeleton className="h-10 w-full rounded-xl" /></TableCell>
                </TableRow>
              ))
            ) : paginatedProjects.length ? (
              paginatedProjects.map((project) => (
                <TableRow key={project.id} className="h-[64px] border-b last:border-b-0 hover:bg-muted/30">
                  <TableCell className="relative px-2.5 py-2">
                    <div className="max-w-[260px]">
                      <div className="truncate font-medium">{project.name}</div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{project.projectId}</div>
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2 text-sm text-muted-foreground">
                    <span className="block max-w-[180px] truncate">{project.createdAccountLabel || "Active account"}</span>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2 font-mono text-xs">
                    <span className="block max-w-[230px] truncate">{project.bucketName || "Not assigned"}</span>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2 text-center font-medium">
                    {project.bucketCount ?? 0}
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2 text-center font-medium">
                    {project.keyCount ?? 0}
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="relative px-2.5 py-2">
                    <Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </TableCell>
                  <TableCell className="px-2.5 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon-sm" className="rounded-full" asChild>
                        <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/buckets`} aria-label={`Manage buckets for ${project.name}`}>
                          <FolderPlus />
                        </Link>
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="rounded-full" asChild>
                        <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/keys`} aria-label={`Manage API keys for ${project.name}`}>
                          <KeyRound />
                        </Link>
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`More actions for ${project.name}`}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => void openSettingsDialog(project)}>
                              <Settings2 /> Settings
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(project)}>
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="h-28 text-center text-muted-foreground">
                  {projects.length === 0 ? "No projects yet." : "No projects match your search."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="border-t px-3 py-2 text-xs text-muted-foreground max-sm:-mb-2">
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <Button variant="outline" size="sm" className="justify-self-start rounded-full" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1 || filteredProjects.length === 0}>
              <ChevronLeft data-icon="inline-start" /> <span className="hidden sm:inline">Previous</span>
            </Button>
            <span className="justify-self-center">Page {filteredProjects.length ? page : 0} of {filteredProjects.length ? totalPages : 0}</span>
            <Button variant="outline" size="sm" className="justify-self-end rounded-full" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page === totalPages || filteredProjects.length === 0}>
              <span className="hidden sm:inline">Next</span> <ChevronRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>Only the project name is required. Buckets can be assigned after the project is created.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-4">
            <Label htmlFor="project-name">Project name</Label>
            <Input
              id="project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Customer uploads"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={createProject} loading={creatingProject}>
              Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!settingsProject} onOpenChange={(open) => !open && setSettingsProject(null)}>
        <DialogContent className="max-h-[88vh] flex flex-col rounded-2xl sm:max-h-[94vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>Update project identity and the inherited browser origins used by assigned media buckets. Bucket assignment remains on the dedicated buckets page.</DialogDescription>
          </DialogHeader>

          {settingsProject ? (
            <div className="flex min-h-0 flex-col gap-5 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="grid gap-4 rounded-lg border bg-muted/40 p-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="settings-name">Project name</Label>
                  <Input
                    id="settings-name"
                    value={settingsName}
                    onChange={(event) => setSettingsName(event.target.value)}
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label>Status</Label>
                  <Select value={settingsStatus} onValueChange={(value) => setSettingsStatus(value as "active" | "disabled")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/40 p-4">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">Delivery &amp; CORS policy</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      One managed policy, applied to every assigned bucket and updated in place. Existing non-Drive CORS rules are preserved.
                    </p>
                  </div>
                  <Badge variant={settingsOrigins.includes("*") ? "default" : "outline"}>{settingsOrigins.includes("*") ? "All origins" : `1 policy / ${settingsOrigins.length} origin${settingsOrigins.length === 1 ? "" : "s"}`}</Badge>
                </div>

                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <Input
                    value={settingsOriginInput}
                    onChange={(event) => {
                      setSettingsOriginInput(event.target.value)
                      setSettingsOriginError(undefined)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        addSettingsOrigin()
                      }
                    }}
                    placeholder="https://media.example.com"
                    aria-label="New inherited media origin"
                    disabled={loadingSettings}
                  />
                  <Button type="button" variant="outline" className="sm:shrink-0" onClick={addSettingsOrigin} disabled={loadingSettings}>
                    <Plus data-icon="inline-start" />
                    Add origin
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="sm:shrink-0"
                    onClick={() => {
                      setSettingsOrigins(["*"])
                      setSettingsOriginInput("")
                      setSettingsOriginError(undefined)
                    }}
                    disabled={loadingSettings || (settingsOrigins.length === 1 && settingsOrigins[0] === "*")}
                  >
                    Any origin (*)
                  </Button>
                </div>
                {settingsOriginError ? <p className="mt-2 text-xs text-destructive">{settingsOriginError}</p> : null}

                <div className="mt-3 flex flex-wrap gap-2">
                  {settingsOrigins.length > 0 ? settingsOrigins.map((origin) => (
                    <div key={origin} className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/70 bg-background px-2 py-1 font-mono text-xs">
                      <span className="break-all">{origin}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-1 h-6 w-6 shrink-0"
                        aria-label={`Remove ${origin}`}
                        onClick={() => setSettingsOrigins((current) => current.filter((candidate) => candidate !== origin))}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )) : <p className="text-xs text-muted-foreground">No inherited browser origins configured.</p>}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Any origin (*) takes precedence across every project and bucket policy, so no additional origins are needed. It affects browser CORS only and never bypasses private Drive API authorization.
                </p>
                <div className="mt-4 flex flex-col gap-2 rounded-md border bg-background p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-xs">drive-media-delivery</span>
                    <Badge variant="secondary">{settingsProject.bucketCount ?? 0} assigned bucket{(settingsProject.bucketCount ?? 0) === 1 ? "" : "s"}</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline">GET</Badge>
                    <Badge variant="outline">HEAD</Badge>
                    {(settingsOrigins.length ? settingsOrigins : ["Deployment fallback origins"]).map((origin) => (
                      <Badge key={origin} variant="outline" className="max-w-full font-mono"><span className="truncate">{origin}</span></Badge>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">This project owns one policy. Each bucket receives the union of this policy, other assigned project policies, and its bucket-manual origins; unrelated provider rules are never removed.</p>
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  <div className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Rules on assigned buckets</div>
                  {settingsBucketRules.length > 0 ? settingsBucketRules.map((bucket) => (
                    <div key={bucket.bucketName} className="flex flex-col gap-2 rounded-md border bg-background p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">{bucket.bucketName}</span>
                        <div className="flex gap-1.5">
                          {bucket.projectCount > 1 ? <Badge variant="outline">{bucket.projectCount} projects</Badge> : null}
                          <Badge variant={bucket.providerStatus === "ok" || bucket.providerStatus === "completed" ? "secondary" : "outline"}>{bucket.providerStatus}</Badge>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {bucket.effectiveMediaAllowedOrigins.map((origin) => <Badge key={`${bucket.bucketName}-${origin}`} variant="outline" className="max-w-full font-mono"><span className="truncate">{origin}</span></Badge>)}
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                        {bucket.corsRules.length ? bucket.corsRules.map((rule, index) => (
                          <span key={`${bucket.bucketName}-${rule.id ?? index}`} className="rounded border px-2 py-1">
                            {rule.id || `Provider rule ${index + 1}`}: {rule.allowedMethods.join(", ")} / {rule.allowedOrigins.join(", ")}
                          </span>
                        )) : <span>No provider CORS snapshot yet; the worker will verify it.</span>}
                      </div>
                    </div>
                  )) : <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">No assigned bucket rules to display.</div>}
                </div>
                <div className="mt-4 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">Saving verifies the managed rule on every assigned bucket. Re-sync repairs provider-side drift without changing your policy.</p>
                  <Button type="button" variant="outline" size="sm" className="sm:shrink-0" loading={syncingSettings} onClick={syncSettingsPolicy}>
                    <RefreshCw data-icon="inline-start" /> Re-sync buckets
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="outline" className="flex-1" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(settingsProject.id)}/buckets`}>
                    <FolderPlus data-icon="inline-start" />
                    Open bucket page
                  </Link>
                </Button>
                <Button variant="outline" className="flex-1" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(settingsProject.id)}/keys`}>
                    <KeyRound data-icon="inline-start" />
                    Manage API keys
                  </Link>
                </Button>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsProject(null)}>
              Close
            </Button>
            <Button onClick={saveSettings} loading={savingSettings}>
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="rounded-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>Choose whether the project should be removed alone or along with every bucket currently assigned to it.</DialogDescription>
          </DialogHeader>

          {deleteTarget ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-lg border bg-muted/40 p-4 text-sm">
                <div className="font-medium">{deleteTarget.name}</div>
                <div className="mt-1 font-mono text-xs text-muted-foreground">{deleteTarget.bucketName || "No primary bucket"}</div>
              </div>
              <RadioGroup value={deleteBucket ? "all" : "project"} onValueChange={(value) => setDeleteBucket(value === "all")} className="grid gap-2">
                <Label htmlFor="delete-project-only" className="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5">
                  <RadioGroupItem id="delete-project-only" value="project" className="mt-0.5" />
                  <span><span className="block font-medium">Keep assigned buckets</span><span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">Remove the project record, API keys, and project links only.</span></span>
                </Label>
                <Label htmlFor="delete-project-all" className="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5 has-[[data-state=checked]]:border-destructive has-[[data-state=checked]]:bg-destructive/5">
                  <RadioGroupItem id="delete-project-all" value="all" className="mt-0.5" />
                  <span><span className="block font-medium">Delete project and unshared storage</span><span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">Permanently delete buckets used only by this project. Buckets shared with other projects are kept.</span></span>
                </Label>
              </RadioGroup>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteProject} loading={deletingProject}>
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}

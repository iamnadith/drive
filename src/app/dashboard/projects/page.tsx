"use client"

import * as React from "react"
import Link from "next/link"
import {
  FolderPlus,
  KeyRound,
  MoreHorizontal,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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

function MetricCard({
  title,
  value,
  description,
}: {
  title: string
  value: string | number
  description: string
}) {
  return (
    <Card>
      <CardHeader className="gap-1">
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-sm text-muted-foreground">{description}</CardContent>
    </Card>
  )
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
  const [loadingSettings, setLoadingSettings] = React.useState(false)
  const [savingSettings, setSavingSettings] = React.useState(false)

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

  const totalKeys = projects.reduce((sum, project) => sum + (project.keyCount ?? 0), 0)
  const activeProjects = projects.filter((project) => project.status === "active").length
  const totalAssignedBuckets = projects.reduce((sum, project) => sum + (project.bucketCount ?? 0), 0)

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
    setLoadingSettings(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}`)
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to load project settings"))
      const loadedProject = data.project as Project | undefined
      if (loadedProject) {
        setSettingsProject(loadedProject)
        setSettingsName(loadedProject.name)
        setSettingsStatus(loadedProject.status)
      }
      setSettingsOrigins(readProjectOrigins(data))
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
      setSettingsProject(data.project as Project)
      toast.success("Project and inherited media policy updated")
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update project")
    } finally {
      setSavingSettings(false)
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
      toast.success(deleteBucket ? "Project and assigned buckets deleted" : "Project deleted")
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete project")
    } finally {
      setDeletingProject(false)
    }
  }

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Projects"
        description="Projects, buckets, and API access."
        actions={
          <>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects"
              className="h-9 w-full sm:w-56"
            />
            <Button className="!h-8 !min-h-8 px-3 text-sm" variant="outline" loading={loading} onClick={() => void loadProjects()}>
              Refresh
            </Button>
            <Button className="!h-8 !min-h-8 px-3 text-sm" onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              New project
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard title="Projects" value={projects.length} description="Project records created in the workspace." />
        <MetricCard title="Active" value={activeProjects} description="Projects currently available for use." />
        <MetricCard title="Assigned Buckets" value={totalAssignedBuckets} description="Total buckets linked across all projects." />
        <MetricCard title="API Keys" value={totalKeys} description="Keys remain managed on separate project access pages." />
      </div>

      <div className="space-y-3">
        <div className="flex justify-end">
          {filteredProjects.length > PAGE_SIZE ? (
            <div className="text-xs text-muted-foreground">
              Page {page} of {totalPages}
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          {loading ? (
            Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-24 w-full rounded-2xl" />)
          ) : filteredProjects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border/70 bg-muted/20 px-6 py-10 text-center">
              <div className="font-medium">{projects.length === 0 ? "No projects yet" : "No matching projects"}</div>
              {projects.length === 0 ? (
                <Button className="mt-4" onClick={openCreateDialog}>
                  <Plus className="mr-2 h-4 w-4" />
                  New project
                </Button>
              ) : null}
            </div>
          ) : (
            paginatedProjects.map((project) => (
              <div
                key={project.id}
                className={cn(
                  "group rounded-2xl border p-3 transition-colors",
                  project.status === "active"
                    ? "border-primary/20 bg-card shadow-sm"
                    : "border-border/60 bg-card shadow-sm"
                )}
              >
                <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                  <div className="grid flex-1 gap-2.5 lg:grid-cols-[minmax(0,1.3fr)_minmax(210px,0.9fr)_minmax(140px,0.5fr)_minmax(140px,0.5fr)] xl:items-center">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="text-base font-semibold tracking-tight">{project.name}</div>
                        <Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge>
                      </div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{project.projectId}</div>
                      <div className="mt-2 text-xs text-muted-foreground">{project.createdAccountLabel || "Project workspace"}</div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Primary bucket</div>
                      <div className="mt-1 font-mono text-xs">{project.bucketName || "No primary bucket"}</div>
                    </div>

                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-center">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Buckets</div>
                      <div className="mt-1 text-lg font-semibold">{project.bucketCount ?? 0}</div>
                    </div>
                    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-center">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Keys</div>
                      <div className="mt-1 text-lg font-semibold">{project.keyCount ?? 0}</div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/buckets`}>
                        <FolderPlus className="mr-2 h-4 w-4" />
                        Buckets
                      </Link>
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/keys`}>
                        <KeyRound className="mr-2 h-4 w-4" />
                        API keys
                      </Link>
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="rounded-full">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => void openSettingsDialog(project)}>
                          <Settings2 className="mr-2 h-4 w-4" />
                          Settings
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => setDeleteTarget(project)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {filteredProjects.length > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-3">
            <div className="text-xs text-muted-foreground">
              Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredProjects.length)} of {filteredProjects.length}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page === 1}>
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>Only the project name is required. Buckets can be assigned after the project is created.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
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
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Project settings</DialogTitle>
            <DialogDescription>Update project identity and the inherited browser origins used by assigned media buckets. Bucket assignment remains on the dedicated buckets page.</DialogDescription>
          </DialogHeader>

          {settingsProject ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="settings-name">Project name</Label>
                  <Input
                    id="settings-name"
                    value={settingsName}
                    onChange={(event) => setSettingsName(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select value={settingsStatus} onValueChange={(value) => setSettingsStatus(value as "active" | "disabled")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="disabled">Disabled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-medium">Inherited media origins</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      These project-level origins are inherited by assigned buckets and synchronized to Drive media responses and R2 CORS. Drive public access is still managed per bucket on the global Buckets dashboard.
                    </p>
                  </div>
                  <Badge variant="outline">Project policy</Badge>
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
                    <Plus className="mr-2 h-4 w-4" />
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
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )) : <p className="text-xs text-muted-foreground">No inherited browser origins configured.</p>}
                </div>
                <p className="mt-3 text-xs text-muted-foreground">
                  Any origin (*) replaces the specific origins and affects CORS only; it does not bypass private Drive API authorization.
                </p>
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(settingsProject.id)}/buckets`}>
                    <FolderPlus className="mr-2 h-4 w-4" />
                    Open bucket page
                  </Link>
                </Button>
                <Button variant="outline" className="flex-1" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(settingsProject.id)}/keys`}>
                    <KeyRound className="mr-2 h-4 w-4" />
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>Choose whether the project should be removed alone or along with every bucket currently assigned to it.</DialogDescription>
          </DialogHeader>

          {deleteTarget ? (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/50 p-3 text-sm">
                <div className="font-medium">{deleteTarget.name}</div>
                <div className="font-mono text-xs text-muted-foreground">{deleteTarget.bucketName || "No primary bucket"}</div>
              </div>

              <button
                type="button"
                className={`w-full rounded-md border p-3 text-left text-sm ${!deleteBucket ? "border-primary bg-primary/5" : ""}`}
                onClick={() => setDeleteBucket(false)}
              >
                Keep all assigned buckets and only remove the project record, API keys, and project links.
              </button>

              <button
                type="button"
                className={`w-full rounded-md border p-3 text-left text-sm ${deleteBucket ? "border-destructive bg-destructive/5" : ""}`}
                onClick={() => setDeleteBucket(true)}
              >
                Delete all assigned buckets and all objects from the active account too.
              </button>
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

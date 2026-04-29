"use client"

import * as React from "react"
import {
  BookOpen,
  Copy,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Switch } from "@/components/ui/switch"
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
  DashboardPanel,
} from "@/components/dashboard/page-shell"

const PERMISSION_KEYS = [
  "list",
  "read",
  "download",
  "upload",
  "write",
  "rename",
  "delete",
  "createFolder",
  "createExpiringLink",
  "createPermanentLink",
  "revokeLink",
  "readMetadata",
  "writeMetadata",
] as const

type PermissionKey = (typeof PERMISSION_KEYS)[number]
type Permissions = Record<PermissionKey, boolean>
type Project = {
  id: string
  projectId: string
  name: string
  bucketName: string
  status: "active" | "disabled"
  createdAccountLabel?: string
  createdAt: string
  keyCount?: number
}
type ApiKey = {
  id: string
  name: string
  keyPrefix: string
  status: "active" | "disabled"
  expiresAt?: string
  lastUsedAt?: string
  permissions: Permissions
  createdAt: string
}

const PRESETS: Record<string, Permissions> = {
  "Read only": {
    list: true,
    read: true,
    download: true,
    upload: false,
    write: false,
    rename: false,
    delete: false,
    createFolder: false,
    createExpiringLink: false,
    createPermanentLink: false,
    revokeLink: false,
    readMetadata: true,
    writeMetadata: false,
  },
  "Upload only": {
    list: false,
    read: false,
    download: false,
    upload: true,
    write: false,
    rename: false,
    delete: false,
    createFolder: true,
    createExpiringLink: false,
    createPermanentLink: false,
    revokeLink: false,
    readMetadata: false,
    writeMetadata: true,
  },
  "Read + write": {
    list: true,
    read: true,
    download: true,
    upload: true,
    write: true,
    rename: false,
    delete: false,
    createFolder: true,
    createExpiringLink: true,
    createPermanentLink: false,
    revokeLink: false,
    readMetadata: true,
    writeMetadata: true,
  },
  "Full access": Object.fromEntries(PERMISSION_KEYS.map((key) => [key, true])) as Permissions,
}

const permissionLabels: Record<PermissionKey, string> = {
  list: "List files",
  read: "Read files",
  download: "Download",
  upload: "Upload",
  write: "Write content",
  rename: "Rename",
  delete: "Delete",
  createFolder: "Create folders",
  createExpiringLink: "Expiring links",
  createPermanentLink: "Permanent links",
  revokeLink: "Revoke links",
  readMetadata: "Read metadata",
  writeMetadata: "Write metadata",
}

function formatDate(value?: string) {
  if (!value) return "-"
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toLocaleString() : "-"
}

function normalizePermissions(input: Partial<Record<PermissionKey, boolean>>): Permissions {
  return Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, input[key] === true])
  ) as Permissions
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

function CodeExample({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-2xl border bg-muted p-3 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  )
}

export default function ProjectsPage() {
  const [projects, setProjects] = React.useState<Project[]>([])
  const [selectedProject, setSelectedProject] = React.useState<Project | null>(null)
  const [keys, setKeys] = React.useState<ApiKey[]>([])
  const [loading, setLoading] = React.useState(false)
  const [keysLoading, setKeysLoading] = React.useState(false)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [projectName, setProjectName] = React.useState("")
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<Project | null>(null)
  const [deleteBucket, setDeleteBucket] = React.useState(false)
  const [deletingProject, setDeletingProject] = React.useState(false)
  const [createKeyOpen, setCreateKeyOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  const [keyPreset, setKeyPreset] = React.useState("Read only")
  const [creatingKey, setCreatingKey] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [editingKey, setEditingKey] = React.useState<ApiKey | null>(null)
  const [editPermissions, setEditPermissions] = React.useState<Permissions>(
    PRESETS["Read only"]
  )
  const [savingKey, setSavingKey] = React.useState(false)
  const [docsOpen, setDocsOpen] = React.useState(false)

  const loadProjects = React.useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/projects")
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to load projects"))
      const rows = Array.isArray(data.projects) ? (data.projects as Project[]) : []
      setProjects(rows)
      setSelectedProject((current) => {
        if (!current) return rows[0] ?? null
        return rows.find((project) => project.id === current.id) ?? rows[0] ?? null
      })
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load projects")
    } finally {
      setLoading(false)
    }
  }, [])

  const loadKeys = React.useCallback(async (project: Project | null) => {
    if (!project) {
      setKeys([])
      return
    }
    setKeysLoading(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/keys`)
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to load API keys"))
      setKeys(Array.isArray(data.keys) ? (data.keys as ApiKey[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load API keys")
      setKeys([])
    } finally {
      setKeysLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadProjects()
  }, [loadProjects])

  React.useEffect(() => {
    void loadKeys(selectedProject)
  }, [selectedProject, loadKeys])

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
      setProjectName("")
      setCreateOpen(false)
      toast.success("Project created")
      await loadProjects()
      if (data.project && typeof data.project === "object") {
        setSelectedProject(data.project as Project)
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to create project")
    } finally {
      setCreatingProject(false)
    }
  }

  const createKey = async () => {
    if (!selectedProject) return
    setCreatingKey(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(selectedProject.id)}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName || "API key",
          preset: keyPreset,
          permissions: PRESETS[keyPreset],
        }),
      })
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to create API key"))
      setKeyName("")
      setKeyPreset("Read only")
      setCreateKeyOpen(false)
      setSecret(typeof data.secret === "string" ? data.secret : null)
      toast.success("API key created")
      await loadKeys(selectedProject)
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to create API key")
    } finally {
      setCreatingKey(false)
    }
  }

  const saveKey = async () => {
    if (!selectedProject || !editingKey) return
    setSavingKey(true)
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/keys/${encodeURIComponent(editingKey.id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: editingKey.name,
            status: editingKey.status,
            permissions: editPermissions,
          }),
        }
      )
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to update API key"))
      setEditingKey(null)
      toast.success("API key updated")
      await loadKeys(selectedProject)
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update API key")
    } finally {
      setSavingKey(false)
    }
  }

  const removeKey = async (key: ApiKey) => {
    if (!selectedProject) return
    if (!window.confirm(`Delete API key "${key.name}" from this project?`)) return
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(selectedProject.id)}/keys/${encodeURIComponent(key.id)}`,
        { method: "DELETE" }
      )
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to delete API key"))
      toast.success("API key deleted")
      await loadKeys(selectedProject)
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete API key")
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
      toast.success(deleteBucket ? "Project and bucket deleted" : "Project deleted")
      await loadProjects()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete project")
    } finally {
      setDeletingProject(false)
    }
  }

  const openEditKey = (key: ApiKey) => {
    setEditingKey({ ...key })
    setEditPermissions(normalizePermissions(key.permissions))
  }

  const docsProjectId = selectedProject?.projectId ?? "prj_your_project_id"
  const docsApiKey = "drv_your_api_key"

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Projects"
        description="Create bucket-backed projects and issue scoped API keys for external apps."
        actions={
        <>
          <Button
            variant="outline"
            size="icon"
            aria-label="Open API documentation"
            title="API documentation"
            onClick={() => setDocsOpen(true)}
          >
            <BookOpen className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            loading={loading}
            onClick={() => void loadProjects()}
            disabled={loading}
          >
            {!loading ? <RefreshCw className="mr-2 h-4 w-4" /> : null}
            Refresh
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New project
          </Button>
        </>
        }
      />

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <DashboardPanel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Project ID</TableHead>
                <TableHead>Bucket</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-10 w-full" />
                    </TableCell>
                  </TableRow>
                ))
              ) : projects.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    No projects yet.
                  </TableCell>
                </TableRow>
              ) : (
                projects.map((project) => (
                  <TableRow
                    key={project.id}
                    className="cursor-pointer"
                    data-state={selectedProject?.id === project.id ? "selected" : undefined}
                    onClick={() => setSelectedProject(project)}
                  >
                    <TableCell>
                      <div className="font-medium">{project.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {project.createdAccountLabel || "Active account"} - {formatDate(project.createdAt)}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{project.projectId}</TableCell>
                    <TableCell className="font-mono text-xs">{project.bucketName}</TableCell>
                    <TableCell>
                      <Badge variant={project.status === "active" ? "default" : "secondary"}>
                        {project.status}
                      </Badge>
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setSelectedProject(project)}>
                            <Settings2 className="mr-2 h-4 w-4" />
                            Manage keys
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(project)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </DashboardPanel>

        <DashboardPanel className="p-4">
          {selectedProject ? (
            <div className="flex h-full flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-muted-foreground">Selected project</div>
                  <h2 className="truncate text-lg font-semibold">{selectedProject.name}</h2>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {selectedProject.projectId}
                  </div>
                </div>
                <Button size="sm" onClick={() => setCreateKeyOpen(true)}>
                  <KeyRound className="mr-2 h-4 w-4" />
                  New key
                </Button>
              </div>

              <div className="grid min-w-0 gap-2 rounded-2xl bg-muted/50 p-3 text-xs">
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Bucket</span>
                  <span className="truncate font-mono">{selectedProject.bucketName}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span className="text-muted-foreground">Public API</span>
                  <span className="min-w-0 truncate font-mono">/api/v1/files?projectId={selectedProject.projectId}</span>
                </div>
              </div>

              <div className="rounded-2xl border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last used</TableHead>
                      <TableHead className="w-20" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keysLoading ? (
                      Array.from({ length: 4 }).map((_, index) => (
                        <TableRow key={index}>
                          <TableCell colSpan={4}>
                            <Skeleton className="h-10 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : keys.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                          No API keys for this project.
                        </TableCell>
                      </TableRow>
                    ) : (
                      keys.map((key) => (
                        <TableRow key={key.id}>
                          <TableCell>
                            <div className="font-medium">{key.name}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {key.keyPrefix}...
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant={key.status === "active" ? "default" : "secondary"}>
                              {key.status}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {formatDate(key.lastUsedAt)}
                          </TableCell>
                          <TableCell>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={() => openEditKey(key)}>
                                  Edit access
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => void removeKey(key)}
                                >
                                  Delete
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              Select or create a project to manage API keys.
            </div>
          )}
        </DashboardPanel>
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>
              A new R2 bucket will be created from the current active account.
            </DialogDescription>
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

      <Dialog open={docsOpen} onOpenChange={setDocsOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Projects API documentation</DialogTitle>
            <DialogDescription>
              Use a project API key to manage files in the project bucket from another app.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 text-sm">
            <section className="space-y-3">
              <h3 className="font-semibold">Authentication</h3>
              <p className="text-muted-foreground">
                Send the API key in one of these headers. Send the project ID in
                the query string, JSON body, form data, or the project header.
              </p>
              <CodeExample>{`Authorization: Bearer ${docsApiKey}
X-Drive-API-Key: ${docsApiKey}
X-Drive-Project: ${docsProjectId}`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">List assigned projects</h3>
              <CodeExample>{`curl -X GET "/api/v1/projects" \\
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">List files and folders</h3>
              <CodeExample>{`curl -X GET "/api/v1/files?projectId=${docsProjectId}&prefix=uploads/&limit=100" \\
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Upload a file</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/upload" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -F "projectId=${docsProjectId}" \\
  -F "path=uploads/" \\
  -F "file=@./image.png"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Direct-to-R2 upload URL</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/uploads/presign" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/large-video.mp4",
    "contentType": "video/mp4",
    "expiresInSeconds": 900
  }'

# Then upload directly to the returned Cloudflare R2 signed URL.
curl -X PUT "<returned-url>" \\
  -H "Content-Type: video/mp4" \\
  --upload-file ./large-video.mp4`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Multipart upload</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/uploads/multipart" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/archive.zip",
    "contentType": "application/zip"
  }'

curl -X POST "/api/v1/files/uploads/multipart/part" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/archive.zip",
    "uploadId": "<upload-id>",
    "partNumber": 1
  }'

curl -X POST "/api/v1/files/uploads/multipart/complete" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/archive.zip",
    "uploadId": "<upload-id>",
    "parts": [{ "partNumber": 1, "etag": "<etag-from-r2>" }]
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Create or replace file content</h3>
              <CodeExample>{`curl -X PUT "/api/v1/files/content" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "notes/readme.txt",
    "content": "Hello from the API",
    "contentType": "text/plain"
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Download and metadata</h3>
              <CodeExample>{`curl -X GET "/api/v1/files/download?projectId=${docsProjectId}&key=uploads/image.png" \\
  -H "Authorization: Bearer ${docsApiKey}"

curl -X GET "/api/v1/files/metadata?projectId=${docsProjectId}&key=uploads/image.png" \\
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Rename and delete</h3>
              <CodeExample>{`curl -X PATCH "/api/v1/files/rename" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "fromKey": "uploads/old.png",
    "toKey": "uploads/new.png"
  }'

curl -X DELETE "/api/v1/files" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/new.png"
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Batch and prefix jobs</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/batch" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Idempotency-Key: move-001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "operation": "move",
    "items": [{ "fromKey": "old/a.png", "toKey": "new/a.png" }]
  }'

curl -X PATCH "/api/v1/files/rename" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Idempotency-Key: prefix-rename-001" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "fromPrefix": "old/",
    "toPrefix": "new/"
  }'

curl -X GET "/api/v1/jobs/<job-id>" \\
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Folders and recursive delete</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/folders" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/images"
  }'

curl -X DELETE "/api/v1/files" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/images/",
    "recursive": true
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Inventory search</h3>
              <CodeExample>{`curl -X POST "/api/v1/inventory/sync" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{ "projectId": "${docsProjectId}", "prefix": "uploads/" }'

curl -X GET "/api/v1/files/search?projectId=${docsProjectId}&q=invoice&limit=50" \\
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">File locks</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/locks" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/image.png",
    "lockToken": "client-generated-secret",
    "reason": "editing"
  }'

curl -X DELETE "/api/v1/files/locks" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/image.png",
    "lockToken": "client-generated-secret"
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Generate links</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/links" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/image.png",
    "mode": "expiring",
    "expiresInSeconds": 900
  }'

curl -X POST "/api/v1/files/links" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "key": "uploads/image.png",
    "mode": "permanent"
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Revoke a permanent link</h3>
              <CodeExample>{`curl -X PATCH "/api/v1/files/links/link_id_here" \\
  -H "Authorization: Bearer ${docsApiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "projectId": "${docsProjectId}",
    "action": "revoke"
  }'`}</CodeExample>
            </section>
          </div>

          <DialogFooter>
            <Button onClick={() => setDocsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createKeyOpen} onOpenChange={setCreateKeyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              The secret will be shown once. Store it before closing the next dialog.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="Production app"
              />
            </div>
            <div className="space-y-2">
              <Label>Preset</Label>
              <Select value={keyPreset} onValueChange={setKeyPreset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(PRESETS).map((preset) => (
                    <SelectItem key={preset} value={preset}>
                      {preset}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateKeyOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={createKey}
              loading={creatingKey}
              disabled={!selectedProject}
            >
              Generate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key generated</DialogTitle>
            <DialogDescription>
              This value is stored as a hash and cannot be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 font-mono text-xs break-all">
            {secret}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!secret) return
                await navigator.clipboard.writeText(secret)
                toast.success("API key copied")
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit API key access</DialogTitle>
            <DialogDescription>
              Permissions apply only to this project assignment.
            </DialogDescription>
          </DialogHeader>
          {editingKey && (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <div className="space-y-2">
                  <Label htmlFor="edit-key-name">Name</Label>
                  <Input
                    id="edit-key-name"
                    value={editingKey.name}
                    onChange={(event) =>
                      setEditingKey((current) =>
                        current ? { ...current, name: event.target.value } : current
                      )
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={editingKey.status}
                    onValueChange={(value) =>
                      setEditingKey((current) =>
                        current
                          ? { ...current, status: value === "disabled" ? "disabled" : "active" }
                          : current
                      )
                    }
                  >
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
              <div className="grid gap-3 sm:grid-cols-2">
                {PERMISSION_KEYS.map((permission) => (
                  <div
                    key={permission}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <Label htmlFor={`perm-${permission}`} className="text-sm">
                      {permissionLabels[permission]}
                    </Label>
                    <Switch
                      id={`perm-${permission}`}
                      checked={editPermissions[permission]}
                      onCheckedChange={(checked) =>
                        setEditPermissions((current) => ({
                          ...current,
                          [permission]: checked,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingKey(null)}>
              Cancel
            </Button>
            <Button onClick={saveKey} loading={savingKey}>
              Save access
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription>
              Choose what should happen to the R2 bucket before deleting the project record.
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/50 p-3 text-sm">
                <div className="font-medium">{deleteTarget.name}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {deleteTarget.bucketName}
                </div>
              </div>
              <button
                type="button"
                className={`w-full rounded-md border p-3 text-left text-sm ${
                  !deleteBucket ? "border-primary bg-primary/5" : ""
                }`}
                onClick={() => setDeleteBucket(false)}
              >
                Keep bucket and only remove the project, keys, and links.
              </button>
              <button
                type="button"
                className={`w-full rounded-md border p-3 text-left text-sm ${
                  deleteBucket ? "border-destructive bg-destructive/5" : ""
                }`}
                onClick={() => setDeleteBucket(true)}
              >
                Delete the R2 bucket and all objects from the active account.
              </button>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={deleteProject}
              loading={deletingProject}
            >
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}

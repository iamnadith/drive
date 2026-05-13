"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, BookOpen, Copy, MoreHorizontal, Plus, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
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
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/page-shell"

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
  return Object.fromEntries(PERMISSION_KEYS.map((key) => [key, input[key] === true])) as Permissions
}

async function readJson(res: Response) {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

function CodeExample({ children }: { children: string }) {
  return (
    <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-2xl border bg-muted p-3 text-xs leading-relaxed">
      <code>{children}</code>
    </pre>
  )
}

export default function ProjectKeysPage() {
  const params = useParams<{ id: string }>()
  const projectId = params?.id ?? ""

  const [project, setProject] = React.useState<Project | null>(null)
  const [keys, setKeys] = React.useState<ApiKey[]>([])
  const [loading, setLoading] = React.useState(true)
  const [createKeyOpen, setCreateKeyOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  const [keyPreset, setKeyPreset] = React.useState("Read only")
  const [creatingKey, setCreatingKey] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [editingKey, setEditingKey] = React.useState<ApiKey | null>(null)
  const [editPermissions, setEditPermissions] = React.useState<Permissions>(PRESETS["Read only"])
  const [savingKey, setSavingKey] = React.useState(false)
  const [docsOpen, setDocsOpen] = React.useState(false)

  const loadAll = React.useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const [projectRes, keysRes] = await Promise.all([
        fetch(`/api/projects/${encodeURIComponent(projectId)}`),
        fetch(`/api/projects/${encodeURIComponent(projectId)}/keys`),
      ])

      const [projectData, keysData] = await Promise.all([readJson(projectRes), readJson(keysRes)])
      if (!projectRes.ok) throw new Error(String(projectData.error ?? "Unable to load project"))
      if (!keysRes.ok) throw new Error(String(keysData.error ?? "Unable to load API keys"))

      setProject((projectData.project as Project) ?? null)
      setKeys(Array.isArray(keysData.keys) ? (keysData.keys as ApiKey[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load project access")
      setProject(null)
      setKeys([])
    } finally {
      setLoading(false)
    }
  }, [projectId])

  React.useEffect(() => {
    void loadAll()
  }, [loadAll])

  const createKey = async () => {
    if (!project) return
    setCreatingKey(true)
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/keys`, {
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
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to create API key")
    } finally {
      setCreatingKey(false)
    }
  }

  const saveKey = async () => {
    if (!project || !editingKey) return
    setSavingKey(true)
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/keys/${encodeURIComponent(editingKey.id)}`,
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
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to update API key")
    } finally {
      setSavingKey(false)
    }
  }

  const removeKey = async (key: ApiKey) => {
    if (!project) return
    if (!window.confirm(`Delete API key "${key.name}" from this project?`)) return
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/keys/${encodeURIComponent(key.id)}`,
        { method: "DELETE" }
      )
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to delete API key"))
      toast.success("API key deleted")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete API key")
    }
  }

  const openEditKey = (key: ApiKey) => {
    setEditingKey({ ...key })
    setEditPermissions(normalizePermissions(key.permissions))
  }

  const docsProjectId = project?.projectId ?? "your_project_id"
  const docsApiKey = "your_api_key"

  return (
    <DashboardPage>
      <DashboardPageHeader
        title={project ? `${project.name} API keys` : "Project API keys"}
        description="Project-scoped API keys."
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
                <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/buckets`}>
                  Buckets
                </Link>
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setDocsOpen(true)}>
              <BookOpen className="mr-2 h-4 w-4" />
              API docs
            </Button>
            <Button variant="outline" loading={loading} onClick={() => void loadAll()}>
              {!loading ? <RefreshCw className="mr-2 h-4 w-4" /> : null}
              Refresh
            </Button>
          </>
        }
      />

      <Card className="border-border/60 shadow-sm">
        <CardContent className="grid gap-2 p-3 md:grid-cols-3">
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Project ID</div>
            <div className="mt-1 font-mono text-xs">{project?.projectId ?? "-"}</div>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Primary bucket</div>
            <div className="mt-1 font-mono text-xs">{project?.bucketName || "No primary bucket"}</div>
          </div>
          <div className="rounded-lg border border-border/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Status</div>
            <div className="mt-1 flex items-center gap-2">
              {project ? <Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge> : "-"}
              <span className="text-xs text-muted-foreground">{formatDate(project?.createdAt)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold">Issued keys</div>
            <div className="text-sm text-muted-foreground">Create, disable, or edit keys.</div>
          </div>
          <Button size="sm" onClick={() => setCreateKeyOpen(true)} disabled={!project}>
            <Plus className="mr-2 h-4 w-4" />
            New key
          </Button>
        </div>

        <div className="space-y-2">
          {loading ? (
            Array.from({ length: 5 }).map((_, index) => <Skeleton key={index} className="h-16 w-full rounded-xl" />)
          ) : keys.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              No API keys for this project.
            </div>
          ) : (
            keys.map((key) => (
              <div key={key.id} className="rounded-xl border border-border/60 bg-background px-3 py-2.5">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                  <div className="grid flex-1 gap-2 md:grid-cols-[minmax(0,1.35fr)_130px_150px_150px] md:items-center">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{key.name}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{key.keyPrefix}...</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Status</div>
                      <div className="mt-1">
                        <Badge variant={key.status === "active" ? "default" : "secondary"}>{key.status}</Badge>
                      </div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Last used</div>
                      <div className="mt-1 text-muted-foreground">{formatDate(key.lastUsedAt)}</div>
                    </div>
                    <div className="text-xs">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">Created</div>
                      <div className="mt-1 text-muted-foreground">{formatDate(key.createdAt)}</div>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="rounded-full">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEditKey(key)}>Edit access</DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onClick={() => void removeKey(key)}
                        >
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
      </div>

      <Dialog open={createKeyOpen} onOpenChange={setCreateKeyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>The secret is shown once. Save it before closing the confirmation dialog.</DialogDescription>
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
            <Button onClick={createKey} loading={creatingKey} disabled={!project}>
              Generate key
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!secret} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key generated</DialogTitle>
            <DialogDescription>This value is stored as a hash and cannot be shown again.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3 font-mono text-xs break-all">{secret}</div>
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
            <DialogDescription>Permissions apply only to this project assignment.</DialogDescription>
          </DialogHeader>
          {editingKey ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
                <div className="space-y-2">
                  <Label htmlFor="edit-key-name">Name</Label>
                  <Input
                    id="edit-key-name"
                    value={editingKey.name}
                    onChange={(event) =>
                      setEditingKey((current) => (current ? { ...current, name: event.target.value } : current))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={editingKey.status}
                    onValueChange={(value) =>
                      setEditingKey((current) =>
                        current ? { ...current, status: value === "disabled" ? "disabled" : "active" } : current
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
                  <div key={permission} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
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
          ) : null}
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

      <Dialog open={docsOpen} onOpenChange={setDocsOpen}>
        <DialogContent className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-x-hidden overflow-y-hidden sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Projects API documentation</DialogTitle>
            <DialogDescription>Use a project API key to manage files in the project&apos;s primary bucket from another app.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-x-hidden overflow-y-auto pr-1">
            <div className="grid gap-6 text-sm">
            <section className="space-y-3">
              <h3 className="font-semibold">Authentication</h3>
              <p className="text-muted-foreground">
                Send the API key in the authorization header and target the project with its project ID. If the project has multiple assigned buckets, send `bucket` in the query string or `X-Drive-Bucket` to target a non-primary bucket.
              </p>
              <CodeExample>{`Authorization: Bearer ${docsApiKey}
X-Drive-API-Key: ${docsApiKey}
X-Drive-Project: ${docsProjectId}
X-Drive-Bucket: uploads-archive`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">List files</h3>
              <CodeExample>{`curl -X GET "/api/v1/files?projectId=${docsProjectId}&bucket=uploads-archive&prefix=uploads/&limit=100" \
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Upload a file</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/upload" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/large-video.mp4",
    "contentType": "video/mp4"
  }'`}</CodeExample>
              <CodeExample>{`curl -X PATCH "/api/v1/files/upload" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/large-video.mp4"
  }'`}</CodeExample>
            </section>

            <section className="space-y-3">
              <h3 className="font-semibold">Generate links</h3>
              <CodeExample>{`curl -X POST "/api/v1/files/links" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/image.png",
    "mode": "expiring",
    "expiresInSeconds": 900
  }'`}</CodeExample>
            </section>
            </div>
          </div>

          <DialogFooter>
            <Button onClick={() => setDocsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}

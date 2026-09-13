"use client"

import * as React from "react"
import type { ColumnDef } from "@tanstack/react-table"
import Link from "next/link"
import { useParams } from "next/navigation"
import { ArrowLeft, BookOpen, Copy, FolderPlus, MoreHorizontal, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react"
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
import { Switch } from "@/components/ui/switch"
import { DashboardPage, DashboardPageHeader } from "@/components/dashboard/page-shell"
import { formatLastSyncedAt } from "@/lib/dashboard-format"
import { DashboardDataTable } from "@/components/dashboard/data-table"

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
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string | null>(null)
  const [createKeyOpen, setCreateKeyOpen] = React.useState(false)
  const [keyName, setKeyName] = React.useState("")
  const [keyPreset, setKeyPreset] = React.useState("Read only")
  const [creatingKey, setCreatingKey] = React.useState(false)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [editingKey, setEditingKey] = React.useState<ApiKey | null>(null)
  const [editPermissions, setEditPermissions] = React.useState<Permissions>(PRESETS["Read only"])
  const [savingKey, setSavingKey] = React.useState(false)
  const [docsOpen, setDocsOpen] = React.useState(false)
  const [deleteKey, setDeleteKey] = React.useState<ApiKey | null>(null)
  const [deletingKey, setDeletingKey] = React.useState(false)

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
      setLastSyncedAt(new Date().toISOString())
      setKeys(Array.isArray(keysData.keys) ? (keysData.keys as ApiKey[]) : [])
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to load project access")
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
    setDeletingKey(true)
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project.id)}/keys/${encodeURIComponent(key.id)}`,
        { method: "DELETE" }
      )
      const data = await readJson(res)
      if (!res.ok) throw new Error(String(data.error ?? "Unable to delete API key"))
      setDeleteKey(null)
      toast.success("API key deleted")
      await loadAll()
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to delete API key")
    } finally {
      setDeletingKey(false)
    }
  }

  const openEditKey = (key: ApiKey) => {
    setEditingKey({ ...key })
    setEditPermissions(normalizePermissions(key.permissions))
  }

  const keyColumns: ColumnDef<ApiKey, unknown>[] = [
    {
      accessorKey: "name",
      header: "API key",
      meta: { width: "min-w-[250px]" },
      cell: ({ row }) => (
        <div className="max-w-[280px] min-w-0">
          <div className="truncate font-medium">{row.original.name}</div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{row.original.keyPrefix}********</div>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      meta: { width: "min-w-[120px]", align: "center" },
      cell: ({ row }) => <Badge variant={row.original.status === "active" ? "default" : "secondary"}>{row.original.status}</Badge>,
    },
    {
      accessorKey: "lastUsedAt",
      header: "Last used",
      meta: { width: "min-w-[190px]" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.lastUsedAt)}</span>,
    },
    {
      accessorKey: "createdAt",
      header: "Created",
      meta: { width: "min-w-[190px]" },
      cell: ({ row }) => <span className="text-xs text-muted-foreground">{formatDate(row.original.createdAt)}</span>,
    },
    {
      id: "actions",
      header: "Actions",
      meta: { width: "min-w-[100px]", align: "right", divider: false },
      cell: ({ row }) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`Actions for ${row.original.name}`}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={() => openEditKey(row.original)}><Settings2 /> Edit access</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => setDeleteKey(row.original)}><Trash2 /> Delete</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]

  const docsProjectId = project?.projectId ?? "your_project_id"
  const docsApiKey = "your_api_key"

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <DashboardPageHeader
          title={project ? `${project.name} / API keys` : "Project API keys"}
          description={formatLastSyncedAt(lastSyncedAt)}
          actions={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:flex-wrap sm:justify-end">
              <Button variant="outline" size="icon" className="size-9 rounded-full" asChild>
                <Link href="/dashboard/projects" aria-label="Back to projects"><ArrowLeft /></Link>
              </Button>
              {project ? (
                <Button variant="outline" className="min-w-0 flex-1 sm:flex-none" asChild>
                  <Link href={`/dashboard/projects/${encodeURIComponent(project.id)}/buckets`}><FolderPlus data-icon="inline-start" /> Buckets</Link>
                </Button>
              ) : null}
              <Button variant="outline" size="icon" className="size-9 rounded-full" onClick={() => setDocsOpen(true)} aria-label="Open API documentation"><BookOpen /></Button>
              <Button variant="outline" size="icon" className="size-9 rounded-full" loading={loading} onClick={() => void loadAll()} aria-label="Refresh API keys"><RefreshCw /></Button>
              <Button size="icon" className="size-9 min-w-9 rounded-full sm:h-9 sm:w-auto sm:min-w-0 sm:px-3" onClick={() => setCreateKeyOpen(true)} disabled={!project}>
                <Plus data-icon="inline-start" /><span className="sr-only sm:not-sr-only">New key</span>
              </Button>
            </div>
          }
        >
          {project ? <div className="mt-2 flex flex-wrap items-center gap-2"><Badge variant={project.status === "active" ? "default" : "secondary"}>{project.status}</Badge><span className="font-mono text-xs text-muted-foreground">{project.bucketName || "No primary bucket"}</span></div> : null}
        </DashboardPageHeader>
      </div>

      <DashboardDataTable
        data={keys}
        columns={keyColumns}
        minWidth="860px"
        pageSize={10}
        loading={loading && keys.length === 0}
        emptyState="No API keys have been issued for this project."
        className="dashboard-motion-delay-2"
        footer={<>{keys.length} key{keys.length === 1 ? "" : "s"} / secrets are shown only once</>}
      />

      <Dialog open={createKeyOpen} onOpenChange={setCreateKeyOpen}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>The secret is shown once. Save it before closing the confirmation dialog.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 rounded-lg border bg-muted/40 p-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={keyName}
                onChange={(event) => setKeyName(event.target.value)}
                placeholder="Production app"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Preset</Label>
              <Select value={keyPreset} onValueChange={setKeyPreset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {Object.keys(PRESETS).map((preset) => (
                      <SelectItem key={preset} value={preset}>{preset}</SelectItem>
                    ))}
                  </SelectGroup>
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
        <DialogContent className="rounded-2xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>API key generated</DialogTitle>
            <DialogDescription>This value is stored as a hash and cannot be shown again.</DialogDescription>
          </DialogHeader>
          <div className="break-all rounded-lg border bg-muted/40 p-4 font-mono text-xs leading-relaxed">{secret}</div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={async () => {
                if (!secret) return
                try {
                  await navigator.clipboard.writeText(secret)
                  toast.success("API key copied")
                } catch {
                  toast.error("Clipboard access was denied. Copy the key manually.")
                }
              }}
            >
              <Copy data-icon="inline-start" />
              Copy
            </Button>
            <Button onClick={() => setSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingKey} onOpenChange={(open) => !open && setEditingKey(null)}>
        <DialogContent className="max-h-[88vh] flex flex-col rounded-2xl sm:max-h-[94vh] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit API key access</DialogTitle>
            <DialogDescription>Permissions apply only to this project assignment.</DialogDescription>
          </DialogHeader>
          {editingKey ? (
            <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 sm:grid-cols-[1fr_160px]">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="edit-key-name">Name</Label>
                  <Input
                    id="edit-key-name"
                    value={editingKey.name}
                    onChange={(event) =>
                      setEditingKey((current) => (current ? { ...current, name: event.target.value } : current))
                    }
                  />
                </div>
                <div className="flex flex-col gap-2">
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
                      <SelectGroup>
                        <SelectItem value="active">Active</SelectItem>
                        <SelectItem value="disabled">Disabled</SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 sm:grid-cols-2">
                {PERMISSION_KEYS.map((permission) => (
                  <div key={permission} className="flex items-center justify-between gap-3 rounded-lg border bg-background/60 px-3 py-2">
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

      <Dialog open={!!deleteKey} onOpenChange={(open) => !open && setDeleteKey(null)}>
        <DialogContent className="rounded-2xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete API key</DialogTitle>
            <DialogDescription>This permanently revokes the key. Applications using it will lose access immediately.</DialogDescription>
          </DialogHeader>
          {deleteKey ? <div className="rounded-lg border bg-muted/40 p-4"><div className="font-medium">{deleteKey.name}</div><div className="mt-1 font-mono text-xs text-muted-foreground">{deleteKey.keyPrefix}********</div></div> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteKey(null)} disabled={deletingKey}>Cancel</Button>
            <Button variant="destructive" loading={deletingKey} onClick={() => deleteKey ? void removeKey(deleteKey) : undefined}>Delete key</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={docsOpen} onOpenChange={setDocsOpen}>
        <DialogContent className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-x-hidden overflow-y-hidden rounded-2xl sm:max-h-[94vh] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Projects API documentation</DialogTitle>
            <DialogDescription>Use a project API key to manage files in the project&apos;s primary bucket from another app.</DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-x-hidden overflow-y-auto pr-1">
            <div className="grid gap-6 text-sm">
            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Core model</h3>
              <p className="text-muted-foreground">
                Every tracked object now gets a permanent `fileId`. Use `fileId` for stable references across renames,
                bucket remaps, and long-lived application records. Keep using `key` when you want path-level control.
              </p>
              <CodeExample>{`{
  "fileId": "8a3f2f01e7e29c0b0b0f5d7a",
  "key": "uploads/large-video.mp4",
  "bucketName": "uploads-archive"
}`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Authentication</h3>
              <p className="text-muted-foreground">
                Send the API key in the authorization header and target the project with its project ID. If the project has multiple assigned buckets, send `bucket` in the query string or `X-Drive-Bucket` to target a non-primary bucket.
              </p>
              <CodeExample>{`Authorization: Bearer ${docsApiKey}
X-Drive-API-Key: ${docsApiKey}
X-Drive-Project: ${docsProjectId}
X-Drive-Bucket: uploads-archive`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">List files</h3>
              <CodeExample>{`curl -X GET "/api/v1/files?projectId=${docsProjectId}&bucket=uploads-archive&prefix=uploads/&limit=100" \
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
              <p className="text-muted-foreground">
                `GET /api/v1/files` and `GET /api/v1/files/search` return `fileId` when the object is already tracked.
              </p>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Single upload flow</h3>
              <p className="text-muted-foreground">
                Uploads are direct-to-R2. First request a signed upload URL, then upload bytes directly to R2, then call
                `PATCH /api/v1/files/upload` to finalize tracking and receive the permanent `fileId`.
              </p>
              <CodeExample>{`curl -X POST "/api/v1/files/upload" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/large-video.mp4",
    "contentType": "video/mp4"
  }'`}</CodeExample>
              <CodeExample>{`{
  "uploadType": "single",
  "method": "PUT",
  "url": "https://...signed-r2-url...",
  "key": "uploads/large-video.mp4",
  "bucketName": "uploads-archive",
  "headers": {
    "Content-Type": "video/mp4"
  }
}`}</CodeExample>
              <CodeExample>{`curl -X PUT "https://...signed-r2-url..." \
  -H "Content-Type: video/mp4" \
  --data-binary "@large-video.mp4"`}</CodeExample>
              <CodeExample>{`curl -X PATCH "/api/v1/files/upload" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/large-video.mp4"
  }'`}</CodeExample>
              <CodeExample>{`{
  "ok": true,
  "bucketName": "uploads-archive",
  "key": "uploads/large-video.mp4",
  "fileId": "8a3f2f01e7e29c0b0b0f5d7a"
}`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Multipart upload flow</h3>
              <p className="text-muted-foreground">
                Use multipart for large files. Start the multipart upload, upload parts directly to R2, then complete the
                multipart session to finalize tracking and get the permanent `fileId`.
              </p>
              <p className="text-muted-foreground">
                Bucket CORS must expose the `ETag` response header for browser multipart uploads. Without that, part uploads
                can succeed in R2 but the browser cannot complete the multipart session.
              </p>
              <CodeExample>{`curl -X POST "/api/v1/files/uploads/multipart" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/feature-film.mp4",
    "contentType": "video/mp4"
  }'`}</CodeExample>
              <CodeExample>{`{
  "uploadType": "multipart",
  "key": "uploads/feature-film.mp4",
  "bucketName": "uploads-archive",
  "uploadId": "..."
}`}</CodeExample>
              <CodeExample>{`curl -X POST "/api/v1/files/uploads/multipart/complete" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "bucket": "uploads-archive",
    "key": "uploads/feature-film.mp4",
    "uploadId": "...",
    "parts": [
      { "partNumber": 1, "etag": "..." },
      { "partNumber": 2, "etag": "..." }
    ]
  }'`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Read or download by fileId</h3>
              <p className="text-muted-foreground">
                Prefer `fileId` for app records. Drive resolves the current bucket and key internally, then issues a short-lived direct R2 download URL.
              </p>
              <CodeExample>{`curl -X GET "/api/v1/files/download?projectId=${docsProjectId}&fileId=8a3f2f01e7e29c0b0b0f5d7a" \
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
              <CodeExample>{`curl -X GET "/api/v1/files/read?projectId=${docsProjectId}&fileId=8a3f2f01e7e29c0b0b0f5d7a" \
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Metadata and writes by fileId</h3>
              <CodeExample>{`curl -X GET "/api/v1/files/metadata?projectId=${docsProjectId}&fileId=8a3f2f01e7e29c0b0b0f5d7a" \
  -H "Authorization: Bearer ${docsApiKey}"`}</CodeExample>
              <CodeExample>{`curl -X PUT "/api/v1/files/content" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "fileId": "8a3f2f01e7e29c0b0b0f5d7a",
    "content": "updated text payload",
    "contentType": "text/plain; charset=utf-8"
  }'`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Rename and delete by fileId</h3>
              <p className="text-muted-foreground">
                Renames preserve the same `fileId`. Deletes mark that tracked file as deleted, so later access by the same `fileId` returns not found.
              </p>
              <CodeExample>{`curl -X PATCH "/api/v1/files/rename" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "fileId": "8a3f2f01e7e29c0b0b0f5d7a",
    "toKey": "uploads/final-video.mp4"
  }'`}</CodeExample>
              <CodeExample>{`curl -X DELETE "/api/v1/files" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "fileId": "8a3f2f01e7e29c0b0b0f5d7a"
  }'`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Generate links</h3>
              <p className="text-muted-foreground">
                Permanent links now store the tracked `fileId` when available, so they keep resolving after renames.
              </p>
              <CodeExample>{`curl -X POST "/api/v1/files/links" \
  -H "Authorization: Bearer ${docsApiKey}" \
  -H "Content-Type: application/json" \
  -d '{
    "projectId": "${docsProjectId}",
    "fileId": "8a3f2f01e7e29c0b0b0f5d7a",
    "mode": "expiring",
    "expiresInSeconds": 900
  }'`}</CodeExample>
            </section>

            <section className="flex flex-col gap-3">
              <h3 className="font-semibold">Behavior guarantees</h3>
              <CodeExample>{`- fileId is permanent for the tracked object
- rename keeps the same fileId
- direct uploads only become fully tracked after finalize/complete
- permanent links follow fileId-backed renames
- deleted files stop resolving by fileId
- direct file bytes still flow between client and R2, not through this host`}</CodeExample>
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

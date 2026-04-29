"use client"

import * as React from "react"
import {
  Folder,
  File,
  Copy,
  Download,
  ExternalLink,
  Filter,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Upload,
  Search,
  Grid2X2,
  List as ListIcon,
  HardDrive,
  ChevronRight,
  Home,
  ArrowLeft,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { Progress } from "@/components/ui/progress"
import { StoragePageSkeleton } from "@/components/dashboard/loading-skeletons"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

type ActiveAccount = {
  id: string
  label: string
  email: string
  status: "active" | "available" | "disabled"
}

type Drive = {
  id: string
  name: string
  usedBytes: number
  objects: number
  statsStatus?: string
}

type FileItem = {
  id: string
  key: string
  name: string
  type: "folder" | "file"
  fileType?: string
  size?: string
  modified: string
}

type RawObject = {
  id: string
  key: string
  size: number
  contentType?: string
  uploaded?: string
}

type ObjectsResponse = {
  prefix?: string
  folders?: string[]
  objects?: Array<{ id?: string; key?: string; name?: string; size?: number; uploaded?: string }>
  nextContinuationToken?: string | null
  isTruncated?: boolean
}

type PropertiesTarget =
  | { type: "drive"; drive: Drive }
  | { type: "item"; item: FileItem }
  | { type: "path"; path: string[] }

type PreviewTarget = {
  item: FileItem
  url?: string
  loading: boolean
  error?: string
}

type KindFilter = "all" | "folder" | "image" | "video" | "audio" | "pdf" | "document" | "other"
type SortMode = "name-asc" | "name-desc" | "type" | "modified-desc" | "size-desc"

type AccountRecord = {
  id?: unknown
  label?: unknown
  email?: unknown
  status?: unknown
}

type BucketRecord = {
  id?: unknown
  name?: unknown
  bytes?: unknown
  objects?: unknown
  statsStatus?: unknown
}

function formatBytes(value: number | undefined): string {
  if (!value || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

function accountStatus(value: unknown): ActiveAccount["status"] {
  return value === "active" || value === "available" || value === "disabled"
    ? value
    : "available"
}

function fileKind(item: FileItem) {
  const ext = item.name.split(".").pop()?.toLowerCase() ?? ""
  if (["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"].includes(ext)) return "image"
  if (["mp4", "webm", "mov", "m4v", "avi", "mkv"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio"
  if (ext === "pdf") return "pdf"
  if (["doc", "docx", "odt", "rtf", "xls", "xlsx", "ppt", "pptx", "csv"].includes(ext)) return "document"
  if (["txt", "md", "json", "js", "jsx", "ts", "tsx", "css", "html", "xml", "sql", "yml", "yaml"].includes(ext)) return "text"
  return "file"
}

function fileTypeLabel(item: FileItem) {
  if (item.type === "folder") return "Folder"
  const kind = fileKind(item)
  if (kind === "image") return "Image"
  if (kind === "video") return "Video"
  if (kind === "audio") return "Audio"
  if (kind === "pdf") return "PDF"
  if (kind === "document") return "Document"
  if (kind === "text") return "Text / code"
  return "File"
}

function itemSizeBytes(item: FileItem) {
  const size = item.size ?? ""
  const match = /^([\d.]+)\s+(B|KB|MB|GB|TB|PB)$/.exec(size)
  if (!match) return 0
  const value = Number(match[1])
  const unit = ["B", "KB", "MB", "GB", "TB", "PB"].indexOf(match[2])
  return Number.isFinite(value) && unit >= 0 ? value * 1024 ** unit : 0
}

function itemModifiedMs(item: FileItem) {
  const time = item.modified ? Date.parse(item.modified) : 0
  return Number.isFinite(time) ? time : 0
}

function matchesKindFilter(item: FileItem, filter: KindFilter) {
  if (filter === "all") return true
  if (filter === "folder") return item.type === "folder"
  if (filter === "other") return item.type === "file" && ["file", "text"].includes(fileKind(item))
  return item.type === "file" && fileKind(item) === filter
}

function buildItemsFromListing(input: {
  prefix: string
  folders: string[]
  objects: RawObject[]
}): FileItem[] {
  const folderItems = input.folders
    .map((fullPrefix) => {
      const rest = fullPrefix.startsWith(input.prefix)
        ? fullPrefix.slice(input.prefix.length)
        : fullPrefix
      const name = rest.replace(/\/+$/, "")
      return {
        id: `folder:${fullPrefix}`,
        key: fullPrefix,
        name,
        type: "folder" as const,
        fileType: "Folder",
        size: undefined,
        modified: "",
      }
    })
    .filter((f) => f.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name))

  const fileItems = input.objects
    .map((obj) => {
      const rest = obj.key.startsWith(input.prefix)
        ? obj.key.slice(input.prefix.length)
        : obj.key
      return {
        id: obj.id,
        key: obj.key,
        name: rest,
        type: "file" as const,
        fileType: obj.contentType ?? "application/octet-stream",
        size: formatBytes(obj.size),
        modified: obj.uploaded ? new Date(obj.uploaded).toLocaleString() : "",
      }
    })
    .filter((f) => f.name.length > 0 && !f.name.includes("/"))
    .sort((a, b) => a.name.localeCompare(b.name))

  return [...folderItems, ...fileItems]
}

export default function StoragePage() {
  const [view, setView] = React.useState<"list" | "grid">("list")
  const [currentPath, setCurrentPath] = React.useState<string[]>([])
  const [activeAccount, setActiveAccount] = React.useState<ActiveAccount | null>(
    null
  )
  const [drives, setDrives] = React.useState<Drive[]>([])
  const [drivesLoading, setDrivesLoading] = React.useState(true)
  const [totalUsedBytes, setTotalUsedBytes] = React.useState(0)
  const [, setBucketObjects] = React.useState<RawObject[]>([])
  const [objects, setObjects] = React.useState<FileItem[]>([])
  const [objectsLoading, setObjectsLoading] = React.useState(false)
  const [nextContinuationToken, setNextContinuationToken] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")
  const [kindFilter, setKindFilter] = React.useState<KindFilter>("all")
  const [sortMode, setSortMode] = React.useState<SortMode>("name-asc")
  const [pageSize, setPageSize] = React.useState("50")
  const [currentPage, setCurrentPage] = React.useState(1)
  const [selectedDrives, setSelectedDrives] = React.useState<string[]>([])
  const [selectedItems, setSelectedItems] = React.useState<string[]>([])
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const loadRequestIdRef = React.useRef(0)
  const videoRef = React.useRef<HTMLVideoElement | null>(null)
  const [videoPlaying, setVideoPlaying] = React.useState(false)
  const [propertiesTarget, setPropertiesTarget] =
    React.useState<PropertiesTarget | null>(null)
  const [previewTarget, setPreviewTarget] = React.useState<PreviewTarget | null>(null)
  const [createBucketOpen, setCreateBucketOpen] = React.useState(false)
  const [newBucketName, setNewBucketName] = React.useState("")
  const [newBucketError, setNewBucketError] = React.useState<string | null>(null)
  const [creatingBucket, setCreatingBucket] = React.useState(false)

  const openCreateBucket = () => {
    setNewBucketName("")
    setNewBucketError(null)
    setCreateBucketOpen(true)
  }

  const loadActiveAndBuckets = React.useCallback(async () => {
    setDrivesLoading(true)
    try {
      const [accountsRes, bucketsRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/storage/buckets"),
      ])

      if (accountsRes.ok) {
        const data = (await accountsRes.json()) as { accounts?: AccountRecord[] }
        const accounts = Array.isArray(data.accounts) ? data.accounts : []
        const active = accounts.find((a) => a.status === "active")
        if (active) {
          setActiveAccount({
            id: String(active.id ?? ""),
            label: String(active.label ?? ""),
            email: String(active.email ?? ""),
            status: accountStatus(active.status),
          })
        } else {
          setActiveAccount(null)
        }
      }

      if (bucketsRes.ok) {
        const data = (await bucketsRes.json()) as {
          buckets?: BucketRecord[]
          totalBytes?: unknown
        }
        const buckets = Array.isArray(data.buckets) ? data.buckets : []
        const totalBytes = typeof data.totalBytes === "number" ? data.totalBytes : 0
        setTotalUsedBytes(totalBytes)
        setDrives(
          buckets.map((b) => ({
            id: String(b.id ?? b.name),
            name: String(b.name ?? "Bucket"),
            usedBytes: typeof b.bytes === "number" ? b.bytes : 0,
            objects: typeof b.objects === "number" ? b.objects : 0,
            statsStatus: typeof b.statsStatus === "string" ? b.statsStatus : undefined,
          }))
        )
      } else {
        setDrives([])
        setTotalUsedBytes(0)
      }
    } catch {
      setDrives([])
      setTotalUsedBytes(0)
    } finally {
      setDrivesLoading(false)
    }
  }, [])

  React.useEffect(() => {
    loadActiveAndBuckets()
  }, [loadActiveAndBuckets])

  const needsStatsSync = React.useMemo(() => {
    if (!activeAccount?.id) return false
    return drives.some((d) => d.statsStatus && d.statsStatus !== "completed")
  }, [activeAccount?.id, drives])

  React.useEffect(() => {
    if (!needsStatsSync) return
    let stopped = false

    const tick = async () => {
      if (stopped) return
      try {
        await fetch("/api/storage/buckets/stats/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ maxKeysTotal: 5_000 }),
        })
      } catch {
        // ignore
      }
      if (!stopped) await loadActiveAndBuckets()
    }

    void tick()
    const interval = setInterval(() => void tick(), 3_000)
    return () => {
      stopped = true
      clearInterval(interval)
    }
  }, [needsStatsSync, loadActiveAndBuckets])

  const pathKey = currentPath.join("/")

  React.useEffect(() => {
    setCurrentPage(1)
  }, [query, kindFilter, sortMode, pathKey])

  const resetBrowserState = () => {
    loadRequestIdRef.current += 1
    setObjects([])
    setBucketObjects([])
    setNextContinuationToken(null)
    setSelectedItems([])
    setSelectedDrives([])
    setQuery("")
    setKindFilter("all")
    setCurrentPage(1)
  }

  const navigateHome = () => {
    setCurrentPath([])
    resetBrowserState()
  }
  
  const navigateToDrive = (driveName: string) => {
    setCurrentPath([driveName])
    setSelectedDrives([])
    setSelectedItems([])
    setObjects([])
    setNextContinuationToken(null)
    setQuery("")
    setKindFilter("all")
    setCurrentPage(1)
    loadObjectsForPath([driveName])
  }

  const navigateUp = () => {
    setCurrentPath((prev) => {
      const next = prev.slice(0, -1)
      setSelectedItems([])
      if (next.length === 0) {
        resetBrowserState()
      } else {
        setObjects([])
        setNextContinuationToken(null)
        setQuery("")
        setCurrentPage(1)
        void loadObjectsForPath(next)
      }
      return next
    })
  }

  const navigateToFolder = (folderName: string) => {
    setCurrentPath((prev) => {
      const next = [...prev, folderName]
      setObjects([])
      setNextContinuationToken(null)
      setSelectedItems([])
      setQuery("")
      setKindFilter("all")
      setCurrentPage(1)
      void loadObjectsForPath(next)
      return next
    })
  }

  const isRoot = currentPath.length === 0

  const handleDriveClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    drive: Drive
  ) => {
    const multi = event.metaKey || event.ctrlKey || event.shiftKey
    setSelectedItems([])
    if (!multi) {
      navigateToDrive(drive.name)
      return
    }
    setSelectedDrives((prev) => {
      return prev.includes(drive.id)
        ? prev.filter((id) => id !== drive.id)
        : [...prev, drive.id]
    })
  }

  const handleItemClick = (
    event: React.MouseEvent<HTMLButtonElement | HTMLTableRowElement>,
    item: FileItem
  ) => {
    const multi = event.metaKey || event.ctrlKey || event.shiftKey
    setSelectedDrives([])
    if (!multi) {
      setSelectedItems([item.id])
      void openItem(item)
      return
    }
    setSelectedItems((prev) => {
      return prev.includes(item.id)
        ? prev.filter((id) => id !== item.id)
        : [...prev, item.id]
    })
  }

  const handleItemDoubleClick = (item: FileItem) => {
    void openItem(item)
  }

  const signedUrl = async (item: FileItem, action: "preview-url" | "download-url") => {
    const bucketName = currentPath[0]
    if (!bucketName) throw new Error("No drive selected")
    const qs = new URLSearchParams({ action, key: item.key })
    const res = await fetch(
      `/api/storage/buckets/${encodeURIComponent(bucketName)}/objects?${qs.toString()}`
    )
    const data = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown }
    if (!res.ok || typeof data.url !== "string") {
      throw new Error(String(data.error ?? "Unable to create signed object URL"))
    }
    return data.url
  }

  const systemStorageLink = (item: FileItem, download?: boolean) => {
    const bucketName = currentPath[0]
    if (!bucketName || item.type === "folder") return ""
    const origin = window.location.origin
    const encodedKey = item.key
      .split("/")
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join("/")
    return `${origin}/storage/${encodeURIComponent(bucketName)}/${encodedKey}${download ? "?download=1" : ""}`
  }

  const copySystemStorageLink = async (item: FileItem) => {
    const link = systemStorageLink(item)
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
    } catch {
      window.prompt("Storage link", link)
    }
  }

  const openItem = async (item: FileItem) => {
    if (item.type === "folder") {
      navigateToFolder(item.name)
      return
    }
    setPreviewTarget({ item, loading: true })
    try {
      const url = await signedUrl(item, "preview-url")
      setPreviewTarget({ item, url, loading: false })
    } catch (error: unknown) {
      setPreviewTarget({
        item,
        loading: false,
        error: errorMessage(error, "Unable to preview file"),
      })
    }
  }

  const downloadItem = (item: FileItem) => {
    const link = systemStorageLink(item, true)
    if (!link) return
    window.location.href = link
  }

  const deleteItem = async (item: FileItem) => {
    const bucketName = currentPath[0]
    if (!bucketName) return
    if (!window.confirm(`Delete "${item.name}"${item.type === "folder" ? " and everything inside it" : ""}?`)) {
      return
    }
    const res = await fetch(`/api/storage/buckets/${encodeURIComponent(bucketName)}/objects`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: item.key, type: item.type }),
    })
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; details?: unknown }
      window.alert(String(data.error ?? data.details ?? "Unable to delete item"))
      return
    }
    setSelectedItems([])
    await loadObjectsForPath(currentPath)
    void loadActiveAndBuckets()
  }

  const loadMore = async () => {
    if (!nextContinuationToken) return
    if (!currentPath[0]) return
    await loadObjectsForPath(currentPath, "append")
  }

  const loadObjectsForPath = async (path: string[], mode?: "append") => {
    const bucketName = path[0] ?? ""
    if (!bucketName) return
    const requestId = ++loadRequestIdRef.current
    setObjectsLoading(true)
    try {
      const prefix = path.length > 1 ? path.slice(1).join("/") + "/" : ""
      const qs = new URLSearchParams()
      if (prefix) qs.set("prefix", prefix)
      qs.set("maxKeys", "1000")
      if (mode === "append" && nextContinuationToken) {
        qs.set("continuationToken", nextContinuationToken)
      }

      const res = await fetch(
        `/api/storage/buckets/${encodeURIComponent(bucketName)}/objects?${qs.toString()}`
      )
      if (requestId !== loadRequestIdRef.current) return
      if (!res.ok) {
        setBucketObjects([])
        setObjects([])
        setNextContinuationToken(null)
        return
      }
      const data: ObjectsResponse = await res.json()
      if (requestId !== loadRequestIdRef.current) return

      const folders = Array.isArray(data.folders) ? data.folders.map(String).filter(Boolean) : []
      const rawObjects = Array.isArray(data.objects) ? data.objects : []
      const normalized: RawObject[] = rawObjects
        .map((obj) => ({
          id: String(obj?.id ?? obj?.key ?? obj?.name ?? ""),
          key: String(obj?.key ?? obj?.name ?? ""),
          size: typeof obj?.size === "number" ? obj.size : 0,
          uploaded: typeof obj?.uploaded === "string" ? obj.uploaded : undefined,
        }))
        .filter((o) => o.key.length > 0)

      const nextToken = typeof data.nextContinuationToken === "string" ? data.nextContinuationToken : null
      setNextContinuationToken(nextToken)

      if (mode === "append") {
        setBucketObjects((prev) => [...prev, ...normalized])
        setObjects((prev) => {
          const existingFolders = prev.filter((i) => i.type === "folder")
          const existingFiles = prev.filter((i) => i.type === "file")
          const nextFiles = buildItemsFromListing({ prefix, folders: [], objects: normalized }).filter(
            (i) => i.type === "file"
          )
          return [...existingFolders, ...existingFiles, ...nextFiles]
        })
      } else {
        setBucketObjects(normalized)
        setObjects(buildItemsFromListing({ prefix, folders, objects: normalized }))
      }
    } catch {
      if (requestId !== loadRequestIdRef.current) return
      setBucketObjects([])
      setObjects([])
      setNextContinuationToken(null)
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setObjectsLoading(false)
      }
    }
  }

  const handleCreateBucket = async () => {
    if (!newBucketName.trim()) {
      setNewBucketError("Bucket name is required")
      return
    }

    setCreatingBucket(true)
    setNewBucketError(null)

    try {
      const res = await fetch("/api/storage/buckets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: newBucketName }),
      })

      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        const msg = data?.error || data?.details || "Unable to create R2 bucket"
        setNewBucketError(String(msg))
        return
      }

      await loadActiveAndBuckets()
      setCreateBucketOpen(false)
      setNewBucketName("")
      setNewBucketError(null)
    } catch (error: unknown) {
      setNewBucketError(errorMessage(error, "Network error while creating bucket"))
    } finally {
      setCreatingBucket(false)
    }
  }

  const filteredDrives = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return drives
    return drives.filter((drive) => drive.name.toLowerCase().includes(needle))
  }, [drives, query])

  const filteredObjects = React.useMemo(() => {
    const needle = query.trim().toLowerCase()
    return objects
      .filter((item) => {
        if (!matchesKindFilter(item, kindFilter)) return false
        if (!needle) return true
        return (
          item.name.toLowerCase().includes(needle) ||
          item.key.toLowerCase().includes(needle) ||
          fileTypeLabel(item).toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        if (sortMode === "name-desc") return b.name.localeCompare(a.name)
        if (sortMode === "type") {
          const typeSort = fileTypeLabel(a).localeCompare(fileTypeLabel(b))
          return typeSort || a.name.localeCompare(b.name)
        }
        if (sortMode === "modified-desc") return itemModifiedMs(b) - itemModifiedMs(a)
        if (sortMode === "size-desc") return itemSizeBytes(b) - itemSizeBytes(a)
        return a.name.localeCompare(b.name)
      })
  }, [kindFilter, objects, query, sortMode])

  const numericPageSize = Math.max(20, Math.min(200, Number(pageSize) || 50))
  const totalPages = Math.max(1, Math.ceil(filteredObjects.length / numericPageSize))
  const safePage = Math.min(currentPage, totalPages)
  const pagedObjects = filteredObjects.slice(
    (safePage - 1) * numericPageSize,
    safePage * numericPageSize
  )
  const folderCount = objects.filter((item) => item.type === "folder").length
  const fileCount = objects.length - folderCount
  const showDrivesPanel = isRoot

  if (drivesLoading && drives.length === 0) {
    return <StoragePageSkeleton />
  }

  return (
    <div className="flex flex-1 flex-col h-full">
      <Dialog open={createBucketOpen} onOpenChange={setCreateBucketOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Cloudflare R2 drive</DialogTitle>
            <DialogDescription>
              Enter a new bucket name. It must be unique in this account and
              use only lowercase letters, numbers, and dashes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            <Input
              autoFocus
              placeholder="my-bucket-name"
              value={newBucketName}
              onChange={(e) => {
                setNewBucketName(e.target.value)
                setNewBucketError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  void handleCreateBucket()
                }
              }}
            />
            {newBucketError && (
              <p className="text-xs text-red-500">{newBucketError}</p>
            )}
          </div>
          <DialogFooter className="pt-2">
            <Button
              variant="outline"
              onClick={() => {
                if (creatingBucket) return
                setCreateBucketOpen(false)
                setNewBucketError(null)
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateBucket()}
              loading={creatingBucket}
              disabled={!newBucketName.trim()}
            >
              Create drive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(previewTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewTarget(null)
            setVideoPlaying(false)
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="h-[min(76dvh,720px)] max-h-[calc(100dvh-1rem)] w-[min(96vw,1280px)] max-w-none overflow-hidden p-0"
        >
          {previewTarget && (
            <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto,minmax(0,1fr)] bg-background">
              <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-1 border-b bg-background/95 px-2 py-1">
                <DialogHeader className="min-w-0 flex-1 gap-0 text-left">
                  <DialogTitle className="truncate text-sm font-medium leading-none">
                    {previewTarget.item.name}
                  </DialogTitle>
                </DialogHeader>
                <div className="flex shrink-0 items-center gap-1">
                  {previewTarget.url && fileKind(previewTarget.item) === "video" && (
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={videoPlaying ? "Pause video" : "Play video"}
                      title={videoPlaying ? "Pause" : "Play"}
                      onClick={() => {
                        const video = videoRef.current
                        if (!video) return
                        if (video.paused) {
                          void video.play()
                          setVideoPlaying(true)
                        } else {
                          video.pause()
                          setVideoPlaying(false)
                        }
                      }}
                    >
                      {videoPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                    </Button>
                  )}
                  {previewTarget.url && (
                    <Button variant="outline" size="icon" className="h-7 w-7" asChild>
                      <a
                        href={systemStorageLink(previewTarget.item)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Open file"
                        title="Open"
                      >
                        <ExternalLink className="h-4 w-4" />
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Copy file link"
                    title="Copy link"
                    onClick={() => void copySystemStorageLink(previewTarget.item)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    size="icon"
                    className="h-7 w-7"
                    aria-label="Download file"
                    title="Download"
                    onClick={() => void downloadItem(previewTarget.item)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <DialogClose asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:bg-destructive/15 hover:text-destructive"
                      aria-label="Close preview"
                      title="Close"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </DialogClose>
                </div>
              </div>

              <div className="min-h-0 min-w-0 overflow-hidden bg-background">
                <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-hidden bg-background">
                  {previewTarget.loading && (
                    <div className="flex items-center gap-2 rounded-md border bg-background px-4 py-3 text-sm text-muted-foreground shadow-sm">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Preparing preview
                    </div>
                  )}
                  {!previewTarget.loading && previewTarget.error && (
                    <div className="max-w-md rounded-lg border bg-background p-8 text-center shadow-sm">
                      <File className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
                      <p className="font-medium">Preview unavailable</p>
                      <p className="mt-1 text-sm text-muted-foreground">{previewTarget.error}</p>
                    </div>
                  )}
                  {!previewTarget.loading && previewTarget.url && fileKind(previewTarget.item) === "image" && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={previewTarget.url}
                      alt={previewTarget.item.name}
                      className="block h-auto max-h-full w-auto max-w-full object-contain"
                    />
                  )}
                  {!previewTarget.loading && previewTarget.url && fileKind(previewTarget.item) === "video" && (
                    <video
                      ref={videoRef}
                      src={previewTarget.url}
                      controls
                      className="h-full max-h-full w-full max-w-full bg-black object-contain object-top"
                      onPlay={() => setVideoPlaying(true)}
                      onPause={() => setVideoPlaying(false)}
                    />
                  )}
                  {!previewTarget.loading && previewTarget.url && fileKind(previewTarget.item) === "audio" && (
                    <div className="w-full max-w-2xl min-w-0 p-4 sm:p-6">
                      <div className="mb-6 flex items-center gap-4">
                        <div className="flex h-14 w-14 items-center justify-center rounded-lg border bg-muted">
                          <File className="h-6 w-6 text-muted-foreground" />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-base font-medium">{previewTarget.item.name}</p>
                        </div>
                      </div>
                      <audio src={previewTarget.url} controls className="w-full" />
                    </div>
                  )}
                  {!previewTarget.loading &&
                    previewTarget.url &&
                    ["pdf", "text", "document", "file"].includes(fileKind(previewTarget.item)) && (
                      <iframe
                        src={previewTarget.url}
                        title={previewTarget.item.name}
                        className="h-full min-h-0 w-full min-w-0 border-0 bg-background"
                      />
                    )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(propertiesTarget)} onOpenChange={(open) => !open && setPropertiesTarget(null)}>
        <DialogContent>
          {propertiesTarget && (
            <>
              <DialogHeader>
                <DialogTitle>Properties</DialogTitle>
                <DialogDescription>
                  {propertiesTarget.type === "drive"
                    ? propertiesTarget.drive.name
                    : propertiesTarget.type === "item"
                      ? propertiesTarget.item.name
                      : propertiesTarget.path.length
                        ? propertiesTarget.path.join(" / ")
                        : "This PC"}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                {propertiesTarget.type === "drive" && (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Used</span>
                      <span>{formatBytes(propertiesTarget.drive.usedBytes)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Objects</span>
                      <span>{propertiesTarget.drive.objects}</span>
                    </div>
                  </>
                )}
                {propertiesTarget.type === "item" && (
                  <>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Type</span>
                      <span>{propertiesTarget.item.type === "folder" ? "Folder" : propertiesTarget.item.fileType}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Size</span>
                      <span>{propertiesTarget.item.type === "folder" ? "-" : propertiesTarget.item.size}</span>
                    </div>
                    <div className="break-all">
                      <span className="text-muted-foreground">Key: </span>
                      {propertiesTarget.item.key}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-3 border-b px-1 pb-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="mr-0 flex min-w-0 flex-1 items-center gap-2 lg:mr-4">
             <Button variant="ghost" size="icon" disabled={isRoot} onClick={navigateUp}>
                <ArrowLeft className="h-4 w-4" />
             </Button>
             
             <div className="flex h-9 min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-xl border bg-background px-3 text-sm [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:max-w-2xl">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 p-0"
                  onClick={navigateHome}
                >
                     <Home className="h-4 w-4 text-muted-foreground" />
                </Button>
                {currentPath.map((segment, index) => (
                    <React.Fragment key={`${segment}-${index}`}>
                         <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                         <button
                            className={cn("cursor-pointer hover:bg-accent/50 px-1 rounded", index === currentPath.length -1 ? "font-medium" : "text-muted-foreground")}
                            onClick={() => {
                              const next = currentPath.slice(0, index + 1)
                              setCurrentPath(next)
                              setObjects([])
                              setSelectedItems([])
                              setQuery("")
                              setCurrentPage(1)
                              void loadObjectsForPath(next)
                            }}
                          >
                            {segment}
                         </button>
                    </React.Fragment>
                ))}
             </div>
       </div>

       <div className="flex flex-wrap items-center gap-2">
             <div className="relative hidden w-full sm:w-64 md:block">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input 
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={isRoot ? "Search drives" : "Search files and folders"} 
                    className="pl-8"
                />
             </div>
             <div className="flex rounded-xl border bg-muted/40 p-0.5">
                <Button 
                    variant={view === "list" ? "secondary" : "ghost"}
                    size="icon"
                    className="rounded-lg"
                    onClick={() => setView("list")}
                >
                    <ListIcon className="h-4 w-4" />
                </Button>
                <Button 
                    variant={view === "grid" ? "secondary" : "ghost"}
                    size="icon"
                    className="rounded-lg"
                    onClick={() => setView("grid")}
                >
                    <Grid2X2 className="h-4 w-4" />
                </Button>
             </div>
             <input
               ref={fileInputRef}
               type="file"
               multiple
               className="hidden"
               onChange={async (event) => {
                 const files = Array.from(event.target.files ?? [])
                 if (!files.length || !currentPath[0]) return

                 const bucketName = currentPath[0]
                 const segments = currentPath.slice(1)
                 const prefix = segments.length ? segments.join("/") + "/" : ""

                 try {
                   for (const file of files) {
                     const formData = new FormData()
                     formData.append("path", prefix)
                     formData.append("file", file)

                     const res = await fetch(
                       `/api/storage/buckets/${encodeURIComponent(
                         bucketName
                       )}/objects`,
                       {
                         method: "POST",
                         body: formData,
                       }
                     )

                     if (!res.ok) {
                       const data = await res.json().catch(() => ({}))
                       const msg =
                         data?.error ||
                         data?.details ||
                         "Failed to upload object"
                       window.alert(msg)
                       break
                     }
                   }
                   await loadObjectsForPath(currentPath)
                   void loadActiveAndBuckets()
                 } finally {
                   event.target.value = ""
                 }
               }}
             />
             <Button
               disabled={isRoot}
               onClick={() => {
                 if (!isRoot) {
                   fileInputRef.current?.click()
                 }
               }}
             >
                <Upload className="mr-2 h-4 w-4" />
                Upload
             </Button>
        </div>
      </div>

      <div
        className={
          showDrivesPanel && view === "grid"
            ? "grid flex-1 grid-cols-1 gap-4 py-4 xl:grid-cols-[minmax(220px,260px)_minmax(0,1fr)]"
            : "grid min-h-0 flex-1 grid-cols-1 gap-4 py-4"
        }
      >
        {showDrivesPanel && (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="space-y-4">
                <div
                  className={
                    view === "grid"
                      ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-3 justify-items-start"
                      : "space-y-2"
                  }
                >
                  {filteredDrives.map((drive) => {
              const percent =
                totalUsedBytes > 0
                  ? Math.round((drive.usedBytes / totalUsedBytes) * 100)
                  : 0
              const isCurrent = currentPath[0] === drive.name
              const isSelected = selectedDrives.includes(drive.id)

              const driveButton =
                view === "grid" ? (
                  // Grid: compact Windows-style tile
                  <button
                    key={drive.id}
                    className={cn(
                      "group flex w-full min-w-0 flex-col gap-2 rounded-2xl border bg-card p-3 text-left transition-colors hover:bg-accent/60 sm:w-64",
                      (isCurrent || isSelected) && "border-primary bg-primary/5"
                    )}
                    onClick={(e) => handleDriveClick(e, drive)}
                  >
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-md border bg-muted">
                        <HardDrive className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex flex-1 flex-col overflow-hidden text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-foreground truncate">
                            {drive.name}
                          </span>
                          <span className="ml-2 shrink-0 text-muted-foreground">
                            {formatBytes(drive.usedBytes)} used
                          </span>
                        </div>
                      </div>
                    </div>
                    <Progress value={percent} className="h-1.5" />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span>
                        {drive.statsStatus && drive.statsStatus !== "completed"
                          ? drive.statsStatus === "error"
                            ? "Error"
                            : "Calculating..."
                          : `${drive.objects} objects`}
                      </span>
                      <span>{percent}% of total used</span>
                    </div>
                  </button>
                ) : (
                  // List: full-width row
                  <button
                    key={drive.id}
                    className={cn(
                      "group flex w-full min-w-0 gap-4 rounded-2xl border bg-card px-4 py-2 text-left transition-colors hover:bg-accent/40",
                      (isCurrent || isSelected) && "border-primary bg-primary/5"
                    )}
                    onClick={(e) => handleDriveClick(e, drive)}
                  >
                    <div className="mt-1">
                      <HardDrive className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
                        <span className="font-medium text-foreground truncate">
                          {drive.name}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {formatBytes(drive.usedBytes)} used
                        </span>
                      </div>
                      <Progress value={percent} className="h-1.5" />
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                        <span>
                          {drive.statsStatus && drive.statsStatus !== "completed"
                            ? drive.statsStatus === "error"
                              ? "Error"
                              : "Calculating..."
                            : `${drive.objects} objects`}
                        </span>
                        <span>{percent}% of total used</span>
                      </div>
                    </div>
                  </button>
                )

                return (
                  <ContextMenu key={drive.id}>
                    <ContextMenuTrigger asChild>
                      {driveButton}
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={() => navigateToDrive(drive.name)}
                      >
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onClick={openCreateBucket}>
                        New drive (bucket)
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() =>
                          setPropertiesTarget({ type: "drive", drive })
                        }
                      >
                        Properties
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={openCreateBucket}>
                New drive (bucket)
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() =>
                  setPropertiesTarget({ type: "path", path: currentPath })
                }
              >
                Properties
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}

        <div className="flex min-h-0 min-w-0 flex-col gap-4">
            {!isRoot && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-sm font-medium text-muted-foreground">
                      {currentPath.join(" / ")}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {folderCount} folders, {fileCount} files
                      {filteredObjects.length !== objects.length
                        ? ` - ${filteredObjects.length} matched`
                        : ""}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={async () => {
                          const ctxBucket = currentPath[0]
                          if (!ctxBucket) return
                          const prefix = currentPath.length > 1 ? `${currentPath.slice(1).join("/")}/` : ""
                          const name = window.prompt("New folder name")
                          if (!name) return
                          await fetch(`/api/storage/buckets/${encodeURIComponent(ctxBucket)}/objects`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ action: "folder", key: `${prefix}${name.replace(/\/+/g, "")}/` }),
                          })
                          await loadObjectsForPath(currentPath)
                        }}
                      >
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => fileInputRef.current?.click()}>
                        Upload files
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void loadObjectsForPath(currentPath)}>
                        Refresh
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card/70 p-2">
                  <div className="flex items-center gap-2 pr-1 text-xs font-medium text-muted-foreground">
                    <Filter className="h-4 w-4" />
                    Filters
                  </div>
                  <Select value={kindFilter} onValueChange={(value) => setKindFilter(value as KindFilter)}>
                    <SelectTrigger size="sm" className="w-[140px] max-w-[calc(100vw-3rem)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All types</SelectItem>
                      <SelectItem value="folder">Folders</SelectItem>
                      <SelectItem value="image">Images</SelectItem>
                      <SelectItem value="video">Videos</SelectItem>
                      <SelectItem value="audio">Audio</SelectItem>
                      <SelectItem value="pdf">PDF</SelectItem>
                      <SelectItem value="document">Documents</SelectItem>
                      <SelectItem value="other">Other files</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={sortMode} onValueChange={(value) => setSortMode(value as SortMode)}>
                    <SelectTrigger size="sm" className="w-[150px] max-w-[calc(100vw-3rem)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="name-asc">Name A-Z</SelectItem>
                      <SelectItem value="name-desc">Name Z-A</SelectItem>
                      <SelectItem value="type">Type</SelectItem>
                      <SelectItem value="modified-desc">Newest</SelectItem>
                      <SelectItem value="size-desc">Largest</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={pageSize} onValueChange={setPageSize}>
                    <SelectTrigger size="sm" className="w-[120px] max-w-[calc(100vw-3rem)]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="20">20 / page</SelectItem>
                      <SelectItem value="50">50 / page</SelectItem>
                      <SelectItem value="100">100 / page</SelectItem>
                      <SelectItem value="200">200 / page</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQuery("")
                      setKindFilter("all")
                      setSortMode("name-asc")
                    }}
                  >
                    Reset
                  </Button>
                </div>

                {filteredObjects.length === 0 && !objectsLoading ? (
                  <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed bg-card/40 p-4 text-center">
                    <Folder className="mb-3 h-10 w-10 text-muted-foreground" />
                    <p className="font-medium">{objects.length ? "No matching items" : "This folder is empty"}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {objects.length ? "Try another search or filter." : "Upload files or create a folder from the context menu."}
                    </p>
                  </div>
                ) : view === "grid" ? (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {pagedObjects.map((item) => {
                      const isFolder = item.type === "folder"
                      const Icon = isFolder ? Folder : File
                      const isSelected = selectedItems.includes(item.id)

                      return (
                        <ContextMenu key={item.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              onClick={(e) => handleItemClick(e, item)}
                              className={cn(
                                "group flex flex-col items-start gap-2 rounded-lg border bg-card p-3 text-left hover:bg-accent/60",
                                isSelected && "border-primary bg-primary/5"
                              )}
                            >
                              <div className="flex w-full min-w-0 items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-2">
                                  <div
                                    className={cn(
                                      "flex h-8 w-8 items-center justify-center rounded-md border bg-muted text-muted-foreground",
                                      isFolder && "bg-primary/10 text-primary"
                                    )}
                                  >
                                    <Icon className="h-4 w-4" />
                                  </div>
                                  <div className="flex min-w-0 flex-col">
                                    <span className="truncate text-sm font-medium">
                                      {item.name}
                                    </span>
                                    <span className="text-xs text-muted-foreground">
                                      {isFolder ? "Folder" : item.fileType}
                                    </span>
                                  </div>
                                </div>
                                <MoreHorizontal className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <div className="flex w-full flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span className="truncate">{item.modified}</span>
                                {!isFolder && <span>{item.size}</span>}
                              </div>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onClick={() => handleItemDoubleClick(item)}
                            >
                              {item.type === "folder" ? "Open" : "Preview"}
                            </ContextMenuItem>
                            {item.type === "file" && (
                              <>
                                <ContextMenuItem onClick={() => void downloadItem(item)}>
                                  Download
                                </ContextMenuItem>
                                <ContextMenuItem
                                  onClick={() => {
                                    window.open(systemStorageLink(item), "_blank", "noopener,noreferrer")
                                  }}
                                >
                                  Open system link
                                </ContextMenuItem>
                                <ContextMenuItem onClick={() => void copySystemStorageLink(item)}>
                                  Copy system link
                                </ContextMenuItem>
                              </>
                            )}
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() =>
                                setPropertiesTarget({ type: "item", item })
                              }
                            >
                              Properties
                            </ContextMenuItem>
                            <ContextMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => void deleteItem(item)}
                            >
                              Delete
                            </ContextMenuItem>
                          </ContextMenuContent>
                        </ContextMenu>
                      )
                    })}
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={async () => {
                          const ctxBucket = currentPath[0]
                          if (!ctxBucket) return
                          const segments = currentPath.slice(1)
                          const prefix = segments.length
                            ? segments.join("/") + "/"
                            : ""
                          const name = window.prompt("New folder name")
                          if (!name) return
                          const key = `${prefix}${name.replace(/\/+/g, "")}/`
                          await fetch(
                            `/api/storage/buckets/${encodeURIComponent(
                              ctxBucket
                            )}/objects`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                action: "folder",
                                key,
                              }),
                            }
                          )
                          await loadObjectsForPath([ctxBucket, ...currentPath.slice(1)])
                        }}
                      >
                        New folder
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={async () => {
                          const ctxBucket = currentPath[0]
                          if (!ctxBucket) return
                          const segments = currentPath.slice(1)
                          const prefix = segments.length
                            ? segments.join("/") + "/"
                            : ""
                          const name = window.prompt("New file name")
                          if (!name) return
                          const key = `${prefix}${name.replace(/\/+/g, "")}`
                          await fetch(
                            `/api/storage/buckets/${encodeURIComponent(
                              ctxBucket
                            )}/objects`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                action: "file",
                                key,
                              }),
                            }
                          )
                          await loadObjectsForPath([ctxBucket, ...currentPath.slice(1)])
                        }}
                      >
                        New file
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          if (!isRoot) {
                            fileInputRef.current?.click()
                          }
                        }}
                      >
                        Upload files
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() =>
                          setPropertiesTarget({ type: "path", path: currentPath })
                        }
                      >
                        Properties
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ) : (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="rounded-2xl border bg-card">
                        <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-[40%]">Name</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Modified</TableHead>
                          <TableHead className="w-[120px]">Size</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pagedObjects.map((item) => {
                          const isFolder = item.type === "folder"
                          const isSelected = selectedItems.includes(item.id)
                          return (
                            <ContextMenu key={item.id}>
                              <ContextMenuTrigger asChild>
                                <TableRow
                                  className={cn(
                                    "cursor-pointer hover:bg-accent/60",
                                    isSelected && "bg-accent/70"
                                  )}
                                  onClick={(e) => handleItemClick(e, item)}
                                >
                                  <TableCell className="flex min-w-0 items-center gap-2">
                                    {isFolder ? (
                                      <Folder className="h-4 w-4 text-primary" />
                                    ) : (
                                      <File className="h-4 w-4 text-muted-foreground" />
                                    )}
                                    <span className="truncate">{item.name}</span>
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {isFolder ? "Folder" : item.fileType}
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {item.modified}
                                  </TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {isFolder ? "-" : item.size}
                                  </TableCell>
                                </TableRow>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                <ContextMenuItem
                                  onClick={() => handleItemDoubleClick(item)}
                                >
                                  {item.type === "folder" ? "Open" : "Preview"}
                                </ContextMenuItem>
                                {item.type === "file" && (
                                  <>
                                    <ContextMenuItem onClick={() => void downloadItem(item)}>
                                      Download
                                    </ContextMenuItem>
                                    <ContextMenuItem
                                      onClick={() => {
                                        window.open(systemStorageLink(item), "_blank", "noopener,noreferrer")
                                      }}
                                    >
                                      Open system link
                                    </ContextMenuItem>
                                    <ContextMenuItem onClick={() => void copySystemStorageLink(item)}>
                                      Copy system link
                                    </ContextMenuItem>
                                  </>
                                )}
                                <ContextMenuSeparator />
                                <ContextMenuItem
                                  onClick={() =>
                                    setPropertiesTarget({ type: "item", item })
                                  }
                                >
                                  Properties
                                </ContextMenuItem>
                                <ContextMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => void deleteItem(item)}
                                >
                                  Delete
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          )
                        })}
                      </TableBody>
                    </Table>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onClick={async () => {
                          const ctxBucket = currentPath[0]
                          if (!ctxBucket) return
                          const segments = currentPath.slice(1)
                          const prefix = segments.length
                            ? segments.join("/") + "/"
                            : ""
                          const name = window.prompt("New folder name")
                          if (!name) return
                          const key = `${prefix}${name.replace(/\/+/g, "")}/`
                          await fetch(
                            `/api/storage/buckets/${encodeURIComponent(
                              ctxBucket
                            )}/objects`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                action: "folder",
                                key,
                              }),
                            }
                          )
                          await loadObjectsForPath([ctxBucket, ...currentPath.slice(1)])
                        }}
                      >
                        New folder
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={async () => {
                          const ctxBucket = currentPath[0]
                          if (!ctxBucket) return
                          const segments = currentPath.slice(1)
                          const prefix = segments.length
                            ? segments.join("/") + "/"
                            : ""
                          const name = window.prompt("New file name")
                          if (!name) return
                          const key = `${prefix}${name.replace(/\/+/g, "")}`
                          await fetch(
                            `/api/storage/buckets/${encodeURIComponent(
                              ctxBucket
                            )}/objects`,
                            {
                              method: "POST",
                              headers: {
                                "Content-Type": "application/json",
                              },
                              body: JSON.stringify({
                                action: "file",
                                key,
                              }),
                            }
                          )
                          await loadObjectsForPath([ctxBucket, ...currentPath.slice(1)])
                        }}
                      >
                        New file
                      </ContextMenuItem>
                      <ContextMenuItem
                        onClick={() => {
                          if (!isRoot) {
                            fileInputRef.current?.click()
                          }
                        }}
                      >
                        Upload files
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        onClick={() =>
                          setPropertiesTarget({ type: "path", path: currentPath })
                        }
                      >
                        Properties
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    Showing {filteredObjects.length === 0 ? 0 : (safePage - 1) * numericPageSize + 1}
                    -{Math.min(safePage * numericPageSize, filteredObjects.length)} of {filteredObjects.length}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage <= 1}
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                    >
                      Previous
                    </Button>
                    <span className="min-w-16 text-center text-xs text-muted-foreground">
                      Page {safePage} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safePage >= totalPages}
                      onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                    >
                      Next
                    </Button>
                    {nextContinuationToken && (
                      <Button
                        variant="outline"
                        size="sm"
                        loading={objectsLoading}
                        onClick={loadMore}
                      >
                        Load more from R2
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
        </div>
      </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={openCreateBucket}>
            New drive (bucket)
          </ContextMenuItem>
          {!isRoot && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={async () => {
                  const ctxBucket = currentPath[0]
                  if (!ctxBucket) return
                  const prefix = currentPath.length > 1 ? `${currentPath.slice(1).join("/")}/` : ""
                  const name = window.prompt("New folder name")
                  if (!name) return
                  await fetch(`/api/storage/buckets/${encodeURIComponent(ctxBucket)}/objects`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      action: "folder",
                      key: `${prefix}${name.replace(/\/+/g, "")}/`,
                    }),
                  })
                  await loadObjectsForPath(currentPath)
                }}
              >
                New folder
              </ContextMenuItem>
              <ContextMenuItem onClick={() => fileInputRef.current?.click()}>
                Upload files
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => {
              if (isRoot) {
                void loadActiveAndBuckets()
              } else {
                void loadObjectsForPath(currentPath)
              }
            }}
          >
            Refresh
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => setPropertiesTarget({ type: "path", path: currentPath })}
          >
            Properties
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

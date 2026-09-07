"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import {
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Grid2X2,
  HardDrive,
  Info,
  List,
  Loader2,
  MoreHorizontal,
  Music2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { toast } from "sonner"
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardPanel,
} from "@/components/dashboard/page-shell"
import { StoragePageSkeleton } from "@/components/dashboard/loading-skeletons"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import {
  listingItems,
  mergeItems,
  sortItems,
  storageHref,
  type StorageItem,
  type StorageListing,
} from "@/lib/storage-browser.cjs"

type Drive = {
  id: string
  name: string
  bytes: number
  objects: number
  statsStatus?: string
  updatedAt?: string
}
type Account = { id: string; label: string; email: string }
type Snapshot = { buckets: Drive[]; totalBytes: number; activeAccount: Account }
type Preview = {
  item: StorageItem
  drive: string
  url?: string
  error?: string
}
type Details = { drive: Drive } | { item: StorageItem }
type CreateKind = "drive" | "folder" | "file"
type Kind =
  "all" | "folder" | "image" | "video" | "audio" | "document" | "other"

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  )
  return (
    (bytes / 1024 ** index).toLocaleString(undefined, {
      maximumFractionDigits: 1,
    }) +
    " " +
    units[index]
  )
}

function fileKind(item: StorageItem): Exclude<Kind, "all"> {
  if (item.type === "folder") return "folder"
  const ext = item.name.split(".").pop()?.toLowerCase() || ""
  if (["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "bmp"].includes(ext))
    return "image"
  if (["mp4", "webm", "mov", "m4v", "avi", "mkv"].includes(ext)) return "video"
  if (["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext)) return "audio"
  if (
    [
      "pdf",
      "doc",
      "docx",
      "xls",
      "xlsx",
      "ppt",
      "pptx",
      "txt",
      "md",
      "csv",
      "json",
      "html",
    ].includes(ext)
  )
    return "document"
  return "other"
}

const kindLabels = {
  folder: "Folder",
  image: "Image",
  video: "Video",
  audio: "Audio",
  document: "Document",
  other: "File",
}
const kindIcons = {
  folder: Folder,
  image: FileImage,
  video: Film,
  audio: Music2,
  document: FileText,
  other: File,
}

function ItemIcon({
  item,
  large = false,
}: {
  item: StorageItem
  large?: boolean
}) {
  const kind = fileKind(item)
  const Icon = kindIcons[kind]
  return (
    <Icon
      aria-hidden="true"
      className={cn(
        "shrink-0",
        large ? "size-9" : "size-5",
        kind === "folder"
          ? "fill-primary/15 text-primary"
          : "text-muted-foreground"
      )}
      strokeWidth={1.5}
    />
  )
}

function modifiedLabel(value: string) {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—"
}

function message(error: unknown) {
  return error instanceof Error
    ? error.message
        .replace(/\bbuckets\b/gi, "drives")
        .replace(/\bbucket\b/gi, "drive")
    : "Something went wrong. Please try again."
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      data?.error ||
        "Request failed (" + response.status + "). Please try again."
    )
  if (!data)
    throw new Error(
      "The server returned an invalid response. Please try again."
    )
  return data as T
}

function objectEndpoint(
  drive: string,
  accountId: string,
  params?: Record<string, string>
) {
  return (
    "/api/storage/buckets/" +
    encodeURIComponent(drive) +
    "/objects?" +
    new URLSearchParams({ accountId, ...params })
  )
}

function fileLink(
  drive: string,
  key: string,
  download = false,
  accountId?: string
) {
  // Dashboard downloads use admin authorization, including private drives.
  return objectEndpoint(drive, accountId || "", {
    key,
    action: download ? "download" : "open",
  })
}

export default function StoragePage() {
  const searchParams = useSearchParams()
  // The URL owns navigation, including browser Back/Forward and legacy links.
  const driveName =
    searchParams.get("drive") || searchParams.get("bucket") || ""
  const requestedPrefix = driveName ? searchParams.get("prefix") || "" : ""
  const prefix =
    requestedPrefix && !requestedPrefix.endsWith("/")
      ? requestedPrefix + "/"
      : requestedPrefix
  const locationKey = JSON.stringify([driveName, prefix])
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null)
  const [drivesLoading, setDrivesLoading] = React.useState(true)
  const [drivesError, setDrivesError] = React.useState("")
  const [items, setItems] = React.useState<StorageItem[]>([])
  const [listingLocation, setListingLocation] = React.useState("")
  const [listingAccount, setListingAccount] = React.useState("")
  const [objectsLoading, setObjectsLoading] = React.useState(false)
  const [objectsError, setObjectsError] = React.useState("")
  const [nextToken, setNextToken] = React.useState<string | null>(null)
  const [view, setView] = React.useState<"grid" | "list">("grid")
  const [query, setQuery] = React.useState("")
  const [kind, setKind] = React.useState<Kind>("all")
  const [sort, setSort] = React.useState("name-asc")
  const [pageSize, setPageSize] = React.useState("50")
  const [page, setPage] = React.useState(1)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [preview, setPreview] = React.useState<Preview | null>(null)
  const [details, setDetails] = React.useState<Details | null>(null)
  const [create, setCreate] = React.useState<CreateKind | null>(null)
  const [name, setName] = React.useState("")
  const [createError, setCreateError] = React.useState("")
  const [deleteTarget, setDeleteTarget] = React.useState<StorageItem | null>(
    null
  )
  const [busy, setBusy] = React.useState(false)
  const [uploadStatus, setUploadStatus] = React.useState<{
    done: number
    total: number
    name: string
  } | null>(null)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const listAbort = React.useRef<AbortController | null>(null)
  const drivesAbort = React.useRef<AbortController | null>(null)
  const previewRequest = React.useRef(0)
  const mutationLock = React.useRef(false)
  const listingLock = React.useRef(false)
  const requestSequence = React.useRef(0)
  const retryToken = React.useRef<string | undefined>(undefined)
  const currentLocation = React.useRef(locationKey)
  const accountId = snapshot?.activeAccount.id || ""
  const isRoot = !driveName
  const pathParts = prefix.replace(/\/$/, "").split("/")
  const parentPrefix = prefix
    ? prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1)
    : ""
  const currentDrive = snapshot?.buckets.find(
    (drive) => drive.name === driveName
  )
  const visibleItems =
    listingLocation === locationKey && listingAccount === accountId ? items : []
  const loading =
    !isRoot &&
    (objectsLoading || listingLocation !== locationKey) &&
    !drivesError

  const loadDrives = React.useCallback(async () => {
    drivesAbort.current?.abort()
    const controller = new AbortController()
    drivesAbort.current = controller
    setDrivesLoading(true)
    setDrivesError("")
    try {
      const data = await readResponse<Snapshot>(
        await fetch("/api/storage/buckets", {
          signal: controller.signal,
          cache: "no-store",
        })
      )
      if (!Array.isArray(data.buckets) || !data.activeAccount?.id)
        throw new Error("Unable to read the active account's drives.")
      if (!controller.signal.aborted) {
        setSnapshot(data)
        return data
      }
    } catch (error) {
      if (!controller.signal.aborted) setDrivesError(message(error))
    } finally {
      if (!controller.signal.aborted) setDrivesLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadDrives()
    return () => {
      drivesAbort.current?.abort()
      listAbort.current?.abort()
      // This is a request generation counter, not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      previewRequest.current++
    }
  }, [loadDrives])

  const loadItems = React.useCallback(
    async (token?: string) => {
      if (!driveName || !accountId) return
      if (token && listingLock.current) return
      listAbort.current?.abort()
      const controller = new AbortController()
      listAbort.current = controller
      const sequence = ++requestSequence.current
      retryToken.current = token
      listingLock.current = true
      setObjectsLoading(true)
      setObjectsError("")
      try {
        const data = await readResponse<StorageListing>(
          await fetch(
            objectEndpoint(driveName, accountId, {
              prefix,
              maxKeys: "1000",
              ...(token ? { continuationToken: token } : {}),
            }),
            { signal: controller.signal, cache: "no-store" }
          )
        )
        if (sequence !== requestSequence.current || controller.signal.aborted)
          return
        if (!Array.isArray(data.objects) || !Array.isArray(data.folders))
          throw new Error("The file listing was incomplete. Please refresh.")
        const next = listingItems(data, prefix)
        setItems((previous) => (token ? mergeItems(previous, next) : next))
        setNextToken(data.nextContinuationToken || null)
        setListingLocation(locationKey)
        setListingAccount(accountId)
      } catch (error) {
        if (
          sequence === requestSequence.current &&
          !controller.signal.aborted
        ) {
          setObjectsError(message(error))
          setListingLocation(locationKey)
        }
      } finally {
        if (sequence === requestSequence.current) {
          listingLock.current = false
          setObjectsLoading(false)
        }
      }
    },
    [accountId, driveName, prefix, locationKey]
  )

  React.useEffect(() => {
    currentLocation.current = locationKey
    setItems([])
    setNextToken(null)
    setObjectsError("")
    setQuery("")
    setKind("all")
    setSort("name-asc")
    setPage(1)
    setSelected(null)
    setPreview(null)
    setDetails(null)
    setDeleteTarget(null)
    setCreate(null)
    previewRequest.current++
    if (driveName) void loadItems()
    else {
      setListingLocation(locationKey)
      setObjectsLoading(false)
    }
    return () => {
      listAbort.current?.abort()
      // Invalidate any response still settling after navigation.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestSequence.current++
      listingLock.current = false
    }
  }, [locationKey, driveName, loadItems])

  const navigate = (drive = "", path = "") => {
    if (mutationLock.current) return
    listAbort.current?.abort()
    previewRequest.current++
    currentLocation.current = JSON.stringify([drive, path])
    window.history.pushState(null, "", storageHref(drive, path))
  }

  const refresh = async () => {
    const origin = locationKey
    const latest = await loadDrives()
    if (
      !isRoot &&
      latest?.activeAccount.id === accountId &&
      currentLocation.current === origin
    )
      await loadItems()
  }
  const openCreate = (type: CreateKind) => {
    setName("")
    setCreateError("")
    setCreate(type)
  }

  const openItem = async (item: StorageItem) => {
    if (item.type === "folder") {
      navigate(driveName, item.key)
      return
    }
    const id = ++previewRequest.current
    setPreview({ item, drive: driveName })
    try {
      const data = await readResponse<{ url: string }>(
        await fetch(
          objectEndpoint(driveName, accountId, {
            action: "preview-url",
            key: item.key,
          })
        )
      )
      if (id === previewRequest.current)
        setPreview({ item, drive: driveName, url: data.url })
    } catch (error) {
      if (id === previewRequest.current)
        setPreview({ item, drive: driveName, error: message(error) })
    }
  }

  const previewFailed = () => {
    setPreview((current) =>
      current?.url === preview?.url && current
        ? {
            ...current,
            error:
              "This preview could not be loaded. Try again or download the file to open it in its app.",
          }
        : current
    )
  }

  const copyLink = async (item: StorageItem) => {
    try {
      const href =
        item.type === "folder"
          ? storageHref(driveName, item.key)
          : fileLink(driveName, item.key, false, accountId)
      await navigator.clipboard.writeText(
        new URL(href, window.location.origin).href
      )
      toast.success("Link copied. Dashboard access is required to open it.")
    } catch {
      toast.error("Could not copy the link. Check clipboard permissions.")
    }
  }

  const createItem = async () => {
    if (!create || mutationLock.current) return
    const value = name.trim()
    if (
      create === "drive" &&
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)
    ) {
      setCreateError(
        "Use 3–63 lowercase letters, numbers or dashes. Start and end with a letter or number."
      )
      return
    }
    if (
      !value ||
      (create !== "drive" &&
        (value.includes("/") || value === "." || value === ".."))
    ) {
      setCreateError("Enter a name without slashes.")
      return
    }
    mutationLock.current = true
    setBusy(true)
    setCreateError("")
    const origin = locationKey
    try {
      const url =
        create === "drive"
          ? "/api/storage/buckets?" + new URLSearchParams({ accountId })
          : objectEndpoint(driveName, accountId)
      const data = await readResponse<{ name?: string; warning?: string }>(
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            create === "drive"
              ? { name: value }
              : {
                  action: create,
                  key: prefix + value + (create === "folder" ? "/" : ""),
                }
          ),
        })
      )
      if (create === "drive" && data.name) {
        const createdName = data.name
        setSnapshot((previous) =>
          previous && previous.activeAccount.id === accountId
            ? {
                ...previous,
                buckets: previous.buckets.some(
                  (drive) => drive.name === createdName
                )
                  ? previous.buckets
                  : [
                      ...previous.buckets,
                      {
                        id: createdName,
                        name: createdName,
                        bytes: 0,
                        objects: 0,
                        statsStatus: "pending",
                      },
                    ],
              }
            : previous
        )
      } else if (currentLocation.current === origin) await loadItems()
      toast.success(
        (create === "drive"
          ? "Drive"
          : create === "folder"
            ? "Folder"
            : "File") + " created"
      )
      if (data.warning) toast.info(data.warning)
      setCreate(null)
    } catch (error) {
      setCreateError(message(error))
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  const deleteItem = async () => {
    if (!deleteTarget || mutationLock.current) return
    mutationLock.current = true
    setBusy(true)
    const origin = locationKey
    try {
      await readResponse(
        await fetch(objectEndpoint(driveName, accountId), {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: deleteTarget.key,
            type: deleteTarget.type,
          }),
        })
      )
      toast.success('"' + deleteTarget.name + '" deleted')
      setDeleteTarget(null)
      setSelected(null)
      if (currentLocation.current === origin) await loadItems()
    } catch (error) {
      toast.error(message(error))
    } finally {
      mutationLock.current = false
      setBusy(false)
    }
  }

  const uploadFiles = async (files: globalThis.File[]) => {
    if (!files.length || isRoot || mutationLock.current) return
    mutationLock.current = true
    setBusy(true)
    const origin = locationKey
    let done = 0
    const failures: string[] = []
    try {
      for (const file of files) {
        setUploadStatus({ done, total: files.length, name: file.name })
        try {
          const body = new FormData()
          body.append("path", prefix)
          body.append("file", file)
          await readResponse(
            await fetch(objectEndpoint(driveName, accountId), {
              method: "POST",
              body,
            })
          )
          done++
        } catch (error) {
          failures.push(file.name)
          toast.error(file.name + ": " + message(error))
        }
      }
      if (done)
        toast.success(
          done + (done === 1 ? " file uploaded" : " files uploaded")
        )
      if (failures.length)
        toast.error(
          failures.length + " uploads need retrying. Select those files again."
        )
      if (currentLocation.current === origin) await loadItems()
    } finally {
      mutationLock.current = false
      setBusy(false)
      setUploadStatus(null)
    }
  }

  const filteredDrives = (snapshot?.buckets || [])
    .filter((drive) => drive.name.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) =>
      sort === "size-desc"
        ? b.bytes - a.bytes
        : sort === "name-desc"
          ? b.name.localeCompare(a.name)
          : a.name.localeCompare(b.name)
    )
  const filteredItems = sortItems(
    visibleItems.filter(
      (item) =>
        item.name.toLowerCase().includes(query.toLowerCase()) &&
        (kind === "all" || fileKind(item) === kind)
    ),
    sort
  )
  const count = isRoot ? filteredDrives.length : filteredItems.length
  const pageCount = Math.max(1, Math.ceil(count / Number(pageSize)))
  const safePage = Math.min(page, pageCount)
  const pageStart = (safePage - 1) * Number(pageSize)
  const pageItems = filteredItems.slice(pageStart, pageStart + Number(pageSize))
  const pageDrives = filteredDrives.slice(
    pageStart,
    pageStart + Number(pageSize)
  )
  const hasFilter = Boolean(query) || kind !== "all"
  const activeError = isRoot ? drivesError : drivesError || objectsError
  const folders = visibleItems.filter((item) => item.type === "folder").length
  const statsReady = (drive: Drive) =>
    !drive.statsStatus || drive.statsStatus === "completed"

  function itemMenu(item: StorageItem) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={"Actions for " + item.name}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={busy}
              onSelect={() => void openItem(item)}
            >
              <ExternalLink />
              Open
            </DropdownMenuItem>
            {item.type === "file" && (
              <DropdownMenuItem asChild>
                <a href={fileLink(driveName, item.key, true, accountId)}>
                  <Download />
                  Download
                </a>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => void copyLink(item)}>
              <Copy />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setDetails({ item })}>
              <Info />
              Properties
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onSelect={() => setDeleteTarget(item)}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  if (drivesLoading && !snapshot) return <StoragePageSkeleton />

  return (
    <DashboardPage className="dashboard-motion-stage">
      <DashboardPageHeader
        className="dashboard-motion-item"
        title="Storage"
        description={
          snapshot
            ? (snapshot.activeAccount.label || snapshot.activeAccount.email) +
              " · " +
              snapshot.buckets.length +
              " drives · " +
              formatBytes(snapshot.totalBytes) +
              " used"
            : "Your drives, folders and files in one place."
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => refresh()}
              disabled={busy || drivesLoading || objectsLoading}
            >
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={!accountId || busy || Boolean(drivesError)}>
                  <Plus data-icon="inline-start" />
                  New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onSelect={() => openCreate("drive")}>
                    <HardDrive />
                    New drive
                  </DropdownMenuItem>
                  {!isRoot && (
                    <>
                      <DropdownMenuItem onSelect={() => openCreate("folder")}>
                        <FolderPlus />
                        New folder
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => openCreate("file")}>
                        <File />
                        New file
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => fileInput.current?.click()}
                      >
                        <Upload />
                        Upload files
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            {!isRoot && (
              <Button
                disabled={busy || Boolean(drivesError)}
                onClick={() => fileInput.current?.click()}
              >
                <Upload data-icon="inline-start" />
                Upload files
              </Button>
            )}
          </>
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files || [])
          event.currentTarget.value = ""
          void uploadFiles(files)
        }}
      />
      <DashboardPanel className="dashboard-motion-item dashboard-motion-delay-1">
        <div className="flex min-w-0 flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Up one level"
              title="Up one level"
              disabled={isRoot || busy}
              onClick={() => navigate(prefix ? driveName : "", parentPrefix)}
            >
              <ArrowUp />
            </Button>
            <Breadcrumb className="min-w-0 overflow-x-auto">
              <BreadcrumbList className="flex-nowrap whitespace-nowrap">
                <BreadcrumbItem>
                  {isRoot ? (
                    <BreadcrumbPage>My drives</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <button disabled={busy} onClick={() => navigate()}>
                        My drives
                      </button>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isRoot && (
                  <>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      {!prefix ? (
                        <BreadcrumbPage>{driveName}</BreadcrumbPage>
                      ) : (
                        <BreadcrumbLink asChild>
                          <button
                            disabled={busy}
                            onClick={() => navigate(driveName)}
                          >
                            {driveName}
                          </button>
                        </BreadcrumbLink>
                      )}
                    </BreadcrumbItem>
                  </>
                )}
                {!isRoot &&
                  prefix &&
                  pathParts.map((part, index) => (
                    <React.Fragment key={index}>
                      <BreadcrumbSeparator />
                      <BreadcrumbItem>
                        {index === pathParts.length - 1 ? (
                          <BreadcrumbPage>
                            {part || "(unnamed folder)"}
                          </BreadcrumbPage>
                        ) : (
                          <BreadcrumbLink asChild>
                            <button
                              disabled={busy}
                              onClick={() =>
                                navigate(
                                  driveName,
                                  pathParts.slice(0, index + 1).join("/") + "/"
                                )
                              }
                            >
                              {part || "(unnamed folder)"}
                            </button>
                          </BreadcrumbLink>
                        )}
                      </BreadcrumbItem>
                    </React.Fragment>
                  ))}
              </BreadcrumbList>
            </Breadcrumb>
          </div>
          <div className="flex w-full items-center gap-2 lg:w-auto">
            <InputGroup className="min-w-0 flex-1 lg:w-64">
              <InputGroupAddon>
                <Search />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={
                  isRoot ? "Search drives" : "Search loaded files and folders"
                }
                placeholder={isRoot ? "Search drives" : "Search this folder"}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(1)
                }}
              />
              {query && (
                <InputGroupAddon align="inline-end">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Clear search"
                    onClick={() => {
                      setQuery("")
                      setPage(1)
                    }}
                  >
                    <X />
                  </Button>
                </InputGroupAddon>
              )}
            </InputGroup>
            <ToggleGroup
              type="single"
              variant="outline"
              value={view}
              onValueChange={(value) => {
                if (value === "grid" || value === "list") setView(value)
              }}
              aria-label="View"
            >
              <ToggleGroupItem value="grid" aria-label="Grid view">
                <Grid2X2 />
              </ToggleGroupItem>
              <ToggleGroupItem value="list" aria-label="List view">
                <List />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            {isRoot ? (
              <HardDrive className="size-4 text-muted-foreground" />
            ) : (
              <Folder className="size-4 text-muted-foreground" />
            )}
            <h2 className="text-sm font-medium">
              {isRoot ? "Drives" : "Folders & files"}
            </h2>
            <Badge variant="secondary">
              {count}
              {!isRoot && nextToken ? "+" : ""}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isRoot && (
              <Select
                value={kind}
                onValueChange={(value) => {
                  setKind(value as Kind)
                  setPage(1)
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-32"
                  aria-label="File type"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All types</SelectItem>
                    {Object.entries(kindLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label === "Folder" ? "Folders" : label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            )}
            <Select
              value={sort}
              onValueChange={(value) => {
                setSort(value)
                setPage(1)
              }}
            >
              <SelectTrigger size="sm" className="w-36" aria-label="Sort by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="name-asc">Name A–Z</SelectItem>
                  <SelectItem value="name-desc">Name Z–A</SelectItem>
                  <SelectItem value="size-desc">Largest first</SelectItem>
                  {!isRoot && (
                    <SelectItem value="modified-desc">Newest first</SelectItem>
                  )}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        {activeError && (
          <Alert variant="destructive" className="mx-4 mb-4 w-auto">
            <Info />
            <AlertTitle>
              {isRoot ? "Could not load drives" : "Could not load this folder"}
            </AlertTitle>
            <AlertDescription>
              <p>{activeError}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    drivesError ||
                    objectsError.includes("active account changed")
                      ? void refresh()
                      : void loadItems(retryToken.current)
                  }
                  disabled={drivesLoading || objectsLoading}
                >
                  Try again
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/dashboard/accounts">Manage accounts</Link>
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}
        {uploadStatus && (
          <div
            role="status"
            aria-live="polite"
            className="mx-4 mb-4 flex flex-col gap-2 rounded-xl border bg-muted/30 p-3"
          >
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Loader2 className="size-4 shrink-0 animate-spin" />
              <span className="truncate">Uploading {uploadStatus.name}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                {uploadStatus.done} / {uploadStatus.total} complete
              </span>
            </div>
            <Progress
              value={(uploadStatus.done / uploadStatus.total) * 100}
              aria-label="Completed uploads"
              className="h-1"
            />
          </div>
        )}
        <div
          aria-busy={loading || drivesLoading}
          className="min-h-[320px] px-3 pb-4 sm:px-4"
        >
          {loading && !visibleItems.length ? (
            <div
              className={cn(
                "grid gap-3",
                view === "grid" && "sm:grid-cols-2 xl:grid-cols-3"
              )}
            >
              {Array.from({ length: 6 }, (_, index) => (
                <Skeleton
                  key={index}
                  className={cn(
                    "w-full rounded-xl",
                    view === "grid" ? "h-32" : "h-14"
                  )}
                />
              ))}
              <span role="status" className="sr-only">
                Loading folder
              </span>
            </div>
          ) : count === 0 && !activeError ? (
            <Empty className="min-h-72">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  {hasFilter ? <Search /> : isRoot ? <HardDrive /> : <Folder />}
                </EmptyMedia>
                <EmptyTitle>
                  {hasFilter
                    ? "No matches found"
                    : isRoot
                      ? "Your drives belong here"
                      : "This folder is empty"}
                </EmptyTitle>
                <EmptyDescription>
                  {hasFilter
                    ? "Try a different name or clear your filters."
                    : isRoot
                      ? "Create a drive to start organizing your files."
                      : "Upload your first file or create a folder to get started."}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                {hasFilter ? (
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuery("")
                      setKind("all")
                    }}
                  >
                    Clear filters
                  </Button>
                ) : (
                  <Button
                    disabled={busy || !accountId}
                    onClick={() =>
                      isRoot ? openCreate("drive") : fileInput.current?.click()
                    }
                  >
                    {isRoot ? <Plus /> : <Upload />}
                    {isRoot ? "New drive" : "Upload files"}
                  </Button>
                )}
              </EmptyContent>
            </Empty>
          ) : isRoot ? (
            <div
              className={cn(
                "grid gap-3",
                view === "grid"
                  ? "sm:grid-cols-2 xl:grid-cols-3"
                  : "grid-cols-1"
              )}
            >
              {pageDrives.map((drive) => {
                const ready = statsReady(drive)
                const share = Math.min(
                  100,
                  Math.max(
                    0,
                    snapshot!.totalBytes > 0
                      ? (drive.bytes / snapshot!.totalBytes) * 100
                      : 0
                  )
                )
                return (
                  <ContextMenu key={drive.id}>
                    <ContextMenuTrigger asChild>
                      <button
                        disabled={busy}
                        onClick={() => navigate(drive.name)}
                        className={cn(
                          "group flex min-w-0 items-center gap-4 rounded-2xl border bg-card/60 p-4 text-left outline-none transition-colors duration-150 hover:border-primary/30 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                          view === "list" && "sm:gap-5"
                        )}
                      >
                        <div className="flex size-14 shrink-0 items-center justify-center rounded-xl border bg-muted/50">
                          <HardDrive
                            aria-hidden="true"
                            className="size-8 text-primary/80"
                            strokeWidth={1.25}
                          />
                        </div>
                        <div className="flex min-w-0 flex-1 flex-col gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              title={drive.name}
                              className="truncate text-sm font-medium"
                            >
                              {drive.name}
                            </span>
                            <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
                          </div>
                          <Progress
                            value={ready ? share : 0}
                            aria-label={
                              drive.name + ": share of account storage used"
                            }
                            className="h-1.5"
                          />
                          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {ready
                                ? formatBytes(drive.bytes) + " used"
                                : drive.statsStatus === "error"
                                  ? "Usage unavailable"
                                  : "Calculating usage"}
                            </span>
                            <span>
                              {ready
                                ? drive.objects.toLocaleString() + " items"
                                : "You can still open this drive"}
                            </span>
                          </div>
                        </div>
                      </button>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuGroup>
                        <ContextMenuItem
                          disabled={busy}
                          onSelect={() => navigate(drive.name)}
                        >
                          Open drive
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => setDetails({ drive })}>
                          Properties
                        </ContextMenuItem>
                      </ContextMenuGroup>
                    </ContextMenuContent>
                  </ContextMenu>
                )
              })}
            </div>
          ) : view === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {pageItems.map((item) => (
                <ContextMenu key={item.id}>
                  <ContextMenuTrigger asChild>
                    <div
                      className={cn(
                        "group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card/60 transition-colors duration-150 hover:bg-accent/30",
                        selected === item.id && "border-primary/40 bg-accent/40"
                      )}
                    >
                      <button
                        disabled={busy}
                        onClick={() => {
                          setSelected(item.id)
                          void openItem(item)
                        }}
                        className="flex min-w-0 flex-1 flex-col gap-4 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <ItemIcon item={item} large />
                        <span
                          className="w-full truncate text-sm font-medium"
                          title={item.name}
                        >
                          {item.name || "(unnamed folder)"}
                        </span>
                      </button>
                      <div className="flex items-center justify-between gap-2 px-4 pb-2">
                        <span className="truncate text-xs text-muted-foreground">
                          {item.type === "folder"
                            ? "Folder"
                            : kindLabels[fileKind(item)] +
                              " · " +
                              formatBytes(item.bytes)}
                        </span>
                        {itemMenu(item)}
                      </div>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuGroup>
                      <ContextMenuItem
                        disabled={busy}
                        onSelect={() => void openItem(item)}
                      >
                        Open
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => void copyLink(item)}>
                        Copy link
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => setDetails({ item })}>
                        Properties
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={busy}
                        onSelect={() => setDeleteTarget(item)}
                      >
                        Delete
                      </ContextMenuItem>
                    </ContextMenuGroup>
                  </ContextMenuContent>
                </ContextMenu>
              ))}
            </div>
          ) : (
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[55%] sm:w-[45%]">Name</TableHead>
                  <TableHead className="hidden sm:table-cell">
                    Modified
                  </TableHead>
                  <TableHead className="hidden lg:table-cell">Type</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-12">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((item) => (
                  <TableRow
                    key={item.id}
                    data-state={selected === item.id ? "selected" : undefined}
                    onClick={() => setSelected(item.id)}
                    className="h-14"
                  >
                    <TableCell>
                      <button
                        disabled={busy}
                        onClick={() => void openItem(item)}
                        className="flex w-full min-w-0 items-center gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <ItemIcon item={item} />
                        <span
                          className="truncate font-medium"
                          title={item.name}
                        >
                          {item.name || "(unnamed folder)"}
                        </span>
                      </button>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      {modifiedLabel(item.uploaded)}
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                      {kindLabels[fileKind(item)]}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {item.type === "folder" ? "—" : formatBytes(item.bytes)}
                    </TableCell>
                    <TableCell onClick={(event) => event.stopPropagation()}>
                      {itemMenu(item)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <Separator />
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs text-muted-foreground">
          <div className="flex flex-col gap-1" role="status" aria-live="polite">
            <span>
              {isRoot
                ? count + " drives"
                : folders +
                  " folders · " +
                  (visibleItems.length - folders) +
                  " files loaded"}
              {hasFilter ? " · " + count + " matches" : ""}
              {loading ? " · Updating…" : ""}
            </span>
            {isRoot ? (
              <span>Bars show each drive’s share of storage used.</span>
            ) : (
              nextToken && (
                <span>
                  Search and sorting cover loaded items. Load more to include
                  the rest.
                </span>
              )
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isRoot && nextToken && (
              <Button
                size="sm"
                variant="outline"
                disabled={objectsLoading || busy}
                onClick={() => void loadItems(nextToken)}
              >
                {objectsLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Plus />
                )}
                Load more
              </Button>
            )}
            <Select
              value={pageSize}
              onValueChange={(value) => {
                setPageSize(value)
                setPage(1)
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-28"
                aria-label="Items per page"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {["20", "50", "100", "200"].map((size) => (
                    <SelectItem value={size} key={size}>
                      {size} / page
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous page"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              <ArrowLeft />
            </Button>
            <span className="tabular-nums">
              {safePage} / {pageCount}
            </span>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Next page"
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      </DashboardPanel>
      <Dialog
        open={Boolean(create)}
        onOpenChange={(open) => {
          if (!open && !busy) setCreate(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New {create}</DialogTitle>
            <DialogDescription>
              {create === "drive"
                ? "Choose a unique name for your drive. Use 3–63 lowercase letters, numbers or dashes."
                : "Create a " +
                  create +
                  " in " +
                  driveName +
                  (prefix ? " / " + prefix : "") +
                  "."}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void createItem()
            }}
            className="flex flex-col gap-5"
          >
            <FieldGroup>
              <Field data-invalid={Boolean(createError)}>
                <FieldLabel htmlFor="storage-name">
                  {create === "drive" ? "Drive name" : "Name"}
                </FieldLabel>
                <Input
                  id="storage-name"
                  autoFocus
                  autoComplete="off"
                  value={name}
                  disabled={busy}
                  aria-invalid={Boolean(createError)}
                  aria-describedby={
                    createError ? "storage-name-error" : undefined
                  }
                  placeholder={
                    create === "drive"
                      ? "my-drive"
                      : create === "folder"
                        ? "New folder"
                        : "notes.txt"
                  }
                  onChange={(event) => {
                    setName(event.target.value)
                    setCreateError("")
                  }}
                />
                {createError && (
                  <p
                    id="storage-name-error"
                    role="alert"
                    className="text-sm text-destructive"
                  >
                    {createError}
                  </p>
                )}
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setCreate(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy && <Loader2 className="animate-spin" />}Create {create}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "folder"
                ? "This permanently deletes the folder and all files inside it."
                : "This permanently deletes the file."}{" "}
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleteTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void deleteItem()}
            >
              {busy && <Loader2 className="animate-spin" />}Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={Boolean(details)}
        onOpenChange={(open) => {
          if (!open) setDetails(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Properties</DialogTitle>
            <DialogDescription className="break-all">
              {details &&
                ("drive" in details ? details.drive.name : details.item.name)}
            </DialogDescription>
          </DialogHeader>
          {details && (
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Type</dt>
              <dd>
                {"drive" in details
                  ? "Drive"
                  : kindLabels[fileKind(details.item)]}
              </dd>
              <dt className="text-muted-foreground">Size</dt>
              <dd>
                {"drive" in details
                  ? statsReady(details.drive)
                    ? formatBytes(details.drive.bytes)
                    : "Usage not yet available"
                  : details.item.type === "folder"
                    ? "—"
                    : formatBytes(details.item.bytes)}
              </dd>
              {"drive" in details ? (
                <>
                  <dt className="text-muted-foreground">Items</dt>
                  <dd>
                    {statsReady(details.drive)
                      ? details.drive.objects.toLocaleString()
                      : "—"}
                  </dd>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd>{modifiedLabel(details.drive.updatedAt || "")}</dd>
                </>
              ) : (
                <>
                  <dt className="text-muted-foreground">Modified</dt>
                  <dd>{modifiedLabel(details.item.uploaded)}</dd>
                  <dt className="text-muted-foreground">Path</dt>
                  <dd className="break-all">
                    {driveName}/{details.item.key}
                  </dd>
                </>
              )}
            </dl>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) {
            previewRequest.current++
            setPreview(null)
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(80dvh,800px)] w-[calc(100vw-2rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        >
          <div className="flex min-w-0 items-center gap-3 border-b p-3">
            <DialogHeader className="min-w-0 flex-1">
              <DialogTitle className="truncate">
                {preview?.item.name}
              </DialogTitle>
              <DialogDescription>
                {preview
                  ? kindLabels[fileKind(preview.item)] +
                    " · " +
                    formatBytes(preview.item.bytes)
                  : ""}
              </DialogDescription>
            </DialogHeader>
            {preview && (
              <>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Open file in new tab"
                  asChild
                >
                  <a
                    href={fileLink(
                      preview.drive,
                      preview.item.key,
                      false,
                      accountId
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink />
                  </a>
                </Button>
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label="Download file"
                  asChild
                >
                  <a
                    href={fileLink(
                      preview.drive,
                      preview.item.key,
                      true,
                      accountId
                    )}
                  >
                    <Download />
                  </a>
                </Button>
              </>
            )}
            <DialogClose asChild>
              <Button size="icon-sm" variant="ghost" aria-label="Close preview">
                <X />
              </Button>
            </DialogClose>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-muted/20 p-3">
            {preview?.error ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <File />
                  </EmptyMedia>
                  <EmptyTitle>Preview unavailable</EmptyTitle>
                  <EmptyDescription>{preview.error}</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button
                    variant="outline"
                    onClick={() => void openItem(preview.item)}
                  >
                    Try again
                  </Button>
                </EmptyContent>
              </Empty>
            ) : preview && !preview.url ? (
              <div
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                Preparing preview
              </div>
            ) : (
              preview?.url &&
              (fileKind(preview.item) === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={preview.url}
                  alt={preview.item.name}
                  onError={previewFailed}
                  className="max-h-full max-w-full object-contain"
                />
              ) : fileKind(preview.item) === "video" ? (
                <video
                  key={preview.url}
                  src={preview.url}
                  controls
                  className="h-full w-full object-contain"
                  onError={previewFailed}
                />
              ) : fileKind(preview.item) === "audio" ? (
                <audio
                  key={preview.url}
                  src={preview.url}
                  controls
                  className="w-full max-w-xl"
                  onError={previewFailed}
                />
              ) : preview.item.name.toLowerCase().endsWith(".pdf") ? (
                <iframe
                  src={preview.url}
                  title={preview.item.name}
                  className="h-full w-full border-0"
                />
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <FileText />
                    </EmptyMedia>
                    <EmptyTitle>No preview for this file type</EmptyTitle>
                    <EmptyDescription>
                      Download the file to open it in its app.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button asChild>
                      <a
                        href={fileLink(
                          preview.drive,
                          preview.item.key,
                          true,
                          accountId
                        )}
                      >
                        <Download />
                        Download
                      </a>
                    </Button>
                  </EmptyContent>
                </Empty>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
      {!isRoot && !currentDrive && !drivesLoading && !drivesError && (
        <p className="text-xs text-muted-foreground">
          Drive statistics are waiting for the next account sync.
        </p>
      )}
    </DashboardPage>
  )
}

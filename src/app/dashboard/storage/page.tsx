"use client"

import * as React from "react"
import {
  Folder,
  File,
  MoreHorizontal,
  Upload,
  Search,
  Grid2X2,
  List as ListIcon,
  HardDrive,
  ChevronRight,
  Home,
  ArrowLeft,
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
  const [totalUsedBytes, setTotalUsedBytes] = React.useState(0)
  const [bucketObjects, setBucketObjects] = React.useState<RawObject[]>([])
  const [objects, setObjects] = React.useState<FileItem[]>([])
  const [objectsLoading, setObjectsLoading] = React.useState(false)
  const [nextContinuationToken, setNextContinuationToken] = React.useState<string | null>(null)
  const [selectedDrives, setSelectedDrives] = React.useState<string[]>([])
  const [selectedItems, setSelectedItems] = React.useState<string[]>([])
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const [propertiesTarget, setPropertiesTarget] =
    React.useState<PropertiesTarget | null>(null)
  const [createBucketOpen, setCreateBucketOpen] = React.useState(false)
  const [newBucketName, setNewBucketName] = React.useState("")
  const [newBucketError, setNewBucketError] = React.useState<string | null>(null)
  const [creatingBucket, setCreatingBucket] = React.useState(false)

  const loadActiveAndBuckets = React.useCallback(async () => {
    try {
      const [accountsRes, bucketsRes] = await Promise.all([
        fetch("/api/accounts"),
        fetch("/api/storage/buckets"),
      ])

      if (accountsRes.ok) {
        const data = await accountsRes.json()
        const accounts: any[] = data.accounts ?? []
        const active = accounts.find((a) => a.status === "active")
        if (active) {
          setActiveAccount({
            id: active.id,
            label: active.label ?? "",
            email: active.email ?? "",
            status: active.status ?? "available",
          })
        } else {
          setActiveAccount(null)
        }
      }

      if (bucketsRes.ok) {
        const data = await bucketsRes.json()
        const buckets: any[] = data.buckets ?? []
        const totalBytes: number = data.totalBytes ?? 0
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
  
  const navigateToDrive = (driveName: string) => {
    setCurrentPath([driveName])
    setSelectedDrives([])
    setSelectedItems([])
    loadObjectsForPath([driveName])
  }

  const navigateUp = () => {
    setCurrentPath((prev) => {
      const next = prev.slice(0, -1)
      setSelectedItems([])
      if (next.length === 0) {
        setObjects([])
        setBucketObjects([])
        setNextContinuationToken(null)
      } else {
        void loadObjectsForPath(next)
      }
      return next
    })
  }

  const navigateToFolder = (folderName: string) => {
    setCurrentPath((prev) => {
      const next = [...prev, folderName]
      void loadObjectsForPath(next)
      return next
    })
  }

  const isRoot = currentPath.length === 0
  const hasItems = objects.length > 0

  const handleDriveClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    drive: Drive
  ) => {
    const multi = event.metaKey || event.ctrlKey || event.shiftKey
    setSelectedItems([])
    setSelectedDrives((prev) => {
      if (multi) {
        return prev.includes(drive.id)
          ? prev.filter((id) => id !== drive.id)
          : [...prev, drive.id]
      }
      return [drive.id]
    })
  }

  const handleDriveDoubleClick = (drive: Drive) => {
    navigateToDrive(drive.name)
  }

  const handleItemClick = (
    event: React.MouseEvent<HTMLButtonElement | HTMLTableRowElement>,
    item: FileItem
  ) => {
    const multi = event.metaKey || event.ctrlKey || event.shiftKey
    setSelectedDrives([])
    setSelectedItems((prev) => {
      if (multi) {
        return prev.includes(item.id)
          ? prev.filter((id) => id !== item.id)
          : [...prev, item.id]
      }
      return [item.id]
    })
  }

  const handleItemDoubleClick = (item: FileItem) => {
    if (item.type === "folder") {
      navigateToFolder(item.name)
      return
    }
    // TODO: open file preview or download
  }

  const loadMore = async () => {
    if (!nextContinuationToken) return
    if (!currentPath[0]) return
    await loadObjectsForPath(currentPath, "append")
  }

  const loadObjectsForPath = async (path: string[], mode?: "append") => {
    const bucketName = path[0] ?? ""
    if (!bucketName) return
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
      if (!res.ok) {
        setBucketObjects([])
        setObjects([])
        setNextContinuationToken(null)
        return
      }
      const data: ObjectsResponse = await res.json()

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
      setBucketObjects([])
      setObjects([])
      setNextContinuationToken(null)
    } finally {
      setObjectsLoading(false)
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
    } catch (error: any) {
      setNewBucketError(error?.message ?? "Network error while creating bucket")
    } finally {
      setCreatingBucket(false)
    }
  }

  const showDrivesPanel = isRoot

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
              disabled={creatingBucket || !newBucketName.trim()}
            >
              {creatingBucket ? "Creating…" : "Create drive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-center justify-between border-b pb-4 px-1">
        <div className="flex items-center gap-2 flex-1 mr-4">
             <Button variant="ghost" size="icon" disabled={isRoot} onClick={navigateUp}>
                <ArrowLeft className="h-4 w-4" />
             </Button>
             
             <div className="flex items-center gap-1 border rounded-md px-3 h-9 bg-background flex-1 max-w-2xl text-sm">
                <Button variant="ghost" size="icon" className="h-6 w-6 p-0" onClick={() => setCurrentPath([])}>
                     <Home className="h-4 w-4 text-muted-foreground" />
                </Button>
                {currentPath.map((segment, index) => (
                    <React.Fragment key={`${segment}-${index}`}>
                         <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
                         <span 
                            className={cn("cursor-pointer hover:bg-accent/50 px-1 rounded", index === currentPath.length -1 ? "font-medium" : "text-muted-foreground")}
                         >
                            {segment}
                         </span>
                    </React.Fragment>
                ))}
             </div>
       </div>

       <div className="flex items-center gap-2">
             <div className="relative w-64 hidden md:block">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input 
                    placeholder="Search this drive" 
                    className="pl-8"
                />
             </div>
             <div className="flex rounded-md border bg-muted/40">
                <Button 
                    variant={view === "list" ? "secondary" : "ghost"}
                    size="icon"
                    className="rounded-none"
                    onClick={() => setView("list")}
                >
                    <ListIcon className="h-4 w-4" />
                </Button>
                <Button 
                    variant={view === "grid" ? "secondary" : "ghost"}
                    size="icon"
                    className="rounded-none"
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
                   await loadObjectsForPath([bucketName])
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
            ? "grid grid-cols-[260px,1fr] gap-4 py-4 flex-1 min-h-0"
            : "grid grid-cols-1 gap-4 py-4 flex-1 min-h-0"
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
                  {drives.map((drive) => {
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
                      "group flex w-64 flex-col gap-2 rounded-lg border bg-card p-3 text-left hover:bg-accent/60",
                      (isCurrent || isSelected) && "border-primary bg-primary/5"
                    )}
                    onClick={(e) => handleDriveClick(e, drive)}
                    onDoubleClick={() => handleDriveDoubleClick(drive)}
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
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
                      "group flex w-full gap-4 px-4 py-2 rounded-lg border bg-card hover:bg-accent/40 transition-colors text-left",
                      (isCurrent || isSelected) && "border-primary bg-primary/5"
                    )}
                    onClick={(e) => handleDriveClick(e, drive)}
                    onDoubleClick={() => handleDriveDoubleClick(drive)}
                  >
                    <div className="mt-1">
                      <HardDrive className="h-5 w-5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-medium text-foreground truncate">
                          {drive.name}
                        </span>
                        <span className="text-muted-foreground">
                          {formatBytes(drive.usedBytes)} used
                        </span>
                      </div>
                      <Progress value={percent} className="h-1.5" />
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
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
              <ContextMenuItem
                onClick={() => {
                  setNewBucketName("")
                  setNewBucketError(null)
                  setCreateBucketOpen(true)
                }}
              >
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

        <div className="flex flex-col gap-4 min-h-0">
            {hasItems && (
              <>
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {isRoot ? "This PC" : currentPath.join(" / ")}
                  </h2>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>New folder</DropdownMenuItem>
                      <DropdownMenuItem>New bucket</DropdownMenuItem>
                      <DropdownMenuItem>Sync settings</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {view === "grid" ? (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {objects.map((item) => {
                      const isFolder = item.type === "folder"
                      const Icon = isFolder ? Folder : File
                      const isSelected = selectedItems.includes(item.id)

                      return (
                        <ContextMenu key={item.id}>
                          <ContextMenuTrigger asChild>
                            <button
                              onClick={(e) => handleItemClick(e, item)}
                              onDoubleClick={() => handleItemDoubleClick(item)}
                              className={cn(
                                "group flex flex-col items-start gap-2 rounded-lg border bg-card p-3 text-left hover:bg-accent/60",
                                isSelected && "border-primary bg-primary/5"
                              )}
                            >
                              <div className="flex items-center justify-between w-full gap-2">
                                <div className="flex items-center gap-2">
                                  <div
                                    className={cn(
                                      "flex h-8 w-8 items-center justify-center rounded-md border bg-muted",
                                      isFolder && "bg-blue-500/10 text-blue-500"
                                    )}
                                  >
                                    <Icon className="h-4 w-4" />
                                  </div>
                                  <div className="flex flex-col">
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
                              <div className="flex w-full items-center justify-between text-xs text-muted-foreground">
                                <span>{item.modified}</span>
                                {!isFolder && <span>{item.size}</span>}
                              </div>
                            </button>
                          </ContextMenuTrigger>
                          <ContextMenuContent>
                            <ContextMenuItem
                              onClick={() => handleItemDoubleClick(item)}
                            >
                              Open
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                              onClick={() =>
                                setPropertiesTarget({ type: "item", item })
                              }
                            >
                              Properties
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
                      <div className="rounded-md border bg-card">
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
                        {objects.map((item) => {
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
                                  onDoubleClick={() => handleItemDoubleClick(item)}
                                >
                                  <TableCell className="flex items-center gap-2">
                                    {isFolder ? (
                                      <Folder className="h-4 w-4 text-blue-500" />
                                    ) : (
                                      <File className="h-4 w-4 text-muted-foreground" />
                                    )}
                                    <span>{item.name}</span>
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
                                  Open
                                </ContextMenuItem>
                                <ContextMenuSeparator />
                                <ContextMenuItem disabled>
                                  New folder – TODO
                                </ContextMenuItem>
                                <ContextMenuItem disabled>
                                  New file – TODO
                                </ContextMenuItem>
                                <ContextMenuItem disabled>
                                  Upload files – TODO
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

                {!isRoot && nextContinuationToken && (
                  <div className="flex justify-center pt-2">
                    <Button variant="outline" onClick={loadMore} disabled={objectsLoading}>
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )}
        </div>
      </div>
    </div>
  )
}

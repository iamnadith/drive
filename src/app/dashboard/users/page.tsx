"use client"

import * as React from "react"
import {
  ColumnDef,
} from "@tanstack/react-table"
import {
  MoreHorizontal,
  Plus,
  Shield,
  HardDrive,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useAuth } from "@/components/auth-provider"
import { DashboardDataTable } from "@/components/dashboard/data-table"
import {
  DashboardPage,
  DashboardPageHeader,
  DashboardPageSkeleton,
} from "@/components/dashboard/page-shell"
import { DashboardSearchFilterToolbar, DASHBOARD_TOOLBAR_ACTION_BUTTON_CLASS, type SearchFilterOption } from "@/components/dashboard/search-filter-toolbar"
import { formatLastSyncedAt } from "@/lib/dashboard-format"

type UserRow = {
  id: string
  name: string
  username?: string
  email: string
  role: "superadmin" | "admin" | "user"
  status: "active" | "disabled"
  quotaUsedMb: number
  quotaLimitMb: number
  profileImageUrl?: string
  googleLinked?: boolean
}

const PAGE_SIZE = 10
type UserStats = { total: number; active: number; disabled: number; privileged: number; activeSuperadmins: number }

export default function UsersPage() {
  const [mounted, setMounted] = React.useState(false)
  const [usersLoading, setUsersLoading] = React.useState(true)
  const [lastSyncedAt, setLastSyncedAt] = React.useState<string | null>(null)
  const [users, setUsers] = React.useState<UserRow[]>([])
  const [userStats, setUserStats] = React.useState<UserStats>({ total: 0, active: 0, disabled: 0, privileged: 0, activeSuperadmins: 0 })
  const [pageIndex, setPageIndex] = React.useState(0)
  const [pageCount, setPageCount] = React.useState(1)
  const [search, setSearch] = React.useState("")
  const [roleFilter, setRoleFilter] = React.useState<
    "" | "superadmin" | "admin" | "user"
  >("")
  const [statusFilter, setStatusFilter] = React.useState<
    "" | "active" | "disabled"
  >("")
  const [isDialogOpen, setIsDialogOpen] = React.useState(false)
  const [isQuotaOnly, setIsQuotaOnly] = React.useState(false)
  const { user: currentUser } = useAuth()

  const reloadUsers = React.useCallback(async (signal?: AbortSignal) => {
    setUsersLoading(true)
    try {
      const params = new URLSearchParams({ page: String(pageIndex), limit: String(PAGE_SIZE) })
      if (search.trim()) params.set("q", search.trim())
      if (roleFilter) params.set("role", roleFilter)
      if (statusFilter) params.set("status", statusFilter)
      const res = await fetch(`/api/users?${params.toString()}`, { cache: "no-store", signal })
      const data = await res.json().catch(() => ({})) as {
        users?: UserRow[]
        stats?: UserStats
        pagination?: { pageCount?: number }
        error?: string
      }
      if (!res.ok) throw new Error(data.error || "Unable to load users")
      const nextPageCount = Math.max(1, Number(data.pagination?.pageCount) || 1)
      setUsers(Array.isArray(data.users) ? data.users : [])
      setUserStats(data.stats ?? { total: 0, active: 0, disabled: 0, privileged: 0, activeSuperadmins: 0 })
      setPageCount(nextPageCount)
      if (pageIndex >= nextPageCount) setPageIndex(nextPageCount - 1)
      setLastSyncedAt(new Date().toISOString())
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return
      toast.error(error instanceof Error ? error.message : "Unable to load users")
    } finally {
      if (!signal?.aborted) setUsersLoading(false)
    }
  }, [pageIndex, roleFilter, search, statusFilter])

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (!mounted) return
    const controller = new AbortController()
    const debounce = window.setTimeout(() => void reloadUsers(controller.signal), 250)
    return () => {
      window.clearTimeout(debounce)
      controller.abort()
    }
  }, [mounted, reloadUsers])

  const [formState, setFormState] = React.useState<{
    id?: string
    firstName: string
    lastName: string
    username: string
    email: string
    role: "superadmin" | "admin" | "user"
    status: "active" | "disabled"
    quotaLimitMb: number
    quotaUnit: "MB" | "GB" | "UNLIMITED"
    profileImageUrl: string
    password: string
    googleLinked: boolean
  }>({
    firstName: "",
    lastName: "",
    username: "",
    email: "",
    role: "user",
    status: "active",
    quotaLimitMb: 500,
    quotaUnit: "MB",
    profileImageUrl: "",
    password: "",
    googleLinked: false,
  })

  const [originalEmail, setOriginalEmail] = React.useState("")
  const [originalUsername, setOriginalUsername] = React.useState("")
  const [usernameStatus, setUsernameStatus] = React.useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle")
  const [usernameHint, setUsernameHint] = React.useState("")
  const [emailStatus, setEmailStatus] = React.useState<
    "idle" | "checking" | "available" | "taken" | "error"
  >("idle")
  const [emailHint, setEmailHint] = React.useState("")
  const [confirmPassword, setConfirmPassword] = React.useState("")
  const [changePassword, setChangePassword] = React.useState(false)
  const [passwordHint, setPasswordHint] = React.useState("")
  const [passwordStrong, setPasswordStrong] = React.useState(false)

  const resizeImageToUnderLimit = React.useCallback(
    async (file: File, maxBytes = 2 * 1024 * 1024, maxDimension = 512) => {
      const readFileAsDataUrl = (f: File): Promise<string> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result
            if (typeof result === "string") {
              resolve(result)
            } else {
              reject(new Error("Unable to read file"))
            }
          }
          reader.onerror = () => reject(new Error("Unable to read file"))
          reader.readAsDataURL(f)
        })

      const initialDataUrl = await readFileAsDataUrl(file)
      const approxBytes = Math.ceil((initialDataUrl.length * 3) / 4)
      if (approxBytes <= maxBytes) {
        return initialDataUrl
      }

      return new Promise<string>((resolve, reject) => {
        const img = new Image()
        img.onload = () => {
          try {
            const canvas = document.createElement("canvas")
            const ctx = canvas.getContext("2d")
            if (!ctx) {
              reject(new Error("Canvas not supported"))
              return
            }

            let width = img.width
            let height = img.height

            const scale = Math.min(1, maxDimension / Math.max(width, height))
            width = Math.max(1, Math.floor(width * scale))
            height = Math.max(1, Math.floor(height * scale))

            canvas.width = width
            canvas.height = height
            ctx.drawImage(img, 0, 0, width, height)

            let quality = 0.9
            let output = canvas.toDataURL("image/jpeg", quality)

            while (output.length * 0.75 > maxBytes && quality > 0.4) {
              quality -= 0.1
              output = canvas.toDataURL("image/jpeg", quality)
            }

            resolve(output)
          } catch (err) {
            reject(err instanceof Error ? err : new Error("Resize failed"))
          }
        }
        img.onerror = () => reject(new Error("Unable to load image"))
        img.src = initialDataUrl
      })
    },
    []
  )

  const evaluatePassword = React.useCallback((value: string) => {
    if (!value) {
      setPasswordHint("")
      setPasswordStrong(false)
      return
    }
    const lengthOk = value.length >= 8
    const hasLetter = /[A-Za-z]/.test(value)
    const hasNumber = /[0-9]/.test(value)

    const strong = lengthOk && hasLetter && hasNumber
    setPasswordStrong(strong)

    if (!lengthOk) {
      setPasswordHint("Password should be at least 8 characters long.")
    } else if (!hasLetter) {
      setPasswordHint("Use at least one letter (A-Z).")
    } else if (!hasNumber) {
      setPasswordHint("Add at least one number.")
    } else {
      setPasswordHint("Strong password.")
    }
  }, [])
  // Live username availability check
  React.useEffect(() => {
    const value = formState.username.trim()
    if (!value) {
      setUsernameStatus("idle")
      setUsernameHint("")
      return
    }
    if (value === originalUsername.trim()) {
      setUsernameStatus("available")
      setUsernameHint("Current username")
      return
    }
    if (value.includes("@")) {
      setUsernameStatus("error")
      setUsernameHint("Username cannot be an email address")
      return
    }
    setUsernameStatus("checking")
    setUsernameHint("Checking username availability…")

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/username-available?username=${encodeURIComponent(
            value
          )}`,
          { signal: controller.signal }
        )
        const data = await res.json()
        if (!res.ok) {
          setUsernameStatus("error")
          setUsernameHint(data.error ?? "Unable to check username")
          return
        }
        if (data.available) {
          setUsernameStatus("available")
          setUsernameHint("Username is available")
        } else {
          setUsernameStatus("taken")
          setUsernameHint("Username is already taken")
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setUsernameStatus("error")
          setUsernameHint("Unable to check username")
        }
      }
    }, 400)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [formState.username, originalUsername])

  // Live email availability check
  React.useEffect(() => {
    const value = formState.email.trim()
    if (!value) {
      setEmailStatus("idle")
      setEmailHint("")
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setEmailStatus("error")
      setEmailHint("Please enter a valid email address.")
      return
    }
    if (value === originalEmail.trim()) {
      setEmailStatus("available")
      setEmailHint("Current email")
      return
    }

    setEmailStatus("checking")
    setEmailHint("Checking email availability…")

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/email-available?email=${encodeURIComponent(value)}`,
          { signal: controller.signal }
        )
        const data = await res.json()
        if (!res.ok) {
          setEmailStatus("error")
          setEmailHint(data.error ?? "Unable to check email")
          return
        }
        if (data.available) {
          setEmailStatus("available")
          setEmailHint("Email is available")
        } else {
          setEmailStatus("taken")
          setEmailHint("That email is already registered")
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setEmailStatus("error")
          setEmailHint("Unable to check email")
        }
      }
    }, 400)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [formState.email, originalEmail])

  const openAddDialog = React.useCallback(() => {
    setFormState({
      firstName: "",
      lastName: "",
      username: "",
      email: "",
      role: "user",
      status: "active",
      quotaLimitMb: 500,
      quotaUnit: "MB",
      profileImageUrl: "",
      password: "",
      googleLinked: false,
    })
    setOriginalEmail("")
    setOriginalUsername("")
    setUsernameStatus("idle")
    setUsernameHint("")
    setEmailStatus("idle")
    setEmailHint("")
    setConfirmPassword("")
    setChangePassword(true)
    setPasswordHint("")
    setPasswordStrong(false)
    setIsQuotaOnly(false)
    setIsDialogOpen(true)
  }, [])

  const openEditDialog = React.useCallback((userRow: UserRow) => {
    const existingLimitMb = userRow.quotaLimitMb
    let quotaUnit: "MB" | "GB" | "UNLIMITED" = "MB"
    if (existingLimitMb <= 0) {
      quotaUnit = "UNLIMITED"
    } else if (existingLimitMb % 1024 === 0) {
      quotaUnit = "GB"
    }

    const nameParts = userRow.name.split(" ")
    const firstName = nameParts[0] ?? ""
    const lastName = nameParts.slice(1).join(" ")
    const username = userRow.username ?? ""

    setFormState({
      id: userRow.id,
      firstName,
      lastName,
      username,
      email: userRow.email,
      role: userRow.role,
      status: userRow.status,
      quotaLimitMb: existingLimitMb,
      quotaUnit,
      profileImageUrl: userRow.profileImageUrl || "",
      password: "",
      googleLinked: !!userRow.googleLinked,
    })
    setOriginalEmail(userRow.email)
    setOriginalUsername(username)
    setUsernameStatus("idle")
    setUsernameHint("")
    setEmailStatus("idle")
    setEmailHint("")
    setConfirmPassword("")
    setChangePassword(false)
    setPasswordHint("")
    setPasswordStrong(false)
    setIsQuotaOnly(false)
    setIsDialogOpen(true)
  }, [])

  const openQuotaDialog = React.useCallback((userRow: UserRow) => {
    const existingLimitMb = userRow.quotaLimitMb
    let quotaUnit: "MB" | "GB" | "UNLIMITED" = "MB"
    if (existingLimitMb <= 0) {
      quotaUnit = "UNLIMITED"
    } else if (existingLimitMb % 1024 === 0) {
      quotaUnit = "GB"
    }

    setFormState((prev) => {
      const nameParts = userRow.name.split(" ")
      const firstName = nameParts[0] ?? ""
      const lastName = nameParts.slice(1).join(" ")
      return {
        ...prev,
        id: userRow.id,
        firstName,
        lastName,
        username: userRow.username ?? "",
        email: userRow.email,
        role: userRow.role,
        status: userRow.status,
        quotaLimitMb: existingLimitMb,
        quotaUnit,
        profileImageUrl: userRow.profileImageUrl || "",
        password: "",
      }
    })
    setOriginalEmail(userRow.email)
    setOriginalUsername(userRow.username ?? "")
    setUsernameStatus("idle")
    setUsernameHint("")
    setEmailStatus("idle")
    setEmailHint("")
    setConfirmPassword("")
    setChangePassword(false)
    setPasswordHint("")
    setPasswordStrong(false)
    setIsQuotaOnly(true)
    setIsDialogOpen(true)
  }, [])

  const activeSuperAdminCount = userStats.activeSuperadmins
  const userFilters: SearchFilterOption[] = [
    { key: "role", label: "Role", type: "select", defaultValue: "all", options: [
      { value: "all", label: "All roles" },
      { value: "superadmin", label: "Super Admin" },
      { value: "admin", label: "Admin" },
      { value: "user", label: "User" },
    ] },
    { key: "status", label: "Status", type: "select", defaultValue: "all", options: [
      { value: "all", label: "All statuses" },
      { value: "active", label: "Active" },
      { value: "disabled", label: "Disabled" },
    ] },
  ]

  const columns: ColumnDef<UserRow>[] = [
    {
      accessorKey: "name",
      meta: { width: "min-w-[260px]" },
      header: "User",
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarImage
              src={
                row.original.profileImageUrl ||
                `https://api.dicebear.com/9.x/avataaars/svg?seed=${row.original.email}`
              }
            />
              <AvatarFallback className="rounded-lg">
                {row.original.name.substring(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.email}
            </span>
          </div>
        </div>
      ),
    },
    {
      accessorKey: "role",
      meta: { width: "min-w-[130px]", align: "center" },
      header: "Role",
      cell: ({ row }) => {
        const role = row.getValue("role") as string
        const label =
          role === "superadmin"
            ? "Super Admin"
            : role === "admin"
            ? "Admin"
            : "User"
        return (
          <div className="flex items-center justify-center gap-2">
            {(role === "admin" || role === "superadmin") && (
              <Shield className="h-3 w-3 text-primary" />
            )}
            <span>{label}</span>
          </div>
        )
      },
    },
    {
      accessorKey: "status",
      meta: { width: "min-w-[120px]", align: "center" },
      header: "Status",
      cell: ({ row }) => {
        const status = (row.getValue("status") as string) || ""
        const label =
          status.length > 0
            ? status.charAt(0).toUpperCase() + status.slice(1)
            : status
        return (
          <div className="flex justify-center">
            <Badge variant={status === "active" ? "default" : "secondary"}>
              {label}
            </Badge>
          </div>
        )
      },
    },
    {
      accessorKey: "quotaLimitMb",
      meta: { width: "min-w-[260px]", align: "center" },
      header: "Storage quota",
      cell: ({ row }) => {
        const used = row.original.quotaUsedMb
        const limit = row.original.quotaLimitMb
        const percent = limit > 0 ? (used / limit) * 100 : 0
        return (
          <div className="w-full max-w-[240px] mx-auto space-y-1">
            <div className="flex justify-between text-xs">
              <span>{used} MB</span>
              <span className="text-muted-foreground">
                {limit > 0 ? `${limit} MB` : "Unlimited"}
              </span>
            </div>
            <Progress
              value={percent}
              className={`h-2 ${
                percent > 90 ? "bg-red-100 [&>div]:bg-red-500" : ""
              }`}
            />
          </div>
        )
      },
    },
    {
      id: "actions",
      meta: { width: "min-w-[180px]", align: "right", divider: false },
      cell: ({ row }) => {
        const rowUser = row.original
        const isDisabled = rowUser.status === "disabled"
        const isSelf = currentUser?.id === rowUser.id
        const isTargetSuperAdmin = rowUser.role === "superadmin"
        const isTargetAdmin = rowUser.role === "admin"
        const isActorSuperAdmin = currentUser?.role === "superadmin"
        const isActorAdmin = currentUser?.role === "admin"
        const isActorUser = currentUser?.role === "user"

        const isLastActiveSuperAdmin =
          isTargetSuperAdmin &&
          rowUser.status === "active" &&
          activeSuperAdminCount === 1

        let canEdit = false
        let canDelete = false
        let canToggleStatus = false
        let canEditQuota = false

        if (!currentUser) {
          canEdit = false
          canDelete = false
          canToggleStatus = false
          canEditQuota = false
        } else if (isActorSuperAdmin) {
          // Super admin can manage everyone, but not delete/disable themselves
          // if they are the last active super admin.
          canEdit = true
          canEditQuota = true
          canToggleStatus = !(isLastActiveSuperAdmin && isSelf)
          canDelete = !(isLastActiveSuperAdmin && isSelf)
        } else if (isActorAdmin) {
          if (isTargetSuperAdmin) {
            // Admins cannot change super admins.
            canEdit = false
            canDelete = false
            canToggleStatus = false
            canEditQuota = false
          } else if (isTargetAdmin) {
            // Admins cannot manage other admins, but can adjust their own account.
            if (isSelf) {
              canEdit = true
              canToggleStatus = true
              canEditQuota = true
              canDelete = false
            }
          } else {
            // Admin managing regular users.
            canEdit = true
            canDelete = true
            canToggleStatus = true
            canEditQuota = true
          }
        } else if (isActorUser) {
          // Regular users cannot manage other accounts here.
          canEdit = false
          canDelete = false
          canToggleStatus = false
          canEditQuota = false
        }

        return (
          <div className="flex items-center justify-end gap-2">
            <div className="flex items-center gap-1">
              <Switch
                checked={!isDisabled}
                disabled={!canToggleStatus}
                onCheckedChange={async (checked) => {
                  if (!canToggleStatus) return

                  // Extra confirmation when a user disables their own account.
                  if (!checked && isSelf) {
                    const confirmed = window.confirm(
                      "You are about to disable your own account. You may be logged out and lose access until a Super Admin re-enables you. Continue?"
                    )
                    if (!confirmed) return
                  }

                  const nextStatus = checked ? "active" : "disabled"
                  try {
                    const res = await fetch(`/api/users/${rowUser.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: nextStatus }),
                    })
                    const data = await res.json().catch(() => ({}))
                    if (!res.ok) {
                      toast.error(
                        data.error ?? "Failed to update user status"
                      )
                      return
                    }
                    setUsers((prev) =>
                      prev.map((u) =>
                        u.id === rowUser.id ? (data.user as UserRow) : u
                      )
                    )
                    toast.success(
                      nextStatus === "disabled"
                        ? "User disabled"
                        : "User enabled"
                    )
                  } catch {
                    toast.error("Failed to update user status")
                  }
                }}
                aria-label={
                  isDisabled ? "Enable user account" : "Disable user account"
                }
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => canEditQuota && openQuotaDialog(rowUser)}
                disabled={!canEditQuota}
                aria-label="Change storage quota"
              >
                <HardDrive className="h-4 w-4" />
              </Button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 p-0">
                  <span className="sr-only">Open menu</span>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit && (
                  <DropdownMenuItem onClick={() => openEditDialog(rowUser)}>
                    Edit details
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={async () => {
                        if (!canDelete) return
                        const confirmed = window.confirm(
                          isSelf
                            ? `You are about to delete your own account "${rowUser.name}". This will permanently remove your access and data for this user. This cannot be undone. Continue?`
                            : `Delete user "${rowUser.name}"? This cannot be undone.`
                        )
                        if (!confirmed) return
                        try {
                          const res = await fetch(`/api/users/${rowUser.id}`, {
                            method: "DELETE",
                          })
                          const data = await res.json().catch(() => ({}))
                          if (!res.ok) {
                            toast.error(data.error ?? "Failed to delete user")
                            return
                          }
                          setUsers((prev) =>
                            prev.filter((u) => u.id !== rowUser.id)
                          )
                          toast.success("User deleted")
                        } catch {
                          toast.error("Failed to delete user")
                        }
                      }}
                    >
                      Delete user
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]

  const handleSaveUser = async () => {
    try {
      const trimmedUsername = formState.username.trim()
      const trimmedEmail = formState.email.trim()
      const fullName = `${formState.firstName.trim()} ${formState.lastName.trim()}`.trim()

      if (!fullName) {
        toast.error("Full name is required")
        return
      }
      if (!trimmedUsername) {
        toast.error("Username is required")
        return
      }
      if (trimmedUsername.includes("@")) {
        toast.error("Username cannot be an email address")
        return
      }

      if (!isQuotaOnly) {
        if (!trimmedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
          toast.error("Please enter a valid email address")
          return
        }
        if (emailStatus === "taken" && trimmedEmail !== originalEmail) {
          toast.error("That email is already registered")
          return
        }
        if (usernameStatus === "taken" && trimmedUsername !== originalUsername) {
          toast.error("That username is already taken")
          return
        }
        if (!formState.id) {
          if (!formState.password || !confirmPassword) {
            toast.error("Password and confirmation are required")
            return
          }
        }
        if (formState.password || confirmPassword) {
          if (formState.password !== confirmPassword) {
            toast.error("Passwords do not match")
            return
          }
          if (!passwordStrong) {
            toast.error(
              "Password must be at least 8 characters and include letters and a number"
            )
            return
          }
        }

        // If creating or promoting to Super Admin, require Super Admin actor
        // and an explicit confirmation.
        const isSuperAdminTarget =
          !isQuotaOnly && formState.role === "superadmin"
        if (isSuperAdminTarget) {
          if (currentUser?.role !== "superadmin") {
            toast.error(
              "Only a Super Admin can create or promote a Super Admin account"
            )
            return
          }

          const existing =
            formState.id && users.find((u) => u.id === formState.id)
          const isPromotion =
            !!existing && existing.role !== "superadmin" && formState.id
          const message = isPromotion
            ? `WARNING: You are about to promote "${fullName}" to Super Admin. Super Admins have full control over all users and storage. Continue?`
            : `WARNING: You are about to create a new Super Admin account. Super Admins have full control over all users and storage. Continue?`

          const confirmed = window.confirm(message)
          if (!confirmed) {
            return
          }
        }
      }

      const effectiveQuotaMb =
        formState.quotaUnit === "UNLIMITED" ? 0 : formState.quotaLimitMb

      if (formState.id) {
        const res = await fetch(`/api/users/${formState.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: isQuotaOnly ? undefined : fullName,
            username: isQuotaOnly ? undefined : trimmedUsername,
            email: isQuotaOnly ? undefined : trimmedEmail,
            role: isQuotaOnly ? undefined : formState.role,
            status: isQuotaOnly ? undefined : formState.status,
            quotaLimitMb: effectiveQuotaMb,
            profileImageUrl: isQuotaOnly ? undefined : formState.profileImageUrl,
            password:
              isQuotaOnly || !formState.password ? undefined : formState.password,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error ?? "Failed to update user")
          return
        }
        await reloadUsers()
        toast.success(isQuotaOnly ? "Quota updated" : "User updated")
      } else {
        const res = await fetch("/api/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: fullName,
            username: trimmedUsername,
            email: trimmedEmail,
            role: formState.role,
            status: formState.status,
            quotaLimitMb: effectiveQuotaMb,
            profileImageUrl: formState.profileImageUrl,
            password: formState.password,
          }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          toast.error(data.error ?? "Failed to create user")
          return
        }
        await reloadUsers()
        toast.success("User created")
      }
      setIsDialogOpen(false)
    } catch {
      toast.error("Unable to save user")
    }
  }

  if (!mounted || (usersLoading && users.length === 0)) {
    return <DashboardPageSkeleton rows={7} />
  }

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <DashboardPageHeader
          title="Users"
          description={formatLastSyncedAt(lastSyncedAt)}
          actions={
            <DashboardSearchFilterToolbar
              searchValue={search}
              onSearchChange={(value) => { setSearch(value); setPageIndex(0) }}
              searchPlaceholder="Search users..."
              searchWidthClassName="sm:w-[220px]"
              onRefresh={() => void reloadUsers()}
              refreshing={usersLoading}
              refreshLabel="Sync users"
              countSearch
              filters={userFilters}
              filterValues={{ role: roleFilter || "all", status: statusFilter || "all" }}
              onFilterChange={(key, value) => {
                setPageIndex(0)
                if (key === "role") setRoleFilter(value === "all" ? "" : value as typeof roleFilter)
                else if (key === "status") setStatusFilter(value === "all" ? "" : value as typeof statusFilter)
              }}
              onClear={() => {
                setSearch("")
                setRoleFilter("")
                setStatusFilter("")
                setPageIndex(0)
              }}
              title="Filter users"
              description="Filter by account role and status."
              actions={<Button size="icon" className={DASHBOARD_TOOLBAR_ACTION_BUTTON_CLASS} onClick={openAddDialog}>
                <Plus className="h-4 w-4 sm:mr-2" /><span className="sr-only sm:not-sr-only">Add user</span>
              </Button>}
            />
          }
        />
      </div>

      <div className="dashboard-motion-item dashboard-motion-delay-1 grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[
          { title: "Total Users", value: userStats.total, detail: "Accounts in this organization" },
          { title: "Active", value: userStats.active, detail: "Enabled accounts" },
          { title: "Administrators", value: userStats.privileged, detail: "Admins and super admins" },
          { title: "Disabled", value: userStats.disabled, detail: "Access currently disabled" },
        ].map(({ title, value, detail }) => (
          <Card key={title} className="gap-0 py-0">
            <CardHeader className="px-4 py-3 pb-1.5 lg:px-4 lg:py-3 lg:pb-1.5">
              <CardDescription className="text-[13px] leading-4">{title}</CardDescription>
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 lg:px-4 lg:pb-3">
              <div className="text-xl font-bold leading-none tabular-nums sm:text-2xl">{value}</div>
              <p className="mt-2 text-[11px] leading-4 text-muted-foreground">{detail}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="dashboard-motion-item dashboard-motion-delay-3">
      <DashboardDataTable
        data={users}
        columns={columns}
        pageSize={PAGE_SIZE}
        minWidth="950px"
        resetKey={`${search}:${roleFilter}:${statusFilter}:${pageIndex}`}
        serverPagination={{ pageIndex, pageCount, onPageChange: setPageIndex }}
        emptyState="No users found."
      />
      </div>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {isQuotaOnly
                ? "Change storage quota"
                : formState.id
                ? "Edit user"
                : "Add user"}
            </DialogTitle>
          </DialogHeader>
          {isQuotaOnly ? (
            <div className="grid gap-3 py-3">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor="quota">
                  Storage quota
                </label>
                <div className="flex gap-2">
                  {formState.quotaUnit !== "UNLIMITED" && (
                    <Input
                      id="quota"
                      type="number"
                      min={0}
                      className="w-32"
                      value={
                        formState.quotaUnit === "GB"
                          ? Math.floor(formState.quotaLimitMb / 1024)
                          : formState.quotaLimitMb
                      }
                      onChange={(e) => {
                        const raw = Number(e.target.value || 0)
                        setFormState((s) => ({
                          ...s,
                          quotaLimitMb:
                            s.quotaUnit === "GB" ? raw * 1024 : raw,
                        }))
                      }}
                    />
                  )}
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={formState.quotaUnit}
                    onChange={(e) => {
                      const nextUnit = e.target
                        .value as (typeof formState)["quotaUnit"]
                      setFormState((s) => {
                        if (nextUnit === "UNLIMITED") {
                          return {
                            ...s,
                            quotaUnit: nextUnit,
                            quotaLimitMb: 0,
                          }
                        }

                        const currentDisplayValue =
                          s.quotaUnit === "GB"
                            ? Math.floor(s.quotaLimitMb / 1024)
                            : s.quotaLimitMb

                        const nextLimitMb =
                          nextUnit === "GB"
                            ? currentDisplayValue * 1024
                            : currentDisplayValue

                        return {
                          ...s,
                          quotaUnit: nextUnit,
                          quotaLimitMb: nextLimitMb,
                        }
                      })
                    }}
                  >
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                    <option value="UNLIMITED">Unlimited</option>
                  </select>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 py-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label
                    className="text-sm font-medium"
                    htmlFor="firstName"
                  >
                    First name
                  </label>
                  <Input
                    id="firstName"
                    value={formState.firstName}
                    onChange={(e) =>
                      setFormState((s) => ({
                        ...s,
                        firstName: e.target.value,
                      }))
                    }
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-sm font-medium" htmlFor="lastName">
                    Last name
                  </label>
                  <Input
                    id="lastName"
                    value={formState.lastName}
                    onChange={(e) =>
                      setFormState((s) => ({
                        ...s,
                        lastName: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor="username">
                  Username
                </label>
                <Input
                  id="username"
                  value={formState.username}
                  onChange={(e) =>
                    setFormState((s) => ({
                      ...s,
                      username: e.target.value,
                    }))
                  }
                />
                {usernameHint && (
                  <p
                    className={
                      usernameStatus === "available"
                        ? "text-xs text-emerald-500"
                        : usernameStatus === "taken" ||
                          usernameStatus === "error"
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {usernameHint}
                  </p>
                )}
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor="email">
                  Email
                </label>
                <Input
                  id="email"
                  type="email"
                  value={formState.email}
                  onChange={(e) =>
                    setFormState((s) => ({
                      ...s,
                      email: e.target.value,
                    }))
                  }
                />
                {emailHint && (
                  <p
                    className={
                      emailStatus === "available"
                        ? "text-xs text-emerald-500"
                        : emailStatus === "taken" || emailStatus === "error"
                        ? "text-xs text-destructive"
                        : "text-xs text-muted-foreground"
                    }
                  >
                    {emailHint}
                  </p>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-1.5">
                  <label className="text-sm font-medium" htmlFor="role">
                    Role
                  </label>
                  <select
                    id="role"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={formState.role}
                    onChange={(e) =>
                      setFormState((s) => ({
                        ...s,
                        role: e.target.value as
                          | "superadmin"
                          | "admin"
                          | "user",
                      }))
                    }
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                    {currentUser?.role === "superadmin" && (
                      <option value="superadmin">Super Admin</option>
                    )}
                  </select>
                  {formState.role === "superadmin" && !isQuotaOnly && (
                    <p className="text-xs text-destructive">
                      Warning: Super Admins have full control over users,
                      storage and settings. Only create or promote to Super
                      Admin if this account should have maximum privileges.
                    </p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <label className="text-sm font-medium" htmlFor="status">
                    Status
                  </label>
                  <div className="flex items-center gap-2">
                    <Switch
                      id="status"
                      checked={formState.status === "active"}
                      onCheckedChange={(checked) =>
                        setFormState((s) => ({
                          ...s,
                          status: checked ? "active" : "disabled",
                        }))
                      }
                    />
                    <span className="text-sm">
                      {formState.status === "active"
                        ? "Active"
                        : "Disabled"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium" htmlFor="quota">
                  Storage quota
                </label>
                <div className="flex gap-2">
                  {formState.quotaUnit !== "UNLIMITED" && (
                    <Input
                      id="quota"
                      type="number"
                      min={0}
                      className="w-32"
                      value={
                        formState.quotaUnit === "GB"
                          ? Math.floor(formState.quotaLimitMb / 1024)
                          : formState.quotaLimitMb
                      }
                      onChange={(e) => {
                        const raw = Number(e.target.value || 0)
                        setFormState((s) => ({
                          ...s,
                          quotaLimitMb:
                            s.quotaUnit === "GB" ? raw * 1024 : raw,
                        }))
                      }}
                    />
                  )}
                  <select
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={formState.quotaUnit}
                    onChange={(e) => {
                      const nextUnit = e.target
                        .value as (typeof formState)["quotaUnit"]
                      setFormState((s) => {
                        if (nextUnit === "UNLIMITED") {
                          return {
                            ...s,
                            quotaUnit: nextUnit,
                            quotaLimitMb: 0,
                          }
                        }

                        const currentDisplayValue =
                          s.quotaUnit === "GB"
                            ? Math.floor(s.quotaLimitMb / 1024)
                            : s.quotaLimitMb

                        const nextLimitMb =
                          nextUnit === "GB"
                            ? currentDisplayValue * 1024
                            : currentDisplayValue

                        return {
                          ...s,
                          quotaUnit: nextUnit,
                          quotaLimitMb: nextLimitMb,
                        }
                      })
                    }}
                  >
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                    <option value="UNLIMITED">Unlimited</option>
                  </select>
                </div>
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Profile picture</label>
                <div className="flex items-center gap-4">
                  <Avatar className="h-10 w-10 rounded-lg">
                    <AvatarImage src={formState.profileImageUrl} />
                    <AvatarFallback className="rounded-lg">
                      {formState.firstName
                        ? formState.firstName.substring(0, 2).toUpperCase()
                        : "US"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-wrap gap-2">
                    <Label
                      htmlFor="avatarUpload"
                      className="cursor-pointer"
                    >
                      <span className="border px-3 py-1.5 text-xs rounded-md">
                        {formState.profileImageUrl ? "Change image" : "Add image"}
                      </span>
                    </Label>
                    {formState.profileImageUrl && (
	                      <Button
	                        type="button"
	                        variant="ghost"
	                        size="sm"
	                        className="text-destructive hover:text-destructive hover:bg-destructive/10 px-2 h-7 text-xs"
	                        onClick={() =>
	                          setFormState((s) => ({
	                            ...s,
                            profileImageUrl: "",
                          }))
                        }
                      >
                        Remove image
                      </Button>
                    )}
                  </div>
                </div>
                <Input
                  id="avatarUpload"
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    if (!file.type.startsWith("image/")) {
                      toast.error("Please select an image file")
                      return
                    }
                    try {
                      const dataUrl = await resizeImageToUnderLimit(file)
                      setFormState((s) => ({
                        ...s,
                        profileImageUrl: dataUrl,
                      }))
                    } catch {
                      toast.error("Unable to process image. Please try a smaller file.")
                    }
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">Google account</label>
                <p className="text-xs text-muted-foreground">
                  {formState.googleLinked
                    ? "This account is linked with a Google login."
                    : "Not linked with a Google account."}
                </p>
              </div>
              {!formState.id && (
                <div className="grid gap-1.5">
                  <label className="text-sm font-medium" htmlFor="password">
                    Password
                  </label>
                  <Input
                    id="password"
                    type="password"
                    value={formState.password}
                    onChange={(e) => {
                      const value = e.target.value
                      setFormState((s) => ({
                        ...s,
                        password: value,
                      }))
                      evaluatePassword(value)
                    }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Must be at least 8 characters and include letters and a
                    number.
                  </p>
                  {passwordHint && (
                    <p
                      className={`text-xs ${
                        passwordStrong ? "text-emerald-500" : "text-destructive"
                      }`}
                    >
                      {passwordHint}
                    </p>
                  )}
                  <label
                    className="text-sm font-medium"
                    htmlFor="confirmPassword"
                  >
                    Confirm password
                  </label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                  {confirmPassword &&
                    formState.password &&
                    confirmPassword !== formState.password && (
                      <p className="text-xs text-destructive">
                        Passwords do not match.
                      </p>
                    )}
                </div>
              )}
              {formState.id && (
                <div className="grid gap-2">
                  <div className="flex items-center gap-2">
                    <Switch
                      id="changePassword"
                      checked={changePassword}
                      onCheckedChange={setChangePassword}
                    />
                    <label
                      htmlFor="changePassword"
                      className="text-sm font-medium"
                    >
                      Change password
                    </label>
                  </div>
                  {changePassword && (
                    <div className="grid gap-1.5">
                      <label
                        className="text-sm font-medium"
                        htmlFor="newPassword"
                      >
                        New password
                      </label>
                      <Input
                        id="newPassword"
                        type="password"
                        value={formState.password}
                        onChange={(e) => {
                          const value = e.target.value
                          setFormState((s) => ({
                            ...s,
                            password: value,
                          }))
                          evaluatePassword(value)
                        }}
                      />
                      <p className="text-xs text-muted-foreground">
                        Must be at least 8 characters and include letters and a
                        number.
                      </p>
                      {passwordHint && (
                        <p
                          className={`text-xs ${
                            passwordStrong
                              ? "text-emerald-500"
                              : "text-destructive"
                          }`}
                        >
                          {passwordHint}
                        </p>
                      )}
                      <label
                        className="text-sm font-medium"
                        htmlFor="confirmNewPassword"
                      >
                        Confirm new password
                      </label>
                      <Input
                        id="confirmNewPassword"
                        type="password"
                        value={confirmPassword}
                        onChange={(e) =>
                          setConfirmPassword(e.target.value)
                        }
                      />
                      {confirmPassword &&
                        formState.password &&
                        confirmPassword !== formState.password && (
                          <p className="text-xs text-destructive">
                            Passwords do not match.
                          </p>
                        )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={handleSaveUser}>
              {isQuotaOnly
                ? "Save quota"
                : formState.id
                ? "Save changes"
                : "Create user"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardPage>
  )
}

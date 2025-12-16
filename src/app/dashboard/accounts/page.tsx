"use client"

import * as React from "react"
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table"
import {
  Plus,
  Ban,
  Globe,
  Trash2,
  RefreshCw,
  Eye,
  Settings,
  Search,
  Copy,
  ClipboardPaste,
  BookOpen,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { Switch } from "@/components/ui/switch"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

function base32ToBytes(secret: string): Uint8Array {
  const cleaned = secret.replace(/[^A-Z2-7]/gi, "").toUpperCase()
  let bits = ""
  for (const char of cleaned) {
    const val = BASE32_ALPHABET.indexOf(char)
    if (val === -1) continue
    bits += val.toString(2).padStart(5, "0")
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return new Uint8Array(bytes)
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

async function generateTotp(secret: string, timeStepSeconds = 30, digits = 6) {
  if (typeof window === "undefined" || !("crypto" in window) || !window.crypto.subtle) {
    throw new Error("TOTP not available in this environment")
  }

  const keyBytes = base32ToBytes(secret)
  if (!keyBytes.length) throw new Error("Invalid 2FA secret")

  const keyData = new ArrayBuffer(keyBytes.byteLength)
  new Uint8Array(keyData).set(keyBytes)

  const counter = Math.floor(Date.now() / 1000 / timeStepSeconds)
  const buffer = new ArrayBuffer(8)
  const view = new DataView(buffer)
  view.setUint32(4, counter, false)

  const cryptoKey = await window.crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  )
  const hmac = new Uint8Array(
    await window.crypto.subtle.sign("HMAC", cryptoKey, buffer)
  )

  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  const otp = (code % 10 ** digits).toString().padStart(digits, "0")
  const secondsRemaining =
    timeStepSeconds - (Math.floor(Date.now() / 1000) % timeStepSeconds)

  return { otp, secondsRemaining }
}

export type Account = {
  id: string
  name: string
  email: string
  password: string
  twoFactorSecret: string
  apiToken: string
  r2AccessKeyId: string
  r2SecretAccessKey: string
  accountId: string
  status: "active" | "disabled" | "available"
  createdAt: string
  totalBuckets: number
  totalObjects: number
  totalBytes: number
  syncStatus?: "idle" | "syncing" | "ok" | "error"
  syncMessage?: string
  lastSyncedAt?: string
}

export default function AccountsPage() {
  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [isAddOpen, setIsAddOpen] = React.useState(false)

  const [label, setLabel] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [twoFactorSecret, setTwoFactorSecret] = React.useState("")
  const [apiToken, setApiToken] = React.useState("")
  const [r2AccessKeyId, setR2AccessKeyId] = React.useState("")
  const [r2SecretAccessKey, setR2SecretAccessKey] = React.useState("")

  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [syncingId, setSyncingId] = React.useState<string | null>(null)
  const [syncingAll, setSyncingAll] = React.useState(false)
  const [viewAccount, setViewAccount] = React.useState<Account | null>(null)
  const [settingsAccount, setSettingsAccount] = React.useState<Account | null>(null)
  const [search, setSearch] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [showTwoFactor, setShowTwoFactor] = React.useState(false)
  const [showViewPassword, setShowViewPassword] = React.useState(false)
  const [showViewR2Secret, setShowViewR2Secret] = React.useState(false)
  const [editLabel, setEditLabel] = React.useState("")
  const [editEmail, setEditEmail] = React.useState("")
  const [editPassword, setEditPassword] = React.useState("")
  const [editTwoFactorSecret, setEditTwoFactorSecret] = React.useState("")
  const [editApiToken, setEditApiToken] = React.useState("")
  const [editR2AccessKeyId, setEditR2AccessKeyId] = React.useState("")
  const [editR2SecretAccessKey, setEditR2SecretAccessKey] = React.useState("")
  const [editAccountId, setEditAccountId] = React.useState("")
  const [showEditPassword, setShowEditPassword] = React.useState(false)
  const [showEditTwoFactor, setShowEditTwoFactor] = React.useState(false)
  const [showEditR2Secret, setShowEditR2Secret] = React.useState(false)
  const [viewTotpCode, setViewTotpCode] = React.useState<string | null>(null)
  const [viewTotpSecondsLeft, setViewTotpSecondsLeft] = React.useState<number | null>(
    null
  )
  const [totpCode, setTotpCode] = React.useState<string | null>(null)
  const [totpSecondsLeft, setTotpSecondsLeft] = React.useState<number | null>(null)
  const [editTotpCode, setEditTotpCode] = React.useState<string | null>(null)
  const [editTotpSecondsLeft, setEditTotpSecondsLeft] =
    React.useState<number | null>(null)
  const [tokenStatus, setTokenStatus] = React.useState<
    "idle" | "checking" | "valid" | "invalid"
  >("idle")
  const [tokenMessage, setTokenMessage] = React.useState<string | null>(null)
  const [keysStatus, setKeysStatus] = React.useState<"idle" | "valid" | "invalid">(
    "idle"
  )
  const pageSize = 10
  const [pageIndex, setPageIndex] = React.useState(0)
  const [confirmAction, setConfirmAction] = React.useState<{
    type: "delete" | "disable"
    account: Account | null
  } | null>(null)
  const [enableAccount, setEnableAccount] = React.useState<Account | null>(null)
  const hasAutoSyncedRef = React.useRef(false)

  React.useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/api/accounts")
        if (!res.ok) throw new Error("Failed to load accounts")
        const data = await res.json()
        const rows: Account[] = (data.accounts ?? []).map((acc: any) => ({
          id: acc.id,
          name: acc.label ?? "",
          email: acc.email ?? "",
          password: acc.password ?? "",
          twoFactorSecret: acc.twoFactorSecret ?? "",
          apiToken: acc.apiToken ?? "",
          r2AccessKeyId: acc.r2AccessKeyId ?? "",
          r2SecretAccessKey: acc.r2SecretAccessKey ?? "",
          accountId: acc.cloudflareAccountId ?? "-",
          status: acc.status ?? "available",
          createdAt: acc.createdAt ?? "-",
          totalBuckets: acc.totalBuckets ?? 0,
          totalObjects: acc.totalObjects ?? 0,
          totalBytes: acc.totalBytes ?? 0,
          syncStatus: acc.syncStatus ?? "idle",
          syncMessage: acc.syncMessage ?? "",
          lastSyncedAt: acc.lastSyncedAt ?? undefined,
        }))
        setAccounts(rows)
      } catch (err) {
        console.error(err)
        toast.error("Unable to load Cloudflare accounts")
      }
    }

    load()
  }, [])

  React.useEffect(() => {
    if (!settingsAccount) return
    setEditLabel(settingsAccount.name || "")
    setEditEmail(settingsAccount.email || "")
    setEditPassword(settingsAccount.password || "")
    setEditTwoFactorSecret(settingsAccount.twoFactorSecret || "")
    setEditApiToken(settingsAccount.apiToken || "")
    setEditR2AccessKeyId(settingsAccount.r2AccessKeyId || "")
    setEditR2SecretAccessKey(settingsAccount.r2SecretAccessKey || "")
    setEditAccountId(settingsAccount.accountId || "")
    setShowEditPassword(false)
    setShowEditTwoFactor(false)
    setShowEditR2Secret(false)
  }, [settingsAccount])

  React.useEffect(() => {
    if (!accounts.length) return
    if (hasAutoSyncedRef.current) return
    hasAutoSyncedRef.current = true
    // Fire-and-forget auto sync of all accounts on first load.
    // Errors will be reflected via syncStatus = "error".
    handleSyncAll().catch(() => {
      // errors already handled inside handleSyncAll
    })
  }, [accounts])

  React.useEffect(() => {
    let interval: number | undefined

    const tick = async () => {
      if (!twoFactorSecret.trim()) {
        setTotpCode(null)
        setTotpSecondsLeft(null)
        return
      }
      try {
        const { otp, secondsRemaining } = await generateTotp(twoFactorSecret)
        setTotpCode(otp)
        setTotpSecondsLeft(secondsRemaining)
      } catch {
        setTotpCode(null)
        setTotpSecondsLeft(null)
      }
    }

    tick()
    interval = window.setInterval(tick, 1000)

    return () => {
      if (interval) window.clearInterval(interval)
    }
  }, [twoFactorSecret])

  React.useEffect(() => {
    let interval: number | undefined

    const tick = async () => {
      if (!editTwoFactorSecret.trim()) {
        setEditTotpCode(null)
        setEditTotpSecondsLeft(null)
        return
      }
      try {
        const { otp, secondsRemaining } = await generateTotp(editTwoFactorSecret)
        setEditTotpCode(otp)
        setEditTotpSecondsLeft(secondsRemaining)
      } catch {
        setEditTotpCode(null)
        setEditTotpSecondsLeft(null)
      }
    }

    if (editTwoFactorSecret) {
      tick()
      interval = window.setInterval(tick, 1000)
    }

    return () => {
      if (interval) window.clearInterval(interval)
    }
  }, [editTwoFactorSecret])

  React.useEffect(() => {
    let interval: number | undefined

    const tick = async () => {
      if (!viewAccount?.twoFactorSecret?.trim()) {
        setViewTotpCode(null)
        setViewTotpSecondsLeft(null)
        return
      }
      try {
        const { otp, secondsRemaining } = await generateTotp(
          viewAccount.twoFactorSecret
        )
        setViewTotpCode(otp)
        setViewTotpSecondsLeft(secondsRemaining)
      } catch {
        setViewTotpCode(null)
        setViewTotpSecondsLeft(null)
      }
    }

    if (viewAccount) {
      tick()
      interval = window.setInterval(tick, 1000)
    }

    return () => {
      if (interval) window.clearInterval(interval)
    }
  }, [viewAccount])

  const resetForm = () => {
    setLabel("")
    setEmail("")
    setPassword("")
    setTwoFactorSecret("")
    setApiToken("")
    setR2AccessKeyId("")
    setR2SecretAccessKey("")
    setShowPassword(false)
    setShowTwoFactor(false)
    setTotpCode(null)
    setTotpSecondsLeft(null)
    setTokenStatus("idle")
    setTokenMessage(null)
    setKeysStatus("idle")
  }

  const handleAddAccount = async () => {
    if (
      !label.trim() ||
      !email.trim() ||
      !password ||
      !twoFactorSecret ||
      !apiToken ||
      !r2AccessKeyId ||
      !r2SecretAccessKey
    ) {
      toast.error("All fields are required")
      return
    }

    if (tokenStatus !== "valid") {
      toast.error("API token must be valid before adding the account")
      return
    }

    if (keysStatus !== "valid") {
      toast.error("R2 access key pair must be valid before adding the account")
      return
    }

    try {
      setIsSubmitting(true)
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          email,
          password,
          twoFactorSecret,
          apiToken,
          r2AccessKeyId,
          r2SecretAccessKey,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to create account")

      const acc = data.account
      const row: Account = {
        id: acc.id,
        name: acc.label,
        email: acc.email,
        password: acc.password ?? "",
        twoFactorSecret: acc.twoFactorSecret ?? "",
        apiToken: acc.apiToken ?? "",
        r2AccessKeyId: acc.r2AccessKeyId ?? "",
        r2SecretAccessKey: acc.r2SecretAccessKey ?? "",
        accountId: acc.cloudflareAccountId ?? "-",
        status: acc.status ?? "available",
        createdAt: acc.createdAt ?? "-",
        totalBuckets: acc.totalBuckets ?? 0,
        totalObjects: acc.totalObjects ?? 0,
        totalBytes: acc.totalBytes ?? 0,
      }

      setAccounts((prev) => [...prev, row])
      resetForm()
      setIsAddOpen(false)
      toast.success("Account added")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to create account")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleValidateToken = async () => {
    if (!apiToken.trim()) {
      setTokenStatus("idle")
      setTokenMessage(null)
      return
    }

    try {
      setTokenStatus("checking")
      setTokenMessage(null)
      const res = await fetch("/api/accounts/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiToken }),
      })
      const data = await res.json()
      if (!res.ok || data.validToken === false) {
        setTokenStatus("invalid")
        setTokenMessage(data.error || "Token is not valid")
        return
      }
      const accounts: string[] = data.accountIds ?? []
      setTokenStatus("valid")
      if (accounts.length > 0) {
        setTokenMessage(
          `Token verified for account${accounts.length > 1 ? "s" : ""}: ${accounts.join(
            ", "
          )}`
        )
      } else {
        setTokenMessage("Token verified")
      }
    } catch (err: any) {
      console.error(err)
      setTokenStatus("invalid")
      setTokenMessage(err?.message || "Unable to verify token")
    }
  }

  // Auto-validate API token when it changes
  React.useEffect(() => {
    if (!apiToken.trim()) {
      setTokenStatus("idle")
      setTokenMessage(null)
      return
    }

    const timeoutId = window.setTimeout(() => {
      handleValidateToken()
    }, 700)

    return () => window.clearTimeout(timeoutId)
  }, [apiToken])

  // Basic local validation for R2 key pair (non-empty)
  React.useEffect(() => {
    if (!r2AccessKeyId.trim() && !r2SecretAccessKey.trim()) {
      setKeysStatus("idle")
    } else if (r2AccessKeyId.trim() && r2SecretAccessKey.trim()) {
      setKeysStatus("valid")
    } else {
      setKeysStatus("invalid")
    }
  }, [r2AccessKeyId, r2SecretAccessKey])

  const handleChangeStatus = async (
    id: string,
    status: "active" | "disabled" | "available"
  ) => {
    try {
      const res = await fetch(`/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to update account")

      const updated = data.account
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === updated.id
            ? {
                id: updated.id,
                name: updated.label ?? acc.name,
                email: updated.email ?? acc.email,
                password: updated.password ?? acc.password,
                twoFactorSecret: updated.twoFactorSecret ?? acc.twoFactorSecret,
                apiToken: updated.apiToken ?? acc.apiToken,
                r2AccessKeyId: updated.r2AccessKeyId ?? acc.r2AccessKeyId,
                r2SecretAccessKey:
                  updated.r2SecretAccessKey ?? acc.r2SecretAccessKey,
                accountId: updated.cloudflareAccountId ?? "-",
                status: updated.status ?? "available",
                createdAt: updated.createdAt ?? acc.createdAt ?? "-",
                totalBuckets: updated.totalBuckets ?? acc.totalBuckets,
                totalObjects: updated.totalObjects ?? acc.totalObjects,
                totalBytes: updated.totalBytes ?? acc.totalBytes,
                syncStatus: updated.syncStatus ?? acc.syncStatus,
                syncMessage: updated.syncMessage ?? acc.syncMessage,
                lastSyncedAt: updated.lastSyncedAt ?? acc.lastSyncedAt,
              }
            : acc
        )
      )
      toast.success("Account updated")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to update account")
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/accounts/${id}`, { method: "DELETE" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to delete account")
      setAccounts((prev) => prev.filter((acc) => acc.id !== id))
      toast.success("Account removed")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to delete account")
    }
  }

  const handleSync = async (id: string) => {
    try {
      setSyncingId(id)
      const res = await fetch(`/api/accounts/${id}/sync`, { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to sync account")

      const updated = data.account
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === updated.id
            ? {
                id: updated.id,
                name: updated.label ?? acc.name,
                email: updated.email ?? acc.email,
                password: updated.password ?? acc.password,
                twoFactorSecret: updated.twoFactorSecret ?? acc.twoFactorSecret,
                apiToken: updated.apiToken ?? acc.apiToken,
                r2AccessKeyId: updated.r2AccessKeyId ?? acc.r2AccessKeyId,
                r2SecretAccessKey:
                  updated.r2SecretAccessKey ?? acc.r2SecretAccessKey,
                accountId: updated.cloudflareAccountId ?? "-",
                status: updated.status ?? "available",
                createdAt: updated.createdAt ?? acc.createdAt ?? "-",
                totalBuckets: updated.totalBuckets ?? acc.totalBuckets,
                totalObjects: updated.totalObjects ?? acc.totalObjects,
                totalBytes: updated.totalBytes ?? acc.totalBytes,
              }
            : acc
        )
      )
      toast.success("Account synced")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to sync account")
    } finally {
      setSyncingId(null)
    }
  }

  const handleSyncAll = async () => {
    if (!accounts.length) return
    try {
      setSyncingAll(true)
      await Promise.all(
        accounts.map(async (acc) => {
          const res = await fetch(`/api/accounts/${acc.id}/sync`, {
            method: "POST",
          })
          if (!res.ok) {
            const data = await res.json().catch(() => ({}))
            throw new Error(data.error || "Unable to sync one of the accounts")
          }
        })
      )

      const res = await fetch("/api/accounts")
      if (res.ok) {
        const data = await res.json()
        const rows: Account[] = (data.accounts ?? []).map((acc: any) => ({
          id: acc.id,
          name: acc.label ?? "",
          email: acc.email ?? "",
          password: acc.password ?? "",
          twoFactorSecret: acc.twoFactorSecret ?? "",
          apiToken: acc.apiToken ?? "",
          r2AccessKeyId: acc.r2AccessKeyId ?? "",
          r2SecretAccessKey: acc.r2SecretAccessKey ?? "",
          accountId: acc.cloudflareAccountId ?? "-",
          status: acc.status ?? "available",
          createdAt: acc.createdAt ?? "-",
          totalBuckets: acc.totalBuckets ?? 0,
          totalObjects: acc.totalObjects ?? 0,
          totalBytes: acc.totalBytes ?? 0,
          syncStatus: acc.syncStatus ?? "idle",
          syncMessage: acc.syncMessage ?? "",
          lastSyncedAt: acc.lastSyncedAt ?? undefined,
        }))
        setAccounts(rows)
      }

      toast.success("All accounts synced")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to sync all accounts")
    } finally {
      setSyncingAll(false)
    }
  }

  const handleSyncAccountId = async (id: string) => {
    try {
      setSyncingId(id)
      const res = await fetch(`/api/accounts/${id}/sync-id`, { method: "POST" })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to sync account ID")

      const updated = data.account
      const newAccountId = updated.cloudflareAccountId ?? ""

      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === updated.id
            ? {
                ...acc,
                accountId: newAccountId || acc.accountId,
              }
            : acc
        )
      )

      // Keep settings dialog in sync if it's open on this account.
      if (settingsAccount && settingsAccount.id === updated.id) {
        setEditAccountId(newAccountId)
        setSettingsAccount({ ...settingsAccount, accountId: newAccountId })
      }

      toast.success("Account ID synced")
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to sync account ID")
    } finally {
      setSyncingId(null)
    }
  }
  const handleSaveSettings = async () => {
    if (!settingsAccount) return
    if (
      !editLabel.trim() ||
      !editEmail.trim() ||
      !editPassword ||
      !editTwoFactorSecret ||
      !editApiToken ||
      !editR2AccessKeyId ||
      !editR2SecretAccessKey
    ) {
      toast.error("All fields are required")
      return
    }

    try {
      const res = await fetch(`/api/accounts/${settingsAccount.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: editLabel,
          email: editEmail,
          password: editPassword,
          twoFactorSecret: editTwoFactorSecret,
          apiToken: editApiToken,
          r2AccessKeyId: editR2AccessKeyId,
          r2SecretAccessKey: editR2SecretAccessKey,
          cloudflareAccountId: editAccountId || undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Unable to update account")

      const updated = data.account
      setAccounts((prev) =>
        prev.map((acc) =>
          acc.id === updated.id
            ? {
                ...acc,
                name: updated.label ?? editLabel,
                email: updated.email ?? editEmail,
                password: updated.password ?? editPassword,
                twoFactorSecret:
                  updated.twoFactorSecret ?? editTwoFactorSecret,
                apiToken: updated.apiToken ?? editApiToken,
                r2AccessKeyId: updated.r2AccessKeyId ?? editR2AccessKeyId,
                r2SecretAccessKey:
                  updated.r2SecretAccessKey ?? editR2SecretAccessKey,
                accountId: updated.cloudflareAccountId ?? acc.accountId,
                status: updated.status ?? acc.status,
                createdAt: updated.createdAt ?? acc.createdAt,
                totalBuckets: updated.totalBuckets ?? acc.totalBuckets,
                syncStatus: updated.syncStatus ?? acc.syncStatus,
                syncMessage: updated.syncMessage ?? acc.syncMessage,
              }
            : acc
        )
      )
      toast.success("Account updated")
      setSettingsAccount(null)
    } catch (err: any) {
      console.error(err)
      toast.error(err?.message || "Unable to update account")
    }
  }

  const activeAccount = accounts.find((a) => a.status === "active")
  const availableCount = accounts.filter((a) => a.status === "available").length
  const disabledCount = accounts.filter((a) => a.status === "disabled").length

  const filteredAccounts = React.useMemo(() => {
    const term = search.trim().toLowerCase()
    const base = accounts.slice()

    const result = term
      ? base.filter((acc) => {
          const haystack = [
            acc.name,
            acc.email,
            acc.accountId,
            acc.status,
            acc.createdAt,
            String(acc.totalBuckets ?? ""),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
          return haystack.includes(term)
        })
      : base

    // Move disabled accounts to the bottom, keep active/available first.
    return result.sort((a, b) => {
      const weight = (s: Account["status"]) =>
        s === "active" ? 0 : s === "available" ? 1 : 2
      const diff = weight(a.status) - weight(b.status)
      if (diff !== 0) return diff
      // Fall back to createdAt for stable-ish ordering.
      return (a.createdAt || "").localeCompare(b.createdAt || "")
    })
  }, [accounts, search])

  const columns: ColumnDef<Account>[] = [
    {
      accessorKey: "name",
      header: () => <div className="text-center">Account</div>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium flex items-center gap-2">
            <Globe className="h-3 w-3 text-muted-foreground" />
            <span>{row.getValue("name")}</span>
          </div>
          <div className="text-xs text-muted-foreground break-all">
            {row.original.accountId}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "email",
      header: () => <div className="text-center">Email</div>,
      cell: ({ row }) => (
        <span className="block text-xs text-center text-muted-foreground break-all">
          {row.original.email}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: () => <div className="text-center">Status</div>,
      cell: ({ row }) => {
        const status = row.getValue("status") as string
        const syncStatus = row.original.syncStatus

        if (syncStatus === "error") {
          return (
            <div className="flex justify-center">
              <Badge className="bg-red-600 text-white hover:bg-red-700">Error</Badge>
            </div>
          )
        }

        return (
          <div className="flex justify-center">
            <Badge
              variant={
                status === "active"
                  ? "default"
                  : status === "available"
                  ? "outline"
                  : "secondary"
              }
              className={
                status === "active"
                  ? "bg-green-500 hover:bg-green-600"
                  : status === "available"
                  ? "text-blue-500 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20"
                  : ""
              }
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          </div>
        )
      },
    },
    {
      accessorKey: "createdAt",
      header: () => <div className="text-center">Added date</div>,
      cell: ({ row }) => (
        <span className="block text-xs text-center text-muted-foreground">
          {row.original.createdAt
            ? new Date(row.original.createdAt).toLocaleString()
            : "-"}
        </span>
      ),
    },
    {
      accessorKey: "totalBuckets",
      header: () => <div className="text-center">Total buckets</div>,
      cell: ({ row }) => (
        <div className="flex w-full justify-center">
          <span className="text-sm text-center">
            {row.original.totalBuckets}
          </span>
        </div>
      ),
    },
    {
      id: "spacer",
      enableHiding: false,
      header: () => <div className="text-center" />,
      cell: () => <span />,
    },
    {
      id: "actions",
      enableHiding: false,
      header: () => <div className="text-center">Actions</div>,
      cell: ({ row }) => {
        const account = row.original
        return (
          <div className="flex w-full items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setViewAccount(account)}
              aria-label="View account details"
            >
              <Eye className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => handleSync(account.id)}
              disabled={syncingId === account.id}
              aria-label="Sync account"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setSettingsAccount(account)}
              aria-label="Account settings"
            >
              <Settings className="h-4 w-4" />
            </Button>
            {account.status === "available" && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-destructive"
                onClick={() =>
                  setConfirmAction({ type: "disable", account })
                }
                aria-label="Disable account"
              >
                <Ban className="h-4 w-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-destructive"
              onClick={() => setConfirmAction({ type: "delete", account })}
              aria-label="Remove account"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )
      },
    },
  ]

  const table = useReactTable({
    data: filteredAccounts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const totalRows = filteredAccounts.length
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
  const currentPageIndex = Math.min(pageIndex, totalPages - 1)
  const paginatedRows = table
    .getRowModel()
    .rows.slice(
      currentPageIndex * pageSize,
      currentPageIndex * pageSize + pageSize
    )

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <h2 className="text-2xl font-bold tracking-tight">Accounts</h2>
          <p className="text-sm text-muted-foreground">
            Manage your Cloudflare R2 accounts and credentials for migrations.
          </p>
          <p className="text-xs text-muted-foreground">
            Active account:{" "}
            {activeAccount ? (
              <span className="font-medium">{activeAccount.name}</span>
            ) : (
              "None"
            )}
            {" · "}
            {availableCount} available, {disabledCount} disabled
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative h-9">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 w-[180px] sm:w-[220px] pl-8"
            />
          </div>
          <Button
            variant="outline"
            className="h-9"
            onClick={handleSyncAll}
            disabled={syncingAll || accounts.length === 0}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {syncingAll ? "Syncing..." : "Sync all"}
          </Button>
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button className="h-[34px]">
                <Plus className="mr-2 h-4 w-4" /> Add Account
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[88vh] sm:max-h-[94vh] sm:max-w-3xl flex flex-col rounded-2xl">
              <DialogHeader>
                <DialogTitle>Add Cloudflare Account</DialogTitle>
                <DialogDescription>
                  Save Cloudflare credentials (email, password, 2FA, API token, R2 keys) to use
                  for migrations and management.
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                <div className="space-y-6 pb-6">
                  <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4 mb-2">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      Cloudflare Login
                    </p>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="label">Account label</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={() => setLabel("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <Input
                          id="label"
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                          placeholder="R2 Prod Account"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="email">Cloudflare email</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(email)
                                  toast.success("Email copied")
                                } catch {
                                  toast.error("Unable to copy email")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setEmail(text)
                                } catch {
                                  toast.error("Unable to paste email")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setEmail("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <Input
                          id="email"
                          type="email"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          placeholder="user@example.com"
                          required
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="password">Cloudflare password</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(password)
                                  toast.success("Password copied")
                                } catch {
                                  toast.error("Unable to copy password")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setPassword(text)
                                } catch {
                                  toast.error("Unable to paste password")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setPassword("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="relative">
                          <Input
                            id="password"
                            type={showPassword ? "text" : "password"}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                          />
                          <button
                            type="button"
                            onClick={() => setShowPassword((v) => !v)}
                            className="absolute inset-y-0 right-0 flex items-center pr-3 text-xs text-muted-foreground hover:text-foreground"
                            aria-label={showPassword ? "Hide password" : "Show password"}
                          >
                            {showPassword ? <Eye className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="twoFactorSecret">2FA secret</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(twoFactorSecret)
                                  toast.success("2FA secret copied")
                                } catch {
                                  toast.error("Unable to copy 2FA secret")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setTwoFactorSecret(text)
                                } catch {
                                  toast.error("Unable to paste 2FA secret")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setTwoFactorSecret("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <div className="relative">
                          <Input
                            id="twoFactorSecret"
                            type={showTwoFactor ? "text" : "password"}
                            value={twoFactorSecret}
                            onChange={(e) => setTwoFactorSecret(e.target.value)}
                            placeholder="Enter TOTP secret"
                            required
                          />
                          <button
                            type="button"
                            onClick={() => setShowTwoFactor((v) => !v)}
                            className="absolute inset-y-0 right-0 flex items-center pr-3 text-xs text-muted-foreground hover:text-foreground"
                            aria-label={showTwoFactor ? "Hide 2FA secret" : "Show 2FA secret"}
                          >
                            {showTwoFactor ? <Eye className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          </button>
                        </div>
                        {twoFactorSecret && (
                          <p className="text-[11px] text-muted-foreground flex items-center gap-2">
                            <span>
                              Current 2FA code:{" "}
                              <span className="font-mono">
                                {totpCode ?? "------"}
                              </span>
                              {totpSecondsLeft != null && (
                                <> · refresh in {totpSecondsLeft}s</>
                              )}
                            </span>
                            {totpCode && (
                              <button
                                type="button"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(totpCode)
                                    toast.success("2FA code copied")
                                  } catch {
                                    toast.error("Unable to copy 2FA code")
                                  }
                                }}
                                className="inline-flex h-5 w-5 items-center justify-center rounded-md border bg-background text-[10px] text-muted-foreground hover:bg-muted"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            )}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border bg-muted/40 p-4 space-y-4">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        API Access
                      </p>
                      <HoverCard>
                        <HoverCardTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background text-xs text-muted-foreground hover:bg-muted"
                          >
                            <BookOpen className="h-3 w-3" />
                          </button>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 text-xs space-y-2">
                          <p className="font-medium">How to get the API token</p>
                          <ol className="space-y-1 list-decimal list-inside">
                            <li>Open Cloudflare dashboard and log in.</li>
                            <li>Go to Profile ? API Tokens.</li>
                            <li>
                              Create a token with R2 Storage read/write access so this panel can
                              manage buckets and objects.
                            </li>
                            <li>Copy the token once and paste it here.</li>
                          </ol>
                          <div className="pt-1 space-y-1">
                            <a
                              href="https://dash.cloudflare.com/profile/api-tokens"
                              target="_blank"
                              rel="noreferrer"
                              className="text-[11px] text-blue-600 hover:underline"
                            >
                              Open API Tokens page
                            </a>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="apiToken">Cloudflare account API token</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(apiToken)
                                  toast.success("API token copied")
                                } catch {
                                  toast.error("Unable to copy API token")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setApiToken(text)
                                } catch {
                                  toast.error("Unable to paste API token")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setApiToken("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <Input
                          id="apiToken"
                          value={apiToken}
                          onChange={(e) => setApiToken(e.target.value)}
                          required
                        />
                        {tokenStatus !== "idle" && (
                          <p
                            className={
                              tokenStatus === "valid"
                                ? "text-[11px] text-emerald-500"
                                : "text-[11px] text-red-500"
                            }
                          >
                            {tokenMessage ||
                              (tokenStatus === "valid"
                                ? "Token looks valid."
                                : "Token is not valid.")}
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="r2AccessKeyId">R2 Access Key ID</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(r2AccessKeyId)
                                  toast.success("R2 Access Key ID copied")
                                } catch {
                                  toast.error("Unable to copy R2 Access Key ID")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setR2AccessKeyId(text)
                                } catch {
                                  toast.error("Unable to paste R2 Access Key ID")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setR2AccessKeyId("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <Input
                          id="r2AccessKeyId"
                          value={r2AccessKeyId}
                          onChange={(e) => setR2AccessKeyId(e.target.value)}
                          required
                        />
                      </div>
                      <div className="space-y-2 md:col-span-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="r2SecretAccessKey">R2 Secret Access Key</Label>
                          <div className="flex gap-1 text-[11px]">
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(r2SecretAccessKey)
                                  toast.success("R2 Secret Access Key copied")
                                } catch {
                                  toast.error("Unable to copy R2 Secret Access Key")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  const text = await navigator.clipboard.readText()
                                  setR2SecretAccessKey(text)
                                } catch {
                                  toast.error("Unable to paste R2 Secret Access Key")
                                }
                              }}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              <ClipboardPaste className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setR2SecretAccessKey("")}
                              className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        <Input
                          id="r2SecretAccessKey"
                          type="password"
                          value={r2SecretAccessKey}
                          onChange={(e) => setR2SecretAccessKey(e.target.value)}
                          required
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <DialogFooter className="mt-1 pt-0">
                <Button onClick={handleAddAccount} disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save Account"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
       </div>
     </div>

      {viewAccount && (
        <Dialog open={!!viewAccount} onOpenChange={() => setViewAccount(null)}>
          <DialogContent
            showCloseButton={false}
            className="max-h-[88vh] sm:max-h-[94vh] sm:max-w-3xl flex flex-col rounded-2xl"
          >
            <DialogHeader className="pb-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <DialogTitle>Cloudflare account details</DialogTitle>
                  <DialogDescription>
                    Read-only view of the saved Cloudflare credentials and keys.
                  </DialogDescription>
                </div>
                <div className="mt-1">
                  <Badge
                    className={
                      viewAccount.status === "active"
                        ? "bg-green-500 hover:bg-green-600"
                        : viewAccount.status === "available"
                        ? "text-blue-500 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20"
                        : "bg-zinc-700 text-zinc-100"
                    }
                  >
                    {viewAccount.status.charAt(0).toUpperCase() +
                      viewAccount.status.slice(1)}
                  </Badge>
                </div>
              </div>
            </DialogHeader>
            <div className="-mt-2 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="space-y-6 pb-6">
                <div className="rounded-lg border bg-muted/40 px-4 pt-4 pb-3 space-y-4 mb-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Account details
                  </p>
                  <div className="grid gap-3 md:grid-cols-2 text-sm">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Added date
                      </span>
                      <span className="font-medium">
                        {viewAccount.createdAt
                          ? new Date(viewAccount.createdAt).toLocaleString()
                          : "-"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Last synced
                      </span>
                      <span className="font-medium">
                        {viewAccount.lastSyncedAt
                          ? new Date(viewAccount.lastSyncedAt).toLocaleString()
                          : "Never"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total buckets
                      </span>
                      <span className="font-medium">
                        {viewAccount.totalBuckets}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total objects
                      </span>
                      <span className="font-medium">
                        {viewAccount.totalObjects ?? 0}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total size
                      </span>
                      <span className="font-medium">
                        {formatBytes(viewAccount.totalBytes)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Status
                      </span>
                      <span className="font-medium">
                        {viewAccount.status.charAt(0).toUpperCase() +
                          viewAccount.status.slice(1)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4 mb-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Cloudflare Login
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-label">Account label</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text =
                                viewAccount.name ||
                                viewAccount.email ||
                                `Account ${viewAccount.id.slice(0, 8)}`
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("Account label copied")
                              } catch {
                                toast.error("Unable to copy label")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <Input
                        id="view-label"
                        value={
                          viewAccount.name ||
                          viewAccount.email ||
                          `Account ${viewAccount.id.slice(0, 8)}`
                        }
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-email">Cloudflare email</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text = viewAccount.email || ""
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("Email copied")
                              } catch {
                                toast.error("Unable to copy email")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <Input
                        id="view-email"
                        type="email"
                        value={viewAccount.email}
                        readOnly
                        disabled
                      />
                    </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="view-password">Cloudflare password</Label>
                      <div className="flex gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={async () => {
                            const text = viewAccount.password || ""
                            if (!text) return
                            try {
                              await navigator.clipboard.writeText(text)
                              toast.success("Password copied")
                            } catch {
                              toast.error("Unable to copy password")
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowViewPassword((v) => !v)}
                          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          aria-label={showViewPassword ? "Hide password" : "Show password"}
                        >
                          <Eye className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <Input
                      id="view-password"
                      type={showViewPassword ? "text" : "password"}
                      value={viewAccount.password}
                      readOnly
                      disabled
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-baseline gap-1">
                        <Label htmlFor="view-totp">2FA code</Label>
                        {viewTotpSecondsLeft != null && (
                          <span className="text-[10px] text-muted-foreground">
                            ({viewTotpSecondsLeft}s)
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1 text-[11px]">
                        <button
                          type="button"
                          onClick={async () => {
                            const text = viewTotpCode || ""
                            if (!text) return
                            try {
                              await navigator.clipboard.writeText(text)
                              toast.success("2FA code copied")
                            } catch {
                              toast.error("Unable to copy 2FA code")
                            }
                          }}
                          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                        >
                          <Copy className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <Input
                      id="view-totp"
                      value={viewTotpCode ?? ""}
                      placeholder={viewAccount.twoFactorSecret ? "Calculating..." : ""}
                      readOnly
                      disabled
                    />
                  </div>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      API Access
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-accountId">Account ID</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text = viewAccount.accountId || ""
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("Account ID copied")
                              } catch {
                            toast.error("Unable to copy Account ID")
                          }
                        }}
                        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                      >
                        <Copy className="h-3 w-3" />
                      </button>
                        </div>
                      </div>
                      <Input
                        id="view-accountId"
                        value={viewAccount.accountId || ""}
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-apiToken">Cloudflare account API token</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text = viewAccount.apiToken || ""
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("API token copied")
                              } catch {
                                toast.error("Unable to copy API token")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <Input
                        id="view-apiToken"
                        value={viewAccount.apiToken}
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-r2AccessKeyId">R2 Access Key ID</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text = viewAccount.r2AccessKeyId || ""
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("R2 Access Key ID copied")
                              } catch {
                                toast.error("Unable to copy R2 Access Key ID")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <Input
                        id="view-r2AccessKeyId"
                        value={viewAccount.r2AccessKeyId}
                        readOnly
                        disabled
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="view-r2SecretAccessKey">R2 Secret Access Key</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              const text = viewAccount.r2SecretAccessKey || ""
                              if (!text) return
                              try {
                                await navigator.clipboard.writeText(text)
                                toast.success("R2 Secret Access Key copied")
                              } catch {
                                toast.error("Unable to copy R2 Secret Access Key")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowViewR2Secret((v) => !v)}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            aria-label={
                              showViewR2Secret ? "Hide R2 secret key" : "Show R2 secret key"
                            }
                          >
                            <Eye className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                      <Input
                        id="view-r2SecretAccessKey"
                        type={showViewR2Secret ? "text" : "password"}
                        value={viewAccount.r2SecretAccessKey}
                        readOnly
                        disabled
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <DialogFooter className="mt-1 pt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setViewAccount(null)}
              >
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {settingsAccount && (
        <Dialog open={!!settingsAccount} onOpenChange={() => setSettingsAccount(null)}>
          <DialogContent
            showCloseButton={false}
            className="max-h-[88vh] sm:max-h-[94vh] sm:max-w-3xl flex flex-col rounded-2xl"
          >
            <DialogHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <DialogTitle>Cloudflare account settings</DialogTitle>
                  <DialogDescription>
                    {settingsAccount.email && (
                      <span className="block text-xs text-muted-foreground mt-1">
                        Email:{" "}
                        <span className="font-mono break-all">
                          {settingsAccount.email}
                        </span>
                      </span>
                    )}
                    {settingsAccount.accountId && (
                      <span className="block text-xs text-muted-foreground mt-1">
                        Account ID:{" "}
                        <span className="font-mono break-all">
                          {settingsAccount.accountId}
                        </span>
                      </span>
                    )}
                  </DialogDescription>
                </div>
                <div className="flex items-start justify-end gap-2 pt-1">
                  <Button type="button" size="sm" onClick={handleSaveSettings}>
                    Save changes
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => setSettingsAccount(null)}
                    className="h-8 w-8 rounded-full border border-border"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <div className="mt-1 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="space-y-6 pb-6">
                <div className="rounded-lg border bg-muted/40 px-4 pt-4 pb-3 space-y-4 mb-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Account details
                  </p>
                  <div className="grid gap-3 md:grid-cols-2 text-sm">
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Added date
                      </span>
                      <span className="font-medium">
                        {settingsAccount.createdAt
                          ? new Date(settingsAccount.createdAt).toLocaleString()
                          : "-"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Last synced
                      </span>
                      <span className="font-medium">
                        {settingsAccount.lastSyncedAt
                          ? new Date(settingsAccount.lastSyncedAt).toLocaleString()
                          : "Never"}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total buckets
                      </span>
                      <span className="font-medium">
                        {settingsAccount.totalBuckets}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total objects
                      </span>
                      <span className="font-medium">
                        {settingsAccount.totalObjects ?? 0}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Total size
                      </span>
                      <span className="font-medium">
                        {formatBytes(settingsAccount.totalBytes)}
                      </span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="text-muted-foreground text-xs uppercase tracking-wide">
                        Status
                      </span>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={settingsAccount.status !== "disabled"}
                          disabled={settingsAccount.status === "active"}
                          onCheckedChange={async (checked) => {
                            const next: Account["status"] = checked
                              ? settingsAccount.status === "active"
                                ? "active"
                                : "available"
                              : "disabled"
                            if (next === settingsAccount.status) return
                            if (next === "active") return
                            if (
                              settingsAccount.status === "disabled" &&
                              next === "available"
                            ) {
                              setEnableAccount(settingsAccount)
                              return
                            }
                            await handleChangeStatus(settingsAccount.id, next)
                            setSettingsAccount((prev) =>
                              prev ? { ...prev, status: next } : prev
                            )
                          }}
                        />
                        <span className="text-xs text-muted-foreground">
                          {settingsAccount.status === "disabled"
                            ? "Disabled"
                            : settingsAccount.status === "active"
                            ? "Active (managed by migrations)"
                            : "Available"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4 mb-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Cloudflare Login
                  </p>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-label">Account label</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editLabel)
                                toast.success("Label copied")
                              } catch {
                                toast.error("Unable to copy label")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditLabel(text)
                              } catch {
                                toast.error("Unable to paste label")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditLabel("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <Input
                        id="edit-label"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-email">Cloudflare email</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editEmail)
                                toast.success("Email copied")
                              } catch {
                                toast.error("Unable to copy email")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditEmail(text)
                              } catch {
                                toast.error("Unable to paste email")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditEmail("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <Input
                        id="edit-email"
                        type="email"
                        value={editEmail}
                        onChange={(e) => setEditEmail(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-password">Cloudflare password</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editPassword)
                                toast.success("Password copied")
                              } catch {
                                toast.error("Unable to copy password")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditPassword(text)
                              } catch {
                                toast.error("Unable to paste password")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditPassword("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="relative">
                        <Input
                          id="edit-password"
                          type={showEditPassword ? "text" : "password"}
                          value={editPassword}
                          onChange={(e) => setEditPassword(e.target.value)}
                          required
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowEditPassword((v) => !v)}
                          className="absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground hover:text-foreground"
                          aria-label={showEditPassword ? "Hide password" : "Show password"}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-twoFactorSecret">2FA secret</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editTwoFactorSecret)
                                toast.success("2FA secret copied")
                              } catch {
                                toast.error("Unable to copy 2FA secret")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditTwoFactorSecret(text)
                              } catch {
                                toast.error("Unable to paste 2FA secret")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditTwoFactorSecret("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="relative">
                        <Input
                          id="edit-twoFactorSecret"
                          type={showEditTwoFactor ? "text" : "password"}
                          value={editTwoFactorSecret}
                          onChange={(e) => setEditTwoFactorSecret(e.target.value)}
                          required
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowEditTwoFactor((v) => !v)}
                          className="absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground hover:text-foreground"
                          aria-label={
                            showEditTwoFactor ? "Hide 2FA secret" : "Show 2FA secret"
                          }
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </div>
                      {editTwoFactorSecret && (
                        <p className="text-[11px] text-muted-foreground flex items-center gap-2">
                          <span>
                            Current 2FA code:{" "}
                            <span className="font-mono">
                              {editTotpCode ?? "------"}
                            </span>
                            {editTotpSecondsLeft != null && (
                              <> · refresh in {editTotpSecondsLeft}s</>
                            )}
                          </span>
                          {editTotpCode && (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await navigator.clipboard.writeText(editTotpCode)
                                  toast.success("2FA code copied")
                                } catch {
                                  toast.error("Unable to copy 2FA code")
                                }
                              }}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-md border bg-background text-[10px] text-muted-foreground hover:bg-muted"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border bg-muted/40 p-4 pb-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      API Access
                    </p>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-accountId">Account ID</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={() => handleSyncAccountId(settingsAccount.id)}
                            disabled={syncingId === settingsAccount.id}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                            aria-label="Sync account ID from token"
                          >
                            <RefreshCw className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editAccountId)
                                toast.success("Account ID copied")
                              } catch {
                                toast.error("Unable to copy Account ID")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditAccountId(text)
                              } catch {
                                toast.error("Unable to paste Account ID")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditAccountId("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <Input
                        id="edit-accountId"
                        value={editAccountId}
                        onChange={(e) => setEditAccountId(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-apiToken">Cloudflare account API token</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editApiToken)
                                toast.success("API token copied")
                              } catch {
                                toast.error("Unable to copy API token")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditApiToken(text)
                              } catch {
                                toast.error("Unable to paste API token")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditApiToken("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <Input
                        id="edit-apiToken"
                        value={editApiToken}
                        onChange={(e) => setEditApiToken(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-r2AccessKeyId">R2 Access Key ID</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editR2AccessKeyId)
                                toast.success("R2 Access Key ID copied")
                              } catch {
                                toast.error("Unable to copy R2 Access Key ID")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditR2AccessKeyId(text)
                              } catch {
                                toast.error("Unable to paste R2 Access Key ID")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditR2AccessKeyId("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <Input
                        id="edit-r2AccessKeyId"
                        value={editR2AccessKeyId}
                        onChange={(e) => setEditR2AccessKeyId(e.target.value)}
                        required
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="edit-r2SecretAccessKey">R2 Secret Access Key</Label>
                        <div className="flex gap-1 text-[11px]">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await navigator.clipboard.writeText(editR2SecretAccessKey)
                                toast.success("R2 Secret Access Key copied")
                              } catch {
                                toast.error("Unable to copy R2 Secret Access Key")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                const text = await navigator.clipboard.readText()
                                setEditR2SecretAccessKey(text)
                              } catch {
                                toast.error("Unable to paste R2 Secret Access Key")
                              }
                            }}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            <ClipboardPaste className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditR2SecretAccessKey("")}
                            className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                          >
                            Clear
                          </button>
                        </div>
                      </div>
                      <div className="relative">
                        <Input
                          id="edit-r2SecretAccessKey"
                          type={showEditR2Secret ? "text" : "password"}
                          value={editR2SecretAccessKey}
                          onChange={(e) => setEditR2SecretAccessKey(e.target.value)}
                          required
                          className="pr-8"
                        />
                        <button
                          type="button"
                          onClick={() => setShowEditR2Secret((v) => !v)}
                          className="absolute inset-y-0 right-2 flex items-center text-xs text-muted-foreground hover:text-foreground"
                          aria-label={
                            showEditR2Secret ? "Hide R2 secret key" : "Show R2 secret key"
                          }
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {confirmAction?.account && (
        <Dialog
          open={!!confirmAction}
          onOpenChange={(open) => {
            if (!open) setConfirmAction(null)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirmAction.type === "delete"
                  ? "Remove Cloudflare account"
                  : "Disable Cloudflare account"}
              </DialogTitle>
              <DialogDescription>
                {confirmAction.type === "delete" ? (
                  <>
                    This will permanently remove{" "}
                    <span className="font-semibold">
                      {confirmAction.account.name}
                    </span>{" "}
                    from this dashboard.
                  </>
                ) : (
                  <>
                    This will mark{" "}
                    <span className="font-semibold">
                      {confirmAction.account.name}
                    </span>{" "}
                    as disabled and it can&apos;t be used for migrations.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmAction(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant={confirmAction.type === "delete" ? "destructive" : "default"}
                onClick={async () => {
                  const current = confirmAction
                  if (!current?.account) return
                  if (current.type === "delete") {
                    await handleDelete(current.account.id)
                  } else {
                    await handleChangeStatus(current.account.id, "disabled")
                  }
                  setConfirmAction(null)
                }}
              >
                Confirm
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {enableAccount && (
        <Dialog
          open={!!enableAccount}
          onOpenChange={(open) => {
            if (!open) setEnableAccount(null)
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Enable Cloudflare account</DialogTitle>
              <DialogDescription>
                This will mark{" "}
                <span className="font-semibold">
                  {enableAccount.name || enableAccount.email || "this account"}
                </span>{" "}
                as available so it can be used for future migrations.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEnableAccount(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={async () => {
                  const account = enableAccount
                  if (!account) return
                  await handleChangeStatus(account.id, "available")
                  setSettingsAccount((prev) =>
                    prev && prev.id === account.id
                      ? { ...prev, status: "available" }
                      : prev
                  )
                  setEnableAccount(null)
                }}
              >
                Enable account
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <div className="rounded-lg border bg-muted/40 px-2 py-1 sm:px-3 sm:py-2">
        <Table className="table-fixed w-full">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="h-9">
                {headerGroup.headers.map((header) => {
                  const columnId = header.column.id
                  const colWidth =
                    columnId === "name"
                      ? "w-[20%]"
                      : columnId === "email"
                      ? "w-[18%]"
                      : columnId === "status"
                      ? "w-[10%]"
                      : columnId === "createdAt"
                      ? "w-[16%]"
                      : columnId === "totalBuckets"
                      ? "w-[10%]"
                      : columnId === "spacer"
                      ? "w-[4%]"
                      : columnId === "actions"
                      ? "w-[20%]"
                      : ""

                  return (
                    <TableHead key={header.id} className={colWidth}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext()
                          )}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {paginatedRows.length ? (
              paginatedRows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className="h-10"
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Showing{" "}
          {totalRows === 0
            ? 0
            : currentPageIndex * pageSize + 1}{" "}
          -{" "}
          {Math.min((currentPageIndex + 1) * pageSize, totalRows)} of{" "}
          {totalRows} accounts
        </span>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <span>
              Page {totalRows ? currentPageIndex + 1 : 0} of{" "}
              {totalRows ? totalPages : 0}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2"
              disabled={currentPageIndex === 0}
              onClick={() =>
                setPageIndex((prev) => Math.max(0, prev - 1))
              }
            >
              Prev
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2"
              disabled={currentPageIndex >= totalPages - 1 || totalRows === 0}
              onClick={() =>
                setPageIndex((prev) =>
                  Math.min(totalPages - 1, prev + 1)
                )
              }
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

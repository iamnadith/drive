"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { CheckCircle2, AlertCircle, Clock, ExternalLink } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type Account = {
  id: string
  label: string
  email: string
  status: "active" | "available" | "disabled"
}

type Migration = {
  id: string
  sourceAccountId: string
  targetAccountId: string
  status: "draft" | "running" | "verifying" | "completed" | "failed" | "canceled"
  createdAt: string
  startedAt?: string
  completedAt?: string
  syncStatus?: "idle" | "syncing" | "ok" | "error"
  syncMessage?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function statusBadge(status: string) {
  if (status === "completed") return <Badge className="bg-green-600">Completed</Badge>
  if (status === "verifying") return <Badge className="bg-purple-600">Verifying</Badge>
  if (status === "running") return <Badge className="bg-primary text-primary-foreground">Running</Badge>
  if (status === "failed") return <Badge className="bg-red-600">Failed</Badge>
  if (status === "canceled") return <Badge variant="secondary">Canceled</Badge>
  if (status === "draft") return <Badge variant="outline">Draft</Badge>
  return <Badge variant="outline">{status}</Badge>
}

export default function MigrationsHistoryPage() {
  const router = useRouter()
  const [accounts, setAccounts] = React.useState<Account[]>([])
  const [migrations, setMigrations] = React.useState<Migration[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [initialLoading, setInitialLoading] = React.useState(true)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const [accountsRes, migrationsRes] = await Promise.all([fetch("/api/accounts"), fetch("/api/migrations")])
        const accountsJson: unknown = accountsRes.ok ? await accountsRes.json() : { accounts: [] }
        const migrationsJson: unknown = migrationsRes.ok ? await migrationsRes.json() : { migrations: [] }

        const nextAccounts =
          isRecord(accountsJson) && Array.isArray(accountsJson.accounts) ? (accountsJson.accounts as Account[]) : []
        const nextMigrations =
          isRecord(migrationsJson) && Array.isArray(migrationsJson.migrations)
            ? (migrationsJson.migrations as Migration[])
            : []

        if (cancelled) return
        setAccounts(nextAccounts)
        setMigrations(nextMigrations)
      } catch (e: unknown) {
        const message =
          typeof e === "object" && e !== null && "message" in e
            ? String((e as { message?: unknown }).message ?? "Unable to load migrations")
            : "Unable to load migrations"
        if (!cancelled) setError(message)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setInitialLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const accountLabelById = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const a of accounts) map.set(a.id, a.label)
    return map
  }, [accounts])

  const confirmDelete = async () => {
    if (!deleteId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/migrations/${encodeURIComponent(deleteId)}`, { method: "DELETE" })
      const json: unknown = await res.json().catch(() => ({}))
      const errorMessage = isRecord(json) && typeof json.error === "string" ? json.error : "Unable to delete migration"
      if (!res.ok) throw new Error(errorMessage)
      setMigrations((prev) => prev.filter((m) => m.id !== deleteId))
      setDeleteId(null)
    } catch (e: unknown) {
      const message =
        typeof e === "object" && e !== null && "message" in e
          ? String((e as { message?: unknown }).message ?? "Unable to delete migration")
          : "Unable to delete migration"
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Migration history</h1>
          <p className="text-sm text-muted-foreground">All migrations stored in the database.</p>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All migrations</CardTitle>
          <CardDescription>Click Details to view full migration state and bucket/job progress.</CardDescription>
        </CardHeader>
        <CardContent>
          {initialLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-48" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : migrations.length === 0 ? (
            <div className="text-sm text-muted-foreground">No migrations yet</div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="table-fixed w-full min-w-[920px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[260px]">ID</TableHead>
                    <TableHead className="w-[140px]">Status</TableHead>
                    <TableHead className="w-[160px]">Source</TableHead>
                    <TableHead className="w-[160px]">Target</TableHead>
                    <TableHead className="w-[180px]">Created</TableHead>
                      <TableHead>Message</TableHead>
                    <TableHead className="w-[220px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {migrations.map((m) => {
                    const icon =
                      m.status === "completed" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-600" />
                      ) : m.status === "verifying" ? (
                        <Clock className="h-4 w-4 text-purple-600" />
                      ) : m.status === "running" ? (
                        <Clock className="h-4 w-4 text-primary" />
                      ) : m.status === "failed" ? (
                        <AlertCircle className="h-4 w-4 text-red-600" />
                      ) : (
                        <Clock className="h-4 w-4 text-muted-foreground" />
                      )
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs">
                          <div className="flex items-center gap-2">
                            {icon}
                            <span className="truncate">{m.id}</span>
                          </div>
                        </TableCell>
                        <TableCell>{statusBadge(m.status)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {accountLabelById.get(m.sourceAccountId) ?? m.sourceAccountId}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {accountLabelById.get(m.targetAccountId) ?? m.targetAccountId}
                        </TableCell>
                        <TableCell className="text-sm">{new Date(m.createdAt).toLocaleString()}</TableCell>
                        <TableCell className="text-sm text-muted-foreground truncate">{m.syncMessage ?? ""}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => router.push(`/dashboard/migrations/${encodeURIComponent(m.id)}`)}
                              disabled={loading}
                            >
                              <ExternalLink className="h-4 w-4 mr-2" />
                              Details
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setDeleteId(m.id)}
                              disabled={loading}
                            >
                              {deleteId === m.id && loading ? <Spinner className="mr-2" /> : null}
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleteId)} onOpenChange={(open) => (!open ? setDeleteId(null) : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete migration?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the migration and its stored items from the database. It does not cancel Cloudflare jobs that may already be running.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={loading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={loading}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

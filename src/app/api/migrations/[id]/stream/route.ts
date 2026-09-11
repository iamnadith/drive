import { NextResponse } from "next/server"
import { getMigration, listMigrationItems } from "@/lib/migrations-store"
import { listRepairJobsByMigration } from "@/lib/repair-jobs-store"
import { requireAdmin } from "@/lib/server-auth"
import { listMigrationWorkerRuns } from "@/lib/migration-worker-runs"

export const runtime = "nodejs"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  const { id } = await context.params

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          closed = true
        }
      }

      const send = (event: string, data: unknown) => {
        safeEnqueue(encoder.encode(`event: ${event}\n`))
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      }

      const close = () => {
        if (closed) return
        closed = true
        try {
          controller.close()
        } catch {
          // ignore
        }
      }

      if (request.signal.aborted) {
        close()
        return
      }
      request.signal.addEventListener("abort", close, { once: true })

      const loop = async () => {
        let lastSnapshot = ""
        let lastSentAt = 0
        // Basic heartbeat + DB state. Cloudflare syncing is driven by /sync.
        while (!closed && !request.signal.aborted) {
          let nextDelay = 10_000
          try {
            const migration = await getMigration(id)
            if (!migration) {
              send("error", { error: "Migration not found" })
              break
            }
            const [items, repairJobs, workerRuns] = await Promise.all([
              listMigrationItems(id),
              migration.options.executionMode === "migration_workers" ? Promise.resolve([]) : listRepairJobsByMigration(id, 20).catch(() => []),
              migration.options.executionMode === "migration_workers" ? listMigrationWorkerRuns(id).catch(() => []) : Promise.resolve([]),
            ])
            const snapshot = { migration, items, repairJobs: repairJobs.filter((job) => job.mode !== "migration"), workerRuns }
            const serialized = JSON.stringify(snapshot)
            const now = Date.now()
            if (serialized !== lastSnapshot || now - lastSentAt >= 15_000) {
              send("snapshot", { ...snapshot, serverTime: new Date(now).toISOString() })
              lastSnapshot = serialized
              lastSentAt = now
            } else {
              safeEnqueue(encoder.encode(": keepalive\n\n"))
            }
            nextDelay = ["running", "verifying", "queued"].includes(migration.status) ? 4_000 : 15_000
          } catch (e: unknown) {
            const message =
              typeof e === "object" && e !== null && "message" in e
                ? String((e as { message?: unknown }).message ?? "Stream error")
                : "Stream error"
            send("error", { error: message })
          }
          await sleep(nextDelay)
        }

        close()
      }

      void loop()
    },
  })

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}

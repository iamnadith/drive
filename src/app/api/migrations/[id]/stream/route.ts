import { NextResponse } from "next/server"
import { getMigration, listMigrationItems } from "@/lib/migrations-store"

export const runtime = "nodejs"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
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
        // Basic heartbeat + DB state. Cloudflare syncing is driven by /sync.
        while (!closed && !request.signal.aborted) {
          try {
            const migration = await getMigration(id)
            if (!migration) {
              send("error", { error: "Migration not found" })
              break
            }
            const items = await listMigrationItems(id)
            send("snapshot", { migration, items, serverTime: new Date().toISOString() })
          } catch (e: unknown) {
            const message =
              typeof e === "object" && e !== null && "message" in e
                ? String((e as { message?: unknown }).message ?? "Stream error")
                : "Stream error"
            send("error", { error: message })
          }
          await sleep(1000)
        }

        close()
      }

      void loop()
    },
  })

  return new NextResponse(stream as any, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  })
}

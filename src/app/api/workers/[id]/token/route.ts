import { NextResponse } from "next/server"
import { ensureAgentRegistrationToken, getAgentById } from "@/lib/agents-store"
import { getMigrationWorkerSettings } from "@/lib/migration-worker-settings-store"
import { requireAdmin } from "@/lib/server-auth"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAdmin()
    if (!auth.ok) return auth.response

    const { id } = await context.params
    const worker = await getAgentById(id)
    if (!worker) return NextResponse.json({ error: "Worker not found" }, { status: 404 })

    if (worker.provider === "github_actions") {
      const settings = await getMigrationWorkerSettings()
      return NextResponse.json({ workerId: worker.id, token: null, sharedSecretConfigured: settings.sharedSecret.length >= 24 && settings.sharedSecret.length <= 512 })
    }
    const token = await ensureAgentRegistrationToken(id)
    return NextResponse.json({ workerId: worker.id, token, sharedSecretConfigured: false })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to load worker token"
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

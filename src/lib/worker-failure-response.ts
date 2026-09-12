import { after } from "next/server"
import { NextResponse } from "next/server"

import { reconcileAndRepairCloudflareWorkers } from "@/lib/cloudflare-worker-installer"

export function scheduleWorkerRepair() {
  after(async () => {
    await reconcileAndRepairCloudflareWorkers(true).catch((repairError) => {
      console.error("Cloudflare Worker failure recovery failed", repairError)
    })
  })
}

export function workerFailureResponse(error: unknown) {
  scheduleWorkerRepair()
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 502, headers: { "X-Drive-Worker-Failure": "1" } },
  )
}

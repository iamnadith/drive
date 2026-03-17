import { getMigration, listMigrationItems, mergeMigrationItemProgressState, updateMigration, type DriveMigrationItem } from "./migrations-store"
import { listRepairJobsByMigration, type DriveRepairJob } from "./repair-jobs-store"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

function isCompletedStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "completed" || s === "copy_completed" || s === "complete" || s === "finished" || s === "success" || s === "succeeded"
}

function isAbortedStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "aborted" || s === "canceled" || s === "copy_aborted"
}

function isFailedLikeStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "precheck_failed" || s === "bucket_create_failed" || s === "job_create_failed" || s.endsWith("_failed") || s.includes("failed") || s.includes("error")
}

function readRepairWorkerState(progress: Record<string, unknown>) {
  if (!isRecord(progress.repairWorker)) return null
  const repair = progress.repairWorker as Record<string, unknown>
  return {
    stage: typeof repair.stage === "string" ? repair.stage : undefined,
    status: typeof repair.status === "string" ? repair.status : undefined,
    transferred: typeof repair.transferred === "number" ? repair.transferred : 0,
    failed: typeof repair.failed === "number" ? repair.failed : 0,
    skipped: typeof repair.skipped === "number" ? repair.skipped : 0,
    details: isRecord(repair.details) ? repair.details : null,
  }
}

function readSlurperResult(progress: Record<string, unknown>) {
  const candidates = [progress.slurperCumulative, progress.slurperNormalized, isRecord(progress.slurper) ? (progress.slurper as Record<string, unknown>).result : null]
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue
    return {
      objects: typeof candidate.objects === "number" ? candidate.objects : 0,
      transferredObjects: typeof candidate.transferredObjects === "number" ? candidate.transferredObjects : 0,
      skippedObjects: typeof candidate.skippedObjects === "number" ? candidate.skippedObjects : 0,
      failedObjects: typeof candidate.failedObjects === "number" ? candidate.failedObjects : 0,
      status: typeof candidate.status === "string" ? candidate.status : undefined,
    }
  }
  return null
}

function readVerifyState(progress: Record<string, unknown>) {
  const verify = isRecord(progress.verify) ? (progress.verify as Record<string, unknown>) : null
  if (!verify) return null
  const status = typeof verify.status === "string" ? verify.status : ""
  if (status !== "pending" && status !== "running" && status !== "ok" && status !== "error") return null
  return {
    status,
    missingInDest: typeof verify.missingInDest === "number" ? verify.missingInDest : 0,
    sizeMismatched: typeof verify.sizeMismatched === "number" ? verify.sizeMismatched : 0,
    extraInDest: typeof verify.extraInDest === "number" ? verify.extraInDest : 0,
    note: typeof verify.note === "string" ? verify.note : "",
  }
}

function readLiveRepairVerificationIssues(input: {
  repairStatus?: string
  finalMissing: number
  finalMismatched: number
  verify?: { status: string; missingInDest: number; sizeMismatched: number; extraInDest: number } | null
}): number {
  const repairStatus = normalizeStatus(input.repairStatus)
  const workerIssues = input.finalMissing + input.finalMismatched
  if (repairStatus === "completed" || repairStatus === "failed" || repairStatus === "error") {
    return workerIssues
  }
  return input.verify?.status === "error" ? input.verify.missingInDest + input.verify.sizeMismatched + input.verify.extraInDest : 0
}

function getItemStatus(item: DriveMigrationItem): string | undefined {
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const stage = typeof progress.stage === "string" ? progress.stage : ""
  const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
  if (
    !item.slurperJobId &&
    (stage === "scan_seeded" ||
      ((stage === "scanning_source" || sourceScanStatus === "pending" || sourceScanStatus === "running") &&
        sourceScanStatus !== "completed" &&
        sourceScanStatus !== "failed"))
  ) {
    return "scanning"
  }
  if (!item.slurperJobId && stage === "scan_failed") return "failed"
  if (typeof item.slurperStatus === "string" && item.slurperStatus.length > 0) return item.slurperStatus
  if (typeof progress.slurperStatus === "string" && progress.slurperStatus.length > 0) return String(progress.slurperStatus)
  return readSlurperResult(progress)?.status
}

function getItemDisplayStatus(
  item: DriveMigrationItem,
  repairResultItem?: Record<string, unknown>,
  repairStatusOverride?: string
): string | undefined {
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const repairState = readRepairWorkerState(progress)
  const repairStatus = normalizeStatus(repairStatusOverride || repairState?.status)
  const repairStage = normalizeStatus(repairState?.stage)
  const repairDetails = repairState?.details
  const finalMissing =
    (repairResultItem && typeof repairResultItem.finalMissing === "number" ? repairResultItem.finalMissing : 0) +
    (repairDetails && typeof repairDetails.finalMissing === "number" ? Number(repairDetails.finalMissing) : 0)
  const finalMismatched =
    (repairResultItem && typeof repairResultItem.finalMismatched === "number" ? repairResultItem.finalMismatched : 0) +
    (repairDetails && typeof repairDetails.finalMismatched === "number" ? Number(repairDetails.finalMismatched) : 0)
  const resolvedAllObjects = repairResultItem?.resolvedAllObjects === true || (repairStatus === "completed" && finalMissing === 0 && finalMismatched === 0)

  if (repairStatus === "running") {
    if (repairStage.includes("scan")) return "scanning"
    if (repairStage.includes("verify")) return "verifying"
    return "running"
  }
  if (repairStatus === "claimed" || repairStatus === "pending") return "running"
  if (repairStatus === "completed") return resolvedAllObjects ? "completed" : finalMissing > 0 || finalMismatched > 0 ? "failed" : "completed"
  if (repairStatus === "failed" || repairStatus === "error") return "failed"
  if (repairStatus === "canceled" || repairStatus === "aborted") return "aborted"

  const base = getItemStatus(item)
  if (base === "scanning") return "scanning"
  if (base === "scan_failed") return "failed"
  if (!isCompletedStatus(base)) return base
  const verify = readVerifyState(progress)
  if (verify?.status === "pending" || verify?.status === "running") return "verifying"
  if (verify?.status === "error") return "verification_failed"
  if (verify?.status === "ok" && verify.note === "no_source_objects") return "no_files"
  return base
}

function readRepairItems(job: DriveRepairJob | null | undefined): Array<Record<string, unknown>> {
  if (!job || !isRecord(job.result) || !Array.isArray(job.result.items)) return []
  return job.result.items.filter(isRecord)
}

function readRepairPayloadItemIds(job: DriveRepairJob | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (!job || !isRecord(job.payload) || !Array.isArray(job.payload.items)) return ids
  for (const raw of job.payload.items) {
    if (!isRecord(raw)) continue
    const itemId = typeof raw.id === "string" ? raw.id : typeof raw.itemId === "string" ? raw.itemId : ""
    if (itemId) ids.add(itemId)
  }
  return ids
}

function isTerminalRepairJobStatus(value: string | undefined): boolean {
  const status = normalizeStatus(value)
  return status === "completed" || status === "failed" || status === "canceled"
}

function isActiveRepairWorkerStatus(value: string | undefined): boolean {
  const status = normalizeStatus(value)
  return status === "running" || status === "claimed" || status === "pending"
}

function getLatestRepairJob(jobs: DriveRepairJob[]): DriveRepairJob | null {
  if (jobs.length === 0) return null
  const sorted = [...jobs].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
  return sorted.find((job) => job.status === "running" || job.status === "claimed" || job.status === "pending") ?? sorted[0] ?? null
}

export async function syncMigrationLiveState(migrationId: string): Promise<void> {
  const migration = await getMigration(migrationId)
  if (!migration) return

  const [items, repairJobs] = await Promise.all([listMigrationItems(migrationId), listRepairJobsByMigration(migrationId, 20)])
  const latestRepairJob = getLatestRepairJob(repairJobs)
  const latestRepairItemsById = new Map<string, Record<string, unknown>>()
  const latestRepairItemIds = readRepairPayloadItemIds(latestRepairJob)
  for (const item of readRepairItems(latestRepairJob)) {
    const itemId = typeof item.itemId === "string" ? item.itemId : ""
    if (!itemId) continue
    latestRepairItemsById.set(itemId, item)
    latestRepairItemIds.add(itemId)
  }

  await Promise.all(
    items.map(async (item) => {
      const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const slurper = readSlurperResult(progress)
      const repairState = readRepairWorkerState(progress)
      const repairResultItem = latestRepairItemsById.get(item.id)
      const verify = readVerifyState(progress)
      const latestRepairJobStatus = normalizeStatus(latestRepairJob?.status)
      const repairAppliesToItem = latestRepairItemIds.has(item.id)
      const currentRepairStatus = normalizeStatus(repairState?.status)
      const effectiveRepairStatus =
        isTerminalRepairJobStatus(latestRepairJobStatus) &&
        isActiveRepairWorkerStatus(currentRepairStatus) &&
        (repairAppliesToItem || !latestRepairJob || latestRepairItemIds.size === 0)
          ? latestRepairJobStatus === "canceled"
            ? "failed"
            : latestRepairJobStatus
          : repairState?.status
      const displayStatus = getItemDisplayStatus(item, repairResultItem, effectiveRepairStatus)
      const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
      const scanComplete = sourceScanStatus === "completed"
      const total =
        scanComplete && typeof item.sourceObjects === "number"
          ? item.sourceObjects
          : typeof slurper?.objects === "number"
            ? slurper.objects
            : 0
      const workerTransferred = Math.max(
        typeof repairState?.transferred === "number" ? repairState.transferred : 0,
        repairResultItem && typeof repairResultItem.transferred === "number" ? repairResultItem.transferred : 0
      )
      const workerSkipped = Math.max(
        typeof repairState?.skipped === "number" ? repairState.skipped : 0,
        repairResultItem && typeof repairResultItem.skipped === "number" ? repairResultItem.skipped : 0
      )
      const workerFailed = Math.max(
        typeof repairState?.failed === "number" ? repairState.failed : 0,
        repairResultItem && typeof repairResultItem.failed === "number" ? repairResultItem.failed : 0
      )
      const finalMissing =
        (repairResultItem && typeof repairResultItem.finalMissing === "number" ? repairResultItem.finalMissing : 0) +
        (repairState?.details && typeof repairState.details.finalMissing === "number" ? Number(repairState.details.finalMissing) : 0)
      const finalMismatched =
        (repairResultItem && typeof repairResultItem.finalMismatched === "number" ? repairResultItem.finalMismatched : 0) +
        (repairState?.details && typeof repairState.details.finalMismatched === "number" ? Number(repairState.details.finalMismatched) : 0)
      const resolvedAllObjects =
        repairResultItem?.resolvedAllObjects === true ||
        (normalizeStatus(effectiveRepairStatus) === "completed" && finalMissing === 0 && finalMismatched === 0)
      const slurperTransferred = typeof slurper?.transferredObjects === "number" ? slurper.transferredObjects : 0
      const slurperSkipped = typeof slurper?.skippedObjects === "number" ? slurper.skippedObjects : 0
      const slurperFailed = typeof slurper?.failedObjects === "number" ? slurper.failedObjects : 0
      let remainingFixed = Math.max(0, workerTransferred)
      const resolvedFailed = Math.min(slurperFailed, remainingFixed)
      remainingFixed -= resolvedFailed
      const baseUnaccounted = Math.max(0, total - (slurperTransferred + slurperSkipped + slurperFailed))
      const resolvedUnaccounted = Math.min(baseUnaccounted, remainingFixed)
      const verifyIssues = readLiveRepairVerificationIssues({
        repairStatus: effectiveRepairStatus,
        finalMissing,
        finalMismatched,
        verify,
      })

      const live = {
        updatedAt: new Date().toISOString(),
        status: displayStatus ?? null,
        transferredObjects: resolvedAllObjects
          ? Math.max(total > 0 ? total - Math.max(slurperSkipped, workerSkipped) : 0, slurperTransferred + workerTransferred)
          : total > 0
            ? Math.min(total, slurperTransferred + workerTransferred)
            : slurperTransferred + workerTransferred,
        skippedObjects: Math.max(slurperSkipped, workerSkipped),
        failedObjects: resolvedAllObjects ? 0 : Math.max(0, slurperFailed - resolvedFailed + workerFailed + finalMissing + finalMismatched),
        unaccountedObjects: resolvedAllObjects ? 0 : Math.max(0, baseUnaccounted - resolvedUnaccounted - verifyIssues),
        verifyIssues,
        totalObjects: total,
        sourceScanStatus: sourceScanStatus || null,
        workerStage: repairState?.stage ?? null,
        workerStatus: effectiveRepairStatus ?? null,
      }

      const currentLive = isRecord(progress.live) ? (progress.live as Record<string, unknown>) : null
      const same =
        currentLive &&
        currentLive.status === live.status &&
        currentLive.transferredObjects === live.transferredObjects &&
        currentLive.skippedObjects === live.skippedObjects &&
        currentLive.failedObjects === live.failedObjects &&
        currentLive.unaccountedObjects === live.unaccountedObjects &&
        currentLive.verifyIssues === live.verifyIssues &&
        currentLive.totalObjects === live.totalObjects &&
        currentLive.sourceScanStatus === live.sourceScanStatus &&
        currentLive.workerStage === live.workerStage &&
        currentLive.workerStatus === live.workerStatus

      if (!same) {
        await mergeMigrationItemProgressState(item.id, { live }, item.lastProgressAt ?? null)
      }
    })
  )

  const refreshedItems = await listMigrationItems(migrationId)
  const liveStatuses = refreshedItems
    .map((item) => {
      const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const live = isRecord(progress.live) ? (progress.live as Record<string, unknown>) : null
      return normalizeStatus(live && typeof live.status === "string" ? live.status : getItemDisplayStatus(item))
    })
    .filter(Boolean)

  const anyScanning = liveStatuses.some((status) => status === "scanning")
  const anyRunning = liveStatuses.some((status) => status === "running")
  const anyVerifying = liveStatuses.some((status) => status === "verifying")
  const anyFailed = liveStatuses.some((status) => isFailedLikeStatus(status))
  const anyAborted = liveStatuses.some((status) => isAbortedStatus(status))
  const allCompleted = liveStatuses.length > 0 && liveStatuses.every((status) => isCompletedStatus(status) || status === "no_files")
  const allTerminal =
    liveStatuses.length > 0 &&
    liveStatuses.every((status) => isCompletedStatus(status) || isFailedLikeStatus(status) || isAbortedStatus(status) || status === "no_files")
  const now = new Date().toISOString()

  if (anyScanning || anyRunning) {
    await updateMigration(migrationId, {
      status: "running",
      syncStatus: "ok",
      syncMessage: anyScanning ? "Scanning source buckets" : "Progress updated",
      completedAt: null,
      lastSyncedAt: now,
    }).catch(() => undefined)
  } else if (anyVerifying) {
    await updateMigration(migrationId, {
      status: "verifying",
      syncStatus: "ok",
      syncMessage: "Verifying migrated objects",
      completedAt: null,
      lastSyncedAt: now,
    }).catch(() => undefined)
  } else if (allCompleted) {
    await updateMigration(migrationId, {
      status: "completed",
      syncStatus: "ok",
      syncMessage: "",
      completedAt: now,
      lastSyncedAt: now,
    }).catch(() => undefined)
  } else if (allTerminal && anyFailed) {
    await updateMigration(migrationId, {
      status: "failed",
      syncStatus: "error",
      syncMessage: liveStatuses.some((status) => status === "verification_failed")
        ? "Verification failed for one or more buckets"
        : "One or more buckets failed",
      completedAt: now,
      lastSyncedAt: now,
    }).catch(() => undefined)
  } else if (allTerminal && anyAborted && !anyFailed) {
    await updateMigration(migrationId, {
      status: "canceled",
      syncStatus: "ok",
      syncMessage: "Migration aborted",
      completedAt: now,
      lastSyncedAt: now,
    }).catch(() => undefined)
  }
}

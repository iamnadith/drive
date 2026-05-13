import { getMigration, listMigrationItems, mergeMigrationItemProgressState, updateMigration } from "./migrations-store"
import { activateAccountForCompletedMigration } from "./accounts-store"
import { listRepairJobsByMigration, type DriveRepairJob } from "./repair-jobs-store"
import {
  getBucketDisplayStatusRank,
  getEffectiveRepairStatus,
  getItemDisplayStatus,
  isAbortedStatus,
  isActiveRepairWorkerStatus,
  isTerminalBucketDisplayStatus,
  isCompletedStatus,
  isFailedLikeStatus,
  isRecord,
  normalizeStatus,
  readLiveRepairVerificationIssues,
  readRepairWorkerState,
  readSlurperResult,
  readVerifyState,
} from "./migration-bucket-state"

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

function getLatestRepairJob(jobs: DriveRepairJob[]): DriveRepairJob | null {
  if (jobs.length === 0) return null
  const sorted = [...jobs].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
  return sorted.find((job) => job.status === "running" || job.status === "claimed" || job.status === "pending") ?? sorted[0] ?? null
}

export async function syncMigrationLiveState(migrationId: string): Promise<void> {
  const migration = await getMigration(migrationId)
  if (!migration) return
  if (migration.status === "completed" && migration.options?.manualCompleted === true) return

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
      const canceledRepairWithoutResult =
        latestRepairJobStatus === "canceled" &&
        !repairResultItem &&
        isActiveRepairWorkerStatus(repairState?.status)
      const canceledRepairScanOnly =
        canceledRepairWithoutResult &&
        normalizeStatus(repairState?.stage).includes("scan")
      const effectiveRepairStatus = getEffectiveRepairStatus({
        repairWorkerStatus: canceledRepairWithoutResult ? (canceledRepairScanOnly ? undefined : "failed") : repairState?.status,
        latestRepairJobStatus: latestRepairJob?.status,
        repairAppliesToItem: latestRepairItemIds.has(item.id),
        latestRepairJobExists: Boolean(latestRepairJob),
        latestRepairItemCount: latestRepairItemIds.size,
      })
      const displayStatus = getItemDisplayStatus(item, repairResultItem, effectiveRepairStatus)
      const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
      const scanComplete = sourceScanStatus === "completed"
      const currentLive = isRecord(progress.live) ? (progress.live as Record<string, unknown>) : null
      const scannedSourceTotal = typeof item.sourceObjects === "number" ? item.sourceObjects : 0
      const workerSourceTotal =
        repairResultItem && typeof repairResultItem.sourceObjectCount === "number"
          ? repairResultItem.sourceObjectCount
          : repairState?.details && typeof repairState.details.sourceObjectCount === "number"
            ? Number(repairState.details.sourceObjectCount)
            : 0
      const total =
        workerSourceTotal > 0
          ? workerSourceTotal
          : scanComplete || scannedSourceTotal > 0
            ? scannedSourceTotal
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
      const workerInitialMissing =
        repairResultItem && typeof repairResultItem.initialMissing === "number"
          ? repairResultItem.initialMissing
          : repairState?.details && typeof repairState.details.initialMissing === "number"
            ? Number(repairState.details.initialMissing)
            : 0
      const workerInitialMismatched =
        repairResultItem && typeof repairResultItem.initialMismatched === "number"
          ? repairResultItem.initialMismatched
          : repairState?.details && typeof repairState.details.initialMismatched === "number"
            ? Number(repairState.details.initialMismatched)
            : 0
      let remainingFixed = Math.max(0, workerTransferred)
      const baselineFailedCount = Math.max(slurperFailed, workerInitialMissing + workerInitialMismatched)
      const resolvedFailed = Math.min(baselineFailedCount, remainingFixed)
      remainingFixed -= resolvedFailed
      const baseUnaccounted = Math.max(0, total - (slurperTransferred + slurperSkipped + baselineFailedCount))
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
        failedObjects: resolvedAllObjects ? 0 : Math.max(finalMissing + finalMismatched, Math.max(0, baselineFailedCount - workerTransferred)),
        unaccountedObjects: resolvedAllObjects ? 0 : Math.max(0, baseUnaccounted - resolvedUnaccounted - verifyIssues),
        verifyIssues,
        totalObjects: total,
        sourceScanStatus: sourceScanStatus || null,
        workerStage: repairState?.stage ?? null,
        workerStatus: effectiveRepairStatus ?? null,
        slurperJobId: item.slurperJobId ?? null,
        repairJobId: latestRepairJob?.id ?? null,
      }

      const sameSlurperJob = (currentLive?.slurperJobId ?? null) === live.slurperJobId
      const sameRepairJob = (currentLive?.repairJobId ?? null) === live.repairJobId
      const sameCycle = Boolean(live.slurperJobId || live.repairJobId || currentLive?.slurperJobId || currentLive?.repairJobId) && sameSlurperJob && sameRepairJob
      const currentStatus = currentLive && typeof currentLive.status === "string" ? currentLive.status : null
      const nextStatus = live.status

      if (currentLive && sameCycle) {
        if (!isTerminalBucketDisplayStatus(nextStatus)) {
          live.transferredObjects = Math.max(currentLive.transferredObjects === undefined ? 0 : Number(currentLive.transferredObjects), live.transferredObjects)
          live.skippedObjects = Math.max(currentLive.skippedObjects === undefined ? 0 : Number(currentLive.skippedObjects), live.skippedObjects)
          live.failedObjects = Math.max(currentLive.failedObjects === undefined ? 0 : Number(currentLive.failedObjects), live.failedObjects)
          live.verifyIssues = Math.max(currentLive.verifyIssues === undefined ? 0 : Number(currentLive.verifyIssues), live.verifyIssues)
        }

        if (isTerminalBucketDisplayStatus(currentStatus) && !isTerminalBucketDisplayStatus(nextStatus)) {
          live.status = currentStatus
        } else if (
          !isTerminalBucketDisplayStatus(currentStatus) &&
          !isTerminalBucketDisplayStatus(nextStatus) &&
          normalizeStatus(nextStatus) !== "queued" &&
          getBucketDisplayStatusRank(currentStatus) > getBucketDisplayStatusRank(nextStatus)
        ) {
          live.status = currentStatus
        }
      }

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
  } else if (anyFailed) {
    await updateMigration(migrationId, {
      status: "failed",
      syncStatus: "error",
      syncMessage: liveStatuses.some((status) => status === "verification_failed")
        ? "Verification failed for one or more buckets"
        : "One or more buckets failed",
      completedAt: now,
      lastSyncedAt: now,
    }).catch(() => undefined)
  } else if (allCompleted) {
    try {
      await updateMigration(migrationId, {
        status: "completed",
        syncStatus: "ok",
        syncMessage: "",
        completedAt: now,
        lastSyncedAt: now,
        options: { ...migration.options, targetActivatedAt: undefined },
      })
      await activateAccountForCompletedMigration({
        targetAccountId: migration.targetAccountId,
        completedAt: now,
      })
      await updateMigration(migrationId, {
        syncStatus: "ok",
        syncMessage: "",
        completedAt: now,
        lastSyncedAt: now,
        options: { ...migration.options, targetActivatedAt: now },
      })
    } catch (error: unknown) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "Failed to activate migrated account")
          : "Failed to activate migrated account"
      await updateMigration(migrationId, {
        status: "completed",
        syncStatus: "error",
        syncMessage: message,
        completedAt: now,
        lastSyncedAt: now,
      }).catch(() => undefined)
    }
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

import { getMigration, listMigrationItems, mergeMigrationItemProgressState, updateMigration, type DriveMigration } from "./migrations-store"
import { activateAccountForCompletedMigration } from "./accounts-store"
import { listRepairJobsByMigration, type DriveRepairJob } from "./repair-jobs-store"
import { syncMigrationBucketSettings } from "./migration-settings-sync"
import { getMigrationReadOnlyState, isPermanentAccountCommunicationFailure } from "./migration-read-only"
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

const MAX_WORKER_REQUEUE_ATTEMPTS = 3
const MAX_WORKER_SHARD_COUNT = 128

function currentWorkerCoordinates(migration: DriveMigration) {
  const generation =
    typeof migration.options.workerGeneration === "number" && Number.isFinite(migration.options.workerGeneration)
      ? Math.max(1, Math.floor(migration.options.workerGeneration))
      : 1
  const shardCount =
    typeof migration.options.workerShardCount === "number" && Number.isFinite(migration.options.workerShardCount)
      ? Math.max(1, Math.min(MAX_WORKER_SHARD_COUNT, Math.floor(migration.options.workerShardCount)))
      : 32
  return { generation, shardCount }
}

function isCurrentWorkerShardJob(migration: DriveMigration, job: DriveRepairJob): boolean {
  if (migration.options.executionMode !== "migration_workers") return false
  if (!isRecord(job.payload) || job.payload.kind !== "migration_shard") return false
  if (typeof job.workKey !== "string") return false
  const match = job.workKey.match(/^migration:([^:]+):generation:(\d+):shard:(\d+)\/(\d+)$/)
  if (!match || match[1] !== migration.id) return false
  const { generation, shardCount } = currentWorkerCoordinates(migration)
  return Number(match[2]) === generation && Number(match[4]) === shardCount
}

function isRetryableCurrentWorkerShard(
  migration: DriveMigration,
  job: DriveRepairJob
): boolean {
  if (migration.options.executionMode !== "migration_workers" || job.status !== "failed") return false
  if (!isRecord(job.payload) || job.payload.kind !== "migration_shard") return false
  if (typeof job.workKey !== "string") return false
  const match = job.workKey.match(/^migration:([^:]+):generation:(\d+):shard:(\d+)\/(\d+)$/)
  if (!match || match[1] !== migration.id) return false
  const generation =
    typeof migration.options.workerGeneration === "number" && Number.isFinite(migration.options.workerGeneration)
      ? Math.max(1, Math.floor(migration.options.workerGeneration))
      : 1
  const { shardCount } = currentWorkerCoordinates(migration)
  if (Number(match[2]) !== generation || Number(match[4]) !== shardCount) return false
  const retryCount = Number(isRecord(job.result) ? job.result.retryCount ?? 0 : 0)
  return Number.isFinite(retryCount) && retryCount < MAX_WORKER_REQUEUE_ATTEMPTS
}

function readRepairItems(job: DriveRepairJob | null | undefined): Array<Record<string, unknown>> {
  if (!job || !isRecord(job.result) || !Array.isArray(job.result.items)) return []
  return job.result.items.filter(isRecord)
}

function readRepairPayloadItemIds(job: DriveRepairJob | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (!job || !isRecord(job.payload)) return ids
  if (Array.isArray(job.payload.itemIds)) {
    for (const raw of job.payload.itemIds) if (typeof raw === "string" && raw.trim()) ids.add(raw.trim())
  }
  if (Array.isArray(job.payload.items)) {
    for (const raw of job.payload.items) {
      if (!isRecord(raw)) continue
      const itemId = typeof raw.id === "string" ? raw.id : typeof raw.itemId === "string" ? raw.itemId : ""
      if (itemId) ids.add(itemId)
    }
  }
  return ids
}

function getLatestRepairJob(jobs: DriveRepairJob[]): DriveRepairJob | null {
  if (jobs.length === 0) return null
  const sorted = [...jobs].sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""))
  return sorted.find((job) => job.status === "running" || job.status === "claimed" || job.status === "pending") ?? sorted[0] ?? null
}

export async function syncMigrationLiveState(
  migrationId: string,
  options?: { runSettingsSync?: boolean }
): Promise<void> {
  const migration = await getMigration(migrationId)
  if (!migration) return
  if (getMigrationReadOnlyState(migration).readOnly) return
  // Migration Orchestrator is the sole writer for worker-pool counters,
  // statuses, verification, and completion. The legacy panel reconciler is
  // based on aggregate repair jobs and can only manufacture zero snapshots
  // for the per-file inventory queue, causing periodic UI/DB regressions.
  if (migration.options.executionMode === "migration_workers") return
  if (migration.status === "completed" && migration.options?.targetActivatedAt) return

  const completeWithSettingsWarning = async (warning: string) => {
    const completedAt = new Date().toISOString()
    let activationError = ""
    try {
      await activateAccountForCompletedMigration({
        targetAccountId: migration.targetAccountId,
        completedAt,
      })
    } catch (error: unknown) {
      activationError = error instanceof Error ? error.message : "Failed to activate migrated account"
    }
    await updateMigration(migrationId, {
      status: "completed",
      syncStatus: "error",
      syncMessage: activationError ? `${warning}; target activation failed: ${activationError}` : warning,
      completedAt,
      lastSyncedAt: completedAt,
      options: {
        ...migration.options,
        ...(activationError ? { targetActivatedAt: undefined } : { targetActivatedAt: completedAt }),
        ...(isPermanentAccountCommunicationFailure(`${warning} ${activationError}`)
          ? {
              historyReadOnlyAt: completedAt,
              historyReadOnlyReason: "Cloudflare account communication failed during settings sync",
            }
          : {}),
      },
    }).catch(() => undefined)
  }

  const [items, allRepairJobs] = await Promise.all([listMigrationItems(migrationId), listRepairJobsByMigration(migrationId, 500)])
  // A retry creates a new generation. Ignore older shard rows and unrelated
  // manual repair rows when rebuilding live state so stale telemetry cannot
  // move a current migration backwards or report duplicate work.
  const repairJobs = migration.options.executionMode === "migration_workers"
    ? allRepairJobs.filter((job) => isCurrentWorkerShardJob(migration, job))
    : allRepairJobs
  const latestRepairJob = getLatestRepairJob(repairJobs)
  const sortedRepairJobs = [...repairJobs].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "")
  )
  const latestRepairJobByItem = new Map<string, DriveRepairJob>()
  const latestRepairItemsById = new Map<string, Record<string, unknown>>()
  const latestRepairItemIds = new Set<string>()
  for (const job of sortedRepairJobs) {
    const ids = readRepairPayloadItemIds(job)
    for (const id of ids) {
      latestRepairItemIds.add(id)
      if (!latestRepairJobByItem.has(id)) latestRepairJobByItem.set(id, job)
    }
    for (const item of readRepairItems(job)) {
      const itemId = typeof item.itemId === "string" ? item.itemId : ""
      if (!itemId) continue
      // Jobs are sorted newest first. Keep the first result for an item so an
      // older shard cannot overwrite a newer terminal/progress snapshot.
      if (!latestRepairItemsById.has(itemId)) latestRepairItemsById.set(itemId, item)
      latestRepairItemIds.add(itemId)
      if (!latestRepairJobByItem.has(itemId)) latestRepairJobByItem.set(itemId, job)
    }
  }

  await Promise.all(
    items.map(async (item) => {
      const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
      const slurper = readSlurperResult(progress)
      const repairState = readRepairWorkerState(progress)
      const repairJobForItem = latestRepairJobByItem.get(item.id) ?? latestRepairJob
      const repairResultItem = latestRepairItemsById.get(item.id)
      const verify = readVerifyState(progress)
      const latestRepairJobStatus = normalizeStatus(repairJobForItem?.status)
      const isShardRepairJob =
        migration.options.executionMode === "migration_workers" && repairJobForItem?.payload?.kind === "migration_shard"
      // A completed shard is only one part of the migration. Keep an active
      // item active until the orchestrator has observed every shard and the
      // finalizer promotes the item state to completed.
      const effectiveLatestRepairJobStatus =
        isShardRepairJob && latestRepairJobStatus === "completed" && normalizeStatus(repairState?.status) !== "completed"
          ? "running"
          : latestRepairJobStatus
      const canceledRepairWithoutResult =
        latestRepairJobStatus === "canceled" &&
        !repairResultItem &&
        isActiveRepairWorkerStatus(repairState?.status)
      const effectiveRepairStatus = getEffectiveRepairStatus({
        repairWorkerStatus: canceledRepairWithoutResult ? "canceled" : repairState?.status,
        latestRepairJobStatus: effectiveLatestRepairJobStatus,
        repairAppliesToItem: latestRepairItemIds.has(item.id),
        latestRepairJobExists: Boolean(repairJobForItem),
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
        typeof repairState?.cumulativeTransferred === "number" ? repairState.cumulativeTransferred : 0,
        typeof repairState?.transferred === "number" ? repairState.transferred : 0,
        repairResultItem && typeof repairResultItem.transferred === "number" ? repairResultItem.transferred : 0
      )
      const workerSkipped = Math.max(
        typeof repairState?.cumulativeSkipped === "number" ? repairState.cumulativeSkipped : 0,
        typeof repairState?.skipped === "number" ? repairState.skipped : 0,
        repairResultItem && typeof repairResultItem.skipped === "number" ? repairResultItem.skipped : 0
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
        repairJobId: repairJobForItem?.id ?? null,
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
  const settingsSyncStates = refreshedItems.map((item) => {
    const progress = isRecord(item.progress) ? item.progress : {}
    return isRecord(progress.settingsSync) ? progress.settingsSync : null
  })
  const settingsSyncFailures = settingsSyncStates.filter((state) => state?.status === "failed")
  const settingsSyncRunning = settingsSyncStates.some((state) => state?.status === "syncing")
  const settingsSyncCompleted =
    settingsSyncStates.length > 0 && settingsSyncStates.every((state) => state?.status === "completed")
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
  // A shard failure is retried by the orchestrator (up to the durable retry
  // limit). Keep the migration resumable while that retry is pending; marking
  // it terminal here would remove it from the orchestrator's active set before
  // the failed shard can be returned to the queue.
  const retryableWorkerShard = repairJobs.some((job) => isRetryableCurrentWorkerShard(migration, job))
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
  } else if (anyFailed && retryableWorkerShard) {
    await updateMigration(migrationId, {
      status: "running",
      syncStatus: "ok",
      syncMessage: "A migration worker shard failed; retrying automatically",
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
    if (
      migration.options.executionMode === "migration_workers" &&
      migration.options.requireIndependentVerification !== false
    ) {
      await updateMigration(migrationId, {
        status: "verifying",
        syncStatus: "ok",
        syncMessage: "Object migration completed; File Scanner verification pending",
        completedAt: null,
        lastSyncedAt: now,
      }).catch(() => undefined)
      return
    }
    if (options?.runSettingsSync !== true) {
      if (settingsSyncRunning || settingsSyncFailures.length > 0 || settingsSyncCompleted) return
      await updateMigration(migrationId, {
        status: "verifying",
        syncStatus: "ok",
        syncMessage: "Object migration completed; settings sync pending",
        completedAt: null,
        lastSyncedAt: now,
      }).catch(() => undefined)
      return
    }

    if (settingsSyncFailures.length > 0) {
      const firstError = settingsSyncFailures.find((state) => typeof state?.error === "string")?.error
      await completeWithSettingsWarning(
        typeof firstError === "string" && firstError
          ? `Settings sync failed: ${firstError}`
          : "Settings sync failed for one or more buckets"
      )
      return
    }

    if (settingsSyncRunning) return

    await updateMigration(migrationId, {
      status: "verifying",
      syncStatus: "syncing",
      syncMessage: "Syncing settings",
      completedAt: null,
      lastSyncedAt: now,
      options: { ...migration.options, targetActivatedAt: undefined },
    })
    try {
      if (!settingsSyncCompleted) await syncMigrationBucketSettings(migrationId)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Settings sync failed"
      await completeWithSettingsWarning(message)
      return
    }

    try {
      const completedAt = new Date().toISOString()
      await activateAccountForCompletedMigration({
        targetAccountId: migration.targetAccountId,
        completedAt,
      })
      await updateMigration(migrationId, {
        status: "completed",
        syncStatus: "ok",
        syncMessage: "",
        completedAt,
        lastSyncedAt: completedAt,
        options: { ...migration.options, targetActivatedAt: completedAt },
      })
    } catch (error: unknown) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message?: unknown }).message ?? "Failed to activate migrated account")
          : "Failed to activate migrated account"
      const failedAt = new Date().toISOString()
      await updateMigration(migrationId, {
        status: "completed",
        syncStatus: "error",
        syncMessage: `Settings synced, but target activation failed: ${message}`,
        completedAt: failedAt,
        lastSyncedAt: failedAt,
        options: {
          ...migration.options,
          targetActivatedAt: undefined,
          ...(isPermanentAccountCommunicationFailure(message)
            ? {
                historyReadOnlyAt: failedAt,
                historyReadOnlyReason: "Target account activation is unavailable",
              }
            : {}),
        },
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

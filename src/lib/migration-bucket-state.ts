export type BucketLikeItem = {
  id: string
  sourceBucket: string
  targetBucket: string
  slurperJobId?: string
  slurperStatus?: string
  progress: Record<string, unknown>
  sourceObjects?: number
  sourceBytes?: number
}

export type RepairJobStatusLike = "pending" | "claimed" | "running" | "completed" | "failed" | "canceled" | string | undefined

export type RepairResultItemMetrics = {
  transferred: number
  failed: number
  skipped: number
  finalMissing: number
  finalMismatched: number
  resolvedAllObjects: boolean
}

export type BucketSnapshot = {
  displayStatus: string | undefined
  total: number
  transferred: number
  skipped: number
  failed: number
  unaccounted: number
  verifyIssues: number
}

function isActiveBucketDisplayStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "scanning" || s === "queued" || s === "running" || s === "verifying" || s === "creating_job" || s === "job_id_pending"
}

export function isTerminalBucketDisplayStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return isCompletedStatus(s) || isFailedLikeStatus(s) || isAbortedStatus(s) || s === "no_files" || s === "verification_failed"
}

export function getBucketDisplayStatusRank(value: unknown): number {
  const s = normalizeStatus(value)
  if (!s) return 0
  if (s === "scanning") return 1
  if (s === "queued" || s === "creating_job" || s === "job_id_pending") return 2
  if (s === "running") return 3
  if (s === "verifying") return 4
  if (s === "no_files") return 5
  if (s === "completed") return 6
  if (s === "verification_failed" || isFailedLikeStatus(s)) return 7
  if (isAbortedStatus(s)) return 8
  return isActiveBucketDisplayStatus(s) ? 3 : 0
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function normalizeStatus(value: unknown): string {
  return String(value ?? "").trim().toLowerCase()
}

export function isCompletedStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "completed" || s === "copy_completed" || s === "complete" || s === "finished" || s === "success" || s === "succeeded"
}

export function isAbortedStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "aborted" || s === "canceled" || s === "copy_aborted"
}

export function isFailedLikeStatus(value: unknown): boolean {
  const s = normalizeStatus(value)
  return s === "precheck_failed" || s === "bucket_create_failed" || s === "job_create_failed" || s.endsWith("_failed") || s.includes("failed") || s.includes("error")
}

export function isTerminalRepairJobStatus(value: string | undefined): boolean {
  const status = normalizeStatus(value)
  return status === "completed" || status === "failed" || status === "canceled"
}

export function isActiveRepairWorkerStatus(value: string | undefined): boolean {
  const status = normalizeStatus(value)
  return status === "running" || status === "claimed" || status === "pending"
}

export function readRepairWorkerState(progress: Record<string, unknown>) {
  if (!isRecord(progress.repairWorker)) return null
  const repair = progress.repairWorker as Record<string, unknown>
  return {
    stage: typeof repair.stage === "string" ? repair.stage : undefined,
    status: typeof repair.status === "string" ? repair.status : undefined,
    summary: typeof repair.summary === "string" ? repair.summary : undefined,
    transferred: typeof repair.transferred === "number" ? repair.transferred : 0,
    failed: typeof repair.failed === "number" ? repair.failed : 0,
    skipped: typeof repair.skipped === "number" ? repair.skipped : 0,
    updatedAt: typeof repair.updatedAt === "string" ? repair.updatedAt : undefined,
    details: isRecord(repair.details) ? repair.details : null,
  }
}

export function readSlurperResult(progress: Record<string, unknown>) {
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

export function readVerifyState(progress: Record<string, unknown>) {
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

export function readLiveBucketState(progress: Record<string, unknown>) {
  const live = isRecord(progress.live) ? (progress.live as Record<string, unknown>) : null
  if (!live) return null
  return {
    status: typeof live.status === "string" ? live.status : undefined,
    transferredObjects: typeof live.transferredObjects === "number" ? live.transferredObjects : 0,
    skippedObjects: typeof live.skippedObjects === "number" ? live.skippedObjects : 0,
    failedObjects: typeof live.failedObjects === "number" ? live.failedObjects : 0,
    unaccountedObjects: typeof live.unaccountedObjects === "number" ? live.unaccountedObjects : 0,
    verifyIssues: typeof live.verifyIssues === "number" ? live.verifyIssues : 0,
    totalObjects: typeof live.totalObjects === "number" ? live.totalObjects : 0,
    sourceScanStatus: typeof live.sourceScanStatus === "string" ? live.sourceScanStatus : null,
    workerStage: typeof live.workerStage === "string" ? live.workerStage : null,
    workerStatus: typeof live.workerStatus === "string" ? live.workerStatus : null,
    slurperJobId: typeof live.slurperJobId === "string" ? live.slurperJobId : null,
    repairJobId: typeof live.repairJobId === "string" ? live.repairJobId : null,
  }
}

export function readRepairResultItemMetrics(itemResult?: Record<string, unknown>): RepairResultItemMetrics {
  return {
    transferred: typeof itemResult?.transferred === "number" ? itemResult.transferred : 0,
    failed: typeof itemResult?.failed === "number" ? itemResult.failed : 0,
    skipped: typeof itemResult?.skipped === "number" ? itemResult.skipped : 0,
    finalMissing: typeof itemResult?.finalMissing === "number" ? itemResult.finalMissing : 0,
    finalMismatched: typeof itemResult?.finalMismatched === "number" ? itemResult.finalMismatched : 0,
    resolvedAllObjects: itemResult?.resolvedAllObjects === true,
  }
}

export function getEffectiveRepairStatus(input: {
  repairWorkerStatus?: string
  latestRepairJobStatus?: RepairJobStatusLike
  repairAppliesToItem?: boolean
  latestRepairJobExists?: boolean
  latestRepairItemCount?: number
}): string | undefined {
  const workerStatus = normalizeStatus(input.repairWorkerStatus)
  const latestJobStatus = normalizeStatus(input.latestRepairJobStatus)
  const jobTargetsThisItem = Boolean(input.repairAppliesToItem || !input.latestRepairJobExists || !input.latestRepairItemCount)

  if (isTerminalRepairJobStatus(latestJobStatus) && isActiveRepairWorkerStatus(workerStatus) && jobTargetsThisItem) {
    return latestJobStatus === "canceled" ? "failed" : latestJobStatus
  }

  if (isActiveRepairWorkerStatus(workerStatus)) {
    return input.latestRepairJobExists && jobTargetsThisItem ? workerStatus : undefined
  }

  return input.repairWorkerStatus
}

export function getItemStatus(item: BucketLikeItem): string | undefined {
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
  if (!item.slurperJobId && stage === "scan_failed") return "scan_failed"
  if (typeof item.slurperStatus === "string" && item.slurperStatus.length > 0) return item.slurperStatus
  if (typeof progress.slurperStatus === "string" && progress.slurperStatus.length > 0) return String(progress.slurperStatus)
  return readSlurperResult(progress)?.status
}

export function getItemDisplayStatus(
  item: BucketLikeItem,
  repairResultItem?: Record<string, unknown>,
  repairStatusOverride?: string
): string | undefined {
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const repairState = readRepairWorkerState(progress)
  const repairStatus = normalizeStatus(repairStatusOverride || repairState?.status)
  const repairStage = normalizeStatus(repairState?.stage)
  const repairDetails = repairState?.details
  const verify = readVerifyState(progress)
  const base = getItemStatus(item)
  const finalMissing =
    (repairResultItem && typeof repairResultItem.finalMissing === "number" ? repairResultItem.finalMissing : 0) +
    (repairDetails && typeof repairDetails.finalMissing === "number" ? Number(repairDetails.finalMissing) : 0)
  const finalMismatched =
    (repairResultItem && typeof repairResultItem.finalMismatched === "number" ? repairResultItem.finalMismatched : 0) +
    (repairDetails && typeof repairDetails.finalMismatched === "number" ? Number(repairDetails.finalMismatched) : 0)
  const resolvedAllObjects = repairResultItem?.resolvedAllObjects === true || (repairStatus === "completed" && finalMissing === 0 && finalMismatched === 0)

  if (repairStatus === "completed") return resolvedAllObjects ? "completed" : finalMissing > 0 || finalMismatched > 0 ? "failed" : "completed"
  if (repairStatus === "failed" || repairStatus === "error") return "failed"
  if (repairStatus === "canceled" || repairStatus === "aborted") return "aborted"
  if (repairStatus === "running") {
    if (repairStage.includes("scan")) return "scanning"
    if (repairStage.includes("verify")) return "verifying"
    return "running"
  }
  if (repairStatus === "claimed" || repairStatus === "pending") return "running"
  if (verify?.status === "ok" && verify.note === "no_source_objects") return "no_files"
  if ((verify?.status === "pending" || verify?.status === "running") && (repairStage.includes("verify") || isCompletedStatus(base))) {
    return "verifying"
  }
  if (base === "scanning") return "scanning"
  if (base === "scan_failed") return "failed"
  if (!isCompletedStatus(base)) return base
  if (verify?.status === "error") return "verification_failed"
  return base
}

export function readLiveRepairVerificationIssues(input: {
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

export function getMergedBucketSnapshot(
  item: BucketLikeItem,
  repairResultItem?: Record<string, unknown>,
  options?: {
    latestRepairJobStatus?: string
    repairAppliesToItem?: boolean
    latestRepairJobExists?: boolean
    latestRepairItemCount?: number
  }
): BucketSnapshot {
  const progress = isRecord(item.progress) ? (item.progress as Record<string, unknown>) : {}
  const live = readLiveBucketState(progress)
  if (live) {
    return {
      displayStatus: live.status ?? getItemDisplayStatus(item, repairResultItem, live.workerStatus ?? undefined),
      total: live.totalObjects,
      transferred: live.transferredObjects,
      skipped: live.skippedObjects,
      failed: live.failedObjects,
      unaccounted: live.unaccountedObjects,
      verifyIssues: live.verifyIssues,
    }
  }

  const slurper = readSlurperResult(progress)
  const repairState = readRepairWorkerState(progress)
  const repairResult = readRepairResultItemMetrics(repairResultItem)
  const verify = readVerifyState(progress)
  const effectiveRepairStatus = getEffectiveRepairStatus({
    repairWorkerStatus: repairState?.status,
    latestRepairJobStatus: options?.latestRepairJobStatus,
    repairAppliesToItem: options?.repairAppliesToItem,
    latestRepairJobExists: options?.latestRepairJobExists,
    latestRepairItemCount: options?.latestRepairItemCount,
  })
  const displayStatus = getItemDisplayStatus(item, repairResultItem, effectiveRepairStatus)

  const sourceScanStatus = typeof progress.sourceScanStatus === "string" ? progress.sourceScanStatus : ""
  const scanComplete = sourceScanStatus === "completed"
  const total =
    scanComplete && typeof item.sourceObjects === "number"
      ? item.sourceObjects
      : typeof slurper?.objects === "number"
        ? slurper.objects
        : 0

  const slurperTransferred = typeof slurper?.transferredObjects === "number" ? slurper.transferredObjects : 0
  const slurperSkipped = typeof slurper?.skippedObjects === "number" ? slurper.skippedObjects : 0
  const slurperFailed = typeof slurper?.failedObjects === "number" ? slurper.failedObjects : 0
  const workerTransferred = Math.max(typeof repairState?.transferred === "number" ? repairState.transferred : 0, repairResult.transferred)
  const workerSkipped = Math.max(typeof repairState?.skipped === "number" ? repairState.skipped : 0, repairResult.skipped)
  const workerFailed = Math.max(typeof repairState?.failed === "number" ? repairState.failed : 0, repairResult.failed)
  const finalMissing =
    repairResult.finalMissing ||
    (repairState?.details && typeof repairState.details.finalMissing === "number" ? Number(repairState.details.finalMissing) : 0)
  const finalMismatched =
    repairResult.finalMismatched ||
    (repairState?.details && typeof repairState.details.finalMismatched === "number" ? Number(repairState.details.finalMismatched) : 0)
  const resolvedAllObjects = repairResult.resolvedAllObjects || (normalizeStatus(effectiveRepairStatus) === "completed" && finalMissing === 0 && finalMismatched === 0)

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

  return {
    displayStatus,
    total,
    transferred: resolvedAllObjects
      ? Math.max(total > 0 ? total - Math.max(slurperSkipped, workerSkipped) : 0, slurperTransferred + workerTransferred)
      : total > 0
        ? Math.min(total, slurperTransferred + workerTransferred)
        : slurperTransferred + workerTransferred,
    skipped: Math.max(slurperSkipped, workerSkipped),
    failed: resolvedAllObjects ? 0 : Math.max(0, slurperFailed - resolvedFailed + workerFailed + finalMissing + finalMismatched),
    unaccounted: resolvedAllObjects ? 0 : Math.max(0, baseUnaccounted - resolvedUnaccounted - verifyIssues),
    verifyIssues,
  }
}

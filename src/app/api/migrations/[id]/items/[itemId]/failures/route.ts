import { NextResponse } from "next/server"

import { listMigrationItemFailureRecords } from "@/lib/migration-failure-records-store"
import { getMigration, listMigrationItems } from "@/lib/migrations-store"
import { requireAdmin } from "@/lib/server-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function countCategory(records: Array<{ diagnosis?: unknown }>, category: string): number {
  return records.filter((record) => isRecord(record.diagnosis) && record.diagnosis.category === category).length
}

/** Return persisted failure evidence only. File Scanner owns inventory and verification. */
export async function GET(request: Request, context: { params: Promise<{ id: string; itemId: string }> }) {
  const auth = await requireAdmin()
  if (!auth.ok) return auth.response

  try {
    const { id, itemId } = await context.params
    const url = new URL(request.url)
    const rawLimit = Number(url.searchParams.get("limit") ?? "150")
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 150
    const migration = await getMigration(id)
    if (!migration) return NextResponse.json({ error: "Migration not found" }, { status: 404 })

    const items = await listMigrationItems(id)
    const item = items.find((entry) => entry.id === itemId)
    if (!item) return NextResponse.json({ error: "Migration bucket not found" }, { status: 404 })

    const [records, latestMigration] = await Promise.all([
      listMigrationItemFailureRecords(itemId, limit),
      getMigration(id),
    ])
    const progress = isRecord(item.progress) ? item.progress : {}
    const snapshot = isRecord(progress.failedDiagnosticsSnapshot) ? progress.failedDiagnosticsSnapshot : {}
    const savedSummary = isRecord(snapshot.summary) ? snapshot.summary : {}
    const reportedFailedObjects = Math.max(0, Number(
      isRecord(progress.live) && typeof progress.live.failedObjects === "number"
        ? progress.live.failedObjects
        : progress.failedObjects ?? 0
    ) || 0)
    const storedTotal = typeof savedSummary.totalFailedEntries === "number"
      ? savedSummary.totalFailedEntries
      : reportedFailedObjects
    const failures = records.map((record) => ({
      key: record.objectKey,
      message: record.message,
      at: record.occurredAtText ?? null,
      rawLog: record.rawLog ?? null,
      source: isRecord(record.sourceProbe) ? record.sourceProbe : {},
      destination: isRecord(record.destinationProbe) ? record.destinationProbe : {},
      diagnosis: isRecord(record.diagnosis) ? record.diagnosis : {},
      download: isRecord(record.download) ? record.download : {},
    }))
    const summary = {
      totalFailedEntries: storedTotal,
      detailedFailedEntries: typeof savedSummary.detailedFailedEntries === "number" ? savedSummary.detailedFailedEntries : records.length,
      cloudflareDetailedEntries: typeof savedSummary.cloudflareDetailedEntries === "number" ? savedSummary.cloudflareDetailedEntries : 0,
      fallbackDetailedEntries: typeof savedSummary.fallbackDetailedEntries === "number" ? savedSummary.fallbackDetailedEntries : 0,
      inferredDetailedEntries: typeof savedSummary.inferredDetailedEntries === "number" ? savedSummary.inferredDetailedEntries : 0,
      missingDetailedEntries: typeof savedSummary.missingDetailedEntries === "number" ? savedSummary.missingDetailedEntries : Math.max(0, storedTotal - records.length),
      sourceMissing: typeof savedSummary.sourceMissing === "number" ? savedSummary.sourceMissing : countCategory(records, "source_missing"),
      sourceAccessIssues: typeof savedSummary.sourceAccessIssues === "number" ? savedSummary.sourceAccessIssues : countCategory(records, "source_access_issue"),
      destinationExists: typeof savedSummary.destinationExists === "number" ? savedSummary.destinationExists : countCategory(records, "destination_exists"),
      transientOrProviderIssues: typeof savedSummary.transientOrProviderIssues === "number" ? savedSummary.transientOrProviderIssues : countCategory(records, "transient_or_provider_issue"),
      unknown: typeof savedSummary.unknown === "number" ? savedSummary.unknown : countCategory(records, "unknown"),
    }
    return NextResponse.json({
      ok: true,
      migration: latestMigration ?? migration,
      item: { id: item.id, sourceBucket: item.sourceBucket, targetBucket: item.targetBucket, jobId: item.slurperJobId ?? null, status: item.slurperStatus ?? null },
      summary,
      failures,
      evidenceUpdatedAt: typeof snapshot.fetchedAt === "string" ? snapshot.fetchedAt : records[0]?.fetchedAt ?? null,
    }, { headers: { "Cache-Control": "no-store, max-age=0" } })
  } catch (error) {
    console.error("Unable to load persisted migration failure details", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load failure details" }, { status: 500 })
  }
}

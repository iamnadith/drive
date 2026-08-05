import { getAllAccounts } from "./accounts-store"
import { getMigration, listMigrationItems, mergeMigrationItemProgressState } from "./migrations-store"
import { syncBucketSettings } from "./r2-bucket-settings"

type SettingsSyncState = {
  status: "syncing" | "completed" | "failed"
  startedAt: string
  completedAt?: string
  attemptCount?: number
  maxAttempts?: number
  sourcePublicEnabled?: boolean
  destinationPublicEnabled?: boolean
  sourceCorsRuleCount?: number
  destinationCorsRuleCount?: number
  publicUrl?: string | null
  error?: string
}

function readSettingsSync(value: unknown): SettingsSyncState | null {
  if (typeof value !== "object" || value === null) return null
  const status = (value as { status?: unknown }).status
  if (status !== "syncing" && status !== "completed" && status !== "failed") return null
  return value as SettingsSyncState
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Bucket settings synchronization failed"
}

const SETTINGS_SYNC_MAX_ATTEMPTS = 3

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function syncMigrationBucketSettings(
  migrationId: string,
  options?: { force?: boolean }
): Promise<void> {
  const [migration, accounts, items] = await Promise.all([
    getMigration(migrationId),
    getAllAccounts(),
    listMigrationItems(migrationId),
  ])
  if (!migration) throw new Error("Migration not found")
  const source = accounts.find((account) => account.id === migration.sourceAccountId)
  const target = accounts.find((account) => account.id === migration.targetAccountId)
  if (!source) throw new Error("Migration source account not found")
  if (!target) throw new Error("Migration target account not found")

  const failures: string[] = []
  for (const item of items) {
    const previous = readSettingsSync(item.progress.settingsSync)
    if (previous?.status === "completed" && options?.force !== true) continue

    const startedAt = new Date().toISOString()
    let finalError = ""
    for (let attempt = 1; attempt <= SETTINGS_SYNC_MAX_ATTEMPTS; attempt += 1) {
      await mergeMigrationItemProgressState(item.id, {
        settingsSync: {
          status: "syncing",
          startedAt,
          attemptCount: attempt,
          maxAttempts: SETTINGS_SYNC_MAX_ATTEMPTS,
          ...(finalError ? { error: finalError } : {}),
        } satisfies SettingsSyncState,
      })

      try {
        const settings = await syncBucketSettings({
          source,
          target,
          sourceBucket: item.sourceBucket,
          targetBucket: item.targetBucket,
        })
        await mergeMigrationItemProgressState(item.id, {
          settingsSync: {
            status: "completed",
            startedAt,
            completedAt: new Date().toISOString(),
            attemptCount: attempt,
            maxAttempts: SETTINGS_SYNC_MAX_ATTEMPTS,
            sourcePublicEnabled: settings.source.publicAccess.enabled,
            destinationPublicEnabled: settings.destination.publicAccess.enabled,
            sourceCorsRuleCount: settings.source.corsRules.length,
            destinationCorsRuleCount: settings.destination.corsRules.length,
            publicUrl: settings.destination.publicAccess.enabled && settings.destination.publicAccess.domain
              ? `https://${settings.destination.publicAccess.domain}`
              : null,
          } satisfies SettingsSyncState,
        })
        finalError = ""
        break
      } catch (error: unknown) {
        finalError = errorMessage(error)
        if (attempt < SETTINGS_SYNC_MAX_ATTEMPTS) await sleep(500 * attempt)
      }
    }

    if (finalError) {
      failures.push(`${item.sourceBucket}: ${finalError}`)
      await mergeMigrationItemProgressState(item.id, {
        settingsSync: {
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          attemptCount: SETTINGS_SYNC_MAX_ATTEMPTS,
          maxAttempts: SETTINGS_SYNC_MAX_ATTEMPTS,
          error: finalError,
        } satisfies SettingsSyncState,
      }).catch(() => undefined)
    }
  }

  if (failures.length > 0) throw new Error(`Settings sync failed for ${failures.join("; ")}`)
}

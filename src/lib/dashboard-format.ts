export function formatLastSyncedAt(value?: string | null) {
  if (!value) return "Last Synced At Never"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "Last Synced At Never"
  return `Last Synced At ${date.toLocaleString()}`
}

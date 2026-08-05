type SyncResponse = { complete?: boolean }

export async function syncObjectHistory(options: { force?: boolean; signal?: AbortSignal } = {}) {
  const attempts = options.force ? 20 : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch("/api/storage/buckets/stats/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxKeysTotal: options.force ? 50_000 : 5_000,
        restart: options.force && attempt === 0,
        restartAfterMs: 5 * 60_000,
      }),
      signal: options.signal,
    })
    if (!response.ok) return
    const result = (await response.json().catch(() => ({}))) as SyncResponse
    if (result.complete !== false) return
  }
}

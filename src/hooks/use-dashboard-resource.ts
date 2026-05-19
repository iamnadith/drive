import * as React from "react"

type LoadOptions = {
  background?: boolean
  force?: boolean
}

type UseDashboardResourceOptions<T> = {
  enabled?: boolean
  fetcher: (input: { signal: AbortSignal; force: boolean }) => Promise<T>
  key: string
  refreshIntervalMs?: number
  staleTimeMs?: number
  cooldownMs?: number
}

type UseDashboardResourceResult<T> = {
  data: T | null
  error: string | null
  loading: boolean
  refreshing: boolean
  refresh: (options?: LoadOptions) => Promise<T | null>
}

type CacheEntry<T> = {
  data: T | null
  error: string | null
  promise: Promise<T | null> | null
  updatedAt: number
  lastStartedAt: number
}

const DEFAULT_STALE_TIME_MS = 12_000
const DEFAULT_COOLDOWN_MS = 1_500

const resourceCache = new Map<string, CacheEntry<unknown>>()

function getCacheEntry<T>(key: string): CacheEntry<T> {
  const cached = resourceCache.get(key)
  if (cached) return cached as CacheEntry<T>

  const entry: CacheEntry<T> = {
    data: null,
    error: null,
    promise: null,
    updatedAt: 0,
    lastStartedAt: 0,
  }
  resourceCache.set(key, entry as CacheEntry<unknown>)
  return entry
}

function getErrorMessage(caught: unknown) {
  return typeof caught === "object" && caught !== null && "message" in caught
    ? String((caught as { message?: unknown }).message ?? "Unable to load data")
    : "Unable to load data"
}

export function useDashboardResource<T>({
  enabled = true,
  fetcher,
  key,
  refreshIntervalMs,
  staleTimeMs = DEFAULT_STALE_TIME_MS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
}: UseDashboardResourceOptions<T>): UseDashboardResourceResult<T> {
  const fetcherEvent = React.useEffectEvent(fetcher)
  const [data, setData] = React.useState<T | null>(() => getCacheEntry<T>(key).data)
  const [error, setError] = React.useState<string | null>(() => getCacheEntry<T>(key).error)
  const [loading, setLoading] = React.useState(() => {
    const cached = getCacheEntry<T>(key)
    return cached.data === null && cached.error === null
  })
  const [refreshing, setRefreshing] = React.useState(false)

  const requestIdRef = React.useRef(0)
  const hasLoadedRef = React.useRef(Boolean(getCacheEntry<T>(key).data || getCacheEntry<T>(key).error))
  const dataRef = React.useRef<T | null>(getCacheEntry<T>(key).data)
  const keyRef = React.useRef(key)

  React.useEffect(() => {
    dataRef.current = data
  }, [data])

  React.useEffect(() => {
    keyRef.current = key
    const cached = getCacheEntry<T>(key)
    const hasCachedState = cached.data !== null || cached.error !== null

    setData(cached.data)
    setError(cached.error)
    setLoading(!hasCachedState)
    setRefreshing(false)
    hasLoadedRef.current = hasCachedState
    dataRef.current = cached.data
  }, [key])

  const refresh = React.useCallback(
    async (options?: LoadOptions) => {
      if (!enabled) return null

      const cacheEntry = getCacheEntry<T>(key)
      const now = Date.now()
      const force = options?.force === true
      const hasCachedData = cacheEntry.data !== null
      const hasCachedState = hasCachedData || cacheEntry.error !== null
      const cacheAge = now - cacheEntry.updatedAt
      const isFresh = hasCachedData && cacheAge <= staleTimeMs
      const isBackground =
        options?.background ??
        (hasLoadedRef.current || dataRef.current !== null || hasCachedState)
      const requestId = ++requestIdRef.current

      if (!force && isFresh) {
        if (cacheEntry.data !== dataRef.current) {
          React.startTransition(() => {
            setData(cacheEntry.data)
          })
        }
        setError(cacheEntry.error)
        setLoading(false)
        setRefreshing(false)
        hasLoadedRef.current = true
        return cacheEntry.data
      }

      if (cacheEntry.promise) {
        if (isBackground) setRefreshing(true)
        else if (!hasCachedState) setLoading(true)

        try {
          const sharedData = await cacheEntry.promise
          if (requestId !== requestIdRef.current || key !== keyRef.current) return null

          setData(cacheEntry.data)
          setError(cacheEntry.error)
          setLoading(false)
          setRefreshing(false)
          hasLoadedRef.current = cacheEntry.data !== null || cacheEntry.error !== null
          return sharedData
        } catch (caught) {
          if (requestId !== requestIdRef.current || key !== keyRef.current) return null

          setError(getErrorMessage(caught))
          setLoading(false)
          setRefreshing(false)
          return null
        }
      }

      if (
        !force &&
        hasCachedData &&
        cacheEntry.lastStartedAt > 0 &&
        now - cacheEntry.lastStartedAt < cooldownMs
      ) {
        setLoading(false)
        setRefreshing(false)
        return cacheEntry.data
      }

      if (isBackground) setRefreshing(true)
      else setLoading(true)

      cacheEntry.lastStartedAt = now
      const controller = new AbortController()

      cacheEntry.promise = (async () => {
        try {
          const nextData = await fetcherEvent({ signal: controller.signal, force })
          cacheEntry.data = nextData
          cacheEntry.error = null
          cacheEntry.updatedAt = Date.now()
          return nextData
        } catch (caught) {
          if (caught instanceof DOMException && caught.name === "AbortError") return cacheEntry.data

          cacheEntry.error = getErrorMessage(caught)
          if (!hasCachedData) {
            cacheEntry.data = null
            cacheEntry.updatedAt = Date.now()
          }
          throw caught
        } finally {
          cacheEntry.promise = null
        }
      })()

      try {
        const nextData = await cacheEntry.promise
        if (requestId !== requestIdRef.current || key !== keyRef.current) return null

        React.startTransition(() => {
          setData(nextData)
        })
        setError(null)
        hasLoadedRef.current = true
        return nextData
      } catch (caught) {
        if (requestId !== requestIdRef.current || key !== keyRef.current) return null

        setError(getErrorMessage(caught))
        return null
      } finally {
        if (requestId === requestIdRef.current && key === keyRef.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    },
    [cooldownMs, enabled, fetcherEvent, key, staleTimeMs]
  )

  React.useEffect(() => {
    if (!enabled) {
      setLoading(false)
      setRefreshing(false)
      return
    }

    const cached = getCacheEntry<T>(key)
    const shouldBackgroundRefresh =
      cached.data !== null && (cached.updatedAt === 0 || Date.now() - cached.updatedAt > staleTimeMs)

    void refresh({ background: shouldBackgroundRefresh || hasLoadedRef.current || dataRef.current !== null })
  }, [enabled, key, refresh, staleTimeMs])

  React.useEffect(() => {
    if (!enabled || !refreshIntervalMs || refreshIntervalMs <= 0) return

    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return
      void refresh({ background: true })
    }

    const intervalId = window.setInterval(refreshIfVisible, refreshIntervalMs)
    window.addEventListener("focus", refreshIfVisible)
    document.addEventListener("visibilitychange", refreshIfVisible)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener("focus", refreshIfVisible)
      document.removeEventListener("visibilitychange", refreshIfVisible)
    }
  }, [enabled, refresh, refreshIntervalMs])

  return { data, error, loading, refreshing, refresh }
}

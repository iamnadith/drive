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
}

type UseDashboardResourceResult<T> = {
  data: T | null
  error: string | null
  loading: boolean
  refreshing: boolean
  refresh: (options?: LoadOptions) => Promise<T | null>
}

export function useDashboardResource<T>({
  enabled = true,
  fetcher,
  key,
  refreshIntervalMs,
}: UseDashboardResourceOptions<T>): UseDashboardResourceResult<T> {
  const fetcherEvent = React.useEffectEvent(fetcher)
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)

  const abortRef = React.useRef<AbortController | null>(null)
  const requestIdRef = React.useRef(0)
  const hasLoadedRef = React.useRef(false)
  const dataRef = React.useRef<T | null>(null)

  React.useEffect(() => {
    dataRef.current = data
  }, [data])

  const refresh = React.useCallback(
    async (options?: LoadOptions) => {
      if (!enabled) return null

      const force = options?.force === true
      const isBackground = options?.background ?? (hasLoadedRef.current || dataRef.current !== null)

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const requestId = ++requestIdRef.current

      if (isBackground) setRefreshing(true)
      else setLoading(true)

      try {
        const nextData = await fetcherEvent({ signal: controller.signal, force })
        if (controller.signal.aborted || requestId !== requestIdRef.current) return null

        React.startTransition(() => {
          setData(nextData)
        })
        setError(null)
        hasLoadedRef.current = true
        return nextData
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return null

        const message =
          typeof caught === "object" && caught !== null && "message" in caught
            ? String((caught as { message?: unknown }).message ?? "Unable to load data")
            : "Unable to load data"
        setError(message)
        return null
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
          setRefreshing(false)
          if (abortRef.current === controller) abortRef.current = null
        }
      }
    },
    [enabled]
  )

  React.useEffect(() => {
    if (!enabled) {
      abortRef.current?.abort()
      setLoading(false)
      setRefreshing(false)
      return
    }

    void refresh({ background: hasLoadedRef.current || dataRef.current !== null })

    return () => {
      abortRef.current?.abort()
    }
  }, [enabled, key, refresh])

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

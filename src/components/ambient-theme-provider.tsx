"use client"

import * as React from "react"

export type AmbientPaletteMode = "light" | "dark"

export type AmbientThemeConfig = {
  id: string
  label: string
  orbitCount: number
  colors: Record<AmbientPaletteMode, string[]>
}

type AmbientThemeContextValue = {
  activeThemeId: string
  themes: AmbientThemeConfig[]
  addTheme: (label: string) => string
  resetThemes: () => void
  setActiveThemeId: (themeId: string) => void
  updateThemeColor: (
    themeId: string,
    mode: AmbientPaletteMode,
    orbitIndex: number,
    color: string
  ) => void
  updateThemeOrbitCount: (themeId: string, orbitCount: number) => void
}

type AmbientThemePayload = {
  activeThemeId: string
  themes: AmbientThemeConfig[]
}

const MAX_ORBIT_COUNT = 8
const DEFAULT_THEME_ID = "aurora"

const DEFAULT_THEME_PRESETS: AmbientThemeConfig[] = [
  {
    id: "aurora",
    label: "Aurora",
    orbitCount: 4,
    colors: {
      light: ["#f28f6b", "#67c7d4", "#ffd166", "#f4f7fb"],
      dark: ["#7c5cff", "#4de2c5", "#ff8c69", "#ff5fb3"],
    },
  },
  {
    id: "tide",
    label: "Tide",
    orbitCount: 5,
    colors: {
      light: ["#80bfff", "#4de2c5", "#7fd5f5", "#d7efff", "#9be7d8"],
      dark: ["#3b82f6", "#0ea5e9", "#14b8a6", "#8b5cf6", "#38bdf8"],
    },
  },
  {
    id: "ember",
    label: "Ember",
    orbitCount: 3,
    colors: {
      light: ["#ff9b71", "#f7c66f", "#ffe9c9"],
      dark: ["#ff6b4a", "#ff9f1c", "#ffd166"],
    },
  },
]

const AmbientThemeContext = React.createContext<AmbientThemeContextValue | null>(null)

function clampOrbitCount(value: number): number {
  return Math.max(1, Math.min(MAX_ORBIT_COUNT, Math.floor(value)))
}

function normalizeColor(value: string, fallback: string): string {
  const trimmed = value.trim()
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed : fallback
}

function buildColorList(colors: string[], orbitCount: number, fallbacks: string[]): string[] {
  const nextCount = clampOrbitCount(orbitCount)
  const source = colors.length > 0 ? colors : fallbacks
  return Array.from({ length: nextCount }, (_, index) => {
    const fallback = fallbacks[index] ?? fallbacks[fallbacks.length - 1] ?? "#ffffff"
    const current = source[index] ?? source[source.length - 1] ?? fallback
    return normalizeColor(current, fallback)
  })
}

function createFallbackTheme(id: string, label: string): AmbientThemeConfig {
  const base = DEFAULT_THEME_PRESETS[0]
  return {
    id,
    label,
    orbitCount: base.orbitCount,
    colors: {
      light: [...base.colors.light],
      dark: [...base.colors.dark],
    },
  }
}

function sanitizeTheme(theme: AmbientThemeConfig, fallback: AmbientThemeConfig): AmbientThemeConfig {
  const orbitCount = clampOrbitCount(theme.orbitCount)
  return {
    id:
      typeof theme.id === "string" && theme.id.trim()
        ? theme.id.trim()
        : fallback.id,
    label:
      typeof theme.label === "string" && theme.label.trim()
        ? theme.label.trim()
        : fallback.label,
    orbitCount,
    colors: {
      light: buildColorList(theme.colors?.light ?? [], orbitCount, fallback.colors.light),
      dark: buildColorList(theme.colors?.dark ?? [], orbitCount, fallback.colors.dark),
    },
  }
}

function buildDefaultPayload(): AmbientThemePayload {
  return {
    activeThemeId: DEFAULT_THEME_ID,
    themes: DEFAULT_THEME_PRESETS.map((theme) => sanitizeTheme(theme, theme)),
  }
}

function slugifyThemeId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return slug || "custom-theme"
}

function getUniqueThemeId(label: string, themes: AmbientThemeConfig[]): string {
  const baseId = slugifyThemeId(label)
  let nextId = baseId
  let suffix = 2

  while (themes.some((theme) => theme.id === nextId)) {
    nextId = `${baseId}-${suffix}`
    suffix += 1
  }

  return nextId
}

function normalizePayload(value: unknown): AmbientThemePayload {
  const fallbackMap = new Map(DEFAULT_THEME_PRESETS.map((theme) => [theme.id, theme]))
  const defaults = buildDefaultPayload()

  if (!value || typeof value !== "object") {
    return defaults
  }

  const record = value as { activeThemeId?: unknown; themes?: unknown }
  const themeList = Array.isArray(record.themes) ? record.themes : []

  const themes = themeList
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => {
      const id = typeof item.id === "string" && item.id.trim() ? item.id : "custom-theme"
      const label = typeof item.label === "string" && item.label.trim() ? item.label : "Custom theme"
      const fallback = fallbackMap.get(id) ?? createFallbackTheme(id, label)
      return sanitizeTheme(item as AmbientThemeConfig, fallback)
    })

  for (const fallback of DEFAULT_THEME_PRESETS) {
    if (!themes.some((theme) => theme.id === fallback.id)) {
      themes.push(sanitizeTheme(fallback, fallback))
    }
  }

  const activeThemeId =
    typeof record.activeThemeId === "string" &&
    themes.some((theme) => theme.id === record.activeThemeId)
      ? record.activeThemeId
      : defaults.activeThemeId

  return {
    activeThemeId,
    themes,
  }
}

export function AmbientThemeProvider({
  children,
  initialState,
}: {
  children: React.ReactNode
  initialState?: AmbientThemePayload
}) {
  const normalizedInitialState = React.useMemo(
    () => normalizePayload(initialState ?? buildDefaultPayload()),
    [initialState]
  )
  const [state, setState] = React.useState<AmbientThemePayload>(normalizedInitialState)
  const [hydrated, setHydrated] = React.useState(Boolean(initialState))
  const [dirty, setDirty] = React.useState(false)

  const fetchState = React.useCallback(async () => {
    const response = await fetch("/api/settings/ambient-theme", {
      cache: "no-store",
      credentials: "same-origin",
    })
    const data = (await response.json()) as { settings?: unknown }
    if (!response.ok) {
      throw new Error(
        typeof (data as { error?: unknown }).error === "string"
          ? (data as { error: string }).error
          : "Unable to load ambient theme settings"
      )
    }
    return normalizePayload(data.settings)
  }, [])

  React.useEffect(() => {
    if (initialState) {
      setState((current) => {
        const currentSignature = JSON.stringify(current)
        const nextSignature = JSON.stringify(normalizedInitialState)
        return currentSignature === nextSignature ? current : normalizedInitialState
      })
      setHydrated(true)
    }
  }, [initialState, normalizedInitialState])

  React.useEffect(() => {
    if (initialState) {
      return
    }

    let cancelled = false

    ;(async () => {
      try {
        const nextState = await fetchState()
        if (!cancelled) {
          setState(nextState)
        }
      } catch {
        // Keep defaults when the shared settings are temporarily unavailable.
      } finally {
        if (!cancelled) {
          setHydrated(true)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fetchState, initialState])

  React.useEffect(() => {
    if (!hydrated || dirty) {
      return
    }

    let cancelled = false

    const refresh = async () => {
      try {
        const nextState = await fetchState()
        if (!cancelled) {
          setState((current) => {
            const currentSignature = JSON.stringify(current)
            const nextSignature = JSON.stringify(nextState)
            return currentSignature === nextSignature ? current : nextState
          })
        }
      } catch {
        // Ignore background refresh errors.
      }
    }

    const intervalId = window.setInterval(() => {
      void refresh()
    }, 30_000)

    const handleFocus = () => {
      if (document.visibilityState === "visible") {
        void refresh()
      }
    }

    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleFocus)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleFocus)
    }
  }, [dirty, fetchState, hydrated])

  React.useEffect(() => {
    if (!hydrated || !dirty) {
      return
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/settings/ambient-theme", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          signal: controller.signal,
          body: JSON.stringify({
            activeThemeId: state.activeThemeId,
            themes: state.themes,
          }),
        })
        const data = (await response.json()) as { settings?: unknown; error?: unknown }
        if (!response.ok) {
          throw new Error(
            typeof data.error === "string" ? data.error : "Unable to save ambient theme settings"
          )
        }
        setState(normalizePayload(data.settings))
        setDirty(false)
      } catch {
        // Keep local state; the next edit or refresh can retry.
      }
    }, 350)

    return () => {
      controller.abort()
      window.clearTimeout(timeoutId)
    }
  }, [dirty, hydrated, state])

  const setActiveThemeId = React.useCallback((themeId: string) => {
    setState((current) => {
      if (!current.themes.some((theme) => theme.id === themeId)) {
        return current
      }

      if (current.activeThemeId === themeId) {
        return current
      }

      setDirty(true)
      return {
        ...current,
        activeThemeId: themeId,
      }
    })
  }, [])

  const addTheme = React.useCallback((label: string) => {
    const trimmedLabel = label.trim() || "Custom theme"
    let createdId = ""

    setState((current) => {
      createdId = getUniqueThemeId(trimmedLabel, current.themes)
      const nextTheme = createFallbackTheme(createdId, trimmedLabel)
      setDirty(true)
      return {
        activeThemeId: createdId,
        themes: [...current.themes, nextTheme],
      }
    })

    return createdId
  }, [])

  const updateThemeOrbitCount = React.useCallback((themeId: string, orbitCount: number) => {
    setState((current) => {
      const nextCount = clampOrbitCount(orbitCount)
      let changed = false

      const themes = current.themes.map((theme) => {
        if (theme.id !== themeId) {
          return theme
        }

        changed = changed || theme.orbitCount !== nextCount
        return {
          ...theme,
          orbitCount: nextCount,
          colors: {
            light: buildColorList(theme.colors.light, nextCount, theme.colors.light),
            dark: buildColorList(theme.colors.dark, nextCount, theme.colors.dark),
          },
        }
      })

      if (!changed) {
        return current
      }

      setDirty(true)
      return {
        ...current,
        themes,
      }
    })
  }, [])

  const updateThemeColor = React.useCallback(
    (themeId: string, mode: AmbientPaletteMode, orbitIndex: number, color: string) => {
      setState((current) => {
        let changed = false

        const themes = current.themes.map((theme) => {
          if (theme.id !== themeId) {
            return theme
          }

          const fallback =
            theme.colors[mode][orbitIndex] ??
            theme.colors[mode][theme.colors[mode].length - 1] ??
            "#ffffff"
          const normalized = normalizeColor(color, fallback)

          if (theme.colors[mode][orbitIndex] === normalized) {
            return theme
          }

          changed = true
          const nextColors = [...theme.colors[mode]]
          nextColors[orbitIndex] = normalized

          return {
            ...theme,
            colors: {
              ...theme.colors,
              [mode]: buildColorList(nextColors, theme.orbitCount, theme.colors[mode]),
            },
          }
        })

        if (!changed) {
          return current
        }

        setDirty(true)
        return {
          ...current,
          themes,
        }
      })
    },
    []
  )

  const resetThemes = React.useCallback(() => {
    setState(buildDefaultPayload())
    setDirty(true)
  }, [])

  const value = React.useMemo<AmbientThemeContextValue>(
    () => ({
      activeThemeId: state.activeThemeId,
      themes: state.themes,
      addTheme,
      resetThemes,
      setActiveThemeId,
      updateThemeColor,
      updateThemeOrbitCount,
    }),
    [
      addTheme,
      resetThemes,
      setActiveThemeId,
      state.activeThemeId,
      state.themes,
      updateThemeColor,
      updateThemeOrbitCount,
    ]
  )

  return <AmbientThemeContext.Provider value={value}>{children}</AmbientThemeContext.Provider>
}

export function useAmbientTheme() {
  const context = React.useContext(AmbientThemeContext)
  if (!context) {
    throw new Error("useAmbientTheme must be used within AmbientThemeProvider")
  }
  return context
}

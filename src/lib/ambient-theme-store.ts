import { unstable_cache, revalidateTag } from "next/cache"
import { ensureDriveSchema } from "@/lib/db"
import { getSupabaseServerClient } from "@/lib/supabase"

export type AmbientPaletteMode = "light" | "dark"

export type AmbientThemeConfig = {
  id: string
  label: string
  orbitCount: number
  colors: Record<AmbientPaletteMode, string[]>
}

export type AmbientThemeSettings = {
  activeThemeId: string
  themes: AmbientThemeConfig[]
}

type AmbientThemeSettingsRow = {
  key: string
  value: AmbientThemeSettings
  updated_at?: string
}

const SETTINGS_TABLE = "drive_app_settings"
const SETTINGS_KEY = "ambient_theme"
const AMBIENT_THEME_CACHE_TAG = "ambient-theme-settings"
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

export function getDefaultAmbientThemeSettings(): AmbientThemeSettings {
  return {
    activeThemeId: DEFAULT_THEME_ID,
    themes: DEFAULT_THEME_PRESETS.map((theme) => sanitizeTheme(theme, theme)),
  }
}

export function normalizeAmbientThemeSettings(value: unknown): AmbientThemeSettings {
  const fallbackMap = new Map(DEFAULT_THEME_PRESETS.map((theme) => [theme.id, theme]))
  const defaults = getDefaultAmbientThemeSettings()

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

  return {
    activeThemeId:
      typeof record.activeThemeId === "string" &&
      themes.some((theme) => theme.id === record.activeThemeId)
        ? record.activeThemeId
        : defaults.activeThemeId,
    themes,
  }
}

function normalizeSupabaseError(error: { message: string }): Error {
  const message = String(error?.message ?? "Supabase error")
  if (message.includes("Could not find the table") && message.includes(SETTINGS_TABLE)) {
    return new Error(
      `Supabase table '${SETTINGS_TABLE}' is missing. Create it from the Drive schema before using shared ambient theme settings.`
    )
  }

  return new Error(message)
}

async function loadAmbientThemeSettings(): Promise<AmbientThemeSettings> {
  await ensureDriveSchema().catch(() => undefined)

  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .select("key, value, updated_at")
    .eq("key", SETTINGS_KEY)
    .maybeSingle()

  if (error) throw normalizeSupabaseError(error)

  if (!data) {
    return getDefaultAmbientThemeSettings()
  }

  return normalizeAmbientThemeSettings((data as AmbientThemeSettingsRow).value)
}

const getAmbientThemeSettingsCached = unstable_cache(loadAmbientThemeSettings, ["ambient-theme-settings"], {
  tags: [AMBIENT_THEME_CACHE_TAG],
  revalidate: 300,
})

export async function getAmbientThemeSettings(): Promise<AmbientThemeSettings> {
  return getAmbientThemeSettingsCached()
}

export async function saveAmbientThemeSettings(
  input: AmbientThemeSettings
): Promise<AmbientThemeSettings> {
  await ensureDriveSchema().catch(() => undefined)

  const next = normalizeAmbientThemeSettings(input)
  const supabase = getSupabaseServerClient()
  const { data, error } = await supabase
    .from(SETTINGS_TABLE)
    .upsert(
      {
        key: SETTINGS_KEY,
        value: next,
      },
      { onConflict: "key" }
    )
    .select("key, value, updated_at")
    .single()

  if (error) throw normalizeSupabaseError(error)

  revalidateTag(AMBIENT_THEME_CACHE_TAG, "max")

  return normalizeAmbientThemeSettings((data as AmbientThemeSettingsRow).value)
}

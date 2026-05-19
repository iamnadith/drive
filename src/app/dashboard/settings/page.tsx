"use client"

import * as React from "react"

import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell"
import {
  type AmbientPaletteMode,
  useAmbientTheme,
} from "@/components/ambient-theme-provider"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export default function DashboardSettingsPage() {
  const {
    activeThemeId,
    themes,
    setActiveThemeId,
    addTheme,
    updateThemeColor,
    updateThemeOrbitCount,
    resetThemes,
  } = useAmbientTheme()
  const [selectedThemeId, setSelectedThemeId] = React.useState(activeThemeId)
  const [paletteMode, setPaletteMode] = React.useState<AmbientPaletteMode>("light")
  const [newThemeName, setNewThemeName] = React.useState("")

  React.useEffect(() => {
    if (!themes.some((theme) => theme.id === selectedThemeId)) {
      setSelectedThemeId(activeThemeId)
    }
  }, [activeThemeId, selectedThemeId, themes])

  const selectedTheme =
    themes.find((theme) => theme.id === selectedThemeId) ??
    themes.find((theme) => theme.id === activeThemeId) ??
    themes[0]

  if (!selectedTheme) {
    return null
  }

  const handleAddPreset = () => {
    const nextId = addTheme(newThemeName)
    setSelectedThemeId(nextId)
    setNewThemeName("")
  }

  return (
    <DashboardPage>
      <DashboardPageHeader
        title="Settings"
        description="Customize the ambient theme presets, control orbit count per theme, and set each orbit color independently for light and dark mode."
        actions={
          <Button variant="outline" onClick={resetThemes}>
            Reset presets
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <Card className="h-full">
          <CardHeader>
            <CardTitle>Ambient Themes</CardTitle>
            <CardDescription>
              Pick the active preset, or add a new one before editing orbit colors.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
              <div className="space-y-2">
                <Label htmlFor="new-theme-name">New preset</Label>
                <Input
                  id="new-theme-name"
                  value={newThemeName}
                  placeholder="Moonrise"
                  onChange={(event) => setNewThemeName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      handleAddPreset()
                    }
                  }}
                />
              </div>
              <Button className="mt-3 w-full" onClick={handleAddPreset}>
                Add preset
              </Button>
            </div>
            {themes.map((theme) => {
              const isActive = theme.id === activeThemeId
              const isSelected = theme.id === selectedThemeId

              return (
                <div
                  key={theme.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedThemeId(theme.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      setSelectedThemeId(theme.id)
                    }
                  }}
                  className={cn(
                    "w-full rounded-3xl border p-4 text-left backdrop-blur-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    isSelected
                      ? "border-foreground/20 bg-foreground/[0.05]"
                      : "border-border/70 bg-background/8 hover:bg-foreground/[0.03]"
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{theme.label}</p>
                        {isActive ? <Badge variant="secondary">Live</Badge> : null}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {theme.orbitCount} orbit{theme.orbitCount === 1 ? "" : "s"}
                      </p>
                    </div>
                    {!isActive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveThemeId(theme.id)
                        }}
                      >
                        Apply
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {theme.colors.light.slice(0, theme.orbitCount).map((color, index) => (
                      <span
                        key={`${theme.id}-light-${index}`}
                        className="h-6 w-6 rounded-full border border-black/10"
                        style={{ backgroundColor: color }}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card className="h-full">
          <CardHeader>
            <CardTitle>{selectedTheme.label} Customizer</CardTitle>
            <CardDescription>
              Adjust the orbit count for this preset and assign a separate color to every orbit in both light and dark mode.
            </CardDescription>
            <CardAction>
              {selectedTheme.id !== activeThemeId ? (
                <Button onClick={() => setActiveThemeId(selectedTheme.id)}>Make active</Button>
              ) : (
                <Badge variant="secondary">Currently active</Badge>
              )}
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
              <div className="space-y-2 rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
                <Label htmlFor="orbit-count">Orbit count</Label>
                <Input
                  id="orbit-count"
                  type="number"
                  min={1}
                  max={8}
                  value={selectedTheme.orbitCount}
                  onChange={(event) => {
                    const nextCount = Number(event.target.value)
                    if (!Number.isFinite(nextCount)) {
                      return
                    }
                    updateThemeOrbitCount(selectedTheme.id, nextCount)
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Supports 1 to 8 orbits per preset.
                </p>
              </div>
              <div className="space-y-3 rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl">
                <p className="text-sm font-medium">Quick preview</p>
                <div className="rounded-3xl border border-border/60 bg-background/10 p-4">
                  <div className="flex flex-wrap gap-3">
                    {selectedTheme.colors[paletteMode]
                      .slice(0, selectedTheme.orbitCount)
                      .map((color, index) => (
                        <div key={`${paletteMode}-${index}`} className="flex items-center gap-2">
                          <span
                            className="h-8 w-8 rounded-full border border-black/10"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-sm text-muted-foreground">Orbit {index + 1}</span>
                        </div>
                      ))}
                  </div>
                </div>
              </div>
            </div>

            <Tabs
              value={paletteMode}
              onValueChange={(value) => setPaletteMode(value as AmbientPaletteMode)}
            >
              <TabsList>
                <TabsTrigger value="light">Light mode</TabsTrigger>
                <TabsTrigger value="dark">Dark mode</TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {selectedTheme.colors[paletteMode]
                .slice(0, selectedTheme.orbitCount)
                .map((color, index) => (
                  <div
                    key={`${selectedTheme.id}-${paletteMode}-${index}`}
                    className="rounded-3xl border border-border/70 bg-background/8 p-4 backdrop-blur-xl"
                  >
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">Orbit {index + 1}</p>
                        <p className="text-xs text-muted-foreground">
                          {paletteMode === "light" ? "Light" : "Dark"} palette color
                        </p>
                      </div>
                      <span
                        className="h-8 w-8 rounded-full border border-black/10"
                        style={{ backgroundColor: color }}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`${paletteMode}-orbit-${index}`}>Hex color</Label>
                      <div className="flex items-center gap-3">
                        <Input
                          id={`${paletteMode}-orbit-${index}`}
                          type="color"
                          value={color}
                          className="h-11 w-16 cursor-pointer p-1"
                          onChange={(event) =>
                            updateThemeColor(
                              selectedTheme.id,
                              paletteMode,
                              index,
                              event.target.value
                            )
                          }
                        />
                        <Input
                          value={color}
                          onChange={(event) =>
                            updateThemeColor(
                              selectedTheme.id,
                              paletteMode,
                              index,
                              event.target.value
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </CardContent>
          <CardFooter>
            <p className="text-sm text-muted-foreground">
              Changes sync to the shared database and the applied preset becomes visible to every user.
            </p>
          </CardFooter>
        </Card>
      </div>
    </DashboardPage>
  )
}

"use client"

import * as React from "react"
import { useTheme } from "next-themes"

import { type AmbientPaletteMode, useAmbientTheme } from "@/components/ambient-theme-provider"

const ORBIT_ANCHORS = [
  { top: "-8rem", left: "-9rem" },
  { top: "10%", right: "-9rem" },
  { bottom: "-10rem", left: "-4rem" },
  { right: "-7rem", bottom: "2%" },
  { top: "28%", left: "12%" },
  { top: "44%", right: "18%" },
  { bottom: "18%", left: "38%" },
  { top: "16%", left: "48%" },
] as const

const ORBIT_SIZES = [
  "clamp(18rem, 30vw, 36rem)",
  "clamp(17rem, 28vw, 34rem)",
  "clamp(16rem, 27vw, 33rem)",
  "clamp(15rem, 25vw, 31rem)",
  "clamp(14rem, 22vw, 28rem)",
  "clamp(13rem, 21vw, 26rem)",
  "clamp(12rem, 20vw, 24rem)",
  "clamp(11rem, 18vw, 22rem)",
] as const

const ORBIT_DURATIONS = [22, 24, 26, 28, 30, 32, 34, 36] as const
const ORBIT_DELAYS = [0, -6, -12, -4, -15, -9, -18, -13] as const
const ORBIT_MOTIONS = [
  {
    x1: "10vw",
    y1: "4vh",
    x2: "24vw",
    y2: "16vh",
    x3: "40vw",
    y3: "30vh",
    x4: "18vw",
    y4: "12vh",
    s1: "1.08",
    s2: "1.16",
    s3: "1.22",
    s4: "1.1",
    o1: "0.74",
    o2: "0.46",
    o3: "0.68",
    o4: "0.58",
  },
  {
    x1: "-10vw",
    y1: "6vh",
    x2: "-24vw",
    y2: "18vh",
    x3: "-38vw",
    y3: "30vh",
    x4: "-16vw",
    y4: "12vh",
    s1: "1.04",
    s2: "1.14",
    s3: "1.2",
    s4: "1.08",
    o1: "0.7",
    o2: "0.42",
    o3: "0.66",
    o4: "0.54",
  },
  {
    x1: "10vw",
    y1: "-6vh",
    x2: "24vw",
    y2: "-18vh",
    x3: "38vw",
    y3: "-30vh",
    x4: "18vw",
    y4: "-12vh",
    s1: "1.06",
    s2: "1.16",
    s3: "1.24",
    s4: "1.1",
    o1: "0.68",
    o2: "0.4",
    o3: "0.62",
    o4: "0.56",
  },
  {
    x1: "-10vw",
    y1: "-6vh",
    x2: "-24vw",
    y2: "-18vh",
    x3: "-38vw",
    y3: "-30vh",
    x4: "-18vw",
    y4: "-12vh",
    s1: "1.04",
    s2: "1.12",
    s3: "1.2",
    s4: "1.08",
    o1: "0.72",
    o2: "0.44",
    o3: "0.64",
    o4: "0.58",
  },
] as const

function getOrbitPosition(index: number): React.CSSProperties {
  const anchor = ORBIT_ANCHORS[index % ORBIT_ANCHORS.length]
  return { ...anchor }
}

export function SiteAmbient() {
  const { activeThemeId, themes } = useAmbientTheme()
  const { resolvedTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const activeTheme =
    themes.find((theme) => theme.id === activeThemeId) ??
    themes[0] ?? {
      id: "fallback",
      label: "Fallback",
      orbitCount: 1,
      colors: { light: ["#ffffff"], dark: ["#ffffff"] },
    }

  const mode: AmbientPaletteMode = mounted && resolvedTheme === "dark" ? "dark" : "light"
  const colors = activeTheme.colors[mode]

  return (
    <div aria-hidden="true" className="site-ambient">
      {Array.from({ length: activeTheme.orbitCount }).map((_, index) => (
        <div
          key={`${activeTheme.id}-${index}`}
          className="site-ambient-orb"
          style={{
            ...getOrbitPosition(index),
            width: ORBIT_SIZES[index % ORBIT_SIZES.length],
            height: ORBIT_SIZES[index % ORBIT_SIZES.length],
            background: `radial-gradient(circle, ${colors[index] ?? colors[colors.length - 1] ?? "#ffffff"} 0%, transparent 72%)`,
            animationName: "ambient-orbit-loop",
            animationDuration: `${ORBIT_DURATIONS[index % ORBIT_DURATIONS.length]}s`,
            animationDelay: `${ORBIT_DELAYS[index % ORBIT_DELAYS.length]}s`,
            animationTimingFunction: "linear",
            animationIterationCount: "infinite",
            ["--ambient-x-1" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].x1,
            ["--ambient-y-1" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].y1,
            ["--ambient-x-2" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].x2,
            ["--ambient-y-2" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].y2,
            ["--ambient-x-3" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].x3,
            ["--ambient-y-3" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].y3,
            ["--ambient-x-4" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].x4,
            ["--ambient-y-4" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].y4,
            ["--ambient-scale-1" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].s1,
            ["--ambient-scale-2" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].s2,
            ["--ambient-scale-3" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].s3,
            ["--ambient-scale-4" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].s4,
            ["--ambient-opacity-1" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].o1,
            ["--ambient-opacity-2" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].o2,
            ["--ambient-opacity-3" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].o3,
            ["--ambient-opacity-4" as string]:
              ORBIT_MOTIONS[index % ORBIT_MOTIONS.length].o4,
          }}
        />
      ))}
    </div>
  )
}

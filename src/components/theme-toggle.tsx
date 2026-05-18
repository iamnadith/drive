"use client"

import * as React from "react"
import { Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function ThemeToggle({
  className,
  iconClassName,
}: {
  className?: string
  iconClassName?: string
}) {
  const { resolvedTheme, setTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted ? resolvedTheme === "dark" : true

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Light theme" : "Dark theme"}
      className={className}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className={cn("h-4 w-4", iconClassName)} /> : <Moon className={cn("h-4 w-4", iconClassName)} />}
    </Button>
  )
}

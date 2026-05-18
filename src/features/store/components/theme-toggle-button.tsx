"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ThemeToggleButtonProps = {
  compact?: boolean;
  className?: string;
  iconClassName?: string;
};

export function ThemeToggleButton({
  compact,
  className,
  iconClassName,
}: ThemeToggleButtonProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const Icon = isDark ? Sun : Moon;

  if (compact) {
    return (
      <button
        type="button"
        aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--border)] bg-transparent p-0 text-[var(--foreground)] transition-[background-color,border-color,color,box-shadow,transform] duration-200 ease-out hover:brightness-[1.03] active:scale-[0.98]",
          className
        )}
        onClick={() => setTheme(isDark ? "light" : "dark")}
      >
        <Icon className={cn("h-4 w-4 shrink-0", iconClassName)} />
      </button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="default"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={className}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      <Icon className={cn("h-4 w-4", iconClassName)} />
    </Button>
  );
}

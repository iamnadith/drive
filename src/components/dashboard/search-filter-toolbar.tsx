"use client"

import * as React from "react"
import { RefreshCw, Search, SlidersHorizontal, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export type SearchFilterOption = {
  key: string
  label: string
  type: "select" | "date" | "text"
  defaultValue: string
  placeholder?: string
  options?: Array<{ value: string; label: string }>
}

type DashboardSearchFilterToolbarProps = {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  countSearch?: boolean
  filters?: SearchFilterOption[]
  filterValues?: Record<string, string>
  onFilterChange?: (key: string, value: string) => void
  onClear?: () => void
  title?: string
  description?: string
  onRefresh?: () => void
  refreshing?: boolean
  refreshLabel?: string
  actions?: React.ReactNode
  searchWidthClassName?: string
}

export const DASHBOARD_TOOLBAR_ACTION_BUTTON_CLASS =
  "size-9 min-w-9 shrink-0 rounded-full border border-border/70 bg-background/85 p-0 text-foreground shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md sm:h-9 sm:w-auto sm:min-w-0 sm:px-3 sm:py-2"

const dashboardToolbarIconButtonClass =
  "size-9 min-w-9 shrink-0 rounded-full border border-border/70 bg-background/85 p-0 text-foreground shadow-sm ring-1 ring-inset ring-white/15 backdrop-blur-sm transition-[border-color,background-color,box-shadow] hover:border-border hover:bg-muted/55 hover:shadow-md"

export function DashboardSearchFilterToolbar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search",
  countSearch = false,
  filters = [],
  filterValues = {},
  onFilterChange,
  onClear,
  title = "Filters",
  description = "Refine the results shown in this table.",
  onRefresh,
  refreshing = false,
  refreshLabel = "Refresh",
  actions,
  searchWidthClassName = "sm:w-[220px]",
}: DashboardSearchFilterToolbarProps) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const activeCount = filters.filter(
    (filter) => (filterValues[filter.key] ?? filter.defaultValue) !== filter.defaultValue,
  ).length + (countSearch && searchValue.trim() ? 1 : 0)

  return (
    <>
      <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
        <div className={`relative h-9 min-w-0 flex-1 ${searchWidthClassName}`}>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchValue}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={searchPlaceholder}
            className="h-9 w-full pl-8"
          />
        </div>
        {filters.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setOpen(true)}
            aria-label="Open filters"
            className={dashboardToolbarIconButtonClass}
          >
            <SlidersHorizontal className="h-4 w-4" />
            {activeCount > 0 ? (
              <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-primary-foreground">
                {activeCount}
              </span>
            ) : null}
          </Button>
        ) : null}
        {onRefresh ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={refreshLabel}
            aria-busy={refreshing || undefined}
            className={dashboardToolbarIconButtonClass}
          >
            <RefreshCw className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          </Button>
        ) : null}
        {actions}
      </div>

      {filters.length > 0 ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {filters.map((filter) => {
                const fieldId = `${id}-${filter.key}`
                const value = filterValues[filter.key] ?? filter.defaultValue
                return (
                  <div key={filter.key} className="space-y-1.5">
                    <Label htmlFor={fieldId}>{filter.label}</Label>
                    {filter.type === "select" ? (
                      <Select value={value} onValueChange={(next) => onFilterChange?.(filter.key, next)}>
                        <SelectTrigger id={fieldId} className="h-9 w-full">
                          <SelectValue placeholder={filter.placeholder ?? filter.label} />
                        </SelectTrigger>
                        <SelectContent>
                          {(filter.options ?? []).map((option) => (
                          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id={fieldId}
                        type={filter.type}
                        value={value}
                        placeholder={filter.placeholder}
                        onChange={(event) => onFilterChange?.(filter.key, event.target.value)}
                        className="h-9"
                      />
                    )}
                  </div>
                )
              })}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => onClear?.()}>
                <X className="h-4 w-4" />
                Clear
              </Button>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  )
}

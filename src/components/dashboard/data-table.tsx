"use client"

import * as React from "react"
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

type DashboardColumnMeta = {
  width?: string
  align?: "left" | "center" | "right"
  divider?: boolean
  headerClassName?: string
  cellClassName?: string
}

type DashboardDataTableProps<TData> = {
  data: TData[]
  columns: ColumnDef<TData, unknown>[]
  pageSize?: number
  minWidth?: string
  header?: React.ReactNode
  emptyState?: React.ReactNode
  footer?: React.ReactNode
  serverPagination?: {
    pageIndex: number
    pageCount: number
    onPageChange: (pageIndex: number) => void
  }
  loading?: boolean
  loadingRows?: number
  className?: string
  containerClassName?: string
  tableClassName?: string
  rowClassName?: string
  resetKey?: string | number
  withCard?: boolean
}

const paginationButtonClass =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/80 bg-background/85 p-0 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/55 disabled:pointer-events-none disabled:opacity-50 sm:w-auto sm:gap-1 sm:px-2.5"
const pageButtonClass =
  "inline-flex h-8 w-8 min-w-8 max-w-8 flex-none aspect-square items-center justify-center rounded-full border border-border/80 bg-background/85 p-0 text-xs font-medium leading-none text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-muted/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

export function DashboardDataTable<TData>({
  data,
  columns,
  pageSize = 10,
  minWidth = "900px",
  header,
  emptyState = "No results.",
  footer,
  serverPagination,
  loading = false,
  loadingRows = 6,
  className,
  containerClassName,
  tableClassName,
  rowClassName,
  resetKey,
  withCard = true,
}: DashboardDataTableProps<TData>) {
  const safePageSize = Number.isFinite(pageSize) ? Math.max(1, Math.floor(pageSize)) : 10
  const [pagination, setPagination] = React.useState({ pageIndex: 0, pageSize: safePageSize })

  React.useEffect(() => {
    setPagination((current) => ({ ...current, pageIndex: 0, pageSize: safePageSize }))
  }, [safePageSize, resetKey])

  // TanStack's table instance intentionally exposes methods consumed directly below.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    state: { pagination },
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: true,
  })
  const pageCount = Math.max(1, serverPagination?.pageCount ?? table.getPageCount())
  const pageIndex = serverPagination?.pageIndex ?? table.getState().pagination.pageIndex
  const canPreviousPage = serverPagination ? pageIndex > 0 : table.getCanPreviousPage()
  const canNextPage = serverPagination ? pageIndex < pageCount - 1 : table.getCanNextPage()
  const goToPage = serverPagination?.onPageChange ?? table.setPageIndex
  const pageWindow = Math.min(pageCount, 3)
  const desktopPageWindow = Math.min(pageCount, 5)
  const mobileStart = Math.max(0, Math.min(pageIndex - Math.floor(pageWindow / 2), pageCount - pageWindow))
  const desktopStart = Math.max(0, Math.min(pageIndex - Math.floor(desktopPageWindow / 2), pageCount - desktopPageWindow))
  const mobilePages = Array.from({ length: pageWindow }, (_, index) => mobileStart + index)
  const desktopPages = Array.from({ length: desktopPageWindow }, (_, index) => desktopStart + index)
  const visibleColumns = table.getVisibleLeafColumns()

  return (
    <>
      <TableSurface withCard={withCard} className={className}>
        {header ? (
          <div className="flex min-h-16 items-center justify-center border-b px-4 py-3 text-center [&>*]:w-full">
            {header}
          </div>
        ) : null}
        <Table
          className={cn("w-full", tableClassName)}
          style={{ minWidth }}
          containerClassName={cn(
            "rounded-b-none max-sm:-mt-3 max-sm:!mx-0 max-sm:!w-full [-ms-overflow-style:none] [scrollbar-width:thin]",
            containerClassName,
          )}
        >
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className="h-9 border-b">
                {headerGroup.headers.map((header) => {
                  const meta = header.column.columnDef.meta as DashboardColumnMeta | undefined
                  const isLastAction = header.column.id === "actions"
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        "relative px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground",
                        meta?.width ?? (isLastAction ? "min-w-[110px]" : "min-w-[120px]"),
                        meta?.align === "center" && "text-center",
                        meta?.align === "right" && "text-right",
                        meta?.headerClassName,
                      )}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                      {meta?.divider !== false && !isLastAction ? (
                        <span aria-hidden="true" className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" />
                      ) : null}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: loadingRows }, (_, index) => (
                <TableRow key={`loading-${index}`} className="h-[64px]">
                  <TableCell colSpan={visibleColumns.length} className="px-2.5 py-2">
                    <Skeleton className="h-10 w-full rounded-xl" />
                  </TableCell>
                </TableRow>
              ))
            ) : table.getRowModel().rows.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() && "selected"}
                  className={cn("h-[64px] border-b last:border-b-0 hover:bg-muted/30", rowClassName)}
                >
                  {row.getVisibleCells().map((cell) => {
                    const meta = cell.column.columnDef.meta as DashboardColumnMeta | undefined
                    const isLastAction = cell.column.id === "actions"
                    return (
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "relative px-2.5 py-2 align-middle",
                          meta?.align === "center" && "text-center",
                          meta?.align === "right" && "text-right",
                          meta?.cellClassName,
                        )}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        {meta?.divider !== false && !isLastAction ? (
                          <span aria-hidden="true" className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                        ) : null}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={visibleColumns.length} className="h-24 text-center text-sm text-muted-foreground">
                  {emptyState}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {footer ? (
          <div className="border-t px-3 py-2 text-center text-xs text-muted-foreground">
            {footer}
          </div>
        ) : null}
        <div className="border-t px-3 py-2 text-xs text-muted-foreground max-sm:-mb-2">
            <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
              <button
                type="button"
                className={cn(paginationButtonClass, "justify-self-start")}
                aria-label="Previous page"
                disabled={!canPreviousPage}
                onClick={() => goToPage(pageIndex - 1)}
              >
                <ChevronLeft className="h-4 w-4 sm:mr-1" />
                <span className="hidden sm:inline">Previous</span>
              </button>
              <div className="flex min-w-0 max-w-full items-center justify-center gap-1 justify-self-center overflow-x-auto">
                <div className="flex min-w-0 items-center gap-1 sm:hidden">
                  {mobilePages.map((page) => (
                    <PageButton key={`m-${page}`} page={page} currentPage={pageIndex} onSelect={() => goToPage(page)} />
                  ))}
                </div>
                <div className="hidden min-w-0 items-center gap-1 sm:flex">
                  {desktopPages.map((page) => (
                    <PageButton key={`d-${page}`} page={page} currentPage={pageIndex} onSelect={() => goToPage(page)} />
                  ))}
                </div>
              </div>
              <button
                type="button"
                className={cn(paginationButtonClass, "justify-self-end")}
                aria-label="Next page"
                disabled={!canNextPage}
                onClick={() => goToPage(pageIndex + 1)}
              >
                <span className="hidden sm:inline">Next</span>
                <ChevronRight className="h-4 w-4 sm:ml-1" />
              </button>
            </div>
        </div>
      </TableSurface>
    </>
  )
}

function TableSurface({
  withCard,
  className,
  children,
}: {
  withCard: boolean
  className?: string
  children: React.ReactNode
}) {
  return withCard ? (
    <Card className={cn("dashboard-motion-item overflow-hidden gap-0 sm:gap-0 md:gap-0", className)}>{children}</Card>
  ) : (
    <div className={cn("min-w-0 overflow-hidden rounded-xl border bg-card", className)}>{children}</div>
  )
}

function PageButton({
  page,
  currentPage,
  onSelect,
}: {
  page: number
  currentPage: number
  onSelect: () => void
}) {
  const active = page === currentPage
  return (
    <button
      type="button"
      className={cn(pageButtonClass, active && "bg-muted/60")}
      aria-label={`Page ${page + 1}`}
      aria-current={active ? "page" : undefined}
      disabled={active}
      onClick={onSelect}
    >
      {page + 1}
    </button>
  )
}

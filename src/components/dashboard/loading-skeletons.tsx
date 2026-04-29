import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  DashboardPage,
  DashboardPanel,
} from "@/components/dashboard/page-shell"

function PageHeaderSkeleton({
  actions = 1,
  descriptionWidth = "w-[min(32rem,80vw)]",
  titleWidth = "w-48",
}: {
  actions?: number
  descriptionWidth?: string
  titleWidth?: string
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="space-y-2">
        <Skeleton className={`h-7 ${titleWidth}`} />
        <Skeleton className={`h-4 ${descriptionWidth}`} />
      </div>
      {actions > 0 ? (
        <div className="flex flex-wrap gap-2 sm:justify-end">
          {Array.from({ length: actions }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-28" />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function MetricCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: count }).map((_, index) => (
        <Card key={index}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-4 rounded-md" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-36" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function TableRowsSkeleton({
  rows = 8,
  columns = 4,
}: {
  rows?: number
  columns?: number
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }).map((_, index) => (
          <Skeleton key={index} className="h-4 w-24" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <div
          key={rowIndex}
          className="grid gap-3 rounded-lg border px-3 py-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: columns }).map((_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={columnIndex === 0 ? "h-5 w-4/5" : "h-5 w-3/5"}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function DashboardOverviewSkeleton() {
  return (
    <DashboardPage>
      <PageHeaderSkeleton actions={1} titleWidth="w-36" />
      <MetricCardsSkeleton count={4} />
      <Card>
        <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-8 w-40" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-72 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    </DashboardPage>
  )
}

function DashboardAnalyticsSkeleton() {
  return (
    <DashboardPage>
      <PageHeaderSkeleton actions={1} titleWidth="w-44" />
      <MetricCardsSkeleton count={8} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[360px] w-full" />
        <Skeleton className="h-[360px] w-full" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Skeleton className="h-[320px] w-full" />
        <Skeleton className="h-[320px] w-full" />
      </div>
    </DashboardPage>
  )
}

function DashboardTableSkeleton({
  actions = 2,
  cards = 0,
  columns = 5,
  filters = 2,
  rows = 8,
  titleWidth = "w-44",
}: {
  actions?: number
  cards?: number
  columns?: number
  filters?: number
  rows?: number
  titleWidth?: string
}) {
  return (
    <DashboardPage>
      <PageHeaderSkeleton actions={actions} titleWidth={titleWidth} />
      {cards > 0 ? <MetricCardsSkeleton count={cards} /> : null}
      <DashboardPanel className="p-4">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: filters }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-40" />
            ))}
          </div>
          <Skeleton className="h-9 w-28" />
        </div>
        <TableRowsSkeleton columns={columns} rows={rows} />
      </DashboardPanel>
    </DashboardPage>
  )
}

function StoragePageSkeleton() {
  return (
    <div className="flex min-h-[calc(100dvh-8rem)] flex-col gap-3">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <div className="grid min-h-[520px] gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <DashboardPanel className="p-3">
          <Skeleton className="mb-3 h-9 w-full" />
          <div className="space-y-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        </DashboardPanel>
        <DashboardPanel className="p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            <Skeleton className="h-9 min-w-56 flex-1" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-32" />
          </div>
          <TableRowsSkeleton columns={5} rows={9} />
        </DashboardPanel>
      </div>
    </div>
  )
}

function WorkerPageSkeleton() {
  return (
    <DashboardPage className="space-y-6">
      <PageHeaderSkeleton actions={2} titleWidth="w-36" />
      <MetricCardsSkeleton count={4} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
        <DashboardPanel className="p-4">
          <Skeleton className="mb-4 h-6 w-40" />
          <TableRowsSkeleton columns={4} rows={7} />
        </DashboardPanel>
        <DashboardPanel className="p-4">
          <Skeleton className="mb-4 h-6 w-36" />
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full" />
            ))}
          </div>
        </DashboardPanel>
      </div>
    </DashboardPage>
  )
}

function DetailPageSkeleton() {
  return (
    <DashboardPage>
      <PageHeaderSkeleton actions={2} titleWidth="w-56" />
      <MetricCardsSkeleton count={3} />
      <DashboardPanel className="p-4">
        <Skeleton className="mb-4 h-6 w-44" />
        <TableRowsSkeleton columns={4} rows={8} />
      </DashboardPanel>
    </DashboardPage>
  )
}

export {
  DashboardAnalyticsSkeleton,
  DashboardOverviewSkeleton,
  DashboardTableSkeleton,
  DetailPageSkeleton,
  MetricCardsSkeleton,
  StoragePageSkeleton,
  TableRowsSkeleton,
  WorkerPageSkeleton,
}

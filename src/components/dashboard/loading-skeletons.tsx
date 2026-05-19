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

function OverviewHeaderSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
      <div className="min-w-0 mt-1 md:mt-0">
        <Skeleton className="h-8 w-36" />
      </div>
      <div className="flex justify-end gap-2 self-start">
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-full" />
      </div>
      <Skeleton className="col-span-2 mt-2 h-4 w-[min(34rem,88vw)] md:col-span-1 md:mt-1" />
    </div>
  )
}

function AnalyticsHeaderSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
      <div className="min-w-0">
        <Skeleton className="h-8 w-40" />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="hidden h-4 w-3 md:block" />
          <Skeleton className="h-4 w-28" />
        </div>
      </div>
      <Skeleton className="h-8 w-8 rounded-full" />
    </div>
  )
}

function ActivityHeaderSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-[min(30rem,82vw)]" />
      </div>
      <div className="flex w-full items-center gap-2 sm:w-auto">
        <Skeleton className="h-10 min-w-0 flex-1 rounded-full sm:w-[320px] sm:flex-none" />
        <Skeleton className="h-10 w-10 rounded-full" />
        <Skeleton className="h-10 w-10 rounded-full" />
      </div>
    </div>
  )
}

function ChartCardSkeleton({
  chartHeight = "h-[250px]",
  rangeWidth = "w-32",
}: {
  chartHeight?: string
  rangeWidth?: string
}) {
  return (
    <Card className="@container/card gap-0 py-0">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1 px-4 pt-4.5 pb-2 sm:px-6 md:gap-1.5 md:px-4 md:pt-2.5 md:pb-2">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className={`h-8 ${rangeWidth} rounded-full`} />
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <div className={`rounded-2xl border border-border/50 bg-muted/20 p-4 ${chartHeight}`}>
          <div className="flex h-full items-end gap-2">
            {Array.from({ length: 10 }).map((_, index) => (
              <Skeleton
                key={index}
                className="w-full rounded-full"
                style={{ height: `${42 + ((index * 13) % 48)}%` }}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function RecentActivitySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden gap-0 py-0">
      <CardHeader className="border-b flex min-h-16 items-center px-4 py-2.5 pb-0 sm:min-h-0 sm:px-5 md:px-4 md:py-2">
        <div className="flex w-full items-center justify-between gap-3 md:gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {Array.from({ length: rows }).map((_, index) => (
            <li key={index} className="px-4 py-3">
              <div className="grid gap-3 md:grid-cols-[144px_minmax(0,1fr)_auto] md:items-center md:gap-4">
                <div className="space-y-2 md:border-r md:border-border/60 md:pr-4">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-2 w-2 rounded-full" />
                    <Skeleton className="h-3 w-20" />
                  </div>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-28" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-[85%]" />
                  <Skeleton className="h-3 w-[60%]" />
                </div>
                <div className="flex items-center justify-between gap-3 md:flex-col md:items-end">
                  <Skeleton className="h-6 w-20 rounded-full" />
                  <Skeleton className="h-4 w-4 rounded-full" />
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function BucketsListSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <Card className="xl:sticky xl:top-4 xl:self-start">
      <CardHeader className="gap-1 pb-2 md:px-4">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-1.5 md:px-4">
        {Array.from({ length: rows }).map((_, index) => (
          <div
            key={index}
            className="rounded-xl border px-3 py-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-2"
          >
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="mt-3 space-y-2 md:mt-0 md:text-right">
              <Skeleton className="h-4 w-20 md:ml-auto" />
              <Skeleton className="h-3 w-12 md:ml-auto" />
            </div>
            <div className="mt-3 space-y-2 md:mt-0 md:text-right">
              <Skeleton className="h-4 w-16 md:ml-auto" />
              <Skeleton className="h-3 w-12 md:ml-auto" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-2 md:mt-0 md:justify-end">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="hidden h-4 w-4 rounded-full md:block" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function HealthPanelSkeleton() {
  return (
    <Card>
      <CardHeader className="gap-1 pb-2 md:px-4">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-72" />
      </CardHeader>
      <CardContent className="space-y-3 md:px-4">
        <div className="space-y-2 rounded-xl border p-3">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-12" />
          </div>
          <Skeleton className="h-2.5 w-full rounded-full" />
        </div>
        <div className="grid gap-2.5 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="rounded-xl border p-3 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function AttentionPanelSkeleton() {
  return (
    <Card>
      <CardHeader className="gap-1 pb-2 md:px-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-2 md:px-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-xl border p-3 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-[92%]" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
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
      <OverviewHeaderSkeleton />
      <MetricCardsSkeleton count={4} />
      <ChartCardSkeleton chartHeight="h-[250px]" rangeWidth="w-40" />
      <RecentActivitySkeleton rows={4} />
    </DashboardPage>
  )
}

function DashboardAnalyticsSkeleton() {
  return (
    <DashboardPage>
      <AnalyticsHeaderSkeleton />
      <MetricCardsSkeleton count={8} />
      <div className="grid gap-3 xl:grid-cols-2">
        <ChartCardSkeleton chartHeight="h-[252px]" />
        <ChartCardSkeleton chartHeight="h-[240px]" />
      </div>
      <ChartCardSkeleton chartHeight="h-[240px]" rangeWidth="w-32" />
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] xl:items-start">
        <BucketsListSkeleton rows={7} />
        <div className="space-y-3 xl:sticky xl:top-4 xl:self-start">
          <HealthPanelSkeleton />
          <AttentionPanelSkeleton />
        </div>
      </div>
    </DashboardPage>
  )
}

function DashboardActivitySkeleton() {
  return (
    <DashboardPage>
      <ActivityHeaderSkeleton />
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-8 w-[4.5rem] rounded-full" />
        </div>
        <Skeleton className="h-4 w-28" />
      </div>
      <Card className="py-0">
        <CardContent className="p-0">
          <ul className="divide-y">
            {Array.from({ length: 8 }).map((_, index) => (
              <li key={index} className="px-4 py-3">
                <div className="grid gap-3 xl:grid-cols-[148px_minmax(0,1fr)_196px_auto] xl:items-start">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="hidden h-3 w-24 xl:block" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-[82%]" />
                    <Skeleton className="h-3 w-[46%]" />
                    <Skeleton className="h-3 w-[70%]" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-3 w-36" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                  <div className="flex items-center justify-between gap-3 xl:flex-col xl:items-end xl:justify-start">
                    <Skeleton className="h-6 w-[4.5rem] rounded-full" />
                    <Skeleton className="h-8 w-16 rounded-full" />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
        <div className="border-t p-4">
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
            <Skeleton className="h-9 w-24 rounded-full justify-self-start" />
            <div className="flex justify-center gap-1.5">
              {Array.from({ length: 3 }).map((_, index) => (
                <Skeleton key={index} className="h-8 w-8 rounded-full" />
              ))}
            </div>
            <Skeleton className="h-9 w-20 rounded-full justify-self-end" />
          </div>
        </div>
      </Card>
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
  DashboardActivitySkeleton,
  DashboardAnalyticsSkeleton,
  DashboardOverviewSkeleton,
  DashboardTableSkeleton,
  DetailPageSkeleton,
  MetricCardsSkeleton,
  StoragePageSkeleton,
  TableRowsSkeleton,
  WorkerPageSkeleton,
}

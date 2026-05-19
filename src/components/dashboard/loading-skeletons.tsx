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
    <div className="mb-[0.7rem] grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
      <div className="-mt-1 min-w-0">
        <Skeleton className="h-8 w-36" />
        <div className="mt-px flex flex-wrap items-center gap-x-2 gap-y-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="hidden h-4 w-2 md:block" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
        </div>
      </div>
      <div className="flex justify-end gap-2 self-start">
        <Skeleton className="h-9 w-9 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>
    </div>
  )
}

function OverviewMetricCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, index) => (
        <Card
          key={index}
          className="dashboard-motion-item gap-0 py-0"
          style={{ ["--dashboard-motion-delay" as string]: `${130 + index * 55}ms` }}
        >
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-0 max-sm:px-3 max-sm:pt-1.5 lg:px-5 lg:pt-5">
            <Skeleton className="h-4 w-20 max-sm:w-16" />
            <Skeleton className="h-4 w-4 rounded-md" />
          </CardHeader>
          <CardContent className="max-sm:px-3 max-sm:pb-1.5 lg:px-5 lg:pb-5">
            <Skeleton className="h-7 w-20 max-sm:h-6 max-sm:w-16" />
            <Skeleton className="mt-0 h-3 w-24 max-sm:w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function OverviewUsageChartSkeleton() {
  return (
    <Card className="@container/card pb-0 sm:pb-0.5">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-0 md:gap-1">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-32 @[540px]/card:w-52 md:h-4" />
        </div>
        <div className="col-start-2 row-start-1 mt-0 justify-self-end self-start">
          <Skeleton className="h-9 w-[8.75rem] rounded-xl @[767px]/card:hidden" />
          <Skeleton className="hidden h-8 w-[22rem] rounded-full @[767px]/card:block" />
        </div>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <div className="rounded-2xl border border-border/40 bg-muted/20 px-3 pt-3">
          <div className="flex h-[250px] items-end gap-1.5 sm:gap-2">
            {Array.from({ length: 12 }).map((_, index) => (
              <Skeleton
                key={index}
                className="dashboard-motion-item w-full rounded-full"
                style={{
                  ["--dashboard-motion-delay" as string]: `${220 + index * 35}ms`,
                  height: `${24 + ((index * 9) % 54)}%`,
                }}
              />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function OverviewRecentActivitySkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden gap-0 py-0">
      <CardHeader className="border-b flex min-h-16 items-center px-4 py-2.5 pb-0 sm:min-h-0 sm:px-5 md:px-4 md:py-2">
        <div className="flex w-full items-center justify-between gap-3 md:gap-2">
          <div className="min-w-0 flex-1 flex-col justify-center gap-0.5 space-y-1">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-4 w-36" />
          </div>
          <Skeleton className="h-8 w-24 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y">
          {Array.from({ length: rows }).map((_, index) => (
            <li
              key={index}
              className="dashboard-motion-item md:py-3 md:first:pt-0 md:last:pb-0"
              style={{ ["--dashboard-motion-delay" as string]: `${260 + index * 55}ms` }}
            >
              <div className="px-4 py-2.5 md:px-4 md:py-0">
                <div className="grid gap-2.5 md:grid-cols-[144px_minmax(0,1fr)_auto] md:items-center md:gap-4">
                  <div className="flex items-center justify-between gap-3 md:block md:self-stretch md:border-r md:border-border/60 md:pr-4">
                    <div className="flex items-center gap-2 md:mb-2">
                      <Skeleton className="h-2 w-2 rounded-full" />
                      <Skeleton className="h-3 w-20" />
                    </div>
                    <div className="hidden space-y-1 md:block">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                  </div>
                  <div className="min-w-0 pr-6 md:pr-0 space-y-2">
                    <Skeleton className="h-4 w-[85%]" />
                    <Skeleton className="h-3 w-[52%]" />
                  </div>
                  <div className="flex items-center justify-between gap-3 md:self-stretch md:flex-col md:items-end md:justify-between md:gap-1">
                    <div className="space-y-1 md:hidden">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="hidden h-4 w-4 rounded-full md:block" />
                    <Skeleton className="h-6 w-20 rounded-full" />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function AnalyticsHeaderSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1">
      <div className="min-w-0">
        <Skeleton className="h-8 w-40" />
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="hidden h-4 w-2 md:block" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3.5 w-3.5 rounded-full" />
        </div>
      </div>
      <Skeleton className="h-8 w-8 rounded-full" />
    </div>
  )
}

function AnalyticsMetricCardsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <Card
          key={index}
          className="dashboard-motion-item gap-0 py-0"
          style={{ ["--dashboard-motion-delay" as string]: `${130 + index * 50}ms` }}
        >
          <CardHeader className="flex flex-row items-start justify-between gap-3 px-4 py-3 pb-1.5 lg:px-4 lg:py-3 lg:pb-1.5">
            <Skeleton className="h-4 w-20 max-sm:w-16" />
            <Skeleton className="h-4 w-4 rounded-md" />
          </CardHeader>
          <CardContent className="px-4 pb-3 pt-0 lg:px-4 lg:pb-3">
            <Skeleton className="h-7 w-20 max-sm:h-6 max-sm:w-16 sm:h-8" />
            <Skeleton className="mt-1 h-3 w-24 max-sm:w-20" />
          </CardContent>
        </Card>
      ))}
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
  contentClassName = "px-1.5 pt-3 pb-0 sm:px-4 sm:pt-3 sm:pb-1 md:px-3",
}: {
  chartHeight?: string
  rangeWidth?: string
  contentClassName?: string
}) {
  return (
    <Card className="@container/card gap-0 py-0">
      <CardHeader className="grid-cols-[minmax(0,1fr)_auto] gap-1 px-4 pt-4.5 pb-2 sm:px-6 md:gap-1.5 md:px-4 md:pt-5 md:pb-2">
        <div className="space-y-2">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-3.5 w-48 md:h-4 md:w-56" />
        </div>
        <div className="justify-self-end">
          <Skeleton className="h-8 w-32 rounded-full @[767px]/card:hidden" />
          <Skeleton className={`hidden h-8 ${rangeWidth} rounded-full @[767px]/card:block`} />
        </div>
      </CardHeader>
      <CardContent className={contentClassName}>
        <div className={`rounded-2xl border border-border/40 bg-muted/20 px-3 pt-3 ${chartHeight}`}>
          <div className="flex h-full items-end gap-1.5 sm:gap-2">
            {Array.from({ length: 12 }).map((_, index) => (
              <Skeleton
                key={index}
                className="dashboard-motion-item w-full rounded-full"
                style={{
                  ["--dashboard-motion-delay" as string]: `${240 + index * 35}ms`,
                  height: `${28 + ((index * 11) % 50)}%`,
                }}
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
            className="dashboard-motion-item rounded-xl border px-3 py-2 md:grid md:grid-cols-[minmax(0,1fr)_auto_auto_auto] md:items-center md:gap-2"
            style={{ ["--dashboard-motion-delay" as string]: `${250 + index * 45}ms` }}
          >
            <div className="grid gap-1.5 md:hidden">
              <div className="min-w-0 space-y-1.5 pr-6">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-3 w-10" />
                </div>
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-3 w-10" />
                </div>
              </div>
              <div className="flex items-center justify-between gap-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            </div>
            <div className="hidden min-w-0 space-y-2 md:block">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-24" />
            </div>
            <div className="hidden space-y-2 md:block md:text-right">
              <Skeleton className="h-4 w-20 md:ml-auto" />
              <Skeleton className="h-3 w-12 md:ml-auto" />
            </div>
            <div className="hidden space-y-2 md:block md:text-right">
              <Skeleton className="h-4 w-16 md:ml-auto" />
              <Skeleton className="h-3 w-12 md:ml-auto" />
            </div>
            <div className="hidden items-center justify-end gap-2 md:flex">
              <Skeleton className="h-6 w-20 rounded-full" />
              <Skeleton className="h-4 w-4 rounded-full" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function HealthPanelSkeleton() {
  return (
    <Card className="dashboard-motion-item" style={{ ["--dashboard-motion-delay" as string]: "330ms" }}>
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
    <Card className="dashboard-motion-item" style={{ ["--dashboard-motion-delay" as string]: "390ms" }}>
      <CardHeader className="gap-1 pb-2 md:px-4">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-2 md:px-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-xl border p-3 space-y-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-[92%]" />
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
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
    <DashboardPage className="dashboard-motion-stage space-y-6">
      <div className="dashboard-motion-item">
        <OverviewHeaderSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-1">
        <OverviewMetricCardsSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-2">
        <OverviewUsageChartSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-3">
        <OverviewRecentActivitySkeleton rows={4} />
      </div>
    </DashboardPage>
  )
}

function DashboardAnalyticsSkeleton() {
  return (
    <DashboardPage className="dashboard-motion-stage space-y-4 md:space-y-5">
      <div className="dashboard-motion-item">
        <AnalyticsHeaderSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-1">
        <AnalyticsMetricCardsSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-2 grid gap-3 xl:grid-cols-2">
        <ChartCardSkeleton chartHeight="h-[252px] sm:h-[272px]" contentClassName="px-1.5 pt-3 pb-0 sm:px-4 sm:pt-3 sm:pb-1 md:px-3" />
        <ChartCardSkeleton chartHeight="h-[240px] sm:h-[260px]" contentClassName="px-1.5 pt-3 sm:px-4 sm:pt-3 md:px-3" />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-3">
        <ChartCardSkeleton chartHeight="h-[240px] sm:h-[260px]" rangeWidth="w-32" contentClassName="px-1.5 pt-3 sm:px-4 sm:pt-3 md:px-3" />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-4 grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)] xl:items-start">
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
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <ActivityHeaderSkeleton />
      </div>
      <div className="dashboard-motion-item dashboard-motion-delay-1 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-[4.5rem] rounded-full" />
        </div>
        <Skeleton className="h-4 w-24" />
      </div>
      <Card className="dashboard-motion-item dashboard-motion-delay-2 py-0">
        <CardContent className="p-0">
          <ul className="divide-y">
            {Array.from({ length: 8 }).map((_, index) => (
              <li
                key={index}
                className="dashboard-motion-item"
                style={{ ["--dashboard-motion-delay" as string]: `${260 + index * 55}ms` }}
              >
                <div className="px-4 pt-2.5 pb-0 md:px-0 md:pt-3 md:pb-3">
                  <div className="grid gap-3 xl:grid-cols-[148px_minmax(0,1fr)_196px_auto] xl:items-start">
                    <div className="text-sm">
                      <div className="flex items-center justify-between gap-3 xl:block">
                        <div>
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="mt-1 h-3 w-28" />
                        </div>
                        <div className="flex flex-wrap gap-2 xl:hidden">
                          <Skeleton className="h-6 w-20 rounded-full" />
                          <Skeleton className="h-6 w-24 rounded-full" />
                        </div>
                      </div>
                      <Skeleton className="mt-2 hidden h-3 w-24 xl:block" />
                    </div>
                    <div className="min-w-0">
                      <Skeleton className="h-4 w-[82%]" />
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Skeleton className="h-3 w-20" />
                        <Skeleton className="hidden h-3 w-2 xl:block" />
                        <Skeleton className="h-3 w-16" />
                      </div>
                      <Skeleton className="mt-1 h-3 w-[70%]" />
                      <div className="mt-0 flex items-center justify-between gap-1.5 xl:hidden">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <Skeleton className="h-3 w-16" />
                          <Skeleton className="h-2 w-2 rounded-full" />
                          <Skeleton className="h-3 w-28" />
                        </div>
                        <Skeleton className="h-6 w-6 rounded-full" />
                      </div>
                    </div>
                    <div className="hidden min-w-0 text-sm xl:block">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="mt-1 h-3 w-36" />
                      <Skeleton className="mt-1 h-3 w-24" />
                    </div>
                    <div className="flex items-center justify-between gap-3 xl:flex-col xl:items-end xl:justify-start">
                      <div className="hidden flex-wrap justify-end gap-2 xl:flex">
                        <Skeleton className="h-6 w-[4.5rem] rounded-full" />
                        <Skeleton className="h-6 w-24 rounded-full" />
                      </div>
                      <Skeleton className="hidden h-8 w-8 rounded-full xl:block" />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
        <div className="border-t px-4 pb-4 pt-2.5 md:p-4">
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div className="justify-self-start">
              <Skeleton className="h-8 w-8 rounded-full md:hidden" />
              <Skeleton className="hidden h-9 w-24 rounded-full md:block" />
            </div>
            <div className="justify-self-center">
              <div className="flex justify-center gap-1.5 md:hidden">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-8 rounded-full" />
                ))}
              </div>
              <div className="hidden justify-center gap-1.5 md:flex">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-8 w-8 rounded-full" />
                ))}
              </div>
            </div>
            <div className="justify-self-end">
              <Skeleton className="h-8 w-8 rounded-full md:hidden" />
              <Skeleton className="hidden h-9 w-20 rounded-full md:block" />
            </div>
          </div>
        </div>
      </Card>
    </DashboardPage>
  )
}

function AccountsPageSkeleton() {
  return (
    <DashboardPage className="space-y-4 md:space-y-5">
      <div>
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-4 w-56" />
          </div>
          <div className="flex w-full items-center gap-2 sm:w-auto sm:flex-wrap sm:justify-end">
            <Skeleton className="h-9 min-w-0 flex-1 rounded-full sm:w-[220px] sm:flex-none" />
            <Skeleton className="h-9 w-9 rounded-full" />
            <Skeleton className="h-9 w-9 rounded-full sm:hidden" />
            <Skeleton className="hidden h-9 w-28 rounded-full sm:block" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="gap-0 py-0">
            <CardHeader className="px-4 py-3 pb-1.5 lg:px-4 lg:py-3 lg:pb-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-7 w-14 sm:h-8" />
            </CardHeader>
            <CardContent className="px-4 pb-3 pt-0 lg:px-4 lg:pb-3">
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="overflow-hidden gap-0 sm:gap-0 md:gap-0">
        <div className="sm:hidden">
          <div className="overflow-hidden">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[240px_220px_120px_140px_130px_170px] border-b">
                {["Account", "Email", "Status", "Added", "Usage", "Actions"].map((label) => (
                  <div key={label} className="relative px-2 py-2 text-center">
                    <Skeleton className="mx-auto h-3 w-14" />
                    {label !== "Actions" ? (
                      <span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" />
                    ) : null}
                  </div>
                ))}
              </div>
              {Array.from({ length: 6 }).map((_, rowIndex) => (
                <div
                  key={rowIndex}
                  className="grid grid-cols-[240px_220px_120px_140px_130px_170px] border-b last:border-b-0"
                >
                  <div className="relative flex min-h-[64px] items-center px-2.5 py-2">
                    <div className="flex min-h-[40px] w-full items-center gap-3">
                      <Skeleton className="h-7 w-7 rounded-lg" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-28" />
                      </div>
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <Skeleton className="h-4 w-32" />
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <Skeleton className="h-6 w-16 rounded-full" />
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <div className="space-y-1.5 text-center">
                      <Skeleton className="h-4 w-20" />
                      <Skeleton className="h-3 w-16" />
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <div className="space-y-1.5 text-center">
                      <Skeleton className="h-4 w-[4.5rem]" />
                      <Skeleton className="h-3 w-14" />
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="flex min-h-[64px] items-center justify-center gap-1.5 px-2.5 py-2">
                    {Array.from({ length: 4 }).map((_, actionIndex) => (
                      <Skeleton key={actionIndex} className="h-7 w-7 rounded-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground max-sm:-mb-2">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Skeleton className="h-8 w-8 justify-self-start rounded-full" />
              <div className="flex items-center justify-center gap-1 justify-self-center">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-[1.875rem] w-[1.875rem] rounded-full" />
                ))}
              </div>
              <Skeleton className="h-8 w-8 justify-self-end rounded-full" />
            </div>
          </div>
        </div>

        <div className="hidden sm:block">
          <div className="overflow-hidden">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[240px_220px_120px_140px_130px_170px] border-b">
                {["Account", "Email", "Status", "Added", "Usage", "Actions"].map((label) => (
                  <div key={label} className="relative px-2.5 py-2 text-center">
                    <Skeleton className="mx-auto h-3 w-16" />
                    {label !== "Actions" ? (
                      <span className="absolute right-0 top-1/2 h-6 w-px -translate-y-1/2 bg-border" />
                    ) : null}
                  </div>
                ))}
              </div>
              {Array.from({ length: 8 }).map((_, rowIndex) => (
                <div
                  key={rowIndex}
                  className="grid grid-cols-[240px_220px_120px_140px_130px_170px] border-b last:border-b-0"
                >
                  <div className="relative flex min-h-[64px] items-center px-2.5 py-2">
                    <div className="flex min-h-[40px] w-full items-center gap-3">
                      <Skeleton className="h-7 w-7 rounded-lg" />
                      <Skeleton className="h-4 w-28" />
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <Skeleton className="h-4 w-36" />
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <Skeleton className="h-6 w-[4.5rem] rounded-full" />
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <div className="space-y-1 text-center">
                      <Skeleton className="mx-auto h-4 w-20" />
                      <Skeleton className="mx-auto h-3 w-16" />
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="relative flex min-h-[64px] items-center justify-center px-2.5 py-2">
                    <div className="space-y-1 text-center">
                      <Skeleton className="mx-auto h-4 w-16" />
                      <Skeleton className="mx-auto h-3 w-14" />
                    </div>
                    <span className="absolute right-0 top-1/2 h-8 w-px -translate-y-1/2 bg-border" />
                  </div>
                  <div className="flex min-h-[64px] items-center justify-center gap-1.5 px-2.5 py-2">
                    {Array.from({ length: 5 }).map((_, actionIndex) => (
                      <Skeleton key={actionIndex} className="h-7 w-7 rounded-full" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Skeleton className="h-8 w-24 justify-self-start rounded-full" />
              <div className="flex items-center justify-center gap-1 justify-self-center">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-[1.875rem] w-[1.875rem] rounded-full" />
                ))}
              </div>
              <Skeleton className="h-8 w-20 justify-self-end rounded-full" />
            </div>
          </div>
        </div>
      </Card>
      <div className="text-center text-xs text-muted-foreground">
        <Skeleton className="mx-auto h-3 w-20" />
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
  AccountsPageSkeleton,
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

"use client"

import * as React from "react"
import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts"
import {
  ArrowRight,
  HardDrive,
  Server,
  Database,
  Activity,
  TrendingUp,
  Users,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import Link from "next/link"

type ActiveAccount = {
  id: string
  label: string
  email: string
  status: "active" | "available" | "disabled"
}

const generateData = (days: number, startValue: number) => {
  const data = []
  for (let i = 0; i < days; i++) {
    const date = new Date()
    date.setDate(date.getDate() - (days - 1 - i))
    data.push({
      date: date.toISOString().split("T")[0],
      bandwidth: Math.floor(startValue + Math.random() * 50 - 20 + i * 2),
      requests: Math.floor(startValue * 10 + Math.random() * 500 - 200 + i * 10),
    })
  }
  return data
}

const chartConfig = {
  bandwidth: {
    label: "Bandwidth (GB)",
    color: "hsl(var(--chart-1))",
  },
  requests: {
    label: "Requests (10k)",
    color: "hsl(var(--chart-2))",
  },
} satisfies ChartConfig

export default function DashboardPage() {
  const [timeRange, setTimeRange] = React.useState("7d")
  const [mounted, setMounted] = React.useState(false)
  const [activeAccount, setActiveAccount] = React.useState<ActiveAccount | null>(
    null
  )

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    const loadActive = async () => {
      try {
        const res = await fetch("/api/accounts")
        if (!res.ok) return
        const data = await res.json()
        const accounts: any[] = data.accounts ?? []
        const active = accounts.find((a) => a.status === "active")
        if (active) {
          setActiveAccount({
            id: active.id,
            label: active.label ?? "",
            email: active.email ?? "",
            status: active.status ?? "available",
          })
        } else {
          setActiveAccount(null)
        }
      } catch {
        // ignore
      }
    }

    loadActive()
  }, [])

  const chartData = React.useMemo(() => {
    switch (timeRange) {
      case "30d":
        return generateData(30, 200)
      case "90d":
        return generateData(90, 150)
      case "7d":
      default:
        return generateData(7, 100)
    }
  }, [timeRange])

  if (!mounted) {
    return null
  }

  return (
    <div className="flex flex-1 flex-col gap-4 pt-0">
      <div className="flex items-center justify-between space-y-2">
        <h2 className="text-3xl font-bold tracking-tight">Overview</h2>
        <div className="flex items-center space-x-2">
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="w-[160px] rounded-lg sm:ml-auto" aria-label="Select a value">
              <SelectValue placeholder="Last 7 days" />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="7d" className="rounded-lg">
                Last 7 days
              </SelectItem>
              <SelectItem value="30d" className="rounded-lg">
                Last 30 days
              </SelectItem>
              <SelectItem value="90d" className="rounded-lg">
                Last 3 months
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {activeAccount && (
        <div className="text-xs text-muted-foreground">
          Active account:{" "}
          <span className="font-medium text-foreground">
            {activeAccount.label || activeAccount.email || "Unnamed"}
          </span>{" "}
          <span className="font-mono break-all ml-1">{activeAccount.email}</span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Storage</CardTitle>
            <HardDrive className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">24.5 TB</div>
            <p className="text-xs text-muted-foreground">+2.1% from last month</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Objects</CardTitle>
            <Database className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">145.2M</div>
            <p className="text-xs text-muted-foreground">+12% from last month</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Accounts</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">4</div>
            <p className="text-xs text-muted-foreground">1 account in migration</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Active Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">32</div>
            <p className="text-xs text-muted-foreground">+3 since last week</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-7">
        <Card className="col-span-4">
          <CardHeader>
            <CardTitle>Bandwidth Usage</CardTitle>
            <CardDescription>
              Data transfer across all buckets over time.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={chartConfig} className="aspect-auto h-[310px] w-full">
              <AreaChart
                data={chartData}
                margin={{
                  left: 12,
                  right: 12,
                }}
              >
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={32}
                  tickFormatter={(value) => {
                    const date = new Date(value)
                    return date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })
                  }}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => {
                        return new Date(value).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })
                      }}
                      indicator="dot"
                    />
                  }
                />
                <Area
                  dataKey="requests"
                  type="natural"
                  fill="var(--color-requests)"
                  fillOpacity={0.1}
                  stroke="var(--color-requests)"
                  stackId="a"
                />
                <Area
                  dataKey="bandwidth"
                  type="natural"
                  fill="var(--color-bandwidth)"
                  fillOpacity={0.4}
                  stroke="var(--color-bandwidth)"
                  stackId="a"
                />
              </AreaChart>
            </ChartContainer>
          </CardContent>
          <CardFooter>
            <div className="flex w-full items-start gap-2 text-sm">
              <div className="grid gap-2">
                <div className="flex items-center gap-2 font-medium leading-none">
                  Trending up by 5.2% this month <TrendingUp className="h-4 w-4" />
                </div>
                <div className="flex items-center gap-2 leading-none text-muted-foreground">
                  Showing total bandwidth usage for the last{" "}
                  {timeRange === "7d"
                    ? "7 days"
                    : timeRange === "30d"
                    ? "30 days"
                    : "3 months"}
                </div>
              </div>
            </div>
          </CardFooter>
        </Card>

        <Card className="col-span-3">
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest system events and migrations.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-8">
              <div className="flex items-center">
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">Migration Completed</p>
                  <p className="text-sm text-muted-foreground">
                    Moved 5.2TB from <strong>R2-Old-04</strong> to <strong>R2-Prod-01</strong>.
                  </p>
                </div>
                <div className="ml-auto font-medium text-xs text-muted-foreground">2h ago</div>
              </div>
              <div className="flex items-center">
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">Bucket Created</p>
                  <p className="text-sm text-muted-foreground">
                    New bucket <code>assets-v2</code> created in prod.
                  </p>
                </div>
                <div className="ml-auto font-medium text-xs text-muted-foreground">5h ago</div>
              </div>
              <div className="flex items-center">
                <div className="space-y-1">
                  <p className="text-sm font-medium leading-none">Quota Warning</p>
                  <p className="text-sm text-muted-foreground">
                    Account <strong>R2-Prod-01</strong> approaching 80% capacity.
                  </p>
                </div>
                <div className="ml-auto font-medium text-xs text-muted-foreground">1d ago</div>
              </div>
              <div className="flex items-center pt-4">
                <Button asChild variant="outline" className="w-full">
                  <Link href="/migrations">
                    View All Activity <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

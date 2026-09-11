"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CircleCheck,
  Clock3,
  Files,
  RefreshCw,
  Server,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";

import {
  DashboardPage,
  DashboardPageHeader,
} from "@/components/dashboard/page-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type WorkerRun = { id: string; online: boolean };
type WorkerJob = {
  id: string;
  status: string;
  claimedByAgentId?: string;
  claimed_by_agent_id?: string;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
};
type BucketStat = {
  id: string;
  sourceBucket: string;
  targetBucket: string;
  status: string;
  totalObjects: number;
  transferredObjects: number;
  failedObjects: number;
  sourceBytes: number;
};
type PoolSnapshot = {
  onlineWorkers?: number;
  activeTransfers?: number;
  totalJobs?: number;
  queuedJobs?: number;
  runningJobs?: number;
  completedJobs?: number;
  failedJobs?: number;
  canceledJobs?: number;
  totalObjects?: number;
  transferred?: number;
  processedFiles?: number;
  completedBytes?: number;
  buckets?: BucketStat[];
  updatedAt?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function num(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function formatNumber(value: number) {
  return new Intl.NumberFormat().format(Math.max(0, value));
}
function formatDate(value?: string) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function formatBytes(value: number) {
  if (value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}
function percentage(done: number, total: number) {
  return total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
}

function statusBadge(status?: string) {
  const value = String(status || "").toLowerCase();
  if (["completed", "copied", "verified"].includes(value))
    return <Badge>Completed</Badge>;
  if (["running", "copying", "transferring"].includes(value))
    return <Badge>Transferring</Badge>;
  if (["scanning", "verifying"].includes(value))
    return (
      <Badge variant="secondary">
        {value === "scanning" ? "Scanning" : "Verifying"}
      </Badge>
    );
  if (["pending", "queued", "claimed"].includes(value))
    return <Badge variant="outline">Queued</Badge>;
  if (value === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (["canceled", "aborted"].includes(value))
    return <Badge variant="outline">Canceled</Badge>;
  return <Badge variant="outline">{value || "Pending"}</Badge>;
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-4 py-3 pb-1.5">
        <div className="flex items-center justify-between gap-3">
          <CardDescription className="text-[13px] leading-4">
            {label}
          </CardDescription>
          <Icon className="size-4 text-muted-foreground" />
        </div>
        <CardTitle className="text-xl font-bold leading-none tabular-nums sm:text-2xl">
          {value}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        <p className="text-[11px] leading-4 text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <DashboardPage>
      <div className="flex flex-col gap-5">
        <Skeleton className="h-16 w-full" />
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-80" />
      </div>
    </DashboardPage>
  );
}

export default function MigrationWorkerPoolDetailsPage() {
  const params = useParams<{ id: string }>();
  const migrationId = typeof params?.id === "string" ? params.id : "";
  const [runs, setRuns] = React.useState<WorkerRun[]>([]);
  const [jobs, setJobs] = React.useState<WorkerJob[]>([]);
  const [snapshot, setSnapshot] = React.useState<PoolSnapshot>({});
  const [source, setSource] = React.useState<"database" | "orchestrator">(
    "database",
  );
  const [liveWarning, setLiveWarning] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);

  const load = React.useCallback(
    async (live = false, showRefreshing = false) => {
      if (!migrationId) return;
      try {
        if (showRefreshing) setRefreshing(true);
        else if (!live) setLoading(true);
        const response = await fetch(
          `/api/migrations/${encodeURIComponent(migrationId)}/worker-pool${live ? "?live=1" : ""}`,
          { cache: "no-store" },
        );
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(data.error || "Unable to load migration worker job");
        setRuns(Array.isArray(data.runs) ? data.runs : []);
        setJobs(Array.isArray(data.jobs) ? data.jobs : []);
        setSnapshot(
          isRecord(data.snapshot) ? (data.snapshot as PoolSnapshot) : {},
        );
        setSource(data.source === "orchestrator" ? "orchestrator" : "database");
        setLiveWarning(
          typeof data.liveWarning === "string" ? data.liveWarning : "",
        );
      } catch (error) {
        if (!live)
          toast.error(
            error instanceof Error
              ? error.message
              : "Unable to load migration worker job",
          );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [migrationId],
  );

  React.useEffect(() => {
    void load(false).then(() => void load(true));
  }, [load]);
  React.useEffect(() => {
    if (loading) return;
    const online =
      num(snapshot.onlineWorkers) > 0 || runs.some((run) => run.online);
    const timer = window.setTimeout(
      () => void load(true),
      online ? 2500 : 15000,
    );
    return () => window.clearTimeout(timer);
  }, [loading, load, runs, snapshot.onlineWorkers]);

  const telemetry = React.useMemo(() => {
    const files: Array<Record<string, unknown>> = [];
    const logs: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const events = Array.isArray(job.progress?.fileEvents)
        ? job.progress.fileEvents
        : Array.isArray(job.result?.fileEvents)
          ? job.result.fileEvents
          : [];
      for (const entry of events)
        if (isRecord(entry))
          files.push({
            ...entry,
            workerId: job.claimedByAgentId || job.claimed_by_agent_id || "-",
          });
      const entries = Array.isArray(job.progress?.logs)
        ? job.progress.logs
        : [];
      for (const entry of entries) if (isRecord(entry)) logs.push(entry);
    }
    files.sort((a, b) =>
      String(b.updatedAt || b.completedAt || b.startedAt || "").localeCompare(
        String(a.updatedAt || a.completedAt || a.startedAt || ""),
      ),
    );
    logs.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    return { files, logs };
  }, [jobs]);

  if (loading) return <PageSkeleton />;

  const totalJobs = num(snapshot.totalJobs);
  const queuedJobs = num(snapshot.queuedJobs);
  const runningJobs = num(snapshot.runningJobs);
  const completedJobs = num(snapshot.completedJobs);
  const failedJobs = num(snapshot.failedJobs);
  const canceledJobs = num(snapshot.canceledJobs);
  const totalObjects = num(snapshot.totalObjects);
  const transferredFiles = num(snapshot.transferred || snapshot.completedJobs);
  const processedFiles = num(snapshot.processedFiles);
  const onlineWorkers = num(snapshot.onlineWorkers);
  const activeTransfers = num(snapshot.activeTransfers);
  const overallPercent = percentage(processedFiles, totalJobs);
  const buckets = Array.isArray(snapshot.buckets) ? snapshot.buckets : [];

  return (
    <DashboardPage className="dashboard-motion-stage">
      <div className="dashboard-motion-item">
        <DashboardPageHeader
          title="Migration worker job"
          description={`Last synced ${formatDate(snapshot.updatedAt)}`}
          actions={
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                asChild
                variant="outline"
                size="sm"
                className="flex-1 rounded-xl sm:flex-none"
              >
                <Link
                  href={`/dashboard/migrations/${encodeURIComponent(migrationId)}`}
                >
                  <ArrowLeft data-icon="inline-start" />
                  Back
                </Link>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 rounded-xl sm:flex-none"
                onClick={() => void load(true, true)}
                disabled={refreshing}
              >
                <RefreshCw
                  data-icon="inline-start"
                  className={refreshing ? "animate-spin" : undefined}
                />
                Refresh
              </Button>
            </div>
          }
        />
      </div>

      {liveWarning ? (
        <Alert className="dashboard-motion-item">
          <Server />
          <AlertTitle>Showing the last synced state</AlertTitle>
          <AlertDescription>
            The Migration Orchestrator is temporarily unavailable. Saved
            progress remains visible and live refresh will retry automatically.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="dashboard-motion-item dashboard-motion-delay-1 grid grid-cols-2 gap-4 xl:grid-cols-4">
        <MetricCard
          label="Migration objects"
          value={formatNumber(totalObjects)}
          detail={`${formatNumber(buckets.length)} buckets in this migration`}
          icon={Files}
        />
        <MetricCard
          label="Job queue"
          value={formatNumber(totalJobs)}
          detail={`${formatNumber(queuedJobs)} queued · ${formatNumber(runningJobs)} running`}
          icon={Clock3}
        />
        <MetricCard
          label="Transferred files"
          value={formatNumber(transferredFiles)}
          detail={`${formatBytes(num(snapshot.completedBytes))} transferred`}
          icon={CircleCheck}
        />
        <MetricCard
          label="Online workers"
          value={formatNumber(onlineWorkers)}
          detail={`${formatNumber(activeTransfers)} active transfers`}
          icon={Workflow}
        />
      </div>

      <div className="dashboard-motion-item dashboard-motion-delay-2 grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,0.45fr)]">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle className="text-base">Overall progress</CardTitle>
                <CardDescription>
                  Object migration and durable queue completion.
                </CardDescription>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  variant={source === "orchestrator" ? "default" : "outline"}
                >
                  {source === "orchestrator" ? "Live" : "Saved"}
                </Badge>
                <span className="font-mono text-sm font-semibold tabular-nums">
                  {overallPercent.toFixed(1)}%
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5 px-4 py-5 sm:px-5">
            <Progress value={overallPercent} className="h-2.5" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Processed</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {formatNumber(processedFiles)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Completed</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {formatNumber(completedJobs)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Failed</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {formatNumber(failedJobs)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Canceled</p>
                <p className="mt-1 text-lg font-semibold tabular-nums">
                  {formatNumber(canceledJobs)}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="gap-0 py-0">
          <CardHeader className="border-b px-4 py-4">
            <CardTitle className="text-base">Live activity</CardTitle>
            <CardDescription>Current orchestrator capacity.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 px-4 py-4 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Online workers</span>
              <span className="font-semibold tabular-nums">
                {formatNumber(onlineWorkers)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Active transfers</span>
              <span className="font-semibold tabular-nums">
                {formatNumber(activeTransfers)}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Queue remaining</span>
              <span className="font-semibold tabular-nums">
                {formatNumber(queuedJobs + runningJobs)}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Last update</span>
              <span className="text-right text-xs">
                {formatDate(snapshot.updatedAt)}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-4 sm:px-5">
          <CardTitle className="text-base">Bucket progress</CardTitle>
          <CardDescription>
            Transfer completion and object totals for every bucket.
          </CardDescription>
        </CardHeader>
        <Table className="min-w-[820px]">
          <TableHeader>
            <TableRow className="h-9">
              <TableHead>Source bucket</TableHead>
              <TableHead>Target bucket</TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-center">Objects</TableHead>
              <TableHead className="min-w-[190px]">Progress</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.length ? (
              buckets.map((bucket) => {
                const value = percentage(
                  num(bucket.transferredObjects),
                  num(bucket.totalObjects),
                );
                return (
                  <TableRow
                    key={bucket.id}
                    className="h-[64px] hover:bg-muted/30"
                  >
                    <TableCell>
                      <div className="font-medium">{bucket.sourceBucket}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatBytes(num(bucket.sourceBytes))}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {bucket.targetBucket}
                    </TableCell>
                    <TableCell className="text-center">
                      {statusBadge(bucket.status)}
                    </TableCell>
                    <TableCell className="text-center tabular-nums">
                      {formatNumber(num(bucket.transferredObjects))} /{" "}
                      {formatNumber(num(bucket.totalObjects))}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1.5">
                        <Progress value={value} className="h-2" />
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>{value.toFixed(1)}%</span>
                          <span>
                            {formatNumber(num(bucket.failedObjects))} failed
                          </span>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-24 text-center text-muted-foreground"
                >
                  Bucket statistics are not available yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <Card className="dashboard-motion-item dashboard-motion-delay-2 gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle className="text-base">File transfers</CardTitle>
              <CardDescription>
                Latest synchronized transfer state from the worker pool.
              </CardDescription>
            </div>
            <Badge variant="outline">
              {formatNumber(telemetry.files.length)} visible
            </Badge>
          </div>
        </CardHeader>
        <Table
          className="table-fixed min-w-[1310px] w-full [&_th:not(:last-child)]:border-r [&_td:not(:last-child)]:border-r"
          containerClassName="h-[560px] rounded-none"
        >
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="h-9">
              <TableHead className="w-[360px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                File
              </TableHead>
              <TableHead className="w-[180px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Bucket
              </TableHead>
              <TableHead className="w-[170px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Worker ID
              </TableHead>
              <TableHead className="w-[110px] px-2.5 text-center text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="w-[110px] px-2.5 text-center text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Size
              </TableHead>
              <TableHead className="w-[200px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Progress
              </TableHead>
              <TableHead className="w-[180px] px-2.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Error
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {telemetry.files.length ? (
              telemetry.files.map((file, index) => {
                const total = num(file.bytesTotal || file.size);
                const loaded = num(
                  file.bytesTransferred ||
                    (["copied", "completed"].includes(String(file.status))
                      ? total
                      : 0),
                );
                const value = percentage(loaded, total);
                return (
                  <TableRow
                    key={`${String(file.itemId || "")}:${String(file.key || "")}:${index}`}
                    className="h-[64px] hover:bg-muted/30"
                  >
                    <TableCell className="px-2.5 py-2">
                      <div
                        className="truncate font-mono text-xs"
                        title={String(file.key || "")}
                      >
                        {String(file.key || "-")}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {formatDate(
                          typeof file.updatedAt === "string"
                            ? file.updatedAt
                            : typeof file.completedAt === "string"
                              ? file.completedAt
                              : undefined,
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-xs">
                      <div
                        className="truncate"
                        title={String(file.bucket || file.sourceBucket || "-")}
                      >
                        {String(file.bucket || file.sourceBucket || "-")}
                      </div>
                    </TableCell>
                    <TableCell className="px-2.5 py-2">
                      <div
                        className="truncate font-mono text-[11px] text-muted-foreground"
                        title={String(file.workerId || "-")}
                      >
                        {String(file.workerId || "-")}
                      </div>
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-center">
                      {statusBadge(
                        typeof file.status === "string"
                          ? file.status
                          : undefined,
                      )}
                    </TableCell>
                    <TableCell className="px-2.5 py-2 text-center text-xs tabular-nums">
                      {formatBytes(num(file.size || total))}
                    </TableCell>
                    <TableCell className="px-2.5 py-2">
                      <div className="flex flex-col gap-1.5">
                        <Progress value={value} className="h-2" />
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>{value.toFixed(1)}%</span>
                          <span>
                            {formatBytes(loaded)} / {formatBytes(total)}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell
                      className="truncate px-2.5 py-2 text-xs text-destructive"
                      title={String(file.error || "")}
                    >
                      {String(file.error || "-")}
                    </TableCell>
                  </TableRow>
                );
              })
            ) : (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="h-24 text-center text-muted-foreground"
                >
                  File activity will appear when the worker pool starts
                  transferring objects.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      {telemetry.logs.length ? (
        <Card className="dashboard-motion-item dashboard-motion-delay-2 gap-0 py-0">
          <CardHeader className="border-b px-4 py-4 sm:px-5">
            <CardTitle className="text-base">Recent worker messages</CardTitle>
            <CardDescription>
              Concise operational messages from the current migration.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-80 flex-col gap-2 overflow-auto px-4 py-4">
            {telemetry.logs.slice(0, 50).map((entry, index) => (
              <div
                key={`${String(entry.at || "")}-${index}`}
                className="flex flex-col gap-1 rounded-lg border bg-muted/20 px-3 py-2"
              >
                <div className="text-xs font-medium">
                  {String(entry.message || "-")}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {formatDate(
                    typeof entry.at === "string" ? entry.at : undefined,
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </DashboardPage>
  );
}

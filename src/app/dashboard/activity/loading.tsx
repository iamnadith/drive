import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={1} columns={6} filters={4} rows={8} titleWidth="w-36" />
}

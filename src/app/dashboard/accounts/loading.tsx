import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={2} columns={6} filters={1} rows={10} titleWidth="w-36" />
}

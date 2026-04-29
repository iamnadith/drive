import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={1} columns={5} filters={1} rows={8} titleWidth="w-48" />
}

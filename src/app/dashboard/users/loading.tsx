import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={1} columns={5} filters={3} rows={10} titleWidth="w-28" />
}

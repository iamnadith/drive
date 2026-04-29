import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={2} columns={4} rows={7} titleWidth="w-40" />
}

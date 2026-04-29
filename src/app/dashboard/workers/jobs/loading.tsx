import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton cards={3} columns={5} rows={8} titleWidth="w-44" />
}

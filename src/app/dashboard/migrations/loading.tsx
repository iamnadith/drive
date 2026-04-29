import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={2} cards={0} columns={5} rows={8} titleWidth="w-44" />
}

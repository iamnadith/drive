import { DashboardTableSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <DashboardTableSkeleton actions={4} columns={4} rows={6} titleWidth="w-52" />
}

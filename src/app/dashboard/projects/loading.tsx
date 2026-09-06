import { ProjectTablePageSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <ProjectTablePageSkeleton actions={3} columns={7} rows={7} titleWidth="w-32" />
}

import { ProjectTablePageSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <ProjectTablePageSkeleton actions={5} columns={5} rows={6} titleWidth="w-56" />
}

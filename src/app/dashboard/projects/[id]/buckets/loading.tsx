import { ProjectTablePageSkeleton } from "@/components/dashboard/loading-skeletons"

export default function Loading() {
  return <ProjectTablePageSkeleton actions={4} columns={4} rows={6} titleWidth="w-52" />
}

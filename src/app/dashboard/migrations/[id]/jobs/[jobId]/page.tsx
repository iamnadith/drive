import { redirect } from "next/navigation"

export default async function LegacyMigrationWorkerJobPage({
  params,
}: {
  params: Promise<{ id: string; jobId: string }>
}) {
  const { id } = await params
  redirect(`/dashboard/migrations/${encodeURIComponent(id)}/worker-pool`)
}

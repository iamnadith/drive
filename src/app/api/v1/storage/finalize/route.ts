import { completeProjectUpload } from "@/lib/project-upload-api"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return completeProjectUpload(request, body)
}

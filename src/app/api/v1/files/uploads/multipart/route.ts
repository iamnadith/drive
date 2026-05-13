import { startProjectUpload } from "@/lib/project-upload-api"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return startProjectUpload(request, body, { forceMultipart: true })
}

import { NextResponse } from "next/server"
import { completeProjectUpload, startProjectUpload } from "@/lib/project-upload-api"

export const runtime = "nodejs"
export const maxDuration = 300

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json(
      {
        error:
          "Upload now uses direct R2 transfer. Send JSON to create a signed upload URL, then upload directly to R2.",
      },
      { status: 400 }
    )
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return startProjectUpload(request, body)
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  return completeProjectUpload(request, body)
}

import { NextResponse } from "next/server"

export type ProjectObjectLockDetails = {
  reason?: string | null
  expiresAt?: string | null
  createdAt?: string | null
}

export class ProjectObjectLockedError extends Error {
  readonly reason: string | null
  readonly expiresAt: string | null
  readonly createdAt: string | null

  constructor(details: ProjectObjectLockDetails = {}) {
    super("Object is locked")
    this.name = "ProjectObjectLockedError"
    this.reason = details.reason ?? null
    this.expiresAt = details.expiresAt ?? null
    this.createdAt = details.createdAt ?? null
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export function isProjectObjectLockedError(
  error: unknown
): error is ProjectObjectLockedError {
  return error instanceof ProjectObjectLockedError
}

export type ProjectObjectLockCheckTarget = {
  operation: string
  projectId: string
  bucketName: string
  key: string
}

export function projectObjectLockResponse(
  error: unknown,
  target: ProjectObjectLockCheckTarget
) {
  if (isProjectObjectLockedError(error)) {
    return NextResponse.json(
      {
        error: "Object is locked",
        code: "OBJECT_LOCKED",
        ...(error.reason ? { reason: error.reason } : {}),
        ...(error.expiresAt ? { expiresAt: error.expiresAt } : {}),
        ...(error.createdAt ? { createdAt: error.createdAt } : {}),
      },
      { status: 409, headers: { "Cache-Control": "no-store" } }
    )
  }

  console.error("Project object lock check failed", {
    ...target,
    error: error instanceof Error
      ? { name: error.name, message: error.message }
      : String(error),
  })

  return NextResponse.json(
    {
      error: "Unable to verify object lock",
      code: "LOCK_CHECK_UNAVAILABLE",
    },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "5",
      },
    }
  )
}

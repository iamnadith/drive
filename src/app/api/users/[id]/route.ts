import { NextResponse } from "next/server"
import {
  PublicUser,
  deleteUser,
  findUserById,
  getAllUsers,
  hashPassword,
  toPublicUser,
  updateUser,
} from "@/lib/users-store"
import { cookies } from "next/headers"
import { getRequestActivityContext, recordActivity } from "@/lib/activity-store"

function errorMessage(error: unknown, fallback: string) {
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? fallback)
    : fallback
}

type RouteParams = {
  params: Promise<{
    id: string
  }>
}

export async function GET(_: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const user = await findUserById(id)
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }
    const publicUser: PublicUser = toPublicUser(user)
    return NextResponse.json({ user: publicUser })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to fetch user")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  try {
    const { id: targetId } = await params

    const allBefore = await getAllUsers()
    const targetBefore = allBefore.find((u) => u.id === targetId)
    if (!targetBefore) {
      return NextResponse.json({ error: "User not found" }, { status: 404 })
    }

    const cookieStore = await cookies()
    const actorId = cookieStore.get("sessionUserId")?.value
    const actor = actorId ? allBefore.find((u) => u.id === actorId) : undefined

    const body = await request.json()

    const {
      name,
      username,
      email,
      role,
      status,
      quotaLimitMb,
      quotaUsedMb,
      profileImageUrl,
      password,
      googleLinked,
    } = body as {
      name?: string
      username?: string
      email?: string
      role?: "superadmin" | "admin" | "user"
      status?: "active" | "disabled"
      quotaLimitMb?: number
      quotaUsedMb?: number
      profileImageUrl?: string
      password?: string
      googleLinked?: boolean
    }

    const updates: Parameters<typeof updateUser>[1] = {}

    if (name !== undefined) updates.name = name
    if (username !== undefined) updates.username = username
    if (email !== undefined) {
      updates.email = email
      if (email.trim().toLowerCase() !== targetBefore.email.toLowerCase()) {
        updates.googleLinked = false
        updates.googleSub = undefined
        updates.emailVerified = false
        updates.emailVerifiedAt = undefined
      }
    }
    if (profileImageUrl !== undefined) updates.profileImageUrl = profileImageUrl

    if (password) {
      updates.passwordHash = hashPassword(password)
      updates.passwordSource = "local"
    }

    if (googleLinked !== undefined) {
      updates.googleLinked = googleLinked
      if (!googleLinked) {
        updates.googleSub = undefined
      }
    }

    if (role !== undefined) updates.role = role
    if (status !== undefined) updates.status = status
    if (quotaLimitMb !== undefined) updates.quotaLimitMb = quotaLimitMb
    if (quotaUsedMb !== undefined) updates.quotaUsedMb = quotaUsedMb

    if (!actor) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      )
    }

    const isSelf = actorId === targetId
    const isActorSuperAdmin = actor.role === "superadmin"
    const isActorAdmin = actor.role === "admin"
    const isActorUser = actor.role === "user"

    const isTargetSuperAdmin = targetBefore.role === "superadmin"
    const isTargetAdmin = targetBefore.role === "admin"

    const activeSuperAdminsBefore = allBefore.filter(
      (u) => u.role === "superadmin" && u.status === "active"
    )
    const isLastActiveSuperAdmin =
      isTargetSuperAdmin &&
      targetBefore.status === "active" &&
      activeSuperAdminsBefore.length === 1 &&
      activeSuperAdminsBefore[0].id === targetId

    // Users cannot modify admin or super admin accounts.
    if (isActorUser && !isSelf && (isTargetAdmin || isTargetSuperAdmin)) {
      return NextResponse.json(
        { error: "You cannot modify admin or super admin accounts" },
        { status: 403 }
      )
    }

    // Admins cannot modify other admins.
    if (isActorAdmin && isTargetAdmin && !isSelf) {
      return NextResponse.json(
        { error: "Admins cannot modify other admin accounts" },
        { status: 403 }
      )
    }

    // Only super admin can change user roles at all.
    if (
      updates.role !== undefined &&
      updates.role !== targetBefore.role &&
      !isActorSuperAdmin
    ) {
      return NextResponse.json(
        { error: "Only Super Admin can change user roles" },
        { status: 403 }
      )
    }

    // The last active super admin cannot demote or disable themself.
    if (isLastActiveSuperAdmin && isSelf) {
      if (updates.role && updates.role !== "superadmin") {
        return NextResponse.json(
          { error: "The last active Super Admin cannot change their role" },
          { status: 400 }
        )
      }
      if (updates.status && updates.status !== "active") {
        return NextResponse.json(
          { error: "The last active Super Admin cannot be disabled" },
          { status: 400 }
        )
      }
    }

    // Prevent non-superadmin from assigning superadmin role.
    if (updates.role === "superadmin" && actor.role !== "superadmin") {
      return NextResponse.json(
        { error: "Only super admin can assign super admin role" },
        { status: 403 }
      )
    }

    // Prevent non-Super Admins from editing Super Admin accounts.
    if (targetBefore.role === "superadmin" && !isActorSuperAdmin) {
      return NextResponse.json(
        { error: "Only Super Admins can modify Super Admin accounts" },
        { status: 403 }
      )
    }

    // Only the account owner may change Google link status.
    if (googleLinked !== undefined && !isSelf) {
      return NextResponse.json(
        { error: "Only the account owner can change Google link status" },
        { status: 403 }
      )
    }

    // Require a password when unlinking a Google-only account.
    if (
      googleLinked === false &&
      targetBefore.googleLinked &&
      targetBefore.passwordSource === "google-generated" &&
      !password
    ) {
      return NextResponse.json(
        {
          error:
            "You must set a password before unlinking your Google account.",
        },
        { status: 400 }
      )
    }

    const updatedUser = await updateUser(targetId, updates)

    // Ensure at least one active super admin always exists.
    const stillHasActiveSuperAdmin = (await getAllUsers()).some(
      (u) => u.role === "superadmin" && u.status === "active"
    )
    if (!stillHasActiveSuperAdmin) {
      // Roll back to previous user state to maintain invariant.
      await updateUser(targetId, {
        name: targetBefore.name,
        username: targetBefore.username,
        email: targetBefore.email,
        role: targetBefore.role,
        status: targetBefore.status,
        quotaLimitMb: targetBefore.quotaLimitMb,
        quotaUsedMb: targetBefore.quotaUsedMb,
        profileImageUrl: targetBefore.profileImageUrl,
        passwordHash: targetBefore.passwordHash,
      })
      return NextResponse.json(
        { error: "At least one super admin is required" },
        { status: 400 }
      )
    }

    const publicUser: PublicUser = toPublicUser(updatedUser)
    await recordActivity({
      actorUserId: actorId,
      action: "user.updated",
      entityType: "user",
      entityId: targetId,
      entityLabel: updatedUser.name,
      summary: `Updated user ${updatedUser.name}`,
      detail: "User profile, permissions, quota, authentication, or status changed.",
      before: { user: toPublicUser(targetBefore) },
      after: { user: publicUser },
      undoable: false,
      undoPayload: {
        type: "restore_user",
        user: {
          id: targetBefore.id,
          name: targetBefore.name,
          username: targetBefore.username,
          email: targetBefore.email,
          role: targetBefore.role,
          status: targetBefore.status,
          quotaLimitMb: targetBefore.quotaLimitMb,
          quotaUsedMb: targetBefore.quotaUsedMb,
          profileImageUrl: targetBefore.profileImageUrl,
        },
      },
      undoReason: "User undo is recorded for review but not executable yet.",
      ...getRequestActivityContext(request),
    })
    return NextResponse.json({ user: publicUser })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to update user")
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

export async function DELETE(_: Request, { params }: RouteParams) {
  try {
    const { id } = await params
    const target = await findUserById(id)
    if (!target) {
      // Idempotent delete: treat as success if already gone.
      return NextResponse.json({ ok: true })
    }

    const cookieStore = await cookies()
    const actorId = cookieStore.get("sessionUserId")?.value
    const actor = actorId ? await findUserById(actorId) : undefined

    // Only a super admin may delete another super admin.
    if (target.role === "superadmin" && actor?.role !== "superadmin") {
      return NextResponse.json(
        { error: "Only super admin can delete a super admin account" },
        { status: 403 }
      )
    }

    // The last active super admin cannot be deleted.
    const allBefore = await getAllUsers()
    const activeSuperAdmins = allBefore.filter(
      (u) => u.role === "superadmin" && u.status === "active"
    )
    const isLastActiveSuperAdmin =
      target.role === "superadmin" &&
      target.status === "active" &&
      activeSuperAdmins.length === 1 &&
      activeSuperAdmins[0].id === id

    if (isLastActiveSuperAdmin) {
      return NextResponse.json(
        { error: "Cannot delete the last active Super Admin" },
        { status: 400 }
      )
    }

    await deleteUser(id)
    await recordActivity({
      actorUserId: actorId,
      action: "user.deleted",
      entityType: "user",
      entityId: id,
      entityLabel: target.name,
      summary: `Deleted user ${target.name}`,
      detail: `${target.email} was removed.`,
      before: { user: toPublicUser(target) },
      undoReason: "Deleted users must be recreated manually.",
      ...getRequestActivityContext(_),
    })
    return NextResponse.json({ ok: true })
  } catch (error: unknown) {
    const message = errorMessage(error, "Unable to delete user")
    // Make delete idempotent: if the user is already gone, treat as success.
    if (message === "User not found") {
      return NextResponse.json({ ok: true })
    }
    return NextResponse.json({ error: message }, { status: 400 })
  }
}

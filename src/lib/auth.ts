import {
  PublicUser,
  createUser,
  findUserByEmail,
  findUserByUsername,
  hashPassword,
  toPublicUser,
} from "./users-store"

export async function login(
  identifier: string,
  password: string
): Promise<PublicUser> {
  const byEmail = await findUserByEmail(identifier)
  const byUsername = byEmail ? undefined : await findUserByUsername(identifier)
  const user = byEmail ?? byUsername

  if (!user) {
    throw new Error("Invalid email/username or password")
  }
  if (user.status !== "active") {
    throw new Error("User is disabled")
  }
  if (!user.emailVerified && !user.googleLinked) {
    throw new Error("Please verify your email address before signing in")
  }
  const passwordHash = hashPassword(password)
  if (user.passwordHash !== passwordHash) {
    if (user.googleLinked && user.passwordSource === "google-generated") {
      throw new Error(
        "Incorrect password. This account is linked with Google. Please use \"Login with Google\"."
      )
    }
    throw new Error("Invalid email or password")
  }

  return toPublicUser(user)
}

export function logout() {
  // No-op for now; cookie is cleared in the route handler.
}

export async function signup(input: {
  name: string
  username?: string
  email: string
  password: string
}): Promise<PublicUser> {
  const existing = await findUserByEmail(input.email)
  if (existing) {
    throw new Error("Email already in use")
  }

  const user = await createUser({
    ...input,
    role: "user",
    status: "active",
    emailVerified: false,
    emailVerifiedAt: undefined,
    passwordSource: "local",
  })

  return toPublicUser(user)
}

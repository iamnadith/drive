import { markTotpCounterUsed, type User } from "./users-store"
import { verifyTotpCodeWithCounter } from "./totp"

export async function consumeUserTotpCode(user: User, code: string) {
  if (!user.totpEnabled || !user.totpSecret) return false

  const result = verifyTotpCodeWithCounter(user.totpSecret, code, 0)
  if (!result.valid || result.counter === null) return false

  return markTotpCounterUsed(user.id, result.counter)
}

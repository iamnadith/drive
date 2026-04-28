import crypto from "crypto"

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function generateTotpSecret(bytes = 20) {
  const buffer = crypto.randomBytes(bytes)
  let bits = ""
  let output = ""

  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0")
    while (bits.length >= 5) {
      output += BASE32_ALPHABET[parseInt(bits.slice(0, 5), 2)]
      bits = bits.slice(5)
    }
  }

  if (bits.length > 0) {
    output += BASE32_ALPHABET[parseInt(bits.padEnd(5, "0"), 2)]
  }

  return output
}

function decodeBase32(secret: string) {
  const clean = secret.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase()
  let bits = ""
  const bytes: number[] = []

  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char)
    if (value === -1) throw new Error("Invalid authenticator secret")
    bits += value.toString(2).padStart(5, "0")
    while (bits.length >= 8) {
      bytes.push(parseInt(bits.slice(0, 8), 2))
      bits = bits.slice(8)
    }
  }

  return Buffer.from(bytes)
}

const TOTP_STEP_SECONDS = 30

export function getTotpCounter(time = Date.now(), stepSeconds = TOTP_STEP_SECONDS) {
  return Math.floor(time / 1000 / stepSeconds)
}

export function generateTotpCode(secret: string, time = Date.now(), stepSeconds = TOTP_STEP_SECONDS, digits = 6) {
  const counter = getTotpCounter(time, stepSeconds)
  return generateTotpCodeForCounter(secret, counter, digits)
}

function generateTotpCodeForCounter(secret: string, counter: number, digits = 6) {
  const key = decodeBase32(secret)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)

  return (code % 10 ** digits).toString().padStart(digits, "0")
}

export function verifyTotpCode(secret: string, code: string, windowSteps = 0) {
  return verifyTotpCodeWithCounter(secret, code, windowSteps).valid
}

export function verifyTotpCodeWithCounter(secret: string, code: string, windowSteps = 0) {
  const normalized = code.replace(/\D/g, "")
  if (normalized.length !== 6) return { valid: false, counter: null as number | null }

  const currentCounter = getTotpCounter()
  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const counter = currentCounter + offset
    const expected = generateTotpCodeForCounter(secret, counter)
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(normalized))) {
      return { valid: true, counter }
    }
  }

  return { valid: false, counter: null as number | null }
}

export function buildTotpUri(input: { issuer: string; account: string; secret: string }) {
  const label = `${input.issuer}:${input.account}`
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  })
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`
}

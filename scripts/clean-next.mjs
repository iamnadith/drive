import fs from "node:fs"

function sleep(ms) {
  const buf = new SharedArrayBuffer(4)
  const arr = new Int32Array(buf)
  Atomics.wait(arr, 0, 0, ms)
}

function rmNextDir() {
  fs.rmSync(".next", { recursive: true, force: true })
}

const maxAttempts = 10
const lockPath = ".next/dev/lock"

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    try {
      fs.rmSync(lockPath, { force: true })
    } catch {
      // ignore
    }
    rmNextDir()
    process.exit(0)
  } catch (error) {
    const code = error && typeof error === "object" ? error.code : undefined
    const retryable = code === "ENOTEMPTY" || code === "EPERM" || code === "EBUSY"
    if (!retryable || attempt === maxAttempts) {
      console.warn("Warning: failed to remove .next directory; continuing without cleaning.")
      console.warn("If you have dev server issues, stop `next dev` and delete `.next` manually.")
      if (error && typeof error === "object" && error.message) console.warn(String(error.message))
      process.exit(0)
    }
    sleep(150 * attempt)
  }
}


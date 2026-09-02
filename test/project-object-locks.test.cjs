const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.join(__dirname, "..")
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8")

const lockModule = read("src/lib/project-object-lock.ts")
const operationsStore = read("src/lib/project-operations-store.ts")

const lockGuardRoutes = [
  "src/lib/project-upload-api.ts",
  "src/app/api/v1/files/route.ts",
  "src/app/api/v1/files/rename/route.ts",
  "src/app/api/v1/files/metadata/route.ts",
  "src/app/api/v1/files/content/route.ts",
  "src/app/api/v1/storage/move/route.ts",
  "src/app/api/v1/storage/object/[...key]/route.ts",
]

test("lock checks distinguish real locks from unavailable lock infrastructure", () => {
  assert.match(lockModule, /class ProjectObjectLockedError extends Error/)
  assert.match(lockModule, /code: "OBJECT_LOCKED"/)
  assert.match(lockModule, /code: "LOCK_CHECK_UNAVAILABLE"/)
  assert.match(lockModule, /status: 503/)
  assert.match(lockModule, /Retry-After/)
  assert.match(operationsStore, /throw new ProjectObjectLockedError\(/)
  assert.match(operationsStore, /reason: lock\.reason/)
  assert.match(operationsStore, /expiresAt: lock\.expires_at/)
})

test("every object write guard uses the shared lock classifier", () => {
  for (const relativePath of lockGuardRoutes) {
    const source = read(relativePath)
    assert.match(source, /projectObjectLockResponse/, relativePath)
    assert.doesNotMatch(
      source,
      /catch \{\s*return NextResponse\.json\(\{ error: "Object is locked"/s,
      relativePath
    )
  }
})

test("lock status has a read-only diagnostic endpoint without token exposure", () => {
  const source = read("src/app/api/v1/files/locks/route.ts")
  const getSource = source.split("export async function POST", 1)[0]
  assert.match(source, /export async function GET\(request: Request\)/)
  assert.match(getSource, /getProjectObjectLock\(/)
  assert.match(getSource, /reason: lock\.reason/)
  assert.match(getSource, /expiresAt: lock\.expiresAt/)
  assert.doesNotMatch(getSource, /lock_token_hash/)
})

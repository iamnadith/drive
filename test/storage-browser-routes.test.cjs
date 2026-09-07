const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

// Execute the actual handlers with isolated storage/auth dependencies. These
// regressions must never contact a live account or mutate real files.
const account = {
  id: "account-a",
  label: "Personal",
  email: "a@example.com",
  status: "active",
  cloudflareAccountId: "cloud-a",
  r2AccessKeyId: "test",
  r2SecretAccessKey: "test",
  syncStatus: "ok",
  totalBytes: 42,
  totalObjects: 2,
  totalBuckets: 1,
}
const sourceCache = new Map()
function handler(file, overrides = {}) {
  if (!sourceCache.has(file))
    sourceCache.set(
      file,
      ts.transpileModule(
        fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
        {
          compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
          },
        }
      ).outputText
    )
  const calls = []
  const dependencies = {
    "next/server": {
      NextResponse: { json: (body, init) => Response.json(body, init) },
    },
    "@/lib/server-auth": { requireAdmin: async () => ({ ok: true }) },
    "@/lib/accounts-store": { getAllAccounts: async () => [account] },
    "@/lib/bucket-stats-store": {
      listBucketStats: async (id) => {
        calls.push(["stats", id])
        return [
          { bucketName: "photos", bytes: 42, objects: 2, status: "completed" },
        ]
      },
      ensureBucketStatsRows: async (...args) => calls.push(["seed", ...args]),
    },
    "@/lib/project-operations-store": {
      syncTrackedBucketObject: async () => {},
      markTrackedBucketObjectDeleted: async () => {},
      markTrackedBucketPrefixDeleted: async () => {},
    },
    "@/lib/r2-s3": {
      r2CreateBucket: async (...args) => calls.push(["create", ...args]),
      r2CreateSignedDownloadUrl: async (...args) => {
        calls.push(["sign", ...args])
        return "https://storage.example.test/signed"
      },
      r2ListObjectsPageWithDelimiter: async (...args) => {
        calls.push(["list", ...args])
        return {
          CommonPrefixes: [{ Prefix: "photos/next/" }],
          Contents: [
            {
              Key: "photos/a.jpg",
              Size: 123,
              LastModified: new Date("2026-01-01"),
            },
          ],
          NextContinuationToken: "next",
          IsTruncated: true,
        }
      },
      r2PutObject: async (...args) => calls.push(["put", ...args]),
      r2ListAllObjects: async () => [],
      r2DeleteObjects: async (...args) => calls.push(["delete-many", ...args]),
      r2DeleteObject: async (...args) => calls.push(["delete", ...args]),
    },
  }
  for (const [name, values] of Object.entries(overrides))
    dependencies[name] = { ...dependencies[name], ...values }
  const module = { exports: {} }
  const load = (name) => {
    if (dependencies[name]) return dependencies[name]
    if (name === "stream") return require(name)
    throw new Error("Unexpected dependency: " + name)
  }
  new Function("require", "module", "exports", sourceCache.get(file))(
    load,
    module,
    module.exports
  )
  return { ...module.exports, calls }
}
const drivesRoute = "src/app/api/storage/buckets/route.ts"
const objectsRoute = "src/app/api/storage/buckets/[name]/objects/route.ts"
const context = { params: Promise.resolve({ name: "photos" }) }
function request(query = "", method = "GET", body) {
  return new Request(
    "https://panel.test/api/storage/buckets/photos/objects?accountId=account-a&" +
      query,
    {
      method,
      ...(body
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  )
}

test("drive snapshot and account label come from the same active account", async () => {
  const route = handler(drivesRoute)
  const data = await (await route.GET()).json()
  assert.equal(data.activeAccount.id, account.id)
  assert.equal(data.activeAccount.label, account.label)
  assert.equal(data.activeAccount.r2SecretAccessKey, undefined)
  assert.deepEqual(route.calls, [["stats", account.id]])
  assert.equal(data.buckets[0].name, "photos")
})

test("created drive is seeded into the listing projection immediately", async () => {
  const route = handler(drivesRoute)
  const response = await route.POST(request("", "POST", { name: "new-drive" }))
  assert.equal(response.status, 200)
  assert.deepEqual(
    route.calls.find((call) => call[0] === "seed"),
    ["seed", account.id, ["new-drive"]]
  )
})

test("successful drive creation stays successful if the projection fails", async () => {
  const route = handler(drivesRoute, {
    "@/lib/bucket-stats-store": {
      ensureBucketStatsRows: async () => {
        throw new Error("test projection unavailable")
      },
    },
  })
  const response = await route.POST(request("", "POST", { name: "new-drive" }))
  assert.equal(response.status, 200)
  assert.match((await response.json()).warning, /Drive created/)
})

test("all storage operations reject an account switch before touching storage", async () => {
  for (const method of ["GET", "POST", "DELETE"]) {
    const route = handler(objectsRoute)
    const req = new Request(
      "https://panel.test/objects?accountId=old-account",
      {
        method,
        ...(method !== "GET"
          ? { body: JSON.stringify({ key: "a", action: "file", type: "file" }) }
          : {}),
      }
    )
    assert.equal((await route[method](req, context)).status, 409)
    assert.deepEqual(route.calls, [])
  }
  const route = handler(drivesRoute)
  const req = new Request("https://panel.test/drives?accountId=old-account", {
    method: "POST",
    body: JSON.stringify({ name: "new-drive" }),
  })
  assert.equal((await route.POST(req)).status, 409)
  assert.deepEqual(route.calls, [])
})

test("private dashboard downloads use admin auth and an uncached signed redirect", async () => {
  const route = handler(objectsRoute)
  const response = await route.GET(
    request("action=download&key=photos%2Fa.jpg"),
    context
  )
  assert.equal(response.status, 307)
  assert.equal(
    response.headers.get("Location"),
    "https://storage.example.test/signed"
  )
  assert.equal(response.headers.get("Cache-Control"), "private, no-store")
  assert.equal(route.calls[0][3], "photos/a.jpg")
  assert.equal(route.calls[0][4].filename, "a.jpg")
  const denied = handler(objectsRoute, {
    "@/lib/server-auth": {
      requireAdmin: async () => ({
        ok: false,
        response: Response.json({ error: "Unauthorized" }, { status: 401 }),
      }),
    },
  })
  assert.equal(
    (await denied.GET(request("action=download&key=a"), context)).status,
    401
  )
  assert.deepEqual(denied.calls, [])
})

test("listing preserves prefix, folders, exact bytes and continuation", async () => {
  const route = handler(objectsRoute)
  const response = await route.GET(
    request("prefix=photos%2F&continuationToken=previous"),
    context
  )
  const data = await response.json()
  assert.deepEqual(data.folders, ["photos/next/"])
  assert.equal(data.objects[0].size, 123)
  assert.equal(data.objects[0].uploaded, "2026-01-01T00:00:00.000Z")
  assert.equal(data.nextContinuationToken, "next")
  assert.equal(route.calls[0][3].continuationToken, "previous")
  assert.equal(route.calls[0][3].prefix, "photos/")
})

test("new file cannot silently overwrite an existing file", async () => {
  const route = handler(objectsRoute)
  assert.equal(
    (
      await route.POST(
        request("", "POST", { action: "file", key: "notes.txt" }),
        context
      )
    ).status,
    200
  )
  assert.equal(route.calls[0][5].ifNoneMatch, "*")
  const collision = handler(objectsRoute, {
    "@/lib/r2-s3": {
      r2PutObject: async () => {
        const error = new Error("exists")
        error.name = "PreconditionFailed"
        throw error
      },
    },
  })
  assert.equal(
    (
      await collision.POST(
        request("", "POST", { action: "file", key: "notes.txt" }),
        context
      )
    ).status,
    409
  )
})

test("committed upload remains successful when object tracking fails", async () => {
  const route = handler(objectsRoute, {
    "@/lib/project-operations-store": {
      syncTrackedBucketObject: async () => {
        throw new Error("test tracking unavailable")
      },
    },
  })
  const form = new FormData()
  form.append("path", "photos/")
  form.append("file", new Blob(["test"]), "test.txt")
  const req = new Request("https://panel.test/objects?accountId=account-a", {
    method: "POST",
    body: form,
  })
  const response = await route.POST(req, context)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).key, "photos/test.txt")
})

test("oversized folder deletion never silently deletes a truncated listing", async () => {
  const route = handler(objectsRoute, {
    "@/lib/r2-s3": {
      r2ListAllObjects: async () =>
        new Array(200_000).fill({ key: "folder/a" }),
    },
  })
  assert.equal(
    (
      await route.DELETE(
        request("", "DELETE", { type: "folder", key: "folder/" }),
        context
      )
    ).status,
    409
  )
  assert.deepEqual(route.calls, [])
})

test("batch deletion checks per-object errors even when storage returns HTTP success", async () => {
  const sent = []
  let fail = false
  const route = handler("src/lib/r2-s3.ts", {
    "@aws-sdk/client-s3": {
      S3Client: class {
        async send(command) {
          sent.push(command.input)
          return fail
            ? { Errors: [{ Key: "blocked", Code: "AccessDenied" }] }
            : {}
        }
      },
      DeleteObjectsCommand: class {
        constructor(input) {
          this.input = input
        }
      },
    },
    "@aws-sdk/lib-storage": {},
    "@aws-sdk/s3-request-presigner": {},
  })
  const config = {
    accountId: "isolated-delete-test",
    accessKeyId: "test",
    secretAccessKey: "test",
  }
  await route.r2DeleteObjects(config, "photos", ["a", "a", "", "b"])
  assert.deepEqual(sent[0].Delete.Objects, [{ Key: "a" }, { Key: "b" }])
  sent.length = 0
  fail = true
  await assert.rejects(
    route.r2DeleteObjects(
      config,
      "photos",
      Array.from({ length: 1001 }, (_, index) => String(index))
    ),
    /AccessDenied/
  )
  assert.equal(sent.length, 1)
})

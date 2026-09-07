const test = require("node:test")
const assert = require("node:assert/strict")
const {
  storageHref,
  listingItems,
  mergeItems,
  sortItems,
} = require("../src/lib/storage-browser.cjs")

test("paths round-trip spaces, literal percent, unicode and repeated separators", () => {
  const prefix = "photos/日本語 & 100%//"
  const url = new URL(storageHref("my-drive", prefix), "https://example.com")
  assert.equal(url.searchParams.get("prefix"), prefix)
  assert.equal(url.searchParams.get("drive"), "my-drive")
  assert.equal(storageHref(), "/dashboard/storage")
})

test("pagination keeps later folders and deduplicates overlapping pages", () => {
  const first = listingItems(
    { folders: ["photos/a/"], objects: [{ key: "photos/one.jpg", size: 7 }] },
    "photos/"
  )
  const second = listingItems(
    {
      folders: ["photos/a/", "photos/b/"],
      objects: [{ key: "photos/one.jpg", size: 8 }],
    },
    "photos/"
  )
  const merged = mergeItems(first, second)
  assert.equal(merged.length, 3)
  assert.equal(merged.find((item) => item.name === "one.jpg").bytes, 8)
  assert.ok(merged.some((item) => item.name === "b"))
})

test("folder markers and objects outside the current directory are excluded", () => {
  assert.deepEqual(
    listingItems(
      {
        objects: [
          { key: "photos/" },
          { key: "photos/deep/file" },
          { key: "other/file" },
        ],
      },
      "photos/"
    ),
    []
  )
})

test("sorting uses exact bytes and ISO dates, with folders first", () => {
  const items = listingItems(
    {
      folders: ["z/"],
      objects: [
        { key: "a", size: 1048577, uploaded: "2026-01-10T00:00:00Z" },
        { key: "b", size: 1048578, uploaded: "2026-02-01T00:00:00Z" },
      ],
    },
    ""
  )
  assert.deepEqual(
    sortItems(items, "size-desc").map((item) => item.name),
    ["z", "b", "a"]
  )
  assert.deepEqual(
    sortItems(items, "modified-desc").map((item) => item.name),
    ["z", "b", "a"]
  )
})

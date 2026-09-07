function storageHref(drive, prefix = "") {
  const params = new URLSearchParams()
  if (drive) params.set("drive", drive)
  if (drive && prefix) params.set("prefix", prefix)
  return `/dashboard/storage${params.size ? `?${params}` : ""}`
}

function listingItems(data, prefix) {
  const folders = (data.folders || [])
    .filter(
      (key) =>
        typeof key === "string" && key.startsWith(prefix) && key !== prefix
    )
    .map((key) => ({
      id: `folder:${key}`,
      key,
      name: key.slice(prefix.length).replace(/\/$/, ""),
      type: "folder",
      bytes: 0,
      uploaded: "",
    }))
  const files = (data.objects || [])
    .filter(
      (object) =>
        typeof object.key === "string" && object.key.startsWith(prefix)
    )
    .map((object) => ({
      id: `file:${object.key}`,
      key: object.key,
      name: object.key.slice(prefix.length),
      type: "file",
      bytes: Number(object.size) || 0,
      uploaded: object.uploaded || "",
    }))
    .filter((item) => item.name && !item.name.includes("/"))
  return mergeItems([], [...folders, ...files])
}

function mergeItems(previous, next) {
  return [
    ...new Map([...previous, ...next].map((item) => [item.id, item])).values(),
  ]
}

function sortItems(items, sort) {
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1
    const name = a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base",
    })
    if (sort === "name-desc") return -name
    if (sort === "size-desc") return b.bytes - a.bytes || name
    if (sort === "modified-desc")
      return (
        (Date.parse(b.uploaded) || 0) - (Date.parse(a.uploaded) || 0) || name
      )
    return name
  })
}

module.exports = { storageHref, listingItems, mergeItems, sortItems }

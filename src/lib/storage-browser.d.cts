export type StorageItem = {
  id: string
  key: string
  name: string
  type: "folder" | "file"
  bytes: number
  uploaded: string
}
export type StorageListing = {
  folders?: string[]
  objects?: { key: string; size?: number; uploaded?: string }[]
  nextContinuationToken?: string | null
}
export function storageHref(drive?: string, prefix?: string): string
export function listingItems(
  data: StorageListing,
  prefix: string
): StorageItem[]
export function mergeItems(
  previous: StorageItem[],
  next: StorageItem[]
): StorageItem[]
export function sortItems(items: StorageItem[], sort: string): StorageItem[]

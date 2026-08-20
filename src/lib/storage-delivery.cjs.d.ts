export const STORAGE_CORS_ENV: string
export const STORAGE_REDIRECT_CACHE_CONTROL: string
export function isSystemDerivativeKey(key: string): boolean
export function isStorageDeliveryOriginAllowed(
  origin?: string | null,
  configuredOrigins?: string
): boolean

export function allowedStorageCorsOrigins(value?: string): string[]

export function createStorageDeliveryHeaders(
  origin?: string | null,
  configuredOrigins?: string
): Headers

export function createStorageDeliveryRedirect(
  location: string,
  origin?: string | null,
  configuredOrigins?: string
): Response

export function createStorageDeliveryOptionsResponse(
  origin?: string | null,
  configuredOrigins?: string
): Response

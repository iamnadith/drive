export const MAX_MEDIA_ALLOWED_ORIGINS: number

export function normalizeMediaAllowedOrigin(value: unknown): string
export function normalizeMediaAllowedOrigins(value: unknown): string[]
export function mergeMediaAllowedOrigins(inherited: string[] | null, manual: string[] | null): string[]
export function hasProjectBucketDeliveryPolicyMutation(value: unknown): boolean

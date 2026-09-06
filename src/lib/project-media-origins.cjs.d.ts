export const MAX_MEDIA_ALLOWED_ORIGINS: number
export const MAX_EFFECTIVE_MEDIA_ALLOWED_ORIGINS: number

export function normalizeMediaAllowedOrigin(value: unknown): string
export function normalizeMediaAllowedOrigins(value: unknown): string[]
export function mergeMediaAllowedOrigins(inherited: string[] | null, manual: string[] | null): string[]
export function mergeManyMediaAllowedOrigins(policies: Array<string[] | null | undefined>): string[]
export function resolveEffectiveMediaAllowedOrigins(input: {
  inheritedPolicies: Array<string[] | null | undefined>
  manual: string[] | null
  fallback: string[]
}): string[]
export function hasProjectBucketDeliveryPolicyMutation(value: unknown): boolean

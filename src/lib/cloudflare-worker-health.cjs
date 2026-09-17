/**
 * Return a health failure reported by an authenticated Worker status payload.
 * Liveness is not readiness: an HTTP 200 can still contain a failed durable
 * orchestrator state (for example, panel reconciliation failing with 401).
 * @param {unknown} payload
 * @returns {string | null}
 */
function runtimeHealthError(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "Worker returned an invalid status response"
  }

  const response = /** @type {{ ok?: unknown; error?: unknown; state?: unknown }} */ (payload)
  if (response.ok === false) {
    return typeof response.error === "string" && response.error.trim()
      ? response.error.trim()
      : "Worker reported an unhealthy status"
  }

  if (!response.state || typeof response.state !== "object" || Array.isArray(response.state)) return null
  const state = /** @type {{ status?: unknown; last_error?: unknown; lastError?: unknown }} */ (response.state)
  const status = typeof state.status === "string" ? state.status.trim().toLowerCase() : ""
  if (status !== "error" && status !== "failed" && status !== "unhealthy") return null

  const detail = typeof state.last_error === "string" ? state.last_error
    : typeof state.lastError === "string" ? state.lastError
      : ""
  return detail.trim() || `Worker runtime reports ${status}`
}

module.exports = { runtimeHealthError }

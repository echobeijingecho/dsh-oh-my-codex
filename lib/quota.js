import { randomUUID } from 'node:crypto'

/** Margin added on top of the window reset time before resending. */
export const QUOTA_RETRY_MARGIN_MS = 30_000
/** A window longer than this is not waited out automatically. */
export const MAX_AUTO_RETRY_WINDOW_MINS = 360
const EXHAUSTED_PERCENT = 99

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') return undefined
  if (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) return undefined
  return {
    usedPercent: window.usedPercent,
    ...(Number.isFinite(window.windowDurationMins) ? { windowDurationMins: window.windowDurationMins } : {}),
    ...(Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? { resetsAt: window.resetsAt } : {}),
  }
}

/**
 * Sparse-merge an `account/rateLimits/updated` payload (or a full read) into
 * the last snapshot: absent/null fields keep the previously observed value,
 * per the official notification semantics.
 */
export function mergeRateLimits(previous, incoming) {
  if (!incoming || typeof incoming !== 'object') return previous ?? null
  const merged = previous ? { ...previous } : {}
  for (const slot of ['primary', 'secondary']) {
    const window = normalizeWindow(incoming[slot])
    if (window) merged[slot] = window
  }
  if (incoming.planType != null) merged.planType = incoming.planType
  if (incoming.rateLimitReachedType !== undefined && incoming.rateLimitReachedType !== null) {
    merged.rateLimitReachedType = incoming.rateLimitReachedType
  }
  return Object.keys(merged).length ? merged : null
}

/**
 * Find the exhausted short window (≤ maxWindowMins) with a known reset time.
 * Returns `{ resetsAt, windowMins } | null`; `exhaustedLongWindow` says why
 * a long-window exhaustion was not selected (for user-facing copy).
 */
export function exhaustedShortWindow(snapshot, { now = Date.now(), maxWindowMins = MAX_AUTO_RETRY_WINDOW_MINS } = {}) {
  if (!snapshot) return null
  let longWindow = false
  for (const slot of ['primary', 'secondary']) {
    const window = snapshot[slot]
    if (!window || window.usedPercent < EXHAUSTED_PERCENT) continue
    if (!Number.isFinite(window.resetsAt) || window.resetsAt <= 0) continue
    const windowMins = window.windowDurationMins
    if (!Number.isFinite(windowMins) || windowMins > maxWindowMins) {
      longWindow = true
      continue
    }
    if (window.resetsAt * 1000 <= now) continue
    return { resetsAt: window.resetsAt, windowMins, exhaustedLongWindow: false }
  }
  return longWindow ? { exhaustedLongWindow: true } : null
}

/** Abortable delay that rejects on abort; resolves after `ms` otherwise. */
export function cancellableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal) {
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
    }
    timer.unref?.()
  })
}

/** The `llm/retry` id for a quota wait; `erq-` marks engine-router quota. */
export function quotaRetryId() {
  return `erq-${randomUUID()}`
}

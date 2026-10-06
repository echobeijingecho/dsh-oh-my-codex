import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const STATES = ['not-started', 'starting', 'connected', 'connection-failed', 'unavailable']
const MAX_EVENTS = 100

// stderr and upstream messages can carry proxy credentials, bearer tokens or
// API keys. Everything recorded for operators passes through this filter.
export function redact(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1***@')
    .replace(/\b(bearer|authorization)\s*[:=]?\s*[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '$1-***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***jwt***')
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1***')
    .slice(0, 2000)
}

/**
 * Operator-facing engine status: one state, a stable code with a next action,
 * the last preflight facts and a bounded ring of recent failures. Persisted as
 * `<stateDir>/status.json` (0600) so fleet tooling can read it without a UI.
 */
export class Diagnostics {
  status = { state: 'not-started', code: null, message: null, action: null, changedAt: Date.now() }
  preflight = null
  events = []
  #writing = Promise.resolve()

  constructor(directory, logger) {
    this.directory = directory
    this.logger = logger
  }

  set(state, { code = null, message = null, action = null } = {}) {
    if (!STATES.includes(state)) throw new Error(`unknown engine state ${state}`)
    this.status = { state, code, message: message && redact(message), action, changedAt: Date.now() }
    return this.persist()
  }

  record(code, detail = {}) {
    const event = { at: Date.now(), code }
    for (const [key, value] of Object.entries(detail)) {
      if (value !== undefined) event[key] = typeof value === 'string' ? redact(value) : value
    }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.logger?.warn?.(`oh-my-codex: ${code}${detail.message ? ` ${redact(detail.message)}` : ''}`)
    return this.persist()
  }

  snapshot() {
    return { status: this.status, preflight: this.preflight, recent: this.events.slice(-20) }
  }

  persist() {
    if (!this.directory) return Promise.resolve()
    const body = JSON.stringify({ ...this.snapshot(), updatedAt: Date.now() }, null, 2)
    this.#writing = this.#writing.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const target = join(this.directory, 'status.json')
      const temporary = `${target}.${randomUUID()}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(body) } finally { await handle.close() }
        await rename(temporary, target)
      } finally {
        await unlink(temporary).catch(() => {})
      }
    }).catch(error => this.logger?.warn?.(`oh-my-codex: status write failed: ${error?.code ?? error?.message}`))
    return this.#writing
  }
}

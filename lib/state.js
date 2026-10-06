import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import lockfile from 'proper-lockfile'
import { EngineError } from './errors.js'

export function isInside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function isRecordLike(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Drop the pending batch from `delivered` so those messages count as new
 *  input again — used when reconciliation proves the prompt never reached Codex. */
export function rollbackDelivered(state) {
  if (!state.pending) return state.delivered
  const pending = new Set(state.pending.messageIds)
  return state.delivered.filter(id => !pending.has(id))
}

export async function workspacePath(cwd, roots) {
  if (!cwd || !isAbsolute(cwd)) throw new EngineError('ENGINE_WORKSPACE', 'absolute path required')
  const resolved = await realpath(cwd)
  const allowed = await Promise.all(roots.map(root => realpath(root)))
  if (!allowed.some(root => isInside(root, resolved))) {
    throw new EngineError('ENGINE_WORKSPACE', 'not enabled')
  }
  return resolved
}

const PENDING_SHAPE = {
  messageIds: value => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string'),
  threadId: value => value === null || typeof value === 'string',
  lastTurnId: value => value === null || typeof value === 'string',
  dispatchedAt: value => Number.isFinite(value),
  pid: value => value === null || Number.isInteger(value),
  expiresAt: value => Number.isFinite(value),
}

export class ThreadStore {
  constructor(directory, owner) {
    if (!isAbsolute(directory) || typeof owner !== 'string' || !owner.trim()) {
      throw new Error('dsh-oh-my-codex requires an absolute stateDir and a deployment-owned ownerId')
    }
    this.directory = directory
    this.owner = owner
  }

  path(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required')
    const key = createHash('sha256').update(JSON.stringify([this.owner, sessionId])).digest('hex')
    return join(this.directory, `${key}.json`)
  }

  async read(sessionId) {
    let data
    try { data = await readFile(this.path(sessionId), 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
    let state
    try { state = JSON.parse(data) } catch {
      throw new EngineError('ENGINE_STATE', 'corrupt binding')
    }
    if (!state || state.version !== 1 || state.owner !== this.owner || state.sessionId !== sessionId
        || !['codex', 'codex-gateway', 'claude-code'].includes(state.engine)
        || !['ready', 'running', 'uncertain'].includes(state.status)
        || typeof state.cwd !== 'string' || typeof state.model !== 'string'
        || (state.threadId !== null && typeof state.threadId !== 'string')
        || !Array.isArray(state.delivered) || !state.delivered.every(id => typeof id === 'string')) {
      throw new EngineError('ENGINE_STATE', 'invalid binding')
    }
    if (state.pending !== undefined
        && (!isRecordLike(state.pending) || !Object.entries(PENDING_SHAPE).every(([key, valid]) => valid(state.pending[key])))) {
      throw new EngineError('ENGINE_STATE', 'invalid pending')
    }
    if (state.collaborationMode !== undefined && !['plan', 'default'].includes(state.collaborationMode)) {
      throw new EngineError('ENGINE_STATE', 'invalid collaborationMode')
    }
    return state
  }

  async write(state) {
    const target = this.path(state.sessionId)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ...state, updatedAt: Date.now() }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, target)
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  }

  async acquire(sessionId, onCompromised) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      return await lockfile.lock(this.path(sessionId), {
        realpath: false, stale: 30000, update: 10000, retries: 0, onCompromised,
      })
    } catch (error) {
      if (error.code === 'ELOCKED') throw new EngineError('ENGINE_BUSY')
      throw error
    }
  }
}

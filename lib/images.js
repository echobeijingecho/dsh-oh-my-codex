import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { EngineError } from './errors.js'

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

function hasBytes(data, offset, expected) {
  return data.length >= offset + expected.length
    && expected.every((byte, index) => data[offset + index] === byte)
}

/** Magic-number sniffing; the attachment ref's mediaType is user-influenced
 *  metadata, the bytes decide. */
export function detectImageMediaType(data) {
  if (!(data instanceof Uint8Array) || data.length < 3) return null
  if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (hasBytes(data, 0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasBytes(data, 0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
  if (hasBytes(data, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(data, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp'
  return null
}

function extensionFor(mediaType) {
  return mediaType === 'image/jpeg' ? 'jpg' : mediaType.slice('image/'.length)
}

/** Staging lives inside the engine's CODEX_HOME so the spawned app-server (and
 *  its core process, which snapshots localImage bytes at serialization) can
 *  read the files; config.env wins because it is what the child receives. */
export function imageStagingRoot(config) {
  const codexHome = config?.env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return resolve(codexHome, 'dsh-input-images')
}

/**
 * Read a DSH image attachment (digest-verified by the store), sniff it, and
 * stage it content-addressed under the Codex home. Returns {path, label,
 * mediaType, bytes}. Throws EngineError codes ENGINE_IMAGE_* — callers run
 * this BEFORE the running/pending commit, so failures stay retryable.
 */
export async function stageImage(attachments, ref, { signal, root, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  signal?.throwIfAborted()
  if (!ref || typeof attachments?.readImage !== 'function') {
    throw new EngineError('ENGINE_ATTACHMENT', 'attachments unavailable')
  }
  let stored
  try {
    stored = await attachments.readImage(ref, signal)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    throw new EngineError('ENGINE_IMAGE_READ')
  }
  signal?.throwIfAborted()
  if (!(stored?.data instanceof Uint8Array) || stored.data.length === 0 || stored.data.length > maxBytes) {
    throw new EngineError(stored?.data ? 'ENGINE_IMAGE_SIZE' : 'ENGINE_IMAGE_READ')
  }
  const data = Buffer.from(stored.data)
  const mediaType = detectImageMediaType(data)
  if (!mediaType) throw new EngineError('ENGINE_IMAGE_TYPE')
  const digest = createHash('sha256').update(data).digest('hex')
  const path = join(root, `${digest}.${extensionFor(mediaType)}`)
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    signal?.throwIfAborted()
    const temporary = join(root, `.${digest}.${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
      signal?.throwIfAborted()
      try {
        await link(temporary, path)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        const existingStat = await lstat(path)
        if (!existingStat.isFile() || existingStat.isSymbolicLink()) throw new EngineError('ENGINE_IMAGE_STORE')
        const existing = await readFile(path)
        if (createHash('sha256').update(existing).digest('hex') !== digest) throw new EngineError('ENGINE_IMAGE_STORE')
      }
      await chmod(path, 0o600)
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  } catch (error) {
    if (error instanceof EngineError) throw error
    if (signal?.aborted) throw signal.reason ?? error
    throw new EngineError('ENGINE_IMAGE_STORE')
  }
  return { path, label: typeof ref.name === 'string' && ref.name ? ref.name : `image.${extensionFor(mediaType)}`, mediaType, bytes: data.length }
}

/** After turn/start snapshots the bytes into the rollout, the staged file is
 *  no longer needed by Codex — retention is the only cleanup. */
export async function sweepStaleImages(root, retentionDays, logger) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return
  let entries
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  const cutoff = Date.now() - retentionDays * 86400000
  for (const name of entries.slice(0, 1000)) {
    try {
      const path = join(root, name)
      const info = await stat(path)
      const mtime = info.mtimeMs
      if (info.isFile() && mtime < cutoff) await unlink(path)
    } catch (error) {
      logger?.warn?.(`oh-my-codex: image sweep: ${error?.message ?? String(error)}`)
    }
  }
}

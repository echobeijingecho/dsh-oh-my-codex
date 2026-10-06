import test from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { detectImageMediaType, imageStagingRoot, stageImage, sweepStaleImages } from '../lib/images.js'
import { fixture } from './helpers.js'

// 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('rest')])
const GIF = Buffer.from('GIF89a2kfaked')
const WEBP = Buffer.from('RIFF0000WEBPVP8 fake')

function ref(data, name = 'shot.png') {
  return { attachmentId: `sha256:${createHash('sha256').update(data).digest('hex')}`, mediaType: 'image/png', bytes: data.length, width: 1, height: 1, name }
}
function store(data) {
  return { async readImage() { return { data: new Uint8Array(data) } } }
}

test('magic-number sniffing covers png, jpeg, both gif headers and webp', () => {
  assert.equal(detectImageMediaType(PNG), 'image/png')
  assert.equal(detectImageMediaType(JPEG), 'image/jpeg')
  assert.equal(detectImageMediaType(GIF), 'image/gif')
  assert.equal(detectImageMediaType(Buffer.from('GIF87a.....')), 'image/gif')
  assert.equal(detectImageMediaType(WEBP), 'image/webp')
  assert.equal(detectImageMediaType(Buffer.from('not an image')), null)
  assert.equal(detectImageMediaType(PNG.subarray(0, 4)), null)
})

test('stageImage writes content-addressed, private, deduplicated files', async t => {
  const { root } = await fixture(t)
  const root2 = join(root, 'staging')
  const staged = await stageImage(store(PNG), ref(PNG), { root: root2 })
  assert.match(staged.path, /\.png$/)
  assert.equal((await stat(staged.path)).mode & 0o777, 0o600)
  assert.equal((await stat(root2)).mode & 0o777, 0o700)
  const again = await stageImage(store(PNG), ref(PNG), { root: root2 })
  assert.equal(again.path, staged.path)
  assert.deepEqual(await readdir(root2), [staged.path.split('/').pop()])
  assert.equal((await readdir(root2)).some(name => name.includes('.tmp')), false)
  assert.equal(staged.label, 'shot.png')
})

test('stageImage rejects bad bytes, oversize, read failures and missing services', async t => {
  const { root } = await fixture(t)
  const staging = join(root, 'staging')
  await assert.rejects(stageImage(store(Buffer.from('plain text')), ref(Buffer.alloc(0)), { root: staging }), { code: 'ENGINE_IMAGE_TYPE' })
  await assert.rejects(stageImage(store(Buffer.concat([PNG, Buffer.alloc(10)])), ref(Buffer.alloc(0)), { root: staging, maxBytes: PNG.length }), { code: 'ENGINE_IMAGE_SIZE' })
  await assert.rejects(stageImage({ async readImage() { throw new Error('gone') } }, ref(Buffer.alloc(0)), { root: staging }), { code: 'ENGINE_IMAGE_READ' })
  await assert.rejects(stageImage(undefined, ref(Buffer.alloc(0)), { root: staging }), { code: 'ENGINE_ATTACHMENT' })
})

test('a symlink squatting the digest path is refused', async t => {
  const { root, cwd } = await fixture(t)
  const staging = join(root, 'staging')
  await mkdir(staging, { recursive: true })
  const digest = createHash('sha256').update(PNG).digest('hex')
  const target = `${digest}.png`
  await writeFile(join(cwd, 'evil'), 'evil')
  await symlink(join(cwd, 'evil'), join(staging, target), 'file')
  assert.equal((await lstat(join(staging, target))).isSymbolicLink(), true)
  await assert.rejects(stageImage(store(PNG), ref(PNG), { root: staging }), { code: 'ENGINE_IMAGE_STORE' })
})

test('sweep removes only stale staged files', async t => {
  const { root } = await fixture(t)
  const staging = join(root, 'staging')
  await mkdir(staging, { recursive: true })
  const stale = join(staging, 'aaa.png')
  const fresh = join(staging, 'bbb.png')
  await writeFile(stale, PNG)
  await writeFile(fresh, PNG)
  await utimes(stale, new Date(Date.now() - 20 * 86400000), new Date(Date.now() - 20 * 86400000))
  await sweepStaleImages(staging, 14)
  assert.equal(await readFile(fresh, 'utf8').then(() => true, () => false), true)
  assert.equal(await readFile(stale, 'utf8').then(() => true, () => false), false)
})

test('staging root follows the engine env CODEX_HOME', () => {
  assert.equal(imageStagingRoot({ env: { CODEX_HOME: '/x' } }), '/x/dsh-input-images')
})

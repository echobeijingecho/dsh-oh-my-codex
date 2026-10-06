import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { EngineRouter, assertEngineSwitch } from '../lib/router.js'
import { SteerPort } from '../lib/codex.js'
import { ThreadStore } from '../lib/state.js'
import { engineFailure } from '../lib/errors.js'
import { EventQueue } from '../lib/queue.js'
import { fixture, request, collect, fakeEngine } from './helpers.js'

test('same workspace, separate sessions and users never share a thread', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd)))
  await collect(router.run(request(cwd, { sessionId: 'session-2' })))
  const other = new EngineRouter({ ...config, ownerId: 'another-user:web' }, { codex: fakeEngine(calls) })
  await collect(other.run(request(cwd)))
  assert.deepEqual(calls.map(r => r.threadId), [null, null, null])
  assert.notEqual(router.store.path('session-1'), other.store.path('session-1'))
  assert.equal((await stat(router.store.path('session-1'))).mode & 0o777, 0o600)
})

test('new router instance resumes the saved thread and sends only new user input', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  await collect(new EngineRouter(config, { codex: fakeEngine(calls) }).run(request(cwd)))
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  const next = request(cwd)
  next.messages.push({ role: 'assistant', id: 'answer-1', content: [{ type: 'text', text: 'answer' }] })
  next.messages.push({ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'what color?' }] })
  await collect(router.run(next))
  assert.equal(calls[1].threadId, 'thread-session-1')
  assert.equal(calls[1].prompt, 'what color?')
  assert.equal((await router.store.read('session-1')).status, 'ready')
  await assert.rejects(collect(router.run(next)), { code: 'ENGINE_INPUT' })
  assert.equal(calls.length, 2)
})

test('bindings lock the managed engine, while community Claude stays outside this router', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd)))
  await assert.rejects(collect(router.run(request(cwd, { provider: 'claude-code' }))), { code: 'ENGINE_DISABLED' })
  await collect(router.run(request(cwd, {
    model: 'other-model',
    messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'continue' }] }],
  })))
  assert.equal(calls[1].threadId, 'thread-session-1')
  assert.equal(calls[1].model, 'other-model')
  assert.throws(() => assertEngineSwitch('glm', 'dsh-codex'), { code: 'ENGINE_SWITCH' })
  assert.throws(() => assertEngineSwitch('dsh-codex', 'glm'), { code: 'ENGINE_SWITCH' })
  assert.throws(() => assertEngineSwitch('claude-code', 'dsh-codex'), { code: 'ENGINE_SWITCH' })
  assert.throws(() => assertEngineSwitch('dsh-codex', 'claude-code'), { code: 'ENGINE_SWITCH' })
  assert.doesNotThrow(() => assertEngineSwitch('glm', 'deepseek'))
})

test('cross-process store lock rejects a simultaneous request', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  const release = await router.store.acquire('session-1', () => {})
  try {
    await assert.rejects(collect(new EngineRouter(config, { codex: fakeEngine() }).run(request(cwd))), { code: 'ENGINE_BUSY' })
  } finally { await release() }
  await collect(router.run(request(cwd)))
})

test('corrupt and uncertain state never silently starts a new thread', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd)))
  const state = await router.store.read('session-1')
  await router.store.write({ ...state, status: 'running' })
  await assert.rejects(collect(router.run(request(cwd))), { code: 'ENGINE_RECOVERY' })
  await writeFile(router.store.path('session-1'), 'broken')
  await assert.rejects(collect(router.run(request(cwd))), { code: 'ENGINE_STATE' })
  assert.equal(calls.length, 1)
})

test('resume error preserves the binding without a fallback or replay', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await collect(router.run(request(cwd)))
  let calls = 0
  router.engines.codex = { async *run() { calls++; throw new Error('refresh failed: secret') } }
  await assert.rejects(collect(router.run(request(cwd, {
    messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'next' }] }],
  }))))
  const state = await router.store.read('session-1')
  assert.equal(state.threadId, 'thread-session-1')
  assert.equal(state.status, 'uncertain')
  await assert.rejects(collect(router.run(request(cwd))), { code: 'ENGINE_RECOVERY' })
  assert.equal(calls, 1)
})

test('deliberate cancellation preserves thread and requires a new prompt', async t => {
  const { cwd, config } = await fixture(t)
  const controller = new AbortController()
  const router = new EngineRouter(config, {
    codex: { async *run(r) {
      await r.bindThread('cancel-thread')
      controller.abort()
      yield { type: 'text', text: 'partial' }
    } },
  })
  await assert.rejects(collect(router.run(request(cwd, { signal: controller.signal }))), { name: 'AbortError' })
  assert.equal((await router.store.read('session-1')).status, 'ready')
  await assert.rejects(collect(router.run(request(cwd))), { code: 'ENGINE_INPUT' })
  const calls = []
  router.engines.codex = fakeEngine(calls)
  await collect(router.run(request(cwd, {
    messages: [{ role: 'user', id: 'new-message', content: [{ type: 'text', text: 'check current state' }] }],
  })))
  assert.equal(calls[0].threadId, 'cancel-thread')
})

test('rejects symlink workspace escape, image blocks, anonymous input and oversized input', async t => {
  const { root, cwd, config } = await fixture(t)
  const router = new EngineRouter({ ...config, maxInputBytes: 5 }, { codex: fakeEngine() })
  const outside = join(cwd, 'escape')
  await symlink(root, outside)
  await assert.rejects(collect(router.run(request(outside))), { code: 'ENGINE_WORKSPACE' })
  await assert.rejects(collect(router.run(request(cwd))), { code: 'ENGINE_INPUT' })
  await assert.rejects(collect(router.run(request(cwd, {
    messages: [{ role: 'user', id: 'image', content: [{ type: 'image' }] }],
  }))), { code: 'ENGINE_ATTACHMENT' })
  await assert.rejects(collect(router.run(request(cwd, {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ok' }] }],
  }))), { code: 'ENGINE_INPUT' })
  assert.equal(await router.store.read('session-1'), undefined)
})

test('disk state contains ids only, not prompts or credentials', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await collect(router.run(request(cwd)))
  assert.equal((await readFile(router.store.path('session-1'), 'utf8')).includes('remember blue'), false)
  assert.throws(() => new ThreadStore('relative', 'user'))
  assert.throws(() => new ThreadStore(config.stateDir, ''))
})

test('errors are classified without disclosing provider diagnostics', () => {
  for (const [message, code] of [['401 secret', 'ENGINE_AUTH'], ['429 secret', 'ENGINE_QUOTA'], ['https://user:secret@proxy', 'ENGINE_FAILED']]) {
    const failure = engineFailure(new Error(message))
    assert.equal(failure.code, code)
    assert.equal(failure.message.includes('secret'), false)
  }
})

test('event queue drains, fails on oversized frames and wakes pending readers', async () => {
  const queue = new EventQueue()
  const stream = collect(queue)
  queue.push('hello')
  queue.end()
  assert.deepEqual(await stream, ['hello'])
  const oversized = new EventQueue()
  oversized.push('x'.repeat(9 * 1024 * 1024))
  await assert.rejects(collect(oversized), /limit/)
})

test('disposal cancels a pending approval and marks the interrupted turn uncertain', async t => {
  const { cwd, config } = await fixture(t)
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const router = new EngineRouter(config, {
    codex: { async *run(r) {
      await r.bindThread('approval-thread')
      await r.approve({ name: 'test', reason: 'test' })
      r.signal.throwIfAborted()
      yield { type: 'text', text: 'done' }
    } },
  })
  const result = collect(router.run(request(cwd, {
    approve: ({ signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => resolve(false), { once: true })
      entered()
    }),
  })))
  const rejected = assert.rejects(result, { name: 'AbortError' })
  await started
  await router.dispose()
  await rejected
  assert.equal((await router.store.read('session-1')).status, 'uncertain')
})

test('a failure before the engine receives the prompt is retryable, not uncertain', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await collect(router.run(request(cwd)))
  const next = request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'next' }] }] })
  router.engines.codex = { reportsDispatch: true, async *run() { throw new Error('workspace routing discovery timed out') } }
  await assert.rejects(collect(router.run(next)))
  const state = await router.store.read('session-1')
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.delivered, ['message-1'])
  const calls = []
  router.engines.codex = fakeEngine(calls)
  await collect(router.run(next))
  assert.equal(calls[0].prompt, 'next')
  assert.equal(calls[0].threadId, 'thread-session-1')
})

test('a failure after dispatch stays uncertain', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, {
    codex: { reportsDispatch: true, async *run(r) {
      await r.bindThread('t1')
      await r.onDispatch()
      throw new Error('stream broke')
    } },
  })
  await assert.rejects(collect(router.run(request(cwd))))
  assert.equal((await router.store.read('session-1')).status, 'uncertain')
})

function crashed(router) {
  router.engines.codex = { reportsDispatch: true, async *run(r) {
    await r.bindThread('thread-session-1')
    await r.onDispatch()
    throw new Error('app-server killed')
  } }
}

test('reconciliation recovers a completed crash answer and continues the thread', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd)))
  router.engines.codex = { reportsDispatch: true, async *run(r) { await r.onDispatch(); throw new Error('killed') } }
  const lost = request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost prompt' }] }] })
  await assert.rejects(collect(router.run(lost)))
  let state = await router.store.read('session-1')
  assert.equal(state.status, 'uncertain')
  assert.deepEqual(state.pending.messageIds, ['message-2'])
  router.engines.codex = {
    reconcile: async pending => {
      assert.deepEqual(pending.messageIds, ['message-2'])
      return { verdict: 'completed', turnId: 'turn-2', answerText: 'THE ANSWER' }
    },
    async *run(r) { calls.push(r); yield { type: 'text', text: 'fresh' } },
  }
  const events = await collect(router.run(request(cwd, { messages: [
    { role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost prompt' }] },
    { role: 'assistant', id: 'answer-2', content: [{ type: 'text', text: 'partial' }] },
    { role: 'user', id: 'message-3', content: [{ type: 'text', text: 'continue' }] },
  ] })))
  const text = events.filter(e => e.type === 'text').map(e => e.text).join('')
  assert.match(text, /【恢复】[\s\S]*THE ANSWER[\s\S]*fresh/)
  state = await router.store.read('session-1')
  assert.equal(state.status, 'ready')
  assert.equal(state.pending, undefined)
  assert.deepEqual(state.delivered, ['message-1', 'message-2', 'message-3'])
  assert.equal(calls.at(-1).prompt, 'continue')
})

test('failed and interrupted verdicts free the binding without resending', async t => {
  for (const verdict of ['failed', 'interrupted']) {
    const { cwd, config } = await fixture(t)
    const calls = []
    const router = new EngineRouter(config, { codex: fakeEngine(calls) })
    await collect(router.run(request(cwd)))
    crashed(router)
    await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost' }] }] }))))
    router.engines.codex = {
      reconcile: async () => ({ verdict }),
      async *run(r) { calls.push(r); yield { type: 'text', text: 'next' } },
    }
    const events = await collect(router.run(request(cwd, { messages: [
      { role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost' }] },
      { role: 'assistant', id: 'answer-2', content: [{ type: 'text', text: '' }] },
      { role: 'user', id: 'message-3', content: [{ type: 'text', text: 'next' }] },
    ] })))
    const text = events.map(e => e.text ?? '').join('')
    assert.match(text, /【恢复】/)
    assert.equal(text.includes('next'), true)
    assert.equal(calls.at(-1).prompt, 'next')
    const state = await router.store.read('session-1')
    assert.equal(state.status, 'ready')
    assert.deepEqual(state.delivered, ['message-1', 'message-2', 'message-3'])
  }
})

test('a missing verdict resends the pending batch, deduplicated against manual resends', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd)))
  crashed(router)
  await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost prompt' }] }] }))))
  router.engines.codex = {
    reconcile: async () => ({ verdict: 'missing' }),
    async *run(r) { calls.push(r); yield { type: 'text', text: 'done' } },
  }
  // The user also re-sent the identical text: only the newer copy goes out.
  await collect(router.run(request(cwd, { messages: [
    { role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost prompt' }] },
    { role: 'user', id: 'message-3', content: [{ type: 'text', text: 'lost prompt' }] },
  ] })))
  assert.equal(calls.at(-1).prompt, 'lost prompt')
  const state = await router.store.read('session-1')
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.delivered, ['message-1', 'message-2', 'message-3'])
})

test('a live pending process refuses instead of misjudging, then ages out', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await collect(router.run(request(cwd)))
  crashed(router)
  await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost' }] }] }))))
  const state = await router.store.read('session-1')
  await router.store.write({ ...state, pending: { ...state.pending, pid: process.pid, expiresAt: Date.now() + 60000 } })
  router.engines.codex = {
    reconcile: async () => assert.fail('must not reconcile a live process'),
    async *run() { assert.fail('must not dispatch') },
  }
  await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-3', content: [{ type: 'text', text: 'next' }] }] }))), { code: 'ENGINE_BUSY' })
  assert.equal((await router.store.read('session-1')).status, 'uncertain')
})

test('inconclusive reconciliation keeps the recovery refusal', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await collect(router.run(request(cwd)))
  crashed(router)
  await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'lost' }] }] }))))
  router.engines.codex = { reconcile: async () => ({ verdict: 'inconclusive' }) }
  await assert.rejects(collect(router.run(request(cwd, { messages: [{ role: 'user', id: 'message-3', content: [{ type: 'text', text: 'next' }] }] }))), { code: 'ENGINE_RECOVERY' })
  assert.equal((await router.store.read('session-1')).status, 'uncertain')
})

test('router.steer marks delivered on success and cleans up after the run', async t => {
  const { cwd, config } = await fixture(t)
  let portRef
  const router = new EngineRouter(config, { codex: { async *run(r) {
    await r.bindThread('thread-session-1')
    portRef = new SteerPort({ events: new EventQueueStub(), request: async () => ({ turnId: 't1' }) })
    r.onSteer?.(portRef)
    portRef.open('thread-session-1', 't1')
    await new Promise(resolve => setTimeout(resolve, 40))
    yield { type: 'text', text: 'answer' }
  } } })
  const runPromise = collect(router.run(request(cwd)))
  for (let i = 0; i < 100 && router.steering.size === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  const steered = await router.steer('session-1', { messageId: 'steered-1', text: '先看失败测试' })
  assert.equal(steered.status, 'steered')
  await runPromise
  assert.ok((await router.store.read('session-1')).delivered.includes('steered-1'))
  // The port leaves with the run: later steers find no active turn.
  assert.equal((await router.steer('session-1', { messageId: 'late', text: 'x' })).status, 'no-active-turn')
  assert.equal(portRef.closed, true)
})

test('router.steer rejects oversized text while a turn is running', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: { async *run(r) {
    await r.bindThread('thread-session-1')
    const port = new SteerPort({ events: new EventQueueStub(), request: async () => assert.fail('must not reach Codex') })
    r.onSteer?.(port)
    port.open('thread-session-1', 't1')
    await new Promise(resolve => setTimeout(resolve, 40))
    yield { type: 'text', text: 'answer' }
  } } })
  const runPromise = collect(router.run(request(cwd)))
  for (let i = 0; i < 100 && router.steering.size === 0; i += 1) await new Promise(resolve => setTimeout(resolve, 5))
  const outcome = await router.steer('session-1', { messageId: 'big', text: 'x'.repeat(config.maxInputBytes + 1) })
  assert.equal(outcome.status, 'rejected')
  await runPromise
  assert.equal((await router.store.read('session-1')).delivered.includes('big'), false)
})

class EventQueueStub {
  items = []
  push(value) { this.items.push(value) }
  end() {}
}

const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const PNG_REF = { attachmentId: 'sha256:deadbeef', mediaType: 'image/png', bytes: PNG_BYTES.length, width: 1, height: 1, name: 'shot.png' }

function attachmentsStub() {
  return {
    async readImage(ref) { return { ref, data: new Uint8Array(PNG_BYTES) } },
    imageHostPath: ref => `/var/lib/dsh/attachments/objects/aa/${String(ref.attachmentId).slice(7)}`,
  }
}

test('live images stage before dispatch and travel as named manifest entries', async t => {
  const { root, cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  const request1 = request(cwd, {
    imageCapable: true,
    dsh: { ctx: { get: name => (name === 'attachments' ? attachmentsStub() : undefined) } },
    messages: [{ role: 'user', id: 'image-1', content: [
      { type: 'text', text: 'what is in these' },
      { type: 'image', attachment: PNG_REF },
      { type: 'image', attachment: { ...PNG_REF, name: 'same-bytes.png' } },
    ] }],
  })
  await collect(router.run(request1))
  const call = calls.at(-1)
  assert.equal(call.images.length, 2)
  assert.equal(call.images[0].path, call.images[1].path) // same bytes, one staged file
  assert.match(call.prompt, /# 用户提供的图片:/)
  assert.match(call.prompt, /## 图1 shot\.png: /)
  assert.match(call.prompt, /## 我的请求:\nwhat is in these/)
  const state = await router.store.read('session-1')
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.delivered, ['image-1'])
  // A follow-up text turn never restages or resends the image.
  const textCall = []
  router.engines.codex = fakeEngine(textCall)
  await collect(router.run(request(cwd, { messages: [
    { role: 'user', id: 'image-1', content: [{ type: 'image', attachment: PNG_REF }] },
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'a picture' }] },
    { role: 'user', id: 'text-1', content: [{ type: 'text', text: 'go on' }] },
  ] })))
  assert.equal(textCall[0].images, undefined)
  assert.equal(textCall[0].prompt, 'go on')
})

test('offloaded images become recovery text and never stage', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd, {
    dsh: { ctx: { get: name => (name === 'attachments' ? attachmentsStub() : undefined) } },
    messages: [{ role: 'user', id: 'off-1', content: [
      { type: 'image', attachment: PNG_REF, offloaded: true },
      { type: 'text', text: 'continue' },
    ] }],
  })))
  assert.equal(calls[0].images, undefined)
  assert.match(calls[0].prompt, /image omitted to fit request image limits/)
  assert.match(calls[0].prompt, /read-only; may be resized/)
})

test('image handling fails closed without capability, service or budget', async t => {
  const { cwd, config } = await fixture(t)
  const withImage = extra => request(cwd, { messages: [{ role: 'user', id: 'i1', content: [
    { type: 'text', text: 'look' }, { type: 'image', attachment: PNG_REF },
  ] }], ...extra })
  const router = new EngineRouter(config, { codex: fakeEngine() })
  await assert.rejects(collect(router.run(withImage({ imageCapable: false }))), { code: 'ENGINE_ATTACHMENT' })
  await assert.rejects(collect(router.run(withImage({ imageCapable: true }))), { code: 'ENGINE_ATTACHMENT' }) // no attachments service
  const many = []
  for (let i = 0; i < 21; i += 1) many.push({ type: 'image', attachment: { ...PNG_REF, attachmentId: `sha256:${i}` } })
  const bounded = new EngineRouter({ ...config, codex: { maxImagesPerTurn: 2 } }, { codex: fakeEngine() })
  await assert.rejects(collect(router.run(request(cwd, { imageCapable: true, dsh: { ctx: { get: () => attachmentsStub() } }, messages: [{ role: 'user', id: 'many', content: many }] }))), { code: 'ENGINE_IMAGE_COUNT' })
  await assert.rejects(collect(bounded.run(request(cwd, { imageCapable: true, dsh: { ctx: { get: () => attachmentsStub() } }, messages: [{ role: 'user', id: 'many', content: many.slice(0, 3) }] }))), { code: 'ENGINE_IMAGE_COUNT' })
})

test('an image-only message passes with an empty text prompt', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: fakeEngine(calls) })
  await collect(router.run(request(cwd, {
    imageCapable: true,
    dsh: { ctx: { get: name => (name === 'attachments' ? attachmentsStub() : undefined) } },
    messages: [{ role: 'user', id: 'only-1', content: [{ type: 'image', attachment: PNG_REF }] }],
  })))
  assert.equal(calls[0].images.length, 1)
  assert.match(calls[0].prompt, /## 我的请求:\n$/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexEngine, SteerPort, launchArgs } from '../lib/codex.js'
import { EventQueue } from '../lib/queue.js'
import { fixture, collect, request } from './helpers.js'

function engine(root, env = {}) {
  return new CodexEngine({
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
    env: { FIXTURE_STATE_DIR: root, ...env }, rpcTimeoutMs: 3000,
  })
}

function processAlive(pid) {
  try { process.kill(pid, 0) } catch { return false }
  // Linux may retain a killed orphan as a zombie until the container init
  // reaps it. It is terminated even though kill(0) still succeeds.
  if (process.platform === 'linux') {
    try {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ', 2)[1]?.[0]
      if (state === 'Z') return false
    } catch {}
  }
  return true
}

test('native multi-agent is opt-in and overrides the hardened feature denylist', () => {
  const disabled = launchArgs({ hardening: true, disableShellSnapshot: true, multiAgent: { enabled: false } })
  assert.ok(disabled.includes('-c') && disabled.includes('features.multi_agent=false'))
  const enabled = launchArgs({ hardening: true, disableShellSnapshot: true, multiAgent: { enabled: true } })
  assert.equal(enabled.filter(value => value === 'features.multi_agent=false').length, 0)
  assert.ok(enabled.includes('features.multi_agent=true'))
})

test('native multi-agent execution limits reach app-server with and without hardening', () => {
  for (const hardening of [true, false]) {
    const args = launchArgs({ hardening, disableShellSnapshot: false,
      multiAgent: { enabled: true, maxAgents: 2, maxDepth: 1 } })
    assert.ok(args.includes('features.multi_agent=true'))
    assert.ok(args.includes('agents.max_threads=2'))
    assert.ok(args.includes('agents.max_depth=1'))
  }
  const defaults = launchArgs({ multiAgent: { enabled: true } })
  assert.ok(defaults.includes('agents.max_threads=4'))
  assert.ok(defaults.includes('agents.max_depth=2'))
  assert.equal(launchArgs({ multiAgent: { enabled: false } }).some(arg => arg.startsWith('agents.')), false)
})

test('real stdio process streams and resumes the same thread without duplicate text', async t => {
  const { root, cwd } = await fixture(t)
  let threadId
  const run = request(cwd, { prompt: 'remember blue', bindThread: async id => { threadId = id } })
  const first = await collect(engine(root).run(run))
  assert.equal(first.filter(e => e.type === 'text').map(e => e.text).join(''), 'streamed response\n\n')
  const resumed = await collect(engine(root).run({ ...run, threadId, prompt: 'what color?' }))
  assert.equal(resumed.map(e => e.text).join(''), 'remember blue\n\n')
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(calls.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(calls.filter(c => c.method === 'thread/resume').length, 1)
  assert.equal(calls.find(c => c.method === 'thread/start').params.sandbox, 'read-only')
  assert.equal(calls.find(c => c.method === 'turn/start').params.sandboxPolicy.networkAccess, false)
})

test('approval grants only this operation and default denial is preserved', async t => {
  const { root, cwd } = await fixture(t)
  for (const allowed of [true, false]) {
    const events = await collect(engine(root).run(request(cwd, {
      prompt: 'approval', bindThread: async () => {}, approve: async () => allowed,
    })))
    assert.equal(events.map(e => e.text).join(''), `${allowed ? 'accept' : 'decline'}\n\n`)
  }
})

test('approval requests carry bilingual human-readable displayReason', async t => {
  const { root, cwd } = await fixture(t)
  const seen = []
  await collect(engine(root).run(request(cwd, {
    prompt: 'approval', bindThread: async () => {}, approve: async req => {
      seen.push(req)
      return true
    },
  })))
  assert.equal(seen.length, 1)
  const display = seen[0].display
  assert.equal(typeof display.en, 'string')
  assert.match(display.zh, /Codex 请求执行命令/)
  assert.match(display.zh, /命令：test command/)
  assert.match(display.zh, /理由：fixture/)
  assert.match(display.en, /Command: test command/)
  // The audit reason stays structured JSON; displayReason is presentation-only.
  assert.equal(JSON.parse(seen[0].reason).command, 'test command')
})

test('unauthenticated engine fails before starting a thread', async t => {
  const { root, cwd } = await fixture(t)
  await assert.rejects(collect(engine(root, { FIXTURE_UNAUTH: '1' }).run(request(cwd, {
    prompt: 'hello', bindThread: async () => assert.fail('must not bind'),
  }))), { code: 'ENGINE_AUTH' })
  assert.equal((await readFile(join(root, 'calls.jsonl'), 'utf8')).includes('thread/start'), false)
})

test('missing thread rejects instead of falling back to a fresh thread', async t => {
  const { root, cwd } = await fixture(t)
  await assert.rejects(collect(engine(root).run(request(cwd, {
    threadId: 'missing', prompt: 'hello', bindThread: async () => assert.fail('must not bind'),
  }))))
  assert.equal((await readFile(join(root, 'calls.jsonl'), 'utf8')).includes('thread/start'), false)
})

test('external tool lifecycle is surfaced without being emitted as a second tool call', async t => {
  const { root, cwd } = await fixture(t)
  const events = await collect(engine(root).run(request(cwd, {
    prompt: 'tool', bindThread: async () => {},
  })))
  const starts = events.filter(event => event.type === 'tool-start')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].name, 'codex:commandExecution')
  assert.equal(starts[0].arguments, JSON.stringify({ command: 'printf tool-output', actions: ['unknown'] }))
  assert.deepEqual(events.filter(event => event.type === 'tool-end').map(event => ({
    type: event.type, output: event.output, isError: event.isError,
  })), [{ type: 'tool-end', output: 'tool-output', isError: false }])
  assert.equal(events.some(event => event.type === 'activity'), false)
})

test('native Codex sub-agent lifecycle is surfaced as bounded events', async t => {
  const { root, cwd } = await fixture(t)
  const events = await collect(new CodexEngine({
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
    env: { FIXTURE_STATE_DIR: root }, rpcTimeoutMs: 3000,
    multiAgent: { enabled: true, mode: 'explicit', maxAgents: 4, maxDepth: 2 },
  }).run(request(cwd, { prompt: 'multi-agent', bindThread: async () => {} })))
  const subagents = events.filter(event => event.type === 'subagent')
  assert.equal(subagents.length, 4)
  assert.equal(subagents[0].kind, 'spawnAgent')
  assert.equal(subagents[0].receiverThreadIds[0], 'child-1')
  assert.equal(subagents[1].kind, 'started')
  assert.equal(subagents[2].kind, 'completed')
  assert.equal(subagents[3].status, 'completed')
  assert.equal(events.at(-1).type, 'turn')
})

test('malformed Codex thread responses fail closed at the protocol boundary', async t => {
  const { root, cwd } = await fixture(t)
  await assert.rejects(collect(engine(root, { FIXTURE_BAD_THREAD: '1' }).run(request(cwd, {
    prompt: 'hello', bindThread: async () => assert.fail('must not bind'),
  }))), { code: 'ENGINE_PROTOCOL' })
})

for (const prompt of ['hang', 'stubborn']) test(`cancellation terminates the owned server and its ${prompt} child`, async t => {
  const { root, cwd } = await fixture(t)
  const controller = new AbortController()
  const result = collect(engine(root).run(request(cwd, {
    prompt, signal: controller.signal, bindThread: async () => {},
  })))
  const rejected = assert.rejects(result, { name: 'AbortError' })
  let childPid
  for (let i = 0; i < 100; i++) {
    try { childPid = Number(await readFile(join(root, 'child.pid'), 'utf8')); break } catch { await delay(20) }
  }
  assert.ok(childPid)
  controller.abort()
  await rejected
  const serverPid = Number(await readFile(join(root, 'server.pid'), 'utf8'))
  for (let i = 0; i < 100; i++) {
    if (!processAlive(childPid)) break
    await delay(20)
  }
  assert.equal(processAlive(serverPid), false)
  assert.equal(processAlive(childPid), false)
})

function portStub(behavior) {
  const events = new EventQueue()
  const requests = []
  return {
    events,
    requests,
    port: new SteerPort({ events, request: async (method, params) => {
      requests.push({ method, params })
      return behavior(params)
    } }),
  }
}

test('steer port buffers before the turn opens and flushes in order', async () => {
  const { events, requests, port } = portStub(() => ({ turnId: 't1' }))
  assert.equal(await port.admit({ text: 'first' }), 'buffered')
  assert.equal(await port.admit({ text: 'second' }), 'buffered')
  assert.equal(requests.length, 0)
  port.open('thread-1', 't1')
  await port.chain ?? Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(requests.map(r => r.params.input[0].text), ['first', 'second'])
  assert.ok(requests.every(r => r.params.expectedTurnId === 't1' && r.params.threadId === 'thread-1'))
  const notes = events.items.map(i => i.value)
  assert.deepEqual(notes.map(n => n.params.kind), ['steered', 'steered'])
  events.end()
})

test('steer port failures degrade softly and close drops the buffer', async () => {
  const { events, requests, port } = portStub(() => { throw new Error('no active turn to steer') })
  port.open('thread-1', 't1')
  const outcome = await port.admit({ text: 'late', clientUserMessageId: 'req-9' })
  assert.equal(outcome, 'failed')
  const note = events.items.at(-1).value
  assert.equal(note.method, 'steer/note')
  assert.equal(note.params.kind, 'steer-failed')
  assert.match(note.params.message, /no active turn/)
  assert.equal(requests[0].params.clientUserMessageId, 'req-9')
  port.close()
  assert.equal(await port.admit({ text: 'after close' }), 'closed')
  assert.equal(requests.length, 1)
  events.end()
})

test('launchArgs passes webSearch through and stays silent when disabled', async () => {
  const { launchArgs } = await import('../lib/codex.js')
  const off = launchArgs({ webSearch: 'disabled' })
  assert.equal(off.some(arg => arg.startsWith('web_search')), false)
  const on = launchArgs({ webSearch: 'live' })
  const at = on.indexOf('web_search=live')
  assert.ok(at > 0 && on[at - 1] === '-c')
})

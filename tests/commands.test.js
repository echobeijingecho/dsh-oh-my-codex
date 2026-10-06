import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { CodexEngine } from '../lib/codex.js'
import { formatCompactResult, formatStatus, parseReviewTarget } from '../lib/commands.js'
import { EngineRouter } from '../lib/router.js'
import { fixture, collect } from './helpers.js'

function request(cwd, changes = {}) {
  return {
    provider: 'dsh-codex', model: 'fixture-model', sessionId: 'session-1', cwd,
    signal: new AbortController().signal,
    messages: [{ role: 'user', id: 'message-1', content: [{ type: 'text', text: 'remember blue' }] }],
    permission: { sandbox: 'read-only', approval: 'never' },
    bindThread: async () => {}, ...changes,
  }
}

function engine(root, env = {}) {
  return new CodexEngine({
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
    env: { FIXTURE_STATE_DIR: root, ...env }, rpcTimeoutMs: 3000,
  })
}

const REVIEW_REQUEST = (cwd, threadId, extra = {}) => ({
  model: 'fixture-model', cwd, threadId, signal: new AbortController().signal,
  permission: { sandbox: 'read-only', approval: 'never' },
  target: { type: 'uncommittedChanges' }, ...extra,
})

test('review target grammar maps every accepted form', () => {
  assert.deepEqual(parseReviewTarget(''), { type: 'uncommittedChanges' })
  assert.deepEqual(parseReviewTarget('base main'), { type: 'baseBranch', branch: 'main' })
  assert.deepEqual(parseReviewTarget('commit abc123'), { type: 'commit', sha: 'abc123', title: null })
  assert.deepEqual(parseReviewTarget('关注并发安全'), { type: 'custom', instructions: '关注并发安全' })
  assert.equal(parseReviewTarget('base').usage, true)
  assert.equal(parseReviewTarget('commit').usage, true)
})

test('compact result copy reports tokens and savings', () => {
  const text = formatCompactResult(50000, 5000)
  assert.match(text, /50,000 → 5,000 tokens（约释放 90%）/)
  assert.match(formatCompactResult(null, null), /— → —/)
})

test('status copy renders probe, binding and surface counts', () => {
  const text = formatStatus({
    probe: { ok: true, email: 'u@example.com', planType: 'pro', rateLimits: { primary: { usedPercent: 42 } } },
    binding: { threadId: 'a1b2c3d4e5f6', model: 'gpt-5.2-codex', status: 'ready', delivered: ['m1', 'm2'] },
  })
  assert.match(text, /已连接/)
  assert.match(text, /u@example.com/)
  assert.match(text, /主窗口已用 42%/)
  assert.match(text, /a1b2c3d4/)
  assert.match(text, /已投递 2 条/)
})

test('review streams the server-rendered findings for the bound thread', async t => {
  const { root, cwd } = await fixture(t)
  const first = await collect(engine(root).run(request(cwd)))
  const threadId = first.find(e => e.type === 'turn').threadId
  const events = await collect(engine(root, { FIXTURE_RESUME_USAGE: '1' }).review(REVIEW_REQUEST(cwd, threadId)))
  assert.match(events.find(e => e.type === 'review').text, /- Prefer Stylize helpers — \/tmp\/f\.rs:10-20/)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const review = calls.find(c => c.method === 'review/start')
  assert.equal(review.params.delivery, 'inline')
  assert.deepEqual(review.params.target, { type: 'uncommittedChanges' })
  assert.equal(review.params.threadId, threadId)
})

test('review failures map through the existing error table', async t => {
  const { root, cwd } = await fixture(t)
  const first = await collect(engine(root).run(request(cwd)))
  const threadId = first.find(e => e.type === 'turn').threadId
  await assert.rejects(collect(engine(root, { FIXTURE_REVIEW_FAIL: '1' }).review(REVIEW_REQUEST(cwd, threadId))), { code: 'ENGINE_QUOTA' })
})

test('compact reads before/after context and reports the turn', async t => {
  const { root, cwd } = await fixture(t)
  const first = await collect(engine(root).run(request(cwd)))
  const threadId = first.find(e => e.type === 'turn').threadId
  const events = await collect(engine(root, { FIXTURE_RESUME_USAGE: '1' }).compact({
    model: 'fixture-model', cwd, threadId, signal: new AbortController().signal,
    permission: { sandbox: 'read-only', approval: 'never' },
  }))
  const compacted = events.find(e => e.type === 'compacted')
  assert.equal(compacted.before, 50000)
  assert.equal(compacted.after, 5000)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.ok(calls.some(c => c.method === 'thread/compact/start' && c.params.threadId === threadId))
})

test('router.command holds the store lock, requires a ready binding and changes no state', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: {
    async *run(r) { calls.push(r); await r.bindThread('thread-session-1'); yield { type: 'text', text: 'ok' } },
    async *review(r) { calls.push(r); yield { type: 'review', text: 'fine' } },
  } })
  await collect(router.run(request(cwd)))
  const events = await collect(router.command({
    sessionId: 'session-1', engine: 'codex', kind: 'review',
    signal: new AbortController().signal, cwd, threadId: 'thread-session-1', model: 'test-model',
  }))
  assert.equal(events.find(e => e.type === 'review').text, 'fine')
  const state = await router.store.read('session-1')
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.delivered, ['message-1'])
  // A held lock rejects a concurrent command.
  const release = await router.store.acquire('session-1', () => {})
  try {
    await assert.rejects(collect(router.command({
      sessionId: 'session-1', engine: 'codex', kind: 'review',
      signal: new AbortController().signal, cwd, threadId: 'thread-session-1', model: 'test-model',
    })), { code: 'ENGINE_BUSY' })
  } finally { await release() }
})

test('compact-checkpoint messages never reach the Codex prompt', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: {
    async *run(r) { calls.push(r); await r.bindThread('thread-session-1'); yield { type: 'text', text: 'ok' } },
  } })
  await collect(router.run(request(cwd)))
  await collect(router.run(request(cwd, { messages: [
    { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'prior answer' }] },
    { role: 'user', id: 'checkpoint-1', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'SURFACE COMPACTION SUMMARY' }] },
    { role: 'user', id: 'message-2', content: [{ type: 'text', text: 'next question' }] },
  ] })))
  assert.equal(calls.at(-1).prompt, 'next question')
})

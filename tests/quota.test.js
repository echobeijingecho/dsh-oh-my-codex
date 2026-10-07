import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  mergeRateLimits, exhaustedShortWindow, cancellableDelay, quotaRetryId,
  QUOTA_RETRY_MARGIN_MS,
} from '../lib/quota.js'

const root = fileURLToPath(new URL('.', import.meta.url))

test('mergeRateLimits keeps absent windows and overwrites present ones', () => {
  const previous = {
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1000 },
    secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 2000 },
    planType: 'pro',
  }
  const merged = mergeRateLimits(previous, {
    primary: { usedPercent: 95, windowDurationMins: 300, resetsAt: 1500 },
  })
  assert.equal(merged.primary.usedPercent, 95)
  assert.equal(merged.primary.resetsAt, 1500)
  assert.deepEqual(merged.secondary, previous.secondary)
  assert.equal(merged.planType, 'pro')
})

test('mergeRateLimits ignores malformed windows', () => {
  assert.equal(mergeRateLimits(null, undefined), null)
  assert.equal(mergeRateLimits(null, {}), null)
  assert.equal(mergeRateLimits(null, { primary: { usedPercent: 'x' } }), null)
  assert.equal(mergeRateLimits({ primary: { usedPercent: 1 } }, { primary: null }).primary.usedPercent, 1)
})

test('exhaustedShortWindow selects a recoverable short window', () => {
  const snapshot = {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 600 },
  }
  const verdict = exhaustedShortWindow(snapshot)
  assert.equal(verdict.exhaustedLongWindow, false)
  assert.equal(verdict.windowMins, 300)
})

test('exhaustedShortWindow reports long windows instead of selecting them', () => {
  const snapshot = {
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 600 },
  }
  assert.equal(exhaustedShortWindow(snapshot)?.exhaustedLongWindow, true)
})

test('exhaustedShortWindow ignores expired resets and non-exhausted windows', () => {
  assert.equal(exhaustedShortWindow({
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) - 10 },
  }), null)
  assert.equal(exhaustedShortWindow({
    primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 600 },
  }), null)
})

test('cancellableDelay resolves and aborts', async () => {
  const keep = setInterval(() => {}, 60_000)
  try {
    await cancellableDelay(5)
    const controller = new AbortController()
    const promise = cancellableDelay(60_000, controller.signal)
    controller.abort()
    await assert.rejects(promise, error => error.name === 'AbortError')
  } finally { clearInterval(keep) }
})

test('quota retry ids are unique and marked', () => {
  assert.match(quotaRetryId(), /^erq-[0-9a-f-]{36}$/)
  assert.notEqual(quotaRetryId(), quotaRetryId())
  assert.equal(QUOTA_RETRY_MARGIN_MS, 30_000)
})

// The browser-side pill must not regress the settings bundle contract.
test('client bundle still parses as a module', () => {
  const client = join(root, '..', 'lib', 'client.js')
  execFileSync(process.execPath, ['--check', client], { stdio: 'ignore' })
})

test('registerQuotaRetry schedules one wait and returns retry', async t => {
  const keep = setInterval(() => {}, 60_000)
  t.after(() => clearInterval(keep))
  const { registerQuotaRetry } = await import('../lib/quota-retry.js')
  const appended = []
  const agent = {
    session: {
      append: (type, data) => appended.push({ type, data }),
      snapshotEvents: () => [],
    },
  }
  let handler
  const ctx = { on: (event, fn) => { handler = fn; return () => {} } }
  const recorded = []
  const diagnostics = { record: (code, detail) => recorded.push(code) }
  const dispose = registerQuotaRetry(ctx, {
    codex: { enabled: true, quotaRetryMaxWaitMins: 360 },
    providers: { codex: 'dsh-codex', gateway: 'dsh-codex-gateway' },
  }, diagnostics)
  assert.equal(typeof handler, 'function')

  let passed = false
  const next = () => { passed = true; return { kind: 'continue' } }
  // Non-quota failures pass straight through.
  const passthrough = await handler({ agent, turn: 1, step: 0, provider: 'dsh-codex', failure: { code: 'ENGINE_UPSTREAM' }, signal: undefined }, next)
  assert.equal(passthrough.kind, 'continue')
  // Non-managed providers pass through.
  assert.equal((await handler({ agent, turn: 1, step: 0, provider: 'glm', failure: { code: 'ENGINE_QUOTA', providerRetryAfterMs: 50 } }, next)).kind, 'continue')
  // Over-budget waits pass through.
  assert.equal((await handler({ agent, turn: 1, step: 0, provider: 'dsh-codex', failure: { code: 'ENGINE_QUOTA', providerRetryAfterMs: 360 * 60_000 + 1 } }, next)).kind, 'continue')

  const action = await handler({
    agent, turn: 1, step: 0, provider: 'dsh-codex',
    failure: { code: 'ENGINE_QUOTA', message: 'exhausted', providerRetryAfterMs: 50 },
    signal: new AbortController().signal,
  }, next)
  assert.deepEqual(action, { kind: 'retry' })
  assert.equal(appended[0].type, 'llm/retry')
  assert.match(appended[0].data.retryId, /^erq-/)
  assert.equal(appended[1].type, 'llm/retry-started')
  assert.deepEqual(recorded, ['ENGINE_QUOTA_RETRY'])
  // A second wait for the same turn+step is refused (durable idempotency).
  agent.session.snapshotEvents = () => [{ type: 'llm/retry', data: { turn: 1, step: 0 } }]
  assert.equal((await handler({
    agent, turn: 1, step: 0, provider: 'dsh-codex',
    failure: { code: 'ENGINE_QUOTA', providerRetryAfterMs: 50 },
  }, next)).kind, 'continue')
  // Abort during the wait cancels the retry.
  agent.session.snapshotEvents = () => []
  const controller = new AbortController()
  const waiting = handler({
    agent, turn: 2, step: 0, provider: 'dsh-codex',
    failure: { code: 'ENGINE_QUOTA', providerRetryAfterMs: 60_000 },
    signal: controller.signal,
  }, next)
  controller.abort()
  assert.equal(await waiting, undefined)
  dispose()
})

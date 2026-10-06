import test from 'node:test'
import assert from 'node:assert/strict'
import { createDshSubscriptionAuthBroker } from '../lib/auth-broker.js'

function credential(overrides = {}) {
  return {
    type: 'oauth',
    access: 'access-1',
    refresh: 'refresh-1',
    expires: Date.now() + 60_000,
    accountId: 'acct-1',
    ...overrides,
  }
}

function service(values) {
  return {
    async resolve(ref) {
      const value = values[ref]
      return value === undefined ? undefined : { value, source: 'test' }
    },
  }
}

test('shared auth reads the subscription credential and returns App Server tokens', async () => {
  const expires = Date.now() + 60_000
  const broker = createDshSubscriptionAuthBroker(service({
    WSL043_OPENAI_CODEX_OAUTH: JSON.stringify(credential({ expires })),
  }))
  assert.deepEqual(await broker.status(), {
    authenticated: true,
    provider: 'openai-codex',
    type: 'oauth',
    accountId: 'acct-1',
    expiresAt: expires,
  })
  assert.deepEqual(await broker.tokens(), {
    accessToken: 'access-1',
    chatgptAccountId: 'acct-1',
  })
  assert.equal(await broker.loginHint(), '已复用「Codex 订阅」登录')
})

test('shared auth delegates refresh and preserves account identity', async () => {
  let seen
  const broker = createDshSubscriptionAuthBroker(service({
    OPENAI_CODEX_SUBSCRIPTION_OAUTH: JSON.stringify(credential({ expires: Date.now() - 1 })),
  }), {
    refreshCredential: async (current, options) => {
      seen = { current, options }
      return credential({ access: 'access-2', refresh: 'refresh-2' })
    },
  })
  assert.deepEqual(await broker.refresh({ previousAccountId: 'acct-1' }), {
    accessToken: 'access-2',
    chatgptAccountId: 'acct-1',
  })
  assert.equal(seen.current.access, 'access-1')
  assert.equal(seen.options.signal, undefined)
})

test('shared auth reuses a token refreshed by the subscription plugin', async () => {
  const records = {
    OPENAI_CODEX_SUBSCRIPTION_OAUTH: credential({ expires: Date.now() - 1 }),
  }
  const broker = createDshSubscriptionAuthBroker(service(records))
  await broker.tokens()
  records.OPENAI_CODEX_SUBSCRIPTION_OAUTH = JSON.stringify(
    credential({ access: 'access-refreshed', refresh: 'refresh-refreshed' }),
  )
  assert.deepEqual(await broker.refresh({ previousAccountId: 'acct-1' }), {
    accessToken: 'access-refreshed',
    chatgptAccountId: 'acct-1',
  })
})

test('shared auth reports no login without a valid subscription record', async () => {
  const broker = createDshSubscriptionAuthBroker(service({}))
  assert.deepEqual(await broker.status(), { authenticated: false, provider: 'openai-codex' })
  assert.equal(await broker.tokens(), undefined)
  assert.equal(await broker.loginHint(), '请先在「Codex 订阅」中完成登录')
})

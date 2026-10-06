import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AccountService } from '../lib/account.js'
import { preflight } from '../lib/codex.js'
import { Diagnostics } from '../lib/diagnostics.js'
import { createHandler } from '../lib/http.js'
import { fixture } from './helpers.js'

const SERVER = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))
const config = (root, env = {}) => ({ command: process.execPath, args: [SERVER], env: { FIXTURE_STATE_DIR: root, ...env }, rpcTimeoutMs: 3000 })

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return
    await delay(20)
  }
  assert.fail('condition not reached')
}

async function methods(root) {
  return (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).method)
}

test('device-code login returns the code, then refreshes status once Codex reports success', async t => {
  const { root, cwd } = await fixture(t)
  let refreshed = 0
  const account = new AccountService(config(root, { FIXTURE_UNAUTH: '1' }), cwd, { refresh: async () => { refreshed++ } })
  t.after(() => account.dispose())
  const view = await account.startLogin()
  assert.deepEqual({ state: view.state, userCode: view.userCode, verificationUrl: view.verificationUrl },
    { state: 'pending', userCode: 'ABCD-1234', verificationUrl: 'https://auth.example/device' })
  assert.equal((await account.startLogin()).userCode, 'ABCD-1234', 'a second start reuses the pending login')
  await until(() => account.loginView().state === 'succeeded' && refreshed === 1)
  assert.equal((await preflight(config(root, { FIXTURE_UNAUTH: '1' }), cwd)).signedIn, true)
  assert.equal((await methods(root)).filter(m => m === 'account/login/start').length, 1)
})

test('a failed login is reported redacted and recorded for operators', async t => {
  const { root, cwd } = await fixture(t)
  const codes = []
  const account = new AccountService(config(root, { FIXTURE_LOGIN_FAIL: '1' }), cwd, { onDiagnostic: code => codes.push(code) })
  await account.startLogin()
  await until(() => account.loginView().state === 'failed')
  assert.match(account.loginView().error, /token exchange failed/)
  assert.doesNotMatch(account.loginView().error, /u:p@/)
  assert.deepEqual(codes, ['ENGINE_LOGIN_FAILED'])
})

test('a pending login can be cancelled and logout clears the account', async t => {
  const { root, cwd } = await fixture(t)
  let refreshed = 0
  const account = new AccountService(config(root, { FIXTURE_LOGIN_HOLD: '1' }), cwd, { refresh: async () => { refreshed++ } })
  await account.startLogin()
  assert.equal((await account.cancelLogin()).state, 'cancelled')
  await account.logout()
  assert.equal(refreshed, 1)
  assert.ok((await methods(root)).includes('account/login/cancel'))
  assert.ok((await methods(root)).includes('account/logout'))
  assert.equal((await preflight(config(root), cwd)).signedIn, false)
})

test('preflight reports account identity and quota windows', async t => {
  const { root, cwd } = await fixture(t)
  const result = await preflight(config(root), cwd)
  assert.equal(result.email, 'user@example.com')
  assert.equal(result.planType, 'pro')
  assert.deepEqual(result.rateLimits.primary, { usedPercent: 20, windowDurationMins: 300, resetsAt: 1791000000 })
  assert.equal(result.rateLimits.secondary.windowDurationMins, 10080)
})

function call(handler, method, path, headers = {}) {
  return new Promise(resolve => {
    const res = {
      writeHead(code) { this.code = code },
      end(body) { resolve({ code: this.code, body: JSON.parse(body) }) },
    }
    handler({ method, url: path, headers, resume() {} }, res)
  })
}

test('settings API exposes status and requires JSON for state changes', async t => {
  const { root, cwd } = await fixture(t)
  const diagnostics = new Diagnostics(undefined)
  let refreshed = 0
  const account = new AccountService(config(root, { FIXTURE_LOGIN_HOLD: '1' }), cwd)
  t.after(() => account.dispose())
  const handler = createHandler({ diagnostics, account, refresh: async () => { refreshed++ } })
  const status = await call(handler, 'GET', '/dsh-oh-my-codex/api/status')
  assert.equal(status.code, 200)
  assert.equal(status.body.status.state, 'not-started')
  assert.equal(status.body.login, null)
  assert.equal((await call(handler, 'POST', '/dsh-oh-my-codex/api/login/start')).code, 415)
  const json = { 'content-type': 'application/json' }
  const started = await call(handler, 'POST', '/dsh-oh-my-codex/api/login/start', json)
  assert.equal(started.body.login.userCode, 'ABCD-1234')
  assert.equal((await call(handler, 'GET', '/dsh-oh-my-codex/api/status')).body.login.state, 'pending')
  assert.equal((await call(handler, 'POST', '/dsh-oh-my-codex/api/login/cancel', json)).body.login.state, 'cancelled')
  assert.equal((await call(handler, 'POST', '/dsh-oh-my-codex/api/refresh', json)).code, 200)
  assert.equal(refreshed, 1)
  assert.equal((await call(handler, 'GET', '/dsh-oh-my-codex/api/nope')).code, 404)
  assert.doesNotMatch(JSON.stringify(started.body), /token|secret/i)
})

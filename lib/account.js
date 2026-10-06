import { AppServer } from './codex.js'
import { EngineError } from './errors.js'
import { redact } from './diagnostics.js'
import { CLIENT_INFO } from './identity.js'

const LOGIN_TTL_MS = 15 * 60 * 1000

/**
 * Codex sign-in for this instance's CODEX_HOME, driven through the App Server
 * account API (`account/login/start` with `chatgptDeviceCode`). The App Server
 * writes CODEX_HOME/auth.json itself; tokens never pass through this plugin or
 * the browser. One login session at a time.
 */
export class AccountService {
  login = null

  constructor(config, cwd, { refresh, onDiagnostic } = {}) {
    this.config = config
    this.cwd = cwd
    this.refresh = refresh ?? (async () => {})
    this.onDiagnostic = onDiagnostic ?? (() => {})
  }

  loginView() {
    if (!this.login) return null
    const { state, userCode, verificationUrl, startedAt, expiresAt, error } = this.login
    return { state, userCode, verificationUrl, startedAt, expiresAt, error }
  }

  async startLogin() {
    if (this.login?.state === 'pending') return this.loginView()
    const abort = new AbortController()
    const rpc = new AppServer(this.config, this.cwd, AbortSignal.any([abort.signal, AbortSignal.timeout(LOGIN_TTL_MS + 60000)]))
    const login = { state: 'starting', startedAt: Date.now(), abort, rpc }
    this.login = login
    try {
      await rpc.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false, requestAttestation: false },
      })
      rpc.send({ method: 'initialized' })
      const started = await rpc.request('account/login/start', { type: 'chatgptDeviceCode' })
      if (started?.type !== 'chatgptDeviceCode' || !started.userCode || !started.verificationUrl) {
        throw new EngineError('ENGINE_PROTOCOL', 'no device code')
      }
      Object.assign(login, {
        state: 'pending', loginId: started.loginId, userCode: started.userCode,
        verificationUrl: started.verificationUrl, expiresAt: login.startedAt + LOGIN_TTL_MS,
      })
    } catch (error) {
      await this.finish(login, 'failed', error)
      throw error
    }
    void this.watch(login)
    return this.loginView()
  }

  async watch(login) {
    try {
      for await (const { method, params } of login.rpc.events) {
        if (method !== 'account/login/completed') continue
        if (params?.loginId && params.loginId !== login.loginId) continue
        if (params?.success) {
          await this.finish(login, 'succeeded')
          await this.refresh()
        } else {
          await this.finish(login, 'failed', new Error(params?.error || 'Codex sign-in failed.'))
        }
        return
      }
    } catch (error) {
      if (login.state === 'pending') await this.finish(login, login.abort.signal.aborted ? 'cancelled' : 'failed', error)
    }
  }

  async finish(login, state, error) {
    if (!['starting', 'pending'].includes(login.state)) return
    login.state = state
    if (error && state === 'failed') {
      login.error = redact(error.message ?? String(error)).slice(0, 300)
      this.onDiagnostic('ENGINE_LOGIN_FAILED', { message: error.message, stderr: login.rpc.stderr.join('\n') || undefined })
    }
    await login.rpc.close()
  }

  async cancelLogin() {
    const login = this.login
    if (!login || !['starting', 'pending'].includes(login.state)) return this.loginView()
    try {
      if (login.loginId) await login.rpc.request('account/login/cancel', { loginId: login.loginId })
    } catch {}
    login.abort.abort()
    await this.finish(login, 'cancelled')
    return this.loginView()
  }

  async logout() {
    await this.cancelLogin()
    const rpc = new AppServer(this.config, this.cwd, AbortSignal.timeout(Math.max(this.config.rpcTimeoutMs * 2, 10000)))
    try {
      await rpc.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false },
      })
      rpc.send({ method: 'initialized' })
      await rpc.request('account/logout')
    } finally {
      await rpc.close()
    }
    this.login = null
    await this.refresh()
  }

  async dispose() {
    await this.cancelLogin()
  }
}

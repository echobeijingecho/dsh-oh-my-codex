// "设置 → Codex 引擎" API on dsh's own webServer (behind dsh auth, no new port).
import { engineFailure } from './errors.js'

export const API_PREFIX = '/dsh-oh-my-codex/api'

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function createHandler({ diagnostics, account, refresh }) {
  return async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname.slice(API_PREFIX.length).replace(/\/+$/, '')
    try {
      if (req.method === 'GET' && route === '/status') {
        return json(res, 200, { ok: true, ...diagnostics.snapshot(), login: account.loginView() })
      }
      // State-changing routes require a JSON request so a cross-site form post
      // cannot trigger them with the user's dsh cookie.
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'application/json required' })
      }
      if (req.method === 'POST' && route === '/login/start') return json(res, 200, { ok: true, login: await account.startLogin() })
      if (req.method === 'POST' && route === '/login/cancel') return json(res, 200, { ok: true, login: await account.cancelLogin() })
      if (req.method === 'POST' && route === '/logout') { await account.logout(); return json(res, 200, { ok: true }) }
      if (req.method === 'POST' && route === '/refresh') { await refresh(); return json(res, 200, { ok: true, ...diagnostics.snapshot() }) }
      return json(res, 404, { ok: false, error: 'unknown route' })
    } catch (error) {
      const failure = engineFailure(error)
      return json(res, 400, { ok: false, code: failure.code, error: failure.message })
    } finally {
      req.resume?.()
    }
  }
}

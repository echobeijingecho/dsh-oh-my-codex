import { cancellableDelay, quotaRetryId } from './quota.js'

function managed(provider, providers) {
  return provider === providers.codex || provider === providers.gateway
}

function retryEventsFor(agent, turn, step) {
  try {
    return agent.session.snapshotEvents().filter(event => event.type === 'llm/retry'
      && event.data?.turn === turn && event.data?.step === step).length
  } catch {
    return 0
  }
}

/**
 * Limited auto-retry for subscription quota exhaustion: when the engine
 * refused the turn before producing anything and the reset lands within the
 * configured wait budget, schedule one retry through DSH's native
 * `agent/request-error` waterfall. The retry re-enters the same failing turn
 * and step, so the adapter re-runs `stream()` with the same messages — the
 * router binding was rolled back to `ready` by then, which makes the resend a
 * fresh turn on the same Codex thread.
 */
export function registerQuotaRetry(ctx, config, diagnostics) {
  const budget = config.codex?.quotaRetryMaxWaitMins ?? 360
  if (!config.codex?.enabled || budget <= 0) return () => {}
  const lifetime = new AbortController()
  const active = new Set()
  const dispose = ctx.on('agent/request-error', async (payload, next) => {
    const { agent, turn, step, provider, failure, signal } = payload ?? {}
    const delay = Number(failure?.providerRetryAfterMs)
    if (!agent
      || !managed(provider, config.providers)
      || failure?.code !== 'ENGINE_QUOTA'
      || !Number.isFinite(delay) || delay <= 0 || delay > budget * 60_000) {
      return next()
    }
    // One scheduled wait per turn+step, durable across restarts.
    if (retryEventsFor(agent, turn, step) >= 1) return next()

    const retryId = quotaRetryId()
    const when = new Date(Date.now() + delay)
    const message = `${failure.message ?? 'Codex 订阅额度已用尽。'} 预计 ${when.toLocaleString('zh-CN', { hour12: false })} 自动重试本条消息。`
    try {
      agent.session.append('llm/retry', {
        retryId, turn, step, provider, mode: 'normal', policyKey: 'dsh-oh-my-codex-quota',
        retry: 1, maxRetries: 1, delayMs: delay,
        failure: { code: failure.code, message },
      })
    } catch {
      // The session store being unavailable must not silently cancel a
      // resend that the engine already made safe.
      console.warn('[dsh-oh-my-codex] llm/retry append failed; retrying without a UI node')
    }
    try {
      await cancellableDelay(delay, AbortSignal.any([signal ?? new AbortController().signal, lifetime.signal]))
    } catch {
      return undefined // aborted (user stop or plugin dispose): no retry
    }
    active.add(retryId)
    try {
      agent.session.append('llm/retry-started', { retryId, turn, step, retry: 1 })
    } catch {}
    diagnostics?.record?.('ENGINE_QUOTA_RETRY', { delayMs: delay })
    return { kind: 'retry' }
  })
  return () => {
    lifetime.abort()
    dispose()
  }
}

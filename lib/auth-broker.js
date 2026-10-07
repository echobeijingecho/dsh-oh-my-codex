const DEFAULT_CREDENTIAL_REF = 'OPENAI_CODEX_SUBSCRIPTION_OAUTH'
const LEGACY_CREDENTIAL_REF = 'WSL043_OPENAI_CODEX_OAUTH'

function asCredential(value) {
  if (value === undefined || value === null || value === '') return undefined
  let credential
  try {
    credential = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    throw new Error('shared Codex credential is not valid JSON')
  }
  if (credential?.type !== 'oauth'
      || typeof credential.access !== 'string' || !credential.access
      || typeof credential.refresh !== 'string' || !credential.refresh
      || !Number.isFinite(credential.expires)) {
    throw new Error('shared Codex credential is malformed')
  }
  return credential
}

/**
 * Stable handoff from dsh-codex-subscription to the Codex App Server.
 * The subscription plugin keeps ownership of OAuth login and rotation.
 */
export function createDshSubscriptionAuthBroker(credentials, options = {}) {
  if (!credentials || typeof credentials.resolve !== 'function') {
    throw new Error('shared Codex auth requires the DSH credentials service')
  }
  const ref = options.credentialRef || DEFAULT_CREDENTIAL_REF
  const legacyRefs = options.legacyCredentialRefs ?? [LEGACY_CREDENTIAL_REF]
  const refreshCredential = options.refreshCredential
  let lastAccessToken

  async function readCredential() {
    for (const candidate of [ref, ...legacyRefs]) {
      const resolved = await credentials.resolve(candidate)
      if (resolved?.value) return asCredential(resolved.value)
    }
    return undefined
  }

  return Object.freeze({
    mode: 'dsh-subscription',
    loginType: 'chatgptAuthTokens',

    async status() {
      const credential = await readCredential()
      if (!credential) return { authenticated: false, provider: 'openai-codex' }
      return {
        authenticated: true,
        provider: 'openai-codex',
        type: 'oauth',
        accountId: credential.accountId,
        expiresAt: credential.expires,
      }
    },

    async tokens({ signal } = {}) {
      signal?.throwIfAborted()
      const credential = await readCredential()
      if (!credential?.accountId) return undefined
      lastAccessToken = credential.access
      return { accessToken: credential.access, chatgptAccountId: credential.accountId }
    },

    async refresh({ previousAccountId, signal } = {}) {
      signal?.throwIfAborted()
      const current = await readCredential()
      if (!current || (previousAccountId && current.accountId !== previousAccountId)) {
        throw new Error('shared Codex account is unavailable')
      }
      // The subscription plugin owns refresh-token rotation. If it refreshed
      // between App Server requests, use the new record without rotating again.
      if ((lastAccessToken && current.access !== lastAccessToken) || current.expires > Date.now()) {
        lastAccessToken = current.access
        return { accessToken: current.access, chatgptAccountId: current.accountId }
      }
      if (typeof refreshCredential !== 'function') {
        throw new Error('shared Codex auth refresh is owned by dsh-codex-subscription')
      }
      const next = asCredential(await refreshCredential(current, { signal }))
      if (previousAccountId && next.accountId !== previousAccountId) {
        throw new Error('shared Codex account changed during refresh')
      }
      lastAccessToken = next.access
      return { accessToken: next.access, chatgptAccountId: next.accountId }
    },

    async loginHint() {
      return (await this.status()).authenticated
        ? '已复用「Codex 订阅」登录'
        : '请先在「Codex 订阅」中完成登录'
    },
  })
}

export function createGatewayApiKeyAuthBroker(resolveApiKey, options = {}) {
  if (typeof resolveApiKey !== 'function') {
    throw new Error('gateway auth requires an API key resolver')
  }
  const provider = options.provider || 'litellm'
  return Object.freeze({
    mode: 'api-key',
    loginType: 'apiKey',

    async status() {
      const apiKey = await resolveApiKey()
      return { authenticated: Boolean(apiKey), provider, type: 'api-key' }
    },

    async tokens({ signal } = {}) {
      signal?.throwIfAborted()
      const apiKey = await resolveApiKey()
      return apiKey ? { apiKey } : undefined
    },

    async loginHint() {
      return (await this.status()).authenticated
        ? '已使用 LiteLLM 网关密钥'
        : '请先配置 LiteLLM 网关密钥'
    },
  })
}

export const SHARED_CODEX_CREDENTIAL_REF = DEFAULT_CREDENTIAL_REF

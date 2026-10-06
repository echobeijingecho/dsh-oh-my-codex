import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function tomlString(value) {
  return JSON.stringify(String(value))
}

function dotenvValue(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*?)\\s*$`, 'm'))
  if (!match) return undefined
  const value = match[1]
  if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) {
    return value.slice(1, -1)
  }
  return value
}

export function gatewayConfigToml(config) {
  const runtime = config.gatewayRuntime
  if (!runtime?.baseUrl || !runtime.providerName || !runtime.apiKeyEnv || !config.env?.CODEX_HOME) {
    throw new Error('gateway runtime is incomplete')
  }
  const model = config.models?.[0]?.id
  if (!model) throw new Error('gateway requires a default model')
  return [
    `model = ${tomlString(model)}`,
    `model_provider = ${tomlString(runtime.providerName)}`,
    '',
    `[model_providers.${runtime.providerName}]`,
    `name = ${tomlString(runtime.displayName ?? 'Codex Gateway')}`,
    `base_url = ${tomlString(runtime.baseUrl)}`,
    `env_key = ${tomlString(runtime.apiKeyEnv)}`,
    `wire_api = ${tomlString(runtime.wireApi)}`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n')
}

export async function prepareGatewayConfig(config) {
  if (!config.gatewayRuntime) return config
  await ensureGatewayHome(config)
  const { apiKeyFile, apiKeyFileEnv, apiKeyEnv } = config.gatewayRuntime
  if (!apiKeyFile) return config
  const sourceEnv = apiKeyFileEnv || apiKeyEnv
  const key = dotenvValue(await readFile(apiKeyFile, 'utf8'), sourceEnv)
  if (!key) throw new Error(`gateway key ${sourceEnv} is missing from ${apiKeyFile}`)
  return {
    ...config,
    env: { ...config.env, [apiKeyEnv]: key },
  }
}

/**
 * The gateway engine has no auth.json and must not inherit the subscription
 * home. Generate only the provider config we own; Codex keeps its rollout
 * state in the same dedicated home.
 */
export async function ensureGatewayHome(config) {
  if (!config.gatewayRuntime) return
  const home = config.env?.CODEX_HOME
  if (!home) throw new Error('gateway CODEX_HOME is missing')
  await mkdir(home, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700).catch(() => {})
  const path = join(home, 'config.toml')
  const content = gatewayConfigToml(config)
  let current
  try { current = await readFile(path, 'utf8') } catch {}
  if (current !== content) await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => {})
}

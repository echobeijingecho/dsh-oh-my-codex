import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { aliasTools, buildDynamicTools, dynamicToolResponse } from '../lib/dsh-tools.js'
import { Diagnostics, redact } from '../lib/diagnostics.js'
import { toolOutput } from '../lib/codex.js'
import { inheritedProvenance } from '../lib/index.js'
import { fixture } from './helpers.js'
import { EngineError, engineFailure } from '../lib/errors.js'
import { subagentTodo, writeTodoSnapshot } from '../lib/external-tools.js'
import { gatewayConfigToml, prepareGatewayConfig } from '../lib/gateway-home.js'

test('sub-agent events become stable bounded todo items without erasing the plan', () => {
  const writes = []
  const agent = { session: { append: (type, data) => writes.push({ type, data }) } }
  const task = subagentTodo({
    type: 'subagent', kind: 'spawnAgent', receiverThreadIds: ['child-1'],
    prompt: 'inspect the repository\nsecond line', model: 'fixture-mini', agentPath: 'child-1',
  })
  assert.deepEqual(task, [{ id: 'child-1', content: 'child-1 Codex 子 Agent child-1（fixture-mini）：inspect the repository', status: 'in_progress' }])
  writeTodoSnapshot(agent, {
    plan: [{ step: 'prepare', status: 'completed' }],
    subagents: task,
  })
  assert.deepEqual(writes, [{ type: 'todo/write', data: { todos: [
    { content: 'prepare', status: 'completed' },
    { content: 'child-1 Codex 子 Agent child-1（fixture-mini）：inspect the repository', status: 'in_progress' },
  ] } }])
})

test('tool aliases keep ordinary names, rewrite mcp__ and stay deterministic and bounded', () => {
  const long = `mcp__${'x'.repeat(80)}`
  const names = ['ordinary_tool', 'mcp__hive__query', 'dsh_mcp__hive__query', long, 'bad name']
  const first = aliasTools(names)
  assert.deepEqual(first, aliasTools([...names].reverse()))
  assert.equal(first.get('ordinary_tool'), 'ordinary_tool')
  assert.equal(first.get('dsh_mcp__hive__query'), 'dsh_mcp__hive__query')
  assert.notEqual(first.get('mcp__hive__query'), 'dsh_mcp__hive__query')
  assert.match(first.get('mcp__hive__query'), /^dsh_mcp__hive__query_[0-9a-f]{10}$/)
  assert.ok(first.get(long).length <= 64)
  assert.equal(first.get('bad name'), 'bad_name')
  assert.equal(new Set(first.values()).size, names.length)
})

test('only allowlisted DSH tools are exposed and calls resolve back to the original name', () => {
  const tools = buildDynamicTools([
    { name: 'mcp__hive__query', description: 'q', parameters: { type: 'object' } },
    { name: 'mcp__osi__lookup', description: 'o', parameters: { type: 'object' } },
    { name: 'bash', description: 'b', parameters: { type: 'object' } },
  ], ['mcp__hive__*', 'mcp__osi__*'])
  assert.deepEqual(tools.names, ['mcp__hive__query', 'mcp__osi__lookup'])
  assert.equal(tools.resolve('dsh_mcp__hive__query'), 'mcp__hive__query')
  assert.equal(tools.resolve('bash'), undefined)
  assert.equal(buildDynamicTools([{ name: 'bash' }], []).specs, undefined)
  assert.deepEqual(dynamicToolResponse({ isError: true, content: [] }), { contentItems: [{ type: 'inputText', text: 'Tool failed.' }], success: false })
})

test('redaction removes proxy credentials, bearer tokens, keys and JWTs', () => {
  const text = redact('socks5h://proxyuser:pa55word@127.0.0.1:7897 Authorization: Bearer abcdefghijkl sk-proj-abcdefghij api_key=hunter22 eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4')
  assert.equal(redact('\u001b[31mERROR\u001b[0m x'), 'ERROR x')
  for (const secret of ['pa55word@', 'abcdefghijkl', 'proj-abcdefghij', 'hunter22', 'SflKxwRJSMeKKF2QT4']) {
    assert.ok(!text.includes(secret), `${secret} leaked: ${text}`)
  }
})

test('status file is private, bounded and redacted', async t => {
  const { root } = await fixture(t)
  const diagnostics = new Diagnostics(join(root, 'state'))
  for (let i = 0; i < 130; i += 1) diagnostics.record('ENGINE_X', { message: `n=${i} https://a:b@h` })
  await diagnostics.set('connected', { code: 'OK', message: 'Bearer abcdefghijkl' })
  const file = join(root, 'state', 'status.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const body = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(diagnostics.events.length, 100)
  assert.equal(body.recent.length, 20)
  assert.equal(body.status.state, 'connected')
  assert.doesNotMatch(JSON.stringify(body), /a:b@|abcdefghijkl/)
})

test('command output reads camelCase aggregatedOutput and marks non-zero exits', () => {
  assert.equal(toolOutput({ type: 'commandExecution', aggregatedOutput: 'ok', exitCode: 0 }), 'ok')
  assert.equal(toolOutput({ type: 'commandExecution', aggregatedOutput: 'no', exitCode: 2 }), 'no\n[exit 2]')
  assert.equal(toolOutput({ type: 'dynamicToolCall', contentItems: [{ type: 'inputText', text: 'r' }] }), 'r')
})

test('fork provenance comes from the newest Codex reply and refuses replies without it', () => {
  const user = id => ({ role: 'user', id })
  const reply = replayState => ({ role: 'assistant', source: { provider: 'dsh-codex', replayState } })
  assert.deepEqual(inheritedProvenance([user('a'), reply({ response: { engine: 'codex', threadId: 't', turnId: 'u' } }), user('b')], 'dsh-codex'),
    { index: 1, threadId: 't', turnId: 'u' })
  assert.deepEqual(inheritedProvenance([user('a'), reply(undefined)], 'dsh-codex'), { index: 1, incomplete: true })
  assert.equal(inheritedProvenance([user('a')], 'dsh-codex'), undefined)
})

test('sandbox modes map DSH permissions to native or external Codex policies', async () => {
  const { executionPolicy } = await import('../lib/codex.js')
  const write = { sandbox: 'workspace-write', approval: 'ask' }
  const read = { sandbox: 'read-only', approval: 'never' }
  assert.equal(executionPolicy({}, write, '/w').sandboxPolicy.type, 'workspaceWrite')
  assert.deepEqual(executionPolicy({}, write, '/w').sandboxPolicy.writableRoots, ['/w'])
  assert.equal(executionPolicy({}, read, '/w').sandboxPolicy.type, 'readOnly')
  const external = executionPolicy({ sandboxMode: 'external' }, write, '/w')
  assert.deepEqual(external.sandboxPolicy, { type: 'externalSandbox', networkAccess: 'restricted' })
  assert.equal(external.approvalPolicy, 'on-request')
  assert.equal(executionPolicy({ sandboxMode: 'external' }, read, '/w').approvalPolicy, 'untrusted')
})

test('minimal DSH instructions drop skill catalogues but keep persona and other sections', async () => {
  const { shapeInstructions } = await import('../lib/index.js')
  const text = 'You are an AI agent.\n\n## 本实例已装技能（务必据此协作）\nuse skill tool\n### hive\nx\n## Skills\n### Available skills\nlist\n## 工作区约定\nkeep me\n'
  assert.equal(shapeInstructions(text, {}), text)
  const minimal = shapeInstructions(text, { dshInstructions: 'minimal', dropInstructionSections: ['技能', 'skills?'] })
  assert.equal(minimal, 'You are an AI agent.\n\n## 工作区约定\nkeep me')
  assert.equal(shapeInstructions(text, { dshInstructions: 'none' }), '')
})

test('engine errors carry localized copy with the code for operators', () => {
  const error = new EngineError('ENGINE_AUTH')
  assert.equal(error.code, 'ENGINE_AUTH')
  assert.match(error.message, /引擎认证失败/)
  assert.match(error.message, /\[ENGINE_AUTH\]$/)
  assert.doesNotMatch(error.message, /Sign in/)
  const detailed = new EngineError('ENGINE_TIMEOUT', 'account/read')
  assert.match(detailed.message, /超时/)
  assert.match(detailed.message, /account\/read/)
})

test('engineFailure classifies without echoing provider diagnostics, in Chinese', () => {
  const failure = engineFailure(new Error('401 secret'))
  assert.equal(failure.code, 'ENGINE_AUTH')
  assert.match(failure.message, /引擎认证失败/)
  assert.equal(failure.message.includes('secret'), false)
  assert.match(engineFailure(new Error('429 secret')).message, /额度/)
  assert.match(engineFailure(new EngineError('ENGINE_QUOTA')).message, /额度/)
  assert.equal(engineFailure(new EngineError('ENGINE_QUOTA')).code, 'ENGINE_QUOTA')
})

test('gateway CODEX_HOME config uses the independent gateway Responses bridge', () => {
  const content = gatewayConfigToml({
    env: { CODEX_HOME: '/tmp/codex-gateway' },
    models: [{ id: 'gateway-model-a', name: 'Gateway Model A' }],
    gatewayRuntime: {
      displayName: 'Codex Gateway',
      providerName: 'codex-gateway',
      baseUrl: 'https://gateway.example.invalid/v1',
      apiKeyEnv: 'CODEX_GATEWAY_API_KEY',
      wireApi: 'responses',
    },
  })
  assert.match(content, /^model = "gateway-model-a"$/m)
  assert.match(content, /^model_provider = "codex-gateway"$/m)
  assert.match(content, /^\[model_providers\.codex-gateway\]$/m)
  assert.match(content, /^base_url = "https:\/\/gateway\.example\.invalid\/v1"$/m)
  assert.match(content, /^env_key = "CODEX_GATEWAY_API_KEY"$/m)
  assert.match(content, /^wire_api = "responses"$/m)
})

test('gateway key is loaded from a dotenv file without entering config.toml', async t => {
  const { root } = await fixture(t)
  const keyFile = join(root, 'gateway.env')
  await writeFile(keyFile, 'CODEX_GATEWAY_KEY="gateway-secret"\n')
  const config = await prepareGatewayConfig({
    env: { CODEX_HOME: join(root, 'codex-gateway') },
    models: [{ id: 'gateway-model-b', name: 'Gateway Model B' }],
    gatewayRuntime: {
      displayName: 'Codex Gateway',
      providerName: 'codex-gateway',
      baseUrl: 'https://gateway.example.invalid/v1',
      apiKeyEnv: 'CODEX_GATEWAY_API_KEY',
      apiKeyFile: keyFile,
      apiKeyFileEnv: 'CODEX_GATEWAY_KEY',
      wireApi: 'responses',
    },
  })
  assert.equal(config.env.CODEX_GATEWAY_API_KEY, 'gateway-secret')
  assert.doesNotMatch(await readFile(join(root, 'codex-gateway', 'config.toml'), 'utf8'), /gateway-secret/)
})

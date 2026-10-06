// Contract test against a REAL Codex binary. Fixtures can share a mistake with
// the code (the old snake_case `aggregated_output`); this test cannot.
//
//   CODEX_CONTRACT_BIN=/path/to/codex npm test
//
// Skipped when CODEX_CONTRACT_BIN is unset. Runs offline with an isolated,
// signed-out CODEX_HOME: it never starts a model turn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AppServer, DEFAULT_DISABLED_FEATURES, SAFETY_ARGS } from '../lib/codex.js'
import { buildDynamicTools } from '../lib/dsh-tools.js'
import { fixture } from './helpers.js'

const bin = process.env.CODEX_CONTRACT_BIN
const run = promisify(execFile)
const skip = bin ? false : 'set CODEX_CONTRACT_BIN to a codex executable'

async function schema(t) {
  const { root } = await fixture(t)
  const out = join(root, 'schema')
  await run(bin, ['app-server', 'generate-json-schema', '--experimental', '--out', out])
  const definitions = {}
  for (const name of await readdir(out)) {
    if (!name.endsWith('.json')) continue
    const body = JSON.parse(await readFile(join(out, name), 'utf8'))
    Object.assign(definitions, body.definitions ?? {})
    definitions[name.replace(/\.json$/, '')] ??= body
  }
  const methods = file => new Set(definitions[file].oneOf.flatMap(entry => entry.properties?.method?.enum ?? []))
  const props = (name, variant) => {
    let node = definitions[name]
    assert.ok(node, `${name} missing from the protocol`)
    if (variant) {
      node = (node.oneOf ?? node.anyOf ?? []).find(entry => entry.properties?.type?.enum?.includes(variant))
      assert.ok(node, `${name}.${variant} missing from the protocol`)
    }
    return new Set(Object.keys(node.properties ?? {}))
  }
  return { methods, props }
}

function includesAll(set, names, label) {
  for (const name of names) assert.ok(set.has(name), `${label} lacks ${name}`)
}

test('protocol methods and fields the router consumes exist in this Codex', { skip }, async t => {
  const { methods, props } = await schema(t)
  includesAll(methods('ClientRequest'), [
    'initialize', 'account/read', 'model/list', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start',
    'account/login/start', 'account/login/cancel', 'account/logout', 'account/rateLimits/read',
    'thread/turns/list', 'thread/read', 'turn/steer', 'review/start', 'thread/compact/start',
  ], 'ClientRequest')
  includesAll(methods('ServerNotification'), [
    'item/agentMessage/delta', 'item/started', 'item/completed', 'turn/completed', 'error',
    'item/commandExecution/outputDelta', 'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'account/login/completed',
  ], 'ServerNotification')
  includesAll(methods('ServerRequest'), [
    'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
    'item/permissions/requestApproval', 'item/tool/requestUserInput', 'item/tool/call',
    'mcpServer/elicitation/request',
  ], 'ServerRequest')
  includesAll(props('ThreadItem', 'commandExecution'), ['id', 'command', 'cwd', 'status', 'aggregatedOutput', 'exitCode', 'commandActions'], 'commandExecution')
  includesAll(props('ThreadItem', 'dynamicToolCall'), ['id', 'namespace', 'tool', 'arguments', 'status', 'contentItems', 'success'], 'dynamicToolCall')
  includesAll(props('ThreadStartParams'), ['model', 'cwd', 'sandbox', 'approvalPolicy', 'developerInstructions', 'ephemeral', 'dynamicTools'], 'ThreadStartParams')
  includesAll(props('ThreadForkParams'), ['threadId', 'lastTurnId', 'excludeTurns', 'developerInstructions'], 'ThreadForkParams')
  includesAll(props('TurnStartParams'), ['threadId', 'input', 'model', 'effort', 'summary', 'sandboxPolicy', 'approvalPolicy', 'clientUserMessageId'], 'TurnStartParams')
  includesAll(props('ThreadTurnsListParams'), ['threadId', 'cursor', 'limit', 'sortDirection', 'itemsView'], 'ThreadTurnsListParams')
  includesAll(props('ThreadReadParams'), ['threadId', 'includeTurns'], 'ThreadReadParams')
  includesAll(props('Turn'), ['id', 'items', 'itemsView', 'status'], 'Turn')
  includesAll(props('ThreadItem', 'userMessage'), ['id', 'clientId', 'content'], 'userMessage')
  includesAll(props('TurnSteerParams'), ['threadId', 'input', 'expectedTurnId', 'clientUserMessageId'], 'TurnSteerParams')
  includesAll(props('UserInput', 'localImage'), ['path', 'detail'], 'localImage')
  includesAll(props('ReviewTarget'), ['type'], 'ReviewTarget')
  includesAll(props('ReviewStartParams'), ['threadId', 'target', 'delivery'], 'ReviewStartParams')
  includesAll(props('ThreadCompactStartParams'), ['threadId'], 'ThreadCompactStartParams')
  includesAll(props('CollaborationMode'), ['mode', 'settings'], 'CollaborationMode')
  includesAll(props('CollaborationModeSettings'), ['model', 'reasoning_effort', 'developer_instructions'], 'CollaborationModeSettings')
  includesAll(props('CommandExecutionOutputDeltaNotification'), ['threadId', 'turnId', 'itemId', 'delta'], 'outputDelta')
  includesAll(props('ReasoningSummaryTextDeltaNotification'), ['threadId', 'turnId', 'itemId', 'delta'], 'summaryTextDelta')
  includesAll(props('DynamicToolCallParams'), ['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments'], 'DynamicToolCallParams')
  includesAll(props('DynamicToolCallResponse'), ['contentItems', 'success'], 'DynamicToolCallResponse')
  includesAll(props('ToolRequestUserInputParams'), ['threadId', 'turnId', 'questions'], 'ToolRequestUserInputParams')
  includesAll(props('ToolRequestUserInputResponse'), ['answers'], 'ToolRequestUserInputResponse')
  includesAll(props('PermissionsRequestApprovalResponse'), ['permissions', 'scope'], 'PermissionsRequestApprovalResponse')
  includesAll(props('McpServerElicitationRequestResponse'), ['action', 'content'], 'McpServerElicitationRequestResponse')
  includesAll(props('LoginAccountResponse', 'chatgptDeviceCode'), ['loginId', 'verificationUrl', 'userCode'], 'LoginAccountResponse.chatgptDeviceCode')
  includesAll(props('AccountLoginCompletedNotification'), ['loginId', 'success', 'error'], 'AccountLoginCompletedNotification')
  includesAll(props('RateLimitWindow'), ['usedPercent', 'windowDurationMins', 'resetsAt'], 'RateLimitWindow')
  includesAll(props('SandboxPolicy', 'externalSandbox'), ['networkAccess'], 'SandboxPolicy.externalSandbox')
  includesAll(props('ThreadTokenUsage'), ['total', 'last', 'modelContextWindow'], 'ThreadTokenUsage')
  includesAll(props('Model'), ['supportedReasoningEfforts', 'defaultReasoningEffort', 'displayName', 'hidden'], 'Model')
  includesAll(methods('ServerNotification'), ['thread/tokenUsage/updated', 'turn/plan/updated', 'turn/diff/updated'], 'ServerNotification')
  includesAll(methods('ClientRequest'), ['turn/interrupt'], 'ClientRequest')
})

test('every hardened feature name exists in this Codex', { skip }, async t => {
  const { root } = await fixture(t)
  const home = join(root, 'codex-home')
  await mkdir(home)
  const { stdout } = await run(bin, ['features', 'list'], { env: { ...process.env, CODEX_HOME: home } })
  const known = new Set(stdout.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(Boolean))
  for (const feature of ['shell_snapshot', ...DEFAULT_DISABLED_FEATURES]) assert.ok(known.has(feature), `unknown Codex feature ${feature}`)
})

test('a real App Server accepts the safety flags, handshake and a dynamic-tool thread', { skip }, async t => {
  const { root, cwd } = await fixture(t)
  const home = join(root, 'codex-home')
  await mkdir(home)
  const rpc = new AppServer({
    command: bin, args: [], rpcTimeoutMs: 20000,
    env: { CODEX_HOME: home, PATH: process.env.PATH, HOME: root },
  }, cwd, AbortSignal.timeout(60000))
  t.after(() => rpc.close())
  const init = await rpc.request('initialize', {
    clientInfo: { name: 'dsh_oh_my_codex_contract', title: 'contract', version: '0' },
    capabilities: { experimentalApi: true },
  })
  assert.equal(typeof init.userAgent, 'string')
  rpc.send({ method: 'initialized' })
  const account = await rpc.request('account/read', { refreshToken: false })
  assert.equal(typeof account.requiresOpenaiAuth, 'boolean')
  const tools = buildDynamicTools([{ name: 'mcp__hive__query', description: 'q', parameters: { type: 'object', properties: { sql: { type: 'string' } } } }], ['mcp__*'])
  const started = await rpc.request('thread/start', {
    cwd, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, dynamicTools: tools.specs,
  })
  assert.equal(typeof started.thread.id, 'string')
  assert.ok(SAFETY_ARGS.includes('features.shell_snapshot=false'))
  await assert.rejects(readdir(join(home, 'shell_snapshots')), { code: 'ENOENT' })
})

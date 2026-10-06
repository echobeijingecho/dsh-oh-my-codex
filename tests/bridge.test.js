import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CodexEngine, preflight } from '../lib/codex.js'
import { createDshSubscriptionAuthBroker } from '../lib/auth-broker.js'
import { buildDynamicTools } from '../lib/dsh-tools.js'
import { fixture, collect, request } from './helpers.js'

const SERVER = fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))

function config(root, env = {}) {
  return { command: process.execPath, args: [SERVER], env: { FIXTURE_STATE_DIR: root, ...env }, rpcTimeoutMs: 3000, reasoningSummary: 'auto' }
}

function engine(root, env) { return new CodexEngine(config(root, env)) }

async function lines(root, file) {
  return (await readFile(join(root, file), 'utf8')).trim().split('\n').map(JSON.parse)
}

function text(events, type = 'text') {
  return events.filter(e => e.type === type).map(e => e.text).join('')
}

async function run(root, cwd, prompt, changes = {}, env) {
  return collect(engine(root, env).run(request(cwd, { prompt, bindThread: async () => {}, ...changes })))
}

test('every App Server launch disables snapshots, updates, analytics and ungoverned features', async t => {
  const { root, cwd } = await fixture(t)
  await run(root, cwd, 'hello')
  const [argv] = await lines(root, 'argv.jsonl')
  const flags = argv.slice(argv.indexOf('-c'), argv.indexOf('app-server'))
  for (const flag of ['features.shell_snapshot=false', 'check_for_update_on_startup=false', 'analytics.enabled=false', 'features.apps=false', 'features.computer_use=false', 'features.multi_agent=false']) {
    assert.ok(flags.includes(flag), `${flag} missing from ${flags.join(' ')}`)
  }
  const init = (await lines(root, 'calls.jsonl')).find(c => c.method === 'initialize')
  assert.ok(init.params.capabilities.optOutNotificationMethods.includes('codex/event/agent_message_delta'))
  assert.equal(init.params.capabilities.requestAttestation, false)
})

test('command output uses camelCase aggregatedOutput and streams live deltas', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'tool')
  assert.deepEqual(events.filter(e => e.type === 'tool-output').map(e => e.delta), ['tool-', 'output'])
  assert.equal(events.find(e => e.type === 'tool-end').output, 'tool-output')
  assert.equal(events.find(e => e.type === 'tool-start').command, 'printf tool-output')
})

test('reasoning summaries stream separately and raw reasoning is suppressed once a summary exists', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'reasoning')
  assert.equal(text(events, 'reasoning'), 'thinking\n\nmore')
  assert.equal(text(events), 'reasoned\n\n')
  const turn = (await lines(root, 'calls.jsonl')).find(c => c.method === 'turn/start')
  assert.equal(turn.params.summary, 'auto')
})

test('a completed turn reports its thread and turn identity for replay provenance', async t => {
  const { root, cwd } = await fixture(t)
  let bound
  const events = await run(root, cwd, 'hello', { bindThread: async id => { bound = id } })
  const turn = events.find(e => e.type === 'turn')
  assert.equal(turn.threadId, bound)
  assert.equal(typeof turn.turnId, 'string')
})

test('Codex questions become DSH questions; secret questions are never relayed', async t => {
  const { root, cwd } = await fixture(t)
  let asked
  const events = await run(root, cwd, 'question', {
    ask: async questions => {
      asked = questions
      return { answers: [{ id: 'color', selected: ['blue'], custom: 'teal' }] }
    },
  })
  assert.deepEqual(asked, [{
    id: 'color', question: 'Pick a color', header: 'Color',
    options: [{ label: 'blue', description: 'cool' }, { label: 'red' }],
  }])
  assert.deepEqual(JSON.parse(text(events).trim()), { answers: { color: { answers: ['blue', 'teal'] } } })
})

test('an unanswerable question returns empty answers instead of failing the turn', async t => {
  const { root, cwd } = await fixture(t)
  const codes = []
  const events = await run(root, cwd, 'question', {
    ask: async () => { throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' }) },
    onDiagnostic: code => codes.push(code),
  })
  assert.deepEqual(JSON.parse(text(events).trim()), { answers: {} })
  assert.deepEqual(codes, ['ENGINE_QUESTION_UNANSWERED'])
})

test('permission escalation is granted for this turn only after DSH approval', async t => {
  const { root, cwd } = await fixture(t)
  for (const allowed of [true, false]) {
    let reason
    const events = await run(root, cwd, 'permissions', {
      approve: async details => { reason = details; return allowed },
    })
    assert.equal(reason.name, 'codex:permissions')
    assert.deepEqual(JSON.parse(text(events).trim()), {
      permissions: allowed ? { network: { enabled: true } } : {}, scope: 'turn',
    })
  }
})

test('approval for a different turn is declined without asking the user', async t => {
  const { root, cwd } = await fixture(t)
  let asked = false
  const events = await run(root, cwd, 'stale-approval', { approve: async () => { asked = true; return true } })
  assert.equal(asked, false)
  assert.equal(text(events), 'decline\n\n')
})

test('MCP elicitation and token refresh are declined without breaking the turn', async t => {
  const { root, cwd } = await fixture(t)
  const codes = []
  const elicited = await run(root, cwd, 'elicitation', { onDiagnostic: code => codes.push(code) })
  assert.deepEqual(JSON.parse(text(elicited).trim()), { action: 'decline', content: null, _meta: null })
  const refreshed = await run(root, cwd, 'unknown-request', { onDiagnostic: code => codes.push(code) })
  assert.equal(text(refreshed), 'refresh:denied\n\n')
  assert.deepEqual(codes, ['ENGINE_ELICITATION_DECLINED', 'ENGINE_UNSUPPORTED_REQUEST'])
})

test('DSH dynamic tools are declared on thread start and executed through the bridge', async t => {
  const { root, cwd } = await fixture(t)
  const tools = buildDynamicTools([
    { name: 'mcp__hive__query', description: 'Run SQL', parameters: { type: 'object', properties: { sql: { type: 'string' } } } },
    { name: 'bash', description: 'shell', parameters: { type: 'object' } },
  ], ['mcp__hive__*'])
  const calls = []
  const events = await run(root, cwd, 'dyntool dsh_mcp__hive__query', {
    tools,
    callTool: async call => {
      calls.push(call)
      return { contentItems: [{ type: 'inputText', text: 'rows=1' }], success: true }
    },
  })
  const start = (await lines(root, 'calls.jsonl')).find(c => c.method === 'thread/start')
  assert.deepEqual(start.params.dynamicTools[0].tools.map(tool => tool.name), ['dsh_mcp__hive__query'])
  assert.equal(start.params.dynamicTools[0].name, 'dsh')
  assert.deepEqual(calls.map(c => [c.namespace, c.tool, c.arguments]), [['dsh', 'dsh_mcp__hive__query', { sql: 'select 1' }]])
  const card = events.find(e => e.type === 'tool-start')
  assert.equal(card.name, 'mcp__hive__query')
  assert.equal(events.find(e => e.type === 'tool-end').output, 'rows=1')
  assert.match(text(events), /"success":true/)
})

test('fork uses thread/fork through the recorded turn and binds the new thread', async t => {
  const { root, cwd } = await fixture(t)
  let source
  const first = await run(root, cwd, 'remember blue', { bindThread: async id => { source = id } })
  const turnId = first.find(e => e.type === 'turn').turnId
  let child
  const events = await run(root, cwd, 'history?', {
    fork: { threadId: source, turnId }, bindThread: async id => { child = id },
  })
  assert.notEqual(child, source)
  assert.equal(text(events), 'remember blue|history?\n\n')
  const fork = (await lines(root, 'calls.jsonl')).find(c => c.method === 'thread/fork')
  assert.equal(fork.params.threadId, source)
  assert.equal(fork.params.lastTurnId, turnId)
})

test('a fork that returns the source or fails never falls back to a fresh thread', async t => {
  const { root, cwd } = await fixture(t)
  let source
  const first = await run(root, cwd, 'remember blue', { bindThread: async id => { source = id } })
  const turnId = first.find(e => e.type === 'turn').turnId
  await assert.rejects(run(root, cwd, 'x', {
    fork: { threadId: source, turnId }, bindThread: async () => assert.fail('must not bind'),
  }, { FIXTURE_FORK_SAME: '1' }), { code: 'ENGINE_FORK' })
  await assert.rejects(run(root, cwd, 'x', {
    fork: { threadId: 'missing', turnId }, bindThread: async () => assert.fail('must not bind'),
  }), { code: 'ENGINE_FORK' })
  assert.equal((await lines(root, 'calls.jsonl')).filter(c => c.method === 'thread/start').length, 1)
})

test('failure diagnostics carry only a redacted stderr tail', async t => {
  const { root, cwd } = await fixture(t)
  const error = await run(root, cwd, 'hello', {}, { FIXTURE_BAD_THREAD: '1' }).catch(e => e)
  assert.equal(error.code, 'ENGINE_PROTOCOL')
  const tail = error.stderr.join('\n')
  assert.match(tail, /fixture stderr/)
  assert.doesNotMatch(tail, /secret|abcdefghijklmnop/)
})

test('preflight reports runtime, sign-in and the account model list without starting a thread', async t => {
  const { root, cwd } = await fixture(t)
  const ok = await preflight(config(root), cwd)
  assert.deepEqual({ userAgent: ok.userAgent, signedIn: ok.signedIn, models: ok.models }, { userAgent: 'fixture/1.0', signedIn: true, models: ['fixture-model', 'fixture-mini', 'fixture-hidden'] })
  const failed = await preflight(config(root, { FIXTURE_MODEL_LIST_FAIL: '1' }), cwd)
  assert.equal(failed.models, undefined)
  assert.doesNotMatch(failed.modelError, /u:p@/)
  assert.equal((await preflight(config(root, { FIXTURE_UNAUTH: '1' }), cwd)).signedIn, false)
  assert.equal((await lines(root, 'calls.jsonl')).some(c => c.method === 'thread/start'), false)
})

test('preflight authenticates through the shared subscription credential', async t => {
  const { root, cwd } = await fixture(t)
  const broker = createDshSubscriptionAuthBroker({
    async resolve(ref) {
      if (ref !== 'OPENAI_CODEX_SUBSCRIPTION_OAUTH') return undefined
      return {
        source: 'test',
        value: JSON.stringify({
          type: 'oauth',
          access: 'shared-access',
          refresh: 'shared-refresh',
          expires: Date.now() + 60_000,
          accountId: 'shared-account',
        }),
      }
    },
  })
  const result = await preflight(config(root), cwd, { authBroker: broker })
  assert.equal(result.signedIn, true)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const login = calls.find(call => call.method === 'account/login/start')
  assert.equal(login.params.type, 'chatgptAuthTokens')
  assert.equal(login.params.accessToken, 'shared-access')
  assert.equal(login.params.chatgptAccountId, 'shared-account')
  assert.equal(calls.some(call => call.method === 'account/login/start' && call.params.type === 'chatgptDeviceCode'), false)
})

test('dispatch is reported only once turn/start is about to be sent', async t => {
  const { root, cwd } = await fixture(t)
  let dispatched = 0
  await run(root, cwd, 'hello', { onDispatch: () => { dispatched++ } })
  assert.equal(dispatched, 1)
  await assert.rejects(run(root, cwd, 'hello', { onDispatch: () => { dispatched++ } }, { FIXTURE_UNAUTH: '1' }), { code: 'ENGINE_AUTH' })
  assert.equal(dispatched, 1)
})

test('turn token usage is the delta of the cumulative thread total', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'usage')
  const usage = events.find(e => e.type === 'usage')
  assert.equal(usage.usage.inputTokens, 250)
  assert.equal(usage.usage.outputTokens, 30)
  assert.equal(usage.usage.cachedInputTokens, 125)
  assert.equal(usage.contextWindow, 200000)
  assert.ok(events.findIndex(e => e.type === 'usage') < events.findIndex(e => e.type === 'turn'))
})

test('plan updates are deduplicated and surface as structured todo snapshots', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'plan')
  const plans = events.filter(e => e.type === 'plan')
  assert.equal(plans.length, 2)
  assert.deepEqual(plans[0].plan, [{ step: 'read', status: 'inProgress' }, { step: 'write', status: 'pending' }])
  assert.deepEqual(plans[1].plan, [{ step: 'read', status: 'completed' }, { step: 'write', status: 'completed' }])
  assert.equal(text(events, 'reasoning'), '')
})

test('the final turn diff is reported once at completion', async t => {
  const { root, cwd } = await fixture(t)
  const diffs = (await run(root, cwd, 'diff')).filter(e => e.type === 'diff')
  assert.equal(diffs.length, 1)
  assert.match(diffs[0].diff, /\+new$/)
})

test('a deliberate stop sends turn/interrupt before the process is reclaimed', async t => {
  const { root, cwd } = await fixture(t)
  const controller = new AbortController()
  const result = run(root, cwd, 'interruptible', { signal: controller.signal })
  for (let i = 0; i < 100; i += 1) {
    try { await readFile(join(root, 'server.pid')); break } catch { await new Promise(r => setTimeout(r, 20)) }
  }
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  const interrupt = (await lines(root, 'calls.jsonl')).find(c => c.method === 'turn/interrupt')
  assert.ok(interrupt)
  assert.equal(typeof interrupt.params.turnId, 'string')
})

test('threads are labelled with this client as source', async t => {
  const { root, cwd } = await fixture(t)
  await run(root, cwd, 'hello')
  const start = (await lines(root, 'calls.jsonl')).find(c => c.method === 'thread/start')
  assert.equal(start.params.threadSource, 'dsh_oh_my_codex')
  assert.equal(start.params.serviceName, 'dsh_oh_my_codex')
})

test('preflight catalog carries reasoning efforts, defaults and visibility', async t => {
  const { root, cwd } = await fixture(t)
  const { catalog } = await preflight(config(root), cwd)
  const model = catalog.find(entry => entry.id === 'fixture-model')
  assert.deepEqual(model.efforts.map(e => e.id), ['low', 'medium', 'high'])
  assert.equal(model.defaultEffort, 'medium')
  assert.equal(catalog.find(entry => entry.id === 'fixture-hidden').hidden, true)
  assert.equal(model.multiAgentVersion, 'v2')
})

test('file-change approvals show the pending changes and the card shows the diffs', async t => {
  const { root, cwd } = await fixture(t)
  let reason
  const events = await run(root, cwd, 'filechange', { approve: async details => { reason = JSON.parse(details.reason); return true } })
  assert.match(reason.changes, /新增 .*a\.txt\nhello/)
  assert.match(reason.changes, /修改 .*b\.txt\n@@ -1 \+1 @@/)
  const end = events.find(e => e.type === 'tool-end')
  assert.match(end.output, /新增 .*a\.txt/)
  assert.equal(end.isError, false)
})

test('transient stream errors are surfaced once and do not fail the turn', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'transient-error')
  assert.equal(text(events), 'recovered\n\n')
  assert.equal((text(events, 'reasoning').match(/正在自动重试/g) ?? []).length, 1)
})

for (const [info, code] of [['usageLimitExceeded', 'ENGINE_QUOTA'], ['contextWindowExceeded', 'ENGINE_CONTEXT'], ['unauthorized', 'ENGINE_AUTH'], ['sandboxError', 'ENGINE_SANDBOX'], ['serverOverloaded', 'ENGINE_UPSTREAM']]) {
  test(`terminal ${info} maps to ${code} from structured codexErrorInfo`, async t => {
    const { root, cwd } = await fixture(t)
    const error = await run(root, cwd, `fail-${info}`).catch(e => e)
    assert.equal(error.code, code)
    assert.doesNotMatch(error.message, /u:p@/)
  })
}

test('a request Codex withdraws cancels the pending DSH approval', async t => {
  const { root, cwd } = await fixture(t)
  let cancelled = false
  const events = await run(root, cwd, 'withdrawn', {
    approve: ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(false) })),
  })
  assert.equal(text(events), 'withdrawn\n\n')
  assert.equal(cancelled, true)
  const replies = (await readFile(join(root, 'replies.jsonl'), 'utf8').catch(() => '')).trim()
  assert.doesNotMatch(replies, /withdraw-/, 'no reply is sent for a withdrawn request')
})

test('config warnings become diagnostics; resume excludes turns and turns carry the DSH message id', async t => {
  const { root, cwd } = await fixture(t)
  const codes = []
  let thread
  await run(root, cwd, 'warn', { onDiagnostic: (code, detail) => codes.push([code, detail.message]), bindThread: async id => { thread = id }, clientMessageId: 'dsh-msg-1' })
  assert.deepEqual(codes, [['ENGINE_CONFIG_WARNING', 'bwrap unavailable: user namespaces blocked']])
  await run(root, cwd, 'hello', { threadId: thread, clientMessageId: 'dsh-msg-2' })
  const calls = await lines(root, 'calls.jsonl')
  assert.equal(calls.find(c => c.method === 'thread/resume').params.excludeTurns, true)
  assert.deepEqual(calls.filter(c => c.method === 'turn/start').map(c => c.params.clientUserMessageId), ['dsh-msg-1', 'dsh-msg-2'])
})

test('preflight collects startup config warnings', async t => {
  const { root, cwd } = await fixture(t)
  const result = await preflight(config(root, { FIXTURE_STARTUP_WARNING: '1' }), cwd)
  assert.deepEqual(result.warnings, ['bwrap unavailable'])
})

test('a transient account/read failure is retried before the turn; persistent failure is ENGINE_UPSTREAM', async t => {
  const { root, cwd } = await fixture(t)
  const events = await run(root, cwd, 'hello', {}, { FIXTURE_ACCOUNT_FAILURES: '2' })
  assert.equal(text(events), 'streamed response\n\n')
  assert.equal((await lines(root, 'calls.jsonl')).filter(c => c.method === 'account/read').length, 3)
  const other = await fixture(t)
  const error = await run(other.root, other.cwd, 'hello', {}, { FIXTURE_ACCOUNT_FAILURES: '9' }).catch(e => e)
  assert.equal(error.code, 'ENGINE_UPSTREAM')
  assert.equal((await lines(other.root, 'calls.jsonl')).some(c => c.method === 'thread/start'), false)
})

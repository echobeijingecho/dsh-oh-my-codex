import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CodexEngine, collaborationParam } from '../lib/codex.js'
import { buildDynamicTools } from '../lib/dsh-tools.js'
import { EngineRouter } from '../lib/router.js'
import { fixture, collect } from './helpers.js'

function engine(root, env = {}) {
  return new CodexEngine({
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
    env: { FIXTURE_STATE_DIR: root, ...env }, rpcTimeoutMs: 3000,
  })
}

function request(cwd, changes = {}) {
  return {
    provider: 'dsh-codex', model: 'fixture-model', sessionId: 'session-1', cwd,
    signal: new AbortController().signal,
    messages: [{ role: 'user', id: 'message-1', content: [{ type: 'text', text: 'remember blue' }] }],
    prompt: 'remember blue',
    permission: { sandbox: 'read-only', approval: 'never' },
    bindThread: async () => {}, ...changes,
  }
}

test('collaborationParam sends plan on request, default only to switch back', () => {
  const base = { model: 'm', reasoningEffort: 'high', instructions: 'DSH governance text' }
  assert.deepEqual(collaborationParam('plan', undefined, base), {
    mode: 'plan',
    settings: { model: 'm', reasoning_effort: 'high', developer_instructions: 'DSH governance text' },
  })
  assert.deepEqual(collaborationParam('default', 'plan', base), {
    mode: 'default',
    settings: { model: 'm', reasoning_effort: 'high', developer_instructions: 'DSH governance text' },
  })
  // Neither plan nor a recorded plan mode: the field stays absent (a null
  // developer_instructions would be backfilled by the server).
  assert.equal(collaborationParam('default', undefined, base), undefined)
  assert.equal(collaborationParam('default', 'default', base), undefined)
  assert.equal(collaborationParam(undefined, undefined, base), undefined)
  assert.equal(collaborationParam('plan', 'default', { model: 'm' }).settings.developer_instructions, null)
})

test('forced tools ride outside the allowlist but still require host registration', () => {
  const schemas = [
    { name: 'exit_plan_mode', description: 'submit plan', parameters: { type: 'object' } },
    { name: 'other_tool', description: 'other', parameters: { type: 'object' } },
  ]
  const forced = buildDynamicTools(schemas, [], ['exit_plan_mode'])
  assert.deepEqual(forced.names, ['exit_plan_mode'])
  assert.equal(forced.resolve('exit_plan_mode'), 'exit_plan_mode')
  const missing = buildDynamicTools([{ name: 'other_tool', description: '', parameters: {} }], [], ['exit_plan_mode'])
  assert.equal(missing.specs, undefined)
})

test('a plan turn sends collaborationMode and surfaces the plan item', async t => {
  const { root, cwd } = await fixture(t)
  const sentModes = []
  const first = await collect(engine(root).run(request(cwd)))
  const threadId = first.find(e => e.type === 'turn').threadId
  const events = await collect(engine(root).run(request(cwd, {
    threadId,
    messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'planmode' }] }],
    prompt: 'planmode',
    instructions: 'Test instructions.',
    collaboration: { desired: 'plan', lastSent: undefined, onSent: async mode => { sentModes.push(mode) } },
  })))
  const plan = events.find(e => e.type === 'plan-item')
  assert.equal(plan.text, '# 调研结论\n先读代码再列步骤')
  assert.match(events.filter(e => e.type === 'reasoning').map(e => e.text).join(''), /（计划草稿）/)
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const starts = calls.filter(c => c.method === 'turn/start')
  assert.equal(starts.at(-1).params.collaborationMode.mode, 'plan')
  assert.equal(starts.at(-1).params.collaborationMode.settings.developer_instructions, 'Test instructions.')
  assert.deepEqual(sentModes, ['plan'])
})

test('a resumed plan thread is switched back to default explicitly', async t => {
  const { root, cwd } = await fixture(t)
  const first = await collect(engine(root).run(request(cwd)))
  const threadId = first.find(e => e.type === 'turn').threadId
  const events = await collect(engine(root, { FIXTURE_RESUME_PLAN: '1' }).run(request(cwd, {
    threadId,
    messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'what color?' }] }],
    prompt: 'what color?',
    collaboration: { desired: 'default', lastSent: undefined, onSent: async () => {} },
  })))
  assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'remember blue\n\n')
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  const start = calls.filter(c => c.method === 'turn/start').at(-1)
  // The thread itself reported plan via resume: default must be explicit.
  assert.equal(start.params.collaborationMode.mode, 'default')
})

function type_is_turn(events, threadId) { return events.find(e => e.type === 'turn') }

test('router persists the collaboration mode actually sent', async t => {
  const { cwd, config } = await fixture(t)
  const calls = []
  const router = new EngineRouter(config, { codex: {
    async *run(r) {
      calls.push(r)
      await r.bindThread('thread-session-1')
      await r.collaboration?.onSent?.('plan')
      yield { type: 'text', text: 'ok' }
    },
  } })
  await collect(router.run(request(cwd, { collaboration: 'plan' })))
  assert.equal(calls[0].collaboration.desired, 'plan')
  const state = await router.store.read('session-1')
  assert.equal(state.collaborationMode, 'plan')
})

test('fork inherits the parent collaboration mode for the switch-back decision', async t => {
  const { cwd, config } = await fixture(t)
  const router = new EngineRouter(config, { codex: {
    async *run(r) {
      calls.push(r)
      await r.bindThread(`thread-${r.prompt}`)
      if (r.collaboration?.lastSent === 'plan') inherited.push(r.collaboration.lastSent)
      yield { type: 'text', text: 'ok' }
    },
  } })
  const calls = []
  const inherited = []
  await collect(router.run(request(cwd, { collaboration: 'plan' })))
  // simulate a fork carrying the parent's mode
  await collect(router.run(request(cwd, {
    sessionId: 'session-fork',
    fork: { threadId: 'thread-remember blue', turnId: 't1', collaborationMode: 'plan', inherited: ['message-1'] },
    messages: [{ role: 'user', id: 'message-2', content: [{ type: 'text', text: 'go' }] }],
  })))
  assert.deepEqual(inherited, ['plan'])
})

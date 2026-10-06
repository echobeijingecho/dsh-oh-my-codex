import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, unlink, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, buildForkSeed } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as plugin from '../lib/index.js'
import { ThreadStore } from '../lib/state.js'
import { fixture, collect } from './helpers.js'

async function harness(t, overrides = {}, codex = {}, planMode = false) {
  const local = await fixture(t)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  for (const service of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry, Commands]) {
    await ctx.plugin(service)
  }
  if (planMode) await ctx.plugin(PlanMode, { section: 'plan:policy' })
  await ctx.plugin(AgentLoop, { agents: [] })
  if (codex.auth?.mode === 'dsh-subscription') {
    ctx.provide('credentials', {
      async resolve(ref) {
        if (ref !== 'OPENAI_CODEX_SUBSCRIPTION_OAUTH') return undefined
        return {
          value: JSON.stringify({
            type: 'oauth',
            access: 'fixture-access',
            refresh: 'fixture-refresh',
            expires: Date.now() + 60_000,
            accountId: 'fixture-account',
          }),
        }
      },
    })
  }
  const fiber = await ctx.plugin(plugin, {
    ...local.config,
    codex: {
      enabled: true, command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/codex-server.mjs', import.meta.url))],
      env: { FIXTURE_STATE_DIR: local.root }, rpcTimeoutMs: 3000,
      models: [{ id: 'fixture-model', name: 'Fixture' }],
      preflight: false,
      ...codex,
      env: { FIXTURE_STATE_DIR: local.root, ...codex.env },
      gateway: { ...local.config.codex.gateway, ...codex.gateway },
    },
    claude: { mode: 'disabled' }, ...overrides,
  })
  return { ...local, ctx, fiber }
}

async function send(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function calls(root) {
  return (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
}

test('published DSH runtime exposes the native model catalog and routes two turns directly', async t => {
  const { ctx, root, cwd, fiber } = await harness(t)
  assert.equal(ctx.llm.listProviders().find(p => p.id === 'dsh-codex').name, 'Codex')
  assert.equal((await ctx.llm.listModels('dsh-codex'))[0].name, 'Codex · Fixture')
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const agent = await ctx.agentLoop.create(SessionId('native-session'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'remember blue')
  await send(agent, 'what color?')
  assert.deepEqual(errors, [])
  const events = agent.session.snapshotEvents()
  const answers = events.filter(e => e.type === 'assistant/message')
  assert.equal(answers.length, 2, JSON.stringify(events))
  assert.match(JSON.stringify(answers[1]), /remember blue/)
  const requests = await calls(root)
  assert.equal(requests.filter(c => c.method === 'thread/start').length, 1)
  assert.equal(requests.filter(c => c.method === 'thread/resume').length, 1)
  assert.deepEqual(requests.filter(c => c.method === 'turn/start').map(c => c.params.input[0].text), ['remember blue', 'what color?'])
  await fiber.dispose()
  assert.equal(ctx.llm.listProviders().some(p => p.id === 'dsh-codex'), false)
})

test('shared subscription auth is injected by Cordis and reaches App Server', async t => {
  const { ctx, cwd } = await harness(t, {}, { auth: { mode: 'dsh-subscription' } })
  assert.equal(ctx.llm.listProviders().find(p => p.id === 'dsh-codex').name, 'Codex')
  const agent = await ctx.agentLoop.create(SessionId('shared-auth-session'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'use the shared login')
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /shared login/)
})

test('gateway publishes explicit models and runs in its own CODEX_HOME', async t => {
  const { ctx, cwd, root } = await harness(t, {}, {
    gateway: {
      enabled: true,
      baseUrl: 'https://gateway.example.invalid/v1',
      models: [
        { id: 'gateway-model-a', name: 'Gateway Model A' },
        { id: 'gateway-model-b', name: 'Gateway Model B' },
      ],
    },
  })
  assert.equal(ctx.llm.listProviders().find(p => p.id === 'dsh-codex-gateway').name, 'Codex · Gateway')
  assert.deepEqual(
    (await ctx.llm.listModels('dsh-codex-gateway')).map(model => model.id),
    ['gateway-model-a', 'gateway-model-b'],
  )
  const agent = await ctx.agentLoop.create(SessionId('gateway-session'), {
    provider: 'dsh-codex-gateway', model: 'gateway-model-b',
  }, { cwd })
  await send(agent, 'use the gateway')
  const config = await readFile(join(root, 'codex-gateway', 'config.toml'), 'utf8')
  assert.match(config, /base_url = "https:\/\/gateway\.example\.invalid\/v1"/)
  assert.match(config, /wire_api = "responses"/)
  const requests = await calls(root)
  assert.equal(requests.find(call => call.method === 'turn/start').params.model, 'gateway-model-b')
})

test('provider ids remain configurable for private deployments and old sessions', async t => {
  const { ctx, cwd } = await harness(t, {
    providers: { codex: 'ziroom-codex', gateway: 'ziroom-codex-gateway' },
  })
  assert.equal(ctx.llm.listProviders().find(p => p.id === 'ziroom-codex').name, 'Codex')
  const agent = await ctx.agentLoop.create(SessionId('legacy-provider-session'), {
    provider: 'ziroom-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'keep the legacy provider id')
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /streamed response/)
})

test('community Claude mode does not register a duplicate Claude provider', async t => {
  const { ctx } = await harness(t, { claude: { mode: 'community', provider: 'claude-code' } })
  assert.equal(ctx.llm.listProviders().some(provider => provider.id === 'claude-code'), false)
})

test('external Codex tool activity is recorded as native DSH tool cards', async t => {
  const { ctx, cwd } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('native-tool'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'tool')
  const events = agent.session.snapshotEvents()
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  assert.equal(calls.length, 1, JSON.stringify(events))
  assert.equal(calls[0].data.name, 'codex:commandExecution')
  assert.equal(results.length, 1, JSON.stringify(events))
  assert.equal(results[0].data.message.isError, false)
  assert.match(JSON.stringify(results[0].data.message), /tool-output/)
})

test('title generation cannot execute a coding agent and uses the explicit auxiliary route', async t => {
  const { ctx, root } = await harness(t, { auxiliaryProvider: 'ordinary', auxiliaryModel: 'title-model' })
  const requests = []
  class Ordinary extends LlmAdapter {
    async *stream(options) {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'title' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'title' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['ordinary'], new Ordinary())
  await collect(ctx.llm.stream({
    provider: 'dsh-codex', model: 'fixture-model', purpose: 'session-title',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'title please' }], source: { kind: 'user' } })],
    signal: new AbortController().signal,
  }))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].model, 'title-model')
  await assert.rejects(readFile(join(root, 'calls.jsonl')), { code: 'ENOENT' })
})

test('engine switch is rejected before dispatch to a different provider', async t => {
  const { ctx, cwd, root } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('locked'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'first')
  ctx.on('agent/request', async (_event, next) => ({ ...await next(), provider: 'ordinary', model: 'other' }))
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await send(agent, 'second')
  assert.ok(errors.some(e => e.code === 'ENGINE_SWITCH'), JSON.stringify(errors))
  assert.equal((await calls(root)).filter(c => c.method === 'turn/start').length, 1)
})

test('native image projection cannot silently discard a new inline image', async t => {
  const { ctx, cwd, root } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('image'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'what is this?' }, {
      type: 'image', attachment: {
        attachmentId: `sha256:${'a'.repeat(64)}`, mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      },
    }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /ENGINE_ATTACHMENT/)
  await assert.rejects(readFile(join(root, 'calls.jsonl')), { code: 'ENOENT' })
})

for (const cancel of [false, true]) test(`native approval is audited and ${cancel ? 'cancellable' : 'grants once'}`, async t => {
  const { ctx, cwd, root } = await harness(t)
  await ctx.plugin(ApprovalService)
  ctx.provide('permissionPresets', {
    current: () => 'workspace-write',
    resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }),
  })
  let asked
  const pending = new Promise(resolve => { asked = resolve })
  ctx.on('approval/request', () => {
    asked()
    return cancel ? new Promise(() => {}) : Promise.resolve('allowed-once')
  })
  const agent = await ctx.agentLoop.create(SessionId('approval'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  const result = send(agent, 'approval')
  await Promise.race([pending, result.then(() => {
    assert.fail(`Turn ended before approval: ${JSON.stringify(agent.session.snapshotEvents())}`)
  })])
  if (cancel) agent.cancel({ kind: 'user' })
  await result
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'approval/asked').length, 1)
  assert.equal(events.find(e => e.type === 'approval/decided').data.outcome, cancel ? 'cancelled' : 'allowed-once')
  if (cancel) {
    await send(agent, 'continue after stopping')
    assert.equal((await calls(root)).filter(c => c.method === 'thread/resume').length, 1)
  } else {
    assert.match(JSON.stringify(events.filter(e => e.type === 'assistant/message')), /accept/)
  }
})

test('lost binding cannot replay an existing conversation into a fresh engine thread', async t => {
  const { ctx, cwd, root, config } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('missing-binding'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'first')
  await unlink(new ThreadStore(config.stateDir, config.ownerId).path('missing-binding'))
  await send(agent, 'continue')
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /ENGINE_STATE/)
  assert.equal((await calls(root)).filter(c => c.method === 'thread/start').length, 1)
})

async function statusOf(config) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const body = JSON.parse(await readFile(join(config.stateDir, 'status.json'), 'utf8'))
      if (body.status.state !== 'starting' && body.status.state !== 'not-started') return body
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('status.json never left starting')
}

test('reasoning, live command output and text are ordered blocks with replay provenance', async t => {
  const { ctx, cwd } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('blocks'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'reasoning')
  await send(agent, 'tool')
  const replies = agent.session.deriveMessages().filter(message => message.role === 'assistant' && message.content.some(b => b.type === 'text'))
  assert.deepEqual(replies[0].content.map(b => [b.type, b.text]), [['reasoning', 'thinking\n\nmore'], ['text', 'reasoned\n\n']])
  const replay = replies[0].source.replayState?.response
  assert.equal(replay?.engine, 'codex')
  assert.equal(typeof replay.threadId, 'string')
  assert.equal(typeof replay.turnId, 'string')
  const live = replies[1].content.find(b => b.type === 'reasoning')
  assert.equal(live.text, '\n$ printf tool-output\ntool-output')
  const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result')
  assert.match(JSON.stringify(result.data.message), /tool-output/)
})

test('a forked DSH conversation continues on a Codex fork through the inherited turn', async t => {
  const { ctx, cwd, root, config } = await harness(t)
  const parent = await ctx.agentLoop.create(SessionId('fork-parent'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(parent, 'remember blue')
  await send(parent, 'remember red')
  const events = parent.session.snapshotEvents()
  const firstReply = events.findIndex(e => e.type === 'assistant/message')
  const boundary = events.slice(firstReply).find(e => e.type === 'step/end' || e.type === 'turn/end') ?? events[firstReply]
  const seed = buildForkSeed(events, boundary.seq)
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('fork-child'),
    meta: { cwd, parentSession: SessionId('fork-parent'), isSeeded: true },
    seed, inheritedEventCount: seed.length,
    agentOptions: { provider: 'dsh-codex', model: 'fixture-model' },
  })
  t.after(() => handle.dispose())
  const errors = []
  ctx.on('agent/error', ({ error }) => errors.push(error))
  await send(handle.agent, 'history?')
  assert.deepEqual(errors, [])
  const answer = handle.agent.session.deriveMessages().filter(m => m.role === 'assistant').at(-1)
  assert.match(JSON.stringify(answer.content), /remember blue\|history\?/)
  assert.doesNotMatch(JSON.stringify(answer.content), /remember red/)
  const requests = await calls(root)
  const fork = requests.find(c => c.method === 'thread/fork')
  assert.ok(fork, JSON.stringify(requests.map(c => c.method)))
  const store = new ThreadStore(config.stateDir, config.ownerId)
  const [parentState, childState] = await Promise.all([store.read('fork-parent'), store.read('fork-child')])
  assert.equal(fork.params.threadId, parentState.threadId)
  assert.notEqual(childState.threadId, parentState.threadId)
  assert.deepEqual(childState.forkedFrom.threadId, parentState.threadId)
  assert.equal(requests.filter(c => c.method === 'thread/start').length, 1)
})

test('a fork whose inherited reply lacks provenance fails closed', async t => {
  const { ctx, cwd, root, config } = await harness(t)
  const parent = await ctx.agentLoop.create(SessionId('legacy-parent'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(parent, 'remember blue')
  // Simulate a parent produced before provenance existed: strip replayState.
  const seed = buildForkSeed(parent.session.snapshotEvents(), parent.session.snapshotEvents().at(-1).seq)
    .map(event => {
      if (event.type !== 'assistant/message') return event
      const { replayState, ...source } = event.data.message.source
      return { ...event, data: { ...event.data, message: { ...event.data.message, source } } }
    })
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('legacy-child'), meta: { cwd, parentSession: SessionId('legacy-parent'), isSeeded: true },
    seed, inheritedEventCount: seed.length, agentOptions: { provider: 'dsh-codex', model: 'fixture-model' },
  })
  t.after(() => handle.dispose())
  await send(handle.agent, 'continue')
  assert.match(JSON.stringify(handle.agent.session.snapshotEvents()), /ENGINE_FORK/)
  assert.equal((await calls(root)).some(c => c.method === 'thread/fork'), false)
  assert.equal(await new ThreadStore(config.stateDir, config.ownerId).read('legacy-child'), undefined)
})

test('Codex questions are answered through the DSH userQuestions service', async t => {
  const { ctx, cwd } = await harness(t)
  const seen = []
  ctx.provide('userQuestions', {
    async ask(request) {
      seen.push(request)
      return { answers: [{ id: 'color', selected: ['red'] }] }
    },
  })
  const agent = await ctx.agentLoop.create(SessionId('questions'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'question')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].agent, agent)
  assert.deepEqual(seen[0].questions.map(q => q.id), ['color'])
  assert.match(JSON.stringify(agent.session.deriveMessages().at(-1).content), /\\"red\\"/)
})

test('allowlisted DSH tools run through ToolRuntime policy and appear as native tool cards', async t => {
  const { ctx, cwd, root } = await harness(t, {}, { dshTools: ['mcp__hive__*'] })
  const executed = []
  ctx.tools.register({
    name: 'mcp__hive__query', description: 'Run governed SQL',
    parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { executed.push(args); return 'rows=1' },
  })
  ctx.tools.register({
    name: 'not_exposed', description: 'hidden', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'no' },
  })
  const policies = []
  ctx.on('tools/pre-execute', (exec, next) => { policies.push(exec.name); return next() })
  const agent = await ctx.agentLoop.create(SessionId('dyn-tools'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'dyntool dsh_mcp__hive__query')
  const start = (await calls(root)).find(c => c.method === 'thread/start')
  assert.deepEqual(start.params.dynamicTools[0].tools.map(tool => tool.name), ['dsh_mcp__hive__query'])
  assert.deepEqual(executed, [{ sql: 'select 1' }])
  assert.deepEqual(policies, ['mcp__hive__query'])
  const card = agent.session.snapshotEvents().find(e => e.type === 'tool/call')
  assert.equal(card.data.name, 'mcp__hive__query')
  assert.match(JSON.stringify(agent.session.deriveMessages().at(-1).content), /rows=1/)
})

test('preflight publishes connected status with the account model list', async t => {
  const { config } = await harness(t, {}, { preflight: true })
  const body = await statusOf(config)
  assert.equal(body.status.state, 'connected')
  assert.deepEqual(body.preflight.models, ['fixture-model', 'fixture-mini', 'fixture-hidden'])
  assert.deepEqual(body.preflight.missing, [])
})

test('preflight surfaces a failed model list without leaking proxy credentials', async t => {
  const { config } = await harness(t, {}, { preflight: true, env: { FIXTURE_MODEL_LIST_FAIL: '1' } })
  const body = await statusOf(config)
  assert.equal(body.status.state, 'connection-failed')
  assert.equal(body.status.code, 'ENGINE_MODEL_LIST')
  assert.doesNotMatch(JSON.stringify(body), /u:p@/)
})

test('enforced model list rejects a configured model the account does not offer', async t => {
  const { ctx, config, cwd, root } = await harness(t, {}, {
    preflight: true, enforceModelList: true,
    models: [{ id: 'fixture-model', name: 'Fixture' }, { id: 'retired-model', name: 'Retired' }],
  })
  const body = await statusOf(config)
  assert.equal(body.status.code, 'ENGINE_MODEL_UNLISTED')
  const agent = await ctx.agentLoop.create(SessionId('retired'), { provider: 'dsh-codex', model: 'retired-model' }, { cwd })
  await send(agent, 'hello')
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /ENGINE_MODEL/)
  assert.equal((await calls(root)).some(c => c.method === 'thread/start'), false)
})

test('model picker gets reasoning efforts and optional discovered models from the account catalog', async t => {
  const { ctx, config } = await harness(t, {}, { preflight: true, discoverModels: true })
  await statusOf(config)
  const models = await ctx.llm.listModels('dsh-codex')
  assert.deepEqual(models.map(m => m.id), ['fixture-model', 'fixture-mini'])
  const resolved = await ctx.llm.resolveModelInfo('dsh-codex', 'fixture-model')
  assert.deepEqual(resolved.reasoning.efforts.map(e => String(e.id)), ['low', 'medium', 'high'])
  assert.equal(String(resolved.reasoning.defaultEffort), 'medium')
})

test('published efforts let DSH reject unsupported ones before any Codex process starts', async t => {
  const { ctx, config, cwd, root } = await harness(t, {}, { preflight: true })
  await statusOf(config)
  const bad = await ctx.agentLoop.create(SessionId('effort-bad'), {
    provider: 'dsh-codex', model: 'fixture-model', reasoningEffort: 'ultra',
  }, { cwd })
  await send(bad, 'hello')
  assert.match(JSON.stringify(bad.session.snapshotEvents()), /UNSUPPORTED_REASONING_EFFORT/)
  assert.equal((await calls(root)).some(c => c.method === 'turn/start'), false)
  const good = await ctx.agentLoop.create(SessionId('effort-good'), {
    provider: 'dsh-codex', model: 'fixture-model', reasoningEffort: 'high',
  }, { cwd })
  await send(good, 'hello')
  assert.equal((await calls(root)).find(c => c.method === 'turn/start').params.effort, 'high')
})

test('token usage reaches DSH and the turn diff becomes a reviewable tool card', async t => {
  const { ctx, cwd } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('usage-diff'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'usage')
  await send(agent, 'diff')
  const events = agent.session.snapshotEvents()
  // Disjoint DSH accounting: 250 input of which 125 cached.
  assert.match(JSON.stringify(events), /"inputTokens":125,"outputTokens":30,"totalTokens":\d+,"cacheReadTokens":125/)
  const card = events.find(e => e.type === 'tool/call' && e.data.name === 'codex:turnDiff')
  assert.ok(card, JSON.stringify(events.map(e => e.type)))
  const result = events.find(e => e.type === 'tool/result' && JSON.stringify(e.data.message).includes('+new'))
  assert.ok(result)
})

test('codex plan checklist lands in the native todo panel', async t => {
  const { ctx, cwd } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('plan'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'plan')
  const events = agent.session.snapshotEvents()
  const writes = events.filter(e => e.type === 'todo/write')
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[0].data.todos, [
    { content: 'read', status: 'in_progress' },
    { content: 'write', status: 'pending' },
  ])
  assert.deepEqual(writes[1].data.todos, [
    { content: 'read', status: 'completed' },
    { content: 'write', status: 'completed' },
  ])
  // The checklist no longer mirrors into reasoning (the panel owns it now).
  assert.equal(events.filter(e => e.type === 'reasoning/message').length, 0)
})

test('native Codex sub-agents land in the same structured todo panel', async t => {
  const { ctx, cwd } = await harness(t, {}, {
    preflight: true,
    multiAgent: { enabled: true, mode: 'explicit', maxAgents: 4, maxDepth: 2 },
  })
  // Preflight runs during plugin startup; wait for its fixture model catalog
  // before the adapter applies the fail-closed multi-agent capability gate.
  await new Promise(resolve => setTimeout(resolve, 150))
  const agent = await ctx.agentLoop.create(SessionId('subagent-todos'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'multi-agent')
  const writes = agent.session.snapshotEvents().filter(e => e.type === 'todo/write')
  assert.ok(writes.length >= 1, JSON.stringify(agent.session.snapshotEvents()))
  const latest = writes.at(-1).data.todos
  assert.deepEqual(latest, [{ content: 'child-1 Codex 子 Agent child-1（fixture-mini）：inspect the repository', status: 'completed' }])
})

test('native multi-agent waits for the startup model preflight before the first turn', async t => {
  const { ctx, cwd } = await harness(t, {}, {
    preflight: true,
    env: { FIXTURE_MODEL_LIST_DELAY_MS: '250' },
    multiAgent: { enabled: true, mode: 'explicit', maxAgents: 4, maxDepth: 2 },
  })
  const agent = await ctx.agentLoop.create(SessionId('subagent-preflight-race'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'multi-agent')
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.doesNotMatch(log, /ENGINE_MULTI_AGENT_UNAVAILABLE/)
  assert.match(log, /Codex 子 Agent/)
})

test('a crashed turn is reconciled and its lost answer recovered on the next message', async t => {
  const { ctx, cwd, root } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('reconcile'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  await send(agent, 'crash-complete')
  await send(agent, 'continue after crash')
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, /【恢复】/)
  assert.match(log, /RECOVERED/)
  const all = await calls(root)
  const listed = all.filter(c => c.method === 'thread/turns/list')
  assert.ok(listed.length >= 1)
  assert.equal(listed[0].params.itemsView, 'summary')
  const starts = all.filter(c => c.method === 'turn/start')
  assert.equal(starts.length, 3)
  assert.equal(new Set(all.filter(c => c.method === 'thread/resume').map(c => c.params.threadId)).size, 1)
  assert.equal(starts[2].params.input[0].text, 'continue after crash')
})

test('an interrupted crash is reconciled without replaying the lost prompt', async t => {
  const { ctx, cwd, root } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('reconcile-interrupted'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  await send(agent, 'crash-dispatch')
  await send(agent, 'continue after crash')
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, /【恢复】[\s\S]*已中断/)
  const starts = (await calls(root)).filter(c => c.method === 'turn/start')
  assert.equal(starts.length, 3)
  // warm up, the crashed turn, and the new message — the lost prompt is not replayed.
  assert.equal(starts[2].params.input[0].text, 'continue after crash')
})

test('reconciliation falls back to thread/read when turns/list is unsupported', async t => {
  const { ctx, cwd, root } = await harness(t, {}, { env: { FIXTURE_TURNS_UNSUPPORTED: '1' } })
  const agent = await ctx.agentLoop.create(SessionId('reconcile-read'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  await send(agent, 'crash-complete')
  await send(agent, 'continue after crash')
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, /【恢复】[\s\S]*RECOVERED/)
  const all = await calls(root)
  assert.ok(all.some(c => c.method === 'thread/read' && c.params.includeTurns === true))
})

async function waitForCall(root, method) {
  for (let i = 0; i < 150; i += 1) {
    try {
      const all = await calls(root)
      if (all.some(c => c.method === method)) return all
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${method}`)
}

test('a steered message joins the running Codex turn', async t => {
  const { ctx, cwd, root, config } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('steer'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  const done = send(agent, 'steerable')
  await waitForCall(root, 'turn/start')
  const steered = createUserMessage({
    content: [{ type: 'text', text: '先看失败测试' }],
    source: { kind: 'user', rpcId: 'req-1' },
  })
  agent.steer(steered)
  await done
  const all = await calls(root)
  const steerCalls = all.filter(c => c.method === 'turn/steer')
  assert.equal(steerCalls.length, 1)
  assert.equal(steerCalls[0].params.clientUserMessageId, 'req-1')
  assert.match(steerCalls[0].params.input[0].text, /先看失败测试/)
  assert.equal(all.filter(c => c.method === 'turn/start').length, 1)
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, /steered:先看失败测试/)
  assert.match(log, /已插话并入当前执行/)
  // The message left the inbox and landed durably (no re-send next step).
  assert.equal(agent.inbox.nextStep.length, 0)
  const events = agent.session.snapshotEvents()
  const userWrites = events.filter(e => e.type === 'user/message')
  assert.equal(userWrites.filter(e => e.data?.id === steered.id).length, 1)
  const state = JSON.parse(await readFile(new ThreadStore(config.stateDir, config.ownerId).path('steer'), 'utf8'))
  assert.ok(state.delivered.includes(steered.id))
})

test('a failed steer degrades to queue semantics on the next turn', async t => {
  const { ctx, cwd, root } = await harness(t, {}, { env: { FIXTURE_STEER_REJECT: '1' } })
  const agent = await ctx.agentLoop.create(SessionId('steer-reject'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  const done = send(agent, 'steerable')
  await waitForCall(root, 'turn/start')
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: '先看失败测试' }],
    source: { kind: 'user', rpcId: 'req-2' },
  }))
  await done
  const all = await calls(root)
  const starts = all.filter(c => c.method === 'turn/start')
  assert.equal(starts.length, 2)
  assert.match(starts[1].params.input[0].text, /先看失败测试/)
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, /插话未送达/)
})

const INTEGRATION_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

function imageRef(name = 'shot.png') {
  return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType: 'image/png', bytes: INTEGRATION_PNG.length, width: 1, height: 1, name }
}

function attachmentsStub() {
  return {
    async readImage(ref) { return { ref, data: new Uint8Array(INTEGRATION_PNG) } },
    imageHostPath: ref => `/fake/attachments/${String(ref.attachmentId).slice(7)}`,
  }
}

test('pasted images reach Codex as localImage, deduplicate and never resend', async t => {
  const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-'))
  t.after(() => rm(codexHome, { recursive: true, force: true }))
  const { ctx, cwd, root } = await harness(t, {}, { imageInput: 'on', env: { CODEX_HOME: codexHome } })
  ctx.provide('attachments', attachmentsStub())
  const agent = await ctx.agentLoop.create(SessionId('image'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  const withImage = () => createUserMessage({ content: [
    { type: 'text', text: 'image' },
    { type: 'image', attachment: imageRef() },
  ], source: { kind: 'user' } })
  await send2(agent, withImage())
  await send2(agent, withImage())
  const all = await calls(root)
  const starts = all.filter(c => c.method === 'turn/start')
  assert.equal(starts.length, 2)
  for (const start of starts) {
    const local = start.params.input.filter(item => item.type === 'localImage')
    assert.equal(local.length, 1)
    assert.match(local[0].path, /dsh-input-images\/[0-9a-f]{64}\.png$/)
    assert.equal(local[0].path.startsWith(codexHome), true)
    const staged = await readFile(local[0].path)
    assert.equal(staged.length, INTEGRATION_PNG.length)
    assert.match(start.params.input[0].text, /# 用户提供的图片:/)
  }
  assert.equal(starts[0].params.input.find(i => i.type === 'localImage').path,
    starts[1].params.input.find(i => i.type === 'localImage').path)
  const log = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log, new RegExp(`image:${INTEGRATION_PNG.length}`))
  // A follow-up text turn resends no image.
  await send(agent, 'and in words?')
  const finalStarts = (await calls(root)).filter(c => c.method === 'turn/start')
  assert.equal(finalStarts.length, 3)
  assert.equal(finalStarts[2].params.input.some(item => item.type === 'localImage'), false)
  assert.equal(finalStarts[2].params.input[0].text, 'and in words?')
})

test('imageInput off refuses images loudly instead of silently dropping them', async t => {
  const { ctx, cwd, root } = await harness(t, {}, { imageInput: 'off' })
  ctx.provide('attachments', attachmentsStub())
  const agent = await ctx.agentLoop.create(SessionId('image-off'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send2(agent, createUserMessage({ content: [
    { type: 'text', text: 'hello' },
    { type: 'image', attachment: imageRef() },
  ], source: { kind: 'user' } }))
  const log = JSON.stringify(agent.session.snapshotEvents())
  // The durable backstop fires before dispatch: no silent placeholder, no turn.
  assert.match(log, /ENGINE_ATTACHMENT/)
  // The refusal happens before the engine spawns: no fixture calls at all.
  let methods = []
  try { methods = (await calls(root)).map(c => c.method) } catch {}
  assert.equal(methods.includes('turn/start'), false)
})

async function send2(agent, message) {
  agent.followup(message)
  await agent.whenIdle()
}

test('session commands appear for Codex sessions and execute end to end', async t => {
  const { ctx, cwd, root } = await harness(t)
  const agent = await ctx.agentLoop.create(SessionId('commands'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  const definitions = ctx.commands.list(agent)
  for (const name of ['status', 'review', 'compact']) {
    assert.ok(definitions.find(command => command.name === name), `${name} registered`)
  }
  const status = await ctx.commands.execute(agent, '/status', [], new AbortController().signal)
  assert.equal(status.result.kind, 'success')
  assert.match(status.result.text, /Codex 引擎状态/)
  assert.match(status.result.text, /user@example.com/)
  assert.match(status.result.text, /主窗口已用 20%/)
  const review = await ctx.commands.execute(agent, '/review focus on errors', [], new AbortController().signal)
  assert.equal(review.result.kind, 'success')
  assert.match(review.result.text, /- Prefer Stylize helpers — \/tmp\/f\.rs:10-20/)
  const all = await calls(root)
  const reviewCall = all.find(c => c.method === 'review/start')
  assert.deepEqual(reviewCall.params.target, { type: 'custom', instructions: 'focus on errors' })
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /command\/run/)
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /command\/done/)
})

test('/compact runs the native Codex compaction through the same lock', async t => {
  const { ctx, cwd, root } = await harness(t, {}, { env: { FIXTURE_RESUME_USAGE: '1' } })
  const agent = await ctx.agentLoop.create(SessionId('commands-compact'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  const result = await ctx.commands.execute(agent, '/compact', [], new AbortController().signal)
  assert.equal(result.result.kind, 'success')
  assert.match(result.result.text, /50,000 → 5,000 tokens（约释放 90%）/)
  const all = await calls(root)
  assert.ok(all.some(c => c.method === 'thread/compact/start'))
  const statePath = join(root, 'state', createHash('sha256').update(JSON.stringify(['test-user:web', 'commands-compact'])).digest('hex') + '.json')
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  assert.equal(state.status, 'ready')
})

test('plan mode maps onto Codex collaborationMode with the exit tool declared', async t => {
  const { ctx, cwd, root } = await harness(t, {}, {}, true)
  const agent = await ctx.agentLoop.create(SessionId('plan'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  assert.equal(ctx.planMode.set(agent, true), 'committed')
  const log = JSON.stringify(agent.session.snapshotEvents())
  await send(agent, 'planmode')
  const all = await calls(root)
  const start = all.filter(c => c.method === 'turn/start').at(-1)
  assert.equal(start.params.collaborationMode.mode, 'plan')
  assert.equal(start.params.collaborationMode.settings.developer_instructions !== null, true)
  const threadStart = all.find(c => c.method === 'thread/start')
  const dsh = threadStart.params.dynamicTools?.find?.(spec => spec.name === 'dsh')
  assert.ok(dsh?.tools?.some(tool => tool.name === 'exit_plan_mode'), 'exit tool declared at thread creation')
  const log2 = JSON.stringify(agent.session.snapshotEvents())
  assert.match(log2, /计划模式：Codex 将只读调研/)
  assert.match(log2, /计划草稿/)
})

test('a submitted plan without an exit call gets the fallback review card', async t => {
  const { ctx, cwd, root } = await harness(t, {}, {}, true)
  const asked = []
  ctx.provide('userQuestions', {
    async ask(request) {
      asked.push(request)
      return { answers: [{ id: 'plan-review', selected: ['Approve'] }] }
    },
  })
  const agent = await ctx.agentLoop.create(SessionId('plan-fallback'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  ctx.planMode.set(agent, true)
  await send(agent, 'planmode')
  assert.equal(asked.length, 1)
  assert.equal(asked[0].questions[0].intent.kind, 'plan-review')
  assert.equal(asked[0].questions[0].intent.approve, 'Approve')
  assert.match(asked[0].questions[0].detail, /# 调研结论/)
  const events = agent.session.snapshotEvents()
  assert.equal(events.filter(e => e.type === 'tool/call' && e.data?.name === 'exit_plan_mode').length, 1)
  assert.equal(events.filter(e => e.type === 'tool/result').at(-1).data.error, undefined)
  // Like the native exit tool, the approval takes effect from the next step:
  // get() reports { active: true, pending: false } — a queued switch to false.
  const queued = ctx.planMode.get(agent)
  assert.equal(queued.active, true)
  assert.equal(queued.pending, false)
  await send(agent, 'go ahead')
  assert.equal(ctx.planMode.get(agent).active, false)
  const starts = (await calls(root)).filter(c => c.method === 'turn/start')
  assert.equal(starts.at(-1).params.collaborationMode.mode, 'default')
})

test('plan mode off sends default explicitly only after a plan turn', async t => {
  const { ctx, cwd, root } = await harness(t, {}, {}, true)
  const agent = await ctx.agentLoop.create(SessionId('plan-off'), {
    provider: 'dsh-codex', model: 'fixture-model',
  }, { cwd })
  await send(agent, 'warm up')
  const before = (await calls(root)).filter(c => c.method === 'turn/start').at(-1)
  assert.equal(before.params.collaborationMode, undefined)
  ctx.planMode.set(agent, true)
  await send(agent, 'planmode')
  ctx.planMode.set(agent, false)
  await send(agent, 'warm up')
  const starts = (await calls(root)).filter(c => c.method === 'turn/start')
  assert.equal(starts.at(-1).params.collaborationMode.mode, 'default')
})

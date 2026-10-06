import z from '@deepseek-ai/schemastery'
import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { CodexEngine, DEFAULT_DISABLED_FEATURES, preflight } from './codex.js'
import {
  EngineRouter,
  COMMUNITY_ROUTES,
  ROUTES,
  LABELS,
  assertEngineSwitch,
} from './router.js'
import { EngineError, engineFailure } from './errors.js'
import { createExternalToolRecorder, subagentTodo, writePlanTodos, writeTodoSnapshot } from './external-tools.js'
import { Diagnostics } from './diagnostics.js'
import { buildDynamicTools, dynamicToolResponse, NAMESPACE } from './dsh-tools.js'
import { AccountService } from './account.js'
import { createDshSubscriptionAuthBroker } from './auth-broker.js'
import { imageStagingRoot, sweepStaleImages } from './images.js'
import { createSessionCommands } from './commands.js'
import { planReviewFallback } from './plan-mode.js'
import { API_PREFIX, createHandler } from './http.js'
import { PACKAGE_NAME } from './identity.js'

export const name = PACKAGE_NAME
export const inject = ['llm', 'agents']

const LIVE_OUTPUT_LIMIT = 4096
const DIFF_LIMIT = 64 * 1024

const model = z.object({ id: z.string().min(1).required(), name: z.string().min(1).required() })
const engineShape = {
  enabled: z.boolean().default(false),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.dict(z.string()).default({}),
  models: z.array(model).default([]),
  rpcTimeoutMs: z.number().min(1000).max(120000).default(30000),
  reasoningSummary: z.union(['auto', 'concise', 'detailed', 'none', 'default']).default('auto'),
  disableShellSnapshot: z.boolean().default(true),
  // Disable Codex surfaces that bypass DSH governance (see DEFAULT_DISABLED_FEATURES).
  hardening: z.boolean().default(true),
  disableFeatures: z.array(z.string().min(1)).default(DEFAULT_DISABLED_FEATURES),
  // Native Codex sub-agents are opt-in. Explicit mode relies on the user's
  // request; proactive mode is reserved for a later policy-controlled rollout.
  multiAgent: z.object({
    enabled: z.boolean().default(false),
    maxAgents: z.number().min(1).max(8).default(4),
    maxDepth: z.number().min(1).max(4).default(2),
    mode: z.union(['explicit', 'proactive']).default('explicit'),
  }).default({}),
  dshTools: z.array(z.string().min(1)).default([]),
  preflight: z.boolean().default(true),
  enforceModelList: z.boolean().default(false),
  discoverModels: z.boolean().default(false),
  dshInstructions: z.union(['full', 'minimal', 'none']).default('full'),
  dropInstructionSections: z.array(z.string().min(1)).default(['技能', 'skills?']),
  // native: Codex bubblewrap sandbox. external: the container is the boundary.
  sandboxMode: z.union(['native', 'external']).default('native'),
  // Deliver mid-turn user messages into the running Codex turn (turn/steer)
  // instead of waiting for the turn to end.
  steer: z.boolean().default(true),
  // Map DSH plan mode onto Codex collaborationMode and expose exit_plan_mode.
  planMode: z.boolean().default(true),
  // auto: follow the preflight model catalog's inputModalities (fail closed to
  // text-only when no catalog); on/off force the capability.
  imageInput: z.union(['auto', 'on', 'off']).default('auto'),
  imageMaxBytes: z.number().min(1).max(26214400).default(26214400),
  maxImagesPerTurn: z.number().min(1).max(20).default(20),
  imageRetentionDays: z.number().min(0).max(365).default(14),
  auth: z.object({
    mode: z.union(['native', 'dsh-subscription']).default('native'),
    credentialRef: z.string().default('OPENAI_CODEX_SUBSCRIPTION_OAUTH'),
    legacyCredentialRefs: z.array(z.string()).default(['WSL043_OPENAI_CODEX_OAUTH']),
  }).default({}),
}
const gateway = z.object({
  ...engineShape,
  enabled: z.boolean().default(false),
  home: z.string().default(''),
  baseUrl: z.string().default(''),
  providerName: z.string().default('litellm'),
  apiKeyEnv: z.string().default('CODEX_GATEWAY_API_KEY'),
  apiKeyFile: z.string().default(''),
  apiKeyFileEnv: z.string().default(''),
  wireApi: z.union(['chat', 'responses']).default('responses'),
  imageInput: z.union(['auto', 'on', 'off']).default('off'),
}).default({})
const claudeIntegration = z.object({
  mode: z.union(['community', 'disabled']).default('disabled'),
  provider: z.string().default('claude-code'),
}).default({})
export const Config = z.object({
  ownerId: z.string().min(1).required(),
  stateDir: z.string().min(1).required(),
  allowedWorkspaces: z.array(z.string().min(1)).required(),
  turnTimeoutMs: z.number().min(1000).max(3600000).default(900000),
  maxInputBytes: z.number().min(1024).max(16777216).default(1048576),
  maxOutputBytes: z.number().min(1024).max(16777216).default(4194304),
  auxiliaryProvider: z.string().default(''),
  auxiliaryModel: z.string().default(''),
  providers: z.object({
    codex: z.string().min(1).default('dsh-codex'),
    gateway: z.string().min(1).default('dsh-codex-gateway'),
  }).default({}),
  codex: z.object({ ...engineShape, gateway }).default({}),
  claude: claudeIntegration,
  settingsUi: z.boolean().default(true),
})

function managedRoutes(config) {
  return {
    [config.providers.codex]: 'codex',
    [config.providers.gateway]: 'codex-gateway',
  }
}

function configuration(config) {
  if (!config.allowedWorkspaces.length) throw new Error('oh-my-codex requires allowedWorkspaces')
  const routes = managedRoutes(config)
  if (config.providers.codex === config.providers.gateway) {
    throw new Error('providers.codex and providers.gateway must be different')
  }
  if (Boolean(config.auxiliaryProvider) !== Boolean(config.auxiliaryModel)
      || routes[config.auxiliaryProvider]
      || (config.claude.mode === 'community' && config.auxiliaryProvider === config.claude.provider)) {
    throw new Error('oh-my-codex auxiliaryProvider/auxiliaryModel must name an ordinary DSH route together')
  }
  if (config.claude.mode === 'community' && config.claude.provider !== 'claude-code') {
    throw new Error('claude.provider must be claude-code when using the optional Claude community adapter')
  }
  if (config.claude.mode === 'community' && routes[config.claude.provider]) {
    throw new Error('claude.provider must not reuse a Codex provider id')
  }
  if (config.codex.enabled) {
    if (!config.codex.models.length || !config.codex.command) {
      throw new Error('codex requires an executable and explicit model catalog')
    }
    if (new Set(config.codex.models.map(m => m.id)).size !== config.codex.models.length) {
      throw new Error('codex has duplicate model ids')
    }
  }
  if (config.codex.gateway.enabled) {
    if (!config.codex.gateway.models.length || !(config.codex.gateway.command || config.codex.command)) {
      throw new Error('codex.gateway requires an executable and explicit model catalog')
    }
    if (!config.codex.gateway.home) {
      throw new Error('codex.gateway requires a dedicated CODEX_HOME')
    }
    if (!/^https?:\/\//u.test(config.codex.gateway.baseUrl)) {
      throw new Error('codex.gateway.baseUrl must be an http(s) URL')
    }
    if (new Set(config.codex.gateway.models.map(m => m.id)).size !== config.codex.gateway.models.length) {
      throw new Error('codex.gateway has duplicate model ids')
    }
  }
  return config
}

function gatewayEngineConfig(config) {
  const source = config.codex
  const gatewayConfig = config.codex.gateway
  return {
    ...source,
    ...gatewayConfig,
    command: gatewayConfig.command || source.command,
    args: gatewayConfig.command ? gatewayConfig.args : source.args,
    env: {
      ...source.env,
      ...gatewayConfig.env,
      CODEX_HOME: gatewayConfig.home,
    },
    models: gatewayConfig.models,
    gatewayRuntime: {
      displayName: 'Codex Gateway',
      providerName: gatewayConfig.providerName,
      baseUrl: gatewayConfig.baseUrl,
      apiKeyEnv: gatewayConfig.apiKeyEnv,
      apiKeyFile: gatewayConfig.apiKeyFile,
      apiKeyFileEnv: gatewayConfig.apiKeyFileEnv,
      wireApi: gatewayConfig.wireApi,
    },
    preflight: false,
    discoverModels: false,
    enforceModelList: false,
  }
}

function permissionOf(ctx, agent) {
  const presets = ctx.get('permissionPresets')
  const current = presets?.current(agent.session)
  const permission = current ? presets.resolve(current) : { sandbox: 'read-only', approval: 'never' }
  if (!['read-only', 'workspace-write'].includes(permission.sandbox)) {
    throw new EngineError('ENGINE_PERMISSION')
  }
  return permission
}

/**
 * DSH composes its system prompt for its own agent loop: skill catalogues and
 * tool guidance for tools Codex does not have. `minimal` drops level-2
 * sections whose heading matches `dropInstructionSections`; `none` sends
 * nothing (Codex keeps its own base instructions and CODEX_HOME/AGENTS.md).
 */
export function shapeInstructions(text, { dshInstructions = 'full', dropInstructionSections = [] } = {}) {
  if (dshInstructions === 'none') return ''
  if (dshInstructions !== 'minimal' || !text) return text
  const patterns = dropInstructionSections.map(pattern => new RegExp(pattern, 'i'))
  const sections = text.split(/(?=^## )/m)
  return sections
    .filter(section => {
      const heading = section.startsWith('## ') ? section.slice(3, section.indexOf('\n') >>> 0) : ''
      return !heading || !patterns.some(pattern => pattern.test(heading))
    })
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Codex provenance recorded on the newest Codex assistant message, if any. */
export function inheritedProvenance(messages, provider, routes = ROUTES) {
  const expectedEngine = routes[provider] ?? 'codex'
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'assistant' || message.source?.provider !== provider) continue
    const replay = message.source.replayState?.response
    if (replay?.engine !== expectedEngine || typeof replay.threadId !== 'string' || typeof replay.turnId !== 'string') {
      return { index, incomplete: true }
    }
    return { index, threadId: replay.threadId, turnId: replay.turnId }
  }
  return undefined
}

/**
 * Text, reasoning and live command output share one ordered assistant message.
 * Blocks are opened and closed strictly in sequence so DSH assembles them in
 * the order Codex produced them.
 */
class BlockWriter {
  blocks = [];
  // Generator methods after a class field need the explicit semicolon above.
  current = undefined;

  *write(kind, text) {
    if (!text) return
    if (this.current?.kind !== kind) {
      yield* this.close()
      this.current = { kind, index: this.blocks.length, text: '' }
      this.blocks.push(this.current)
      yield { type: 'block-start', index: this.current.index, blockType: kind }
    }
    this.current.text += text
    yield { type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: this.current.index, text }
  }

  *close() {
    if (!this.current) return
    const { kind, index, text } = this.current
    this.current = undefined
    yield { type: 'block-end', index, block: { type: kind, text } }
  }
}

class EngineAdapter extends LlmAdapter {
  constructor(ctx, config, router, diagnostics, engineConfigs, preflightReady = () => Promise.resolve()) {
    super()
    this.ctx = ctx
    this.config = config
    this.router = router
    this.diagnostics = diagnostics
    this.engineConfigs = engineConfigs
    this.routes = router.routes
    this.preflightReady = preflightReady
  }

  providerInfo(provider) { return { id: provider, name: LABELS[this.routes[provider]] } }

  /**
   * Steer observer: durable inbox splices for THIS plugin's running turns are
   * forwarded into the Codex turn. Tool-context injections also splice into
   * next-step, so only genuine user input (rpcId + all-text blocks) counts.
   * Every failure path leaves the inbox untouched, which degrades to DSH's
   * native queue-and-claim on the next step boundary.
   */
  onSessionEvent(session, event) {
    if (!this.config.codex.steer || this.config.codex.enabled !== true) return
    if (event?.type !== 'agent/inbox/spliced' || event.data?.target !== 'next-step') return
    const inserted = Array.isArray(event.data.inserted) ? event.data.inserted : []
    for (const message of inserted) {
      if (!message || message.role !== 'user' || message.source?.kind !== 'user') continue
      const blocks = Array.isArray(message.content) ? message.content : []
      if (!blocks.length || !blocks.every(block => block?.type === 'text' && typeof block.text === 'string')) continue
      void this.steerMessage(session, message, blocks)
    }
  }

  async steerMessage(session, message, blocks) {
    const outcome = await this.router.steer(session.id, {
      messageId: message.id,
      text: blocks.map(block => block.text).join('\n'),
      clientUserMessageId: typeof message.source?.rpcId === 'string' ? message.source.rpcId : undefined,
    })
    if (outcome.status === 'steered') this.retireSteeredMessage(session.id, message)
    else if (outcome.status === 'failed') void this.diagnostics.record('ENGINE_STEER_FAILED', {})
  }

  // The message must leave the inbox and land as a durable user/message, or
  // DSH would re-send it as the next step once this turn ends.
  retireSteeredMessage(sessionId, message) {
    let agent
    try { agent = this.ctx.agents?.get?.(sessionId) } catch { return }
    if (!agent?.inbox || typeof agent.inbox.remove !== 'function') return
    try {
      if (!agent.inbox.remove(message.id)) {
        void this.diagnostics.record('ENGINE_STEER_RACE', { stage: 'claimed' })
        return
      }
      agent.session.append('user/message', message, { surfaceOp: 'append' })
    } catch (error) {
      void this.diagnostics.record('ENGINE_STEER_RACE', { stage: 'append', message: String(error?.message ?? error).slice(0, 300) })
    }
  }
  providerRetryPolicy() {
    return { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 }
  }
  engineConfig(provider) { return this.engineConfigs[this.routes[provider]] ?? this.config.codex }

  catalogEntry(provider, id) {
    if (this.routes[provider] !== 'codex') return undefined
    return this.diagnostics.preflight?.catalog?.find(entry => entry.id === id)
  }

  /** The declared modality decides two gates: whether DSH keeps image blocks
   *  intact on the way in (dsh-llm projects them away otherwise) and whether
   *  the host admits pasted images at all. Missing catalog in auto mode fails
   *  closed — never claim an image capability nobody verified. */
  inputModalitiesFor(config, provider, id) {
    if (config.imageInput === 'off') return ['text']
    if (config.imageInput === 'on') return ['text', 'image']
    const entry = this.catalogEntry(provider, id)
    if (!entry) {
      if (this.diagnostics.preflight?.models) void this.diagnostics.record('ENGINE_IMAGE_UNVERIFIED', { model: id })
      return ['text']
    }
    return entry.inputModalities.includes('image') ? ['text', 'image'] : ['text']
  }

  async listModels(provider) {
    const config = this.engineConfig(provider)
    const label = LABELS[this.routes[provider]]
    const models = config.models.map(model => ({
      provider, id: model.id, inputModalities: this.inputModalitiesFor(config, provider, model.id),
      // A catalog display name beats a config name that merely repeats the id.
      name: `${label} · ${model.name === model.id && this.catalogEntry(provider, model.id)?.displayName ? this.catalogEntry(provider, model.id).displayName : model.name}`,
      ...(this.catalogEntry(provider, model.id)?.description ? { description: this.catalogEntry(provider, model.id).description } : {}),
    }))
    if (config.discoverModels) {
      const configured = new Set(config.models.map(model => model.id))
      for (const entry of this.diagnostics.preflight?.catalog ?? []) {
        if (entry.hidden || configured.has(entry.id)) continue
        models.push({ provider, id: entry.id, name: `${label} · ${entry.displayName}`, inputModalities: this.inputModalitiesFor(config, provider, entry.id), description: entry.description })
      }
    }
    return models
  }

  async resolveModel(provider, id) {
    const listedModel = (await this.listModels(provider)).find(model => model.id === id)
    if (!listedModel) throw new EngineError('ENGINE_MODEL')
    const entry = this.catalogEntry(provider, id)
    const contextWindow = this.diagnostics.contextWindows?.[id]
    const model = {
      ...listedModel,
      ...(entry?.efforts?.length
        ? {
            reasoning: {
              efforts: entry.efforts.map(effort => ({ id: ReasoningEffortId(effort.id), name: effort.id, ...(effort.description ? { description: effort.description } : {}) })),
              ...(entry.defaultEffort ? { defaultEffort: ReasoningEffortId(entry.defaultEffort) } : {}),
            },
          }
        : {}),
      ...(contextWindow ? { context: { contextWindow } } : {}),
      ...(entry?.multiAgentVersion ? { multiAgentVersion: entry.multiAgentVersion } : {}),
    }
    const listed = this.routes[provider] === 'codex' ? this.diagnostics.preflight?.models : undefined
    if (this.engineConfig(provider).enforceModelList && listed && !listed.includes(id)) {
      // Thrown outside stream(): only an LlmError keeps its code through DSH.
      throw new LlmError('This Codex account does not offer the configured model (model/list). No other model was used.', 'ENGINE_MODEL')
    }
    return model
  }

  async forkRequest(agent, options) {
    const parent = agent.session.header?.parentSession
    const provenance = inheritedProvenance(options.messages, options.provider, this.routes)
    if (!parent) return undefined
    if (!provenance) {
      // Inherited history without a completed Codex reply must not be replayed
      // into a fresh thread.
      if (options.messages.some(message => message.role === 'assistant')) {
        throw new EngineError('ENGINE_FORK', 'no completed reply')
      }
      return undefined
    }
    if (provenance.incomplete) {
      throw new EngineError('ENGINE_FORK', 'no provenance')
    }
    const source = await this.router.store.read(parent)
    if (!source || source.engine !== this.routes[options.provider] || source.threadId !== provenance.threadId) {
      throw new EngineError('ENGINE_FORK', 'not owned')
    }
    const inherited = options.messages.slice(0, provenance.index)
      .filter(message => message.role === 'user' && message.id).map(message => message.id)
    return { threadId: provenance.threadId, turnId: provenance.turnId, inherited }
  }

  dshTools(options) {
    const config = this.engineConfig(options.provider)
    const include = config.dshTools
    // exit_plan_mode must ride the thread-creation declaration (dynamicTools
    // exist only on thread/start), so it is forced whenever the host has it —
    // a /plan can arrive long after the thread exists.
    const forced = config.planMode && Array.isArray(options.tools)
      && options.tools.some(schema => schema?.name === 'exit_plan_mode')
      ? ['exit_plan_mode'] : []
    if ((!include.length && !forced.length) || !Array.isArray(options.tools)) return undefined
    return buildDynamicTools(options.tools, include, forced)
  }

  planStateOf(agent, provider) {
    if (!this.engineConfig(provider).planMode) return false
    try {
      return this.ctx.get('sessionProjections')?.stateOf(agent.session, 'plan')?.active === true
    } catch {
      return false
    }
  }

  async *stream(options) {
    const writer = new BlockWriter()
    let recorder
    let turn
    let taskAgent
    let currentPlan = []
    const subagentTasks = new Map()
    try {
      if (options.purpose) {
        if (!this.config.auxiliaryProvider) throw new EngineError('ENGINE_AUXILIARY')
        yield* this.ctx.llm.stream({
          ...options, provider: this.config.auxiliaryProvider, model: this.config.auxiliaryModel,
          reasoningEffort: undefined, tools: undefined,
        })
        return
      }
      const agent = this.ctx.agents.requireInitiator()
      taskAgent = agent
      if (agent.session.id !== options.sessionId) throw new EngineError('ENGINE_SESSION')
      const binding = await this.router.store.read(agent.session.id)
      const fork = binding ? undefined : await this.forkRequest(agent, options)
      const delivered = new Set(binding?.delivered ?? fork?.inherited ?? [])
      const engineConfig = this.engineConfig(options.provider)
      // Durable backstop: images that reach us while the resolved model (per
      // the same modality we declared) cannot take them must fail loudly —
      // dsh-llm already projected images away for text-only declarations, so
      // an image surviving here means the durable source disagrees.
      const imageCapable = this.inputModalitiesFor(engineConfig, options.provider, options.model).includes('image')
      if (!imageCapable && agent.session.deriveMessages().some(message => message.role === 'user'
          && !delivered.has(message.id) && message.content.some(block => block.type === 'image' && !block.offloaded))) {
        throw new EngineError('ENGINE_ATTACHMENT')
      }
      const planActive = this.planStateOf(agent, options.provider)
      const permission = permissionOf(this.ctx, agent)
      const instructions = shapeInstructions(options.messages
        .filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => typeof message.content === 'string' ? message.content : message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'))
        .join('\n\n'), engineConfig)
      const tools = this.dshTools(options)
      const multiAgent = engineConfig.multiAgent
      // Preflight is intentionally fire-and-forget during plugin startup, but
      // the capability gate must not race the first user turn. A missing
      // catalog remains fail-closed after preflight completes.
      if (multiAgent?.enabled && this.routes[options.provider] === 'codex') {
        await this.preflightReady()
      }
      const multiAgentVersion = this.catalogEntry(options.provider, options.model)?.multiAgentVersion
      if (multiAgent?.enabled && !['v1', 'v2'].includes(multiAgentVersion)) {
        throw new EngineError('ENGINE_MULTI_AGENT_UNAVAILABLE', options.model)
      }
      const efforts = this.catalogEntry(options.provider, options.model)?.efforts
      let reasoningEffort = options.reasoningEffort
      if (reasoningEffort && efforts?.length && !efforts.some(effort => effort.id === String(reasoningEffort))) {
        // An effort the model does not support would fail the whole turn.
        void this.diagnostics.record('ENGINE_EFFORT_UNSUPPORTED', { model: options.model, effort: String(reasoningEffort) })
        reasoningEffort = undefined
      }
      if (planActive) yield* writer.write('reasoning', '\n（计划模式：Codex 将只读调研，完成后提交计划供审批）\n')
      let pendingPlan
      let exited = false
      const stream = this.router.run({
        ...options, reasoningEffort, cwd: agent.session.header.cwd, permission, instructions, fork, tools,
        imageCapable, collaboration: planActive ? 'plan' : 'default', dsh: { ctx: this.ctx, agent },
        approve: async ({ name, reason, display, signal }) => {
          if (permission.approval !== 'ask' || signal.aborted) return false
          const approval = this.ctx.get('approval')
          if (!approval) return false
          const outcome = await approval.request({
            agent, toolName: name, reason: reason.slice(0, 16000),
            ...(display ? { displayReason: display } : {}),
            signal,
          })
          return outcome === 'allowed-once' && !signal.aborted
        },
        ask: this.ctx.get('userQuestions')
          ? ({ questions, signal }) => this.ctx.get('userQuestions').ask({ questions, agent, signal })
          : undefined,
        callTool: tools ? async ({ namespace, tool, arguments: args, callId, signal }) => {
          const original = namespace === NAMESPACE ? tools.resolve(tool) : undefined
          if (!original) {
            return { contentItems: [{ type: 'inputText', text: `DSH tool ${tool} is not available for this turn.` }], success: false }
          }
          const runtime = this.ctx.get('tools')
          if (!runtime) return { contentItems: [{ type: 'inputText', text: 'DSH tool runtime is unavailable.' }], success: false }
          signal.throwIfAborted()
          const result = await runtime.execute({
            callId: ToolCallId(`codex:${callId}`), name: original, arguments: args ?? {}, agent, signal,
          })
          signal.throwIfAborted()
          return dynamicToolResponse(result)
        } : undefined,
        onDiagnostic: (code, detail) => { void this.diagnostics.record(code, detail) },
      })
      recorder = createExternalToolRecorder(
        agent,
        options.provider,
        options.model,
        message => this.ctx.logger?.warn?.(message),
      )
      const label = LABELS[this.routes[options.provider]]
      const live = new Map()
      let usage
      for await (const event of stream) {
        if (event.type === 'turn') {
          turn = event
          try { this.sessionCommands?.ensure(agent) } catch {}
        } else if (event.type === 'usage') {
          usage = event.usage
          if (event.contextWindow) {
            this.diagnostics.contextWindows ??= {}
            this.diagnostics.contextWindows[options.model] = event.contextWindow
          }
        } else if (event.type === 'diff') {
          // The turn's unified diff, as one reviewable card after the work.
          const body = event.diff.length > DIFF_LIMIT
            ? `${event.diff.slice(0, DIFF_LIMIT)}\n… (diff truncated at ${DIFF_LIMIT} bytes)` : event.diff
          recorder?.start({ id: event.id, name: 'codex:turnDiff', arguments: JSON.stringify({ files: (event.diff.match(/^diff --git /gm) ?? []).length }) })
          recorder?.finish({ id: event.id, output: body, isError: false })
        } else if (event.type === 'tool-output') {
          // DSH 0.1.7 has no in-place tool-card progress event, so live command
          // output is mirrored into the collapsible reasoning stream. The full
          // output still lands on the tool card when the command completes.
          const used = live.get(event.id)
          if (used === undefined || used >= LIVE_OUTPUT_LIMIT) continue
          const chunk = event.delta.slice(0, LIVE_OUTPUT_LIMIT - used)
          live.set(event.id, used + chunk.length)
          const suffix = used + chunk.length >= LIVE_OUTPUT_LIMIT ? '\n… (full output is on the tool card)\n' : ''
          yield* writer.write('reasoning', chunk + suffix)
        } else if (event.type === 'tool-end') {
          if (recorder) recorder.finish(event)
          live.delete(event.id)
        } else if (event.type === 'reasoning') {
          yield* writer.write('reasoning', event.text)
        } else if (event.type === 'subagent') {
          for (const task of subagentTodo(event)) {
            const previous = subagentTasks.get(task.id)
            // Activity-only updates carry the thread id but omit the model and
            // prompt from the original spawn event; retain that context while
            // replacing only the lifecycle status.
            subagentTasks.set(task.id, previous && !task.content.includes('（')
              ? { ...previous, status: task.status } : task)
          }
          writeTodoSnapshot(agent, { plan: currentPlan, subagents: [...subagentTasks.values()] }, message => this.ctx.logger?.warn?.(message))
          const identity = event.agentThreadId || event.receiverThreadIds?.[0] || event.id
          const label = event.kind || event.status || 'activity'
          const detail = event.prompt ? `：${event.prompt.split('\n')[0]}` : ''
          yield* writer.write('reasoning', `\n[Codex 子 Agent ${identity} · ${label}${detail}]\n`)
        } else if (event.type === 'plan') {
          currentPlan = Array.isArray(event.plan) ? event.plan : []
          writePlanTodos(agent, currentPlan, message => this.ctx.logger?.warn?.(message))
        } else if (event.type === 'plan-item') {
          pendingPlan = event.text
        } else if (event.type === 'tool-start') {
          if (recorder) recorder.start(event)
          else yield* writer.write('text', `\n\n[${label}: ${event.name}]\n\n`)
          if (event.name === 'exit_plan_mode') exited = true
          if (event.kind === 'commandExecution' && typeof event.command === 'string') {
            live.set(event.id, 0)
            yield* writer.write('reasoning', `\n$ ${event.command.slice(0, 500)}\n`)
          }
        } else if (event.type === 'steer-note') {
          // Same collapsible reasoning channel as live command output.
          if (event.kind === 'steered') {
            yield* writer.write('reasoning', `\n[已插话并入当前执行：${String(event.text ?? '').split('\n')[0].slice(0, 200)}]\n`)
          } else {
            yield* writer.write('reasoning', '\n[插话未送达当前回合，将在下一轮自动发送]\n')
          }
        } else if (event.type === 'text') {
          yield* writer.write('text', event.text)
        }
      }
      recorder?.finishPending(false)
      if (planActive && pendingPlan && !exited && !options.signal?.aborted) {
        await planReviewFallback({
          ctx: this.ctx, agent, recorder, plan: pendingPlan,
          signal: AbortSignal.any([options.signal ?? new AbortController().signal].filter(Boolean)),
        })
      }
      yield* writer.close()
      if (usage) {
        yield {
          type: 'usage',
          // DSH counts are disjoint; Codex (OpenAI convention) folds cached
          // input into inputTokens, so subtract the cache fields out.
          usage: {
            inputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
            outputTokens: usage.outputTokens, totalTokens: usage.totalTokens,
            cacheReadTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteInputTokens,
            reasoningTokens: usage.reasoningOutputTokens,
          },
        }
      }
      yield {
        type: 'finish', reason: { kind: 'stop' },
        ...(turn ? { replayState: { response: { engine: this.routes[options.provider], threadId: turn.threadId, turnId: turn.turnId } } } : {}),
      }
    } catch (error) {
      if (taskAgent && subagentTasks.size) {
        const interrupted = options.signal?.aborted === true
        const subagents = [...subagentTasks.values()].map(task => ({
          ...task,
          status: 'pending',
          content: `${task.content}${interrupted ? '（已中断）' : '（失败）'}`,
        }))
        writeTodoSnapshot(taskAgent, { plan: currentPlan, subagents }, message => this.ctx.logger?.warn?.(message))
      }
      recorder?.finishPending(true)
      yield* writer.close()
      const failure = engineFailure(error)
      if (!options.signal?.aborted) {
        void this.diagnostics.record(failure.code, {
          message: failure.code === 'ENGINE_FAILED' ? error?.message : undefined,
          stderr: Array.isArray(error?.stderr) ? error.stderr.join('\n') : undefined,
        })
      }
      yield {
        type: 'finish',
        reason: { kind: options.signal?.aborted ? 'aborted' : 'error', failure },
      }
    }
  }
}

async function runPreflight(config, diagnostics, signal, onModels, authBroker) {
  await diagnostics.set('starting')
  try {
    const result = await preflight(config.codex, config.allowedWorkspaces[0], {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(config.codex.rpcTimeoutMs * 3, 10000))]),
      authBroker,
    })
    if (signal.aborted) return
    const configured = config.codex.models.map(model => model.id)
    const missing = result.models ? configured.filter(id => !result.models.includes(id)) : undefined
    diagnostics.preflight = { ...result, configured, missing, at: Date.now() }
    for (const warning of result.warnings ?? []) await diagnostics.record('ENGINE_CONFIG_WARNING', { phase: 'preflight', message: warning })
    if (!result.signedIn) {
      await diagnostics.set('unavailable', { code: 'ENGINE_AUTH', message: 'Codex is not signed in on this instance.', action: 'Sign in Codex for this instance (CODEX_HOME/auth.json), then reload the plugin.' })
    } else if (result.modelError) {
      await diagnostics.set('connection-failed', { code: 'ENGINE_MODEL_LIST', message: result.modelError, action: 'Check the proxy and account; the configured model catalog is used unchanged.' })
    } else if (missing?.length) {
      await diagnostics.set('connected', { code: 'ENGINE_MODEL_UNLISTED', message: `Configured models not offered by model/list: ${missing.join(', ')}`, action: 'Update codex.models to models this account offers.' })
    } else if (result.warnings?.length) {
      await diagnostics.set('connected', { code: 'ENGINE_CONFIG_WARNING', message: result.warnings[0], action: 'See 最近诊断; sandbox warnings usually mean the container blocks user namespaces.' })
    } else {
      await diagnostics.set('connected')
    }
    if (config.codex.discoverModels) onModels?.()
  } catch (error) {
    if (signal.aborted) return
    const failure = engineFailure(error)
    diagnostics.preflight = { at: Date.now(), error: failure.code }
    await diagnostics.record(failure.code, {
      phase: 'preflight',
      message: error?.message,
      stderr: Array.isArray(error?.stderr) ? error.stderr.join('\n') : undefined,
    })
    await diagnostics.set(failure.code === 'ENGINE_START' ? 'unavailable' : 'connection-failed', {
      code: failure.code, message: failure.message,
      action: failure.code === 'ENGINE_START' ? 'Check codex.command on this instance.' : 'Inspect status.json recent entries and the Codex proxy.',
    })
  }
}

function applyRuntime(ctx, input, config, credentials) {
  const authBroker = config.codex.auth.mode === 'dsh-subscription'
    ? createDshSubscriptionAuthBroker(credentials, config.codex.auth)
    : undefined
  const routes = managedRoutes(config)
  const engines = {}
  const engineConfigs = {}
  if (config.codex.enabled) {
    engines.codex = new CodexEngine(config.codex, { authBroker })
    engineConfigs.codex = config.codex
  }
  if (config.codex.gateway.enabled) {
    const gatewayConfig = gatewayEngineConfig(config)
    engines['codex-gateway'] = new CodexEngine(gatewayConfig)
    engineConfigs['codex-gateway'] = gatewayConfig
  }
  const router = new EngineRouter(config, engines, routes)
  const diagnostics = new Diagnostics(config.stateDir, ctx.logger)
  const registeredRoutes = Object.keys(routes).filter(route => engines[routes[route]])
  const externalRoutes = config.claude.mode === 'community'
    ? { ...routes, ...COMMUNITY_ROUTES }
    : routes
  let preflightRun = Promise.resolve()
  const adapter = new EngineAdapter(ctx, config, router, diagnostics, engineConfigs, () => preflightRun)
  if (registeredRoutes.length) ctx.llm.registerAdapter(registeredRoutes, adapter)
  const lifecycle = new AbortController()
  const refresh = () => {
    if (!config.codex.enabled) return Promise.resolve()
    preflightRun = preflightRun.catch(() => {}).then(() => runPreflight(config, diagnostics, lifecycle.signal, () => {
      try { ctx.emit('llm/adapters-updated') } catch {}
    }, authBroker))
    return preflightRun
  }
  if (config.codex.enabled && config.codex.preflight) void refresh()
  if (config.codex.enabled && config.codex.imageRetentionDays > 0) {
    // Fire and forget: startup sweep of content-addressed input images.
    void sweepStaleImages(imageStagingRoot(config.codex), config.codex.imageRetentionDays, ctx.logger)
  }
  const account = new AccountService(config.codex, config.allowedWorkspaces[0], {
    refresh, onDiagnostic: (code, detail) => { void diagnostics.record(code, detail) },
    authBroker,
  })
  let unregister
  let mountTimer
  if (config.codex.enabled && config.settingsUi) {
    // webServer registers after plugins without hard injects; poll briefly.
    let tries = 0
    const mount = () => {
      const web = ctx.get('webServer')
      if (web) {
        unregister = web.register({ kind: 'prefix', path: API_PREFIX, handler: createHandler({ diagnostics, account, refresh }) })
        return
      }
      if (++tries > 60) {
        ctx.logger?.warn?.('oh-my-codex: webServer not ready after 60s; settings API not mounted')
        return
      }
      mountTimer = setTimeout(mount, 1000)
      mountTimer.unref?.()
    }
    mount()
  }
  ctx.effect(() => async () => {
    clearTimeout(mountTimer)
    if (typeof unregister === 'function') unregister()
    lifecycle.abort()
    await account.dispose()
    await preflightRun.catch(() => {})
    await diagnostics.persist()
  }, 'oh-my-codex: preflight and settings')
  ctx.on('agent/request', async ({ agent }, next) => {
    const selected = await next()
    try {
      const previous = agent.session.requestHeader()?.config.provider
      assertEngineSwitch(previous, selected.provider, externalRoutes)
      const state = await router.store.read(agent.session.id)
      // A fork without a binding is allowed through: the adapter validates its
      // provenance against the parent binding and fails closed.
      if (routes[previous] && !state && !agent.session.header?.parentSession) {
        throw new EngineError('ENGINE_STATE', 'no binding')
      }
      if (state && routes[selected.provider] !== state.engine) {
        throw new EngineError('ENGINE_SWITCH', 'other engine')
      }
    } catch (error) {
      const failure = engineFailure(error)
      throw new LlmError(failure.message, failure.code)
    }
    return selected
  }, { prepend: true })
  ctx.effect(() => () => router.dispose(), 'oh-my-codex: active turns')
  const sessionCommands = createSessionCommands({ ctx, config, router, diagnostics, engines })
  adapter.sessionCommands = sessionCommands
  // Resumed sessions register their commands immediately; fresh sessions do so
  // after the first successful turn (see stream()).
  ctx.on('agent/created', async ({ agent }) => {
    try {
      const binding = await router.store.read(agent.session.id)
      if (binding && ['codex', 'codex-gateway'].includes(binding.engine)) sessionCommands.ensure(agent)
    } catch {}
  })
  const offSessionEvents = ctx.on('session/event', (session, event) => {
    try { adapter.onSessionEvent(session, event) } catch (error) {
      ctx.logger?.warn?.(`oh-my-codex: steer observer: ${error?.message ?? String(error)}`)
    }
  })
  ctx.effect(() => () => offSessionEvents(), 'oh-my-codex: steer observer')
}

export function apply(ctx, input) {
  const config = configuration(input)
  if (config.codex.auth.mode === 'dsh-subscription') {
    return ctx.inject(['credentials'], injected => applyRuntime(injected, input, config, injected.credentials))
  }
  return applyRuntime(ctx, input, config)
}

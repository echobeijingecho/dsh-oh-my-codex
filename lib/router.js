import { checkAbort, EngineError } from './errors.js'
import { rollbackDelivered, ThreadStore, workspacePath } from './state.js'
import { imageStagingRoot, stageImage } from './images.js'
import { offloadedImageText } from '@deepseek-ai/dsh-llm'

export const MANAGED_ROUTES = {
  'dsh-codex': 'codex',
  'dsh-codex-gateway': 'codex-gateway',
}
// Optional community providers can be installed beside this package. They
// are listed only to prevent unsafe cross-engine session switching.
export const COMMUNITY_ROUTES = { 'claude-code': 'community-claude' }
export const ROUTES = { ...MANAGED_ROUTES, ...COMMUNITY_ROUTES }
export const LABELS = {
  codex: 'Codex',
  'codex-gateway': 'Codex · Gateway',
  'claude-code': 'Claude Code',
}

export function assertEngineSwitch(previous, selected, routes = ROUTES) {
  if (previous && (routes[previous] || routes[selected]) && previous !== selected) {
    throw new EngineError('ENGINE_SWITCH')
  }
}

export class EngineRouter {
  constructor(config, engines, routes = MANAGED_ROUTES) {
    this.config = config
    this.engines = engines
    this.routes = routes
    this.store = new ThreadStore(config.stateDir, config.ownerId)
    this.active = new Set()
    // sessionId -> SteerPort of the run currently holding the store lock.
    this.steering = new Map()
    this.onDiagnostic = () => {}
  }

  /**
   * Deliver a mid-turn user message into the running Codex turn. Serialised
   * per port: inbox events are fire-and-forget, so concurrent splices must
   * not interleave their delivered-bookkeeping writes.
   */
  async steer(sessionId, { messageId, text, clientUserMessageId }) {
    // A steer can land in the gap between turn/start dispatch and the run
    // loop's onSteer registration; wait briefly before declaring the turn
    // inactive, so a just-started turn still accepts the message.
    const deadline = Date.now() + 1000
    let port = this.steering.get(sessionId)
    while ((!port || port.closed) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
      port = this.steering.get(sessionId)
    }
    if (!port || port.closed) return { status: 'no-active-turn' }
    if (Buffer.byteLength(text) > this.config.maxInputBytes) return { status: 'rejected' }
    port.chain = port.chain.then(async () => {
      if (port.closed) return { status: 'no-active-turn' }
      const status = await port.admit({ text, clientUserMessageId })
      if (status === 'steered' && messageId && port.markDelivered) {
        try { await port.markDelivered(messageId) } catch (error) {
          this.onDiagnostic('ENGINE_STEER_FAILED', { stage: 'delivered', message: String(error?.message ?? error) })
          return { status: 'failed' }
        }
      }
      return { status }
    })
    return port.chain
  }

  // A live pid inside its expiry window means the detached app-server may still
  // be finishing the turn; a fresh reader cannot see that (cross-process
  // inProgress reads as interrupted), so refuse instead of misjudging.
  static stillRunning(pending) {
    if (!pending?.pid || !Number.isFinite(pending.expiresAt)) return false
    if (Date.now() >= pending.expiresAt) return false
    try { process.kill(pending.pid, 0) } catch (error) {
      if (error.code === 'EPERM') return true
      return false
    }
    return true
  }

  // Bindings written before pending existed: the batch is whatever the engine
  // never answered — the user messages after the last assistant reply.
  static deriveLegacyPending(state, request) {
    const ids = []
    for (let i = request.messages.length - 1; i >= 0; i -= 1) {
      const message = request.messages[i]
      if (message.role === 'assistant') break
      if (message.role === 'user' && message.id) ids.unshift(message.id)
    }
    if (!ids.length) return undefined
    return {
      messageIds: ids, threadId: state.threadId, lastTurnId: state.lastTurnId ?? null,
      dispatchedAt: 0, pid: null, expiresAt: 0, legacy: true,
    }
  }

  async *reconcileAndYield(runner, state, request, cwd, signal) {
    const pending = state.pending ?? EngineRouter.deriveLegacyPending(state, request)
    if (!pending) throw new EngineError('ENGINE_RECOVERY')
    if (EngineRouter.stillRunning(pending)) {
      throw new EngineError('ENGINE_BUSY', '疑似上轮仍在执行')
    }
    let verdict
    try {
      verdict = await runner.reconcile(pending, { cwd, signal })
    } catch (error) {
      if (error instanceof EngineError) throw error
      // Read-side trouble is not a decision; keep the uncertainty.
      throw new EngineError('ENGINE_RECOVERY')
    }
    this.onDiagnostic('ENGINE_RECONCILED', { verdict: verdict.verdict })
    if (verdict.verdict === 'inconclusive') throw new EngineError('ENGINE_RECOVERY')
    let recovered = ''
    if (verdict.verdict === 'completed') {
      const answer = verdict.answerText?.trim()
        || '（该轮已完成，但没有文本回复；产物与改动见原生线程和工作区）'
      recovered = `【恢复】上次中断期间，Codex 其实已经完成了你上一条消息的执行，当时的回复如下：\n\n${answer}\n\n――以上为恢复内容，以下是本轮新消息的处理。――\n\n`
      state = { ...state, status: 'ready', pending: undefined }
    } else if (verdict.verdict === 'failed') {
      recovered = '【恢复】核对原生线程：上一条消息的 Codex 执行已失败，不会自动重发；如需重试请重新发送它。\n\n'
      state = { ...state, status: 'ready', pending: undefined }
    } else if (verdict.verdict === 'interrupted') {
      recovered = '【恢复】核对原生线程：上一条消息的 Codex 执行已中断，未产出完整回答；已执行的部分改动仍有效。该消息不会自动重发，你可以直接继续，或重新发送原消息让它重新执行。\n\n'
      state = { ...state, status: 'ready', pending: undefined }
    } else {
      recovered = '【恢复】核对原生线程：上一条消息从未到达 Codex（未执行），本次请求将自动把它重新发送。\n\n'
      state = { ...state, status: 'ready', pending: undefined, delivered: rollbackDelivered(state) }
    }
    await this.store.write(state)
    if (recovered) yield { type: 'text', text: recovered }
    return state
  }

  async dispose() {
    for (const entry of this.active) entry.controller.abort()
    await Promise.all([...this.active].map(entry => entry.done))
  }

  /**
   * Engine command path (/review, /compact): the store lock still serialises
   * against turns, but a command never touches binding state — its turn's
   * outcome lives in the Codex rollout itself.
   */
  async *command(request) {
    checkAbort(request.signal)
    const runner = this.engines[request.engine]
    if (!runner) throw new EngineError('ENGINE_DISABLED')
    const cwd = await workspacePath(request.cwd, this.config.allowedWorkspaces)
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      request.signal ?? new AbortController().signal,
      AbortSignal.timeout(this.config.turnTimeoutMs),
    ])
    let settle
    const entry = { controller, done: new Promise(resolve => { settle = resolve }) }
    this.active.add(entry)
    let release
    try {
      release = await this.store.acquire(request.sessionId, () => controller.abort())
      checkAbort(signal)
      const state = await this.store.read(request.sessionId)
      if (!state || state.engine !== request.engine || !state.threadId) {
        throw new EngineError('ENGINE_STATE', 'no binding')
      }
      if (state.status !== 'ready') throw new EngineError('ENGINE_RECOVERY')
      let bytes = 0
      const operation = request.kind === 'review' ? runner.review?.(request) : runner.compact?.(request)
      if (!operation) throw new EngineError('ENGINE_DISABLED')
      for await (const event of operation) {
        checkAbort(signal)
        bytes += Buffer.byteLength(JSON.stringify(event))
        if (bytes > this.config.maxOutputBytes) throw new EngineError('ENGINE_OUTPUT')
        yield event
      }
    } finally {
      controller.abort()
      try { await release?.() } finally {
        this.active.delete(entry)
        settle()
      }
    }
  }

  async *run(request) {
    checkAbort(request.signal)
    const engine = this.routes[request.provider]
    const runner = this.engines[engine]
    if (!runner) throw new EngineError('ENGINE_DISABLED')
    const cwd = await workspacePath(request.cwd, this.config.allowedWorkspaces)
    const controller = new AbortController()
    const signal = AbortSignal.any([
      controller.signal,
      request.signal ?? new AbortController().signal,
      AbortSignal.timeout(this.config.turnTimeoutMs),
    ])
    let settle
    const entry = { controller, done: new Promise(resolve => { settle = resolve }) }
    this.active.add(entry)
    let release
    let state
    let dispatched = false
    let engineDispatched = false
    let previousDelivered
    let completed = false
    try {
      release = await this.store.acquire(request.sessionId, () => controller.abort())
      checkAbort(signal)
      state = await this.store.read(request.sessionId)
      if (state && (state.engine !== engine || state.cwd !== cwd)) {
        throw new EngineError('ENGINE_SWITCH', 'engine or workspace changed')
      }
      if (state && state.status !== 'ready') {
        if (!runner.reconcile) throw new EngineError('ENGINE_RECOVERY')
        const settled = yield* this.reconcileAndYield(runner, state, request, cwd, signal)
        state = settled
      }
      if (state && request.fork) {
        throw new EngineError('ENGINE_STATE', 'already bound')
      }
      // A forked DSH session inherits the user messages already present in the
      // forked Codex thread; only messages after the fork point are new input.
      const delivered = new Set(state?.delivered ?? request.fork?.inherited ?? [])
      // DSH surface compaction rewrites history with checkpoint summaries;
      // the Codex thread governs its own context, so these never reach it.
      const undelivered = request.messages.filter(message => message.role === 'user'
        && !delivered.has(message.id) && message.source?.kind !== 'compact-checkpoint')
      // Reconciliation may have rolled the pending batch back for a resend; if
      // the user also re-sent the identical text manually, keep only the newer
      // copy so the prompt is not duplicated.
      const textOf = message => message.content.map(block => block.text ?? '').join('\n')
      const messages = undelivered.filter((message, index) => {
        const text = textOf(message)
        return !text || !undelivered.slice(index + 1).some(later => textOf(later) === text)
      })
      if (messages.length === 0 || messages.some(message => !message.id)) {
        throw new EngineError('ENGINE_INPUT', 'no new user message')
      }
      // Assemble text and images separately: offloaded images become recovery
      // text, live images stage to disk now — BEFORE the running/pending commit,
      // so a staging failure stays a retryable, pre-dispatch error.
      const imageRefs = []
      const prompt = messages.map(message => message.content.map(block => {
        if (block.type === 'text') return block.text
        if (block.type === 'image' && block.offloaded) {
          const host = request.dsh?.ctx?.get?.('attachments')?.imageHostPath?.(block.attachment)
          return offloadedImageText(block.attachment, host ? { readonlyPath: host } : undefined)
        }
        if (block.type === 'image') {
          if (request.imageCapable === false) throw new EngineError('ENGINE_ATTACHMENT')
          imageRefs.push(block.attachment)
          return null
        }
        throw new EngineError('ENGINE_ATTACHMENT')
      }).filter(block => block !== null).join('\n')).join('\n\n')
      const maxImages = this.config.codex?.maxImagesPerTurn ?? 20
      if (imageRefs.length > maxImages) throw new EngineError('ENGINE_IMAGE_COUNT', `${maxImages}`)
      if (!prompt.trim() && imageRefs.length === 0) throw new EngineError('ENGINE_INPUT', 'empty message')
      if (Buffer.byteLength(prompt) > this.config.maxInputBytes) {
        throw new EngineError('ENGINE_INPUT', 'size limit')
      }
      const images = []
      if (imageRefs.length) {
        const attachments = request.dsh?.ctx?.get?.('attachments')
        const root = imageStagingRoot(this.config.codex)
        const maxBytes = this.config.codex?.imageMaxBytes ?? 26214400
        const stagedById = new Map()
        for (const ref of imageRefs) {
          const id = String(ref?.attachmentId ?? '')
          if (stagedById.has(id)) { images.push(stagedById.get(id)); continue }
          const staged = await stageImage(attachments, ref, { signal, root, maxBytes })
          stagedById.set(id, staged)
          images.push(staged)
        }
      }
      const finalPrompt = images.length
        ? `# 用户提供的图片:\n${images.map((image, index) => `## 图${index + 1} ${image.label}: ${image.path}`).join('\n')}\n\n## 我的请求:\n${prompt}`
        : prompt
      state ??= {
        version: 1, owner: this.config.ownerId, sessionId: request.sessionId,
        engine, cwd, model: request.model, threadId: null, delivered: [], status: 'ready',
        ...(request.fork ? { forkedFrom: { threadId: request.fork.threadId, turnId: request.fork.turnId } } : {}),
      }
      previousDelivered = [...delivered]
      // The pending batch records what a reconciliation would have to answer
      // for if this dispatch ends without a terminal event.
      const pending = {
        messageIds: messages.map(message => message.id), threadId: state.threadId,
        lastTurnId: state.lastTurnId ?? null, dispatchedAt: Date.now(), pid: null,
        expiresAt: Date.now() + this.config.turnTimeoutMs + 60000,
      }
      state = { ...state, model: request.model, status: 'running', delivered: [...delivered, ...undelivered.map(m => m.id)], pending }
      // Commit intent before sending anything to an engine. A crash is not permission to retry.
      await this.store.write(state)
      dispatched = true
      let bytes = 0
      const lastMode = state.collaborationMode ?? request.fork?.collaborationMode
      for await (const event of runner.run({
        ...request, cwd, signal, prompt: finalPrompt, ...(images.length ? { images } : {}), threadId: state.threadId,
        collaboration: {
          desired: request.collaboration ?? 'default',
          lastSent: lastMode,
          onSent: async mode => {
            state = { ...state, ...(mode ? { collaborationMode: mode } : {}) }
            await this.store.write(state).catch(() => {})
          },
        },
        fork: state.threadId ? undefined : request.fork,
        onDispatch: () => { engineDispatched = true },
        onSteer: port => {
          // The delivered set is the authority for "never resend this"; a
          // steered message is marked before the DSH inbox cleanup happens.
          port.markDelivered = async id => {
            if (state.status !== 'running' || state.delivered.includes(id)) return
            state = { ...state, delivered: [...state.delivered, id] }
            await this.store.write(state)
          }
          this.steering.set(request.sessionId, port)
        },
        onProcessLaunched: pid => {
          if (state.status === 'running' && state.pending) {
            state = { ...state, pending: { ...state.pending, pid } }
            void this.store.write(state).catch(() => {})
          }
        },
        approve: details => request.approve({ ...details, signal: details.signal ? AbortSignal.any([signal, details.signal]) : signal }),
        ask: request.ask && ((questions, requestSignal) => request.ask({ questions, signal: requestSignal ? AbortSignal.any([signal, requestSignal]) : signal })),
        clientMessageId: messages.at(-1)?.id,
        callTool: request.callTool && (call => request.callTool({ ...call, signal })),
        bindThread: async threadId => {
          if (!threadId || (state.threadId && state.threadId !== threadId)
              || threadId === request.fork?.threadId) {
            throw new EngineError('ENGINE_THREAD', 'identifier changed')
          }
          state = { ...state, threadId }
          await this.store.write(state)
        },
      })) {
        checkAbort(signal)
        if (event.type === 'turn') {
          state = { ...state, lastTurnId: event.turnId }
        } else {
          bytes += Buffer.byteLength(JSON.stringify(event))
          if (bytes > this.config.maxOutputBytes) {
            throw new EngineError('ENGINE_OUTPUT')
          }
        }
        yield event
      }
      checkAbort(signal)
      if (!state.threadId) throw new EngineError('ENGINE_THREAD', 'no identifier')
      state = { ...state, status: 'ready', pending: undefined }
      await this.store.write(state)
      completed = true
    } finally {
      controller.abort()
      try {
        if (dispatched && !completed) {
          if (runner.reportsDispatch && !engineDispatched) {
            // The engine never received the prompt (start-up, sign-in or
            // thread setup failed): nothing ran, so the same message may be
            // retried. A thread bound during setup is kept for resume.
            state = { ...state, status: 'ready', delivered: previousDelivered, pending: undefined }
          } else {
            // A deliberate stop can resume the same thread with a NEW prompt. All
            // other failures retain uncertainty — and the pending batch, which is
            // exactly what the next request's reconciliation will answer for.
            const deliberate = request.signal?.aborted && state.threadId
            state = { ...state, status: deliberate ? 'ready' : 'uncertain', ...(deliberate ? { pending: undefined } : {}) }
          }
          await this.store.write(state)
        }
      } finally {
        try { await release?.() } finally {
          // The engine closes its own port in its finally; this is the
          // idempotent backstop so a late steer can never reach a dead turn.
          this.steering.get(request.sessionId)?.close?.()
          this.steering.delete(request.sessionId)
          this.active.delete(entry)
          settle()
        }
      }
    }
  }
}

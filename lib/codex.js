import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { EventQueue } from './queue.js'
import { checkAbort, EngineError } from './errors.js'
import { safeArguments } from './external-tools.js'
import { redact } from './diagnostics.js'
import { toCodexAnswers, toDshQuestions } from './questions.js'
import { prepareGatewayConfig } from './gateway-home.js'
import { CLIENT_INFO, THREAD_SOURCE } from './identity.js'

const TOOL_ITEM_TYPES = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'])
const SUBAGENT_ITEM_TYPES = new Set(['collabAgentToolCall', 'subAgentActivity'])
const STDERR_LINES = 20
const INTERRUPT_GRACE_MS = 3000
const SHUTDOWN_GRACE_MS = 3000
const ACCOUNT_READ_ATTEMPTS = 3
const UNSUPPORTED = { code: -32601, message: 'This client does not support this request.' }
// Never let Codex persist a full environment snapshot (including secrets from
// the wrapper's env file) under CODEX_HOME/shell_snapshots.
export const SAFETY_ARGS = ['-c', 'features.shell_snapshot=false']

// Built-in Codex surfaces that bypass DSH governance or make no sense behind
// it: ChatGPT-connected apps/plugins (auto-approved for the account), browser
// and computer use, in-app UI features, dependency auto-install, sub-agents
// and goals (DSH owns both). Names are checked by the contract test.
export const DEFAULT_DISABLED_FEATURES = [
  'apps', 'plugins', 'plugin_sharing', 'remote_plugin', 'tool_suggest',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'in_app_browser', 'in_app_chat', 'in_app_dictation', 'in_app_local_automation', 'in_app_updates',
  'realtime_conversation', 'skill_mcp_dependency_install', 'multi_agent', 'worktrees',
  'image_generation', 'goals',
]

export function launchArgs(config) {
  if (config.disableShellSnapshot === false && config.hardening === false) return []
  const args = config.disableShellSnapshot === false ? [] : [...SAFETY_ARGS]
  if (config.hardening !== false) {
    args.push('-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false')
    const disabled = new Set(config.disableFeatures ?? DEFAULT_DISABLED_FEATURES)
    if (config.multiAgent?.enabled === true) disabled.delete('multi_agent')
    for (const feature of disabled) args.push('-c', `features.${feature}=false`)
    if (config.multiAgent?.enabled === true) args.push('-c', 'features.multi_agent=true')
  }
  return args
}

// Legacy event mirrors and notifications this client never consumes; opting
// out keeps the bounded event queue for the v2 stream.
const OPT_OUT_NOTIFICATIONS = [
  'thread/environment/connected', 'thread/environment/disconnected', 'externalAgentConfig/import/progress',
  'windows/worldWritableWarning', 'turn/moderationMetadata', 'authStatusChange', 'thread/closed', 'rawResponse/completed',
  ...['task_started', 'agent_reasoning', 'agent_message', 'task_complete', 'mcp_tool_call_begin', 'mcp_tool_call_end',
    'exec_command_begin', 'exec_command_end', 'exec_command_output_delta', 'exec_approval_request',
    'apply_patch_approval_request', 'background_event', 'turn_diff', 'get_history_entry_response',
    'agent_reasoning_delta', 'agent_reasoning_section_break', 'agent_message_delta', 'stream_error', 'error',
    'turn_aborted', 'plan_delta', 'plan_update', 'patch_apply_begin', 'patch_apply_end', 'item_started',
    'item_completed', 'user_message', 'agent_reasoning_raw_content', 'agent_reasoning_raw_content_delta',
    'web_search_begin', 'web_search_end', 'mcp_list_tools_response', 'list_skills_response',
    'agent_message_content_delta', 'reasoning_content_delta', 'reasoning_raw_content_delta', 'warning',
    'shutdown_complete', 'mcp_startup_update', 'mcp_startup_complete', 'thread_name_updated',
    'elicitation_request', 'dynamic_tool_call_request', 'request_user_input', 'terminal_interaction',
    'token_count', 'deprecation_notice', 'raw_response_item', 'view_image_tool_call'].map(name => `codex/event/${name}`),
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function protocolFailure(message) {
  return new EngineError('ENGINE_PROTOCOL', message)
}

function toolName(item, resolveTool) {
  if (item.type === 'mcpToolCall') {
    if (typeof item.server === 'string' && typeof item.tool === 'string') {
      return `mcp__${item.server}__${item.tool}`
    }
    return 'codex:mcpToolCall'
  }
  if (item.type === 'dynamicToolCall') {
    return resolveTool?.(item.tool) ?? `dsh:${item.tool}`
  }
  return `codex:${item.type}`
}

function toolArguments(item) {
  if (item.type === 'commandExecution') {
    const actions = Array.isArray(item.commandActions)
      ? item.commandActions.map(action => action?.type).filter(Boolean) : []
    return safeArguments({ command: item.command, cwd: item.cwd, ...(actions.length ? { actions } : {}) })
  }
  if (item.type === 'fileChange') return safeArguments({ changes: item.changes })
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return safeArguments(item.arguments)
  return '{}'
}

function itemsText(items) {
  if (!Array.isArray(items)) return undefined
  return items.map(item => item?.type === 'inputText' ? item.text : `[${item?.type ?? 'item'}]`).join('\n')
}

// App Server v2 items are camelCase (`aggregatedOutput`); the snake_case
// fallback only covers older servers.
export function toolOutput(item) {
  if (item.type === 'commandExecution') {
    const output = item.aggregatedOutput ?? item.aggregated_output ?? ''
    const exit = Number.isInteger(item.exitCode) && item.exitCode !== 0 ? `\n[exit ${item.exitCode}]` : ''
    return `${output}${exit}`
  }
  if (item.type === 'dynamicToolCall') return itemsText(item.contentItems) ?? ''
  if (item.type === 'fileChange') return changesText(item.changes)
  return item.aggregatedOutput ?? item.output ?? item.result ?? item.error ?? ''
}

const CHANGE_TEXT_LIMIT = 16 * 1024
const CHANGE_VERB = { add: '新增', delete: '删除', update: '修改' }

// fileChange items carry no output; their per-file diffs are the result.
export function changesText(changes, limit = CHANGE_TEXT_LIMIT) {
  if (!Array.isArray(changes) || !changes.length) return ''
  const text = changes.map(change => {
    const kind = change?.kind?.type ?? 'update'
    const moved = change?.kind?.move_path ? ` → ${change.kind.move_path}` : ''
    return `${CHANGE_VERB[kind] ?? kind} ${change?.path ?? '?'}${moved}\n${change?.diff ?? ''}`.trimEnd()
  }).join('\n\n')
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text
}

function toolFailed(item) {
  return ['failed', 'error', 'cancelled', 'declined'].includes(item.status)
    || Boolean(item.error) || item.success === false
}

function subagentEvent(item) {
  if (!SUBAGENT_ITEM_TYPES.has(item?.type)) return undefined
  if (item.type === 'subAgentActivity') {
    return {
      type: 'subagent', id: item.id, kind: item.kind,
      agentPath: typeof item.agentPath === 'string' ? item.agentPath.slice(0, 200) : undefined,
      agentThreadId: typeof item.agentThreadId === 'string' ? item.agentThreadId : undefined,
    }
  }
  const states = isRecord(item.agentsStates) ? Object.fromEntries(
    Object.entries(item.agentsStates).slice(0, 8).map(([id, state]) => [id, {
      status: typeof state?.status === 'string' ? state.status : 'unknown',
      message: typeof state?.message === 'string' ? state.message.slice(0, 200) : undefined,
    }]),
  ) : undefined
  return {
    type: 'subagent', id: item.id, kind: item.tool,
    status: item.status,
    agentPath: typeof item.agentPath === 'string' ? item.agentPath.slice(0, 200) : undefined,
    model: typeof item.model === 'string' ? item.model : undefined,
    prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 500) : undefined,
    senderThreadId: typeof item.senderThreadId === 'string' ? item.senderThreadId : undefined,
    receiverThreadIds: Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(id => typeof id === 'string').slice(0, 8) : [],
    agentsStates: states,
  }
}

function validateResponse(method, result) {
  if (!isRecord(result)) throw protocolFailure(`Codex returned an invalid ${method} response.`)
  if (method === 'account/read' && result.account !== undefined
      && !isRecord(result.account) && result.account !== null) {
    throw protocolFailure('Codex returned an invalid account response.')
  }
  if (['thread/start', 'thread/resume', 'thread/fork'].includes(method)
      && (!isRecord(result.thread) || typeof result.thread.id !== 'string' || !result.thread.id)) {
    throw protocolFailure('Codex returned no valid thread identifier.')
  }
  if (method === 'turn/start'
      && (!isRecord(result.turn) || typeof result.turn.id !== 'string' || !result.turn.id)) {
    throw protocolFailure('Codex returned no valid turn identifier.')
  }
  if (method === 'turn/steer' && typeof result.turnId !== 'string') {
    throw protocolFailure('Codex returned no valid steer response.')
  }
  if (method === 'review/start'
      && (!isRecord(result.turn) || typeof result.turn.id !== 'string' || !result.turn.id
          || typeof result.reviewThreadId !== 'string' || !result.reviewThreadId)) {
    throw protocolFailure('Codex returned no valid review response.')
  }
  return result
}

// Bilingual, human-readable approval copy; displayReason is presentation-only
// and never lands in the persisted approval audit (reason stays JSON for that).
function approvalDisplay(kind, p, changes) {
  const reason = String(p?.reason ?? '').slice(0, 400)
  const lines = []
  if (kind === 'command') {
    lines.push(['Codex wants to run a command', 'Codex 请求执行命令'])
    if (p?.command) lines.push([`Command: ${p.command}`, `命令：${p.command}`])
    if (p?.cwd) lines.push([`Directory: ${p.cwd}`, `目录：${p.cwd}`])
  } else if (kind === 'file-change') {
    lines.push(['Codex wants to modify files', 'Codex 请求修改文件'])
    if (changes) lines.push([`Changes:\n${changes}`, `变更：\n${changes}`])
    if (p?.grantRoot) lines.push([`Grant root: ${p.grantRoot}`, `授权根目录：${p.grantRoot}`])
  } else {
    lines.push(['Codex requests elevated permissions', 'Codex 请求提升权限'])
    const perms = Array.isArray(p?.permissions) ? p.permissions.join(', ') : String(p?.permissions ?? '')
    if (perms) lines.push([`Permissions: ${perms}`, `权限：${perms}`])
    if (p?.cwd) lines.push([`Directory: ${p.cwd}`, `目录：${p.cwd}`])
  }
  if (reason) lines.push([`Reason: ${reason}`, `理由：${reason}`])
  return {
    en: lines.map(l => l[0]).join('\n'),
    zh: lines.map(l => l[1]).join('\n'),
  }
}

function grantedPermissions(requested) {
  const granted = {}
  if (isRecord(requested?.network)) granted.network = requested.network
  if (isRecord(requested?.fileSystem)) granted.fileSystem = requested.fileSystem
  return granted
}

export class AppServer {
  pending = new Map()
  sequence = 0
  closed = false
  events = new EventQueue()
  stderr = []
  items = new Map()
  inflight = new Map()

  constructor(config, cwd, signal, handlers = {}) {
    this.signal = signal
    this.handlers = handlers
    this.timeoutMs = config.rpcTimeoutMs
    this.child = spawn(config.command, [...config.args, ...launchArgs(config), 'app-server', '--listen', 'stdio://'], {
      cwd, env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    this.exited = new Promise(resolve => {
      this.child.once('close', resolve)
      this.child.once('error', resolve)
    })
    this.child.once('error', () => this.fail(new EngineError('ENGINE_START')))
    this.child.once('close', () => this.fail(new EngineError('ENGINE_EXIT')))
    this.child.stdin.on('error', () => this.fail(new EngineError('ENGINE_PIPE')))
    // stderr is never forwarded to the user. A redacted, bounded tail is kept
    // only for operator diagnostics when a turn fails.
    const errorDecoder = new StringDecoder('utf8')
    let errorBuffer = ''
    this.child.stderr.on('data', chunk => {
      errorBuffer = (errorBuffer + errorDecoder.write(chunk)).slice(-16384)
      const lines = errorBuffer.split('\n')
      errorBuffer = lines.pop()
      for (const line of lines) if (line.trim()) this.stderr.push(redact(line).slice(0, 500))
      if (this.stderr.length > STDERR_LINES) this.stderr.splice(0, this.stderr.length - STDERR_LINES)
    })
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    this.child.stdout.on('data', chunk => {
      buffer += decoder.write(chunk)
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        this.fail(new EngineError('ENGINE_PROTOCOL', 'oversized frame'))
        return
      }
      let boundary
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 1)
        if (!line.trim()) continue
        let message
        try { message = JSON.parse(line) } catch {
          this.fail(new EngineError('ENGINE_PROTOCOL', 'invalid frame'))
          return
        }
        this.receive(message)
      }
    })
    this.onAbort = () => this.fail(new DOMException('Execution stopped.', 'AbortError'))
    signal.addEventListener('abort', this.onAbort, { once: true })
    if (signal.aborted) this.onAbort()
  }

  send(message) {
    if (this.closed || this.child.stdin.destroyed) throw new EngineError('ENGINE_PIPE')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new EngineError('ENGINE_PIPE'))
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new EngineError('ENGINE_TIMEOUT', method))
      }, this.timeoutMs)
      this.pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      try { this.send({ id, method, params }) } catch (error) {
        this.pending.get(id).reject(error)
        this.pending.delete(id)
      }
    })
  }

  receive(message) {
    if (!isRecord(message)) {
      this.fail(protocolFailure('Codex sent a non-object protocol frame.'))
      return
    }
    if (message.method && message.id !== undefined) {
      void this.answer(message)
    } else if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (!pending && !message.method) {
        this.fail(protocolFailure('Codex sent a response for an unknown request.'))
        return
      }
      this.pending.delete(message.id)
      if (!pending) return
      if (message.error) {
        const text = isRecord(message.error) && typeof message.error.message === 'string'
          ? message.error.message : 'Codex returned an invalid protocol error.'
        const error = new Error(text)
        if (isRecord(message.error.data)) error.data = message.error.data
        pending.reject(error)
      } else if (Object.hasOwn(message, 'result')) {
        try {
          const result = validateResponse(pending.method, message.result)
          // Record the turn synchronously: a server request in the same stdout
          // chunk must already be checked against this turn.
          if (pending.method === 'turn/start') this.turnId = result.turn.id
          pending.resolve(result)
        } catch (error) { pending.reject(error) }
      } else {
        pending.reject(protocolFailure(`Codex returned neither result nor error for ${pending.method}.`))
      }
    } else if (typeof message.method === 'string') {
      // Approvals reference items by id only; keep the latest item snapshot so
      // the DSH approval shows what will change.
      // Codex withdrew a request (turn ended, auto-review decided): close the
      // matching DSH dialog instead of leaving it waiting for a click.
      if (message.method === 'serverRequest/resolved') this.inflight.get(message.params?.requestId)?.abort()
      if ((message.method === 'item/started' || message.method === 'item/completed') && message.params?.item?.id) {
        this.items.set(message.params.item.id, message.params.item)
        if (this.items.size > 200) this.items.delete(this.items.keys().next().value)
      }
      this.events.push(message)
    } else {
      this.fail(protocolFailure('Codex sent a protocol frame without a method or request id.'))
    }
  }

  // A server request is answered only for the thread and turn this process
  // owns. Ownership is checked before asking the human and again before
  // replying, so a late decision can never reach a different turn.
  owns(params) {
    if (!this.threadId || params?.threadId !== this.threadId) return false
    return !params.turnId || !this.turnId || params.turnId === this.turnId
  }

  replyError(id, error) {
    if (!this.closed) this.send({ id, error })
  }

  diagnostic(code, detail) {
    this.handlers.onDiagnostic?.(code, detail)
  }

  async answer(message) {
    const { id, method, params } = message
    const withdrawn = new AbortController()
    this.inflight.set(id, withdrawn)
    this.requestSignal = withdrawn.signal
    try {
      await this.dispatch(id, method, params, withdrawn.signal)
    } catch (error) {
      if (withdrawn.signal.aborted) return
      // A failed bridge declines this one request instead of breaking the turn.
      this.diagnostic('ENGINE_BRIDGE_FAILED', { method, message: error?.message })
      try { this.replyError(id, { code: -32000, message: 'The DSH bridge could not complete this request.' }) } catch {}
    } finally {
      this.inflight.delete(id)
    }
  }

  async approve(name, reason, display, signal) {
    if (!this.handlers.approve) return false
    return this.handlers.approve({ name, reason: JSON.stringify(reason), display, signal })
  }

  reply(id, result) {
    // A withdrawn request is already resolved server-side.
    if (!this.closed && this.inflight.get(id)?.signal.aborted !== true) this.send({ id, result })
  }

  async dispatch(id, method, p, signal) {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const owned = this.owns(p)
      const item = p?.itemId ? this.items.get(p.itemId) : undefined
      const changes = method.includes('fileChange') ? changesText(item?.changes, 4000) : ''
      const kind = method.includes('commandExecution') ? 'command' : 'file-change'
      const granted = owned && await this.approve(
        `codex:${kind}`,
        {
          command: p.command, cwd: p.cwd, reason: p.reason, grantRoot: p.grantRoot,
          ...(changes ? { changes } : {}),
        },
        approvalDisplay(kind, { ...p, grantRoot: p.grantRoot }, changes),
        signal,
      )
      const decision = this.signal.aborted ? 'cancel' : granted && this.owns(p) ? 'accept' : 'decline'
      this.reply(id, { decision })
    } else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      const owned = Boolean(this.threadId) && p?.conversationId === this.threadId
      const kind = method === 'execCommandApproval' ? 'command' : 'file-change'
      const granted = owned && await this.approve(
        `codex:${kind}`,
        { command: p.command, cwd: p.cwd, reason: p.reason, grantRoot: p.grantRoot },
        approvalDisplay(kind, p),
        signal,
      )
      const decision = this.signal.aborted ? 'abort' : granted ? 'approved' : { denied: { rejection: 'Declined in DSH.' } }
      this.reply(id, { decision })
    } else if (method === 'item/permissions/requestApproval') {
      const granted = this.owns(p) && await this.approve('codex:permissions', {
        cwd: p.cwd, reason: p.reason, permissions: p.permissions,
      }, approvalDisplay('permissions', p), signal)
      this.reply(id, { permissions: granted && this.owns(p) && !this.signal.aborted ? grantedPermissions(p.permissions) : {}, scope: 'turn' })
    } else if (method === 'item/tool/requestUserInput') {
      const questions = this.owns(p) ? toDshQuestions(p) : []
      if (!questions.length || !this.handlers.ask) {
        this.diagnostic('ENGINE_QUESTION_UNANSWERED', { method, message: questions.length ? 'no question service' : 'no relayable question' })
        this.reply(id, { answers: {} })
        return
      }
      let answer
      try {
        answer = await this.handlers.ask(questions, signal)
      } catch (error) {
        this.diagnostic('ENGINE_QUESTION_UNANSWERED', { method, message: error?.code ?? error?.message })
        this.reply(id, { answers: {} })
        return
      }
      this.reply(id, this.owns(p) ? toCodexAnswers(answer) : { answers: {} })
    } else if (method === 'item/tool/call') {
      if (!this.owns(p) || !this.handlers.callTool) {
        this.reply(id, { contentItems: [{ type: 'inputText', text: 'This tool is not available in this turn.' }], success: false })
        return
      }
      const result = await this.handlers.callTool(p)
      this.reply(id, this.owns(p) ? result : { contentItems: [{ type: 'inputText', text: 'Turn changed before the tool finished.' }], success: false })
    } else if (method === 'mcpServer/elicitation/request') {
      // MCP form/url elicitation has no safe DSH surface yet; decline explicitly.
      this.diagnostic('ENGINE_ELICITATION_DECLINED', { method, server: p?.serverName })
      this.reply(id, { action: 'decline', content: null, _meta: null })
    } else {
      // Token refresh, attestation and unknown capabilities never receive a
      // grant. Declining them must not break an otherwise healthy turn.
      this.diagnostic('ENGINE_UNSUPPORTED_REQUEST', { method })
      this.replyError(id, UNSUPPORTED)
    }
  }

  fail(error) {
    this.events.fail(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.signal.removeEventListener('abort', this.onAbort)
    this.fail(new EngineError('ENGINE_CLOSED'))
    const kill = signal => {
      if (!this.child.pid) return
      if (process.platform === 'win32') {
        try { this.child.kill(signal) } catch (error) {
          if (!['ESRCH', 'EPERM'].includes(error.code)) throw error
        }
        return
      }
      try {
        process.kill(-this.child.pid, signal)
      } catch (error) {
        if (error.code === 'ESRCH') return
        if (error.code !== 'EPERM') throw error
        // A macOS/Linux process-group race can reject the group signal after
        // the leader is already reparented. Kill the owned leader as fallback.
        try { this.child.kill(signal) } catch (fallback) {
          if (!['ESRCH', 'EPERM'].includes(fallback.code)) throw fallback
        }
      }
    }
    // stdin EOF is App Server's graceful shutdown: it flushes the rollout and
    // stops MCP servers itself. Signals are the fallback, never the first step.
    try { this.child.stdin.end() } catch {}
    const exitedGracefully = await Promise.race([
      this.exited.then(() => true),
      new Promise(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS, false).unref?.()),
    ])
    if (!exitedGracefully) kill('SIGTERM')
    const timer = setTimeout(() => kill('SIGKILL'), 2000)
    try { await this.exited } finally {
      clearTimeout(timer)
      // The server may exit before a command that ignores SIGTERM.
      try { kill('SIGKILL') } catch {}
    }
  }
}

/**
 * DSH permission -> Codex sandbox. `native` uses Codex's own Linux sandbox
 * (bubblewrap). `external` is for containers whose seccomp profile forbids
 * user namespaces: the container is the isolation boundary, Codex gets full
 * disk access inside it, network stays restricted, and approvals tighten for
 * read-only sessions instead.
 */
export function executionPolicy(config, permission, cwd) {
  const ask = permission.approval === 'ask'
  if (config.sandboxMode === 'external') {
    return {
      sandbox: 'danger-full-access',
      sandboxPolicy: { type: 'externalSandbox', networkAccess: 'restricted' },
      approvalPolicy: permission.sandbox === 'read-only' ? 'untrusted' : ask ? 'on-request' : 'never',
    }
  }
  return {
    sandbox: permission.sandbox,
    sandboxPolicy: permission.sandbox === 'read-only'
      ? { type: 'readOnly', networkAccess: false }
      : { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    approvalPolicy: ask ? 'on-request' : 'never',
  }
}

// Codex error key -> engine code + detail; the user-facing copy comes from errors.js.
const ERROR_CODES = {
  usageLimitExceeded: ['ENGINE_QUOTA', 'usageLimitExceeded'],
  sessionBudgetExceeded: ['ENGINE_QUOTA', 'sessionBudgetExceeded'],
  rateLimitExceeded: ['ENGINE_QUOTA', 'rateLimitExceeded'],
  contextWindowExceeded: ['ENGINE_CONTEXT', 'compact-hint'],
  unauthorized: ['ENGINE_AUTH', 'unauthorized'],
  sandboxError: ['ENGINE_SANDBOX', 'sandboxError'],
  cyberPolicy: ['ENGINE_POLICY', 'cyberPolicy'],
  misalignmentPolicyViolation: ['ENGINE_POLICY', 'misalignmentPolicyViolation'],
  serverOverloaded: ['ENGINE_UPSTREAM', 'serverOverloaded'],
  internalServerError: ['ENGINE_UPSTREAM', 'internalServerError'],
  httpConnectionFailed: ['ENGINE_UPSTREAM', 'httpConnectionFailed'],
  responseStreamConnectionFailed: ['ENGINE_UPSTREAM', 'responseStreamConnectionFailed'],
  responseStreamDisconnected: ['ENGINE_UPSTREAM', 'responseStreamDisconnected'],
  responseTooManyFailedAttempts: ['ENGINE_UPSTREAM', 'responseTooManyFailedAttempts'],
}

// Structured codexErrorInfo, not message text, decides the user-facing code.
export function turnFailure(error, status = 'failed') {
  const info = error?.codexErrorInfo
  const key = typeof info === 'string' ? info : isRecord(info) ? Object.keys(info)[0] : undefined
  const mapped = key && ERROR_CODES[key]
  if (mapped) return new EngineError(mapped[0], mapped[1])
  return new Error(error?.message || `Codex turn ${status}`)
}

function subtractUsage(total, base) {
  const keys = ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens']
  const out = {}
  for (const key of keys) out[key] = Math.max(0, (Number(total?.[key]) || 0) - (Number(base?.[key]) || 0))
  return out
}

async function interruptTurn(rpc, threadId, turnId) {
  try {
    await Promise.race([
      rpc.request('turn/interrupt', { threadId, turnId }),
      new Promise(resolve => setTimeout(resolve, INTERRUPT_GRACE_MS).unref?.()),
    ])
  } catch {}
}

async function handshake(rpc, experimentalApi) {
  const init = await rpc.request('initialize', {
    clientInfo: CLIENT_INFO,
    capabilities: { experimentalApi, requestAttestation: false, optOutNotificationMethods: OPT_OUT_NOTIFICATIONS },
  })
  rpc.send({ method: 'initialized' })
  // account/read performs workspace-routing discovery over the network. Nothing
  // has run yet, so a transient failure is retried before giving up.
  let account
  for (let attempt = 1; ; attempt += 1) {
    try {
      account = await rpc.request('account/read', { refreshToken: false })
      break
    } catch (error) {
      if (error instanceof EngineError || attempt >= ACCOUNT_READ_ATTEMPTS) throw accountReadFailure(error)
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt).unref?.())
    }
  }
  return { init, account }
}

function accountReadFailure(error) {
  if (error instanceof EngineError) return error
  return new EngineError('ENGINE_UPSTREAM', 'account/read')
}

const TURNS_PAGE_LIMIT = 10
const NOT_SUPPORTED = /not supported|unknown method|unrecognized|no such method/i

async function createAppServer(config, cwd, signal, handlers) {
  return new AppServer(await prepareGatewayConfig(config), cwd, signal, handlers)
}

function turnClientId(turn) {
  const userMessage = (turn.items ?? []).find(item => item?.type === 'userMessage')
  return userMessage ? userMessage.clientId ?? null : null
}

function turnAnswer(turn, limit) {
  const text = (turn.items ?? [])
    .filter(item => item?.type === 'agentMessage' && typeof item.text === 'string')
    .map(item => item.text)
    .join('\n')
  return text.length > limit ? `${text.slice(0, limit)}\n…（恢复内容已截断）` : text
}

function verdictOf(turn, answerLimit) {
  if (turn.status === 'completed') {
    return { verdict: 'completed', turnId: turn.id, answerText: turnAnswer(turn, answerLimit) }
  }
  if (turn.status === 'failed') {
    return { verdict: 'failed', turnId: turn.id, error: turn.error ?? null }
  }
  // inProgress is never observable cross-process: the server normalizes it to
  // interrupted for a thread this process did not load.
  return { verdict: 'interrupted', turnId: turn.id }
}

/**
 * Reconcile a pending (uncertain) batch against the durable Codex thread with
 * a throwaway read-only App Server process. Never starts, resumes or forks a
 * thread and never triggers a turn. Uses the experimental paged
 * `thread/turns/list` (clientId match) and falls back to the deprecated
 * `thread/read {includeTurns}` when the list method is unavailable.
 */
export async function reconcileThread(config, cwd, pending, {
  signal = AbortSignal.timeout(Math.max(config.rpcTimeoutMs * 6, 20000)),
  maxPages = 20,
  answerLimit = 16384,
} = {}) {
  if (!pending?.threadId) return { verdict: 'missing' }
  const rpc = await createAppServer(config, cwd, signal)
  try {
    await handshake(rpc, true)
    const listTurns = async () => {
      const turns = []
      let cursor
      for (let page = 0; page < maxPages; page += 1) {
        const result = await rpc.request('thread/turns/list', {
          threadId: pending.threadId, limit: TURNS_PAGE_LIMIT, itemsView: 'summary',
          sortDirection: 'desc', ...(cursor ? { cursor } : {}),
        })
        turns.push(...(result.data ?? []))
        cursor = result.nextCursor
        if (!cursor || (pending.lastTurnId && result.data?.some(turn => turn.id === pending.lastTurnId))) break
      }
      return turns
    }
    let turns
    try {
      turns = await listTurns()
    } catch (error) {
      if (!NOT_SUPPORTED.test(String(error?.message ?? error))) throw error
      const read = await rpc.request('thread/read', { threadId: pending.threadId, includeTurns: true })
      turns = [...(read.thread?.turns ?? [])].reverse()
    }
    const newer = []
    for (const turn of turns) {
      if (pending.lastTurnId && turn.id === pending.lastTurnId) break
      newer.unshift(turn)
    }
    const ids = new Set(pending.messageIds)
    const hit = newer.find(turn => ids.has(turnClientId(turn)))
    if (hit) return verdictOf(hit, answerLimit)
    if (pending.legacy) {
      // Bindings written before clientUserMessageId existed: match by position.
      // Exactly one turn newer than the anchor is attributable; more is not.
      if (newer.length === 1) return { ...verdictOf(newer[0], answerLimit), legacy: true }
      if (newer.length === 0) return { verdict: 'missing' }
      return { verdict: 'inconclusive' }
    }
    return { verdict: 'missing' }
  } finally {
    await rpc.close()
  }
}

/**
 * Build the turn/start collaborationMode param. Sent only when a plan mode is
 * (or was last) active: an absent field keeps today's behaviour, while a null
 * developer_instructions would make the server backfill its own plan prompt
 * over DSH's governance text.
 */
export function collaborationParam(desired, lastSent, request) {
  // plan is requested, or plan was the last mode and default must switch back
  // explicitly; any other combination keeps today's field-less behaviour.
  const mode = desired === 'plan' ? 'plan' : desired === 'default' && lastSent === 'plan' ? 'default' : undefined
  if (!mode) return undefined
  return {
    mode,
    settings: {
      model: request.model,
      reasoning_effort: request.reasoningEffort ?? null,
      developer_instructions: request.instructions || null,
    },
  }
}

/**
 * Launch a throwaway App Server and report what this instance can actually do:
 * runtime identity, sign-in state and the account's model list. Never starts a
 * thread or a turn.
 */
export async function preflight(config, cwd, { signal = AbortSignal.timeout(Math.max(config.rpcTimeoutMs * 3, 10000)) } = {}) {
  const rpc = await createAppServer(config, cwd, signal)
  try {
    const { init, account } = await handshake(rpc, false)
    const signedIn = !(account.requiresOpenaiAuth && !account.account)
    let models
    let modelError
    const catalog = []
    try {
      const listed = []
      let cursor
      for (let page = 0; page < 5; page += 1) {
        const result = await rpc.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) })
        for (const model of result.data ?? []) {
          if (typeof model?.id !== 'string') continue
          listed.push(model.id)
          if (typeof model.model === 'string' && model.model !== model.id) listed.push(model.model)
          catalog.push({
            id: model.id,
            displayName: typeof model.displayName === 'string' ? model.displayName : model.id,
            description: typeof model.description === 'string' ? model.description.slice(0, 300) : '',
            hidden: model.hidden === true,
            isDefault: model.isDefault === true,
            efforts: Array.isArray(model.supportedReasoningEfforts)
              ? model.supportedReasoningEfforts
                .filter(option => typeof option?.reasoningEffort === 'string')
                .map(option => ({ id: option.reasoningEffort, description: String(option.description ?? '').slice(0, 200) }))
              : [],
            defaultEffort: typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : null,
            // Codex omits the field for classic text+image models (devdocs compat rule).
            inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities.filter(m => typeof m === 'string') : ['text', 'image'],
            multiAgentVersion: ['disabled', 'v1', 'v2'].includes(model.multiAgentVersion) ? model.multiAgentVersion : 'disabled',
          })
        }
        cursor = result.nextCursor
        if (!cursor) break
      }
      models = [...new Set(listed)]
    } catch (error) {
      modelError = redact(error?.message)
    }
    let rateLimits
    if (signedIn && account.account?.type === 'chatgpt') {
      try {
        const limits = await rpc.request('account/rateLimits/read')
        const window = value => value && Number.isFinite(value.usedPercent)
          ? { usedPercent: value.usedPercent, windowDurationMins: value.windowDurationMins ?? null, resetsAt: value.resetsAt ?? null }
          : null
        rateLimits = { primary: window(limits.rateLimits?.primary), secondary: window(limits.rateLimits?.secondary) }
      } catch {}
    }
    // Startup warnings (e.g. bubblewrap unusable) arrive as notifications.
    const warnings = rpc.events.items
      .map(item => item.value)
      .filter(message => message?.method === 'configWarning')
      .map(message => redact([message.params?.summary, message.params?.details].filter(Boolean).join(': ')).slice(0, 300))
    return {
      userAgent: typeof init.userAgent === 'string' ? init.userAgent.slice(0, 200) : null,
      warnings,
      account: account.account?.type ?? null,
      email: typeof account.account?.email === 'string' ? account.account.email : null,
      planType: typeof account.account?.planType === 'string' ? account.account.planType : null,
      signedIn,
      models,
      catalog: models ? catalog : undefined,
      modelError,
      rateLimits,
    }
  } catch (error) {
    error.stderr = rpc.stderr.slice()
    throw error
  } finally {
    await rpc.close()
  }
}

/**
 * Feeds mid-turn user messages into the running Codex turn via `turn/steer`.
 * Admissions before turn/start completes are buffered and flushed in order.
 * Feedback rides the existing event queue as steer/note pseudo-frames, so it
 * inherits the same ordering, byte budget and termination as protocol events.
 */
export class SteerPort {
  pending = []
  closed = false
  turnId = undefined
  markDelivered = null
  chain = Promise.resolve()

  constructor(rpc) { this.rpc = rpc }

  open(threadId, turnId) {
    this.threadId = threadId
    this.turnId = turnId
    const pending = this.pending
    this.pending = []
    for (const item of pending) void this.admit(item)
  }

  async admit({ text, clientUserMessageId }) {
    if (this.closed) return 'closed'
    if (this.turnId === undefined) {
      this.pending.push({ text, clientUserMessageId })
      return 'buffered'
    }
    try {
      await this.rpc.request('turn/steer', {
        threadId: this.threadId, expectedTurnId: this.turnId,
        input: [{ type: 'text', text, text_elements: [] }],
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      })
      this.rpc.events.push({ method: 'steer/note', params: { kind: 'steered', text } })
      return 'steered'
    } catch (error) {
      // Any failure falls soft: the message stays in the DSH inbox and is
      // claimed as the next step when this turn ends (= queue semantics).
      this.rpc.events.push({ method: 'steer/note', params: { kind: 'steer-failed', message: String(error?.message ?? error).slice(0, 300) } })
      return 'failed'
    }
  }

  close() {
    this.closed = true
    this.pending = []
  }
}

/**
 * Shared short-lived-session setup for engine commands: handshake, sign-in
 * check, the session's exact execution policy, and a resume of the bound
 * thread. Mirrors run()'s setup so approvals behave identically.
 */
async function openThreadSession(config, rpc, request) {
  const { account } = await handshake(rpc, true)
  if (account.requiresOpenaiAuth && !account.account) {
    throw new EngineError('ENGINE_AUTH')
  }
  const execution = executionPolicy(config, request.permission, request.cwd)
  const policy = {
    model: request.model, cwd: request.cwd, sandbox: execution.sandbox,
    approvalPolicy: execution.approvalPolicy,
    developerInstructions: request.instructions || undefined,
  }
  const result = await rpc.request('thread/resume', { ...policy, threadId: request.threadId, excludeTurns: true })
  if (result.thread.id !== request.threadId) throw new EngineError('ENGINE_THREAD', 'resume')
  rpc.threadId = request.threadId
  return { execution, policy }
}

export class CodexEngine {
  // Calls request.onDispatch() immediately before turn/start.
  reportsDispatch = true

  constructor(config) { this.config = config }

  /** Native Codex code review on the session's thread (delivery inline). */
  async *review(request) {
    checkAbort(request.signal)
    const rpc = await createAppServer(this.config, request.cwd, request.signal, {
      approve: request.approve, ask: request.ask, onDiagnostic: request.onDiagnostic,
    })
    try {
      await openThreadSession(this.config, rpc, request)
      const started = await rpc.request('review/start', {
        threadId: request.threadId, target: request.target, delivery: 'inline',
      })
      const turnId = started.turn.id
      rpc.turnId = turnId
      yield { type: 'review-started', turnId }
      let reviewText
      let terminalError
      for await (const { method, params: p } of rpc.events) {
        checkAbort(request.signal)
        if (p?.threadId !== request.threadId) continue
        if (p.turnId && p.turnId !== turnId) continue
        if (method === 'item/started') {
          if (p.item?.type === 'enteredReviewMode') yield { type: 'note', text: `审查开始：${p.item.review ?? ''}` }
          else if (TOOL_ITEM_TYPES.has(p.item?.type)) yield {
            type: 'tool-start', id: p.item.id, kind: p.item.type,
            name: toolName(p.item, request.tools?.resolve), arguments: toolArguments(p.item),
            ...(p.item.type === 'commandExecution' ? { command: p.item.command } : {}),
          }
        } else if (method === 'item/completed') {
          if (p.item?.type === 'exitedReviewMode') reviewText = p.item.review
          else if (TOOL_ITEM_TYPES.has(p.item?.type)) yield {
            type: 'tool-end', id: p.item.id, output: toolOutput(p.item), isError: toolFailed(p.item),
          }
        } else if (method === 'error') {
          if (!p.willRetry) terminalError = p.error
        } else if (method === 'turn/completed' && p.turn?.id === turnId) {
          if (p.turn.status !== 'completed') throw turnFailure(p.turn.error ?? terminalError, p.turn.status)
          yield { type: 'review', text: reviewText ?? 'Reviewer failed to output a response.' }
          return
        }
      }
      if (terminalError) throw turnFailure(terminalError, 'failed')
      throw new EngineError('ENGINE_EXIT', 'review incomplete')
    } catch (error) {
      if (isRecord(error) && rpc.stderr.length) error.stderr = rpc.stderr.slice()
      if (request.signal.aborted && rpc.threadId && rpc.turnId) await interruptTurn(rpc, rpc.threadId, rpc.turnId)
      throw error
    } finally {
      await rpc.close()
    }
  }

  /** Native Codex thread compaction; the response is {}, progress rides events. */
  async *compact(request) {
    checkAbort(request.signal)
    const rpc = await createAppServer(this.config, request.cwd, request.signal, {
      approve: request.approve, onDiagnostic: request.onDiagnostic,
    })
    try {
      await openThreadSession(this.config, rpc, request)
      let before
      let after
      let turnId
      // Consume the resumed replay first: the first tokenUsage after resume
      // is the pre-compaction context size.
      let compacting = false
      let terminalError
      await rpc.request('thread/compact/start', { threadId: request.threadId })
      for await (const { method, params: p } of rpc.events) {
        checkAbort(request.signal)
        if (p?.threadId !== request.threadId) continue
        if (method === 'turn/started') {
          turnId = p.turn?.id ?? turnId
          if (turnId) rpc.turnId = turnId
          continue
        }
        if (p.turnId && turnId && p.turnId !== turnId) continue
        if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
          before ??= p.tokenUsage.total.totalTokens
          after = p.tokenUsage.total.totalTokens
        } else if (method === 'item/started' && p.item?.type === 'contextCompaction') {
          compacting = true
          yield { type: 'compacting' }
        } else if (method === 'error') {
          if (!p.willRetry) terminalError = p.error
        } else if (method === 'turn/completed') {
          if (p.turn.status !== 'completed') throw turnFailure(p.turn.error ?? terminalError, p.turn.status)
          if (!compacting) throw new EngineError('ENGINE_PROTOCOL', 'no compaction item')
          yield { type: 'compacted', before: before ?? null, after: after ?? null }
          return
        }
      }
      if (terminalError) throw turnFailure(terminalError, 'failed')
      throw new EngineError('ENGINE_EXIT', 'compaction incomplete')
    } catch (error) {
      if (isRecord(error) && rpc.stderr.length) error.stderr = rpc.stderr.slice()
      if (request.signal.aborted && rpc.threadId && rpc.turnId) await interruptTurn(rpc, rpc.threadId, rpc.turnId)
      throw error
    } finally {
      await rpc.close()
    }
  }

  /** Read-only account probe for /status: sign-in + rate limits, no turn. */
  async statusProbe({ cwd } = {}) {
    const signal = AbortSignal.timeout(Math.max(this.config.rpcTimeoutMs * 3, 10000))
    const rpc = await createAppServer(this.config, cwd ?? process.cwd(), signal)
    try {
      const { account } = await handshake(rpc, false)
      const probe = { ok: true }
      if (account.account?.email) probe.email = account.account.email
      if (account.account?.planType) probe.planType = account.account.planType
      try {
        const limits = await rpc.request('account/rateLimits/read')
        const window = value => value && Number.isFinite(value.usedPercent)
          ? { usedPercent: value.usedPercent, resetsAt: value.resetsAt ?? null } : null
        probe.rateLimits = { primary: window(limits.rateLimits?.primary), secondary: window(limits.rateLimits?.secondary) }
      } catch {}
      return probe
    } catch {
      return { ok: false }
    } finally {
      await rpc.close()
    }
  }

  reconcile(pending, { cwd, signal } = {}) {
    const options = this.config.reconcile ?? {}
    return reconcileThread(this.config, cwd, pending, {
      signal,
      maxPages: options.maxPages,
      answerLimit: options.answerLimit,
    })
  }

  async *run(request) {
    checkAbort(request.signal)
    const rpc = await createAppServer(this.config, request.cwd, request.signal, {
      approve: request.approve,
      ask: request.ask,
      callTool: request.callTool,
      onDiagnostic: request.onDiagnostic,
    })
    request.onProcessLaunched?.(rpc.child.pid)
    let threadId = request.threadId
    let turnId
    const steer = new SteerPort(rpc)
    request.onSteer?.(steer)
    try {
      const { account } = await handshake(rpc, true)
      if (account.requiresOpenaiAuth && !account.account) {
        throw new EngineError('ENGINE_AUTH')
      }
      const execution = executionPolicy(this.config, request.permission, request.cwd)
      const policy = {
        model: request.model, cwd: request.cwd, sandbox: execution.sandbox,
        approvalPolicy: execution.approvalPolicy,
        developerInstructions: request.instructions || undefined,
      }
      let result
      let resumedMode
      if (threadId) {
        // History stays on disk; returning it can exceed the 8 MiB frame limit.
        result = await rpc.request('thread/resume', { ...policy, threadId, excludeTurns: true })
        if (result.thread.id !== threadId) {
          throw new EngineError('ENGINE_THREAD', 'resume')
        }
        resumedMode = result.collaborationMode?.mode
      } else if (request.fork) {
        // Fork through the exact turn recorded on the inherited DSH message.
        // A refused or ambiguous fork never falls back to a fresh thread.
        try {
          result = await rpc.request('thread/fork', {
            ...policy, threadId: request.fork.threadId, lastTurnId: request.fork.turnId, excludeTurns: true,
            threadSource: THREAD_SOURCE,
          })
        } catch (error) {
          if (error instanceof EngineError) throw error
          throw new EngineError('ENGINE_FORK', 'refused')
        }
        if (result.thread.id === request.fork.threadId) {
          throw new EngineError('ENGINE_FORK', 'same thread')
        }
      } else {
        result = await rpc.request('thread/start', {
          ...policy, ephemeral: false, serviceName: THREAD_SOURCE, threadSource: THREAD_SOURCE,
          ...(request.tools?.specs ? { dynamicTools: request.tools.specs } : {}),
        })
      }
      threadId = result.thread.id
      rpc.threadId = threadId
      await request.bindThread(threadId)
      checkAbort(request.signal)
      // From here on the engine may act on the prompt: a failure is uncertain.
      await request.onDispatch?.()
      // The effective last mode prefers what the thread itself reports; the
      // binding's recorded value is the fallback for forks (no mode on fork).
      const effectiveLast = resumedMode ?? request.collaboration?.lastSent
      const collaboration = request.collaboration
        ? collaborationParam(request.collaboration.desired, effectiveLast, request)
        : undefined
      await request.collaboration?.onSent?.(collaboration?.mode)
      const started = await rpc.request('turn/start', {
        threadId, model: request.model,
        ...(collaboration ? { collaborationMode: collaboration } : {}),
        ...(request.reasoningEffort ? { effort: request.reasoningEffort } : {}),
        ...(this.config.reasoningSummary && this.config.reasoningSummary !== 'default'
          ? { summary: this.config.reasoningSummary } : {}),
        // The prompt names each staged image; the bytes go as localImage
        // paths the Codex core snapshots (and re-encodes) itself. No detail
        // field: the default (high) adapts, 'original' needs a model flag.
        input: [
          { type: 'text', text: request.prompt, text_elements: [] },
          ...(request.images ?? []).map(image => ({ type: 'localImage', path: image.path })),
        ],
        ...(request.clientMessageId ? { clientUserMessageId: request.clientMessageId } : {}),
        sandboxPolicy: execution.sandboxPolicy,
        approvalPolicy: policy.approvalPolicy,
      })
      turnId = started.turn.id
      rpc.turnId = turnId
      steer.open(threadId, turnId)
      const streamed = new Set()
      const summarized = new Set()
      const reasoned = new Set()
      let usageBase
      let usageTotal
      let contextWindow
      let lastPlan
      let diff
      let retrying = false
      let terminalError
      let planDraftSeen = false
      for await (const { method, params: p } of rpc.events) {
        checkAbort(request.signal)
        if (method === 'configWarning' || method === 'deprecationNotice') {
          request.onDiagnostic?.('ENGINE_CONFIG_WARNING', { message: [p?.summary, p?.details].filter(Boolean).join(': ') })
          continue
        }
        if (method === 'steer/note') {
          yield { type: 'steer-note', kind: p.kind, ...(p.text !== undefined ? { text: p.text } : {}), ...(p.message !== undefined ? { message: p.message } : {}) }
          continue
        }
        if (p?.threadId !== threadId) continue
        if (p.turnId && p.turnId !== turnId) continue
        if (method === 'item/agentMessage/delta') {
          streamed.add(p.itemId)
          yield { type: 'text', text: p.delta }
        } else if (method === 'item/reasoning/summaryTextDelta') {
          summarized.add(p.itemId)
          reasoned.add(p.itemId)
          yield { type: 'reasoning', text: p.delta }
        } else if (method === 'item/reasoning/summaryPartAdded') {
          if (reasoned.has(p.itemId)) yield { type: 'reasoning', text: '\n\n' }
        } else if (method === 'item/reasoning/textDelta') {
          if (!summarized.has(p.itemId)) {
            reasoned.add(p.itemId)
            yield { type: 'reasoning', text: p.delta }
          }
        } else if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) {
          // `total` is cumulative for the thread; the turn's usage is the delta
          // from the total before this turn's first model response.
          const { total, last } = p.tokenUsage
          usageBase ??= subtractUsage(total, last)
          usageTotal = total
          if (Number.isFinite(p.tokenUsage.modelContextWindow)) contextWindow = p.tokenUsage.modelContextWindow
        } else if (method === 'turn/plan/updated' && Array.isArray(p.plan)) {
          // The checklist renders in DSH's native todo panel (index.js turns
          // this event into a todo/write); only the explanation mirrors into
          // reasoning, deduplicated.
          const plan = JSON.stringify(p.plan)
          if (plan && plan !== lastPlan) {
            lastPlan = plan
            if (p.explanation) yield { type: 'reasoning', text: `\n${p.explanation}\n` }
            yield { type: 'plan', plan: p.plan }
          }
        } else if (method === 'turn/diff/updated' && typeof p.diff === 'string') {
          diff = p.diff
        } else if (method === 'item/plan/delta') {
          if (typeof p.delta === 'string' && p.delta) {
            yield { type: 'reasoning', text: `${planDraftSeen ? '' : '\n（计划草稿）\n'}${p.delta}` }
            planDraftSeen = true
          }
        } else if (method === 'item/completed' && p.item?.type === 'plan') {
          yield { type: 'plan-item', id: p.item.id, text: typeof p.item.text === 'string' ? p.item.text : '' }
        } else if ((method === 'item/started' || method === 'item/completed') && SUBAGENT_ITEM_TYPES.has(p.item?.type)) {
          const event = subagentEvent(p.item)
          if (event) {
            const maxAgents = this.config.multiAgent?.maxAgents ?? 4
            if (Array.isArray(event.receiverThreadIds)) event.receiverThreadIds = event.receiverThreadIds.slice(0, maxAgents)
            if (isRecord(event.agentsStates)) event.agentsStates = Object.fromEntries(Object.entries(event.agentsStates).slice(0, maxAgents))
            yield event
          }
        } else if (method === 'item/commandExecution/outputDelta') {
          if (typeof p.delta === 'string' && p.delta) yield { type: 'tool-output', id: p.itemId, delta: p.delta }
        } else if (method === 'item/started' && TOOL_ITEM_TYPES.has(p.item?.type)) {
          yield {
            type: 'tool-start',
            id: p.item.id,
            kind: p.item.type,
            name: toolName(p.item, request.tools?.resolve),
            arguments: toolArguments(p.item),
            ...(p.item.type === 'commandExecution' ? { command: p.item.command } : {}),
          }
        } else if (method === 'item/completed' && TOOL_ITEM_TYPES.has(p.item?.type)) {
          yield {
            type: 'tool-end',
            id: p.item.id,
            output: toolOutput(p.item),
            isError: toolFailed(p.item),
          }
        } else if (method === 'item/completed' && p.item?.type === 'agentMessage') {
          if (!streamed.has(p.item.id) && p.item.text) yield { type: 'text', text: p.item.text }
          yield { type: 'text', text: '\n\n' }
        } else if (method === 'error') {
          if (p.willRetry) {
            // Transient: Codex reconnects by itself. Say so once, keep going.
            if (!retrying) yield { type: 'reasoning', text: '\n（与模型的连接中断，Codex 正在自动重试…）\n' }
            retrying = true
          } else {
            // The terminal error precedes turn/completed(failed); wait for it.
            terminalError = p.error
          }
        } else if (method === 'turn/completed' && p.turn?.id === turnId) {
          if (p.turn.status !== 'completed') throw turnFailure(p.turn.error ?? terminalError, p.turn.status)
          if (diff) yield { type: 'diff', id: `diff-${turnId}`, diff }
          if (usageTotal) yield { type: 'usage', usage: subtractUsage(usageTotal, usageBase), contextWindow }
          yield { type: 'turn', threadId, turnId }
          return
        }
      }
      if (terminalError) throw turnFailure(terminalError, 'failed')
      throw new EngineError('ENGINE_EXIT', 'turn incomplete')
    } catch (error) {
      if (isRecord(error) && rpc.stderr.length) error.stderr = rpc.stderr.slice()
      // A deliberate stop asks Codex to end the turn itself first, so the
      // thread records an interrupted turn instead of a killed process.
      if (request.signal.aborted && threadId && turnId) await interruptTurn(rpc, threadId, turnId)
      throw error
    } finally {
      // The process belongs to this turn only. Resume uses the persisted thread,
      // so disposal cannot orphan a second long-running agent.
      steer.close()
      await rpc.close()
    }
  }
}

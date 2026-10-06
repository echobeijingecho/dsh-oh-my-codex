import {
  createAssistantMessage,
  createToolResultMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'

function currentStep(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return undefined
  const events = session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.type === 'step/end') break
    if (event.type === 'step/start') {
      return { turn: event.data.turn, step: event.data.step }
    }
  }
  return undefined
}

function textContent(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(block => {
      if (block && typeof block === 'object' && typeof block.text === 'string') return block.text
      return JSON.stringify(block)
    }).join('\n')
  }
  if (value === undefined || value === null) return ''
  return JSON.stringify(value)
}

function safeArguments(value) {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? {}) } catch { return '{}' }
}

/**
 * External engines execute their own tools. Recording these as stream tool calls
 * would make dsh execute them a second time, so they are written directly to
 * the active session log as native tool cards.
 */
export function createExternalToolRecorder(agent, provider, model, onWarn = () => {}) {
  const session = agent?.session
  const position = currentStep(session)
  if (!session || !position || typeof session.append !== 'function') return undefined

  const pending = new Map()
  let broken = false

  const guard = (label, write) => {
    if (broken) return
    try {
      write()
    } catch (error) {
      broken = true
      pending.clear()
      onWarn(`oh-my-codex: failed to record external ${label}: ${error?.message ?? String(error)}`)
    }
  }

  return {
    start({ id, name, arguments: args }) {
      if (typeof id !== 'string' || !id || pending.has(id)) return
      const callId = ToolCallId(id)
      guard('tool/call', () => {
        const message = createAssistantMessage({
          content: [{ type: 'tool-call', id: callId, name, arguments: args }],
          source: { provider, model },
        })
        session.append('assistant/message', {
          turn: position.turn,
          step: position.step,
          message,
          stream: [],
        }, { surfaceOp: 'append' })
        const event = session.append('tool/call', {
          turn: position.turn,
          step: position.step,
          callId,
          name,
          arguments: args,
        })
        pending.set(id, { callId, callSeq: event.seq })
      })
    },

    finish({ id, output = '', isError = false }) {
      const call = pending.get(id)
      if (!call) return
      pending.delete(id)
      guard('tool/result', () => {
        const content = textContent(output)
        const message = createToolResultMessage({
          callId: call.callId,
          content: content ? [{ type: 'text', text: content }] : [],
          isError: isError === true,
        })
        session.append('tool/result', {
          turn: position.turn,
          step: position.step,
          message,
          ...(isError === true
            ? { error: { name: 'ExternalToolError', code: 'ENGINE_TOOL_FAILED' } }
            : {}),
        }, {
          surfaceOp: 'append',
          sourceEventSeqs: [call.callSeq],
        })
      })
    },

    finishPending(isError = true) {
      for (const id of [...pending.keys()]) {
        this.finish({ id, output: '', isError })
      }
    },
  }
}

export { safeArguments }

const TODO_STATUS = { completed: 'completed', inProgress: 'in_progress', pending: 'pending' }

function todoItems(plan) {
  if (!Array.isArray(plan)) return []
  return plan
    .filter(step => step && typeof step.step === 'string' && step.step)
    .map(step => ({ content: step.step.slice(0, 200), status: TODO_STATUS[step.status] ?? 'pending' }))
}

/** Write one combined DSH todo snapshot. Plan and native Codex sub-agent tasks
 * share the host panel, so an agent update never erases the user's plan. */
export function writeTodoSnapshot(agent, { plan = [], subagents = [] } = {}, onWarn = () => {}) {
  const session = agent?.session
  if (!session || typeof session.append !== 'function') return
  try {
    const todos = [...todoItems(plan), ...subagents
      .filter(item => item && typeof item.content === 'string' && item.content)
      .map(item => ({ content: item.content.slice(0, 240), status: item.status ?? 'pending' }))]
    if (todos.length) session.append('todo/write', { todos })
  } catch (error) {
    onWarn(`oh-my-codex: failed to write todo snapshot: ${error?.message ?? String(error)}`)
  }
}

/** Codex plan steps map one-to-one onto DSH todo items; the panel is whole-list
 *  replace-on-write, so partial updates just send the full snapshot. Must run
 *  inside an open turn (dsh's todo invariant) — true here, stream() is the turn. */
export function writePlanTodos(agent, plan, onWarn = () => {}) {
  writeTodoSnapshot(agent, { plan }, onWarn)
}

/** Convert a native sub-agent activity into a stable todo item. */
export function subagentTodo(event) {
  if (!event || typeof event !== 'object') return []
  const ids = event.agentThreadId ? [event.agentThreadId]
    : Array.isArray(event.receiverThreadIds) ? event.receiverThreadIds : []
  const failed = event.kind === 'failed' || event.status === 'failed' || event.status === 'errored'
  const status = event.kind === 'completed' || event.status === 'completed' ? 'completed'
    : event.kind === 'interrupted' || event.status === 'interrupted' || failed ? 'pending' : 'in_progress'
  const prompt = typeof event.prompt === 'string' ? event.prompt.split('\n')[0].trim() : ''
  const model = typeof event.model === 'string' ? event.model : ''
  const path = typeof event.agentPath === 'string' ? event.agentPath : ''
  return ids.filter(id => typeof id === 'string' && id).map(id => ({
    id,
    content: `${path ? `${path} ` : ''}Codex 子 Agent ${id}${model ? `（${model}）` : ''}${failed ? '（失败）' : event.kind === 'interrupted' || event.status === 'interrupted' ? '（已中断）' : ''}${prompt ? `：${prompt}` : ''}`,
    status,
  }))
}

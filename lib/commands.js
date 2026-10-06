import { EngineError, engineFailure } from './errors.js'

/** `/review` argument grammar → Codex ReviewTarget. */
export function parseReviewTarget(rawInput) {
  const text = String(rawInput ?? '').trim()
  if (!text) return { type: 'uncommittedChanges' }
  const base = /^base\s+(\S+)$/u.exec(text)
  if (base) return { type: 'baseBranch', branch: base[1] }
  const commit = /^commit\s+(\S+)$/u.exec(text)
  if (commit) return { type: 'commit', sha: commit[1], title: null }
  if (/^base\b|^commit\b/u.test(text)) return { usage: true }
  return { type: 'custom', instructions: text }
}

const number = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—')

export function formatCompactResult(before, after) {
  const saved = Number.isFinite(before) && Number.isFinite(after) && before > after
    ? `（约释放 ${Math.round(((before - after) / before) * 100)}%）` : ''
  return `Codex 线程已压缩：上下文 ${number(before)} → ${number(after)} tokens${saved}。\n后续对话将继续使用同一线程；DSH 侧历史保持不变。`
}

export function formatStatus({ snapshot, binding, probe }) {
  const lines = ['Codex 引擎状态']
  lines.push(`引擎: Codex（${probe?.ok ? '已连接' : snapshot?.codex?.signedIn ? '已连接（上次探测）' : '未检测'}）`)
  if (probe?.email || snapshot?.codex?.email) {
    const plan = probe?.planType ?? snapshot?.codex?.planType
    lines.push(`账号: ${probe?.email ?? snapshot?.codex?.email}${plan ? `（${probe?.ok ? 'ChatGPT ' + plan : plan}）` : ''}`)
  }
  const primary = probe?.rateLimits?.primary
  if (primary) lines.push(`额度: 主窗口已用 ${Math.round(primary.usedPercent)}%${primary.resetsAt ? `，${new Date(primary.resetsAt * 1000).toLocaleString('zh-CN')} 重置` : ''}`)
  if (probe && !probe.ok) lines.push('（实时额度读取失败：Codex 无法连接账号服务）')
  if (binding) {
    lines.push(`本会话: 已绑定 Codex 线程 ${String(binding.threadId).slice(0, 8)}（模型 ${binding.model}，状态 ${binding.status}）`)
    if (probe?.contextTokens) lines.push(`线程上下文: ${number(probe.contextTokens)}${probe.contextWindow ? ` / ${number(probe.contextWindow)} tokens（${Math.round((probe.contextTokens / probe.contextWindow) * 100)}%）` : ''}`)
    lines.push(`DSH 表面: 已投递 ${binding.delivered.length} 条用户消息`)
  }
  return lines.join('\n')
}

function errorResult(error) {
  const failure = engineFailure(error)
  return { kind: 'error', text: `${failure.message} [${failure.code}]` }
}

const busyText = '当前会话正在执行 Codex 任务，请等它结束再运行此命令。'
const CODEX_ENGINES = new Set(['codex', 'codex-gateway'])

/**
 * Session-scoped /status /review /compact registrations through the agent's
 * own context, so only Codex-bound sessions ever see them (/compact also
 * shadows the host's global surface compaction for those sessions).
 */
export function createSessionCommands({ router, diagnostics, engines, config }) {
  const ensured = new WeakSet()

  const runEngineCommand = async (invocation, kind, prepare) => {
    const agent = invocation.agent
    let binding
    try {
      binding = await router.store.read(agent.session.id)
    } catch {
      return { kind: 'error', text: '此会话未绑定 Codex 引擎，该命令仅对 Codex 会话可用。' }
    }
    if (!binding || !CODEX_ENGINES.has(binding.engine)) {
      return { kind: 'error', text: '此会话未绑定 Codex 引擎，该命令仅对 Codex 会话可用。' }
    }
    if (binding.status !== 'ready') {
      return { kind: 'error', text: '上一次引擎操作结果不确定，请先检查该会话（发送新消息可自动对账）再运行此命令。' }
    }
    let prepared
    try {
      prepared = prepare(invocation)
    } catch (error) {
      if (error instanceof EngineError && error.code === 'ENGINE_INPUT') {
        return { kind: 'error', text: '用法：/review [base <分支> | commit <提交> | <审查要求>]' }
      }
      return errorResult(error)
    }
    try {
      let result
      await agent.runMaintenance(async maintenanceSignal => {
        const events = []
        for await (const event of router.command({
          sessionId: agent.session.id, engine: binding.engine, kind,
          signal: AbortSignal.any([maintenanceSignal, invocation.signal].filter(Boolean)),
          cwd: binding.cwd, threadId: binding.threadId, model: binding.model,
          target: prepared, agent, permission: agentPermission(agent),
        })) events.push(event)
        result = events
      })
      if (invocation.signal?.aborted) {
        return { kind: 'error', text: kind === 'review' ? '审查已取消；Codex 线程已保留。' : '压缩已中断；Codex 会保留线程。再次运行 /compact 可重试。' }
      }
      if (kind === 'review') {
        const review = result.find(event => event.type === 'review')
        return { kind: 'success', text: review?.text ?? '审查完成，但 Codex 未返回文本。' }
      }
      const compacted = result.find(event => event.type === 'compacted')
      return { kind: 'success', text: formatCompactResult(compacted?.before, compacted?.after) }
    } catch (error) {
      const text = String(error?.message ?? error)
      if (/busy|maintenance/i.test(text)) return { kind: 'error', text: busyText }
      if (error?.code === 'ENGINE_BUSY') return { kind: 'error', text: '此会话已有进行中的引擎请求，请稍后重试。' }
      return errorResult(error)
    }
  }

  function agentPermission(agent) {
    const presets = agent?.ctx?.get?.('permissionPresets')
    try {
      return presets?.resolve?.() ?? { sandbox: 'read-only', approval: 'never' }
    } catch {
      return { sandbox: 'read-only', approval: 'never' }
    }
  }

  function ensure(agent) {
    if (!agent || ensured.has(agent)) return
    ensured.add(agent)
    const commands = agent.ctx?.get?.('commands')
    if (!commands || typeof commands.register !== 'function') {
      void diagnostics.record('ENGINE_COMMANDS_UNAVAILABLE', {})
      return
    }
    try {
      agent.ctx.inject(['commands'], commandCtx => {
        commandCtx.commands.register({
          name: 'status', description: '查看 Codex 引擎与会话状态',
          handler: async invocation => {
            try {
              const binding = await router.store.read(invocation.agent.session.id)
              if (!binding || !CODEX_ENGINES.has(binding.engine)) {
                return { kind: 'error', text: '此会话未绑定 Codex 引擎，/status 仅对 Codex 会话可用。' }
              }
              const probe = await engines[binding.engine]?.statusProbe?.(binding)
              return { kind: 'success', text: formatStatus({ snapshot: diagnostics.snapshot?.(), binding, probe }) }
            } catch (error) {
              return errorResult(error)
            }
          },
        })
        commandCtx.commands.register({
          name: 'review', description: '让 Codex 审查工作区改动',
          input: { hint: '[base <分支> | commit <提交> | <审查要求>]' },
          handler: invocation => runEngineCommand(invocation, 'review', () => {
            const target = parseReviewTarget(invocation.rawInput)
            if (target.usage) throw new EngineError('ENGINE_INPUT')
            return target
          }),
        })
        commandCtx.commands.register({
          name: 'compact', description: '压缩此会话的 Codex 线程上下文',
          handler: invocation => {
            if (String(invocation.rawInput ?? '').trim()) {
              return Promise.resolve({ kind: 'error', text: '用法：/compact（不带参数）' })
            }
            return runEngineCommand(invocation, 'compact', () => undefined)
          },
        })
      })
    } catch (error) {
      void diagnostics.record('ENGINE_COMMANDS_UNAVAILABLE', { message: String(error?.message ?? error).slice(0, 200) })
    }
  }

  return { ensure }
}

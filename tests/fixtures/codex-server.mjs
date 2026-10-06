import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const root = process.env.FIXTURE_STATE_DIR
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const save = (id, value) => writeFileSync(join(root, `${id}.json`), JSON.stringify(value))
const load = id => JSON.parse(readFileSync(join(root, `${id}.json`), 'utf8'))
const waiting = new Map()
const saveTurns = (id, value) => writeFileSync(join(root, `${id}.turns.json`), JSON.stringify(value))
const loadTurns = id => { try { return JSON.parse(readFileSync(join(root, `${id}.turns.json`), 'utf8')) } catch { return [] } }
const recordTurn = (id, turn) => saveTurns(id, [...loadTurns(id), turn])
const settleTurn = (id, turnId, fields) => saveTurns(id, loadTurns(id).map(t => t.turnId === turnId ? { ...t, ...fields } : t))
const turnItems = t => [
  { type: 'userMessage', id: `um-${t.turnId}`, clientId: t.clientId ?? null, content: [{ type: 'text', text: t.input }] },
  ...(t.status === 'completed' && t.text != null ? [{ type: 'agentMessage', id: `am-${t.turnId}`, text: t.text }] : []),
]
// Field names follow `codex app-server generate-ts` (v2, camelCase).
const ask = (method, params, then) => {
  const id = `${method}-${randomUUID()}`
  waiting.set(id, then)
  send({ id, method, params })
}

appendFileSync(join(root, 'argv.jsonl'), `${JSON.stringify(process.argv.slice(2))}\n`)
process.stderr.write('fixture stderr https://user:secret@proxy.example:7897 Bearer abcdefghijklmnop\n')

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params: p, result: answer, error } = JSON.parse(line)
  if (method) appendFileSync(join(root, 'calls.jsonl'), `${JSON.stringify({ method, params: p })}\n`)
  if (!method) {
    appendFileSync(join(root, 'replies.jsonl'), `${JSON.stringify({ id, result: answer, error })}\n`)
    waiting.get(id)?.(answer ?? { error })
    waiting.delete(id)
  } else if (method === 'initialize') {
    send({ id, result: { userAgent: 'fixture/1.0' } })
    if (process.env.FIXTURE_STARTUP_WARNING) send({ method: 'configWarning', params: { summary: 'bwrap unavailable', details: null } })
  }
  else if (method === 'account/read') {
    const failures = Number(process.env.FIXTURE_ACCOUNT_FAILURES || 0)
    if (failures) {
      const seen = (() => { try { return Number(readFileSync(join(root, 'account.failures'), 'utf8')) } catch { return 0 } })()
      if (seen < failures) {
        writeFileSync(join(root, 'account.failures'), String(seen + 1))
        send({ id, error: { code: -1, message: 'workspace routing discovery timed out' } })
        continue
      }
    }
    let auth = process.env.FIXTURE_UNAUTH ? 'out' : 'in'
    try { auth = readFileSync(join(root, 'auth.state'), 'utf8') } catch {}
    send({ id, result: { requiresOpenaiAuth: true, account: auth === 'in' ? { type: 'chatgpt', email: 'user@example.com', planType: 'pro' } : null } })
  } else if (method === 'account/rateLimits/read') {
    send({ id, result: { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1791000000 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1791500000 } } } })
  } else if (method === 'account/login/start') {
    if (p?.type === 'chatgptAuthTokens') {
      if (!p.accessToken || !p.chatgptAccountId) {
        send({ id, error: { code: -1, message: 'missing external auth tokens' } })
        continue
      }
      writeFileSync(join(root, 'auth.state'), 'in')
      send({ id, result: { type: 'chatgptAuthTokens' } })
      continue
    }
    if (p?.type !== 'chatgptDeviceCode') { send({ id, error: { code: -1, message: 'unsupported login' } }); continue }
    send({ id, result: { type: 'chatgptDeviceCode', loginId: 'login-1', verificationUrl: 'https://auth.example/device', userCode: 'ABCD-1234' } })
    if (!process.env.FIXTURE_LOGIN_HOLD) {
      setTimeout(() => {
        const ok = !process.env.FIXTURE_LOGIN_FAIL
        if (ok) writeFileSync(join(root, 'auth.state'), 'in')
        send({ method: 'account/login/completed', params: { loginId: 'login-1', success: ok, error: ok ? null : 'token exchange failed via https://u:p@proxy', onboardingEntrypoint: null } })
      }, 50)
    }
  } else if (method === 'account/login/cancel') {
    send({ id, result: {} })
  } else if (method === 'account/logout') {
    writeFileSync(join(root, 'auth.state'), 'out')
    send({ id, result: {} })
  } else if (method === 'model/list') {
    if (process.env.FIXTURE_MODEL_LIST_FAIL) send({ id, error: { code: -1, message: 'model list timed out via https://u:p@proxy' } })
    else {
      const delay = Number(process.env.FIXTURE_MODEL_LIST_DELAY_MS || 0)
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      const efforts = ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort, description: `${reasoningEffort} effort` }))
      send({ id, result: { nextCursor: null, data: [
        { id: 'fixture-model', model: 'fixture-model', displayName: 'Fixture', description: 'Fixture model', hidden: false, isDefault: true, supportedReasoningEfforts: efforts, defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], multiAgentVersion: 'v2' },
        { id: 'fixture-mini', model: 'fixture-mini', displayName: 'Fixture Mini', description: 'Small', hidden: false, isDefault: false, supportedReasoningEfforts: efforts.slice(0, 2), defaultReasoningEffort: 'low', inputModalities: ['text'] },
        { id: 'fixture-hidden', model: 'fixture-hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: 'low', inputModalities: ['text'] },
      ] } })
    }
  } else if (method === 'thread/start') {
    const threadId = randomUUID()
    save(threadId, [])
    send({
      id,
      result: process.env.FIXTURE_BAD_THREAD
        ? { thread: {} }
        : { thread: { id: threadId } },
    })
  } else if (method === 'thread/resume') {
    try {
      load(p.threadId)
    } catch { send({ id, error: { code: -1, message: 'thread missing' } }); continue }
    send({ id, result: {
      thread: { id: p.threadId },
      ...(process.env.FIXTURE_RESUME_PLAN ? { collaborationMode: { mode: 'plan' } } : {}),
    } })
    if (process.env.FIXTURE_RESUME_USAGE) {
      // Real servers replay the persisted thread totals right after resume.
      const cumulative = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 })
      send({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, tokenUsage: { total: cumulative(49500, 500), last: cumulative(49500, 500), modelContextWindow: 200000 } } })
    }
  } else if (method === 'review/start') {
    const turnId = randomUUID()
    send({ id, result: { turn: { id: turnId }, reviewThreadId: p.threadId } })
    send({ method: 'item/started', params: { threadId: p.threadId, turnId, item: { id: 'rev-enter', type: 'enteredReviewMode', review: 'uncommitted changes' } } })
    if (process.env.FIXTURE_REVIEW_FAIL) {
      settleTurn(p.threadId, turnId, { status: 'failed', error: { message: 'raw', codexErrorInfo: 'usageLimitExceeded' } })
      send({ method: 'error', params: { threadId: p.threadId, turnId, willRetry: false, error: { message: 'raw', codexErrorInfo: 'usageLimitExceeded' } } })
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'failed', error: { message: 'raw', codexErrorInfo: 'usageLimitExceeded' } } } })
      continue
    }
    const reviewText = '总体良好，建议做少量打磨。\n\nFull review comments:\n\n- Prefer Stylize helpers — /tmp/f.rs:10-20\n  Use .dim()/.bold() chaining instead of manual Style.'
    settleTurn(p.threadId, turnId, { status: 'completed', text: reviewText })
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId, item: { id: 'rev-exit', type: 'exitedReviewMode', review: reviewText } } })
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } } })
  } else if (method === 'thread/compact/start') {
    send({ id, result: {} })
    const turnId = randomUUID()
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: turnId } } })
    send({ method: 'item/started', params: { threadId: p.threadId, turnId, item: { id: 'cc', type: 'contextCompaction' } } })
    const compacted = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 0 })
    send({ method: 'thread/tokenUsage/updated', params: { threadId: p.threadId, turnId, tokenUsage: { total: compacted(4950, 50), last: compacted(4950, 50), modelContextWindow: 200000 } } })
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId, item: { id: 'cc', type: 'contextCompaction' } } })
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: turnId, status: 'completed' } } })
  } else if (method === 'thread/fork') {
    let history
    try { history = load(p.threadId) } catch {
      send({ id, error: { code: -1, message: 'thread missing' } })
      continue
    }
    if (process.env.FIXTURE_FORK_SAME) {
      send({ id, result: { thread: { id: p.threadId } } })
      continue
    }
    // Honour lastTurnId like the real server: keep turns through it, inclusive.
    const turns = loadTurns(p.threadId)
    const anchor = p.lastTurnId ? turns.findIndex(t => t.turnId === p.lastTurnId) + 1 : turns.length
    const keep = anchor
    if (p.lastTurnId && keep === 0) {
      send({ id, error: { code: -1, message: 'unknown lastTurnId' } })
      continue
    }
    const threadId = randomUUID()
    save(threadId, history.slice(0, keep))
    saveTurns(threadId, turns.slice(0, keep))
    send({ id, result: { thread: { id: threadId } } })
  } else if (method === 'thread/turns/list') {
    if (process.env.FIXTURE_TURNS_UNSUPPORTED) { send({ id, error: { code: -32601, message: 'list_turns is not supported yet' } }); continue }
    const all = loadTurns(p.threadId)
    const asc = p.sortDirection === 'asc' ? all : [...all].reverse()
    const offset = p.cursor ? Number(p.cursor) : 0
    const limit = Math.min(Number(p.limit ?? 10), 50)
    const page = asc.slice(offset, offset + limit)
    send({
      id,
      result: {
        data: page.map(t => ({ id: t.turnId, items: turnItems(t), itemsView: 'summary', status: t.status, ...(t.status === 'failed' && t.error ? { error: t.error } : {}), startedAt: 0, completedAt: 0, durationMs: 0 })),
        nextCursor: offset + limit < asc.length ? String(offset + limit) : undefined,
        backwardsCursor: offset > 0 ? String(Math.max(0, offset - limit)) : undefined,
      },
    })
  } else if (method === 'thread/read') {
    try {
      load(p.threadId)
    } catch { send({ id, error: { code: -1, message: 'thread missing' } }); continue }
    const turns = loadTurns(p.threadId).map(t => ({
      id: t.turnId, items: turnItems(t), itemsView: 'summary', status: t.status,
      ...(t.status === 'failed' && t.error ? { error: t.error } : {}),
    }))
    send({ id, result: { thread: { id: p.threadId, status: 'notLoaded', ...(p.includeTurns ? { turns } : {}) } } })
  } else if (method === 'turn/interrupt') {
    send({ id, result: {} })
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted' } } })
  } else if (method === 'turn/steer') {
    appendFileSync(join(root, 'steers.jsonl'), `${JSON.stringify(p)}\n`)
    if (process.env.FIXTURE_STEER_REJECT) {
      send({ id, error: { code: -1, message: 'no active turn to steer' } })
      // The real server still finishes its turn; the steered text arrives as
      // the next turn instead.
      const itemId = randomUUID()
      const text = 'turn finished without the steer'
      settleTurn(p.threadId, p.expectedTurnId, { status: 'completed', text })
      send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId: p.expectedTurnId, itemId, delta: text } })
      send({ method: 'item/completed', params: { threadId: p.threadId, turnId: p.expectedTurnId, item: { id: itemId, type: 'agentMessage', text } } })
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.expectedTurnId, status: 'completed' } } })
      continue
    }
    send({ id, result: { turnId: p.expectedTurnId } })
    const text = `steered:${p.input[0].text}`
    settleTurn(p.threadId, p.expectedTurnId, { status: 'completed', text })
    const itemId = randomUUID()
    send({ method: 'item/agentMessage/delta', params: { threadId: p.threadId, turnId: p.expectedTurnId, itemId, delta: text } })
    send({ method: 'item/completed', params: { threadId: p.threadId, turnId: p.expectedTurnId, item: { id: itemId, type: 'agentMessage', text } } })
    send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: p.expectedTurnId, status: 'completed' } } })
  } else if (method === 'turn/start') {
    const turnId = randomUUID()
    let text = typeof p.input[0]?.text === 'string' ? p.input[0].text : ''
    // The router prefixes staged-image manifests; the user text follows.
    const marker = text.indexOf('## 我的请求:\n')
    if (marker >= 0) text = text.slice(marker + '## 我的请求:\n'.length)
    const scenario = text.split('\n', 1)[0]
    const history = load(p.threadId)
    history.push(text)
    save(p.threadId, history)
    recordTurn(p.threadId, { turnId, clientId: p.clientUserMessageId ?? null, status: 'inProgress', text: null, input: text })
    send({ id, result: { turn: { id: turnId } } })
    const thread = p.threadId
    if (scenario === 'crash-dispatch') {
      // The app-server dies mid-turn; the next process reads the turn as interrupted.
      settleTurn(thread, turnId, { status: 'interrupted' })
      process.exit(1)
    }
    if (scenario === 'crash-complete') {
      // The answer finished and persisted before the process died.
      settleTurn(thread, turnId, { status: 'completed', text: 'RECOVERED' })
      process.exit(1)
    }
    if (scenario === 'hang' || scenario === 'stubborn') {
      const code = scenario === 'stubborn'
        ? 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)'
        : 'process.stdout.write("ready"); setInterval(() => {}, 1000)'
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] })
      await new Promise(resolve => child.stdout.once('data', resolve))
      writeFileSync(join(root, 'child.pid'), String(child.pid))
      writeFileSync(join(root, 'server.pid'), String(process.pid))
      continue
    }
    const finish = result => {
      const itemId = randomUUID()
      settleTurn(thread, turnId, { status: 'completed', text: result })
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId, delta: result } })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: itemId, type: 'agentMessage', text: result } } })
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } })
    }
    if (scenario === 'tool') {
      const itemId = randomUUID()
      const item = {
        id: itemId, type: 'commandExecution', command: 'printf tool-output', cwd: p.cwd, status: 'completed',
        commandActions: [{ type: 'unknown', command: 'printf tool-output' }], aggregatedOutput: 'tool-output', exitCode: 0,
      }
      send({ method: 'item/started', params: { threadId: thread, turnId, item: { ...item, status: 'inProgress', aggregatedOutput: null } } })
      send({ method: 'item/commandExecution/outputDelta', params: { threadId: thread, turnId, itemId, delta: 'tool-' } })
      send({ method: 'item/commandExecution/outputDelta', params: { threadId: thread, turnId, itemId, delta: 'output' } })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item } })
      finish('tool finished')
    } else if (scenario === 'multi-agent') {
      const collabId = 'collab-1'
      const activityId = 'activity-1'
      const states = { 'child-1': { status: 'running', message: 'checking repository' } }
      send({ method: 'item/started', params: { threadId: thread, turnId, item: {
        id: collabId, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'inProgress',
        model: 'fixture-mini', prompt: 'inspect the repository', agentPath: 'child-1', receiverThreadIds: ['child-1'], agentsStates: states,
      } } })
      send({ method: 'item/started', params: { threadId: thread, turnId, item: {
        id: activityId, type: 'subAgentActivity', kind: 'started', agentPath: 'child-1', agentThreadId: 'child-1',
      } } })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: {
        id: activityId, type: 'subAgentActivity', kind: 'completed', agentPath: 'child-1', agentThreadId: 'child-1',
      } } })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: {
        id: collabId, type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed',
        model: 'fixture-mini', prompt: 'inspect the repository', agentPath: 'child-1', receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: 'completed', message: 'found 3 files' } },
      } } })
      finish('multi-agent finished')
    } else if (scenario === 'filechange') {
      const itemId = randomUUID()
      const item = { id: itemId, type: 'fileChange', status: 'inProgress', changes: [{ path: `${p.cwd}/a.txt`, kind: { type: 'add' }, diff: 'hello\n' }, { path: `${p.cwd}/b.txt`, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-x\n+y\n' }] }
      send({ method: 'item/started', params: { threadId: thread, turnId, item } })
      ask('item/fileChange/requestApproval', { threadId: thread, turnId, itemId, reason: 'command failed; retry without sandbox?', grantRoot: null }, response => {
        send({ method: 'item/completed', params: { threadId: thread, turnId, item: { ...item, status: response.decision === 'accept' ? 'completed' : 'declined' } } })
        finish(response.decision)
      })
    } else if (scenario === 'transient-error') {
      send({ method: 'error', params: { threadId: thread, turnId, willRetry: true, error: { message: 'stream disconnected', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } })
      send({ method: 'error', params: { threadId: thread, turnId, willRetry: true, error: { message: 'again', codexErrorInfo: null } } })
      finish('recovered')
    } else if (scenario.startsWith('fail-')) {
      const info = scenario.slice(5)
      settleTurn(thread, turnId, { status: 'failed', error: { message: `raw ${info}`, codexErrorInfo: info } })
      send({ method: 'error', params: { threadId: thread, turnId, willRetry: false, error: { message: `raw ${info} https://u:p@proxy`, codexErrorInfo: info } } })
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'failed', error: { message: `raw ${info}`, codexErrorInfo: info } } } })
    } else if (scenario === 'withdrawn') {
      const approvalId = `withdraw-${turnId}`
      waiting.set(approvalId, () => {})
      send({ id: approvalId, method: 'item/commandExecution/requestApproval', params: { threadId: thread, turnId, itemId: 'cmd', command: 'x', cwd: p.cwd } })
      setTimeout(() => {
        send({ method: 'serverRequest/resolved', params: { threadId: thread, requestId: approvalId } })
        finish('withdrawn')
      }, 50)
    } else if (scenario === 'warn') {
      send({ method: 'configWarning', params: { summary: 'bwrap unavailable', details: 'user namespaces blocked' } })
      finish('warned')
    } else if (scenario === 'usage') {
      const breakdown = (input, output) => ({ totalTokens: input + output, inputTokens: input, cachedInputTokens: Math.floor(input / 2), cacheWriteInputTokens: 0, outputTokens: output, reasoningOutputTokens: 3 })
      send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId, tokenUsage: { total: breakdown(1100, 60), last: breakdown(100, 10), modelContextWindow: 200000 } } })
      send({ method: 'thread/tokenUsage/updated', params: { threadId: thread, turnId, tokenUsage: { total: breakdown(1250, 80), last: breakdown(150, 20), modelContextWindow: 200000 } } })
      finish('counted')
    } else if (scenario === 'plan') {
      const plan = statuses => ({ threadId: thread, turnId, explanation: null, plan: [{ step: 'read', status: statuses[0] }, { step: 'write', status: statuses[1] }] })
      send({ method: 'turn/plan/updated', params: plan(['inProgress', 'pending']) })
      send({ method: 'turn/plan/updated', params: plan(['inProgress', 'pending']) })
      send({ method: 'turn/plan/updated', params: plan(['completed', 'completed']) })
      finish('planned')
    } else if (scenario === 'diff') {
      send({ method: 'turn/diff/updated', params: { threadId: thread, turnId, diff: 'diff --git a/x b/x\n-old\n+mid' } })
      send({ method: 'turn/diff/updated', params: { threadId: thread, turnId, diff: 'diff --git a/x b/x\n-old\n+new' } })
      finish('changed')
    } else if (scenario === 'image' || scenario === 'image-only') {
      const localImages = p.input.filter(item => item?.type === 'localImage')
      if (scenario === 'image' && typeof p.input[0]?.text !== 'string') { process.exit(2) }
      let described = 'no-images'
      for (const image of localImages) {
        let bytes = 0
        try { bytes = readFileSync(image.path).length } catch { bytes = -1 }
        appendFileSync(join(root, 'images-seen.jsonl'), `${JSON.stringify({ path: image.path, bytes })}\n`)
      }
      described = localImages.map(image => `image:${readFileSync(image.path).length}`).join('|') || 'no-images'
      settleTurn(thread, turnId, { status: 'completed', text: described })
      const itemId = randomUUID()
      send({ method: 'item/agentMessage/delta', params: { threadId: thread, turnId, itemId, delta: described } })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: itemId, type: 'agentMessage', text: described } } })
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } })
    } else if (scenario === 'planmode') {
      // Mirrors a plan turn: draft deltas, a completed plan item, no execution.
      const planItemId = randomUUID()
      send({ method: 'item/plan/delta', params: { threadId: thread, turnId, itemId: planItemId, delta: '# 调研结论\n' } })
      send({ method: 'item/plan/delta', params: { threadId: thread, turnId, itemId: planItemId, delta: '先读代码再列步骤' } })
      const planText = '# 调研结论\n先读代码再列步骤'
      settleTurn(thread, turnId, { status: 'completed', text: planText })
      send({ method: 'item/completed', params: { threadId: thread, turnId, item: { id: planItemId, type: 'plan', text: planText } } })
      send({ method: 'turn/completed', params: { threadId: thread, turn: { id: turnId, status: 'completed' } } })
    } else if (scenario === 'steerable') {
      // The turn stays open until a turn/steer arrives and finishes it.
      writeFileSync(join(root, 'server.pid'), String(process.pid))
    } else if (scenario === 'interruptible') {
      writeFileSync(join(root, 'server.pid'), String(process.pid))
    } else if (scenario === 'reasoning') {
      const itemId = randomUUID()
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: thread, turnId, itemId, delta: 'thinking', summaryIndex: 0 } })
      send({ method: 'item/reasoning/summaryPartAdded', params: { threadId: thread, turnId, itemId, summaryIndex: 1 } })
      send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: thread, turnId, itemId, delta: 'more', summaryIndex: 1 } })
      send({ method: 'item/reasoning/textDelta', params: { threadId: thread, turnId, itemId, delta: 'raw-hidden', contentIndex: 0 } })
      finish('reasoned')
    } else if (scenario === 'approval') {
      ask('item/commandExecution/requestApproval', { threadId: thread, turnId, itemId: 'cmd', command: 'test command', cwd: p.cwd, reason: 'fixture' }, response => finish(response.decision))
    } else if (scenario === 'stale-approval') {
      ask('item/commandExecution/requestApproval', { threadId: thread, turnId: 'other-turn', itemId: 'cmd', command: 'x', cwd: p.cwd }, response => finish(response.decision))
    } else if (scenario === 'permissions') {
      ask('item/permissions/requestApproval', {
        threadId: thread, turnId, itemId: 'perm', environmentId: null, startedAtMs: 0, cwd: p.cwd, reason: 'net',
        permissions: { network: { enabled: true }, fileSystem: null },
      }, response => finish(JSON.stringify(response)))
    } else if (scenario === 'question') {
      ask('item/tool/requestUserInput', {
        threadId: thread, turnId, itemId: 'q', isBlocking: true, autoResolutionMs: null,
        questions: [
          { id: 'color', header: 'Color', question: 'Pick a color', isOther: true, isSecret: false, options: [{ label: 'blue', description: 'cool' }, { label: 'red', description: '' }] },
          { id: 'pin', header: 'PIN', question: 'Your PIN', isOther: false, isSecret: true, options: null },
        ],
      }, response => finish(JSON.stringify(response)))
    } else if (scenario === 'elicitation') {
      ask('mcpServer/elicitation/request', { threadId: thread, turnId, serverName: 'srv', mode: 'url', _meta: null, message: 'open', url: 'https://x', elicitationId: 'e' }, response => finish(JSON.stringify(response)))
    } else if (scenario === 'unknown-request') {
      ask('account/chatgptAuthTokens/refresh', {}, response => finish(`refresh:${response.error ? 'denied' : 'granted'}`))
    } else if (scenario.startsWith('dyntool')) {
      const tool = scenario.split(' ')[1] ?? 'dsh_mcp__hive__query'
      const itemId = randomUUID()
      const item = { id: itemId, type: 'dynamicToolCall', namespace: 'dsh', tool, arguments: { sql: 'select 1' }, status: 'inProgress', contentItems: null, success: null }
      send({ method: 'item/started', params: { threadId: thread, turnId, item } })
      ask('item/tool/call', { threadId: thread, turnId, callId: itemId, namespace: 'dsh', tool, arguments: { sql: 'select 1' } }, response => {
        send({ method: 'item/completed', params: { threadId: thread, turnId, item: { ...item, status: response.success ? 'completed' : 'failed', contentItems: response.contentItems, success: response.success } } })
        finish(`tool:${JSON.stringify(response)}`)
      })
    } else finish(scenario === 'what color?' ? history[0] : scenario === 'history?' ? history.join('|') : 'streamed response')
  }
}

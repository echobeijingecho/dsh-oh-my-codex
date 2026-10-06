import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'oh-my-codex-')))
  // Plugin status writes may still be settling during teardown.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const cwd = join(root, 'workspace')
  await mkdir(cwd)
  return {
    root, cwd,
    config: {
      ownerId: 'test-user:web', stateDir: join(root, 'state'), allowedWorkspaces: [cwd],
      turnTimeoutMs: 10000, maxInputBytes: 1048576, maxOutputBytes: 4194304,
      codex: {
        env: { CODEX_HOME: join(root, 'codex') },
        gateway: { home: join(root, 'codex-gateway') },
      },
    },
  }
}

export function request(cwd, changes = {}) {
  return {
    provider: 'dsh-codex', model: 'test-model', sessionId: 'session-1', cwd,
    signal: new AbortController().signal,
    messages: [{ role: 'user', id: 'message-1', content: [{ type: 'text', text: 'remember blue' }] }],
    permission: { sandbox: 'read-only', approval: 'never' },
    instructions: 'Test instructions.', approve: async () => false, ...changes,
  }
}

export async function collect(stream) {
  const values = []
  for await (const value of stream) values.push(value)
  return values
}

export function fakeEngine(calls = []) {
  return {
    async *run(request) {
      calls.push(request)
      await request.bindThread(request.threadId || `thread-${request.sessionId}`)
      yield { type: 'text', text: 'answer' }
    },
  }
}

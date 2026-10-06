# Architecture

`dsh-oh-my-codex` is a DSH provider backed by the first-party Codex App Server.
It keeps DSH responsible for the web session, workspace boundary, approval UI,
tool policy, and durable binding, while Codex remains responsible for the
agent loop, native thread, model request, sandbox, and native tool execution.

```text
DSH session
  |
  +-- EngineRouter
  |     +-- workspace and permission checks
  |     +-- durable session/thread binding
  |     +-- uncertain-execution recovery
  |     +-- output and input limits
  |
  +-- CodexEngine
        +-- codex app-server --listen stdio://
        +-- initialize / account/read
        +-- thread/start | thread/resume | thread/fork
        +-- turn/start and streaming item events
        +-- approval and user-input relays
        +-- dynamic DSH tools
```

## Boundaries

- Browser input never chooses the executable, `CODEX_HOME`, gateway URL, or
  workspace root.
- A DSH session binds to one engine and one canonical workspace.
- A request is marked `running` before dispatch.
- A request whose execution result is uncertain is not automatically replayed.
- Unknown App Server requests fail closed.
- Tool names are allowlisted and exposed in one `dsh` namespace.

## Process lifecycle

The provider starts a short-lived App Server process per turn. The native
Codex thread is durable, so a new process resumes the same thread instead of
replaying the DSH transcript. This keeps process state isolated while leaving
conversation state under Codex's control.

EOF is used for graceful shutdown. Signals are only a fallback after the
shutdown grace period.

## DSH tools

Selected DSH tools are declared through App Server `dynamicTools`. Calls return
to the DSH tool executor, which applies the normal identity, masking, approval,
and audit path. The model never receives an unrestricted list of internal DSH
tools.

## Compatibility strategy

The App Server schema is treated as an external contract:

- validate request responses by method;
- reject unknown response ids and malformed frames;
- identify the owning thread and turn before answering a server request;
- keep a real-binary contract test separate from fixture tests;
- pin a tested Codex CLI range in each release.

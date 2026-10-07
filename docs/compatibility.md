# Compatibility

This project targets the Codex App Server shipped with the Codex CLI. The
protocol is first-party and open source, but the App Server is evolving. A
release of this provider must record the Codex CLI version used for the real
contract test.

## Version matrix

| dsh-oh-my-codex | DSH | Codex CLI | Notes |
| --- | --- | --- | --- |
| 0.4.x | 0.1.7-rc.2 | 0.155+ | Current extracted baseline; verify the exact CLI build with the real contract test |

The matrix is a compatibility statement, not a model availability statement.
The account, plan, region, and gateway still decide which models can run.

## Supported surface

- App Server stdio JSON-RPC.
- `initialize`, `account/read`, and `model/list` preflight.
- `thread/start`, `thread/resume`, and `thread/fork`.
- `turn/start`, `turn/interrupt`, and `turn/steer`.
- Command, file-change, and permission approvals.
- User-input requests.
- Namespaced dynamic DSH tools.
- Native plan mode, review, and compaction commands when the binary exposes them.

## Intentionally declined

- MCP elicitation forms and URLs until DSH has a safe user-facing surface.
- Unknown or unrecognized server requests.
- Automatic replay after an uncertain write.
- Cross-engine context migration.

## Authentication

The provider can use an isolated `CODEX_HOME`. Operators must not copy one
subscription credential to multiple users or expose the provider as an
uncontrolled shared endpoint.

## Native multi-agent execution limits

When enabled, `multiAgent.maxAgents` is passed as `agents.max_threads` (the
legacy alias for the concurrent child-thread limit) and `maxDepth` as
`agents.max_depth`. These apply independently of hardening. The real-binary
contract test reads the effective configuration to check both values; it
does not run a model or prove spawn/limit behavior. Live-model depth and
concurrency verification remains a separate acceptance step.

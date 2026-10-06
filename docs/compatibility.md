# Compatibility

This project targets the Codex App Server shipped with the Codex CLI. The
protocol is first-party and open source, but the App Server is evolving. A
release of this provider must record the Codex CLI version used for the real
contract test.

## Version matrix

| dsh-oh-my-codex | DSH | Codex CLI | Notes |
| --- | --- | --- | --- |
| 0.3.x | 0.1.7-rc.2 | 0.155+ | Current extracted baseline |

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

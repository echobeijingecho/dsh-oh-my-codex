## 0.4.0 (2026-10-07)

- Composer quota pill + unified settings quota card (sparse-merged rate-limit
  snapshots from turn pushes and preflight).
- Zero-output quota failures roll back the binding and auto-retry once after
  the window reset (`codex.quotaRetryMaxWaitMins`, 0 disables).
- Recommended model catalog docs (gpt-6-astra / gpt-6.1-sol / gpt-6-luna;
  gpt-5.5 retires 2026-10-14) and `discoverModels` surfaced in the example.
- Opt-in native web search passthrough (`codex.webSearch`).
- Backport: gateway API-key auth broker and explicit `gateway.command` args
  semantics (subscription `-c` overrides never leak into the gateway home).

# Changelog

## Unreleased

- Extract the DSH Codex App Server provider into an independent community package.
- Generalize provider identifiers, client attribution, and gateway configuration.

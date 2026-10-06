# Contributing

Thanks for helping improve `dsh-oh-my-codex`.

## Development

Requirements:

- Node.js 22.19 or newer.
- A DSH installation matching the peer dependency versions in `package.json`.
- A Codex CLI binary when running the optional protocol contract test.

Run the local suite:

```bash
npm ci
npm test
```

Run the real App Server contract test only when a compatible binary is available:

```bash
CODEX_CONTRACT_BIN=/path/to/codex npm test -- --test-name-pattern='real App Server'
```

## Protocol changes

Treat the Codex App Server schema as an external contract. Add or update:

1. A fixture test for the event or request.
2. Validation for the smallest accepted response shape.
3. A fail-closed path for unknown or unsafe requests.
4. A compatibility note in `docs/compatibility.md`.

Never add a fallback that silently creates a new thread after an uncertain write.

## Pull requests

Keep changes focused, explain the App Server version tested, and include the
relevant test command. Do not commit credentials, `CODEX_HOME`, transcripts, or
private gateway URLs.

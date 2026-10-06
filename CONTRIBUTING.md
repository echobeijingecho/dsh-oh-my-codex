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
npm run check
```

The repository pins the supported local runtime in `.nvmrc`. If the command
fails before the test runner starts, switch to Node.js 22.19 or newer.

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

## Local maintenance layout

This repository is the public source of truth for the generic DSH adapter.
Keep private deployment overlays, vendored UI packages, instance configuration,
and production scripts in the consuming private repository. Do not copy those
files into this repository when preparing a public change.

The normal local loop is:

```bash
cd ~/code/dsh-oh-my-codex
npm ci
npm run check
git diff --check
git add .
git commit
git push origin main
```

When the private deployment needs a new public version, build a package from
this checkout and review the tarball contents before installing it:

```bash
npm pack --dry-run
```

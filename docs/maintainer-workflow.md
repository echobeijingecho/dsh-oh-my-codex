# Maintainer Workflow

`dsh-oh-my-codex` is the public source of truth for the generic Codex App
Server adapter. A private DSH deployment may consume a built package or a
reviewed source snapshot, but it must not become the upstream source by
accident.

## Repository boundaries

Keep these concerns in the public repository:

- Codex App Server protocol handling.
- DSH provider and engine integration.
- Generic gateway, workspace, approval, and state handling.
- Fixtures and tests that do not need private services.

Keep these concerns in a private consuming repository:

- Instance-specific `cordis.patch.yml` files.
- Internal gateway URLs, model names, credentials, and `CODEX_HOME`.
- Vendored UI packages and deployment-only bundles.
- Production rollout scripts and host-specific paths.

## Local paths

Use a sibling checkout layout so the two repositories are easy to inspect
without putting one repository inside the other:

```text
~/code/dsh-oh-my-codex/   # public source
~/code/ziroom-buddy/      # private DSH integration and deployment
```

If the paths differ on another machine, use the equivalent two independent
checkouts. Do not add a symlink, `file:` dependency, or absolute local path to
the published package.

## Change flow

1. Make generic adapter changes in the public checkout.
2. Run `npm run check` and `git diff --check`.
3. Review `npm pack --dry-run` for accidental private files.
4. Commit and push the public change.
5. Update the private deployment from the reviewed package or commit.
6. Run the private deployment's focused tests and rollout verification.

The package identity in `lib/identity.js` is read from `package.json`. Update
the package version once per release; do not hardcode a second runtime version
or override the Codex `clientInfo.version` independently.

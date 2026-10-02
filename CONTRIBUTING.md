# Contributing to Talekiln

> Draft for the open-source release. Wording on licensing and the CLA needs legal review before publication.

Thanks for helping. This repository contains the desktop shell, the renderer UI, the local service and the
provider adapters. The rendering core (lycore), licensing and cloud services are closed source and not in this repo;
the project builds and runs without them with reduced features (see `docs/open-source-split.md`).

## Before you start

- Read the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go to [SECURITY.md](SECURITY.md), never to a public issue.
- Sign the [CLA](CLA.md). A bot comments on your first pull request; you sign by replying with the sentence it shows. PRs cannot be merged before that.
- Open an issue before large changes (new provider, new view, storage changes) so we can agree on scope.

## What is licensed how

| Part | License |
|---|---|
| `apps/*`, `packages/local`, `packages/kernel` | AGPL-3.0-only (see `LICENSE`) |
| `packages/plugin-sdk` and plugins you build on it | MIT (see its `LICENSE`); your plugin may use any license you like |
| Upstream LocalMiniDrama portions | MIT (`LICENSE-LocalMiniDrama`) |

Your contribution is licensed under the license of the directory you change, and the CLA additionally lets the maintainers
relicense it (needed because a closed build ships alongside the open one). New files need no per-file header unless a directory already has one.

## Development

```bash
pnpm install
pnpm test            # all packages
pnpm secrets:scan    # must pass before every commit
pnpm licenses:check  # fails on GPL/AGPL dependencies
pnpm dev:web         # local service :5679 + renderer :3013
```

Node >= 22, pnpm 10. No Rust toolchain is needed: lycore is not part of this repo.
Without lycore, export/render features are disabled; tests inject a fake core where needed.

## Rules for every pull request

1. Tests for behavior changes. `pnpm test` green.
2. **No secrets, ever.** API keys, tokens, signed URLs, real account or workspace domains must not appear in code, tests, fixtures or logs. Use `.example` domains and fake keys. Recorded vendor responses go through `packages/local/scripts/lib/redact.js` first.
3. Provider adapters: follow `docs/provider-extension.md` (or build a plugin, see `packages/plugin-sdk/README.md`). Adapter code must not read env vars or config files, and must not put the key in error text. Run the contract kit for plugins.
4. No new dependency with a GPL/AGPL license; LGPL only if dynamically used and listed in `docs/licenses.md`.
5. Do not add prices, real endpoints, brand assets or third-party media without stating their license in the PR.
6. Keep PRs focused; commit messages in English or Chinese, imperative, one logical change each.
7. User-facing strings are Chinese by default; keep error codes stable (`docs/error-codes.md`).

## Review

A maintainer reviews within a reasonable time (no SLA promised). CI must pass: tests, secret scan, license check, CLA.

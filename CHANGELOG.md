# Changelog

## 0.1.4

- **Display metadata for the Plugins page.** The package now exports `./package.json`, `./locale/*.json`, and `./icon`, and ships `locale/en.json`, `locale/zh.json`, and `icon.svg`. Before this release the manifest's `exports` map covered only `.`, so DSH's metadata reader — which resolves `<package>/locale/<lang>.json`, `<package>/package.json`, and `<package>/icon` through Node — could reach none of them. The bundle card and its detail page therefore showed the bare package name, no description, and the default artwork. `lib/index.mjs` is unchanged from 0.1.3, so an installation on 0.1.3 runs the same code.
- `tests/display-metadata.test.mjs` pins the exports, the non-empty `meta.title`/`meta.description` in every locale, the packed file list, and resolver reachability, so a future manifest edit cannot silently strip the card again.
- `npm test` runs both test files; `npm run pack:check` previews the published file list.

## 0.1.3

- Chinese `description`, matching the one-line summaries other DSH bundles publish: the Web Plugins page and the install dialog show it verbatim. `lib/index.mjs` is unchanged from 0.1.2.

## 0.1.2

- Documentation and metadata only. `lib/index.mjs` is byte-identical to 0.1.1, so an installation on either version runs the same code.

## 0.1.1

- **`engines.dsh` raised to `>=0.2.1-rc.2`.** The previous `>=0.1.7` claimed a range that was never run. Every extension point this plugin uses (`approval/request`, `tools/pre-execute`, `agent/status`, `SessionHeader.origin`/`delegationDepth`, `ToolExecution.callId`/`agent`) is declared in 0.1.7-rc.2 as well, so the lower bound was not provably wrong — but a declared compatibility range should cover only versions that were actually exercised. 0.2.1-rc.2 is the one this plugin is tested against.

## 0.1.0

- First release.
- Modal topmost dialogs for approval requests, `ask_user_question`, `exit_plan_mode`, and root-agent run completion.
- Zero npm dependencies; the dialog is a PowerShell child process driven over `-EncodedCommand`, so multi-line bodies and arbitrary quotes survive intact.
- One dialog at a time, with a queue behind it.
- Per-source switches, template messages, per-session completion cooldown, subagent muting, and an optional trace file.

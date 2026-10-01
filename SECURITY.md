# Security Policy

> Draft for the open-source release.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private vulnerability reporting
(repository > Security > "Report a vulnerability"). TODO: Jay to enable it on the public repository and, if wanted,
add a security mailbox here (no address has been invented in this draft).

Please include: affected version or commit, steps to reproduce, impact, and whether you believe a secret was exposed.
Never include real API keys or customer data in a report; if a key leaked, revoke it at the vendor first.

## What to expect (targets, not promises)

- Acknowledgement within 3 working days.
- A first assessment within 10 working days; fixes for confirmed issues are prioritised by severity.
- Coordinated disclosure: we ask for up to 90 days before public details; credit in the advisory unless you prefer otherwise.

## Scope

In scope: the desktop shell, the local service (listens on 127.0.0.1 only), provider adapters and the plugin SDK
(including the plugin permission checks). Out of scope: the closed-source rendering core, licensing and cloud services
(report those through the same channel; they are handled privately), third-party providers' own APIs, and social engineering.

Note for plugin authors and users: plugins run in-process with the permissions the manifest declares; the SDK's permission
guard is not a sandbox (`packages/plugin-sdk/README.md`, "Trust model"). Install only plugins you trust.

## Supported versions

Only the latest release receives security fixes. TODO: revisit after the first public release.

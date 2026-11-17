# Security policy

RUGR holds a real Solana wallet, so security reports are taken seriously.

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Report it privately through GitHub instead:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

Never include a real private key, password or seed phrase in a report. Use a fresh wallet with no funds to
demonstrate the problem.

We'll acknowledge your report as soon as we can, keep you updated while we work on a fix, and credit you when it's
released, unless you'd rather stay anonymous. There is no bug bounty at the moment.

## In scope

- The companion: wallet storage, signing, transaction limits and the local API.
- The mod and the phone window, including how input and the password reach the companion.
- The RUGR server.
- RUGR Setup: downloads, file checks and what it writes to the game folder.

## Out of scope

- Bugs in Script Hook V, ScriptHookVDotNet, iFruit Jailbreak or GTA V itself. Please report those to their authors.
- The Solana network, pump.fun's programs and Jupiter's services.
- Attacks that need full control of the player's PC. See the limits in the [security model](docs/SECURITY_MODEL.md).

## Supported versions

Security fixes go into the latest release. Update RUGR by running the newest RUGR Setup.

# Contributing to GTAMOD

Thanks for helping build RUGR. This guide covers how to set up the project, what a good pull request looks like, and
the rules that keep players' money safe.

## Before you start

- **Bugs:** open an issue with the bug report template. Never include a private key, password or seed phrase, and
  check logs and screenshots for them before posting.
- **Security problems:** don't open an issue. Report them privately, as described in [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue first to discuss the idea, so no work is wasted.

## Setting up

You need Node.js 20 or newer. For the C# parts, you need the .NET SDK with the .NET Framework 4.8 targeting pack and
iFruit Jailbreak 6.0 in `mod/lib/` (see [`mod/lib/README.md`](mod/lib/README.md)).

```bash
cd companion && npm ci && npm test
cd server && npm ci && npm test
```

`npm run sim -- --fake` in `companion/` opens every screen in a browser at http://127.0.0.1:47616, with made-up coins
and no network, so most changes can be tried without the game. [`docs/BUILDING.md`](docs/BUILDING.md) has the full
build, the C# contract test and the release process.

## Pull requests

- Keep each pull request to one change, and explain what it does and why.
- `npm test` must pass in `companion/` and `server/`. CI runs both on every pull request.
- If you change the screens the companion sends, run the C# contract test from [`docs/BUILDING.md`](docs/BUILDING.md),
  because the mod parses them.
- Add or update tests for behavior you change, especially anything that builds, signs or limits a transaction.
- Match the style of the code around you. TypeScript is strict; don't silence the compiler.
- Update the docs when behavior changes.

## Rules for anything that touches money

RUGR handles a real wallet. These rules aren't up for debate in a pull request:

- The private key stays in the companion. Never send it, log it or pass it to the game process.
- Every transaction is shown on a confirm screen first, with the limits the chain will enforce.
- No fees, tips or hidden transfers of any kind.
- No features designed to mislead other players, such as fake volume, bundled buys or impersonating other projects.
- New wallets start in Practice, and switching to real money always asks for the password.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

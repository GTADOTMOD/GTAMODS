## What this changes

<!-- What does this pull request do, and why? Link the issue it closes, if there is one. -->

## How it was tested

- [ ] `npm test` passes in `companion/`
- [ ] `npm test` passes in `server/`
- [ ] The C# contract test passes, if the screens the companion sends changed
- [ ] Tried in the simulator (`npm run sim -- --fake`) or in the game

## Money safety

- [ ] The private key stays in the companion and isn't logged or sent anywhere
- [ ] Every new transaction goes through a confirm screen with the limits the chain enforces
- [ ] No fees, tips or hidden transfers

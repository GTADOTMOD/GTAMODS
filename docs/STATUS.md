# Project status

RUGR is in early access. This page lists what has been verified, in the game and outside it, and what hasn't yet.


**Verified in the game** (Legacy 1.0.3889, Borderless, with Script Hook V 3889.0 and
ScriptHookVDotNet Enhanced 1.1.0.6):
- The mod, phone app, companion auto-start and phone window all load and run.
- A wallet created from the phone, with its password typed there.
- The game's camera took a clean square photo, with nothing drawn over it.
- The P screenshot key.

**Verified outside the game:**
- Companion: 99 automated tests (`npm test`). They cover the keystore, wallet setup, unlocking
  and backup, config validation, formatting, slippage math, local-API security, the live coin
  feed, the SOL price, image hosting, and full buy/sell/create flows. Those flows run through the
  real pump.fun SDK against an in-memory chain whose accounts are encoded with the SDK's own
  IDL, and the resulting transactions are decoded to check the on-chain limits.
- The C# UI model parses real companion responses, and navigation and the fallback layout are
  checked for every screen (the contract test below).
- The phone window's screens, checked by eye as images from `PumpPhone.exe --capture`.
- Jupiter's live service: real quotes parse, an empty wallet is told it has insufficient funds, and a real transaction
  for another wallet is refused before signing. A swap has not been simulated end to end with a funded wallet.
- The packaged companion: wallet setup, refusing to trade while locked, live coins, the
  clipboard, and stopping when its parent process exits.
- Against live services, using the public RPC: Trending and New from Jupiter and the live feed, and
  real coin pages, drawn through the phone window.
- Settings, in the simulator: limits, RPC screens, exporting the key, changing the password, locking,
  resetting, and a refused import. A successful import is covered by the automated tests.
- Against Solana mainnet, simulated and never sent: PumpSwap buy and sell, bonding-curve buy and
  sell, and a launch. A create with RUGR's reference comes to 942 bytes; with the first buy in the same transaction
  it came to 1,716, over Solana's 1,232 limit, which is why the first buy is now its own transaction.
- RUGR's server and the companion together, against mainnet: a new wallet, its balance, RUGR-only Trending, a real
  coin's page, and a buy simulated through the server's RPC. The server has its own tests (`server/`, `npm test`).

**Not yet verified:**
- A real, sent transaction of any kind: buy, sell, swap, send or create.
- In the game: the RUGR look, the bottom tabs and Q/E, opening animation, Trending and New from
  live data, Settings, Swap and Send.
- LB and RB on a controller, which nobody has tried.
- Copying from the game's phone in other apps, and pasting into Swap and Send from them.
- Practice with a funded wallet through the phone. The simulations above built the same
  transactions, but ran them as a public address without signing.
- In the game: the back keys and new highlight, Esc staying out of the pause menu, the square
  viewfinder and coin card, selfie mode, and whether the character visibly raises the phone.
- Scanning the QR code with a real wallet.
- The phone window in exclusive fullscreen, on another resolution, or on other characters' phones.
- PumpSwap has no automated test yet, only the mainnet simulations above.

Prices, quotes and balances always come from the chain, read fresh when a token page opens.

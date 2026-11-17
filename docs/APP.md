# The RUGR app

RUGR is a Solana wallet and trading app that lives on the GTA V phone. This page covers what each screen does and
how the coin lists work. For playing, see the [user guide](USER_GUIDE.md).

## Screens

| Screen | What it does |
|---|---|
| Opening | An animation of the logo every time the app opens, then **Create wallet** or **Import a wallet** on first open: choose a password on the phone, then fund it. Later opens ask for the password |
| Tabs | **Home**, **Swap**, **Wallet** and **Activity** along the bottom. **Q** and **E** move between them from anywhere, LB and RB on a controller. Back goes from a tab to Home, and from Home closes the app |
| Home | Wallet card, Trending, New Coins, Watchlist, Search, Create Coin |
| Swap | You pay and You receive cards, with any Solana token on either side, routed through [Jupiter](https://developers.jup.ag/docs/swap). Paste or type a token's address, or pick from your tokens and popular ones. 50% and 100%, flip, price impact and minimum received. Fresh quote at the moment you confirm |
| Wallet | Address (press to copy), total in dollars and its 24-hour change, Send, Swap, Receive (QR code and copy button), Settings, and your tokens with logos, amounts, values and changes |
| Settings | Copy address, Export private key, Change password, Lock wallet, Practice or Real money, Slippage, Max per trade, RPC, Reset wallet |
| Activity | Your past trades, swaps and sends |
| Trending, New | Coins launched on RUGR, with their pictures, market cap, 5-minute change, volume and traders, and how old they are on New. Any other token is a search away |
| Coin | Market cap, bonding-curve progress (or "PumpSwap" once graduated), price, 24-hour change and volume, liquidity, holders, your position and its value. Buy presets, buy a custom amount, sell 25/50/100%, add to watchlist. Tokens pump.fun can't trade get **Swap** instead |
| Confirm | Exactly what will happen: max SOL spent, expected tokens, minimum after slippage, venue. The highlight starts on **Cancel**. Valid for 30 s, and each one can be used only once |
| Create coin | A card showing your coin as it stands, then photo, name, ticker, description, first buy, review, confirm. The coin is created first and the first buy follows as its own transaction, because the two together are too big for one |

**Values** are shown in dollars, using the SOL price from Pyth's on-chain account, and
fall back to SOL if that can't be read. Trades are always quoted and limited in SOL. The Wallet and Swap tabs get
names, logos, prices and 24-hour changes from Jupiter's public token list. Without it they still work, with less shown.
Token logos load from wherever each token's creator hosts them, so those sites can see your IP address.

The limits the chain enforces match the confirm screen: a buy never spends more SOL than
the amount you picked, and a sell never returns less than the minimum shown.

**Trending and New** show only coins launched through RUGR, from RUGR's server. Search and trading work for any
token; only the lists are RUGR's own.

- Every launch from the app names RUGR's reference address in its transaction, and the server reads launches back
  from the chain, so a coin is listed only if it really came from RUGR, and none is ever missed.
- **Trending** ranks by how many wallets traded a coin in the last 5 minutes, then by volume. **New** is newest
  first.
- Stats come from [Jupiter's token data](https://dev.jup.ag/docs/tokens) and each coin's bonding curve, so a coin
  has a market cap and curve progress from its first second.
- Until someone launches, both lists say so and offer **Create Coin**.

**RUGR only buys regular coins.** Mayhem mode coins never appear in the lists and can't
be bought, even by address, because their curves can hold far less SOL than the price
implies, so a big enough sale can't be paid out. If the wallet already holds one, its
token page still lets you sell as much as the curve can pay, and holdings are valued at
that amount. Launches always create regular coins.

**What pump.fun doesn't offer:** its SDK covers trading, not wallets, logins or its
social features (follows, callouts, DMs), and we found no official API for those. So
wallets here are ordinary Solana key pairs, kept on the player's PC.

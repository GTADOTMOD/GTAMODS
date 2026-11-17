# Security model

How RUGR protects the wallet, and where its limits are. To report a vulnerability, see
[SECURITY.md](../SECURITY.md).


- **Wallet:** encrypted with scrypt plus AES-256-GCM under your password (`keystore.json`).
  The companion starts locked, with no key in memory, and can't reach any other screen until
  it's unlocked. There is no password reset.
- **Password:** it's typed in the game and passes through the mod to the companion, so another
  mod could capture it, the same way a bad program could log keystrokes in a terminal. The key
  itself and all signing stay in the companion.
- **Anything beyond a normal trade asks for the password again:** showing or copying the key,
  turning on real money, raising slippage or the per-trade limit, changing the RPC, changing the
  password, and resetting the wallet. Lowering a limit doesn't. Any program on the PC can read the API's token, so an unlocked
  wallet alone must not be enough to read out the key. Trades are still limited per trade
  rather than by password, so a bad program on the PC could trade within those limits.
- **Local API:**
  - Listens on 127.0.0.1 only.
  - Each run creates a random token, written to `connection.json` for the mod and required on
    every request.
  - Requests carrying an `Origin` header (browsers) or a foreign `Host` header (DNS rebinding)
    are refused.
  - Bodies must be JSON, 16 KB maximum.
- **Token images:** only files inside the images folder can be uploaded. Paths and symlinks
  that escape it are refused.
- **Text from the internet:** token names and other outside text have GTA formatting codes
  (`~r~`, `~n~`, ...) stripped before they reach the phone.
- **Trades:** run one at a time, and every confirm screen works only once.
- **Swaps:** Jupiter builds these transactions, so none is taken on trust. The fee payer must be this wallet, the
  amount received must still meet the minimum you saw, and a simulation must show it spending no more SOL than the
  swap plus 0.02 SOL for fees and new accounts. The simulation only checks SOL, not other tokens in the wallet.
- **Sends:** real ones always need the password, and the confirm screen shows the whole address.
- **Clipboard:** only read when you press a Paste button, and only written when you press Copy.

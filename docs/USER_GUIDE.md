# User guide

How to play with RUGR once it's installed. To install it, download RUGR Setup from the
[download page](https://gtamod.onrender.com/download.html) and press **Install**.

## Opening the app

Open the phone and go to **RUGR** on the home screen. If single player has filled page 1,
it's on page 2; `ReplaceGameApp=true` in `PumpV.ini` puts it on page 1. It starts the
companion by itself, so the first open can take a moment.

| Key | What it does |
|---|---|
| Up, Down, Left, Right, mouse wheel | Move the highlight. It only lands on things you can pick, and moves across rows of buttons the way they look. On a screen inside a tab, Left at the edge goes back |
| Q, E (LB, RB on a controller) | The tab to the left or right, from anywhere. Goes round at the ends. The game doesn't get these keys while the app is open |
| Enter | Select |
| Esc, Delete, or right-click | Back. From a tab, to Home. From Home, it closes the app |
| P | Saves a screenshot to `%LOCALAPPDATA%\PumpV\screenshots\` and copies it, while the app is open |

- **Your wallet:** on first open, press **Create wallet** and type a password of at least 10
  characters, twice. It shows as `*` and can't be recovered, so save your key from
  **Wallet → Settings → Export private key**. To use an existing wallet instead, copy its private
  key and press **Import a wallet**. The clipboard is cleared afterwards.
- **Starting over:** **Wallet → Settings → Reset wallet** takes the wallet out of RUGR and asks for
  your password. Activity is cleared and the app goes back to Practice. The encrypted wallet file
  moves to `%LOCALAPPDATA%\PumpV\old-wallets\`, so a mistake can be undone by moving it back as
  `keystore.json`. If you forgot the password, **Forgot password** on the unlock screen does the same
  once you type RESET. Without your private key or password, the funds can't be reached by anyone.
- **Funding it:** **Wallet → Receive** shows a QR code to scan, and **Copy address** copies it so you can
  paste it into another wallet.
- **Swapping any token:** copy its address (CA) anywhere on your PC, go to **Swap → Paste token address**, and enter
  an amount under **You pay**, or press 50% or 100%. Press a token to change it, and the round button to flip them.
- **Sending:** **Wallet → Send**, pick SOL or a token, press **Paste wallet address**, pick an amount, and check the whole
  address on the confirm screen. It leaves a little SOL behind for fees. Real sends ask for your password.
- **Typing** custom amounts, token addresses and coin details uses the game's on-screen
  keyboard. Passwords are typed directly on the phone instead, because that keyboard shows
  what you type. Dead keys type nothing there, so `´` then `a` gives `a`.
- **Taking a coin's photo:** on Create coin, choose **Photo**. The game's real phone camera
  opens, cropped to a square. **Enter** takes the shot, **Up** switches to selfie, and **Esc**
  cancels. The photo is saved to `%LOCALAPPDATA%\PumpV\images\`. You can also drop your own PNG
  or JPG into that folder and pick **Use newest image file**.
- **Before GTA Online:** take everything back out, and turn BattlEye back on in the Rockstar
  launcher if you turned it off there.

## Before you go live

1. Try everything in Practice first. Confirm screens say **SIMULATE BUY / SELL / CREATE**, and
   the transaction is simulated against mainnet but never sent. It still needs SOL in the
   wallet, though none is spent: about 0.015 SOL to reach the confirm screen for a 0.01 SOL
   buy, and 0.03 SOL for a launch with no first buy.
2. Keep only what you're willing to lose in this wallet, and back up its key.
3. A real launch uploads the coin's picture and details to RUGR's server first. If that fails, nothing is sent.
   Practice doesn't upload. `pumpv-companion.exe check` tests the server.
4. Go to **Wallet → Settings → Mode → Use real money** and enter your password. Trades now use real SOL
   until you switch back, including after a restart. Start with the smallest amount.
5. Memecoins are extremely risky, and created coins are permanent.

## Rockstar and Take-Two

Rockstar's rules for roleplay servers explicitly ban crypto and NFTs, so this must never be
used on FiveM or any server. Take-Two has historically tolerated single-player mods that are
non-commercial and respect its IP, but a crypto mod is a gray area. Don't add trading fees,
and don't launch GTA-branded tokens. This project is not affiliated with Rockstar Games,
Take-Two or pump.fun.

## Configuration (`%LOCALAPPDATA%\PumpV\config.json`)

| Key | Default | Meaning |
|---|---|---|
| `apiUrl` | `https://rugr-api.onrender.com` | RUGR's server |
| `rpcUrl` | RUGR's, `<apiUrl>/rpc` | Solana RPC (must be https). A config still set to the old public default moves to RUGR's |
| `dryRun` | `true` | Practice: simulate only. The phone changes this for you |
| `slippagePercent` | `10` | Slippage tolerance (0.1–50) |
| `maxSolPerTrade` | `0.5` | Hard cap per buy |
| `buyPresetsSol` | `[0.01, 0.05, 0.1, 0.25]` | Buy rows on a token page (each ≤ the cap) |
| `sellPresetsPercent` | `[25, 50, 100]` | Sell rows |
| `launchBuyPresetsSol` / `maxLaunchBuySol` | `[0, 0.01, 0.05, 0.1, 0.25]` / `1` | First buy when launching |
| `priorityFeeMicroLamports` | `200000` | Priority fee per compute unit |
| `quoteTtlSeconds` | `30` | How long a confirm screen stays valid |
| `port` | `47615` | Local port (only 127.0.0.1 is bound) |

Swaps use Jupiter's free tier, limited to about one request every two seconds, and need no key.

Invalid or risky values (an http RPC, slippage over 50%, presets above the cap, absurd
priority fees) are rejected at startup. If the companion won't start, the reason is in
`companion.log` in the same folder.

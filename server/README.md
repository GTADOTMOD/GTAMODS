# RUGR server

The app on every player's PC talks to this for three things:

- **`POST /rpc`**: Solana, through a private RPC (Helius or similar) whose key stays on the server. Only the calls the
  app makes are passed on, each player is rate-limited, and when the private RPC is busy or down the call goes to
  Solana's public RPC instead. A transaction goes out both ways, so it's likelier to land.
- **`POST /launch/upload`** and **`POST /launch/register`**: a new coin's picture and details, kept as pump.fun-style
  metadata and served from `/m/<id>.json` and `/i/<hash>`, then the launch itself, read back from the chain and listed.
- **`GET /coins?kind=trending|new`**: Trending and New, made only of coins launched through RUGR.

## Which coins count as RUGR's

A coin is listed when its create transaction, read from the chain, does all of this:

1. names RUGR's reference address, `DTd9oBwtsdTK7q2UoN4ejGYe7CuuEyFyaeSk1E2D5RqW`, read-only. It's derived from the seed
   `rugr-launch` under the System program, nobody holds a key for it, and the companion adds it to every launch;
2. isn't a Mayhem coin;
3. points to metadata this server issued.

The server also walks the reference address's history every 20 seconds, so a launch the app never reported (a crash, a
lost connection) still shows up within a minute, and the whole list can be rebuilt from the chain.

Stats come from Jupiter's token data (market cap, 5-minute change and volume, traders, holders) and from each coin's
bonding curve on-chain, which is there from the first second.

## Running it

```bash
npm ci
npm run build
npm start
```

| Variable | What it is |
|---|---|
| `RPC_URL` | The private RPC, key included. Without it, everything uses the public RPC. |
| `PUBLIC_URL` | Where players reach the server. On Render, `RENDER_EXTERNAL_URL` is used. Coin metadata links point here and are on-chain for good, so keep it stable. |
| `DATA_DIR` | Pictures, metadata and the coin list. On Render, a persistent disk. |
| `NETWORK` | `mainnet` (default) or `devnet`. |
| `PUBLIC_RPC_URL` | Overrides Solana's public RPC for the network. |
| `JUPITER_API_KEY` | Optional, for more headroom on token stats. |

On Render it runs as a web service on the Starter plan (always on: a sleeping free service takes a minute to wake,
far too long for an app people trade from) with a 1 GB disk at `/var/data`, `DATA_DIR=/var/data`, build command
`npm ci && npm run build` and start command `npm start`, rooted at `server/`.

`npm test` runs the tests, including decoding a real pump.fun create from `test/fixtures/create.json`.

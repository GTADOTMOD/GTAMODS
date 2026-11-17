# Third-party notices

The code in this repository is released under the [MIT License](LICENSE). The items below are not covered by it.

## Brand and artwork

The GTAMOD and RUGR names and logos, and the artwork made for the project, are not licensed for reuse. All rights
reserved. This covers:

- `brand/`
- `landing/assets/` (except the fonts listed below)
- `companion/tools/art/`
- `installer/assets/`
- `docs/assets/`

The artwork is AI-generated, with invented people and places. `landing/assets/art/ingame-golden.webp` and
`landing/assets/art/coin-photo.webp` are screenshots of Grand Theft Auto V, © Rockstar Games and Take-Two Interactive.

## Included in this repository

| Component | License | Where |
|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | MIT | `landing/vendor/three.module.min.js`, license in `landing/vendor/three.LICENSE.txt` |
| [Lenis](https://github.com/darkroomengineering/lenis) | MIT | `landing/vendor/lenis.min.js`, license in `landing/vendor/lenis.LICENSE.txt` |
| [Barlow Condensed](https://github.com/jpt/barlow) | SIL Open Font License 1.1 | `landing/assets/fonts/barlow-condensed-*`, license in `OFL-BarlowCondensed.txt` |
| [IBM Plex Mono](https://github.com/IBM/plex) | SIL Open Font License 1.1 | `landing/assets/fonts/ibm-plex-mono-*`, license in `OFL-IBMPlexMono.txt` |
| [Inter](https://github.com/rsms/inter) | SIL Open Font License 1.1 | `landing/assets/fonts/inter-*`, license in `OFL-Inter.txt` |

npm dependencies are installed from the npm registry under their own licenses, listed in each `package-lock.json`.

## Used by RUGR, not included

These are installed on the player's PC by RUGR Setup and are not part of this repository.

- **[Script Hook V](http://www.dev-c.com/gtav/scripthookv/)** by Alexander Blade. Its readme forbids redistribution,
  so RUGR Setup downloads it from its official page on the player's PC.
- **[ScriptHookVDotNet Enhanced](https://github.com/Chiheb-Bacha/scripthookvdotnetenhanced)**, zlib license. RUGR Setup
  downloads it from its GitHub releases.
- **[iFruit Jailbreak](https://www.gta5-mods.com/tools/ifruit-jailbreak-sending-sms-and-emails)** by andre500
  ([source](https://github.com/sruckstar/iFruitJailbreak)). RUGR Setup carries the author's official 6.0 build,
  unchanged and credited.
- **Microsoft Visual C++ Redistributable** and **Microsoft Edge WebView2 Runtime**, downloaded from Microsoft when missing.

## Services

RUGR uses [pump.fun](https://pump.fun)'s official SDK (`@pump-fun/pump-sdk`), [Jupiter](https://jup.ag) for swaps and
token data, and [Pyth](https://pyth.network) for the SOL price. None of them is affiliated with this project.

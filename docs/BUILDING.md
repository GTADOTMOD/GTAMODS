# Building from source

Players don't need any of this: RUGR Setup installs everything. This is for building and changing RUGR.

## Requirements

RUGR Setup installs all of these with one click, except the game. Anything already there stays.

- GTA V on PC, **story mode only**, in **Borderless or Windowed** display mode so the phone
  window can sit over the game. Setup switches a fullscreen game to borderless. Never use mods in GTA Online.
- [Script Hook V](http://www.dev-c.com/gtav/scripthookv/). Its readme forbids
  redistributing it, so Setup downloads it from that page on the player's PC. Its `args.txt` turns off the game's
  BattlEye anti-cheat, so remove the mod files before playing GTA Online.
- [ScriptHookVDotNet Enhanced](https://github.com/Chiheb-Bacha/scripthookvdotnetenhanced), which
  works on Legacy and Enhanced. Setup gets its latest release from GitHub. It needs Microsoft's Visual C++ runtime,
  which Setup adds if it's missing.
- [iFruit Jailbreak](https://www.gta5-mods.com/tools/ifruit-jailbreak-sending-sms-and-emails) by andre500
  ([source](https://github.com/sruckstar/iFruitJailbreak)), which provides the
  phone-app framework. Its phone apps currently support game versions 1.72–1.73 on both
  Legacy and Enhanced. It has no license file; RUGR Setup carries the author's own 6.0 build from gta5-mods.com,
  unchanged and credited.
- The WebView2 runtime, which comes with Windows 11; Setup adds it if it's missing. Without it, or without the phone
  window's files, the app falls back to drawing on the game's own phone screen.
- Nothing else: the app uses RUGR's own RPC through its server. A player can still set their own in
  **Wallet → Settings → RPC**; any https:// Solana RPC works, and none needs WebSocket access.

## Building

`installer\build-release.ps1` builds steps 3 to 5 and RUGR Setup in one go. To do it by hand, follow
the steps below. This needs Node.js 20 or newer and the .NET SDK.

**1. Script Hook V and ScriptHookVDotNet Enhanced.** Copy them into the folder with
`GTA5.exe`, following their own notes. Skip `NativeTrainer.asi`, which this doesn't need.

The first launch may show BattlEye's install prompt. Choose **Cancel** rather than
installing it. If it keeps coming back, untick BattlEye and add `-nobattleye` to GTA V's
launch arguments in the Rockstar launcher's settings.

**2. iFruit Jailbreak.** Download 6.0 from [its gta5-mods.com page](https://www.gta5-mods.com/tools/ifruit-jailbreak-sending-sms-and-emails)
and copy `scripts\iFruit Jailbreak.dll` from its zip to `mod\lib\` and to `GTA V\scripts\`. It fetches its own
version tables from GitHub the first time the game runs. `build-release.ps1` checks `mod\lib` holds exactly that build,
because RUGR Setup carries it.

**3. The mod.**

```bat
cd mod
dotnet build PumpV.csproj -c Release -p:GTAPath="C:\Games\GTAV"
```

`GTAPath` copies `PumpV.dll` (and `PumpV.ini`, if you don't have one yet) into `scripts\`.

**4. The phone window.**

```bat
cd mod\phone
dotnet build PumpPhone.csproj -c Release
```

From `bin\Release\net48\`, copy these into a new `GTA V\PumpPhone\` folder: `PumpPhone.exe`,
`PumpPhone.exe.config`, `phone.html`, the `art` folder, `Microsoft.Web.WebView2.Core.dll`,
`Microsoft.Web.WebView2.WinForms.dll` and `WebView2Loader.dll`. Keep them out of `scripts\`,
because ScriptHookVDotNet tries to load every DLL under it.

**5. The companion.**

```bat
cd companion
npm install
npm run package
```

Copy `dist-exe\pumpv-companion.exe` into `GTA V\scripts\PumpV\`. Windows may be suspicious
of it, because it's unsigned.

## Testing without the game

The phone simulator runs the same page in a browser, against the real app code, so you can
use every screen without GTA V:

```bat
cd companion
npm install
npm run sim
```

Then open <http://127.0.0.1:47616>.

| Command | Data | Wallet |
|---|---|---|
| `npm run sim` | Live coins from your RPC | A throwaway one with 0 SOL, so buys stop at "Not enough SOL". Always Practice |
| `npm run sim -- --fake` | Made-up coins, no network | A fake one with 2 SOL. Every buy, sell and launch completes as a simulation |
| `npm run sim -- --fake --first-run` | The same | Starts from **Create wallet**. Kept in memory only |
| `npm run sim -- --fake --locked` | The same | Starts from **Unlock wallet**. The password is shown on the page |
| `npm run sim -- --attach` | Your running companion (`pumpv start`) | **Your real wallet.** It follows your Practice or Real money setting, so check the buttons say SIMULATE |

The simulator can't test what only the game can: the phone's keys, the game's on-screen
keyboard, the camera, and capturing the photo. Copy buttons do nothing in it.

## Development

```bash
cd companion && npm install && npm test
cd mod && dotnet build PumpV.csproj -c Release -p:IFruitJailbreakPath=/path/to/iFruit\ Jailbreak.dll
cd mod/phone && dotnet build PumpPhone.csproj -c Release

# Contract test: the C# UI model parses real companion responses. The key test only runs on Windows.
node companion/dist/test/fixtures.js /tmp/fx
csc -r:System.Web.Extensions.dll -out:contract.exe mod/src/UiModel.cs mod/src/ThemeLayout.cs mod/src/KeyText.cs mod/tests/UiContractTest.cs
contract.exe /tmp/fx

# Draw the fallback layout to an image, to look at without the game
csc -r:System.Web.Extensions.dll -r:System.Drawing.dll -out:preview.exe mod/src/UiModel.cs mod/src/ThemeLayout.cs mod/tests/ThemePreview.cs
preview.exe /tmp/fx preview.png

# Draw a screen in the phone window to an image: send one {"type":"view",...} line on stdin
PumpPhone.exe --capture out.png --images "folder with coin photos"
```

Screens are built in `companion/src/ui.ts` and, for the wallet, `companion/src/gate.ts`, so most
changes only touch TypeScript. Each row has `text`, which is all the phone's plain list shows, and
a `style`, which `companion/tools/phone-sim.html` and the fallback in `mod/src/ThemeLayout.cs` draw
from. That page is both the simulator and the phone in the game. As a simulator, it also repeats
the mod's navigation rules from `mod/src/PumpVScript.cs` and `PhoneNav`, so a change to those
belongs there too.

While the game runs, a new `PumpV.dll` can be copied over the old one and loaded with
ScriptHookVDotNet's reload key (`ReloadKeyBinding`, Insert by default), with no restart.

`companion/tools/art/` holds the phone's art. `make-art.cs` cuts the icon, logo and wordmark out of
`brand/rugr-logo.png` and shrinks the generated images for the phone.

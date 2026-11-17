# RUGR Setup

The one file players download: `RUGR-Setup-<version>.exe`. One click puts RUGR and everything it needs in the game
folder: Script Hook V, ScriptHookVDotNet, iFruit Jailbreak, Microsoft's runtimes when they're missing, and borderless
mode. Running it again updates RUGR or takes it out.

It's a .NET Framework 4.8 program (part of Windows 10 and 11) with no frame of its own: every screen is drawn in
RUGR's colours by `src/View.cs`. It runs as the player, and only asks Windows for permission when the game is under
Program Files. Then it starts itself again with permission and carries on where it was.

## What it does

1. **Finds the game** (`src/Games.cs`) through Steam's libraries, the key Rockstar fills in for Steam, Epic and its own
   launcher, Epic's manifests, and the usual folders. It picks the copy RUGR is in, or the one it last installed into
   (`%LOCALAPPDATA%\RUGR Setup\game-folder.txt`). **Change** lets the player pick another, or point it at `GTA5.exe` or
   `GTA5_Enhanced.exe`.
2. **Works out what's missing** (`src/Deps.cs`) and shows it on the first screen, next to the one **Install** button.
   Anything the game already has is left as it is:
   - **Script Hook V**: `ScriptHookV.dll` and the edition's ASI loader (`dinput8.dll` for Legacy, `xinput1_4.dll` for
     Enhanced). Its file version names the game builds it supports (3889.0.1158.13 is Legacy 1.0.3889.0 and Enhanced
     1.0.1158.13), so a game that has updated past it gets the new one.
   - **ScriptHookVDotNet**: `ScriptHookVDotNet.asi` and `ScriptHookVDotNet3.dll`, 3.6 or newer, and the Enhanced build
     on GTA V Enhanced.
   - **iFruit Jailbreak**: `scripts\iFruit Jailbreak.dll`, with `RegisterApp` in it, the call RUGR uses to put its app
     on the phone.
   - **Visual C++ runtime** (14.30 or newer, which ScriptHookVDotNet runs on) and **WebView2** (RUGR's phone window).
     Most PCs have both, and then they don't appear at all.
   - **Borderless mode**, read from the game's `settings.xml` in Documents.
3. **Installs** (`src/Install.cs`), top to bottom, each part a row with its own tick:
   - **Visual C++ runtime** and **WebView2** from Microsoft's own links, run only if Windows says Microsoft signed them.
     The runtime is a must; WebView2 isn't, so if it fails RUGR uses the game's own phone screen.
   - **Script Hook V** from its page on dev-c.com: Setup reads the page for the current zip and downloads it with the
     page as referrer, as a browser does when you click the link. It puts in `ScriptHookV.dll`, an ASI loader where
     there isn't one already, and Script Hook V's `args.txt` (which starts the game without BattlEye), merged into the
     player's own. `NativeTrainer.asi` stays out.
   - **ScriptHookVDotNet Enhanced**, the latest release from GitHub (or v1.1.0.6 if GitHub's API is busy). The
     player's own `ScriptHookVDotNet.ini` stays.
   - **iFruit Jailbreak 6.0**, carried inside the exe (`deps/` in the zip), checked against its SHA-256.
   - **RUGR**: `scripts\PumpV.dll`, `scripts\PumpV.ini` (only if the player hasn't got one, so their settings stay),
     `scripts\PumpV\pumpv-companion.exe` and the `PumpPhone` folder, each checked against the SHA-256 in `release.json`.
   - **Borderless mode**: a fullscreen game is switched to borderless in `settings.xml`, byte for byte, with a
     `settings.xml.rugr-backup` beside it.

   Every file is written beside its target first and then swapped in. GTA V has to be closed; RUGR's own programs are
   stopped first. It writes `scripts\PumpV\install.json` with RUGR's version, RUGR's files, and the other mods it put
   in. If something can't be done (no internet, say), it stops on that row and offers the maker's page.
4. **Removes** only RUGR's files: the ones in `install.json`, plus everything RUGR has ever put there. The wallet in
   `%LOCALAPPDATA%\PumpV` is never touched. The other mods stay, because other mods may use them.

Script Hook V's readme forbids passing its archive on, so it's never in the exe: each player's Setup downloads it from
dev-c.com. ScriptHookVDotNet (zlib licence) also comes from its own releases, so it's always the latest. iFruit
Jailbreak has no licence file; Setup carries the author's own 6.0 build from gta5-mods.com, unchanged and credited, and
`build-release.ps1` refuses any other build.

## Building a release

```powershell
powershell -ExecutionPolicy Bypass -File installer\build-release.ps1
```

It copies `mod` and `companion` to `%TEMP%\rugr-release` (outside any cloud-synced folder), builds `PumpV.dll`, `PumpPhone` and
`pumpv-companion.exe`, zips them with `release.json`, and builds `installer\dist\RUGR-Setup-<version>.exe` with a
`.sha256` beside it. The version comes from `companion\package.json`. `-Companion <exe>` reuses a companion already
built from the same source. It needs `mod\lib\iFruit Jailbreak.dll`, the official 6.0 from gta5-mods.com: RUGR
compiles against it, and Setup carries it (see `mod\lib\README.md`).

Then, for the site:

1. Publish the exe and its `.sha256` on GitHub Releases, and set `download` in `landing/js/site-config.js` (url,
   version, size, SHA-256).
2. Redraw the screens on the download page: `RUGR-Setup-<version>.exe --capture <folder> --scale 2` draws every screen
   with sample data as PNG files, by the same code as the real window. `landing/assets/install/` has them as WebP, at
   1800 and 900 px wide.

`tools/make-icon.cjs` makes `assets/rugr.ico` from RUGR's logo. A build without the zip (plain `dotnet build`) can only
draw its screens.

## Testing

The one-click install is tested on a throwaway game folder made of hard links to a real game's files (so version
detection is real) with no mods in it. Opened from Downloads like a player, one click on **Install** downloads Script
Hook V and ScriptHookVDotNet, puts in iFruit Jailbreak and RUGR, and leaves the real game folder and `settings.xml`
exactly as they were, in about 10 seconds. Opening Setup again shows every part as already in. `--folder` and
`--then install|remove` are what Setup passes itself when Windows' permission is needed.

## Not done yet

- **Signing.** The exe isn't signed, so Windows SmartScreen warns about it ("Windows protected your PC") until it's
  signed with a code-signing certificate and has built up a reputation. The download page tells players about the
  warning and gives the SHA-256.
- **Add or remove programs.** RUGR doesn't appear there; running RUGR Setup again is how to remove it.

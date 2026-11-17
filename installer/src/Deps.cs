using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace RugrSetup
{
    enum PartState { Waiting, Working, Done, Warning, Failed }

    /// <summary>One thing the install does, shown as a row: a mod RUGR needs, a runtime, RUGR itself.</summary>
    sealed class Part
    {
        public string Key, Name, Credit;
        /// <summary>The game already has it.</summary>
        public bool Have;
        /// <summary>Setup will install or change it.</summary>
        public bool Needed;
        /// <summary>What Setup will do, on the first screen: "Will install", "Already in".</summary>
        public string Plan = "";
        public PartState State;
        public string Detail = "";
    }

    /// <summary>Something Setup couldn't do, and where the player can do it by hand.</summary>
    sealed class SetupError : Exception
    {
        public readonly string Url, Link;

        public SetupError(string message, string url = null, string link = null) : base(message)
        {
            Url = url;
            Link = link;
        }
    }

    /// <summary>
    /// The mods and runtimes RUGR needs, and how Setup gets each one. Script Hook V comes from its author's site,
    /// because its licence doesn't allow passing the archive on. ScriptHookVDotNet comes from its GitHub releases,
    /// iFruit Jailbreak from inside this setup, and Microsoft's runtimes from Microsoft. Nothing is downloaded when
    /// the game already has it.
    /// </summary>
    static class Deps
    {
        public const string HookPage = "https://www.dev-c.com/gtav/scripthookv/";
        const string HookSite = "https://www.dev-c.com";
        public const string DotNetPage = "https://github.com/Chiheb-Bacha/ScriptHookVDotNetEnhanced/releases/latest";
        const string DotNetLatest = "https://api.github.com/repos/Chiheb-Bacha/ScriptHookVDotNetEnhanced/releases/latest";
        const string DotNetDownloads = "https://github.com/Chiheb-Bacha/ScriptHookVDotNetEnhanced/releases/download/";
        /// <summary>The release this setup was tested with, for when GitHub's API is busy.</summary>
        const string DotNetTested = DotNetDownloads + "v1.1.0.6/ScriptHookVDotNetEnhanced-v1.1.0.6.zip";
        public const string IFruitPage = "https://www.gta5-mods.com/tools/ifruit-jailbreak-sending-sms-and-emails";
        public const string VcRuntimeUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe";
        const string WebViewSetupUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";

        public static string UserAgent = "RUGR-Setup";

        /// <summary>Script Hook V's ASI loaders: dinput8.dll loads plugins in Legacy, xinput1_4.dll in Enhanced.</summary>
        static readonly string[] Loaders = { "dinput8.dll", "xinput1_4.dll" };
        static readonly string[] DotNetFiles = { "ScriptHookVDotNet.asi", "ScriptHookVDotNet2.dll", "ScriptHookVDotNet3.dll", "MinHook.x64.dll" };
        const string DotNetSettings = "ScriptHookVDotNet.ini";
        public const string IFruitFile = @"scripts\iFruit Jailbreak.dll";

        // ---- what this copy of the game already has ----

        public static List<Part> Plan(GameCopy game)
        {
            var parts = new List<Part>();
            if (!VcRuntimeInstalled())
                parts.Add(new Part { Key = "vc", Name = "Visual C++ runtime", Credit = "from Microsoft", Needed = true, Plan = "Will install" });
            if (WebViewVersion() == null)
                parts.Add(new Part { Key = "webview", Name = "WebView2", Credit = "from Microsoft", Needed = true, Plan = "Will install" });
            parts.Add(Hook(game));
            parts.Add(DotNet(game));
            parts.Add(IFruit(game));
            parts.Add(new Part
            {
                Key = "rugr", Name = "RUGR", Credit = "by GTAMOD", Needed = true,
                Plan = game.RugrVersion != null ? "Will update" : "Will install",
            });
            parts.Add(Display(game));
            return parts;
        }

        static Part Hook(GameCopy game)
        {
            var p = new Part { Key = "hook", Name = "Script Hook V", Credit = "by Alexander Blade" };
            string dll = Path.Combine(game.Folder, "ScriptHookV.dll");
            bool has = File.Exists(dll);
            bool current = has && Supports(Games.FileVersion(dll), game);
            bool loader = File.Exists(Path.Combine(game.Folder, game.Enhanced ? "xinput1_4.dll" : "dinput8.dll"));
            return Mark(p, current && loader, has);
        }

        static Part DotNet(GameCopy game)
        {
            var p = new Part { Key = "dotnet", Name = "ScriptHookVDotNet", Credit = "by crosire, kagikn & Chiheb-Bacha" };
            string asi = Path.Combine(game.Folder, "ScriptHookVDotNet.asi"), v3 = Path.Combine(game.Folder, "ScriptHookVDotNet3.dll");
            bool has = File.Exists(asi) && File.Exists(v3);
            bool ok = has;
            if (has)
            {
                // RUGR needs a recent version 3. Enhanced needs the Enhanced build, which says so in its name.
                Version v = Games.FileVersion(v3);
                if (v != null && v < new Version(3, 6)) ok = false;
                if (game.Enhanced && (Product(asi) ?? "").IndexOf("Enhanced", StringComparison.OrdinalIgnoreCase) < 0) ok = false;
            }
            return Mark(p, ok, has);
        }

        static Part IFruit(GameCopy game)
        {
            var p = new Part { Key = "ifruit", Name = "iFruit Jailbreak", Credit = "by andre500" };
            string dll = Path.Combine(game.Folder, IFruitFile);
            bool has = File.Exists(dll);
            // RUGR adds its app with RegisterApp, which arrived in 5.0.
            return Mark(p, has && Contains(dll, "RegisterApp"), has);
        }

        static Part Display(GameCopy game)
        {
            var p = new Part { Key = "display", Name = "Borderless mode", Credit = "so RUGR's phone can sit over the game" };
            switch (WindowMode(game))
            {
                case 2:
                    p.Have = true;
                    p.Plan = "Already on";
                    break;
                case 1:
                    p.Have = true;
                    p.Plan = "Windowed, fine";
                    break;
                case 0:
                    p.Needed = true;
                    p.Plan = "Will turn on";
                    break;
                default:
                    // The game hasn't saved its settings yet, so there's nothing to change.
                    p.Plan = "Set it in the game";
                    break;
            }
            return p;
        }

        static Part Mark(Part p, bool ok, bool has)
        {
            p.Have = ok;
            p.Needed = !ok;
            p.Plan = ok ? "Already in" : has ? "Will update" : "Will install";
            return p;
        }

        /// <summary>Script Hook V's version names the builds it supports: 3889.0.1158.13 is Legacy 1.0.3889.0 and Enhanced 1.0.1158.13.</summary>
        public static bool Supports(Version hook, GameCopy game)
        {
            Version mine = game.Version;
            if (hook == null || mine == null) return true;
            return game.Enhanced
                ? !(mine.Build > hook.Build || mine.Build == hook.Build && mine.Revision > hook.Revision)
                : mine.Build <= hook.Major;
        }

        public static string HookName(Version hook) => hook == null ? "" : $"{hook.Major}.{Math.Max(0, hook.Minor)}";

        /// <summary>The game's screen type: 0 fullscreen, 1 windowed, 2 borderless, -1 when it hasn't saved its settings.</summary>
        static int WindowMode(GameCopy game)
        {
            foreach (string settings in SettingsFiles(game))
            {
                try
                {
                    Match m = Regex.Match(File.ReadAllText(settings), "<Windowed\\s+value=\"(\\d)\"");
                    if (m.Success) return m.Groups[1].Value == "2" ? 2 : m.Groups[1].Value == "1" ? 1 : 0;
                }
                catch (Exception)
                {
                    // Try the next one.
                }
            }
            return -1;
        }

        static IEnumerable<string> SettingsFiles(GameCopy game)
        {
            string documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            string[] folders = game.Enhanced ? new[] { "GTAV Enhanced", "GTA V Enhanced", "GTA V" } : new[] { "GTA V" };
            foreach (string folder in folders)
            {
                string settings = Path.Combine(documents, "Rockstar Games", folder, "settings.xml");
                if (File.Exists(settings)) yield return settings;
            }
        }

        public static bool VcRuntimeInstalled()
        {
            try
            {
                using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = machine.OpenSubKey(@"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64"))
                {
                    if (key != null && Convert.ToInt32(key.GetValue("Installed", 0)) == 1
                        && Convert.ToInt32(key.GetValue("Major", 0)) == 14 && Convert.ToInt32(key.GetValue("Minor", 0)) >= 30) return true;
                }
            }
            catch (Exception)
            {
                // Fall back to the file itself.
            }
            Version v = Games.FileVersion(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "vcruntime140.dll"));
            return v != null && v >= new Version(14, 30);
        }

        public static string WebViewVersion()
        {
            const string client = @"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
            var places = new (RegistryKey, string)[]
            {
                (Registry.LocalMachine, @"SOFTWARE\WOW6432Node\" + client),
                (Registry.LocalMachine, @"SOFTWARE\" + client),
                (Registry.CurrentUser, @"Software\" + client),
            };
            foreach (var (hive, path) in places)
            {
                try
                {
                    using (RegistryKey key = hive.OpenSubKey(path))
                        if (key?.GetValue("pv") is string pv && pv.Length > 0 && pv != "0.0.0.0") return pv;
                }
                catch (Exception)
                {
                    // Try the next place.
                }
            }
            return null;
        }

        // ---- getting and installing each one ----

        /// <summary>Downloads Script Hook V's current zip from its page, the way a browser does when you click the link there.</summary>
        public static string FetchHook(string temp, Action<float, string> progress)
        {
            const string where = "Script Hook V from dev-c.com";
            progress(0.05f, "Finding the latest Script Hook V on dev-c.com");
            string page;
            try { page = GetText(HookPage); }
            catch (WebException ex) { throw Offline(where, HookPage, "Open dev-c.com", ex); }
            Match m = Regex.Match(page, "href=\"(/files/ScriptHookV_\\d[^\"]*\\.zip)\"", RegexOptions.IgnoreCase);
            if (!m.Success)
                throw new SetupError("Couldn't find Script Hook V's download on dev-c.com. Get it there, copy the files from its bin folder into your GTA V folder, then press Try again.",
                    HookPage, "Open dev-c.com");

            string zip = Path.Combine(temp, "ScriptHookV.zip");
            try { Download(HookSite + m.Groups[1].Value, HookPage, zip, f => progress(0.1f + 0.85f * f, "Downloading " + where)); }
            catch (WebException ex) { throw Offline(where, HookPage, "Open dev-c.com", ex); }
            if (!IsZip(zip))
                throw new SetupError("dev-c.com didn't send Script Hook V. Try again in a minute, or get it there yourself.", HookPage, "Open dev-c.com");
            return zip;
        }

        /// <summary>Puts Script Hook V in: its runtime, an ASI loader where there isn't one, and args.txt. Returns its version.</summary>
        public static Version InstallHook(GameCopy game, string zipPath, List<string> written)
        {
            using (var zip = new ZipArchive(File.OpenRead(zipPath), ZipArchiveMode.Read))
            {
                byte[] hook = Read(zip, "bin/", "ScriptHookV.dll")
                    ?? throw new SetupError("Script Hook V's download had no ScriptHookV.dll in it. Try again in a minute.", HookPage, "Open dev-c.com");
                Put(game.Folder, "ScriptHookV.dll", hook, written);
                // A loader already there stays, so another mod's own ASI loader keeps working.
                foreach (string loader in Loaders)
                    if (!File.Exists(Path.Combine(game.Folder, loader)) && Read(zip, "bin/", loader) is byte[] data)
                        Put(game.Folder, loader, data, written);
                // Script Hook V's own way of starting the game without BattlEye, which would stop every mod.
                Args(game.Folder, Read(zip, "bin/", "args.txt"), written);
            }
            return Games.FileVersion(Path.Combine(game.Folder, "ScriptHookV.dll"));
        }

        static void Args(string folder, byte[] shipped, List<string> written)
        {
            string[] wanted = shipped != null
                ? Encoding.ASCII.GetString(shipped).Split((char[])null, StringSplitOptions.RemoveEmptyEntries)
                : new[] { "-nobattleye", "-noBE" };
            string path = Path.Combine(folder, "args.txt");
            string current = File.Exists(path) ? File.ReadAllText(path) : "";
            var have = new HashSet<string>(current.Split((char[])null, StringSplitOptions.RemoveEmptyEntries), StringComparer.OrdinalIgnoreCase);
            string[] missing = wanted.Where(a => !have.Contains(a)).ToArray();
            if (missing.Length == 0) return;
            Put(folder, "args.txt", Encoding.ASCII.GetBytes((current.TrimEnd() + " " + string.Join(" ", missing)).Trim()), written);
        }

        /// <summary>Downloads the latest ScriptHookVDotNet Enhanced release. Returns the zip and its version.</summary>
        public static (string zip, string version) FetchDotNet(string temp, Action<float, string> progress)
        {
            const string where = "ScriptHookVDotNet from GitHub";
            progress(0.05f, "Finding the latest ScriptHookVDotNet on GitHub");
            string url = DotNetTested;
            try
            {
                var release = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(GetText(DotNetLatest, accept: "application/vnd.github+json"));
                if (release.TryGetValue("assets", out object assets) && assets is IEnumerable list)
                {
                    foreach (object item in list)
                    {
                        if (item is IDictionary<string, object> asset
                            && asset.TryGetValue("name", out object n) && n is string name
                            && name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)
                            && name.IndexOf("ScriptHookVDotNet", StringComparison.OrdinalIgnoreCase) >= 0
                            && asset.TryGetValue("browser_download_url", out object u) && u is string link
                            && link.StartsWith(DotNetDownloads, StringComparison.OrdinalIgnoreCase))
                        {
                            url = link;
                            break;
                        }
                    }
                }
            }
            catch (Exception)
            {
                // GitHub's API allows so many calls an hour: the release this setup was tested with will do.
            }

            string zip = Path.Combine(temp, "ScriptHookVDotNet.zip");
            try { Download(url, null, zip, f => progress(0.1f + 0.85f * f, "Downloading " + where)); }
            catch (WebException ex) { throw Offline(where, DotNetPage, "Open its GitHub page", ex); }
            if (!IsZip(zip))
                throw new SetupError("GitHub didn't send ScriptHookVDotNet. Try again in a minute.", DotNetPage, "Open its GitHub page");
            Match v = Regex.Match(url, @"/download/v?([^/]+)/");
            return (zip, v.Success ? v.Groups[1].Value : "");
        }

        public static void InstallDotNet(GameCopy game, string zipPath, List<string> written)
        {
            using (var zip = new ZipArchive(File.OpenRead(zipPath), ZipArchiveMode.Read))
            {
                var files = new Dictionary<string, byte[]>();
                foreach (string name in DotNetFiles)
                {
                    byte[] data = Read(zip, "", name);
                    // MinHook comes with the Enhanced build only; the others are a must.
                    if (data == null && name != "MinHook.x64.dll")
                        throw new SetupError($"ScriptHookVDotNet's download had no {name} in it. Try again in a minute.", DotNetPage, "Open its GitHub page");
                    if (data != null) files[name] = data;
                }
                foreach (var f in files) Put(game.Folder, f.Key, f.Value, written);
                // The player's own settings stay.
                if (!File.Exists(Path.Combine(game.Folder, DotNetSettings)) && Read(zip, "", DotNetSettings) is byte[] ini)
                    Put(game.Folder, DotNetSettings, ini, written);
            }
        }

        public static void InstallIFruit(GameCopy game, Payload payload, List<string> written)
        {
            PayloadFile f = payload.IFruit ?? throw new InvalidDataException("This setup is missing iFruit Jailbreak. Download RUGR Setup again.");
            using (Stream s = Payload.Open())
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                ZipArchiveEntry entry = zip.GetEntry(f.Path) ?? throw new InvalidDataException("This setup is damaged. Download RUGR Setup again.");
                byte[] data;
                using (Stream from = entry.Open())
                using (var to = new MemoryStream())
                {
                    from.CopyTo(to);
                    data = to.ToArray();
                }
                if (!string.Equals(Install.Sha256(data), f.Sha256, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("iFruit Jailbreak didn't unpack correctly. Download RUGR Setup again.");
                Put(game.Folder, IFruitFile, data, written);
            }
        }

        /// <summary>Installs Microsoft's Visual C++ runtime, which ScriptHookVDotNet runs on. True when Windows needs a restart.</summary>
        public static bool InstallVcRuntime(string temp, Action<float, string> progress)
        {
            const string name = "Microsoft's Visual C++ runtime";
            string exe = Path.Combine(temp, "vc_redist.x64.exe");
            try { Download(VcRuntimeUrl, null, exe, f => progress(0.6f * f, "Downloading " + name)); }
            catch (WebException ex) { throw Offline(name, VcRuntimeUrl, "Download it from Microsoft", ex); }
            if (!SignedByMicrosoft(exe))
                throw new SetupError($"The download of {name} wasn't signed by Microsoft, so it wasn't run. Try again.", VcRuntimeUrl, "Download it from Microsoft");

            progress(0.65f, $"Installing {name}. Choose Yes if Windows asks.");
            int code;
            try { code = Run(exe, "/install /quiet /norestart"); }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 1223) { code = 1602; }
            switch (code)
            {
                case 0:
                case 1638:   // a newer one is already in
                    return false;
                case 3010:
                case 1641:
                    return true;
                case 1602:
                    throw new SetupError($"ScriptHookVDotNet needs {name}. Press Try again and choose Yes when Windows asks.");
                case 1618:
                    throw new SetupError($"Another install is running, so {name} had to wait. Let it finish, then press Try again.");
                default:
                    throw new SetupError($"{name} didn't install (code {code}). Install it from Microsoft, then press Try again.", VcRuntimeUrl, "Download it from Microsoft");
            }
        }

        /// <summary>Installs WebView2, which draws RUGR's phone over the game. RUGR still works without it, so this never stops the install.</summary>
        public static bool InstallWebView(string temp, Action<float, string> progress)
        {
            try
            {
                string exe = Path.Combine(temp, "MicrosoftEdgeWebview2Setup.exe");
                Download(WebViewSetupUrl, null, exe, f => progress(0.3f * f, "Downloading WebView2 from Microsoft"));
                if (!SignedByMicrosoft(exe)) return false;
                progress(0.35f, "Installing WebView2 from Microsoft");
                return Run(exe, "/silent /install") == 0 || WebViewVersion() != null;
            }
            catch (Exception)
            {
                return WebViewVersion() != null;
            }
        }

        /// <summary>Turns the game's screen type from fullscreen to borderless. Returns the mode it's in afterwards, as <see cref="WindowMode"/>.</summary>
        public static int SetBorderless(GameCopy game)
        {
            int mode = WindowMode(game);
            if (mode != 0) return mode;
            foreach (string settings in SettingsFiles(game))
            {
                // Byte for byte, so the rest of the file stays exactly as the game wrote it.
                byte[] data = File.ReadAllBytes(settings);
                Match m = Regex.Match(Encoding.GetEncoding(28591).GetString(data), "<Windowed\\s+value=\"(0)\"");
                if (!m.Success) continue;
                string backup = settings + ".rugr-backup";
                if (!File.Exists(backup)) File.Copy(settings, backup);
                data[m.Groups[1].Index] = (byte)'2';
                string temp = settings + ".rugr-new";
                File.WriteAllBytes(temp, data);
                Install.Replace(temp, settings);
            }
            return WindowMode(game);
        }

        // ---- helpers ----

        static HttpWebRequest Request(string url, string referer)
        {
            var r = (HttpWebRequest)WebRequest.Create(url);
            r.UserAgent = UserAgent;
            if (referer != null) r.Referer = referer;
            r.Timeout = 30000;
            r.ReadWriteTimeout = 30000;
            r.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            return r;
        }

        static string GetText(string url, string referer = null, string accept = null)
        {
            HttpWebRequest r = Request(url, referer);
            if (accept != null) r.Accept = accept;
            using (var response = (HttpWebResponse)r.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return reader.ReadToEnd();
        }

        static void Download(string url, string referer, string path, Action<float> progress)
        {
            HttpWebRequest r = Request(url, referer);
            using (var response = (HttpWebResponse)r.GetResponse())
            using (Stream from = response.GetResponseStream())
            using (FileStream to = File.Create(path))
            {
                long total = response.ContentLength, done = 0, reported = 0;
                var buffer = new byte[1 << 16];
                int n;
                while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
                {
                    to.Write(buffer, 0, n);
                    done += n;
                    if (total > 0 && done - reported > 200_000)
                    {
                        reported = done;
                        progress(Math.Min(1f, (float)done / total));
                    }
                }
                progress(1f);
            }
        }

        static SetupError Offline(string what, string url, string link, WebException ex)
        {
            string why = ex.Response is HttpWebResponse r ? $"the site answered {(int)r.StatusCode}" : "check your internet connection";
            return new SetupError($"Couldn't download {what} ({why}). Press Try again, or get it there yourself.", url, link);
        }

        static bool IsZip(string path)
        {
            try
            {
                using (FileStream s = File.OpenRead(path))
                    return s.Length > 4 && s.ReadByte() == 'P' && s.ReadByte() == 'K';
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>A file from a zip: folder + name first, then that name anywhere but the debug and docs folders.</summary>
        static byte[] Read(ZipArchive zip, string folder, string name)
        {
            ZipArchiveEntry entry = zip.Entries.FirstOrDefault(e => string.Equals(e.FullName, folder + name, StringComparison.OrdinalIgnoreCase))
                ?? zip.Entries.FirstOrDefault(e => string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)
                    && e.FullName.IndexOf("debug/", StringComparison.OrdinalIgnoreCase) < 0
                    && e.FullName.IndexOf("docs/", StringComparison.OrdinalIgnoreCase) < 0);
            if (entry == null) return null;
            using (Stream from = entry.Open())
            using (var to = new MemoryStream())
            {
                from.CopyTo(to);
                return to.ToArray();
            }
        }

        /// <summary>Writes a file in the game folder through a temporary copy, so a half-written file never replaces a good one.</summary>
        static void Put(string folder, string name, byte[] data, List<string> written)
        {
            string target = Path.Combine(folder, name);
            Directory.CreateDirectory(Path.GetDirectoryName(target));
            string temp = target + ".rugr-new";
            File.WriteAllBytes(temp, data);
            Install.Replace(temp, target);
            if (!written.Contains(name, StringComparer.OrdinalIgnoreCase)) written.Add(name);
        }

        static int Run(string exe, string arguments)
        {
            // Through the shell, so an installer that needs Windows' permission can ask for it.
            using (Process p = Process.Start(new ProcessStartInfo(exe, arguments) { UseShellExecute = true }))
            {
                if (!p.WaitForExit(15 * 60_000)) throw new SetupError("An installer from Microsoft didn't finish. Restart Windows, then try again.");
                return p.ExitCode;
            }
        }

        static string Product(string file)
        {
            try { return FileVersionInfo.GetVersionInfo(file).ProductName; }
            catch (Exception) { return null; }
        }

        public static bool Contains(string file, string text)
        {
            byte[] data, needle = Encoding.ASCII.GetBytes(text);
            try { data = File.ReadAllBytes(file); }
            catch (Exception) { return false; }
            for (int i = 0; i + needle.Length <= data.Length; i++)
            {
                int j = 0;
                while (j < needle.Length && data[i + j] == needle[j]) j++;
                if (j == needle.Length) return true;
            }
            return false;
        }

        /// <summary>Windows says the file's signature is good, and Microsoft signed it.</summary>
        static bool SignedByMicrosoft(string path)
        {
            try
            {
                var file = new WinTrustFileInfo { StructSize = (uint)Marshal.SizeOf(typeof(WinTrustFileInfo)), FilePath = path };
                IntPtr filePtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WinTrustFileInfo)));
                try
                {
                    Marshal.StructureToPtr(file, filePtr, false);
                    var data = new WinTrustData
                    {
                        StructSize = (uint)Marshal.SizeOf(typeof(WinTrustData)),
                        UIChoice = 2,            // WTD_UI_NONE
                        RevocationChecks = 0,    // WTD_REVOKE_NONE
                        UnionChoice = 1,         // WTD_CHOICE_FILE
                        FileInfo = filePtr,
                        StateAction = 0,         // WTD_STATEACTION_IGNORE
                    };
                    var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");   // WINTRUST_ACTION_GENERIC_VERIFY_V2
                    if (WinVerifyTrust(IntPtr.Zero, action, ref data) != 0) return false;
                }
                finally
                {
                    Marshal.FreeHGlobal(filePtr);
                }
                string subject = new X509Certificate2(X509Certificate.CreateFromSignedFile(path)).Subject;
                return subject.IndexOf("O=Microsoft Corporation", StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WinTrustFileInfo
        {
            public uint StructSize;
            [MarshalAs(UnmanagedType.LPWStr)] public string FilePath;
            public IntPtr File;
            public IntPtr KnownSubject;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WinTrustData
        {
            public uint StructSize;
            public IntPtr PolicyCallbackData;
            public IntPtr SipClientData;
            public uint UIChoice;
            public uint RevocationChecks;
            public uint UnionChoice;
            public IntPtr FileInfo;
            public uint StateAction;
            public IntPtr StateData;
            [MarshalAs(UnmanagedType.LPWStr)] public string UrlReference;
            public uint ProvFlags;
            public uint UIContext;
            public IntPtr SignatureSettings;
        }

        [DllImport("wintrust.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
        static extern int WinVerifyTrust(IntPtr hwnd, [MarshalAs(UnmanagedType.LPStruct)] Guid action, ref WinTrustData data);
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

namespace RugrSetup
{
    /// <summary>How the install tells the window what it's doing. Called from the install's own thread.</summary>
    interface IReport
    {
        void Part(Part part, PartState state, string detail);
        void Progress(float progress, string text);
    }

    /// <summary>
    /// Puts RUGR and everything it needs into a GTA V folder, and takes RUGR out again. Removing only ever touches
    /// RUGR's own files there. The wallet lives in %LOCALAPPDATA%\PumpV and is never touched.
    /// </summary>
    static class Install
    {
        /// <summary>Written after every install: RUGR's version, the files it put there, and the mods Setup added.</summary>
        public const string Manifest = @"scripts\PumpV\install.json";

        /// <summary>What RUGR has ever put in the game folder, for copies installed before the manifest existed.</summary>
        static readonly string[] KnownFiles =
        {
            @"scripts\PumpV.dll", @"scripts\PumpV.ini", @"scripts\PumpV\pumpv-companion.exe", @"scripts\PumpV\logo.png", Manifest,
        };

        /// <summary>RUGR's phone window. The whole folder is RUGR's.</summary>
        const string PhoneFolder = "PumpPhone";

        static readonly string[] GameProcesses = { "GTA5", "GTA5_Enhanced", "GTA5_BE", "PlayGTAV" };
        static readonly string[] RugrProcesses = { "PumpPhone", "pumpv-companion" };

        /// <summary>How long each part takes, roughly, so the bar moves evenly.</summary>
        static readonly Dictionary<string, float> Weights = new Dictionary<string, float>
        {
            ["vc"] = 24, ["webview"] = 24, ["hook"] = 14, ["dotnet"] = 14, ["ifruit"] = 3, ["rugr"] = 30, ["display"] = 2,
        };

        /// <summary>The game folder needs Windows' permission to write to (it's under Program Files).</summary>
        public sealed class NeedsPermission : Exception
        {
        }

        public sealed class GameRunning : Exception
        {
            public GameRunning() : base("GTA V is still running. Close it, then press Try again.") { }
        }

        public static string InstalledVersion(string folder)
        {
            try
            {
                string manifest = Path.Combine(folder, Manifest);
                if (File.Exists(manifest))
                {
                    var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
                    if (d.TryGetValue("version", out object v) && v is string s) return s;
                }
                return File.Exists(Path.Combine(folder, @"scripts\PumpV.dll")) ? "" : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>Runs every part that's needed, top to bottom. Returns what the player should know afterwards.</summary>
        public static List<string> Run(GameCopy game, Payload payload, List<Part> parts, IReport report)
        {
            var notes = new List<string>();
            report.Progress(0.01f, "Closing RUGR if it's open");
            Prepare(game.Folder);

            List<Part> todo = parts.Where(p => p.Needed || p.Key == "display").ToList();
            float total = Math.Max(1, todo.Sum(p => Weights.TryGetValue(p.Key, out float w) ? w : 5)), done = 0;
            string temp = Path.Combine(Path.GetTempPath(), "RUGR-Setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(temp);
            var mods = new List<string>();
            List<string> rugrFiles = null;
            try
            {
                foreach (Part p in todo)
                {
                    float weight = Weights.TryGetValue(p.Key, out float w) ? w : 5;
                    float start = done;
                    void Step(float f, string text) => report.Progress(0.02f + 0.96f * (start + weight * Math.Max(0, Math.Min(1, f))) / total, text);

                    report.Part(p, PartState.Working, Working(p));
                    try
                    {
                        switch (p.Key)
                        {
                            case "vc":
                                if (Deps.InstallVcRuntime(temp, Step)) notes.Add("Restart Windows before you play, so Microsoft's Visual C++ runtime finishes installing.");
                                report.Part(p, PartState.Done, "Installed");
                                break;

                            case "webview":
                                if (Deps.InstallWebView(temp, Step))
                                {
                                    report.Part(p, PartState.Done, "Installed");
                                }
                                else
                                {
                                    report.Part(p, PartState.Warning, "Didn't install");
                                    notes.Add("WebView2 didn't install, so RUGR shows on the game's own phone screen. Get WebView2 from Microsoft and run this setup again for RUGR's full phone.");
                                }
                                break;

                            case "hook":
                            {
                                string zip = Deps.FetchHook(temp, (f, t) => Step(0.85f * f, t));
                                Step(0.9f, "Installing Script Hook V");
                                Version v = Deps.InstallHook(game, zip, mods);
                                if (Deps.Supports(v, game))
                                {
                                    report.Part(p, PartState.Done, "Installed " + Deps.HookName(v));
                                }
                                else
                                {
                                    report.Part(p, PartState.Warning, $"Installed {Deps.HookName(v)}, a step behind the game");
                                    notes.Add($"Script Hook V doesn't support GTA V {game.Version} yet, so mods won't load until it does. It's usually updated within days of a game update: run this setup again then.");
                                }
                                break;
                            }

                            case "dotnet":
                            {
                                var (zip, version) = Deps.FetchDotNet(temp, (f, t) => Step(0.85f * f, t));
                                Step(0.9f, "Installing ScriptHookVDotNet");
                                Deps.InstallDotNet(game, zip, mods);
                                report.Part(p, PartState.Done, version.Length > 0 ? "Installed " + version : "Installed");
                                break;
                            }

                            case "ifruit":
                                Step(0.3f, "Installing iFruit Jailbreak");
                                Deps.InstallIFruit(game, payload, mods);
                                report.Part(p, PartState.Done, "Installed " + payload.IFruitVersion);
                                break;

                            case "rugr":
                                rugrFiles = CopyRugr(game.Folder, payload, Step);
                                report.Part(p, PartState.Done, "Installed " + payload.Version);
                                break;

                            case "display":
                                int mode;
                                try { mode = Deps.SetBorderless(game); }
                                catch (Exception) { mode = 0; }
                                if (mode >= 1)
                                {
                                    report.Part(p, PartState.Done, p.Needed ? "Turned on" : mode == 2 ? "Already on" : "Windowed, fine");
                                }
                                else
                                {
                                    report.Part(p, PartState.Warning, "Set it in the game");
                                    notes.Add("In the game, set Settings > Graphics > Screen Type to Borderless, so RUGR's phone can sit over the game.");
                                }
                                break;
                        }
                    }
                    catch (Exception)
                    {
                        report.Part(p, PartState.Failed, "Stopped here");
                        throw;
                    }
                    done += weight;
                }
            }
            finally
            {
                try { Directory.Delete(temp, true); }
                catch (Exception) { /* Windows clears its temp folder itself */ }
            }

            report.Progress(0.99f, "Checking every file");
            WriteManifest(game.Folder, payload.Version, rugrFiles ?? new List<string>(), mods);
            if (notes.Count < 2)
                notes.Add("Mods are for story mode only. With Script Hook V in, GTA Online won't start; to play online, take its files and args.txt out of your game folder.");
            report.Progress(1f, "Done");
            return notes;
        }

        static string Working(Part p)
        {
            switch (p.Key)
            {
                case "vc":
                case "webview": return "Getting it from Microsoft";
                case "hook": return "Getting it from dev-c.com";
                case "dotnet": return "Getting it from GitHub";
                case "display": return "Checking the game's settings";
                default: return "Installing";
            }
        }

        /// <summary>Copies RUGR's own files, checking each one's SHA-256. Returns the files, from the game folder.</summary>
        static List<string> CopyRugr(string folder, Payload payload, Action<float, string> progress)
        {
            long total = Math.Max(1, payload.Files.Sum(f => f.Size)), done = 0;
            var written = new List<string>();
            using (Stream s = Payload.Open())
            using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
            {
                foreach (PayloadFile f in payload.Files)
                {
                    string name = f.Path.Replace('/', '\\');
                    string target = Path.Combine(folder, name);
                    progress(0.9f * done / total, name);
                    written.Add(name);
                    if (f.Keep && File.Exists(target))
                    {
                        done += f.Size;
                        continue;
                    }

                    ZipArchiveEntry entry = zip.GetEntry("files/" + f.Path)
                        ?? throw new InvalidDataException("This setup is damaged. Download RUGR Setup again.");
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    string temp = target + ".rugr-new";
                    using (Stream from = entry.Open())
                    using (FileStream to = File.Create(temp))
                    using (SHA256 sha = SHA256.Create())
                    {
                        var buffer = new byte[1 << 16];
                        long reported = done;
                        int n;
                        while ((n = from.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            to.Write(buffer, 0, n);
                            sha.TransformBlock(buffer, 0, n, null, 0);
                            done += n;
                            if (done - reported > 2_000_000)
                            {
                                reported = done;
                                progress(0.9f * done / total, name);
                            }
                        }
                        sha.TransformFinalBlock(new byte[0], 0, 0);
                        if (!string.Equals(Hex(sha.Hash), f.Sha256, StringComparison.OrdinalIgnoreCase))
                        {
                            to.Close();
                            File.Delete(temp);
                            throw new InvalidDataException($"{name} didn't unpack correctly. Download RUGR Setup again.");
                        }
                    }
                    Replace(temp, target);
                }
            }

            progress(0.95f, "Checking RUGR's files");
            foreach (PayloadFile f in payload.Files)
            {
                string target = Path.Combine(folder, f.Path.Replace('/', '\\'));
                if (!File.Exists(target)) throw new IOException($"{f.Path} is missing after installing. Try again.");
                if (!f.Keep && new FileInfo(target).Length != f.Size) throw new IOException($"{f.Path} didn't copy fully. Try again.");
            }

            // Files an older RUGR put there that this one no longer uses.
            foreach (string old in ManifestFiles(folder))
                if (!written.Contains(old, StringComparer.OrdinalIgnoreCase) && !old.Equals(Manifest, StringComparison.OrdinalIgnoreCase))
                    Delete(Path.Combine(folder, old));
            return written;
        }

        public static List<Part> RemoveParts() => new List<Part>
        {
            new Part { Key = "close", Name = "Close RUGR if it's open" },
            new Part { Key = "files", Name = "Take RUGR's files out" },
            new Part { Key = "tidy", Name = "Tidy up" },
        };

        public static void Remove(string folder, List<Part> parts, IReport report)
        {
            report.Part(parts[0], PartState.Working, "");
            report.Progress(0.02f, "Closing RUGR if it's open");
            Prepare(folder);
            report.Part(parts[0], PartState.Done, "");

            report.Part(parts[1], PartState.Working, "");
            var files = new HashSet<string>(ManifestFiles(folder), StringComparer.OrdinalIgnoreCase);
            foreach (string f in KnownFiles) files.Add(f);
            files.Remove(Manifest);
            int i = 0;
            foreach (string f in files)
            {
                report.Progress(0.1f + 0.6f * i++ / files.Count, f);
                Delete(Path.Combine(folder, f));
            }
            report.Progress(0.75f, PhoneFolder);
            string phone = Path.Combine(folder, PhoneFolder);
            if (Directory.Exists(phone)) Retry(() => Directory.Delete(phone, true));
            report.Part(parts[1], PartState.Done, "");

            report.Part(parts[2], PartState.Working, "");
            report.Progress(0.9f, "Tidying up");
            Delete(Path.Combine(folder, Manifest));
            string own = Path.Combine(folder, @"scripts\PumpV");
            if (Directory.Exists(own) && !Directory.EnumerateFileSystemEntries(own).Any()) Directory.Delete(own);
            report.Part(parts[2], PartState.Done, "");
            report.Progress(1f, "Done");
        }

        /// <summary>The game closed, RUGR's own programs stopped, and the folder writable.</summary>
        static void Prepare(string folder)
        {
            foreach (string name in GameProcesses)
                if (Process.GetProcessesByName(name).Length > 0) throw new GameRunning();

            foreach (string name in RugrProcesses)
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    try
                    {
                        p.Kill();
                        p.WaitForExit(4000);
                    }
                    catch (Exception)
                    {
                        // It closed by itself, or it's not ours to stop. Copying will say so if it's in the way.
                    }
                    finally
                    {
                        p.Dispose();
                    }
                }
            }

            string probe = Path.Combine(folder, ".rugr-write-test");
            try
            {
                File.WriteAllText(probe, "");
                File.Delete(probe);
            }
            catch (UnauthorizedAccessException)
            {
                throw new NeedsPermission();
            }
        }

        static List<string> ManifestFiles(string folder)
        {
            var list = new List<string>();
            try
            {
                string manifest = Path.Combine(folder, Manifest);
                if (!File.Exists(manifest)) return list;
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
                if (d.TryGetValue("files", out object files) && files is IEnumerable e)
                    foreach (object f in e)
                        if (f is string s && IsSafe(s)) list.Add(s.Replace('/', '\\'));
            }
            catch (Exception)
            {
                // A damaged manifest: fall back to the known files.
            }
            return list;
        }

        /// <summary>Only paths inside the game folder, so a bad manifest can't point anywhere else.</summary>
        static bool IsSafe(string path) =>
            path.Length > 0 && !Path.IsPathRooted(path) && !path.Split('\\', '/').Any(p => p == ".." || p == ".");

        /// <summary>
        /// "files" are RUGR's own and go when RUGR is removed. "mods" are the other mods Setup put in; they stay, because
        /// other mods may use them too.
        /// </summary>
        static void WriteManifest(string folder, string version, List<string> files, List<string> mods)
        {
            string path = Path.Combine(folder, Manifest);
            var d = new Dictionary<string, object>
            {
                ["product"] = "RUGR",
                ["version"] = version,
                ["installed"] = DateTime.UtcNow.ToString("o"),
                ["files"] = files,
                ["mods"] = mods.Union(OldMods(path), StringComparer.OrdinalIgnoreCase).ToList(),
            };
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            File.WriteAllText(path, new JavaScriptSerializer().Serialize(d));
        }

        static IEnumerable<string> OldMods(string manifest)
        {
            var list = new List<string>();
            try
            {
                if (!File.Exists(manifest)) return list;
                var d = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(manifest));
                if (d.TryGetValue("mods", out object mods) && mods is IEnumerable e)
                    foreach (object m in e)
                        if (m is string s && IsSafe(s)) list.Add(s);
            }
            catch (Exception)
            {
                // Nothing to keep.
            }
            return list;
        }

        public static void Replace(string temp, string target) => Retry(() =>
        {
            if (File.Exists(target))
            {
                File.SetAttributes(target, FileAttributes.Normal);
                File.Delete(target);
            }
            File.Move(temp, target);
        });

        static void Delete(string path)
        {
            if (!File.Exists(path)) return;
            Retry(() =>
            {
                File.SetAttributes(path, FileAttributes.Normal);
                File.Delete(path);
            });
        }

        /// <summary>A program that just closed can hold its file for a moment.</summary>
        static void Retry(Action action)
        {
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    action();
                    return;
                }
                catch (IOException) when (attempt < 12)
                {
                    Thread.Sleep(250);
                }
                catch (UnauthorizedAccessException) when (attempt < 4)
                {
                    Thread.Sleep(250);
                }
            }
        }

        public static string Sha256(byte[] data)
        {
            using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(data));
        }

        static string Hex(byte[] bytes) => BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }
}

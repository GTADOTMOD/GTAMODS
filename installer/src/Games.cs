using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace RugrSetup
{
    /// <summary>One copy of GTA V on this PC.</summary>
    sealed class GameCopy
    {
        public string Folder;
        /// <summary>Steam, Epic Games, Rockstar, or "Your folder" when the player picked it.</summary>
        public string Store;
        public bool Enhanced;
        /// <summary>The game exe's version, like 1.0.3889.0.</summary>
        public Version Version;
        /// <summary>RUGR's version in this copy: null when it isn't there, "" when it is but the version is unknown.</summary>
        public string RugrVersion;

        public string Edition => Enhanced ? "GTA V Enhanced" : "GTA V Legacy";
        public string Exe => Path.Combine(Folder, Enhanced ? "GTA5_Enhanced.exe" : "GTA5.exe");
    }

    /// <summary>Finds GTA V the way each launcher records it.</summary>
    static class Games
    {
        public static List<GameCopy> Find()
        {
            var found = new List<GameCopy>();
            void Try(string folder, string store)
            {
                GameCopy copy = Inspect(folder, store);
                if (copy != null && !found.Any(g => Same(g.Folder, copy.Folder))) found.Add(copy);
            }

            foreach (string library in SteamLibraries())
            {
                Try(Path.Combine(library, "steamapps", "common", "Grand Theft Auto V"), "Steam");
                Try(Path.Combine(library, "steamapps", "common", "Grand Theft Auto V Enhanced"), "Steam");
            }
            foreach (var (folder, store) in RockstarRegistry()) Try(folder, store);
            foreach (string folder in EpicManifests()) Try(folder, "Epic Games");

            string programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            Try(Path.Combine(programs, "Rockstar Games", "Grand Theft Auto V"), "Rockstar");
            Try(Path.Combine(programs, "Rockstar Games", "Grand Theft Auto V Enhanced"), "Rockstar");
            Try(Path.Combine(programs, "Epic Games", "GTAV"), "Epic Games");
            Try(Path.Combine(programs, "Epic Games", "GTAVEnhanced"), "Epic Games");
            return found;
        }

        /// <summary>The copy of GTA V in this folder (or the one above it), or null.</summary>
        public static GameCopy Inspect(string folder, string store)
        {
            if (string.IsNullOrWhiteSpace(folder)) return null;
            try
            {
                folder = Path.GetFullPath(folder.Trim().Trim('"')).TrimEnd('\\', '/');
                // Some launchers record the folder one level too deep.
                foreach (string dir in new[] { folder, Path.GetDirectoryName(folder) })
                {
                    if (string.IsNullOrEmpty(dir)) continue;
                    bool legacy = File.Exists(Path.Combine(dir, "GTA5.exe"));
                    bool enhanced = File.Exists(Path.Combine(dir, "GTA5_Enhanced.exe"));
                    if (!legacy && !enhanced) continue;
                    var copy = new GameCopy { Folder = dir.TrimEnd('\\'), Store = store, Enhanced = enhanced && !legacy };
                    copy.Version = FileVersion(copy.Exe);
                    copy.RugrVersion = Install.InstalledVersion(copy.Folder);
                    return copy;
                }
            }
            catch (Exception)
            {
                // A folder we can't read isn't one we can install into.
            }
            return null;
        }

        static string RememberFile =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RUGR Setup", "game-folder.txt");

        /// <summary>The copy Setup last installed into, so an update goes to the same one.</summary>
        public static string Remembered()
        {
            try
            {
                return File.Exists(RememberFile) ? File.ReadAllText(RememberFile).Trim() : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static void Remember(string folder)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(RememberFile));
                File.WriteAllText(RememberFile, folder);
            }
            catch (Exception)
            {
                // Only a convenience.
            }
        }

        /// <summary>Which launcher a folder belongs to, from its path, for a folder the player picked.</summary>
        public static string StoreFor(string folder)
        {
            string f = folder ?? "";
            if (f.IndexOf(@"\steamapps\", StringComparison.OrdinalIgnoreCase) >= 0) return "Steam";
            if (f.IndexOf(@"\Epic Games\", StringComparison.OrdinalIgnoreCase) >= 0) return "Epic Games";
            if (f.IndexOf(@"\Rockstar Games\", StringComparison.OrdinalIgnoreCase) >= 0) return "Rockstar";
            return "Your folder";
        }

        public static Version FileVersion(string file)
        {
            try
            {
                string text = FileVersionInfo.GetVersionInfo(file).FileVersion;
                if (text == null) return null;
                Match m = Regex.Match(text, @"\d+(\.\d+){1,3}");
                return m.Success && Version.TryParse(m.Value, out Version v) ? v : null;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static bool Same(string a, string b)
        {
            try
            {
                return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception)
            {
                return string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
            }
        }

        static IEnumerable<string> SteamLibraries()
        {
            string steam = Read(Registry.CurrentUser, @"Software\Valve\Steam", "SteamPath")
                ?? Read(Registry.LocalMachine, @"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath")
                ?? Read(Registry.LocalMachine, @"SOFTWARE\Valve\Steam", "InstallPath");
            var libraries = new List<string>();
            if (steam == null) return libraries;
            steam = steam.Replace('/', '\\');
            libraries.Add(steam);
            try
            {
                string vdf = File.ReadAllText(Path.Combine(steam, "steamapps", "libraryfolders.vdf"));
                foreach (Match m in Regex.Matches(vdf, "\"path\"\\s+\"([^\"]+)\""))
                    libraries.Add(m.Groups[1].Value.Replace(@"\\", @"\"));
            }
            catch (Exception)
            {
                // No other libraries, or Steam moved.
            }
            return libraries;
        }

        /// <summary>Rockstar's own key, which the Steam, Epic and Rockstar versions all fill in.</summary>
        static List<(string, string)> RockstarRegistry()
        {
            var list = new List<(string, string)>();
            foreach (RegistryView view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                try
                {
                    using (RegistryKey machine = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                    using (RegistryKey rockstar = machine.OpenSubKey(@"SOFTWARE\Rockstar Games"))
                    {
                        if (rockstar == null) continue;
                        foreach (string name in rockstar.GetSubKeyNames())
                        {
                            if (name.IndexOf("Grand Theft Auto", StringComparison.OrdinalIgnoreCase) < 0
                                && name.IndexOf("GTA", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            using (RegistryKey game = rockstar.OpenSubKey(name))
                            {
                                if (game == null) continue;
                                foreach (string value in game.GetValueNames())
                                {
                                    if (!value.StartsWith("InstallFolder", StringComparison.OrdinalIgnoreCase)) continue;
                                    string store = value.EndsWith("Steam", StringComparison.OrdinalIgnoreCase) ? "Steam"
                                        : value.EndsWith("Epic", StringComparison.OrdinalIgnoreCase) ? "Epic Games"
                                        : "Rockstar";
                                    if (game.GetValue(value) is string path) list.Add((path, store));
                                }
                            }
                        }
                    }
                }
                catch (Exception)
                {
                    // Not readable; the other ways still work.
                }
            }
            return list;
        }

        static List<string> EpicManifests()
        {
            var list = new List<string>();
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Epic", "EpicGamesLauncher", "Data", "Manifests");
                if (!Directory.Exists(dir)) return list;
                var json = new JavaScriptSerializer();
                foreach (string file in Directory.GetFiles(dir, "*.item"))
                {
                    try
                    {
                        var item = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file));
                        if (item.TryGetValue("DisplayName", out object name) && name is string n
                            && n.IndexOf("Grand Theft Auto V", StringComparison.OrdinalIgnoreCase) >= 0
                            && item.TryGetValue("InstallLocation", out object location) && location is string l)
                            list.Add(l);
                    }
                    catch (Exception)
                    {
                        // Another game's manifest we can't read.
                    }
                }
            }
            catch (Exception)
            {
                // No Epic launcher.
            }
            return list;
        }

        static string Read(RegistryKey hive, string path, string name)
        {
            try
            {
                using (RegistryKey key = hive.OpenSubKey(path))
                    return key?.GetValue(name) as string;
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}

using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Web.Script.Serialization;

namespace RugrSetup
{
    sealed class PayloadFile
    {
        /// <summary>Where it goes, from the GTA V folder, with forward slashes: scripts/PumpV.dll.</summary>
        public string Path;
        public string Sha256;
        public long Size;
        /// <summary>The player's own copy wins, like their PumpV.ini settings.</summary>
        public bool Keep;
    }

    /// <summary>
    /// RUGR's own files, zipped inside this exe: files/... plus a release.json that lists each one
    /// with its size and SHA-256, so every file can be checked after it's written. iFruit Jailbreak
    /// rides along in deps/, for players who don't have it yet.
    /// </summary>
    sealed class Payload
    {
        public string Version = "0.1.0";
        public readonly List<PayloadFile> Files = new List<PayloadFile>();

        /// <summary>iFruit Jailbreak's dll, in deps/.</summary>
        public PayloadFile IFruit;
        public string IFruitVersion = "";

        /// <summary>False in a build without RUGR's files, which can only draw its screens.</summary>
        public bool Present;

        public static Payload Load()
        {
            var payload = new Payload();
            using (Stream s = Open())
            {
                if (s == null) return payload;
                using (var zip = new ZipArchive(s, ZipArchiveMode.Read))
                {
                    ZipArchiveEntry entry = zip.GetEntry("release.json")
                        ?? throw new InvalidDataException("This setup is damaged. Download RUGR Setup again.");
                    using (var reader = new StreamReader(entry.Open()))
                    {
                        var release = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                        payload.Version = (string)release["version"];
                        foreach (object item in (IEnumerable)release["files"])
                        {
                            var f = (IDictionary<string, object>)item;
                            payload.Files.Add(new PayloadFile
                            {
                                Path = (string)f["path"],
                                Sha256 = (string)f["sha256"],
                                Size = Convert.ToInt64(f["size"]),
                                Keep = f.TryGetValue("keep", out object keep) && keep is bool k && k,
                            });
                        }
                        if (release.TryGetValue("ifruit", out object ifruit) && ifruit is IDictionary<string, object> i)
                        {
                            payload.IFruit = new PayloadFile
                            {
                                Path = (string)i["path"],
                                Sha256 = (string)i["sha256"],
                                Size = Convert.ToInt64(i["size"]),
                            };
                            payload.IFruitVersion = i.TryGetValue("version", out object v) ? v as string ?? "" : "";
                        }
                    }
                }
            }
            payload.Present = true;
            return payload;
        }

        public static Stream Open() => Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip");
    }
}

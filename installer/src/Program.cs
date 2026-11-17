using System;
using System.Globalization;
using System.Windows.Forms;

namespace RugrSetup
{
    /// <summary>What the command line asked for.</summary>
    sealed class Options
    {
        /// <summary>--folder "GTA V folder": start with this copy picked.</summary>
        public string Folder;

        /// <summary>--then install|remove: run it straight away. Used after Windows asks for permission.</summary>
        public string Then;

        /// <summary>--capture folder: draw every screen to PNG files for the website, then quit.</summary>
        public string CaptureDir;

        public float CaptureScale = 2f;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string next = i + 1 < args.Length ? args[i + 1] : null;
                switch (args[i])
                {
                    case "--folder": o.Folder = next; i++; break;
                    case "--then": o.Then = next; i++; break;
                    case "--capture": o.CaptureDir = next; i++; break;
                    case "--scale":
                        float.TryParse(next, NumberStyles.Float, CultureInfo.InvariantCulture, out o.CaptureScale);
                        i++;
                        break;
                }
            }
            return o;
        }
    }

    static class Program
    {
        /// <summary>The install guide on GTAMOD's site.</summary>
        public const string Guide = "https://gtamod.onrender.com/download.html";

        [STAThread]
        static int Main(string[] args)
        {
            var options = Options.Parse(args);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            if (options.CaptureDir != null) return Capture.Run(options.CaptureDir, options.CaptureScale);
            Application.Run(new SetupForm(options));
            return 0;
        }
    }
}

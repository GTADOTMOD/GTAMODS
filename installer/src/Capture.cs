using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

namespace RugrSetup
{
    /// <summary>
    /// Draws every screen with sample data to PNG files, for the install guide on GTAMOD's site.
    /// The screens are drawn by the same code as the real window.
    /// </summary>
    static class Capture
    {
        sealed class NoActions : IActions
        {
            public void Install() { }
            public void Change() { }
            public void Use() { }
            public void Back() { }
            public void Select(int index) { }
            public void Browse() { }
            public void AskRemove() { }
            public void Retry() { }
            public void Open(string url) { }
            public void Close() { }
            public void Minimize() { }
        }

        public static int Run(string dir, float scale)
        {
            Directory.CreateDirectory(dir);
            string version = "0.1.0", ifruit = "6.0";
            try
            {
                Payload payload = Payload.Load();
                version = payload.Version;
                if (payload.IFruitVersion.Length > 0) ifruit = payload.IFruitVersion;
            }
            catch (Exception)
            {
                // A build without files still draws its screens.
            }

            var game = new GameCopy
            {
                Folder = @"C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V",
                Store = "Steam",
                Version = new Version(1, 0, 3889, 0),
            };
            var model = new Model { Version = version, Selected = 0 };
            model.Games.Add(game);
            using (var ui = new Ui(scale))
            {
                var view = new View(ui, model, new NoActions());

                // A PC with GTA V and nothing else yet: the install brings everything.
                model.Page = Page.Welcome;
                model.Parts = Plan(ifruit, version);
                Save(view, dir, "1-welcome");

                model.Page = Page.Working;
                model.Job = Job.Install;
                model.Progress = 0.58f;
                model.Shimmer = 0.55f;
                model.ProgressText = "Installing iFruit Jailbreak";
                Set(model.Parts, "hook", PartState.Done, "Installed 3889.0");
                Set(model.Parts, "dotnet", PartState.Done, "Installed 1.1.0.6");
                Set(model.Parts, "ifruit", PartState.Working, "Installing");
                Save(view, dir, "2-installing");

                model.Page = Page.Done;
                model.Notes = new List<string>
                {
                    "Mods are for story mode only. With Script Hook V in, GTA Online won't start; to play online, take its files and args.txt out of your game folder.",
                };
                Save(view, dir, "3-ready");

                model.Page = Page.Folder;
                Save(view, dir, "4-change");
            }
            return 0;
        }

        static List<Part> Plan(string ifruit, string version) => new List<Part>
        {
            new Part { Key = "hook", Name = "Script Hook V", Credit = "by Alexander Blade", Needed = true, Plan = "Will install" },
            new Part { Key = "dotnet", Name = "ScriptHookVDotNet", Credit = "by crosire, kagikn & Chiheb-Bacha", Needed = true, Plan = "Will install" },
            new Part { Key = "ifruit", Name = "iFruit Jailbreak", Credit = "by andre500", Needed = true, Plan = "Will install" },
            new Part { Key = "rugr", Name = "RUGR", Credit = "by GTAMOD", Needed = true, Plan = "Will install" },
            new Part { Key = "display", Name = "Borderless mode", Credit = "so RUGR's phone can sit over the game", Needed = true, Plan = "Will turn on" },
        };

        static void Set(List<Part> parts, string key, PartState state, string detail)
        {
            foreach (Part p in parts)
                if (p.Key == key)
                {
                    p.State = state;
                    p.Detail = detail;
                }
        }

        /// <summary>The screen with Windows 11's rounded corners, smooth at the edges, on a see-through background.</summary>
        static void Save(View view, string dir, string name)
        {
            int w = (int)Math.Round(View.W * view.Ui.S), h = (int)Math.Round(View.H * view.Ui.S);
            using (var flat = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            using (var shaped = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(flat)) view.Draw(g);
                using (Graphics g = Graphics.FromImage(shaped))
                using (var texture = new TextureBrush(flat))
                using (GraphicsPath corners = Ui.Round(new RectangleF(0, 0, w, h), 9 * view.Ui.S))
                {
                    g.Clear(Color.Transparent);
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.FillPath(texture, corners);
                }
                shaped.Save(Path.Combine(dir, name + ".png"), ImageFormat.Png);
            }
        }
    }
}

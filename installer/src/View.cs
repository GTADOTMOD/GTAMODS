using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Linq;
using System.Reflection;

namespace RugrSetup
{
    enum Page { Welcome, Folder, Working, Done, Error }
    enum Job { Install, Update, Remove }

    sealed class Model
    {
        public Page Page = Page.Welcome;
        public List<GameCopy> Games = new List<GameCopy>();
        public int Selected = -1;
        /// <summary>What the install will do (on the first screen), then what it's doing.</summary>
        public List<Part> Parts = new List<Part>();
        /// <summary>What the player should know when it's done.</summary>
        public List<string> Notes = new List<string>();
        public Job Job;
        public float Progress;
        public string ProgressText = "";
        public string Error = "", ErrorUrl, ErrorLink;
        public string Version = "0.1.0";
        /// <summary>0 to 1, looping while something runs: the shine on the bar and the spinner.</summary>
        public float Shimmer = 0.6f;

        public GameCopy Game => Selected >= 0 && Selected < Games.Count ? Games[Selected] : null;
    }

    /// <summary>What the screens can ask the window to do.</summary>
    interface IActions
    {
        /// <summary>The one button: install, or update.</summary>
        void Install();
        /// <summary>Pick another copy of the game.</summary>
        void Change();
        /// <summary>Use the copy picked on the Change screen.</summary>
        void Use();
        void Back();
        void Select(int index);
        void Browse();
        void AskRemove();
        void Retry();
        void Open(string url);
        void Close();
        void Minimize();
    }

    sealed class Zone
    {
        public string Id;
        public RectangleF Rect;
        public Action Click;
        public bool Enabled = true;
    }

    enum Glyph { Folder, Get }

    /// <summary>Draws the setup's screens and knows where their buttons are.</summary>
    sealed class View
    {
        public const float W = 900, H = 620;
        const float RailW = 248, X0 = 300, CW = 552, FootY = 534, BtnH = 46;
        const float BackX = X0 + CW - 330, NextX = X0 + CW - 196;

        public readonly Ui Ui;
        public readonly Model M;
        readonly IActions act;
        readonly List<Zone> zones = new List<Zone>();
        static readonly Bitmap Logo = LoadImage("logo.png");

        public string Hover, Pressed;

        public View(Ui ui, Model model, IActions actions)
        {
            Ui = ui;
            M = model;
            act = actions;
        }

        static Bitmap LoadImage(string name)
        {
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name))
                return s == null ? null : new Bitmap(s);
        }

        public Zone Hit(Point p)
        {
            for (int i = zones.Count - 1; i >= 0; i--)
                if (zones[i].Rect.Contains(p)) return zones[i];
            return null;
        }

        public Zone Find(string id) => zones.FirstOrDefault(z => z.Id == id);
        public bool InTitleBar(Point p) => p.Y < Ui.P(40);

        public void Draw(Graphics g)
        {
            zones.Clear();
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.CompositingQuality = CompositingQuality.HighQuality;

            RectangleF all = Ui.R(0, 0, W, H);
            using (var bg = new LinearGradientBrush(all, Palette.Window, Palette.WindowEnd, 70f)) g.FillRectangle(bg, all);
            Ui.Glow(g, Palette.Accent, 22, W - 20, -40, 320, 210);
            Rail(g);
            switch (M.Page)
            {
                case Page.Welcome: Welcome(g); break;
                case Page.Folder: Folder(g); break;
                case Page.Working: Working(g); break;
                case Page.Done: Done(g); break;
                case Page.Error: ErrorPage(g); break;
            }
            Chrome(g);
        }

        // ---- the parts every screen has ----

        void Rail(Graphics g)
        {
            RectangleF rail = Ui.R(0, 0, RailW, H);
            using (var b = new SolidBrush(Palette.Rail)) g.FillRectangle(b, rail);
            g.SetClip(rail);
            Ui.Glow(g, Palette.Accent, 64, 30, H + 20, 270, 210);
            Ui.Glow(g, Palette.Accent, 40, 124, 144, 132, 122);
            g.ResetClip();
            using (var pen = new Pen(Palette.Line, Ui.P(1))) g.DrawLine(pen, rail.Right - Ui.P(0.5f), 0, rail.Right - Ui.P(0.5f), rail.Bottom);

            Ui.Line(g, "RUGR Setup", Ui.SmallStrong, Palette.Dim, Ui.R(22, 9, 200, 22));
            if (Logo != null) g.DrawImage(Logo, Ui.R(44, 60, 160, 160));

            string[] steps = { "Your game", "Install", "Play" };
            int current = M.Page == Page.Welcome || M.Page == Page.Folder ? 0
                : M.Page != Page.Done ? 1 : M.Job == Job.Remove ? 3 : 2;
            float y = 258;
            for (int i = 0; i < steps.Length; i++, y += 44)
            {
                bool done = i < current, now = i == current;
                float cx = 44, cy = y + 13;
                if (done)
                {
                    Ui.Badge(g, cx, cy, 12, Status.Ok);
                }
                else
                {
                    var circle = Ui.R(cx - 12, cy - 12, 24, 24);
                    if (now)
                    {
                        using (var b = new SolidBrush(Palette.Accent)) g.FillEllipse(b, circle);
                    }
                    else
                    {
                        using (var pen = new Pen(Palette.Alpha(Color.White, 44), Ui.P(1.2f))) g.DrawEllipse(pen, circle);
                    }
                    Ui.Line(g, (i + 1).ToString(), Ui.Step, now ? Palette.OnAccent : Palette.Dim, new RectangleF(circle.X, circle.Y + Ui.P(1), circle.Width, circle.Height), StringAlignment.Center);
                }
                Ui.Line(g, steps[i], now ? Ui.Strong : Ui.Body, now ? Palette.Text : done ? Palette.Sub : Palette.Dim, Ui.R(70, y, RailW - 80, 26));
            }

            Ui.Line(g, $"RUGR {M.Version}  ·  early access", Ui.Small, Palette.Sub, Ui.R(26, H - 66, RailW - 40, 20));
            Ui.Line(g, "By GTAMOD. Unofficial.", Ui.Small, Palette.Dim, Ui.R(26, H - 44, RailW - 40, 20));
        }

        void Chrome(Graphics g)
        {
            RectangleF min = Ui.R(W - 92, 0, 46, 36), close = Ui.R(W - 46, 0, 46, 36);
            zones.Add(new Zone { Id = "min", Rect = min, Click = act.Minimize });
            zones.Add(new Zone { Id = "close", Rect = close, Click = act.Close, Enabled = M.Page != Page.Working });
            if (Hover == "min") using (var b = new SolidBrush(Palette.Alpha(Color.White, 18))) g.FillRectangle(b, min);
            if (Hover == "close" && M.Page != Page.Working) using (var b = new SolidBrush(Palette.Close)) g.FillRectangle(b, close);
            using (var pen = new Pen(M.Page == Page.Working ? Palette.Dim : Palette.Sub, Ui.P(1)))
            {
                float mx = W - 92 + 18, cx = W - 46 + 18;
                g.DrawLine(pen, Ui.P(mx), Ui.P(18), Ui.P(mx + 10), Ui.P(18));
                if (Hover == "close" && M.Page != Page.Working) pen.Color = Color.White;
                g.DrawLine(pen, Ui.P(cx), Ui.P(13), Ui.P(cx + 10), Ui.P(23));
                g.DrawLine(pen, Ui.P(cx + 10), Ui.P(13), Ui.P(cx), Ui.P(23));
            }
        }

        float Header(Graphics g, float top, string eyebrow, string title, string body)
        {
            Ui.Tracked(g, eyebrow.ToUpperInvariant(), Ui.Eyebrow, Palette.Accent, X0, top, 1.4f);
            float y = Ui.Para(g, title, Ui.Title, Palette.Text, X0 - 1, top + 18, CW);
            if (!string.IsNullOrEmpty(body)) y = Ui.Para(g, body, Ui.Body, Palette.Sub, X0, y + 8, CW - 12);
            return y;
        }

        void Button(Graphics g, string id, float x, float w, string label, Kind kind, Action click, bool enabled = true)
        {
            RectangleF r = Ui.R(x, FootY, w, BtnH);
            zones.Add(new Zone { Id = id, Rect = r, Click = click, Enabled = enabled });
            bool hot = enabled && Hover == id;
            Ui.Button(g, r, label, kind, hot, hot && Pressed == id, enabled);
        }

        void SmallButton(Graphics g, string id, RectangleF r, string label, Action click)
        {
            zones.Add(new Zone { Id = id, Rect = r, Click = click });
            bool hot = Hover == id;
            Ui.Button(g, r, label, Kind.Small, hot, hot && Pressed == id, true);
        }

        float Note(Graphics g, float y, string text)
        {
            float textH;
            using (var probe = new Bitmap(1, 1))
            using (Graphics m = Graphics.FromImage(probe))
                textH = Ui.Para(m, text, Ui.Small, Color.Transparent, 0, 0, CW - 62);
            RectangleF r = Ui.R(X0, y, CW, textH + 26);
            Ui.Fill(g, Palette.Alpha(Palette.Warn, 16), r, 12);
            Ui.Stroke(g, Palette.Alpha(Palette.Warn, 64), r, 12);
            Ui.Badge(g, X0 + 23, y + 22, 9, Status.Warning);
            Ui.Para(g, text, Ui.Small, Palette.Text, X0 + 44, y + 13, CW - 62);
            return y + textH + 26;
        }

        void DrawGlyph(Graphics g, Glyph glyph, float cx, float cy, Color c)
        {
            using (var pen = new Pen(c, Ui.P(2)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            {
                switch (glyph)
                {
                    case Glyph.Folder:
                        using (var path = new GraphicsPath())
                        {
                            path.AddLines(new[] { Ui.Pt(cx - 8, cy + 6), Ui.Pt(cx - 8, cy - 6), Ui.Pt(cx - 3, cy - 6), Ui.Pt(cx - 1, cy - 3.5f), Ui.Pt(cx + 8, cy - 3.5f), Ui.Pt(cx + 8, cy + 6) });
                            path.CloseFigure();
                            g.DrawPath(pen, path);
                        }
                        break;
                    case Glyph.Get:
                        // A down arrow in a ring: Setup will get this one.
                        var circle = Ui.R(cx - 10, cy - 10, 20, 20);
                        using (var b = new SolidBrush(Palette.Alpha(c, 30))) g.FillEllipse(b, circle);
                        using (var ring = new Pen(Palette.Alpha(c, 190), Ui.P(1.4f))) g.DrawEllipse(ring, circle);
                        pen.Width = Ui.P(1.8f);
                        g.DrawLine(pen, Ui.Pt(cx, cy - 4.5f), Ui.Pt(cx, cy + 3.5f));
                        g.DrawLines(pen, new[] { Ui.Pt(cx - 3.6f, cy + 0.2f), Ui.Pt(cx, cy + 3.8f), Ui.Pt(cx + 3.6f, cy + 0.2f) });
                        break;
                }
            }
        }

        // ---- the screens ----

        void Welcome(Graphics g)
        {
            GameCopy game = M.Game;
            bool installed = game?.RugrVersion != null;
            float y = Header(g, 58, "Early access  ·  Version " + M.Version, "Put RUGR on your GTA V phone",
                "Launch coins and trade any Solana token from the phone, right in story mode. One click puts RUGR and everything it needs into your game.");
            y += 22;
            GameCard(g, y);
            y += 76 + 26;

            Ui.Tracked(g, "INSTALLS WITH IT", Ui.Eyebrow, Palette.Dim, X0, y, 1.4f);
            y += 26;
            foreach (Part p in M.Parts.Where(p => p.Key != "rugr"))
            {
                PlanRow(g, p, y, game != null);
                y += 32;
            }

            if (installed)
                Button(g, "remove", X0, 150, "Remove RUGR", Kind.Danger, act.AskRemove);
            else
                Ui.Para(g, "Unofficial. Not affiliated with Rockstar Games,\nTake-Two Interactive or pump.fun.", Ui.Small, Palette.Dim, X0, FootY + 5, CW - 220);
            string label = game == null ? "Find GTA V" : installed ? "Update" : "Install";
            Button(g, "primary", NextX, 196, label, Kind.Primary, game == null ? (Action)act.Browse : act.Install);
        }

        /// <summary>The copy RUGR goes into, with a way to pick another.</summary>
        void GameCard(Graphics g, float y)
        {
            GameCopy c = M.Game;
            RectangleF r = Ui.R(X0, y, CW, 76);
            Ui.Fill(g, Palette.Card, r, 14);
            Ui.Stroke(g, Palette.Line, r, 14);
            bool none = c == null && M.Games.Count == 0;
            SmallButton(g, "change", Ui.R(X0 + CW - 112, y + 21, 96, 34), none ? "Find it" : "Change", none ? (Action)act.Browse : act.Change);
            const float textW = CW - 150;
            if (c == null)
            {
                Ui.Line(g, "We couldn't find GTA V on this PC", Ui.Strong, Palette.Text, Ui.R(X0 + 20, y + 12, textW, 24));
                Ui.Line(g, "Find GTA5.exe in your game folder, and RUGR goes in there.", Ui.Small, Palette.Sub, Ui.R(X0 + 20, y + 42, textW, 20));
                return;
            }

            float x = Ui.Chip(g, c.Store, Palette.Accent, X0 + 20, y + 14);
            string title = c.Edition + (c.Version != null ? "  ·  " + c.Version : "");
            float titleW = Math.Min(Ui.Measure(g, title, Ui.Strong), X0 + 20 + textW - x - 10);
            Ui.Line(g, title, Ui.Strong, Palette.Text, Ui.R(x + 10, y + 11, titleW + 2, 24));
            if (c.RugrVersion != null)
            {
                string chip = c.RugrVersion.Length > 0 ? $"RUGR {c.RugrVersion} in" : "RUGR in";
                if (x + 22 + titleW + Ui.Measure(g, chip.ToUpperInvariant(), Ui.Tag) + 14 < X0 + CW - 124)
                    Ui.Chip(g, chip, Palette.Gain, x + 22 + titleW, y + 14);
            }
            Ui.Line(g, c.Folder, Ui.Mono, Palette.Sub, Ui.R(X0 + 20, y + 44, textW, 20), StringAlignment.Near, StringAlignment.Center, path: true);
        }

        /// <summary>One thing the install brings, and whether the game already has it.</summary>
        void PlanRow(Graphics g, Part p, float y, bool known)
        {
            float cx = X0 + 11, cy = y + 12;
            Color planColor;
            if (known && p.Have)
            {
                Ui.Badge(g, cx, cy, 10, Status.Ok);
                planColor = Palette.Gain;
            }
            else if (!known || p.Needed)
            {
                DrawGlyph(g, Glyph.Get, cx, cy, Palette.Accent);
                planColor = Palette.Accent;
            }
            else
            {
                Ui.Badge(g, cx, cy, 10, Status.Info);
                planColor = Palette.Sub;
            }
            float nameW = Ui.Measure(g, p.Name, Ui.Strong);
            Ui.Line(g, p.Name, Ui.Strong, Palette.Text, Ui.R(X0 + 32, y, nameW + 4, 24));
            Ui.Line(g, p.Credit, Ui.Small, Palette.Dim, Ui.R(X0 + 42 + nameW, y + 1, CW - 42 - nameW - 132, 24));
            if (known) Ui.Line(g, p.Plan, Ui.Small, planColor, Ui.R(X0 + CW - 130, y + 1, 130, 24), StringAlignment.Far);
        }

        void Folder(Graphics g)
        {
            int n = M.Games.Count;
            string body = n == 0 ? "We couldn't find GTA V on this PC. Find GTA5.exe in your game folder, and RUGR goes in there."
                : n == 1 ? "This is the copy we found. If yours is somewhere else, find its GTA5.exe."
                : "We found more than one copy. Pick the one RUGR should go in.";
            float y = Header(g, 62, "Your game", "Which GTA V?", body) + 24;
            for (int i = 0; i < Math.Min(n, 3); i++)
            {
                Card(g, i, y);
                y += 94;
            }

            const string browse = "Find GTA5.exe yourself";
            float bw = Ui.Measure(g, browse, Ui.Strong) + 34;
            RectangleF r = Ui.R(X0, y + 2, bw, 34);
            zones.Add(new Zone { Id = "browse", Rect = r, Click = act.Browse });
            bool hot = Hover == "browse";
            DrawGlyph(g, Glyph.Folder, X0 + 10, y + 19, hot ? Palette.Text : Palette.Accent);
            Ui.Button(g, Ui.R(X0 + 28, y + 2, bw - 28, 34), browse, Kind.Ghost, hot, false, true);

            Button(g, "back", BackX, 120, "Back", Kind.Secondary, act.Back);
            Button(g, "primary", NextX, 196, "Use this one", Kind.Primary, act.Use, M.Game != null);
        }

        void Card(Graphics g, int i, float y)
        {
            GameCopy c = M.Games[i];
            bool selected = i == M.Selected;
            string id = "game" + i;
            RectangleF r = Ui.R(X0, y, CW, 80);
            zones.Add(new Zone { Id = id, Rect = r, Click = () => act.Select(i) });
            bool hot = Hover == id;
            Ui.Fill(g, selected ? Palette.Alpha(Palette.Accent, 16) : hot ? Palette.CardHover : Palette.Card, r, 14);
            Ui.Stroke(g, selected ? Palette.Accent : hot ? Palette.LineStrong : Palette.Line, r, 14, selected ? 1.5f : 1);

            float x = Ui.Chip(g, c.Store, selected ? Palette.Accent : Palette.Sub, X0 + 20, y + 15);
            string title = c.Edition + (c.Version != null ? "  ·  " + c.Version : "");
            float titleW = Math.Min(Ui.Measure(g, title, Ui.Strong), CW - (x - X0) - 90);
            Ui.Line(g, title, Ui.Strong, Palette.Text, Ui.R(x + 10, y + 12, titleW + 2, 24));
            if (c.RugrVersion != null)
                Ui.Chip(g, c.RugrVersion.Length > 0 ? $"RUGR {c.RugrVersion} installed" : "RUGR installed", Palette.Gain, x + 22 + titleW, y + 15);
            Ui.Line(g, c.Folder, Ui.Mono, Palette.Sub, Ui.R(X0 + 20, y + 46, CW - 88, 20), StringAlignment.Near, StringAlignment.Center, path: true);

            float cx = X0 + CW - 34, cy = y + 40;
            using (var pen = new Pen(selected ? Palette.Accent : Palette.Alpha(Color.White, hot ? 90 : 60), Ui.P(selected ? 2 : 1.4f)))
                g.DrawEllipse(pen, Ui.R(cx - 11, cy - 11, 22, 22));
            if (selected) Ui.Dot(g, Palette.Accent, cx, cy, 5.5f);
        }

        void Working(Graphics g)
        {
            bool removing = M.Job == Job.Remove;
            string verb = removing ? "Removing" : M.Job == Job.Update ? "Updating" : "Installing";
            string body = removing
                ? "This takes a few seconds. Keep GTA V closed until it's done."
                : "This takes about a minute. Keep GTA V closed until it's done.";
            float y = Header(g, 62, verb, verb + " RUGR", body) + 34;

            Ui.Line(g, $"{(int)Math.Round(M.Progress * 100)}%", Ui.ButtonFont, Palette.Text, Ui.R(X0, y, CW, 24), StringAlignment.Far);
            RectangleF track = Ui.R(X0, y + 32, CW, 10);
            Ui.Fill(g, Palette.Alpha(Color.White, 16), track, 5);
            float w = Math.Max(10, CW * Math.Min(1, M.Progress));
            RectangleF fill = Ui.R(X0, y + 32, w, 10);
            using (GraphicsPath path = Ui.Round(fill, Ui.P(5)))
            {
                using (var brush = new LinearGradientBrush(new RectangleF(fill.X - 1, fill.Y, fill.Width + 2, fill.Height), Palette.Accent, Palette.Hex("#ff7ab5"), 0f))
                    g.FillPath(brush, path);
                g.SetClip(path);
                float sx = X0 - 80 + (w + 160) * M.Shimmer;
                RectangleF shine = Ui.R(sx, y + 32, 80, 10);
                using (var brush = new LinearGradientBrush(new RectangleF(shine.X - 1, shine.Y, shine.Width + 2, shine.Height), Color.Transparent, Color.Transparent, 0f))
                {
                    brush.InterpolationColors = new ColorBlend
                    {
                        Colors = new[] { Palette.Alpha(Color.White, 0), Palette.Alpha(Color.White, 90), Palette.Alpha(Color.White, 0) },
                        Positions = new[] { 0f, 0.5f, 1f },
                    };
                    g.FillRectangle(brush, shine);
                }
                g.ResetClip();
            }
            Ui.Line(g, M.ProgressText, Ui.Small, Palette.Sub, Ui.R(X0, y + 52, CW, 20), StringAlignment.Near, StringAlignment.Center, path: true);

            y += 96;
            foreach (Part p in M.Parts)
            {
                PartRow(g, p, y);
                y += 38;
            }
        }

        void PartRow(Graphics g, Part p, float y)
        {
            float cx = X0 + 12, cy = y + 12;
            var circle = Ui.R(cx - 11, cy - 11, 22, 22);
            switch (p.State)
            {
                case PartState.Done: Ui.Badge(g, cx, cy, 11, Status.Ok); break;
                case PartState.Warning: Ui.Badge(g, cx, cy, 11, Status.Warning); break;
                case PartState.Failed: Ui.Badge(g, cx, cy, 11, Status.Missing); break;
                case PartState.Working:
                    using (var ring = new Pen(Palette.Alpha(Palette.Accent, 56), Ui.P(1.8f))) g.DrawEllipse(ring, circle);
                    using (var arc = new Pen(Palette.Accent, Ui.P(2.2f)) { StartCap = LineCap.Round, EndCap = LineCap.Round })
                        g.DrawArc(arc, circle, M.Shimmer * 720f, 110f);
                    break;
                default:
                    using (var pen = new Pen(Palette.Alpha(Color.White, 44), Ui.P(1.2f))) g.DrawEllipse(pen, circle);
                    break;
            }
            Color name = p.State == PartState.Waiting ? Palette.Dim : p.State == PartState.Working ? Palette.Text : Palette.Sub;
            float nameW = Ui.Measure(g, p.Name, Ui.Body);
            Ui.Line(g, p.Name, Ui.Body, name, Ui.R(X0 + 36, y, nameW + 4, 24));
            Color detail = p.State == PartState.Warning ? Palette.Warn
                : p.State == PartState.Failed ? Palette.Accent
                : p.State == PartState.Working ? Palette.Text : Palette.Dim;
            Ui.Line(g, p.Detail ?? "", Ui.Small, detail, Ui.R(X0 + 48 + nameW, y + 1, CW - 48 - nameW, 24), StringAlignment.Far);
        }

        void Done(Graphics g)
        {
            Ui.Badge(g, X0 + 26, 86, 26, Status.Ok);
            if (M.Job == Job.Remove)
            {
                float top = Header(g, 128, "Done", "RUGR is removed",
                    "Your wallet is still saved in your Windows profile, so if you put RUGR back, it'll be there.") + 22;
                Note(g, top, "Script Hook V, ScriptHookVDotNet and iFruit Jailbreak are still in your game folder, for your other mods. Take them and args.txt out too before you play GTA Online.");
                Button(g, "primary", NextX, 196, "Finish", Kind.Primary, act.Close);
                return;
            }

            float y = Header(g, 128, "All set", M.Job == Job.Update ? "RUGR is updated" : "RUGR is ready", "Here's how to open it in the game.") + 18;
            string[] steps =
            {
                "Start GTA V and load story mode.",
                "Press the Up arrow to take out your phone.",
                "Open RUGR. If the first page of apps is full, it's on the next one.",
                "Create your wallet, fund it, and you're in.",
            };
            for (int i = 0; i < steps.Length; i++)
            {
                RectangleF circle = Ui.R(X0, y, 26, 26);
                using (var pen = new Pen(Palette.Alpha(Palette.Accent, 200), Ui.P(1.4f))) g.DrawEllipse(pen, circle);
                Ui.Line(g, (i + 1).ToString(), Ui.Step, Palette.Accent, new RectangleF(circle.X, circle.Y + Ui.P(1), circle.Width, circle.Height), StringAlignment.Center);
                float end = Ui.Para(g, steps[i], Ui.Body, Palette.Text, X0 + 40, y + 2, CW - 40);
                y = Math.Max(y + 26, end) + 11;
            }
            y += 4;
            foreach (string note in M.Notes.Take(2)) y = Note(g, y, note) + 8;
            Button(g, "guide", X0, 196, "Open the guide", Kind.Secondary, () => act.Open(Program.Guide + "#play"));
            Button(g, "primary", NextX, 196, "Finish", Kind.Primary, act.Close);
        }

        void ErrorPage(Graphics g)
        {
            Ui.Badge(g, X0 + 26, 86, 26, Status.Missing);
            Header(g, 128, "Something went wrong", M.Job == Job.Remove ? "RUGR wasn't removed" : "RUGR isn't in yet", M.Error);
            if (M.ErrorUrl != null)
            {
                string link = M.ErrorLink ?? "Open the page";
                Button(g, "link", X0, Math.Min(BackX - X0 - 16, Ui.Measure(g, link, Ui.Strong) + 8), link, Kind.Ghost, () => act.Open(M.ErrorUrl));
            }
            Button(g, "back", BackX, 120, "Back", Kind.Secondary, act.Back);
            Button(g, "primary", NextX, 196, "Try again", Kind.Primary, act.Retry);
        }
    }
}

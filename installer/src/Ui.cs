using System;
using System.Drawing;
using System.Drawing.Drawing2D;

namespace RugrSetup
{
    /// <summary>RUGR's colours, the same as the phone app's.</summary>
    static class Palette
    {
        public static readonly Color Window = Hex("#0b0709");
        public static readonly Color WindowEnd = Hex("#060304");
        public static readonly Color Rail = Hex("#120a0e");
        public static readonly Color Card = Hex("#150c11");
        public static readonly Color CardHover = Hex("#1d1117");
        public static readonly Color Line = Color.FromArgb(24, 255, 255, 255);
        public static readonly Color LineStrong = Color.FromArgb(48, 255, 255, 255);
        public static readonly Color Text = Hex("#f6f0e6");
        public static readonly Color Sub = Hex("#b5a9a4");
        public static readonly Color Dim = Hex("#84787a");
        public static readonly Color Accent = Hex("#ff1f7d");
        public static readonly Color AccentHover = Hex("#ff4b97");
        public static readonly Color AccentDown = Hex("#e0126a");
        public static readonly Color OnAccent = Hex("#160208");
        public static readonly Color Warn = Hex("#f7c325");
        public static readonly Color Gain = Hex("#2ee6a6");
        public static readonly Color Loss = Hex("#ff5c6c");
        public static readonly Color Close = Hex("#c42b1c");

        public static Color Hex(string hex) => ColorTranslator.FromHtml(hex);
        public static Color Alpha(Color c, int alpha) => Color.FromArgb(Math.Max(0, Math.Min(255, alpha)), c);
    }

    enum Kind { Primary, Secondary, Ghost, Danger, Small }

    enum Status { Ok, Missing, Outdated, Warning, Info }

    /// <summary>
    /// Fonts and drawing at one scale. Every size passed in is in 96-dpi pixels and multiplied by
    /// Scale, so the window and the website's screenshots are drawn by the same code.
    /// </summary>
    sealed class Ui : IDisposable
    {
        public readonly float S;
        public readonly Font Title, Eyebrow, Body, Strong, Small, SmallStrong, Mono, ButtonFont, ButtonSmallFont, Tag, Step;

        static readonly string Heading = First("Bahnschrift SemiBold Condensed", "Bahnschrift", "Segoe UI Semibold");
        static readonly string Text = First("Segoe UI");
        static readonly string TextBold = First("Segoe UI Semibold", "Segoe UI");
        static readonly string MonoFace = First("Cascadia Mono", "Consolas");

        public Ui(float scale)
        {
            S = scale;
            Title = Make(Heading, 38);
            Eyebrow = Make(TextBold, 11.5f);
            Body = Make(Text, 15);
            Strong = Make(TextBold, 15);
            Small = Make(Text, 13);
            SmallStrong = Make(TextBold, 13);
            Mono = Make(MonoFace, 12);
            ButtonFont = Make(Heading, 17.5f);
            ButtonSmallFont = Make(Heading, 15);
            Tag = Make(TextBold, 10);
            Step = Make(Heading, 14);
        }

        public void Dispose()
        {
            foreach (Font f in new[] { Title, Eyebrow, Body, Strong, Small, SmallStrong, Mono, ButtonFont, ButtonSmallFont, Tag, Step }) f.Dispose();
        }

        Font Make(string face, float px) => new Font(face, px * S, FontStyle.Regular, GraphicsUnit.Pixel);

        static string First(params string[] faces)
        {
            foreach (string face in faces)
            {
                try
                {
                    using (new FontFamily(face)) return face;
                }
                catch (ArgumentException)
                {
                    // Not on this PC: try the next one.
                }
            }
            return "Segoe UI";
        }

        public RectangleF R(float x, float y, float w, float h) => new RectangleF(x * S, y * S, w * S, h * S);
        public float P(float v) => v * S;

        public static GraphicsPath Round(RectangleF r, float radius)
        {
            var path = new GraphicsPath();
            float d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 0.5f)
            {
                path.AddRectangle(r);
                return path;
            }
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }

        public void Fill(Graphics g, Color c, RectangleF px, float radius)
        {
            using (var b = new SolidBrush(c))
            using (GraphicsPath p = Round(px, P(radius)))
                g.FillPath(b, p);
        }

        public void Stroke(Graphics g, Color c, RectangleF px, float radius, float width = 1)
        {
            using (var pen = new Pen(c, P(width)))
            using (GraphicsPath p = Round(Inset(px, P(width) / 2), P(radius)))
                g.DrawPath(pen, p);
        }

        static RectangleF Inset(RectangleF r, float d) => new RectangleF(r.X + d, r.Y + d, r.Width - 2 * d, r.Height - 2 * d);

        static StringFormat Format(StringAlignment h, StringAlignment v, bool wrap, StringTrimming trimming)
        {
            var f = (StringFormat)StringFormat.GenericTypographic.Clone();
            f.Alignment = h;
            f.LineAlignment = v;
            f.Trimming = trimming;
            f.FormatFlags = (wrap ? 0 : StringFormatFlags.NoWrap) | StringFormatFlags.LineLimit;
            return f;
        }

        /// <summary>Wrapped text from (x, y) across w, in 96-dpi units. Returns where it ends.</summary>
        public float Para(Graphics g, string text, Font font, Color color, float x, float y, float w, int maxLines = 0)
        {
            using (StringFormat f = Format(StringAlignment.Near, StringAlignment.Near, true, StringTrimming.EllipsisWord))
            using (var b = new SolidBrush(color))
            {
                SizeF size = g.MeasureString(text, font, new SizeF(P(w), 100000), f);
                float height = size.Height;
                if (maxLines > 0) height = Math.Min(height, font.GetHeight(g) * maxLines + 1);
                g.DrawString(text, font, b, new RectangleF(P(x), P(y), P(w), height + 1), f);
                return y + height / S;
            }
        }

        public float Measure(Graphics g, string text, Font font, float w = 100000)
        {
            using (StringFormat f = Format(StringAlignment.Near, StringAlignment.Near, false, StringTrimming.None))
                return g.MeasureString(text, font, new SizeF(P(w), 100000), f).Width / S;
        }

        /// <summary>One line in a box, cut with an ellipsis if it doesn't fit.</summary>
        public void Line(Graphics g, string text, Font font, Color color, RectangleF px,
            StringAlignment h = StringAlignment.Near, StringAlignment v = StringAlignment.Center, bool path = false)
        {
            using (StringFormat f = Format(h, v, false, path ? StringTrimming.EllipsisPath : StringTrimming.EllipsisCharacter))
            using (var b = new SolidBrush(color))
                g.DrawString(text, font, b, px, f);
        }

        /// <summary>Small capitals spaced apart, for the label over each title.</summary>
        public void Tracked(Graphics g, string text, Font font, Color color, float x, float y, float tracking)
        {
            using (StringFormat f = Format(StringAlignment.Near, StringAlignment.Near, false, StringTrimming.None))
            using (var b = new SolidBrush(color))
            {
                float px = P(x);
                foreach (char ch in text)
                {
                    string s = ch.ToString();
                    g.DrawString(s, font, b, px, P(y), f);
                    float w = ch == ' ' ? font.Size * 0.3f : g.MeasureString(s, font, 1000, f).Width;
                    px += w + P(tracking);
                }
            }
        }

        public void Button(Graphics g, RectangleF r, string label, Kind kind, bool hot, bool down, bool enabled)
        {
            switch (kind)
            {
                case Kind.Primary:
                {
                    Color fill = !enabled ? Palette.Alpha(Palette.Accent, 80) : down ? Palette.AccentDown : hot ? Palette.AccentHover : Palette.Accent;
                    if (enabled && hot)
                    {
                        for (int i = 3; i >= 1; i--)
                        {
                            var glow = new RectangleF(r.X - P(i * 3), r.Y - P(i * 3), r.Width + P(i * 6), r.Height + P(i * 6));
                            Fill(g, Palette.Alpha(Palette.Accent, 22 - i * 5), glow, 10 + i * 3);
                        }
                    }
                    Fill(g, fill, r, 10);
                    Line(g, label.ToUpperInvariant(), ButtonFont, enabled ? Palette.OnAccent : Palette.Alpha(Palette.OnAccent, 150), Nudge(r), StringAlignment.Center);
                    break;
                }
                case Kind.Secondary:
                    Fill(g, Palette.Alpha(Color.White, !enabled ? 4 : down ? 22 : hot ? 15 : 7), r, 10);
                    Stroke(g, Palette.Alpha(Color.White, hot ? 70 : 40), r, 10);
                    Line(g, label.ToUpperInvariant(), ButtonFont, enabled ? Palette.Text : Palette.Dim, Nudge(r), StringAlignment.Center);
                    break;
                case Kind.Small:
                    Fill(g, Palette.Alpha(Palette.Accent, down ? 60 : hot ? 38 : 16), r, 8);
                    Stroke(g, Palette.Alpha(Palette.Accent, hot ? 230 : 150), r, 8);
                    Line(g, label.ToUpperInvariant(), ButtonSmallFont, hot ? Palette.Text : Palette.Accent, Nudge(r), StringAlignment.Center);
                    break;
                case Kind.Ghost:
                case Kind.Danger:
                {
                    Color c = kind == Kind.Danger
                        ? (hot ? Palette.Hex("#ff8a96") : Palette.Loss)
                        : (hot ? Palette.Text : Palette.Sub);
                    Line(g, label, Strong, c, r, StringAlignment.Near);
                    if (hot)
                    {
                        float w = Measure(g, label, Strong) * S;
                        using (var pen = new Pen(Palette.Alpha(c, 160), P(1)))
                            g.DrawLine(pen, r.X, r.Bottom - P(9), r.X + w, r.Bottom - P(9));
                    }
                    break;
                }
            }
        }

        /// <summary>Bahnschrift sits a little high in its box; this centres it by eye.</summary>
        RectangleF Nudge(RectangleF r) => new RectangleF(r.X, r.Y + P(1), r.Width, r.Height);

        /// <summary>A round status badge: a tick, a cross, a warning or an i.</summary>
        public void Badge(Graphics g, float cx, float cy, float radius, Status status)
        {
            Color c = status == Status.Ok ? Palette.Gain
                : status == Status.Missing ? Palette.Accent
                : status == Status.Info ? Palette.Sub
                : Palette.Warn;
            var circle = new RectangleF(P(cx - radius), P(cy - radius), P(radius * 2), P(radius * 2));
            using (var b = new SolidBrush(Palette.Alpha(c, 34))) g.FillEllipse(b, circle);
            using (var ring = new Pen(Palette.Alpha(c, 200), P(1.4f))) g.DrawEllipse(ring, circle);
            using (var pen = new Pen(c, P(2.1f)) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            {
                float u = radius * 0.42f;
                switch (status)
                {
                    case Status.Ok:
                        g.DrawLines(pen, new[] { Pt(cx - u, cy + 0.05f * radius), Pt(cx - u * 0.25f, cy + u * 0.7f), Pt(cx + u * 1.05f, cy - u * 0.75f) });
                        break;
                    case Status.Missing:
                        g.DrawLine(pen, Pt(cx - u * 0.8f, cy - u * 0.8f), Pt(cx + u * 0.8f, cy + u * 0.8f));
                        g.DrawLine(pen, Pt(cx + u * 0.8f, cy - u * 0.8f), Pt(cx - u * 0.8f, cy + u * 0.8f));
                        break;
                    case Status.Info:
                        g.DrawLine(pen, Pt(cx, cy - u * 0.15f), Pt(cx, cy + u * 1.0f));
                        Dot(g, c, cx, cy - u * 0.95f, 1.5f);
                        break;
                    default:
                        g.DrawLine(pen, Pt(cx, cy - u * 1.05f), Pt(cx, cy + u * 0.2f));
                        Dot(g, c, cx, cy + u * 1.0f, 1.5f);
                        break;
                }
            }
        }

        public void Dot(Graphics g, Color c, float cx, float cy, float radius)
        {
            using (var b = new SolidBrush(c)) g.FillEllipse(b, P(cx - radius), P(cy - radius), P(radius * 2), P(radius * 2));
        }

        public PointF Pt(float x, float y) => new PointF(P(x), P(y));

        /// <summary>A small rounded label, like STEAM or INSTALLED.</summary>
        public float Chip(Graphics g, string text, Color c, float x, float y)
        {
            string label = text.ToUpperInvariant();
            float w = Measure(g, label, Tag) + 14;
            var r = R(x, y, w, 20);
            Fill(g, Palette.Alpha(c, 30), r, 6);
            Stroke(g, Palette.Alpha(c, 90), r, 6);
            Line(g, label, Tag, c, new RectangleF(r.X, r.Y + P(0.5f), r.Width, r.Height), StringAlignment.Center);
            return x + w;
        }

        /// <summary>A soft round glow, for depth behind the logo and in the corners.</summary>
        public void Glow(Graphics g, Color c, int alpha, float cx, float cy, float rx, float ry)
        {
            using (var path = new GraphicsPath())
            {
                path.AddEllipse(P(cx - rx), P(cy - ry), P(rx * 2), P(ry * 2));
                using (var brush = new PathGradientBrush(path) { CenterColor = Palette.Alpha(c, alpha), SurroundColors = new[] { Palette.Alpha(c, 0) } })
                    g.FillPath(brush, path);
            }
        }
    }
}

using System;
using System.Collections.Generic;

namespace PumpV
{
    internal enum DrawKind { Rect, Text }

    internal enum TextAlign { Left, Center, Right }

    internal sealed class DrawOp
    {
        public DrawKind Kind;
        public float X, Y, W, H;
        public int Argb;
        public string Text;
        public float Scale;
        public TextAlign Align;
    }

    /// <summary>The bottom tabs, in the order they sit on the screen.</summary>
    internal static class PhoneTabs
    {
        public const string Home = "/ui/home";
        private static readonly string[] Paths = { Home, "/ui/swap", "/ui/wallet", "/ui/history" };

        /// <summary>The tab along from this one, going round at the ends; null if this isn't a tab.</summary>
        public static string Next(string path, int step)
        {
            int from = Array.IndexOf(Paths, path);
            return from >= 0 ? Paths[(from + step + Paths.Length) % Paths.Length] : null;
        }
    }

    /// <summary>
    /// Moves the highlight around a screen the way it looks: up and down between lines,
    /// left and right along a line of buttons, and only ever onto a row that can be picked.
    /// </summary>
    internal static class PhoneNav
    {
        private static bool CanPick(UiRow row) => row.Enabled && row.Action != null;

        /// <summary>The row nearest to the one asked for that can be picked.</summary>
        public static int Settle(UiScreen screen, int wanted)
        {
            int best = -1;
            for (int i = 0; i < screen.Rows.Count; i++)
            {
                if (CanPick(screen.Rows[i]) && (best < 0 || Math.Abs(i - wanted) < Math.Abs(best - wanted))) best = i;
            }
            return best >= 0 ? best : 0;
        }

        /// <summary>Where the highlight belongs after a screen reloads: on the same row if it's
        /// still there, in the same place if the rows are the same, or else where the screen starts.</summary>
        public static int KeepPlace(UiScreen before, int at, UiScreen now)
        {
            if (before == null || at < 0 || at >= before.Rows.Count) return now.Selected;
            int same = now.Rows.FindIndex(r => r.Text == before.Rows[at].Text);
            if (same >= 0) return same;
            return now.Rows.Count == before.Rows.Count ? at : now.Selected;
        }

        public static int Move(UiScreen screen, int from, int dx, int dy)
        {
            List<List<int>> lines = ThemeLayout.GroupIntoLines(screen.Rows);
            if (!Locate(lines, from, out int lineIndex, out int column)) return from;
            List<int> line = lines[lineIndex];

            if (dx != 0)
            {
                for (int c = column + dx; c >= 0 && c < line.Count; c += dx)
                {
                    if (CanPick(screen.Rows[line[c]])) return line[c];
                }
                return from;
            }
            for (int l = lineIndex + dy; l >= 0 && l < lines.Count; l += dy)
            {
                List<int> target = lines[l];
                int same = Math.Min(target.Count - 1, column * target.Count / line.Count); // the same spot across
                if (CanPick(screen.Rows[target[same]])) return target[same];
                foreach (int row in target)
                {
                    if (CanPick(screen.Rows[row])) return row;
                }
            }
            return from;
        }

        private static bool Locate(List<List<int>> lines, int row, out int lineIndex, out int column)
        {
            for (lineIndex = 0; lineIndex < lines.Count; lineIndex++)
            {
                column = lines[lineIndex].IndexOf(row);
                if (column >= 0) return true;
            }
            lineIndex = column = 0;
            return false;
        }
    }

    /// <summary>
    /// Lays out a screen in the pump.fun look as a list of things to draw, with
    /// no game calls, so tests can check it and draw it to an image without GTA V.
    /// ThemePanel draws the result on the phone's own screen.
    /// </summary>
    internal static class ThemeLayout
    {
        // The dark palette from pump.fun's own stylesheet.
        private const int Bg = unchecked((int)0xFF000000);
        private const int Muted = unchecked((int)0xFF141416);
        private const int Muted2 = unchecked((int)0xFF1C1C1F);
        private const int Line = unchecked((int)0xFF1E1E22);
        private const int Line2 = unchecked((int)0xFF2C2C31);
        private const int Text = unchecked((int)0xFFEDEDEF);
        private const int Sub = unchecked((int)0xFF9B9BA2);
        private const int Dim = unchecked((int)0xFF68686F);
        private const int Accent = unchecked((int)0xFF86EFAC);
        private const int OnAccent = unchecked((int)0xFF052E16);
        private const int Down = unchecked((int)0xFFF87171);
        private const int OnDown = unchecked((int)0xFF450A0A);
        private const int Warn = unchecked((int)0xFFEAB308);
        private const int PillWhite = unchecked((int)0xFFF4F4F5);

        private static readonly int[] Avatars =
        {
            unchecked((int)0xFF86EFAC), unchecked((int)0xFFFDA4AF), unchecked((int)0xFF93C5FD), unchecked((int)0xFFFCD34D),
            unchecked((int)0xFFC4B5FD), unchecked((int)0xFF5EEAD4), unchecked((int)0xFFFDBA74), unchecked((int)0xFFF9A8D4),
        };

        /// <summary>The part of the phone's screen the app fills, between its status
        /// bar and softkeys, in units of about one pixel at the phone's normal size.</summary>
        public const float PhoneWidth = 238f;
        public const float PhoneHeight = 280f;

        private const float Pad = 6f;
        private const float TopBar = 26f;
        private const float RowGap = 2f;
        private const float CellGap = 4f;

        /// <summary>Rough width of one character at text scale 1.0. Set a little wide,
        /// so long text is cut short rather than overlapping.</summary>
        private const float CharWidth = 14f;

        public const float TextHeight = 40f; // Rough height of a line at text scale 1.0.

        public static List<DrawOp> Build(UiScreen screen, int selected, string appName, float x, float y, float w, float h)
        {
            var ops = new List<DrawOp>();
            Rect(ops, x, y, w, h, Bg);

            Pill(ops, x + Pad, y + 4, 18);
            Label(ops, appName, x + Pad + 23, y + 3, 0.46f, Text, 80);
            Label(ops, "fan app, not pump.fun", x + w - Pad, y + 8, 0.3f, Dim, 110, TextAlign.Right);
            Rect(ops, x, y + TopBar, w, 1, Line);

            float top = y + TopBar + 3;
            string title = UiText.Clean(screen.Header, 30);
            UiStyle lead = screen.Rows.Count > 0 ? screen.Rows[0].Style : null;
            bool heroNamesIt = lead?.Kind == "coinHero" && lead.Symbol == title;
            if (title.Length > 0 && title != appName && !heroNamesIt)
            {
                Label(ops, title, x + Pad, top, 0.55f, Text, w - 2 * Pad);
                top += 25;
            }

            float bottom = y + h - 2;
            float rowX = x + Pad;
            float rowW = w - 2 * Pad;
            List<UiRow> rows = screen.Rows.Count > 0 ? screen.Rows : new List<UiRow> { new UiRow { Text = "(empty)" } };

            List<List<int>> lines = GroupIntoLines(rows);
            int first = FirstVisible(rows, lines, selected, bottom - top);
            float lineY = top;
            int last = first;
            for (int l = first; l < lines.Count; l++)
            {
                List<int> line = lines[l];
                float rh = RowHeight(rows[line[0]]);
                if (lineY + rh > bottom) break;
                int columns = Columns(rows[line[0]]);
                float cellW = (rowW - (columns - 1) * CellGap) / columns;
                for (int c = 0; c < line.Count; c++)
                {
                    int i = line[c];
                    DrawRow(ops, rows[i], i == selected, rowX + c * (cellW + CellGap), lineY, cellW, rh);
                }
                lineY += rh + RowGap;
                last = l;
            }

            if (first > 0 || last < lines.Count - 1)
                ScrollBar(ops, x + w - 3, top, bottom - top, first, last, lines.Count);
            return ops;
        }

        /// <summary>The app's mark: a capsule on the diagonal, white at the top right and
        /// green at the bottom left. It's drawn a row at a time because the phone's
        /// screen can only draw upright rectangles.</summary>
        private static void Pill(List<DrawOp> ops, float x, float y, int size)
        {
            float half = size / 2f;
            float radius = size * 0.24f;
            float reach = half * 1.2f - radius;
            for (int row = 0; row < size; row++)
            {
                int runStart = 0, runColor = 0;
                for (int col = 0; col <= size; col++)
                {
                    int color = col < size ? PillColor(col + 0.5f - half, row + 0.5f - half, radius, reach) : 0;
                    if (color == runColor) continue;
                    if (runColor != 0) Rect(ops, x + runStart, y + row, col - runStart, 1, runColor);
                    runStart = col;
                    runColor = color;
                }
            }
        }

        /// <summary>The colour of one spot of the pill, or 0 outside it.</summary>
        private static int PillColor(float dx, float dy, float radius, float reach)
        {
            const float Diagonal = 0.7071f;
            float along = (dx - dy) * Diagonal; // towards the top right
            float across = (dx + dy) * Diagonal;
            float nearest = Math.Max(-reach, Math.Min(reach, along));
            float distance = (along - nearest) * (along - nearest) + across * across;
            if (distance > radius * radius || Math.Abs(along) < 0.5f) return 0;
            return along > 0 ? PillWhite : Accent;
        }

        /// <summary>How many of this row fit side by side: amounts sit together
        /// like pump.fun's quick-amount buttons.</summary>
        private static int Columns(UiRow row)
        {
            UiStyle s = row.Style;
            if (s != null && s.Cols > 1) return s.Cols;
            if (s?.Kind != "button") return 1;
            if (s.Tone == "sell" && IsAmount(row.Text, "Sell ")) return 3;
            if (s.Tone == "buy" && IsAmount(row.Text, "Buy ")) return 2;
            return 1;
        }

        private static bool IsAmount(string text, string verb)
        {
            return text.StartsWith(verb) && text.Length > verb.Length && char.IsDigit(text[verb.Length]);
        }

        internal static List<List<int>> GroupIntoLines(List<UiRow> rows)
        {
            var lines = new List<List<int>>();
            for (int i = 0; i < rows.Count; i++)
            {
                List<int> current = lines.Count > 0 ? lines[lines.Count - 1] : null;
                int columns = Columns(rows[i]);
                bool joins = current != null && columns > 1 && current.Count < columns
                    && Columns(rows[current[0]]) == columns && rows[current[0]].Style.Tone == rows[i].Style.Tone;
                if (joins) current.Add(i);
                else lines.Add(new List<int> { i });
            }
            return lines;
        }

        /// <summary>The first line to draw so the selected row is fully on screen.</summary>
        private static int FirstVisible(List<UiRow> rows, List<List<int>> lines, int selected, float space)
        {
            int target = 0;
            for (int l = 0; l < lines.Count; l++)
            {
                if (lines[l].Contains(selected)) target = l;
            }
            int first = 0;
            while (first < target && HeightOf(rows, lines, first, target) > space) first++;
            return first;
        }

        private static float HeightOf(List<UiRow> rows, List<List<int>> lines, int from, int to)
        {
            float sum = 0;
            for (int l = from; l <= to; l++) sum += RowHeight(rows[lines[l][0]]) + RowGap;
            return sum - RowGap;
        }

        private static float RowHeight(UiRow row)
        {
            switch (row.Style?.Kind)
            {
                case "wallet": return 46;
                case "coin": return 42;
                case "coinHero": return 44;
                case "coinPreview": return 44;
                case "progress": return 28;
                case "stat": return 19;
                case "button": return 26;
                case "nav": return 25;
                case "warn": return 18;
                case "field": return 34;
                case "qr": return 222;
                default: return row.Enabled && row.Action != null ? 25 : 19;
            }
        }

        private static void DrawRow(List<DrawOp> ops, UiRow row, bool selected, float x, float y, float w, float h)
        {
            UiStyle s = row.Style;
            bool canSelect = row.Enabled && row.Action != null;
            string text = UiText.Clean(row.Text, 40);

            if (s?.Kind == "button")
            {
                DrawButton(ops, s, text, selected, x, y, w, h);
                return;
            }

            if (s?.Kind == "wallet") Rect(ops, x, y, w, h, Muted);
            else if (selected && canSelect) Rect(ops, x, y, w, h, Muted);
            if (selected && canSelect) Rect(ops, x, y, 3, h, Accent);

            switch (s?.Kind)
            {
                case "wallet":
                    Label(ops, "Wallet", x + 8, y + 3, 0.3f, Sub, 80);
                    Label(ops, s.Sol, x + 8, y + 15, 0.62f, Text, w - 80);
                    if (s.Usd.Length > 0) Label(ops, s.Usd, x + w - 8, y + 21, 0.42f, Sub, 70, TextAlign.Right);
                    break;

                case "coin":
                    Avatar(ops, s, x + 5, y + 5, 30);
                    float nameX = x + 40;
                    float mcWidth = 62;
                    Label(ops, s.Name.Length > 0 ? s.Name : s.Symbol, nameX, y + 3, 0.46f, Text, w - 40 - mcWidth);
                    string detail = s.Graduated ? (s.Detail.Length > 0 ? s.Detail + " - graduated" : "graduated") : s.Detail;
                    if (detail.Length == 0 && s.Name.Length > 0) detail = s.Symbol;
                    Label(ops, detail, nameX, y + 21, 0.33f, Dim, w - 40 - mcWidth);
                    if (s.MarketCap.Length > 0)
                    {
                        Label(ops, s.ValueLabel, x + w - 5, y + 3, 0.28f, Dim, mcWidth, TextAlign.Right);
                        Label(ops, s.MarketCap, x + w - 5, y + 14, 0.44f, Text, mcWidth, TextAlign.Right);
                    }
                    if (s.Pct >= 0 && !s.Graduated) Bar(ops, nameX, y + h - 5, w - 40 - 5, 3, s.Pct);
                    Rect(ops, x, y + h, w, 1, Line);
                    break;

                case "coinHero":
                    Avatar(ops, s, x + 2, y + 4, 36);
                    float mcW = s.MarketCap.Length > 0 ? 76 : 0;
                    Label(ops, s.Name.Length > 0 ? s.Name : s.Symbol, x + 44, y + 4, 0.52f, Text, w - 44 - mcW);
                    bool addressOnly = s.Name.Length == 0 || s.Symbol == s.Address;
                    Label(ops, addressOnly ? s.Address : s.Symbol + " - " + s.Address, x + 44, y + 24, 0.33f, Dim, w - 44 - mcW);
                    if (s.MarketCap.Length > 0)
                    {
                        Label(ops, "Market cap", x + w - 2, y + 4, 0.28f, Sub, mcW, TextAlign.Right);
                        Label(ops, s.MarketCap, x + w - 2, y + 16, 0.5f, Text, mcW, TextAlign.Right);
                    }
                    Rect(ops, x, y + h, w, 1, Line);
                    break;

                case "coinPreview":
                    // The phone's own screen can't show a photo, so its first letter stands in.
                    Avatar(ops, s, x + 2, y + 4, 36);
                    Label(ops, s.Name, x + 44, y + 4, 0.52f, Text, w - 44);
                    Label(ops, s.Symbol, x + 44, y + 24, 0.33f, Dim, w - 44);
                    break;

                case "progress":
                    Label(ops, s.Label, x + 3, y + 2, 0.36f, Sub, w - 50);
                    Label(ops, (s.Pct >= 10 ? s.Pct.ToString("0") : s.Pct.ToString("0.0")) + "%", x + w - 3, y + 2, 0.36f, Accent, 50, TextAlign.Right);
                    Bar(ops, x + 3, y + 20, w - 6, 4, Math.Max(0, s.Pct));
                    break;

                case "stat":
                    Label(ops, s.Label, x + 3, y + 1, 0.36f, Sub, w * 0.42f);
                    Label(ops, s.Value, x + w - 3, y + 1, 0.36f, Text, w * 0.56f, TextAlign.Right);
                    break;

                case "nav":
                    if (s.Label.Length > 0)
                    {
                        Label(ops, s.Label, x + 8, y + 3, 0.44f, Text, w * 0.4f);
                        Label(ops, s.Value, x + w - 15, y + 5, 0.36f, Sub, w * 0.5f, TextAlign.Right);
                    }
                    else
                    {
                        Label(ops, text, x + 8, y + 3, 0.44f, Text, w - 24);
                    }
                    if (canSelect) Label(ops, ">", x + w - 5, y + 3, 0.44f, Dim, 12, TextAlign.Right);
                    break;

                case "warn":
                    Label(ops, text, x + 3, y + 2, 0.34f, Warn, w - 6);
                    break;

                case "field":
                    Rect(ops, x, y, w, h, Muted);
                    Rect(ops, x, y + h - 2, w, 2, Accent);
                    Label(ops, s.Value + "_", x + 8, y + 7, 0.55f, Text, w - 12);
                    break;

                case "qr":
                    DrawQr(ops, s.Modules, x, y, w, h);
                    break;

                default:
                    if (canSelect)
                    {
                        Label(ops, text, x + 8, y + 3, 0.44f, Text, w - 24);
                        Label(ops, ">", x + w - 5, y + 3, 0.44f, Dim, 12, TextAlign.Right);
                    }
                    else
                    {
                        Label(ops, text, x + 3, y + 1, 0.36f, Sub, w - 6);
                    }
                    break;
            }
        }

        private static void DrawButton(List<DrawOp> ops, UiStyle s, string text, bool selected, float x, float y, float w, float h)
        {
            int fill, ink;
            switch (s.Tone)
            {
                case "buy":
                case "primary": fill = Accent; ink = OnAccent; break;
                case "sell": fill = Down; ink = OnDown; break;
                default: fill = Muted2; ink = Text; break;
            }
            if (selected) Rect(ops, x - 2, y - 2, w + 4, h + 4, Text);
            Rect(ops, x, y, w, h, fill);
            Label(ops, text, x + w / 2, y + 4, 0.44f, ink, w - 6, TextAlign.Center);
        }

        /// <summary>A QR code on white, with the blank margin scanners need.</summary>
        private static void DrawQr(List<DrawOp> ops, List<string> modules, float x, float y, float w, float h)
        {
            const int Margin = 4;
            int size = modules.Count;
            if (size == 0) return;
            float cell = (float)Math.Floor(Math.Min(w, h) / (size + 2 * Margin));
            float side = cell * (size + 2 * Margin);
            float left = x + (w - side) / 2;
            Rect(ops, left, y, side, side, PillWhite);
            for (int row = 0; row < size; row++)
            {
                string line = modules[row];
                for (int col = 0; col < line.Length; col++)
                {
                    if (line[col] != '1') continue;
                    int start = col;
                    while (col + 1 < line.Length && line[col + 1] == '1') col++;
                    Rect(ops, left + (Margin + start) * cell, y + (Margin + row) * cell, (col - start + 1) * cell, cell, Bg);
                }
            }
        }

        private static void Avatar(List<DrawOp> ops, UiStyle s, float x, float y, float size)
        {
            uint hash = 7;
            foreach (char c in s.Mint) hash = unchecked(hash * 31 + c);
            Rect(ops, x, y, size, size, Avatars[hash % (uint)Avatars.Length]);
            string letter = UiText.Clean(s.Symbol, 12).TrimStart('$');
            if (letter.Length > 0)
                Label(ops, letter.Substring(0, 1).ToUpperInvariant(), x + size / 2, y + size * 0.18f, size / 60f, OnAccent, size, TextAlign.Center);
        }

        private static void Bar(List<DrawOp> ops, float x, float y, float w, float h, double pct)
        {
            Rect(ops, x, y, w, h, Muted2);
            float fill = (float)(w * Math.Max(0, Math.Min(100, pct)) / 100);
            if (fill > 0) Rect(ops, x, y, fill, h, Accent);
        }

        private static void ScrollBar(List<DrawOp> ops, float x, float y, float h, int first, int last, int count)
        {
            Rect(ops, x, y, 2, h, Line);
            float each = h / count;
            Rect(ops, x, y + first * each, 2, Math.Max(12, (last - first + 1) * each), Line2);
        }

        private static void Rect(List<DrawOp> ops, float x, float y, float w, float h, int argb)
        {
            ops.Add(new DrawOp { Kind = DrawKind.Rect, X = x, Y = y, W = w, H = h, Argb = argb });
        }

        private static void Label(List<DrawOp> ops, string text, float x, float y, float scale, int argb, float maxWidth, TextAlign align = TextAlign.Left)
        {
            string fitted = Fit(text, scale, maxWidth);
            if (fitted.Length == 0) return;
            ops.Add(new DrawOp { Kind = DrawKind.Text, X = x, Y = y, Text = fitted, Scale = scale, Argb = argb, Align = align });
        }

        private static string Fit(string text, float scale, float maxWidth)
        {
            string clean = UiText.Clean(text, 60);
            int max = Math.Max(3, (int)(maxWidth / (scale * CharWidth)));
            return clean.Length > max ? clean.Substring(0, max - 2).TrimEnd() + ".." : clean;
        }
    }
}

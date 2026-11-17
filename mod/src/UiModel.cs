using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Web.Script.Serialization;

namespace PumpV
{
    // The phone UI is server-driven: the companion sends screens (a header and
    // rows), and each row may carry an action. These types mirror ui.ts.

    internal sealed class UiAction
    {
        public string Kind = "";
        public string Path = "";
        public string Title = "";
        public string Hint = "";
        public string Initial = "";
        public string Field = "";
        public int MaxLength = 32;
        public bool Quiet; // a post that leaves the screen up while it runs
        public Dictionary<string, object> Body = new Dictionary<string, object>();
    }

    /// <summary>How a row looks in the themed panel; mirrors RowStyle in ui.ts.</summary>
    internal sealed class UiStyle
    {
        public string Kind = "";
        public string Mint = "";
        public string Symbol = "";
        public string Name = "";
        public string MarketCap = "";
        public string ValueLabel = "MC";
        public string Detail = "";
        public string Address = "";
        public string Label = "";
        public string Value = "";
        public string Tone = "";
        public string Sol = "";
        public string Usd = "";
        public double Pct = -1; // -1 = no progress to show
        public bool Graduated;
        public List<string> Modules = new List<string>(); // a QR code's rows, as 0s and 1s
        public string Image = ""; // a file in the images folder
        public string Glyph = ""; // which icon the phone draws
        public string Badge = "";
        public int Cols; // how many rows share this line
        public int Span; // how much of the line this one takes, out of 12
        public string Part = ""; // the card this row belongs to
        public string Logo = ""; // a token's logo, from the token list
        public bool Verified;
        public string Change = "";
        public bool Up;
    }

    internal sealed class UiRow
    {
        public string Text = "";
        public int Icon;
        public bool Enabled;
        public UiAction Action;
        public UiStyle Style;
    }

    internal sealed class UiScreen
    {
        public string Path = "";
        public string Header = "";
        public List<UiRow> Rows = new List<UiRow>();
        public int Selected;
        public int RefreshMs;
        public bool Tab; // one of the bottom tabs

        public bool CanRefresh => !string.IsNullOrEmpty(Path);
    }

    internal sealed class UiResponse
    {
        public string Nav = "none";
        public UiScreen Screen;
        public string ToastText;
        public string ToastLevel = "info";
    }

    /// <summary>What shows while the player types a password: stars and how many.
    /// The typed text itself never gets near a screen.</summary>
    internal static class SecretScreen
    {
        private const int MaxStars = 24;

        public static UiScreen Build(string title, string hint, int typed)
        {
            var s = new UiScreen { Header = title };
            s.Rows.Add(new UiRow { Text = Stars(typed), Style = new UiStyle { Kind = "field", Value = Stars(typed) } });
            s.Rows.Add(new UiRow { Text = hint });
            s.Rows.Add(new UiRow { Text = typed == 1 ? "1 character" : typed + " characters" });
            return s;
        }

        public static string Stars(int typed) => new string('*', Math.Min(typed, MaxStars));
    }

    internal static class UiText
    {
        /// <summary>Strips GTA formatting codes (~x~) and control characters
        /// from text that came from outside the game.</summary>
        public static string Clean(string s, int max)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length);
            foreach (char c in s)
            {
                if (c == '~' || char.IsControl(c)) continue;
                sb.Append(c);
            }
            string r = sb.ToString().Trim();
            return r.Length > max ? r.Substring(0, Math.Max(1, max - 2)) + ".." : r;
        }
    }

    internal static class UiJson
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer { MaxJsonLength = 4 * 1024 * 1024 };

        public static string Serialize(object value) => Serializer.Serialize(value);

        /// <summary>A screen in the shape the phone page reads, the same one ui.ts sends.</summary>
        public static Dictionary<string, object> ForPage(UiScreen screen)
        {
            var rows = new List<object>();
            foreach (UiRow row in screen.Rows)
            {
                var r = new Dictionary<string, object>
                {
                    { "text", row.Text },
                    { "icon", row.Icon },
                    { "enabled", row.Enabled && row.Action != null },
                };
                if (row.Action != null) r["action"] = new Dictionary<string, object> { { "kind", row.Action.Kind } };
                if (row.Style != null) r["style"] = StyleForPage(row.Style);
                rows.Add(r);
            }
            return new Dictionary<string, object>
            {
                { "header", screen.Header },
                { "path", screen.Path },
                { "tab", screen.Tab },
                { "rows", rows },
            };
        }

        private static Dictionary<string, object> StyleForPage(UiStyle s)
        {
            var o = new Dictionary<string, object> { { "kind", s.Kind } };
            void Text(string key, string value)
            {
                if (!string.IsNullOrEmpty(value)) o[key] = value;
            }
            Text("mint", s.Mint);
            Text("symbol", s.Symbol);
            Text("name", s.Name);
            Text("marketCap", s.MarketCap);
            Text("valueLabel", s.ValueLabel);
            Text("detail", s.Detail);
            Text("address", s.Address);
            Text("label", s.Label);
            Text("value", s.Value);
            Text("tone", s.Tone);
            Text("sol", s.Sol);
            Text("usd", s.Usd);
            Text("image", s.Image);
            Text("glyph", s.Glyph);
            Text("badge", s.Badge);
            Text("part", s.Part);
            Text("logo", s.Logo);
            Text("change", s.Change);
            if (s.Cols > 0) o["cols"] = s.Cols;
            if (s.Span > 0) o["span"] = s.Span;
            if (s.Verified) o["verified"] = true;
            if (s.Up) o["up"] = true;
            if (s.Pct >= 0) o[s.Kind == "progress" ? "pct" : "progressPct"] = s.Pct;
            if (s.Graduated) o["graduated"] = true;
            if (s.Modules.Count > 0) o["modules"] = s.Modules;
            return o;
        }

        public static Dictionary<string, object> Object(string json)
        {
            return Serializer.DeserializeObject(json) as Dictionary<string, object> ?? new Dictionary<string, object>();
        }

        public static UiResponse ParseResponse(string json)
        {
            var o = Object(json);
            var r = new UiResponse { Nav = Str(o, "nav", "none") };
            if (o.TryGetValue("screen", out var s) && s is Dictionary<string, object> sd)
                r.Screen = ParseScreen(sd);
            if (o.TryGetValue("toast", out var t) && t is Dictionary<string, object> td)
            {
                r.ToastText = Str(td, "text", "");
                r.ToastLevel = Str(td, "level", "info");
            }
            return r;
        }

        private static UiScreen ParseScreen(Dictionary<string, object> o)
        {
            var s = new UiScreen
            {
                Path = Str(o, "path", ""),
                Header = Str(o, "header", ""),
                Selected = Int(o, "selected", 0),
                RefreshMs = Int(o, "refreshMs", 0),
                Tab = Bool(o, "tab", false),
            };
            if (o.TryGetValue("rows", out var rows) && rows is IEnumerable list && !(rows is string))
            {
                foreach (var item in list)
                {
                    if (!(item is Dictionary<string, object> ro)) continue;
                    var row = new UiRow
                    {
                        Text = Str(ro, "text", ""),
                        Icon = Int(ro, "icon", 0),
                        Enabled = Bool(ro, "enabled", false),
                    };
                    if (ro.TryGetValue("action", out var a) && a is Dictionary<string, object> ao)
                        row.Action = ParseAction(ao);
                    if (ro.TryGetValue("style", out var st) && st is Dictionary<string, object> so)
                        row.Style = ParseStyle(so);
                    s.Rows.Add(row);
                }
            }
            return s;
        }

        private static UiAction ParseAction(Dictionary<string, object> o)
        {
            var a = new UiAction
            {
                Kind = Str(o, "kind", ""),
                Path = Str(o, "path", ""),
                Title = Str(o, "title", ""),
                Hint = Str(o, "hint", ""),
                Initial = Str(o, "initial", ""),
                Field = Str(o, "field", ""),
                MaxLength = Math.Max(1, Math.Min(200, Int(o, "maxLength", 32))),
                Quiet = Bool(o, "quiet", false),
            };
            if (o.TryGetValue("body", out var b) && b is Dictionary<string, object> bd)
                a.Body = bd;
            return a;
        }

        private static UiStyle ParseStyle(Dictionary<string, object> o)
        {
            string kind = Str(o, "kind", "");
            double pct = -1;
            if (o.TryGetValue(kind == "progress" ? "pct" : "progressPct", out var p) && p != null)
            {
                try { pct = Math.Max(0, Math.Min(100, Convert.ToDouble(p, CultureInfo.InvariantCulture))); }
                catch { pct = -1; }
            }
            var modules = new List<string>();
            if (o.TryGetValue("modules", out var m) && m is IEnumerable lines && !(m is string))
            {
                foreach (var line in lines)
                {
                    if (line is string text) modules.Add(text);
                }
            }
            return new UiStyle
            {
                Modules = modules,
                Image = Str(o, "image", ""),
                Glyph = Str(o, "glyph", ""),
                Badge = Str(o, "badge", ""),
                Cols = Int(o, "cols", 0),
                Span = Int(o, "span", 0),
                Part = Str(o, "part", ""),
                Logo = Str(o, "logo", ""),
                Verified = Bool(o, "verified", false),
                Change = Str(o, "change", ""),
                Up = Bool(o, "up", false),
                Kind = kind,
                Mint = Str(o, "mint", ""),
                Symbol = Str(o, "symbol", ""),
                Name = Str(o, "name", ""),
                MarketCap = Str(o, "marketCap", ""),
                ValueLabel = Str(o, "valueLabel", "MC"),
                Detail = Str(o, "detail", ""),
                Address = Str(o, "address", ""),
                Label = Str(o, "label", ""),
                Value = Str(o, "value", ""),
                Tone = Str(o, "tone", ""),
                Sol = Str(o, "sol", ""),
                Usd = Str(o, "usd", ""),
                Pct = pct,
                Graduated = Bool(o, "graduated", false),
            };
        }

        private static string Str(Dictionary<string, object> o, string key, string def)
        {
            return o.TryGetValue(key, out var v) && v is string s ? s : def;
        }

        private static int Int(Dictionary<string, object> o, string key, int def)
        {
            if (!o.TryGetValue(key, out var v) || v == null) return def;
            try { return Convert.ToInt32(v); } catch { return def; }
        }

        private static bool Bool(Dictionary<string, object> o, string key, bool def)
        {
            return o.TryGetValue(key, out var v) && v is bool b ? b : def;
        }
    }
}

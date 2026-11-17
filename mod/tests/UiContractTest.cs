// Contract test: parses JSON written by the companion (companion/test/fixtures.ts)
// with the mod's own UiModel.cs and checks nothing is lost on the way.
//
//   node companion/dist/test/fixtures.js /tmp/fx
//   mcs -r:System.Web.Extensions -out:/tmp/contract.exe mod/src/UiModel.cs mod/src/ThemeLayout.cs mod/src/KeyText.cs mod/tests/UiContractTest.cs
//   mono /tmp/contract.exe /tmp/fx
using System;
using System.IO;
using System.Linq;
using PumpV;

internal static class UiContractTest
{
    private static int _failures;

    private static void Check(bool ok, string what)
    {
        Console.WriteLine((ok ? "  ok   " : "  FAIL ") + what);
        if (!ok) _failures++;
    }

    // Selection shows as a green bar on rows, or a light outline around buttons.
    private static bool HasHighlight(System.Collections.Generic.List<DrawOp> ops)
    {
        const int accent = unchecked((int)0xFF86EFAC);
        const int outline = unchecked((int)0xFFEDEDEF);
        return ops.Any(o => o.Kind == DrawKind.Rect && ((o.Argb == accent && o.W == 3) || (o.Argb == outline && o.H >= 30)));
    }

    private static UiScreen swap0(string dir) => Load(dir, "swapQuoted").Screen;

    private static UiResponse Load(string dir, string name)
    {
        return UiJson.ParseResponse(File.ReadAllText(Path.Combine(dir, name + ".json")));
    }

    private static int Main(string[] args)
    {
        string dir = args.Length > 0 ? args[0] : "fixtures";

        var home = Load(dir, "home");
        Check(home.Nav == "push" && home.Screen != null, "home: push with a screen");
        Check(home.Screen.Path == "/ui/home" && home.Screen.CanRefresh, "home: refreshable path");
        Check(home.Screen.Rows.Count >= 6, "home: rows parsed (" + home.Screen.Rows.Count + ")");
        Check(home.Screen.Rows[1].Action.Kind == "open" && home.Screen.Rows[1].Action.Path == "/ui/list?kind=trending", "home: open action + path");
        Check(home.Screen.Rows[1].Style.Glyph == "bars", "home: a row's icon");
        Check(home.Screen.Tab, "home: is a tab");
        Check(home.Screen.Rows[0].Action.Kind == "tab" && home.Screen.Rows[0].Action.Path == "/ui/wallet", "home: the wallet card opens the Wallet tab");
        var find = home.Screen.Rows.First(r => r.Action != null && r.Action.Kind == "input");
        Check(find.Action.MaxLength == 44 && find.Action.Field == "mint" && find.Action.Path == "/ui/search", "home: input action fields");
        Check(home.Screen.RefreshMs == 30000, "home: refreshMs");

        var token = Load(dir, "token");
        Check(!token.Screen.Rows[0].Enabled && token.Screen.Rows[0].Action == null, "token: info rows are disabled");
        Check(token.Screen.Selected == 4 && token.Screen.Rows[4].Text == "Buy 0.01 SOL", "token: selected index");
        var buy = token.Screen.Rows[4].Action;
        Check(buy.Kind == "post" && buy.Path == "/ui/quote/buy" && buy.Body.ContainsKey("mint") && buy.Body.ContainsKey("sol"), "token: post body keys");
        Check(Convert.ToDouble(buy.Body["sol"]) == 0.01, "token: numeric body survives (" + buy.Body["sol"] + ")");
        var custom = token.Screen.Rows.First(r => r.Text == "Buy other amount").Action;
        Check(custom.Kind == "input" && custom.Body.ContainsKey("mint") && custom.Field == "sol", "token: input carries a body");
        Check(token.Screen.Rows.Any(r => r.Text == "Sell 100%"), "token: sell rows when holding");
        Check(token.Screen.Rows.All(r => r.Icon >= 0 && r.Icon < 100), "token: icon ids");

        var launch = Load(dir, "launch");
        var photo = launch.Screen.Rows.First(r => r.Action != null && r.Action.Kind == "photo").Action;
        Check(photo.Path == "/ui/launch/set" && photo.Field == "value" && (string)photo.Body["field"] == "image", "launch: photo action");
        var name = launch.Screen.Rows.First(r => r.Text.StartsWith("Name")).Action;
        Check(name.Kind == "input" && name.Initial == "" && name.MaxLength == 32, "launch: input initial + maxLength");
        var ready = Load(dir, "launchReady").Screen;
        Check(ready.Rows[0].Style.Kind == "coinPreview" && ready.Rows[0].Style.Image == "coin-fixture.png" && ready.Rows[0].Style.Name == "Downtown" && ready.Rows[0].Style.Symbol == "$DTWN", "launch: the coin card shows the photo, name and ticker");
        var readyPage = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.List<object>)UiJson.ForPage(ready)["rows"])[0])["style"];
        Check(readyPage["image"] as string == "coin-fixture.png", "launch: the photo reaches the phone window");
        Check(ready.Rows[ready.Selected].Text == "Review", "launch: with everything set, the highlight waits on Review");
        Check(Load(dir, "launchConfirm").Screen.Rows[0].Style.Image == "coin-fixture.png", "launch: the confirm screen shows the photo too");

        var offline = Load(dir, "listOffline");
        Check(offline.Screen.Rows.Any(r => r.Action != null && r.Action.Kind == "refresh"), "list: refresh action");

        var error = Load(dir, "error");
        Check(error.Nav == "none" && error.Screen == null && error.ToastLevel == "error" && error.ToastText.Length > 0, "error: toast only");

        var confirm = Load(dir, "confirm");
        Check(confirm.Screen.Path == "" && !confirm.Screen.CanRefresh, "confirm: never refreshed");
        Check(confirm.Screen.Rows[confirm.Screen.Selected].Text == "Cancel", "confirm: highlight on Cancel");
        Check(confirm.Screen.Rows[confirm.Screen.Selected].Action.Kind == "back", "confirm: cancel is back");

        var result = Load(dir, "result");
        Check(result.Nav == "replace" && result.ToastLevel == "success", "result: replace + success toast");

        // Styles for the themed panel.
        var hero = token.Screen.Rows[0].Style;
        Check(hero != null && hero.Kind == "coinHero" && hero.MarketCap.StartsWith("$") && hero.Mint.Length > 30, "style: coin page header");
        var curve = token.Screen.Rows[1].Style;
        Check(curve != null && curve.Kind == "progress" && curve.Pct > 0 && curve.Pct < 100, "style: bonding curve progress (" + curve?.Pct + ")");
        Check(buy != null && token.Screen.Rows[4].Style.Kind == "button" && token.Screen.Rows[4].Style.Tone == "buy", "style: buy button");
        Check(token.Screen.Rows.Any(r => r.Style != null && r.Style.Tone == "sell"), "style: sell button");
        var wallet = home.Screen.Rows[0].Style;
        Check(wallet != null && wallet.Kind == "wallet" && wallet.Sol.EndsWith("SOL") && wallet.Usd.StartsWith("$"), "style: wallet card");
        var coinRow = Load(dir, "trending").Screen.Rows.First(r => r.Style?.Pct >= 0).Style;
        Check(coinRow.Kind == "coin" && coinRow.Symbol.StartsWith("$"), "style: coin row");
        Check(confirm.Screen.Rows[confirm.Screen.Selected].Style.Tone == "plain", "style: Cancel is the plain button");

        // The wallet's screens.
        var welcome = Load(dir, "welcome").Screen;
        var create = welcome.Rows.First(r => r.Text == "Create wallet").Action;
        Check(create.Kind == "secret" && create.Path == "/ui/setup/password" && create.Field == "password" && create.Hint.Contains("10") && create.MaxLength == 64, "wallet: create asks for a password");
        Check(welcome.Rows[welcome.Selected].Text == "Create wallet", "wallet: highlight starts on Create wallet");
        var unlock = Load(dir, "unlock").Screen;
        Check(unlock.Rows.First(r => r.Text == "Enter password").Action.Path == "/ui/unlock", "wallet: unlock asks for a password");
        var qr = Load(dir, "deposit").Screen.Rows[0].Style;
        Check(qr.Kind == "qr" && qr.Modules.Count == 29 && qr.Modules.All(m => m.Length == 29), "wallet: QR code survives (" + qr.Modules.Count + " rows)");
        var qrOps = ThemeLayout.Build(Load(dir, "deposit").Screen, 0, "PUMP", 0, 0, ThemeLayout.PhoneWidth, ThemeLayout.PhoneHeight);
        const int black = unchecked((int)0xFF000000);
        float qrCell = qrOps.Where(o => o.Kind == DrawKind.Rect && o.Argb == black).Min(o => o.H);
        Check(qrCell >= 4, "wallet: QR squares are big enough to scan (" + qrCell + ")");

        // What the phone window is sent, in the shape the companion's own screens have.
        var page = UiJson.ForPage(Load(dir, "token").Screen);
        var pageRows = (System.Collections.Generic.List<object>)page["rows"];
        var pageHero = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)pageRows[0])["style"];
        Check((string)page["path"] != "" && pageHero["kind"] as string == "coinHero" && pageHero.ContainsKey("mint"), "window: coin header reaches the page");
        var pageCurve = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)pageRows[1])["style"];
        Check(pageCurve.ContainsKey("pct") && !pageCurve.ContainsKey("progressPct"), "window: progress bar keeps its value");
        var pageNav = UiJson.ForPage(Load(dir, "home").Screen);
        var navStyle = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.List<object>)pageNav["rows"])[1])["style"];
        Check(!navStyle.ContainsKey("label"), "window: empty fields are left out, so the row's text shows");
        var pageQr = UiJson.ForPage(Load(dir, "deposit").Screen);
        var qrStyle = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.List<object>)pageQr["rows"])[0])["style"];
        Check(((System.Collections.Generic.List<string>)qrStyle["modules"]).Count == 29, "window: QR code reaches the page");

        // Moving the highlight the way the screen looks.
        var nav = token.Screen;
        int Row(UiScreen s, string text) => s.Rows.FindIndex(r => r.Text == text);
        int buy1 = Row(nav, "Buy 0.01 SOL"), buy2 = Row(nav, "Buy 0.05 SOL"), buy3 = Row(nav, "Buy 0.1 SOL"), buy4 = Row(nav, "Buy 0.25 SOL");
        Check(PhoneNav.Move(nav, buy1, 1, 0) == buy2, "nav: right along a line of buttons");
        Check(PhoneNav.Move(nav, buy1, 0, 1) == buy3 && PhoneNav.Move(nav, buy2, 0, 1) == buy4, "nav: down keeps the column");
        Check(PhoneNav.Move(nav, buy4, 0, 1) == Row(nav, "Buy other amount"), "nav: down onto a wide button");
        Check(PhoneNav.Move(nav, Row(nav, "Buy other amount"), 0, 1) == Row(nav, "Sell 25%"), "nav: down onto a line of three");
        var reloaded = Load(dir, "swap").Screen;
        int review = Row(swap0(dir), "Review swap");
        Check(PhoneNav.KeepPlace(swap0(dir), review, swap0(dir)) == review, "reload: stays on the same row");
        Check(PhoneNav.KeepPlace(swap0(dir), review, reloaded) == reloaded.Selected, "reload: that row's gone and the rows moved, so back to the start");
        Check(PhoneNav.KeepPlace(nav, buy2, nav) == buy2 && PhoneNav.KeepPlace(null, 3, nav) == nav.Selected, "reload: keeps a row, or starts where the screen starts");
        Check(PhoneNav.Move(nav, buy1, 0, -1) == buy1, "nav: up stops at the first thing to pick, not on info rows");
        Check(PhoneNav.Move(nav, buy1, -1, 0) == buy1 && PhoneNav.Move(nav, buy2, -1, 0) == buy1, "nav: left stops at the left edge");
        var walletNav = Load(dir, "wallet").Screen;
        int send = Row(walletNav, "Send");
        Check(walletNav.Tab && PhoneNav.Settle(walletNav, walletNav.Selected) == send, "wallet: a tab, starting on Send");
        Check(PhoneNav.Move(walletNav, send, 1, 0) == Row(walletNav, "Swap"), "wallet: right along its four buttons");
        Check(PhoneNav.Move(walletNav, Row(walletNav, "Settings"), 1, 0) == Row(walletNav, "Settings"), "wallet: right stops at the last button; it never leaves the screen");
        Check(PhoneNav.Move(walletNav, send, 0, -1) == 0, "wallet: up to the address, to copy it");
        Check(walletNav.Rows[PhoneNav.Move(walletNav, send, 0, 1)].Style.Kind == "asset", "wallet: down skips the heading to the first token");
        Check(walletNav.Rows.First(r => r.Style?.Kind == "asset").Style.Logo.StartsWith("https://"), "wallet: token logos arrive");
        Check(Load(dir, "wallet").Screen.Rows.First(r => r.Text == "Swap").Action.Kind == "tab", "wallet: its Swap button opens the tab");
        Check(!Load(dir, "settings").Screen.Tab && !Load(dir, "swapPick").Screen.Tab && !Load(dir, "token").Screen.Tab, "screens inside a tab are not tabs");
        var settings = Load(dir, "settings").Screen;
        Check(settings.Rows[settings.Selected].Style.Glyph == "copy", "settings: starts on the first thing to do, not a heading");
        Check(settings.Rows.First(r => r.Text == "Reset wallet").Style.Tone == "danger", "settings: reset stands out");
        Check(settings.Rows.Any(r => r.Text == "Export private key") && settings.Rows.Any(r => r.Text == "Lock wallet"), "settings: export and lock");
        var resetting = Load(dir, "reset").Screen;
        Check(resetting.Rows[resetting.Selected].Text == "Cancel", "reset: starts on Cancel");
        Check(resetting.Rows.First(r => r.Text == "Reset wallet").Action.Kind == "secret", "reset: asks for the password");
        Check(Load(dir, "raiseLimit").Screen.Rows.First(r => r.Text == "Enter password").Action.Kind == "secret", "limits: raising one asks for the password");
        var listed = Load(dir, "trending").Screen.Rows.First(r => r.Style?.Kind == "coin" && r.Style.Change != "").Style;
        Check(listed.Change.StartsWith("+") || listed.Change.StartsWith("-"), "lists: a coin's change arrives (" + listed.Change + ")");
        Check(PhoneTabs.Next(PhoneTabs.Home, 1) == "/ui/swap" && PhoneTabs.Next("/ui/swap", -1) == PhoneTabs.Home, "tabs: in order");
        Check(PhoneTabs.Next(PhoneTabs.Home, -1) == "/ui/history" && PhoneTabs.Next("/ui/history", 1) == PhoneTabs.Home, "tabs: go round at both ends");
        Check(PhoneTabs.Next("/ui/token", 1) == null, "tabs: only from a tab");

        // Swap: the form moves the way it looks.
        var swap = Load(dir, "swapQuoted").Screen;
        int pay = swap.Rows.FindIndex(r => r.Style?.Kind == "swapAmount");
        int payPill = swap.Rows.FindIndex(r => r.Style?.Kind == "tokenPill");
        int getPill = swap.Rows.FindLastIndex(r => r.Style?.Kind == "tokenPill");
        int half = Row(swap, "50%"), all = Row(swap, "100%"), flip = Row(swap, "Flip");
        Check(payPill == pay + 1 && PhoneNav.Move(swap, pay, 1, 0) == payPill, "swap: right from the amount to its token");
        Check(PhoneNav.Move(swap, payPill, 1, 0) == payPill, "swap: right stops at the token; it never leaves the screen");
        Check(PhoneNav.Move(swap, pay, 0, 1) == half && PhoneNav.Move(swap, half, 1, 0) == all, "swap: down to 50%, along to 100%");
        Check(PhoneNav.Move(swap, half, 0, 1) == flip && PhoneNav.Move(swap, flip, 0, 1) == getPill, "swap: down through flip to the other token");
        Check(PhoneNav.Move(swap, getPill, 0, 1) == Row(swap, "Review swap"), "swap: then on to Review");
        Check(swap.Rows[swap.Selected].Text == "Review swap", "swap: with a quote, starts on Review");
        Check(swap.Rows[half].Action.Quiet && swap.Rows[flip].Action.Quiet, "swap: 50% and flip leave the screen up");
        Check(!swap.Rows[Row(swap, "Review swap")].Action.Quiet, "swap: Review shows it's working");
        Check(swap.Rows[pay].Style.Part == "pay" && swap.Rows[pay].Style.Span == 6 && swap.Rows[pay].Style.Cols == 2, "swap: card and column sizes arrive");
        var pageSwap = UiJson.ForPage(swap);
        Check((bool)pageSwap["tab"], "window: told it's a tab");
        var pagePay = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.List<object>)pageSwap["rows"])[pay])["style"];
        Check((string)pagePay["part"] == "pay" && (int)pagePay["span"] == 6, "window: sizes reach the page");
        var pageWalletRows = (System.Collections.Generic.List<object>)UiJson.ForPage(walletNav)["rows"];
        var pageAsset = (System.Collections.Generic.Dictionary<string, object>)((System.Collections.Generic.Dictionary<string, object>)pageWalletRows[walletNav.Rows.FindIndex(r => r.Style?.Kind == "asset")])["style"];
        Check(((string)pageAsset["logo"]).StartsWith("https://") && (bool)pageAsset["verified"] && pageAsset.ContainsKey("change"), "window: logo, tick and change reach the page");
        var picked = UiJson.ParseResponse("{\"nav\":\"back\",\"screen\":{\"path\":\"/ui/swap\",\"header\":\"Swap\",\"rows\":[]}}");
        Check(picked.Nav == "back" && picked.Screen != null, "swap: picking a token goes back with the new form");
        var deposit = Load(dir, "deposit").Screen;
        int copyRow = PhoneNav.Settle(deposit, 0);
        Check(deposit.Rows[copyRow].Text == "Copy address" && PhoneNav.Move(deposit, copyRow, 0, -1) == copyRow, "nav: up from the only button stays put");

        // Typing a password shows stars and nothing else of it.
        var typing = SecretScreen.Build("Choose a password", "At least 10 characters", 3);
        var typingOps = ThemeLayout.Build(typing, 0, "PUMP", 0, 0, ThemeLayout.PhoneWidth, ThemeLayout.PhoneHeight);
        Check(typingOps.Any(o => o.Kind == DrawKind.Text && o.Text == "***_"), "password: three stars");
        Check(typingOps.Any(o => o.Kind == DrawKind.Text && o.Text == "3 characters"), "password: says how many");
        Check(SecretScreen.Stars(200).Length == 24, "password: stars stop before they overflow");
        if (Environment.OSVersion.Platform == PlatformID.Win32NT)
        {
            string letter = KeyText.Translate(0x41, false, false, false);
            Check(letter.Equals("a", StringComparison.OrdinalIgnoreCase), "keys: A types an a on this layout");
            Check(KeyText.Translate(0x41, true, false, false) != letter, "keys: Shift changes the letter");
            Check(KeyText.Translate(0x10, false, false, false) == "", "keys: Shift alone types nothing");
        }

        // Amounts sit side by side; the button that confirms a trade stays full width.
        var sellConfirm = Load(dir, "sellConfirm").Screen;
        var sellButton = sellConfirm.Rows.First(r => r.Text == "SIMULATE SELL");
        const float phoneW = ThemeLayout.PhoneWidth, phoneH = ThemeLayout.PhoneHeight;
        var sellOps = ThemeLayout.Build(sellConfirm, sellConfirm.Rows.IndexOf(sellButton), "PumpV", 0, 0, phoneW, phoneH);
        const int down = unchecked((int)0xFFF87171);
        Check(sellOps.Any(o => o.Kind == DrawKind.Rect && o.Argb == down && o.W > phoneW * 0.9f), "layout: confirm sell is full width");
        int firstSell = token.Screen.Rows.FindIndex(r => r.Text.StartsWith("Sell "));
        var tokenOps = ThemeLayout.Build(token.Screen, firstSell, "PumpV", 0, 0, phoneW, phoneH);
        Check(tokenOps.Count(o => o.Kind == DrawKind.Rect && o.Argb == down && o.W < phoneW * 0.4f) == 3, "layout: three sell amounts on one line");

        // The layout, for every screen.
        foreach (string fixture in new[] { "home", "token", "launch", "listOffline", "confirm", "sellConfirm", "result", "wallet", "settings", "limit", "raiseLimit", "rpc", "reset", "forgot", "welcomeImport", "activity", "trending", "newCoins", "launchReady", "launchConfirm", "welcome", "repeat", "created", "deposit", "backup", "secretKey", "mode", "unlock", "sendAssets", "sendTo", "sendAmount", "sendReview", "swap", "swapPick", "swapQuoted", "swapCoin", "swapConfirm" })
        {
            var screen = Load(dir, fixture).Screen;
            for (int selected = 0; selected < screen.Rows.Count; selected++)
            {
                var ops = ThemeLayout.Build(screen, selected, "PumpV", 0, 0, phoneW, phoneH);
                var offPanel = ops.Where(o => o.Kind != DrawKind.Text && (o.X < 0 || o.Y < 0 || o.X + o.W > phoneW + 1 || o.Y + o.H > phoneH + 1)).ToList();
                if (offPanel.Count > 0) { Check(false, fixture + ": drawing stays inside the phone (row " + selected + ")"); break; }
                var badText = ops.Where(o => o.Kind == DrawKind.Text && (o.Text.Contains("~") || o.Y > phoneH)).ToList();
                if (badText.Count > 0) { Check(false, fixture + ": text is clean and on the phone (row " + selected + ")"); break; }
                var row = screen.Rows[selected];
                if (row.Enabled && row.Action != null && !HasHighlight(ops))
                {
                    Check(false, fixture + ": the selected row is on screen (row " + selected + ")");
                    break;
                }
            }
            Check(true, fixture + ": layout checked");
        }

        Console.WriteLine(_failures == 0 ? "ALL PASSED" : _failures + " FAILED");
        return _failures == 0 ? 0 : 1;
    }
}

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using GTA;
using GTA.Native;
using iFruitJailbreak;

namespace PumpV
{
    /// <summary>
    /// The phone app. It registers a home-screen app through iFruit Jailbreak
    /// and renders whatever screens the companion sends. Network calls run on
    /// background tasks; their results are queued and applied in Tick, the
    /// only place game natives may be called.
    /// </summary>
    public class PumpVScript : Script
    {
        private const int MaxStack = 16;
        private const int SecretTimeoutMs = 120000;
        private const int SecretOpenGuardMs = 400;
        private const float StockPhoneScale = 500f; // what the game's phone script uses
        private const float HiddenPhoneScale = 1f;
        private const int OpeningAnimationMs = 1800; // nothing to pick until it clears

        private readonly string _appName;
        private readonly int _homeIcon;
        private readonly bool _mayReplaceGameApp;
        private readonly System.Windows.Forms.Keys _photoKey;
        private readonly int _photoSize;
        private readonly System.Windows.Forms.Keys _screenshotKey;
        private readonly string _screenshotsDir;
        private readonly CompanionClient _client;

        private readonly ConcurrentQueue<Action> _main = new ConcurrentQueue<Action>();
        private readonly List<UiScreen> _stack = new List<UiScreen>();

        private PhoneApp _app;
        private UiScreen _shown;          // what the phone shows now; null while loading
        private bool _registered;
        private bool _wasOpen;
        private bool _busy;               // a user-initiated request is in flight
        private bool _refreshing;         // a background refresh is in flight
        private int _lastFetch;
        private int _ignoreInputUntil;
        private int _navGen;              // bumped when the player backs out of a pending load
        private int _tabStep;             // Q or E was pressed: -1 or 1

        private PhoneCamera _camera;
        private UiAction _armedPhoto;     // the photo being framed is for this action
        private bool _snapRequested;
        private int _snapFrames;
        private int _shutterUntil;
        private string _photoName;

        private UiAction _secret;         // the password being typed is for this action
        private readonly StringBuilder _secretText = new StringBuilder();
        private int _secretOpenedAt;
        private int _secretLastKeyAt;

        private readonly PhoneWindow _window;
        private readonly ThemePanel _panel; // for when the phone window can't run
        private bool _stockPhoneHidden;
        private int _highlight;
        private int _keepPauseMenuClosedUntil;
        private UiScreen _view;           // what the themed app shows
        private readonly Dictionary<string, UiScreen> _seenTabs = new Dictionary<string, UiScreen>(); // shown at once when going back to a tab

        public PumpVScript()
        {
            _appName = Settings.GetValue("App", "Name", "RUGR");
            _homeIcon = Settings.GetValue("App", "Icon", PhoneIcon.Save);
            _mayReplaceGameApp = Settings.GetValue("App", "ReplaceGameApp", false);
            string dir = Settings.GetValue("Companion", "Dir", "");
            int timeout = Settings.GetValue("Companion", "TimeoutSeconds", 90);
            _photoKey = Enum.TryParse(Settings.GetValue("Photo", "Key", "F10"), true, out System.Windows.Forms.Keys key)
                ? key
                : System.Windows.Forms.Keys.F10;
            _photoSize = Settings.GetValue("Photo", "Size", 512);
            _screenshotKey = Enum.TryParse(Settings.GetValue("Screenshot", "Key", "P"), true, out System.Windows.Forms.Keys shotKey)
                ? shotKey
                : System.Windows.Forms.Keys.P;
            string companionDir = string.IsNullOrWhiteSpace(dir) ? CompanionClient.DefaultDir() : dir;
            _screenshotsDir = System.IO.Path.Combine(companionDir, "screenshots");
            _client = new CompanionClient(
                companionDir,
                System.IO.Path.Combine(BaseDirectory, "PumpV", "pumpv-companion.exe"),
                timeout);
            if (Settings.GetValue("Theme", "Panel", true))
            {
                _window = new PhoneWindow(System.IO.Path.Combine(BaseDirectory, "..", "PumpPhone", "PumpPhone.exe"), _client.ImagesDir);
                _panel = new ThemePanel(
                    ThemeSetting("ScreenLeft", 0f),
                    ThemeSetting("ScreenTop", 0.065f),
                    ThemeSetting("ScreenWidth", 1f),
                    ThemeSetting("ScreenHeight", 0.86f),
                    ThemeSetting("TextSize", 1.33f));
            }

            Tick += OnTick;
            KeyDown += OnKeyDown;
            Aborted += OnAborted;
        }

        private UiScreen Top => _stack.Count > 0 ? _stack[_stack.Count - 1] : null;

        /// <summary>Always reads a dot as the decimal point, whatever the PC's language.</summary>
        private float ThemeSetting(string name, float fallback)
        {
            return float.TryParse(Settings.GetValue("Theme", name, ""), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out float value)
                ? value
                : fallback;
        }

        // ------------------------------------------------------------------
        // Frame loop
        // ------------------------------------------------------------------

        private void OnTick(object sender, EventArgs e)
        {
            if (!_registered)
            {
                _registered = true;
                Register();
            }

            appHome.Update();

            while (_main.TryDequeue(out Action work))
                work();

            if (_app == null)
                return;

            bool open = _app.IsOpen;
            if (open || Game.GameTime < _keepPauseMenuClosedUntil)
                KeepPauseMenuClosed(); // Esc means Back in here
            if (open)
                KeepTabKeysFromTheGame();
            if (open && !_wasOpen)
                OnOpened();
            if (!open && _wasOpen)
                PutPhoneWindowAway();
            _wasOpen = open;

            if (open)
            {
                PhoneMenu menu = _app.Menu;
                if (_armedPhoto != null)
                {
                    TickPhoto();
                    return;
                }
                if (_secret != null)
                {
                    TickSecret();
                }
                else
                {
                    if (Game.GameTime < _ignoreInputUntil)
                    {
                        // Swallow presses that belonged to the keyboard.
                        DisableGameControls();
                        menu.JustSelected();
                        menu.JustBackedOut();
                        _tabStep = 0;
                    }
                    else if (menu.JustBackedOut())
                    {
                        GoBack();
                    }
                    else if (menu.JustSelected())
                    {
                        OnSelect(_highlight);
                    }
                    else
                    {
                        Navigate();
                    }
                    AutoRefresh();
                    if (menu.SelectedIndex != _highlight) menu.SelectedIndex = _highlight;
                }
                DrawPanel();
            }
            else if (_secret != null)
            {
                CancelSecret();
            }
            else if (_armedPhoto != null)
            {
                CancelPhoto(); // the phone closed under us, for a call or a cutscene
            }
        }

        private void Register()
        {
            if (!appHome.Supported)
            {
                Notify("Phone apps are not supported on this game version (see iFruit Jailbreak).", "error");
                return;
            }
            int icon = PhoneIcon.IsValidForHomeScreen(_homeIcon) ? _homeIcon : PhoneIcon.Save;
            _app = appHome.RegisterApp(_appName, icon);
            if (_app == null)
            {
                Notify("No free phone app slot.", "error");
                return;
            }
            _app.MayReplaceGameApp = _mayReplaceGameApp;
            _app.Menu.CloseOnBack = false; // Back goes up one screen; we close at the root.
            _app.Menu.Header = _appName;
        }

        private void OnOpened()
        {
            _window?.Opened();
            _ignoreInputUntil = Game.GameTime + OpeningAnimationMs;
            if (_stack.Count == 0)
            {
                ShowLoading("Connecting...");
                Open("/ui/home");
                return;
            }
            ShowTop();
            RefreshTop();
        }

        private void OnAborted(object sender, EventArgs e)
        {
            _camera?.Close();
            PutPhoneWindowAway();
            _window?.Dispose();
            if (_app != null)
                appHome.Remove(_app);
            _client.Dispose();
        }

        // ------------------------------------------------------------------
        // Navigation
        // ------------------------------------------------------------------

        private void OnSelect(int index)
        {
            UiScreen s = _shown;
            if (_busy || s == null || index < 0 || index >= s.Rows.Count)
            {
                if (_busy) PlaySound("ERROR");
                return;
            }
            UiRow row = s.Rows[index];
            if (row.Enabled && row.Action != null)
                Perform(row.Action);
        }

        private void Perform(UiAction a)
        {
            switch (a.Kind)
            {
                case "open":
                    RememberSelection();
                    ShowLoading("Loading...");
                    Open(a.Path);
                    break;
                case "post":
                    RememberSelection();
                    if (!a.Quiet) ShowLoading(a.Path == "/ui/execute" ? "Sending..." : "Working...");
                    Request(() => _client.PostAsync(a.Path, a.Body), Apply);
                    break;
                case "tab":
                    SwitchTab(a.Path);
                    break;
                case "input":
                    RunInput(a);
                    break;
                case "secret":
                    BeginSecret(a);
                    break;
                case "photo":
                    ArmPhoto(a);
                    break;
                case "refresh":
                    ReloadTop();
                    break;
                case "back":
                    GoBack();
                    break;
                case "home":
                    GoHome();
                    break;
                case "close":
                    _app.RequestClose();
                    break;
            }
        }

        private void Open(string path)
        {
            Request(() => _client.GetAsync(path), Apply);
        }

        /// <summary>Follows a response's navigation instruction.</summary>
        private void Apply(UiResponse r)
        {
            if (!string.IsNullOrEmpty(r.ToastText))
                Notify(r.ToastText, r.ToastLevel);

            switch (r.Nav)
            {
                case "push":
                    if (r.Screen != null)
                    {
                        _stack.Add(r.Screen);
                        if (_stack.Count > MaxStack) _stack.RemoveAt(0);
                        Show(r.Screen, keepSelection: false);
                    }
                    else ShowTop();
                    break;
                case "replace":
                    if (r.Screen != null)
                    {
                        if (_stack.Count > 0) _stack.RemoveAt(_stack.Count - 1);
                        _stack.Add(r.Screen);
                        Show(r.Screen, keepSelection: false);
                    }
                    else ShowTop();
                    break;
                case "back":
                    // With a screen, it's what the one underneath has become.
                    if (r.Screen != null && _stack.Count > 1)
                    {
                        _stack.RemoveAt(_stack.Count - 1);
                        _stack[_stack.Count - 1] = r.Screen;
                        Show(r.Screen, keepSelection: false);
                    }
                    else GoBack();
                    break;
                case "home":
                    GoHome();
                    break;
                case "close":
                    _app?.RequestClose();
                    break;
                default:
                    ShowTop(); // put back what "Loading..." covered
                    break;
            }
            _lastFetch = Game.GameTime;
        }

        /// <summary>The menu moves its highlight one row at a time by itself; this replaces
        /// that with moves that match how the screen looks.</summary>
        private void Navigate()
        {
            UiScreen s = _shown;
            if (s == null) return;
            int step = TabStepPressed();
            if (step != 0)
            {
                string tab = _stack.Count > 0 ? PhoneTabs.Next(_stack[0].Path, step) : null;
                if (tab != null && !_busy) SwitchTab(tab);
                return;
            }
            int dy = Pressed(Control.PhoneDown) || Pressed(Control.PhoneScrollForward) ? 1
                : Pressed(Control.PhoneUp) || Pressed(Control.PhoneScrollBackward) ? -1
                : 0;
            int dx = Pressed(Control.PhoneRight) ? 1 : Pressed(Control.PhoneLeft) ? -1 : 0;
            if (dx == 0 && dy == 0) return;
            int moved = PhoneNav.Move(s, _highlight, dx, dy);
            if (moved == _highlight && dx < 0 && _stack.Count > 1)
                GoBack(); // Nowhere further left on a screen inside a tab, so that means Back.
            else
                _highlight = moved;
        }

        /// <summary>Q and E move between tabs from anywhere, the same keys the game's own menus use.
        /// A controller has LB and RB for it.</summary>
        private int TabStepPressed()
        {
            int step = _tabStep;
            _tabStep = 0;
            if (step == 0 && Game.LastInputMethod == InputMethod.GamePad)
                step = Pressed(Control.FrontendLb) ? -1 : Pressed(Control.FrontendRb) ? 1 : 0;
            return step;
        }

        /// <summary>Goes to a tab: at once if it's been seen, while it reloads behind the scenes.</summary>
        private void SwitchTab(string path)
        {
            _stack.Clear();
            if (_seenTabs.TryGetValue(path, out UiScreen seen))
            {
                _stack.Add(seen);
                Show(seen, keepSelection: false);
                RefreshTop();
                return;
            }
            ShowLoading("Loading...", path);
            Open(path);
        }

        private void GoHome()
        {
            _stack.Clear();
            _seenTabs.Clear();
            ShowLoading("Loading...");
            Open(PhoneTabs.Home);
        }

        // The phone disables the controls it draws over, so read their disabled form too.
        private static bool Pressed(Control control)
        {
            return Game.IsControlJustPressed(control) || Function.Call<bool>(Hash.IS_DISABLED_CONTROL_JUST_PRESSED, 0, (int)control);
        }

        private static void KeepPauseMenuClosed()
        {
            foreach (int group in new[] { 0, 2 })
            {
                Function.Call(Hash.DISABLE_CONTROL_ACTION, group, (int)Control.FrontendPause, true);
                Function.Call(Hash.DISABLE_CONTROL_ACTION, group, (int)Control.FrontendPauseAlternate, true);
            }
        }

        /// <summary>The player's Q and E are ours while the app is open: no cover, horn or radio.</summary>
        private static void KeepTabKeysFromTheGame()
        {
            foreach (Control control in new[] { Control.Cover, Control.ContextSecondary, Control.Context, Control.Pickup, Control.Talk, Control.VehicleHorn, Control.VehicleRadioWheel })
                Function.Call(Hash.DISABLE_CONTROL_ACTION, 0, (int)control, true);
        }

        private void GoBack()
        {
            if (_busy && _shown == null)
            {
                // Back while "Loading..." abandons that navigation. A trade
                // already sent still reports its outcome as a notification.
                _navGen++;
                ShowTop();
                return;
            }
            if (_busy) return; // the screen is about to change by itself
            if (_stack.Count > 1)
            {
                _stack.RemoveAt(_stack.Count - 1);
                ShowTop();
                RefreshTop();
            }
            else if (Top != null && Top.Tab && Top.Path != PhoneTabs.Home)
            {
                SwitchTab(PhoneTabs.Home);
            }
            else
            {
                _app?.RequestClose();
            }
        }

        private void RememberSelection()
        {
            if (_app != null && _shown != null && _shown == Top)
                Top.Selected = _app.Menu.SelectedIndex;
        }

        // ------------------------------------------------------------------
        // Refreshing
        // ------------------------------------------------------------------

        private void AutoRefresh()
        {
            UiScreen top = Top;
            if (top == null || top.RefreshMs <= 0 || _shown != top) return;
            if (Game.GameTime - _lastFetch >= top.RefreshMs)
                RefreshTop();
        }

        /// <summary>Re-fetches the top screen in the background, keeping the highlight.</summary>
        private void RefreshTop()
        {
            UiScreen target = Top;
            if (target == null || !target.CanRefresh || _refreshing || _busy) return;
            _lastFetch = Game.GameTime;
            Request(() => _client.GetAsync(target.Path), r =>
            {
                if (Top != target)
                {
                    RefreshTop(); // they moved on while this ran
                    return;
                }
                if (r.Screen == null || r.Nav != "push") return;
                _stack[_stack.Count - 1] = r.Screen;
                if (_shown == target) Show(r.Screen, keepSelection: true);
            }, silent: true);
        }

        /// <summary>A visible reload (the "Retry" rows).</summary>
        private void ReloadTop()
        {
            UiScreen target = Top;
            if (target == null || !target.CanRefresh) return;
            ShowLoading("Loading...");
            Request(() => _client.GetAsync(target.Path), r =>
            {
                if (r.Screen != null && r.Nav == "push" && Top == target)
                {
                    _stack[_stack.Count - 1] = r.Screen;
                    Show(r.Screen, keepSelection: false);
                    if (!string.IsNullOrEmpty(r.ToastText)) Notify(r.ToastText, r.ToastLevel);
                }
                else Apply(r);
            });
        }

        // ------------------------------------------------------------------
        // Background requests
        // ------------------------------------------------------------------

        private void Request(Func<Task<UiResponse>> call, Action<UiResponse> onDone, bool silent = false)
        {
            if (silent) _refreshing = true; else _busy = true;
            int gen = _navGen;
            Task.Run(async () =>
            {
                try
                {
                    UiResponse r = await call().ConfigureAwait(false);
                    _main.Enqueue(() =>
                    {
                        Finish(silent);
                        if (!silent && gen != _navGen)
                        {
                            if (!string.IsNullOrEmpty(r.ToastText)) Notify(r.ToastText, r.ToastLevel);
                            return;
                        }
                        onDone(r);
                    });
                }
                catch (Exception ex)
                {
                    _main.Enqueue(() =>
                    {
                        Finish(silent);
                        if (silent || gen == _navGen) Failed(ex, silent);
                    });
                }
            });
        }

        private void Finish(bool silent)
        {
            if (silent) _refreshing = false; else _busy = false;
        }

        private void Failed(Exception ex, bool silent)
        {
            if (silent) return; // a missed background refresh is not worth a popup
            if (ex is CompanionOfflineException)
            {
                Notify(ex.Message, "error");
                ShowOffline(ex.Message);
            }
            else
            {
                Notify("Error: " + ex.Message, "error");
                ShowTop();
            }
        }

        // ------------------------------------------------------------------
        // Drawing
        // ------------------------------------------------------------------

        private void DrawPanel()
        {
            if (_window == null || !_window.Usable)
            {
                _panel?.Draw(_view, _highlight, _appName);
                return;
            }
            if (Game.IsPaused)
            {
                _window.Hide();
                return;
            }
            // The stock phone still takes the player's keys, unseen behind the window.
            Function.Call(Hash.SET_MOBILE_PHONE_SCALE, HiddenPhoneScale);
            _stockPhoneHidden = true;
            _window.Show(_view, _highlight, BackKeyLabel(), _stack.Count, World.CurrentTimeOfDay.ToString(@"hh\:mm"));
        }

        private string BackKeyLabel()
        {
            if (_stack.Count > 1) return "Back";
            return Top != null && Top.Tab && Top.Path != PhoneTabs.Home ? "Home" : "Close";
        }

        private void PutPhoneWindowAway()
        {
            _window?.Hide();
            if (!_stockPhoneHidden) return;
            _stockPhoneHidden = false;
            Function.Call(Hash.SET_MOBILE_PHONE_SCALE, StockPhoneScale);
        }

        private void Show(UiScreen screen, bool keepSelection)
        {
            UiScreen before = _shown;
            _shown = screen;
            _view = screen;
            if (screen.Tab) _seenTabs[screen.Path] = screen;
            if (_app == null) return;
            PhoneMenu menu = _app.Menu;
            int keep = menu.SelectedIndex;
            menu.Clear();
            menu.Header = Clean(string.IsNullOrEmpty(screen.Header) ? _appName : screen.Header, 30);
            foreach (UiRow row in screen.Rows)
            {
                PhoneMenuItem item = menu.AddItem(Clean(row.Text, 40), PhoneIcon.IsValid(row.Icon) ? row.Icon : 0);
                item.Enabled = row.Enabled && row.Action != null;
            }
            if (screen.Rows.Count == 0)
                menu.AddItem("(empty)", 0).Enabled = false;
            _highlight = PhoneNav.Settle(screen, keepSelection ? PhoneNav.KeepPlace(before, keep, screen) : screen.Selected);
            menu.SelectedIndex = _highlight;
            menu.Refresh();
        }

        private void ShowTop()
        {
            if (Top != null) Show(Top, keepSelection: false);
            else ShowOffline("Not connected.");
        }

        /// <param name="tabPath">The tab being opened, when it's one, so the tab bar stays up.</param>
        private void ShowLoading(string text, string tabPath = null)
        {
            _shown = null;
            _view = new UiScreen
            {
                Header = Top?.Header ?? _appName,
                Path = tabPath ?? Top?.Path ?? "",
                Tab = tabPath != null || (Top?.Tab ?? false),
            };
            _view.Rows.Add(new UiRow { Text = text, Style = new UiStyle { Kind = "loading" } });
            _highlight = 0;
            if (_app == null) return;
            PhoneMenu menu = _app.Menu;
            menu.Clear();
            menu.Header = _appName;
            menu.AddItem(text, 0).Enabled = false;
            menu.Refresh();
        }

        private void ShowOffline(string reason)
        {
            var s = new UiScreen { Header = _appName };
            s.Rows.Add(new UiRow { Text = "Can't reach the companion" });
            s.Rows.Add(new UiRow { Text = reason });
            s.Rows.Add(new UiRow { Text = "Retry", Enabled = true, Action = new UiAction { Kind = "home" } });
            s.Selected = 2;
            Show(s, keepSelection: false);
        }

        // ------------------------------------------------------------------
        // Text input (on-screen keyboard over the phone)
        // ------------------------------------------------------------------

        private void RunInput(UiAction a)
        {
            RememberSelection();
            string text = Keyboard(a.Title, a.Initial, a.MaxLength);
            _ignoreInputUntil = Game.GameTime + 500;
            if (text == null)
            {
                ShowTop();
                return;
            }
            var body = new Dictionary<string, object>(a.Body);
            body[a.Field] = text;
            ShowLoading("Working...");
            Request(() => _client.PostAsync(a.Path, body), Apply);
        }

        private string Keyboard(string title, string initial, int maxLength)
        {
            Function.Call(Hash.DISPLAY_ONSCREEN_KEYBOARD, 0, "FMMC_KEY_TIP8", "", initial ?? "", "", "", "", maxLength + 1);
            int status;
            while ((status = Function.Call<int>(Hash.UPDATE_ONSCREEN_KEYBOARD)) == 0)
            {
                GTA.UI.Screen.ShowHelpTextThisFrame(Clean(title, 60));
                appHome.Update(); // keep the phone framework ticking while we wait
                DrawPanel();
                Yield();
            }
            if (status != 1) return null;
            string result = Function.Call<string>(Hash.GET_ONSCREEN_KEYBOARD_RESULT);
            return string.IsNullOrWhiteSpace(result) ? null : result.Trim();
        }

        // ------------------------------------------------------------------
        // Passwords: typed straight from the keyboard, because the game's own
        // on-screen keyboard shows what's typed. Keys arrive in OnKeyDown, which
        // only runs between ticks, so this can't wait in a loop as Keyboard does.
        // ------------------------------------------------------------------

        private void BeginSecret(UiAction a)
        {
            RememberSelection();
            ShowLoading("Enter your password"); // what shows with the themed app turned off
            _secret = a;
            _secretText.Clear();
            _secretOpenedAt = Game.GameTime;
            _secretLastKeyAt = Game.GameTime;
            ShowSecret();
        }

        private void ShowSecret()
        {
            _view = SecretScreen.Build(_secret.Title, _secret.Hint, _secretText.Length);
        }

        private void TickSecret()
        {
            DisableGameControls(); // typing mustn't walk the player around or pause the game
            _app.Menu.JustSelected();
            _app.Menu.JustBackedOut();
            if (_window == null || !_window.Usable)
                GTA.UI.Screen.ShowHelpTextThisFrame(Clean(_secret.Title, 40) + ": " + SecretScreen.Stars(_secretText.Length) + " (Enter / Esc)");
            if (Game.GameTime - _secretLastKeyAt > SecretTimeoutMs)
                CancelSecret();
        }

        private void OnSecretKey(System.Windows.Forms.KeyEventArgs e)
        {
            _secretLastKeyAt = Game.GameTime;
            switch (e.KeyCode)
            {
                case System.Windows.Forms.Keys.Return:
                    // The Enter that opened this can arrive a moment later.
                    if (_secretText.Length > 0 && Game.GameTime - _secretOpenedAt >= SecretOpenGuardMs)
                        SubmitSecret();
                    return;
                case System.Windows.Forms.Keys.Escape:
                    _keepPauseMenuClosedUntil = Game.GameTime + 500;
                    CancelSecret();
                    return;
                case System.Windows.Forms.Keys.Back:
                    if (_secretText.Length > 0) _secretText.Length--;
                    ShowSecret();
                    return;
            }
            string typed = KeyText.Translate((uint)e.KeyCode, e.Shift, e.Control, e.Alt);
            if (typed.Length == 0 || char.IsControl(typed[0]) || _secretText.Length + typed.Length > _secret.MaxLength) return;
            _secretText.Append(typed);
            ShowSecret();
        }

        private void SubmitSecret()
        {
            UiAction a = _secret;
            var body = new Dictionary<string, object>(a.Body);
            body[a.Field] = _secretText.ToString();
            EndSecret();
            ShowLoading("Working...");
            Request(() => _client.PostAsync(a.Path, body), Apply);
        }

        private void CancelSecret()
        {
            EndSecret();
            ShowTop();
        }

        private void EndSecret()
        {
            _secret = null;
            _secretText.Clear();
            _ignoreInputUntil = Game.GameTime + 500;
        }

        private static void DisableGameControls()
        {
            Function.Call(Hash.DISABLE_ALL_CONTROL_ACTIONS, 0);
            Function.Call(Hash.DISABLE_ALL_CONTROL_ACTIONS, 2);
        }

        // ------------------------------------------------------------------
        // Photos for token launches
        // ------------------------------------------------------------------

        private void ArmPhoto(UiAction a)
        {
            RememberSelection();
            _window?.Hide();
            _armedPhoto = a;
            _snapRequested = false;
            _shutterUntil = 0;
            _ignoreInputUntil = Game.GameTime + 400; // the Enter that opened this
            _camera = new PhoneCamera();
            _camera.Open();
        }

        private void OnKeyDown(object sender, System.Windows.Forms.KeyEventArgs e)
        {
            if (_secret != null)
            {
                OnSecretKey(e);
                return;
            }
            // Letters typed on the game's keyboard arrive here once it closes, and aren't for us.
            bool typedEarlier = Game.GameTime < _ignoreInputUntil;
            if (e.KeyCode == _screenshotKey && _app != null && _app.IsOpen && !typedEarlier)
            {
                TakeScreenshot();
                return;
            }
            if ((e.KeyCode == System.Windows.Forms.Keys.Q || e.KeyCode == System.Windows.Forms.Keys.E) && _app != null && _app.IsOpen && _armedPhoto == null && !typedEarlier)
            {
                _tabStep = e.KeyCode == System.Windows.Forms.Keys.Q ? -1 : 1;
                return;
            }
            if (e.KeyCode == System.Windows.Forms.Keys.Escape && _app != null && _app.IsOpen)
            {
                _keepPauseMenuClosedUntil = Game.GameTime + 500; // Closing the app mustn't let this press through.
                if (_armedPhoto != null) CancelPhoto();
                else if (Game.GameTime >= _ignoreInputUntil) GoBack();
                return;
            }
            if (_armedPhoto != null && !_snapRequested && e.KeyCode == _photoKey)
            {
                _snapRequested = true;
                _snapFrames = 0;
            }
        }

        private void TickPhoto()
        {
            PhoneMenu menu = _app.Menu;
            menu.JustSelected();
            menu.JustBackedOut();
            Function.Call(Hash.SET_MOBILE_PHONE_SCALE, HiddenPhoneScale);
            _stockPhoneHidden = true;

            if (_shutterUntil != 0)
            {
                _camera.Tick(overlays: true);
                if (Game.GameTime >= _shutterUntil) SendPhoto();
                return;
            }
            if (_snapRequested)
            {
                // A few clean frames first, with nothing drawn over the view.
                _camera.Tick(overlays: false);
                if (++_snapFrames >= 4) TakePhoto();
                return;
            }
            _camera.Tick(overlays: true);
            if (Game.GameTime < _ignoreInputUntil) return;
            if (Pressed(Control.PhoneSelect))
            {
                _snapRequested = true;
                _snapFrames = 0;
            }
            else if (Pressed(Control.PhoneCancel))
            {
                CancelPhoto();
            }
            else if (Pressed(Control.PhoneUp))
            {
                _camera.ToggleSelfie();
            }
        }

        private void TakeScreenshot()
        {
            Snapshot.SaveScreenshot(_screenshotsDir, path => _main.Enqueue(() =>
            {
                if (path == null)
                {
                    Notify("Couldn't take a screenshot.", "error");
                    return;
                }
                PlaySound("Camera_Shoot");
                Notify("Screenshot copied. Paste it anywhere.", "success");
            }));
        }

        private void TakePhoto()
        {
            try
            {
                _photoName = Snapshot.Capture(_client.ImagesDir, _photoSize);
            }
            catch (Exception ex)
            {
                CancelPhoto();
                Notify(ex.Message, "error");
                return;
            }
            PlaySound("Camera_Shoot");
            _camera.CloseShutter();
            _shutterUntil = Game.GameTime + 350;
        }

        private void SendPhoto()
        {
            UiAction a = _armedPhoto;
            string name = _photoName;
            CloseCamera();
            var body = new Dictionary<string, object>(a.Body);
            body[a.Field] = name;
            ShowLoading("Saving photo...");
            Request(() => _client.PostAsync(a.Path, body), Apply);
        }

        private void CancelPhoto()
        {
            CloseCamera();
            ShowTop();
        }

        private void CloseCamera()
        {
            _camera?.Close();
            _camera = null;
            _armedPhoto = null;
            _snapRequested = false;
            _shutterUntil = 0;
            _ignoreInputUntil = Game.GameTime + 400;
        }

        // ------------------------------------------------------------------
        // Helpers
        // ------------------------------------------------------------------

        private void Notify(string text, string level)
        {
            if (_window != null && _window.Toast(Clean(text, 200), level)) return;
            string color = level == "error" ? "~r~" : level == "success" ? "~g~" : "~b~";
            GTA.UI.Notification.Show(color + Clean(_appName, 20) + ":~s~ " + Clean(text, 200));
        }

        private static void PlaySound(string name)
        {
            string set = name == "Camera_Shoot" ? "Phone_Soundset_Franklin" : "HUD_FRONTEND_DEFAULT_SOUNDSET";
            Function.Call(Hash.PLAY_SOUND_FRONTEND, -1, name, set, true);
        }

        private static string Clean(string s, int max) => UiText.Clean(s, max);
    }
}

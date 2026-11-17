using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace PumpPhone
{
    /// <summary>
    /// The phone players see: a small window over the game showing phone.html. It never
    /// takes focus or clicks, so the game keeps running and the player's keys keep
    /// going to it. The mod works the phone and sends this what to show, one JSON
    /// message per line on stdin; when that closes, the game is gone and so is this.
    ///
    ///   PumpPhone.exe --game-pid 1234 --images "folder with coin photos"
    ///   PumpPhone.exe --capture out.png    Draws the first screen sent to an image, then exits.
    /// </summary>
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [STAThread]
        private static int Main(string[] args)
        {
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            var form = new PhoneForm(Option(args, "--game-pid"), Option(args, "--capture"), Option(args, "--images"));
            form.Begin();
            Application.Run();
            GC.KeepAlive(form);
            return 0;
        }

        private static string Option(string[] args, string name)
        {
            int i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }
    }

    internal sealed class PhoneForm : Form
    {
        // The size phone.html is laid out at. It's zoomed to fit the game's window.
        private const float DesignWidth = 372f;
        private const float DesignHeight = 696f;
        private const float DesignCorner = 88f;
        private const float HeightOfGame = 0.84f;
        private const float RightMargin = 0.05f;
        private const float BottomMargin = 0.05f;
        private const int CaptureHeight = 885;

        private const int WsExTopmost = 0x00000008;
        private const int WsExToolWindow = 0x00000080;
        private const int WsExNoActivate = 0x08000000;

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeRect { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativePoint { public int X, Y; }

        // Screenshot tools take the front while they work, and the phone should be in the picture.
        private static readonly HashSet<string> ScreenshotTools = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "ScreenClippingHost", "SnippingTool", "ScreenSketch", "GameBar", "GameBarFTServer", "ScreenRec", "obs64",
        };

        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr window, out NativeRect rect);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr window, ref NativePoint point);
        [DllImport("gdi32.dll")] private static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int cornerWidth, int cornerHeight);
        [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr handle);

        private readonly int _gamePid;
        private readonly string _capturePath;
        private readonly string _imagesDir;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
        private readonly WebView2 _web = new WebView2 { Dock = DockStyle.Fill };
        private readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer { Interval = 150 };

        private IntPtr _game;
        private bool _pageReady;
        private bool _wanted;
        private bool _captured;
        private string _lastView;
        private Size _laidOutFor;

        public PhoneForm(string gamePid, string capturePath, string imagesDir)
        {
            int.TryParse(gamePid, out _gamePid);
            _capturePath = capturePath;
            _imagesDir = imagesDir;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            BackColor = Color.Black;
            Controls.Add(_web);
        }

        protected override bool ShowWithoutActivation => true;

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams p = base.CreateParams;
                p.ExStyle |= WsExTopmost | WsExToolWindow | WsExNoActivate;
                return p;
            }
        }

        public void Begin()
        {
            CreateHandle();
            _timer.Tick += (s, e) => Place();
            _timer.Start();
            var reader = new Thread(ReadCommands) { IsBackground = true };
            reader.Start();
            _ = StartPageAsync();
        }

        private async Task StartPageAsync()
        {
            try
            {
                string data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PumpV", "phone-webview");
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, data);
                await _web.EnsureCoreWebView2Async(env);
                CoreWebView2 core = _web.CoreWebView2;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.SetVirtualHostNameToFolderMapping("pump.phone", AppDomain.CurrentDomain.BaseDirectory, CoreWebView2HostResourceAccessKind.Allow);
                if (!string.IsNullOrEmpty(_imagesDir))
                {
                    Directory.CreateDirectory(_imagesDir);
                    core.SetVirtualHostNameToFolderMapping("pump.images", _imagesDir, CoreWebView2HostResourceAccessKind.Allow);
                }
                core.NavigationCompleted += (s, e) =>
                {
                    _pageReady = true;
                    SendLastView();
                };
                core.Navigate("https://pump.phone/phone.html");
                Enabled = false; // Clicks must never take focus from the game.
            }
            catch (Exception e)
            {
                Fail(e);
            }
        }

        private static void Fail(Exception e)
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PumpV");
                Directory.CreateDirectory(dir);
                File.WriteAllText(Path.Combine(dir, "phone.log"), DateTime.Now.ToString("s") + " " + e + Environment.NewLine);
            }
            catch (IOException)
            {
                // Only a log.
            }
            Environment.Exit(1);
        }

        private void ReadCommands()
        {
            using (var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
            {
                string line;
                while ((line = input.ReadLine()) != null)
                {
                    string command = line;
                    BeginInvoke((Action)(() => OnCommand(command)));
                }
            }
            if (_capturePath == null) BeginInvoke((Action)Application.Exit);
        }

        private void OnCommand(string line)
        {
            if (!(_json.DeserializeObject(line) is Dictionary<string, object> message) || !message.TryGetValue("type", out object type)) return;
            switch (type as string)
            {
                case "show":
                    _wanted = true;
                    Place();
                    ForwardToPage(line);
                    break;
                case "hide":
                    _wanted = false;
                    Place();
                    ForwardToPage(line);
                    break;
                case "view":
                    _lastView = line;
                    SendLastView();
                    break;
                default:
                    ForwardToPage(line);
                    break;
            }
        }

        private void ForwardToPage(string line)
        {
            if (_pageReady) _web.CoreWebView2.PostWebMessageAsJson(line);
        }

        private void SendLastView()
        {
            if (!_pageReady || _lastView == null) return;
            _web.CoreWebView2.PostWebMessageAsJson(_lastView);
            if (_capturePath != null && !_captured)
            {
                _captured = true;
                _ = CaptureAsync();
            }
        }

        private async Task CaptureAsync()
        {
            await Task.Delay(2800); // Past the opening animation, with fonts and coin images in.
            using (FileStream file = File.Create(_capturePath))
                await _web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
            Application.Exit();
        }

        /// <summary>Keeps the phone on the game's window, and only while the game is what's in front.</summary>
        private void Place()
        {
            if (_capturePath != null)
            {
                FitTo(new Rectangle(-4000, -4000, (int)(CaptureHeight * DesignWidth / DesignHeight), CaptureHeight));
                if (!Visible) Show();
                return;
            }
            if (_game == IntPtr.Zero && _gamePid != 0)
            {
                try { _game = Process.GetProcessById(_gamePid).MainWindowHandle; }
                catch (ArgumentException) { Application.Exit(); return; }
            }
            bool show = _wanted && _game != IntPtr.Zero && GameIsInFront() && GetClientRect(_game, out NativeRect client) && client.Bottom > 0;
            if (!show)
            {
                if (Visible) Hide();
                return;
            }
            GetClientRect(_game, out NativeRect size);
            var origin = new NativePoint();
            ClientToScreen(_game, ref origin);
            int height = (int)(size.Bottom * HeightOfGame);
            int width = (int)(height * DesignWidth / DesignHeight);
            FitTo(new Rectangle(
                origin.X + size.Right - width - (int)(size.Right * RightMargin),
                origin.Y + size.Bottom - height - (int)(size.Bottom * BottomMargin),
                width,
                height));
            if (!Visible) Show();
            TopMost = true;
        }

        private bool GameIsInFront()
        {
            IntPtr front = GetForegroundWindow();
            if (front == _game) return true;
            GetWindowThreadProcessId(front, out uint pid);
            try { return ScreenshotTools.Contains(Process.GetProcessById((int)pid).ProcessName); }
            catch (ArgumentException) { return false; }
        }

        private void FitTo(Rectangle where)
        {
            if (Bounds != where) Bounds = where;
            if (_laidOutFor == where.Size) return;
            _laidOutFor = where.Size;

            float zoom = where.Height / DesignHeight;
            int corner = (int)(DesignCorner * zoom);
            IntPtr shape = CreateRoundRectRgn(0, 0, where.Width + 1, where.Height + 1, corner, corner);
            Region = Region.FromHrgn(shape);
            DeleteObject(shape);
            _web.ZoomFactor = zoom / (DeviceDpi / 96f);
        }
    }
}

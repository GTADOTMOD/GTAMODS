using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace PumpV
{
    /// <summary>
    /// Runs PumpPhone.exe, the phone window over the game, and tells it what to show.
    /// Writing to it happens on a background task, so a slow window can never hold up
    /// a frame of the game.
    /// </summary>
    internal sealed class PhoneWindow : IDisposable
    {
        private readonly string _exePath;
        private readonly string _imagesDir;
        private readonly BlockingCollection<string> _outbox = new BlockingCollection<string>();
        private Process _process;
        private bool _failed;
        private bool _showing;
        private UiScreen _sentScreen;
        private int _sentSelected = int.MinValue;
        private string _sentBack;
        private int _sentDepth;
        private string _sentClock;

        public PhoneWindow(string exePath, string imagesDir)
        {
            _exePath = exePath;
            _imagesDir = imagesDir;
        }

        /// <summary>False if it's missing or won't run; the app then draws on the stock phone.</summary>
        public bool Usable => !_failed && File.Exists(_exePath);

        /// <param name="back">What the Back key does here, for the key hints.</param>
        /// <param name="depth">How many screens deep this is, so it slides in from the right side.</param>
        /// <param name="clock">The game's time, for the phone's status bar.</param>
        public void Show(UiScreen screen, int selected, string back, int depth, string clock)
        {
            if (screen == null || !EnsureRunning()) return;
            if (!_showing)
            {
                _showing = true;
                _outbox.Add("{\"type\":\"show\"}");
            }
            if (clock != _sentClock)
            {
                _sentClock = clock;
                _outbox.Add(UiJson.Serialize(new Dictionary<string, object> { { "type", "clock" }, { "time", clock } }));
            }
            if (screen == _sentScreen && selected == _sentSelected && back == _sentBack && depth == _sentDepth) return;
            _sentScreen = screen;
            _sentSelected = selected;
            _sentBack = back;
            _sentDepth = depth;
            _outbox.Add(UiJson.Serialize(new Dictionary<string, object>
            {
                { "type", "view" },
                { "selected", selected },
                { "back", back },
                { "depth", depth },
                { "screen", UiJson.ForPage(screen) },
            }));
        }

        /// <summary>Shows a message on the phone. False if the phone isn't up to show it.</summary>
        public bool Toast(string text, string level)
        {
            if (!_showing) return false;
            _outbox.Add(UiJson.Serialize(new Dictionary<string, object>
            {
                { "type", "toast" },
                { "text", text },
                { "level", level },
            }));
            return true;
        }

        /// <summary>The player opened the app, so it plays its opening animation. The first
        /// time there's no page yet, and the page plays it as it loads.</summary>
        public void Opened()
        {
            if (_process != null && !_process.HasExited) _outbox.Add("{\"type\":\"opened\"}");
        }

        public void Hide()
        {
            if (!_showing) return;
            _showing = false;
            _outbox.Add("{\"type\":\"hide\"}");
        }

        private bool EnsureRunning()
        {
            if (_failed) return false;
            if (_process != null)
            {
                if (!_process.HasExited) return true;
                _failed = true; // It stopped by itself; see phone.log. Don't restart it every frame.
                return false;
            }
            try
            {
                var start = new ProcessStartInfo(_exePath, "--game-pid " + Process.GetCurrentProcess().Id + " --images \"" + _imagesDir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                };
                _process = Process.Start(start);
                var writer = new StreamWriter(_process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
                Task.Run(() => Pump(writer));
                return true;
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception || e is IOException || e is InvalidOperationException)
            {
                _failed = true;
                return false;
            }
        }

        private void Pump(StreamWriter writer)
        {
            try
            {
                foreach (string line in _outbox.GetConsumingEnumerable())
                    writer.WriteLine(line);
            }
            catch (IOException)
            {
                _failed = true;
            }
            finally
            {
                writer.Dispose(); // Closing stdin is what tells the window to exit.
            }
        }

        public void Dispose()
        {
            _outbox.CompleteAdding();
        }
    }
}

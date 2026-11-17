using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace PumpV
{
    internal sealed class SnapshotFailedException : Exception
    {
        public SnapshotFailedException(string message) : base(message) { }
    }

    /// <summary>
    /// Grabs the game window, crops the middle square and saves it as a PNG
    /// into the companion's images folder for use as a token image.
    /// Exclusive fullscreen can hand back a black frame; that is detected and
    /// reported rather than uploaded.
    /// </summary>
    internal static class Snapshot
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT { public int X, Y; }

        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

        /// <summary>The game window as the player sees it, with the phone on top.</summary>
        private static Bitmap GrabWindow()
        {
            IntPtr hwnd = Process.GetCurrentProcess().MainWindowHandle;
            if (hwnd == IntPtr.Zero) hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero || !GetClientRect(hwnd, out RECT rc))
                throw new SnapshotFailedException("Couldn't find the game window.");

            int w = rc.Right - rc.Left, h = rc.Bottom - rc.Top;
            if (w < 64 || h < 64) throw new SnapshotFailedException("Game window is too small.");
            var origin = new POINT { X = 0, Y = 0 };
            ClientToScreen(hwnd, ref origin);

            var full = new Bitmap(w, h, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(full))
                g.CopyFromScreen(origin.X, origin.Y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
            return full;
        }

        /// <summary>A screenshot for the player, saved and put on the clipboard. Windows
        /// only lets a thread like this one touch the clipboard, so it runs on its own.</summary>
        /// <param name="done">Gets the file's path, or null if it failed.</param>
        public static void SaveScreenshot(string dir, Action<string> done)
        {
            var worker = new Thread(() =>
            {
                string path = null;
                try
                {
                    using (Bitmap full = GrabWindow())
                    {
                        Directory.CreateDirectory(dir);
                        path = Path.Combine(dir, "pump-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png");
                        full.Save(path, ImageFormat.Png);
                        Clipboard.SetDataObject(full, true, 5, 100);
                    }
                }
                catch (Exception e) when (e is SnapshotFailedException || e is IOException || e is ExternalException || e is ArgumentException)
                {
                    // A saved file is enough if only the clipboard was busy.
                }
                done(path);
            });
            worker.IsBackground = true;
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
        }

        public static string Capture(string dir, int size)
        {
            using (Bitmap full = GrabWindow())
            {
                int w = full.Width, h = full.Height;
                int side = Math.Min(w, h);
                var src = new Rectangle((w - side) / 2, (h - side) / 2, side, side);
                size = Math.Max(128, Math.Min(1024, size));
                using (var square = new Bitmap(size, size, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(square))
                    {
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(full, new Rectangle(0, 0, size, size), src, GraphicsUnit.Pixel);
                    }
                    if (MostlyBlack(square))
                        throw new SnapshotFailedException("Photo came out black. Use Borderless/Windowed mode, or put an image in the PumpV images folder.");

                    Directory.CreateDirectory(dir);
                    string name = "gta-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".png";
                    square.Save(Path.Combine(dir, name), ImageFormat.Png);
                    return name;
                }
            }
        }

        private static bool MostlyBlack(Bitmap bmp)
        {
            long sum = 0;
            int samples = 0;
            for (int y = 0; y < 16; y++)
                for (int x = 0; x < 16; x++)
                {
                    Color c = bmp.GetPixel(x * (bmp.Width - 1) / 15, y * (bmp.Height - 1) / 15);
                    sum += c.R + c.G + c.B;
                    samples++;
                }
            return sum / (samples * 3.0) < 4.0;
        }
    }
}

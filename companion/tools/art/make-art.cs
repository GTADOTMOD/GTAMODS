// Cuts the phone's art out of the RUGR logo. The results are committed, so this only needs
// running again if the logo changes:
//
//   csc -r:System.Drawing.dll -out:make-art.exe companion/tools/art/make-art.cs
//   make-art.exe brand/rugr-logo.png companion/tools/art
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

internal static class MakeArt
{
    // Where things sit in the 1254 x 1254 logo.
    private static readonly Rectangle Brush = new Rectangle(90, 660, 1110, 500);
    private const int MaxLetterWidth = 300;
    private const int DisplayWidth = 760;

    private static int Main(string[] args)
    {
        using (var logo = new Bitmap(args[0]))
        {
            string dir = args[1];
            Directory.CreateDirectory(dir);
            Scaled(logo, new Rectangle(0, 0, logo.Width, logo.Height), 192, 192).Save(Path.Combine(dir, "icon.png"), ImageFormat.Png);
            Scaled(logo, new Rectangle(0, 0, logo.Width, logo.Height), 640, 640).Save(Path.Combine(dir, "logo.png"), ImageFormat.Png);
            CutBrush(logo).Save(Path.Combine(dir, "wordmark.png"), ImageFormat.Png);
            // The generated art, at the size the phone shows it. Only the JPGs are committed, so this runs
            // for any full-size PNG put next to them.
            foreach (string name in new[] { "hero", "wallpaper", "card", "splash" })
                if (File.Exists(Path.Combine(dir, name + ".png")))
                    SaveSmaller(Path.Combine(dir, name + ".png"), Path.Combine(dir, name + ".jpg"));
        }
        Console.WriteLine("wrote art to " + args[1]);
        return 0;
    }

    private static void SaveSmaller(string from, string to)
    {
        if (!File.Exists(from)) return;
        using (var source = new Bitmap(from))
        using (Bitmap small = Scaled(source, new Rectangle(0, 0, source.Width, source.Height), DisplayWidth, DisplayWidth * source.Height / source.Width))
        using (var quality = new EncoderParameters(1))
        {
            quality.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 86L);
            ImageCodecInfo jpeg = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
            small.Save(to, jpeg, quality);
        }
    }

    private static Bitmap Scaled(Bitmap source, Rectangle from, int width, int height)
    {
        var result = new Bitmap(width, height, PixelFormat.Format32bppArgb);
        using (Graphics g = Graphics.FromImage(result))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(source, new Rectangle(0, 0, width, height), from, GraphicsUnit.Pixel);
        }
        return result;
    }

    private static bool IsPink(byte r, byte g, byte b) => r > 170 && g < 110 && b > 70 && r - g > 90;

    /// <summary>The pink stroke and the black letters on it, without the portrait behind.
    /// A pixel stays if it's pink, or dark with pink close by on both sides, which is what a
    /// letter on the stroke looks like.</summary>
    private static Bitmap CutBrush(Bitmap logo)
    {
        using (Bitmap area = logo.Clone(Brush, PixelFormat.Format32bppArgb))
        {
            BitmapData data = area.LockBits(new Rectangle(0, 0, area.Width, area.Height), ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int w = area.Width, h = area.Height, stride = data.Stride;
            var px = new byte[stride * h];
            Marshal.Copy(data.Scan0, px, 0, px.Length);

            var keep = new bool[w * h];
            for (int y = 0; y < h; y++)
            {
                int lastPink = int.MinValue;
                var pinkLeft = new int[w];
                for (int x = 0; x < w; x++)
                {
                    int i = y * stride + x * 4;
                    if (IsPink(px[i + 2], px[i + 1], px[i])) lastPink = x;
                    pinkLeft[x] = lastPink;
                }
                lastPink = int.MaxValue;
                for (int x = w - 1; x >= 0; x--)
                {
                    int i = y * stride + x * 4;
                    if (IsPink(px[i + 2], px[i + 1], px[i])) { lastPink = x; keep[y * w + x] = true; continue; }
                    bool dark = px[i + 2] < 95 && px[i + 1] < 95 && px[i] < 95;
                    bool between = pinkLeft[x] != int.MinValue && lastPink != int.MaxValue && lastPink - pinkLeft[x] <= MaxLetterWidth;
                    keep[y * w + x] = dark && between;
                }
            }
            for (int y = 0; y < h; y++)
            {
                for (int x = 0; x < w; x++)
                {
                    if (!keep[y * w + x]) px[y * stride + x * 4 + 3] = 0;
                }
            }
            Marshal.Copy(px, 0, data.Scan0, px.Length);
            area.UnlockBits(data);
            return Scaled(area, new Rectangle(0, 0, w, h), 720, (int)(720f * h / w));
        }
    }
}

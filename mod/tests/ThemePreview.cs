// Draws the app's phone screens to an image, for checking the layout without GTA V. The font
// is Arial instead of the game's, so text widths are only close. Windows or Mono:
//
//   node companion/dist/test/fixtures.js fx
//   csc -r:System.Web.Extensions.dll -r:System.Drawing.dll -out:preview.exe mod/src/UiModel.cs mod/src/ThemeLayout.cs mod/tests/ThemePreview.cs
//   preview.exe fx preview.png
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.IO;
using PumpV;

internal static class ThemePreview
{
    private const float Width = ThemeLayout.PhoneWidth;
    private const float Height = ThemeLayout.PhoneHeight;
    private const float Gap = 12;
    private const float Zoom = 2;
    private const float TextNarrowing = 0.72f; // Text on the phone's screen comes out narrower than tall.

    private static int Main(string[] args)
    {
        string dir = args[0];
        string[] names = { "welcome", "repeat", "created", "deposit", "secret", "unlock", "backup", "secretKey", "mode", "home", "trending", "newCoins", "token", "confirm", "sellConfirm", "result", "launch", "wallet", "settings", "activity", "swap", "swapPick", "swapQuoted", "listOffline" };
        const int columns = 5;
        int rows = (names.Length + columns - 1) / columns;
        using (var sheet = new Bitmap((int)(Zoom * (columns * (Width + Gap) + Gap)), (int)(Zoom * (rows * (Height + Gap) + Gap)), PixelFormat.Format32bppArgb))
        using (var g = Graphics.FromImage(sheet))
        {
            g.ScaleTransform(Zoom, Zoom);
            g.Clear(Color.FromArgb(40, 44, 40)); // stands in for the phone around the app
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            for (int i = 0; i < names.Length; i++)
            {
                var screen = names[i] == "secret"
                    ? SecretScreen.Build("Choose a password", "At least 10 characters", 7)
                    : UiJson.ParseResponse(File.ReadAllText(Path.Combine(dir, names[i] + ".json"))).Screen;
                float x = Gap + (i % columns) * (Width + Gap);
                float y = Gap + (i / columns) * (Height + Gap);
                foreach (DrawOp op in ThemeLayout.Build(screen, screen.Selected, "PUMP", x, y, Width, Height))
                    Draw(g, op);
            }
            sheet.Save(args[1], ImageFormat.Png);
        }
        Console.WriteLine("wrote " + args[1]);
        return 0;
    }

    private static void Draw(Graphics g, DrawOp op)
    {
        switch (op.Kind)
        {
            case DrawKind.Rect:
                using (var b = new SolidBrush(Color.FromArgb(op.Argb)))
                    g.FillRectangle(b, op.X, op.Y, op.W, op.H);
                break;
            case DrawKind.Text:
                float size = op.Scale * ThemeLayout.TextHeight * 0.9f;
                using (var font = new Font("Arial", size, GraphicsUnit.Pixel))
                using (var b = new SolidBrush(Color.FromArgb(op.Argb)))
                {
                    float width = TextNarrowing * g.MeasureString(op.Text, font, PointF.Empty, StringFormat.GenericTypographic).Width;
                    float x = op.Align == TextAlign.Right ? op.X - width : op.Align == TextAlign.Center ? op.X - width / 2 : op.X;
                    GraphicsState state = g.Save();
                    g.TranslateTransform(x, op.Y);
                    g.ScaleTransform(TextNarrowing, 1);
                    g.DrawString(op.Text, font, b, 0, 0, StringFormat.GenericTypographic);
                    g.Restore(state);
                }
                break;
        }
    }
}

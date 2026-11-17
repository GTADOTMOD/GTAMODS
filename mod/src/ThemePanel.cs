using System.Collections.Generic;
using System.Drawing;
using GTA.Native;
using GTA.UI;

namespace PumpV
{
    /// <summary>
    /// Draws the pump.fun-style app on the phone's own screen, from what
    /// ThemeLayout works out. It draws into the phone's render target the same way
    /// the game's cellphone_flashhand script does, so it moves with the phone. The
    /// phone's menu still runs underneath: it takes the player's input, and it's
    /// what shows if this is turned off in PumpV.ini.
    /// </summary>
    internal sealed class ThemePanel
    {
        private const int PhoneDrawOrder = 4; // what the game draws the phone's screen with
        private const float TargetWidth = 1280f; // SHVDN's elements work in a 1280x720 space
        private const float TargetHeight = 720f;

        private readonly float _left;
        private readonly float _top;
        private readonly float _unitX;
        private readonly float _unitY;
        private readonly float _textSize;

        private readonly List<IElement> _elements = new List<IElement>();
        private UiScreen _builtFor;
        private int _builtSelected = int.MinValue;

        /// <param name="left">Left edge of the app on the phone's screen, from 0 to 1. The others likewise.</param>
        /// <param name="textSize">The game's text scale for text ThemeLayout sizes at 1.0. The phone's screen
        /// draws text far larger than its size suggests, so this was measured from the game.</param>
        public ThemePanel(float left, float top, float width, float height, float textSize)
        {
            _left = left * TargetWidth;
            _top = top * TargetHeight;
            _unitX = width * TargetWidth / ThemeLayout.PhoneWidth;
            _unitY = height * TargetHeight / ThemeLayout.PhoneHeight;
            _textSize = textSize;
        }

        public void Draw(UiScreen screen, int selected, string appName)
        {
            if (screen == null) return;
            if (screen != _builtFor || selected != _builtSelected)
                Rebuild(screen, selected, appName);

            int phone;
            using (var id = new OutputArgument())
            {
                Function.Call(Hash.GET_MOBILE_PHONE_RENDER_ID, id);
                phone = id.GetResult<int>();
            }
            Function.Call(Hash.SET_TEXT_RENDER_ID, phone);
            Function.Call(Hash.SET_SCRIPT_GFX_DRAW_ORDER, PhoneDrawOrder + 1);
            foreach (IElement element in _elements)
                element.Draw();
            Function.Call(Hash.SET_SCRIPT_GFX_DRAW_ORDER, PhoneDrawOrder);
            Function.Call(Hash.SET_TEXT_RENDER_ID, Function.Call<int>(Hash.GET_DEFAULT_SCRIPT_RENDERTARGET_RENDER_ID));
        }

        private void Rebuild(UiScreen screen, int selected, string appName)
        {
            _builtFor = screen;
            _builtSelected = selected;
            _elements.Clear();

            foreach (DrawOp op in ThemeLayout.Build(screen, selected, appName, 0, 0, ThemeLayout.PhoneWidth, ThemeLayout.PhoneHeight))
            {
                var at = new PointF(_left + op.X * _unitX, _top + op.Y * _unitY);
                if (op.Kind == DrawKind.Rect)
                    _elements.Add(new ContainerElement(at, new SizeF(op.W * _unitX, op.H * _unitY), Color.FromArgb(op.Argb)));
                else
                    _elements.Add(new TextElement(op.Text, at, op.Scale * _textSize, Color.FromArgb(op.Argb), GTA.UI.Font.ChaletLondon, ToAlignment(op.Align)));
            }
        }

        private static Alignment ToAlignment(TextAlign align)
        {
            switch (align)
            {
                case TextAlign.Center: return Alignment.Center;
                case TextAlign.Right: return Alignment.Right;
                default: return Alignment.Left;
            }
        }
    }
}

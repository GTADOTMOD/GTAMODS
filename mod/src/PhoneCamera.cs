using GTA;
using GTA.Native;

namespace PumpV
{
    /// <summary>
    /// The game's own phone camera, set up the way its appcamera script does it: the
    /// camera view, the viewfinder and shutter from the camera_gallery movie, and the
    /// button bar along the bottom. It only shows the view; Snapshot takes the picture.
    /// </summary>
    internal sealed class PhoneCamera
    {
        private readonly Scaleform _viewfinder = new Scaleform("camera_gallery");
        private readonly Scaleform _buttons = new Scaleform("instructional_buttons");
        private bool _movieReady;
        private bool _selfie;

        public void Open()
        {
            Function.Call(Hash.CELL_CAM_ACTIVATE, true, true);
        }

        /// <param name="overlays">False for the frames just before a photo, so it comes out clean.</param>
        public void Tick(bool overlays)
        {
            Function.Call(Hash.HIDE_HUD_AND_RADAR_THIS_FRAME);
            if (!overlays) return;
            if (!_movieReady && _viewfinder.IsLoaded && _buttons.IsLoaded)
            {
                _movieReady = true;
                SetUpMovies();
            }
            CoverOutsideSquare();
            if (!_movieReady) return;
            _viewfinder.Render2D();
            _buttons.Render2D();
        }

        public void ToggleSelfie()
        {
            _selfie = !_selfie;
            Function.Call(Hash.CELL_CAM_ACTIVATE_SELFIE_MODE, _selfie);
        }

        public void CloseShutter()
        {
            if (_movieReady) _viewfinder.CallFunction("CLOSE_SHUTTER");
        }

        public void Close()
        {
            if (_selfie) Function.Call(Hash.CELL_CAM_ACTIVATE_SELFIE_MODE, false);
            Function.Call(Hash.CELL_CAM_ACTIVATE, false, false);
            _viewfinder.Dispose();
            _buttons.Dispose();
        }

        private void SetUpMovies()
        {
            _viewfinder.CallFunction("SHOW_PHOTO_FRAME", 1f);
            _viewfinder.CallFunction("SHOW_REMAINING_PHOTOS", 0f);
            _viewfinder.CallFunction("OPEN_SHUTTER");

            _buttons.CallFunction("CLEAR_ALL");
            _buttons.CallFunction("SET_DATA_SLOT", 0, "t_Esc", "Cancel");
            _buttons.CallFunction("SET_DATA_SLOT", 1, "t_Up", "Selfie");
            _buttons.CallFunction("SET_DATA_SLOT", 2, "t_Enter", "Take photo");
            _buttons.CallFunction("DRAW_INSTRUCTIONAL_BUTTONS", 0f);
        }

        /// <summary>A coin's logo is the middle square of the screen, so that's all the viewfinder shows.</summary>
        private static void CoverOutsideSquare()
        {
            float side = 1f / GTA.UI.Screen.AspectRatio;
            if (side >= 1f) return;
            float bar = (1f - side) / 2f;
            Function.Call(Hash.DRAW_RECT, bar / 2f, 0.5f, bar, 1f, 0, 0, 0, 255, false);
            Function.Call(Hash.DRAW_RECT, 1f - bar / 2f, 0.5f, bar, 1f, 0, 0, 0, 255, false);
        }
    }
}

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace RugrSetup
{
    /// <summary>The setup's window: no Windows frame, everything drawn by <see cref="View"/>.</summary>
    sealed class SetupForm : Form, IActions, IReport
    {
        readonly Options options;
        readonly Model model = new Model();
        readonly View view;
        readonly Payload payload;
        readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 33 };
        bool working;
        float lastProgress = -1;
        string lastText;
        /// <summary>The copy that was picked before the Change screen, for Back.</summary>
        int pickedBefore = -1;

        public SetupForm(Options options)
        {
            this.options = options;
            Text = "RUGR Setup";
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            KeyPreview = true;
            BackColor = Palette.Window;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch (Exception) { /* the default icon will do */ }

            float scale = DeviceDpi / 96f;
            view = new View(new Ui(scale), model, this);
            ClientSize = new Size((int)Math.Ceiling(View.W * scale), (int)Math.Ceiling(View.H * scale));

            try
            {
                payload = Payload.Load();
            }
            catch (Exception ex)
            {
                payload = new Payload();
                model.Error = ex.Message;
            }
            model.Version = payload.Version;
            Deps.UserAgent = $"RUGR-Setup/{payload.Version} (+https://gtamod.onrender.com)";

            // The copy RUGR is in, else the one Setup last installed into, else the one on the command line.
            model.Games = Games.Find();
            model.Selected = model.Games.FindIndex(g => g.RugrVersion != null);
            if (model.Selected < 0 && model.Games.Count > 0) model.Selected = 0;
            string remembered = Games.Remembered();
            if (remembered != null) Pick(Games.Inspect(remembered, Games.StoreFor(remembered)));
            if (options.Folder != null) Pick(Games.Inspect(options.Folder, Games.StoreFor(options.Folder)));
            Replan();

            ticker.Tick += (s, e) =>
            {
                model.Shimmer = (model.Shimmer + 0.022f) % 1f;
                Invalidate();
            };
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000;         // CS_DROPSHADOW
                cp.Style |= 0x00020000 | 0x00080000;  // WS_MINIMIZEBOX | WS_SYSMENU, so the taskbar can minimise it
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            try
            {
                int round = 2;   // DWMWCP_ROUND: Windows 11's rounded corners
                DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
                int dark = 1;    // DWMWA_USE_IMMERSIVE_DARK_MODE
                DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int));
            }
            catch (Exception)
            {
                // Windows 10: square corners.
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (options.Then == "install" && model.Game != null) Start(model.Game.RugrVersion != null ? Job.Update : Job.Install);
            else if (options.Then == "remove" && model.Game != null) Start(Job.Remove);
        }

        protected override void OnPaint(PaintEventArgs e) => view.Draw(e.Graphics);

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            Zone z = view.Hit(e.Location);
            string id = z != null && z.Enabled ? z.Id : null;
            if (id == view.Hover) return;
            view.Hover = id;
            Cursor = id != null ? Cursors.Hand : Cursors.Default;
            Invalidate();
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (view.Hover == null) return;
            view.Hover = null;
            Invalidate();
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            Zone z = view.Hit(e.Location);
            if (z != null)
            {
                if (!z.Enabled) return;
                view.Pressed = z.Id;
                Invalidate();
                return;
            }
            if (view.InTitleBar(e.Location))
            {
                ReleaseCapture();
                SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);   // WM_NCLBUTTONDOWN on the caption: drag the window
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            string pressed = view.Pressed;
            if (pressed == null) return;
            view.Pressed = null;
            Invalidate();
            Zone z = view.Hit(e.Location);
            if (z != null && z.Id == pressed && z.Enabled) z.Click();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            base.OnKeyDown(e);
            if (e.KeyCode == Keys.Enter)
            {
                Zone z = view.Find("primary");
                if (z != null && z.Enabled) z.Click();
            }
            else if (e.KeyCode == Keys.Escape && !working)
            {
                Close();
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // Stopping halfway would leave RUGR half copied.
            if (working && e.CloseReason == CloseReason.UserClosing) e.Cancel = true;
            base.OnFormClosing(e);
        }

        // ---- what the screens ask for ----

        public void Install()
        {
            GameCopy game = model.Game;
            if (game != null) Start(game.RugrVersion != null ? Job.Update : Job.Install);
        }

        public void Change()
        {
            pickedBefore = model.Selected;
            model.Page = Page.Folder;
            Invalidate();
        }

        public void Use()
        {
            if (model.Game == null) return;
            model.Page = Page.Welcome;
            Replan();
            Invalidate();
        }

        public void Back()
        {
            if (model.Page == Page.Folder && pickedBefore >= 0 && pickedBefore < model.Games.Count) model.Selected = pickedBefore;
            model.Page = Page.Welcome;
            Replan();
            Invalidate();
        }

        public void Select(int index)
        {
            model.Selected = index;
            Invalidate();
        }

        public void Browse()
        {
            using (var dialog = new OpenFileDialog
            {
                Title = "Find GTA5.exe in your GTA V folder",
                Filter = "GTA V (GTA5.exe, GTA5_Enhanced.exe)|GTA5.exe;GTA5_Enhanced.exe|Programs (*.exe)|*.exe",
                CheckFileExists = true,
                RestoreDirectory = true,
            })
            {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string folder = Path.GetDirectoryName(dialog.FileName);
                GameCopy copy = Games.Inspect(folder, Games.StoreFor(folder));
                if (copy == null)
                {
                    MessageBox.Show(this, "That folder doesn't have GTA V in it. Pick GTA5.exe in your game folder.", "RUGR Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Pick(copy);
                if (model.Page == Page.Welcome) Replan();
                Invalidate();
            }
        }

        void Pick(GameCopy copy)
        {
            if (copy == null) return;
            int i = model.Games.FindIndex(g => Games.Same(g.Folder, copy.Folder));
            if (i < 0)
            {
                model.Games.Insert(0, copy);
                i = 0;
            }
            model.Selected = i;
        }

        /// <summary>What the install would do in the picked copy, for the first screen.</summary>
        void Replan()
        {
            GameCopy game = model.Game;
            if (game == null)
            {
                model.Parts = new List<Part>
                {
                    new Part { Key = "hook", Name = "Script Hook V", Credit = "by Alexander Blade" },
                    new Part { Key = "dotnet", Name = "ScriptHookVDotNet", Credit = "by crosire, kagikn & Chiheb-Bacha" },
                    new Part { Key = "ifruit", Name = "iFruit Jailbreak", Credit = "by andre500" },
                    new Part { Key = "display", Name = "Borderless mode", Credit = "so RUGR's phone can sit over the game" },
                };
                return;
            }
            game.RugrVersion = RugrSetup.Install.InstalledVersion(game.Folder);
            model.Parts = Deps.Plan(game);
        }

        public void AskRemove()
        {
            GameCopy game = model.Game;
            if (game == null) return;
            DialogResult answer = MessageBox.Show(this,
                $"Take RUGR out of this copy of GTA V?\n\n{game.Folder}\n\nYour wallet stays saved in your Windows profile.",
                "Remove RUGR", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
            if (answer == DialogResult.Yes) Start(Job.Remove);
        }

        public void Retry() => Start(model.Job);

        public void Open(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch (Exception)
            {
                MessageBox.Show(this, "Couldn't open your browser. The address is:\n\n" + url, "RUGR Setup", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        public void Minimize() => WindowState = FormWindowState.Minimized;

        public void Start(Job job)
        {
            GameCopy game = model.Game;
            if (game == null || working) return;
            if (job != Job.Remove && !payload.Present)
            {
                Fail(job, model.Error.Length > 0 ? model.Error : "This copy of RUGR Setup has no files in it. Download it again from GTAMOD's site.");
                return;
            }

            if (job == Job.Remove)
            {
                model.Parts = RugrSetup.Install.RemoveParts();
            }
            else
            {
                Replan();
                // What the game already has is done before it starts.
                foreach (Part p in model.Parts)
                    if (!p.Needed && p.Key != "display")
                    {
                        p.State = PartState.Done;
                        p.Detail = p.Plan;
                    }
            }

            working = true;
            model.Job = job;
            model.Page = Page.Working;
            model.Progress = 0;
            model.ProgressText = "";
            model.Notes = new List<string>();
            lastProgress = -1;
            ticker.Start();
            Invalidate();

            string folder = game.Folder;
            List<Part> parts = model.Parts;
            DateTime started = DateTime.UtcNow;
            Task.Run(() =>
            {
                try
                {
                    List<string> notes = new List<string>();
                    if (job == Job.Remove) RugrSetup.Install.Remove(folder, parts, this);
                    else notes = RugrSetup.Install.Run(game, payload, parts, this);
                    // A real install can be quicker than a blink; let the bar be seen.
                    int left = 1400 - (int)(DateTime.UtcNow - started).TotalMilliseconds;
                    if (left > 0) Thread.Sleep(left);
                    OnUi(() =>
                    {
                        Stop();
                        game.RugrVersion = job == Job.Remove ? null : payload.Version;
                        if (job != Job.Remove) Games.Remember(folder);
                        model.Notes = notes;
                        model.Page = Page.Done;
                        Invalidate();
                    });
                }
                catch (RugrSetup.Install.NeedsPermission)
                {
                    OnUi(() =>
                    {
                        Stop();
                        Elevate(job, folder);
                    });
                }
                catch (SetupError ex)
                {
                    OnUi(() =>
                    {
                        Stop();
                        Fail(job, ex.Message, ex.Url, ex.Link);
                    });
                }
                catch (Exception ex)
                {
                    OnUi(() =>
                    {
                        Stop();
                        Fail(job, Friendly(ex));
                    });
                }
            });
        }

        void Stop()
        {
            working = false;
            ticker.Stop();
        }

        void IReport.Part(Part part, PartState state, string detail) => OnUi(() =>
        {
            part.State = state;
            part.Detail = detail ?? "";
            Invalidate();
        });

        void IReport.Progress(float progress, string text)
        {
            if (progress < 1 && progress - lastProgress < 0.004f && text == lastText) return;
            lastProgress = progress;
            lastText = text;
            OnUi(() =>
            {
                model.Progress = progress;
                model.ProgressText = text;
                Invalidate();
            });
        }

        void OnUi(Action action)
        {
            if (IsHandleCreated && !IsDisposed) BeginInvoke(action);
        }

        /// <summary>The game is under Program Files: start again with Windows' permission, picking up where this left off.</summary>
        void Elevate(Job job, string folder)
        {
            try
            {
                var start = new ProcessStartInfo(Application.ExecutablePath, $"--folder \"{folder.TrimEnd('\\')}\" --then {(job == Job.Remove ? "remove" : "install")}")
                {
                    UseShellExecute = true,
                    Verb = "runas",
                };
                Process.Start(start);
                Close();
            }
            catch (Win32Exception ex) when (ex.NativeErrorCode == 1223)
            {
                Fail(job, "Windows needs your permission to change that folder, because it's under Program Files. Press Try again and choose Yes.");
            }
            catch (Exception ex)
            {
                Fail(job, ex.Message);
            }
        }

        void Fail(Job job, string message, string url = null, string link = null)
        {
            model.Job = job;
            model.Error = message;
            model.ErrorUrl = url;
            model.ErrorLink = link;
            model.Page = Page.Error;
            Invalidate();
        }

        static string Friendly(Exception ex)
        {
            if (ex is RugrSetup.Install.GameRunning || ex is InvalidDataException) return ex.Message;
            if (ex is UnauthorizedAccessException)
                return "Windows wouldn't let RUGR Setup change a file in your game folder. Close GTA V and anything else using it, then try again.";
            if (ex is IOException && ex.Message.IndexOf("being used", StringComparison.OrdinalIgnoreCase) >= 0)
                return "A file in your game folder is in use. Close GTA V, then try again.";
            return ex.Message;
        }

        [DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("user32.dll")]
        static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
    }
}

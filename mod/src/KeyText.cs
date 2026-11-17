using System;
using System.Runtime.InteropServices;
using System.Text;

namespace PumpV
{
    /// <summary>
    /// Turns a key press into the character it types, on the player's own keyboard
    /// layout. Script Hook reports which key went down, not what it means, and
    /// an @ or an ñ depends on the layout. Dead keys type nothing.
    /// </summary>
    internal static class KeyText
    {
        private const int VkShift = 0x10;
        private const int VkControl = 0x11;
        private const int VkAlt = 0x12;
        private const int VkCapsLock = 0x14;
        private const uint LeaveDeadKeysAlone = 4;

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr processId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetKeyboardLayout(uint thread);

        [DllImport("user32.dll")]
        private static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);

        [DllImport("user32.dll")]
        private static extern short GetKeyState(int key);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int ToUnicodeEx(uint key, uint scanCode, byte[] state, StringBuilder text, int size, uint flags, IntPtr layout);

        /// <summary>The text this key types, or "" if it types nothing.</summary>
        public static string Translate(uint key, bool shift, bool control, bool alt)
        {
            IntPtr layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero));
            var state = new byte[256];
            if (shift) state[VkShift] = 0x80;
            if (control) state[VkControl] = 0x80;
            if (alt) state[VkAlt] = 0x80;
            if ((GetKeyState(VkCapsLock) & 1) != 0) state[VkCapsLock] = 1;

            var text = new StringBuilder(8);
            int count = ToUnicodeEx(key, MapVirtualKeyEx(key, 0, layout), state, text, text.Capacity, LeaveDeadKeysAlone, layout);
            return count > 0 ? text.ToString(0, count) : "";
        }
    }
}

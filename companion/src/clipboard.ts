import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { UserError } from "./solana.js";

function system32(program: string): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", program);
}

/** Puts text on the Windows clipboard, through the clip.exe every Windows has. */
export function copyToClipboard(text: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new UserError("Copying only works on Windows."));
  return new Promise((resolve, reject) => {
    const failed = () => reject(new UserError("Couldn't reach the clipboard."));
    const child = spawn(system32("clip.exe"), [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    child.on("error", failed);
    child.on("close", (code) => (code === 0 ? resolve() : failed()));
    child.stdin.on("error", failed);
    child.stdin.end(text);
  });
}

/** Reads the clipboard, only when the player presses a Paste button. */
export function readClipboard(): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new UserError("Pasting only works on Windows."));
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"], { windowsHide: true, timeout: 8_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) reject(new UserError("Couldn't reach the clipboard."));
      else resolve(stdout.trim());
    });
  });
}

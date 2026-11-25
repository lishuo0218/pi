// Native folder picker for the web UI's new-session dialog: Windows
// FolderBrowserDialog via PowerShell (same mechanism as deleteToRecycleBin).
// The browser cannot supply an absolute path, so the bridge shows the dialog.
// Resolves null when the user cancels or picks something unusable.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

export function pickDirectory(): Promise<string | null> {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog;",
    "$f.Description = '选择工作目录';",
    "$f.ShowNewFolderButton = $true;",
    "if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $f.SelectedPath }",
  ].join(" ");
  return new Promise((resolvePromise, reject) => {
    // 5 minutes: the dialog blocks until the user decides; kill it if the
    // desktop never shows it (headless session) so the command can finish.
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: 300_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const path = stdout.trim();
        if (!path) {
          resolvePromise(null);
          return;
        }
        // The dialog could hand back a stale/removed path; verify it.
        stat(path).then(
          (info) => resolvePromise(info.isDirectory() ? path : null),
          () => resolvePromise(null),
        );
      },
    );
  });
}

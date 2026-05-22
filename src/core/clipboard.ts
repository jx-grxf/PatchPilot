/**
 * Clipboard image support — lets the user paste an image straight from the OS
 * clipboard into PatchPilot as an attachment, instead of having to save it to
 * disk first and paste the path.
 *
 * Terminal emulators capture the platform paste shortcut (⌘V on macOS) for
 * their own text paste, so PatchPilot binds **Ctrl+V** on every platform — it
 * is free in every common terminal and works identically on Windows.
 */
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The Ctrl+V hint, phrased for the host platform. */
export function clipboardImageHint(hostPlatform: NodeJS.Platform = platform()): string {
  const combo = hostPlatform === "darwin" ? "Ctrl+V (nicht ⌘V — das fängt das Terminal ab)" : "Ctrl+V";
  return `Ein Bild liegt in der Zwischenablage — mit ${combo} als Anhang einfügen.`;
}

/**
 * Decide whether a clipboard type listing describes an image. Pure so the
 * per-platform listing parsers can be unit-tested without a real clipboard.
 */
export function clipboardListingHasImage(listing: string): boolean {
  const lower = listing.toLowerCase();
  // macOS `clipboard info` class codes + Linux/Windows MIME types.
  return (
    lower.includes("pngf") ||
    lower.includes("tiff") ||
    lower.includes("giff") ||
    lower.includes("jpeg") ||
    lower.includes("«class 8bps»") ||
    lower.includes("image/png") ||
    lower.includes("image/jpeg") ||
    lower.includes("image/gif") ||
    lower.includes("image/tiff") ||
    lower.includes("image/bmp")
  );
}

const EXEC_TIMEOUT_MS = 4000;

/** Probe the OS clipboard; resolves true when it currently holds an image. */
export async function clipboardHasImage(): Promise<boolean> {
  try {
    if (platform() === "darwin") {
      const { stdout } = await run("osascript", ["-e", "clipboard info"], { timeout: EXEC_TIMEOUT_MS });
      return clipboardListingHasImage(stdout);
    }

    if (platform() === "win32") {
      // Clipboard access needs an STA thread and the System.Windows.Forms +
      // System.Drawing assemblies — without -Sta GetImage/ContainsImage throw.
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
        "[System.Windows.Forms.Clipboard]::ContainsImage()";
      const { stdout } = await run("powershell", ["-NoProfile", "-Sta", "-Command", script], {
        timeout: EXEC_TIMEOUT_MS,
      });
      return stdout.trim().toLowerCase() === "true";
    }

    // Linux / other X11 — ask xclip for the available target MIME types.
    const { stdout } = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
      timeout: EXEC_TIMEOUT_MS,
    });
    return clipboardListingHasImage(stdout);
  } catch {
    // Missing tool (no xclip, sandboxed osascript) or empty clipboard.
    return false;
  }
}

/**
 * Extract the clipboard image to a temp PNG file and return its path, or null
 * when the clipboard holds no image / the platform tool is unavailable.
 */
export async function readClipboardImage(): Promise<string | null> {
  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), "patchpilot-clip-"));
  } catch {
    return null;
  }

  const target = path.join(dir, `clipboard-${Date.now()}.png`);

  try {
    if (platform() === "darwin") {
      const script = [
        "try",
        "  set png to (the clipboard as «class PNGf»)",
        `  set fp to (open for access (POSIX file ${JSON.stringify(target)}) with write permission)`,
        "  write png to fp",
        "  close access fp",
        '  return "ok"',
        "on error",
        "  try",
        "    close access fp",
        "  end try",
        '  return "none"',
        "end try",
      ].join("\n");
      const { stdout } = await run("osascript", ["-e", script], { timeout: EXEC_TIMEOUT_MS });
      if (stdout.trim() !== "ok") {
        return null;
      }
    } else if (platform() === "win32") {
      // -Sta + both assemblies are required: GetImage() returns a
      // System.Drawing.Bitmap, and ImageFormat lives in System.Drawing.
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms;",
        "Add-Type -AssemblyName System.Drawing;",
        "$img = [System.Windows.Forms.Clipboard]::GetImage();",
        "if ($img -ne $null) {",
        `  $img.Save(${JSON.stringify(target)}, [System.Drawing.Imaging.ImageFormat]::Png);`,
        "  'ok'",
        "} else { 'none' }",
      ].join(" ");
      const { stdout } = await run("powershell", ["-NoProfile", "-Sta", "-Command", script], {
        timeout: EXEC_TIMEOUT_MS,
      });
      if (stdout.trim() !== "ok") {
        return null;
      }
    } else {
      // Linux — pipe xclip's PNG bytes into the target file.
      await run("sh", ["-c", `xclip -selection clipboard -t image/png -o > ${JSON.stringify(target)}`], {
        timeout: EXEC_TIMEOUT_MS,
      });
    }

    const info = await stat(target);
    return info.size > 0 ? target : null;
  } catch {
    return null;
  }
}

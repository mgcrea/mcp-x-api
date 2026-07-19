import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export type OpenResult = { opened: boolean; reason?: string };

/** Only ever X. This must not become a generic "open whatever the model asked for". */
const ALLOWED_ORIGINS = new Set(["https://x.com", "https://twitter.com"]);

const isHeadless = (): boolean => {
  if (existsSync("/.dockerenv")) return true;
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return true;
  }
  return false;
};

const command = (url: string): { file: string; args: string[] } => {
  switch (process.platform) {
    case "darwin":
      return { file: "open", args: [url] };
    case "win32":
      // The empty string is `start`'s title argument; without it a quoted URL
      // becomes the window title and nothing opens.
      return { file: "cmd", args: ["/c", "start", "", url] };
    default:
      return { file: "xdg-open", args: [url] };
  }
};

/**
 * Best effort, and deliberately non-throwing: the intent URL is the deliverable,
 * and Docker, SSH and headless CI are all normal places to run this server.
 * Callers always return the URL regardless of what this says.
 */
export const openInBrowser = async (url: string): Promise<OpenResult> => {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { opened: false, reason: "not a valid URL" };
  }
  if (!ALLOWED_ORIGINS.has(origin)) {
    return { opened: false, reason: `refusing to open a non-X origin (${origin})` };
  }
  if (isHeadless()) {
    return { opened: false, reason: "headless environment — open the URL yourself" };
  }

  const { file, args } = command(url);
  return new Promise<OpenResult>((resolve) => {
    // execFile, not exec: the URL is an argv element and never touches a shell,
    // so its query string cannot be interpreted as shell syntax.
    execFile(file, args, { timeout: 5000 }, (err) => {
      resolve(err ? { opened: false, reason: `${file} failed: ${err.message}` } : { opened: true });
    });
  });
};

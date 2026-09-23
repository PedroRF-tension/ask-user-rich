import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

function isWsl() {
  return process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));
}

function wslInteropEnabled() {
  try {
    return fs.readdirSync("/proc/sys/fs/binfmt_misc").some((name) => name.startsWith("WSLInterop"));
  } catch {
    return false;
  }
}

function firstExisting(candidates) {
  return candidates.find((c) => !c.includes("/") || fs.existsSync(c));
}

function commandFor(url) {
  const custom = process.env.ASK_USER_RICH_OPEN_CMD;
  if (custom) return { cmd: custom, args: [url], shell: false };
  if (isWsl()) {
    // Without the WSLInterop binfmt entry a .exe cannot run at all: the kernel refuses it and the shell
    // fallback "succeeds" at nothing. systemd=true in wsl.conf is a known way to lose that entry.
    if (!wslInteropEnabled()) {
      return { unavailable: "WSL interop is disabled (no WSLInterop entry in /proc/sys/fs/binfmt_misc), so explorer.exe cannot run" };
    }
    const explorer = firstExisting(["/mnt/c/Windows/explorer.exe", "/mnt/c/WINDOWS/explorer.exe", "explorer.exe"]);
    // explorer.exe exits 1 even when it opened the URL.
    return { cmd: explorer, args: [url], okCodes: [0, 1] };
  }
  if (process.platform === "darwin") return { cmd: "open", args: [url] };
  if (process.platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Opens the URL in the user's browser. Resolves { opened, method, error }. Never throws.
 * ASK_USER_RICH_OPEN=0 disables opening (tests, remote sessions).
 */
export function openBrowser(url) {
  if (process.env.ASK_USER_RICH_OPEN === "0") {
    return Promise.resolve({ opened: false, method: "disabled", error: "ASK_USER_RICH_OPEN=0" });
  }
  const { cmd, args, okCodes = [0], unavailable } = commandFor(url);
  if (unavailable) return Promise.resolve({ opened: false, method: "none", error: unavailable });
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let child;
    try {
      child = spawn(cmd, args, { stdio: "ignore", detached: true });
    } catch (error) {
      return done({ opened: false, method: cmd, error: String(error) });
    }
    child.on("error", (error) => done({ opened: false, method: cmd, error: String(error) }));
    child.on("exit", (code) => {
      if (okCodes.includes(code)) done({ opened: true, method: cmd });
      else done({ opened: false, method: cmd, error: `exit code ${code}` });
    });
    child.unref();
    // Some openers stay alive (a browser started in the foreground); that counts as opened.
    setTimeout(() => done({ opened: true, method: cmd }), 5000).unref();
  });
}

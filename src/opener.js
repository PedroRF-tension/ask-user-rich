import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WSL_FIX_HINT = 're-enable interop to open forms automatically, see README "WSL note"';
const WINDOWS_ROOT = "/mnt/c";

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

/** Absolute paths are checked on disk; bare names are looked up on PATH. */
function commandExists(cmd, env = process.env) {
  if (cmd.includes("/")) return fs.existsSync(cmd);
  return (env.PATH ?? "").split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The .desktop entry xdg-open would hand an https URL to, or null. */
function defaultLinuxBrowserHandler() {
  try {
    const result = spawnSync("xdg-mime", ["query", "default", "x-scheme-handler/https"], { encoding: "utf8", timeout: 2000 });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

// PowerShell treats the typographic single quotes as quote characters too, so they are doubled as well.
function powershellSingleQuote(value) {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
}

// WSL interop rebuilds a Windows command line from argv; whitespace and double quotes do not survive it reliably.
const WINDOWS_ARG_UNSAFE = /[\s"\u201C\u201D\u201E\p{Cc}]/u;
// cmd.exe re-parses its command line, so anything beyond this set could be read as an operator or a variable.
const CMD_SAFE = /^[A-Za-z0-9:/._~?#-]+$/;

function windowsCandidates({ url, exists }) {
  const found = [];
  const skipped = [];
  if (exists("wslview")) found.push({ name: "wslview", cmd: "wslview", args: [url] });

  const explorer = ["/mnt/c/Windows/explorer.exe", "/mnt/c/WINDOWS/explorer.exe", "explorer.exe"].find(exists);
  // explorer.exe exits 1 even when it opened the URL.
  if (explorer) found.push({ name: "explorer.exe", cmd: explorer, args: [url], okCodes: [0, 1] });

  // cmd.exe warns about (and falls back from) a UNC working directory, which is what a Linux cwd becomes.
  const cwd = exists(WINDOWS_ROOT) ? WINDOWS_ROOT : undefined;
  const cmd = `${WINDOWS_ROOT}/Windows/System32/cmd.exe`;
  if (exists(cmd)) {
    if (CMD_SAFE.test(url)) found.push({ name: "cmd.exe", cmd, args: ["/c", "start", "", url], cwd });
    else skipped.push({ name: "cmd.exe", reason: "URL has characters cmd.exe would interpret" });
  }

  const powershell = `${WINDOWS_ROOT}/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;
  if (exists(powershell)) {
    if (!WINDOWS_ARG_UNSAFE.test(url)) {
      const script = `Start-Process ${powershellSingleQuote(url)}`;
      found.push({ name: "powershell.exe", cmd: powershell, args: ["-NoProfile", "-NonInteractive", "-Command", script], cwd });
    } else skipped.push({ name: "powershell.exe", reason: "URL has whitespace or quotes" });
  }
  return { found, skipped };
}

/**
 * xdg-open under WSL is only worth trying when a Linux GUI browser can take the URL: WSLg sets DISPLAY /
 * WAYLAND_DISPLAY even with no browser installed, and wslu registers wslview (which needs interop) as the
 * default. A false "opened" leaves the tool blocked on a form nobody can see, so without a real handler we skip.
 */
function linuxGuiCandidate({ url, env, exists, linuxBrowserHandler }) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { skipped: "no Linux GUI (DISPLAY/WAYLAND_DISPLAY unset)" };
  if (!exists("xdg-open")) return { skipped: "xdg-open is not installed" };
  if (!exists("xdg-mime")) return { skipped: "xdg-mime is not installed, so no Linux browser handler can be confirmed" };
  const handler = linuxBrowserHandler();
  if (!handler || !handler.endsWith(".desktop") || /wslview/i.test(handler)) {
    return { skipped: `no Linux browser is registered for https (xdg-mime: ${handler ?? "none"})` };
  }
  return { candidate: { name: "xdg-open", cmd: "xdg-open", args: [url] } };
}

/**
 * Decides which openers to try, in order, without touching the system: every probe is injected.
 * Returns { candidates, skipped, unavailable?, disabled? }. `unavailable` is set when there is nothing to try.
 */
export function planOpeners({
  url,
  platform = process.platform,
  wsl = isWsl(),
  interop = wsl && wslInteropEnabled(),
  env = process.env,
  exists = (cmd) => commandExists(cmd, env),
  linuxBrowserHandler = defaultLinuxBrowserHandler,
}) {
  if (env.ASK_USER_RICH_OPEN === "0") return { candidates: [], skipped: [], disabled: "ASK_USER_RICH_OPEN=0" };
  if (env.ASK_USER_RICH_OPEN_CMD) {
    const cmd = env.ASK_USER_RICH_OPEN_CMD;
    return { candidates: [{ name: cmd, cmd, args: [url] }], skipped: [] };
  }
  if (!wsl) {
    if (platform === "darwin") return { candidates: [{ name: "open", cmd: "open", args: [url] }], skipped: [] };
    if (platform === "win32") return { candidates: [{ name: "cmd", cmd: "cmd", args: ["/c", "start", "", url] }], skipped: [] };
    return { candidates: [{ name: "xdg-open", cmd: "xdg-open", args: [url] }], skipped: [] };
  }

  const candidates = [];
  const skipped = [];
  const windows = windowsCandidates({ url, exists });
  if (interop) {
    candidates.push(...windows.found);
    skipped.push(...windows.skipped.map((s) => `${s.name} skipped (${s.reason})`));
  } else {
    // Without the WSLInterop binfmt entry no .exe can run (wslview is a script that calls one). systemd=true in
    // wsl.conf is a known way to lose that entry.
    const names = [...windows.found, ...windows.skipped].map((c) => c.name);
    const which = names.length > 0 ? `Windows openers (${names.join(", ")})` : "Windows openers";
    skipped.push(`WSL interop is disabled (no WSLInterop entry in /proc/sys/fs/binfmt_misc), so ${which} cannot run`);
  }

  const gui = linuxGuiCandidate({ url, env, exists, linuxBrowserHandler });
  if (gui.candidate) candidates.push(gui.candidate);
  else if (!interop || candidates.length === 0) skipped.push(gui.skipped);

  const plan = { candidates, skipped };
  if (candidates.length === 0) plan.unavailable = [...skipped, ...(interop ? [] : [WSL_FIX_HINT])].join("; ");
  return plan;
}

function tryOpener({ cmd, args = [], okCodes = [0], cwd }, aliveMs) {
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
      child = spawn(cmd, args, { stdio: "ignore", detached: true, cwd });
    } catch (error) {
      return done({ opened: false, error: String(error) });
    }
    child.on("error", (error) => done({ opened: false, error: String(error) }));
    child.on("exit", (code, signal) => {
      if (okCodes.includes(code)) done({ opened: true });
      else done({ opened: false, error: code === null ? `killed by ${signal}` : `exit code ${code}` });
    });
    child.unref();
    // Some openers stay alive (a browser started in the foreground); that counts as opened.
    setTimeout(() => done({ opened: true }), aliveMs).unref();
  });
}

/**
 * Tries each candidate in order until one opens. Resolves { opened, method, error }. Never throws.
 * A single failure reports its reason as is; several are listed as "tried a (reason), b (reason)".
 */
export async function walkOpeners(candidates, { aliveMs = 5000 } = {}) {
  const failures = [];
  for (const candidate of candidates) {
    const name = candidate.name ?? candidate.cmd;
    const result = await tryOpener(candidate, aliveMs);
    if (result.opened) return { opened: true, method: name };
    failures.push({ name, error: result.error });
  }
  if (failures.length === 0) return { opened: false, method: "none", error: "no opener to try" };
  const error =
    failures.length === 1 ? failures[0].error : `tried ${failures.map((f) => `${f.name} (${f.error})`).join(", ")}`;
  return { opened: false, method: failures.at(-1).name, error };
}

/**
 * Opens the URL in the user's browser. Resolves { opened, method, error }. Never throws.
 * ASK_USER_RICH_OPEN=0 disables opening (tests, remote sessions); ASK_USER_RICH_OPEN_CMD forces the command.
 */
export async function openBrowser(url) {
  try {
    const plan = planOpeners({ url });
    if (plan.disabled) return { opened: false, method: "disabled", error: plan.disabled };
    if (plan.unavailable) return { opened: false, method: "none", error: plan.unavailable };
    const result = await walkOpeners(plan.candidates);
    if (!result.opened && plan.skipped.length > 0) result.error = `${result.error}; ${plan.skipped.join("; ")}`;
    return result;
  } catch (error) {
    return { opened: false, method: "none", error: String(error) };
  }
}

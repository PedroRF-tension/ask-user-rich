// Decision logic of the browser opener, checked without launching a browser.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openBrowser, planOpeners, walkOpeners } from "../src/opener.js";

const url = "http://localhost:4321/s/AbC-dEf_123";
const explorer = "/mnt/c/Windows/explorer.exe";
const cmdExe = "/mnt/c/Windows/System32/cmd.exe";
const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const windowsFiles = ["/mnt/c", explorer, cmdExe, powershell];

function plan({ files = windowsFiles, handler = null, ...options } = {}) {
  return planOpeners({
    url,
    platform: "linux",
    wsl: true,
    interop: true,
    env: {},
    exists: (cmd) => files.includes(cmd),
    linuxBrowserHandler: () => handler,
    ...options,
  });
}

const names = (p) => p.candidates.map((c) => c.name);

describe("planOpeners on WSL with interop enabled", () => {
  test("tries wslview, explorer.exe, cmd.exe, then powershell.exe", () => {
    const p = plan({ files: ["wslview", ...windowsFiles] });
    assert.deepEqual(names(p), ["wslview", "explorer.exe", "cmd.exe", "powershell.exe"]);
    assert.equal(p.unavailable, undefined);
  });

  test("leaves out the openers that do not exist", () => {
    assert.deepEqual(names(plan()), ["explorer.exe", "cmd.exe", "powershell.exe"]);
    assert.deepEqual(names(plan({ files: ["/mnt/c", powershell] })), ["powershell.exe"]);
  });

  test("keeps explorer.exe's exit code 1 as success and runs cmd.exe from a Windows directory", () => {
    const [explorerCandidate, cmdCandidate, psCandidate] = plan().candidates;
    assert.deepEqual(explorerCandidate.okCodes, [0, 1]);
    assert.deepEqual(cmdCandidate.args, ["/c", "start", "", url]);
    assert.equal(cmdCandidate.cwd, "/mnt/c");
    assert.deepEqual(psCandidate.args, ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${url}'`]);
  });

  test("doubles single quotes for PowerShell and skips cmd.exe for URLs it would re-parse", () => {
    const odd = "http://localhost:1/s/it's&x=%PATH%";
    const p = plan({ url: odd });
    assert.deepEqual(names(p), ["explorer.exe", "powershell.exe"]);
    assert.equal(p.candidates[1].args.at(-1), "Start-Process 'http://localhost:1/s/it''s&x=%PATH%'");
    assert.match(p.skipped.join("; "), /cmd\.exe skipped/);
  });

  test("appends xdg-open only when a real Linux browser handles https", () => {
    const gui = { env: { DISPLAY: ":0" }, files: [...windowsFiles, "xdg-open", "xdg-mime"] };
    assert.deepEqual(names(plan({ ...gui, handler: "firefox.desktop" })).at(-1), "xdg-open");
    assert.ok(!names(plan({ ...gui, handler: "wslview.desktop" })).includes("xdg-open"));
  });
});

describe("planOpeners on WSL with interop disabled", () => {
  test("without a Linux GUI nothing is tried and the reason names what was skipped", () => {
    const p = plan({ interop: false });
    assert.deepEqual(p.candidates, []);
    assert.match(p.unavailable, /WSL interop is disabled \(no WSLInterop entry in \/proc\/sys\/fs\/binfmt_misc\)/);
    assert.match(p.unavailable, /Windows openers \(explorer\.exe, cmd\.exe, powershell\.exe\) cannot run/);
    assert.match(p.unavailable, /no Linux GUI \(DISPLAY\/WAYLAND_DISPLAY unset\)/);
    assert.match(p.unavailable, /re-enable interop.*README "WSL note"/);
  });

  test("never schedules wslview or a .exe", () => {
    const p = plan({ interop: false, files: ["wslview", ...windowsFiles], env: { DISPLAY: ":0" } });
    assert.deepEqual(p.candidates, []);
    assert.match(p.unavailable, /\(wslview, explorer\.exe, cmd\.exe, powershell\.exe\)/);
    assert.match(p.unavailable, /xdg-open is not installed/);
  });

  test("with WSLg but no registered Linux browser, xdg-open is not trusted", () => {
    const files = [...windowsFiles, "xdg-open", "xdg-mime"];
    const p = plan({ interop: false, files, env: { WAYLAND_DISPLAY: "wayland-0" }, handler: null });
    assert.deepEqual(p.candidates, []);
    assert.match(p.unavailable, /no Linux browser is registered for https/);
  });

  test("with WSLg and a registered Linux browser, xdg-open is the one candidate", () => {
    const files = [...windowsFiles, "xdg-open", "xdg-mime"];
    const p = plan({ interop: false, files, env: { DISPLAY: ":0" }, handler: "firefox.desktop" });
    assert.deepEqual(names(p), ["xdg-open"]);
    assert.deepEqual(p.candidates[0].args, [url]);
  });
});

describe("planOpeners overrides and other platforms", () => {
  test("ASK_USER_RICH_OPEN_CMD short-circuits everything, even WSL without interop", () => {
    const p = plan({ interop: false, env: { ASK_USER_RICH_OPEN_CMD: "/opt/my-browser" } });
    assert.deepEqual(p.candidates, [{ name: "/opt/my-browser", cmd: "/opt/my-browser", args: [url] }]);
    assert.equal(p.unavailable, undefined);
  });

  test("ASK_USER_RICH_OPEN=0 disables opening", () => {
    const p = plan({ env: { ASK_USER_RICH_OPEN: "0", ASK_USER_RICH_OPEN_CMD: "true" } });
    assert.deepEqual(p.candidates, []);
    assert.equal(p.disabled, "ASK_USER_RICH_OPEN=0");
  });

  test("macOS, Windows and plain Linux keep their single opener", () => {
    assert.deepEqual(plan({ wsl: false, platform: "darwin" }).candidates, [{ name: "open", cmd: "open", args: [url] }]);
    assert.deepEqual(plan({ wsl: false, platform: "win32" }).candidates, [
      { name: "cmd", cmd: "cmd", args: ["/c", "start", "", url] },
    ]);
    assert.deepEqual(plan({ wsl: false, platform: "linux" }).candidates, [{ name: "xdg-open", cmd: "xdg-open", args: [url] }]);
  });
});

describe("walkOpeners", () => {
  test("falls through a failing opener to the next and names the one that worked", async () => {
    assert.deepEqual(await walkOpeners([{ cmd: "false" }, { cmd: "true" }]), { opened: true, method: "true" });
  });

  test("lists every failure when nothing opens", async () => {
    const result = await walkOpeners([{ cmd: "false" }, { name: "missing", cmd: "/nonexistent/browser" }]);
    assert.equal(result.opened, false);
    assert.match(result.error, /^tried false \(exit code 1\), missing \(.*ENOENT.*\)$/);
  });

  test("a single failure reports its reason unchanged", async () => {
    const result = await walkOpeners([{ cmd: "/nonexistent/browser" }]);
    assert.equal(result.opened, false);
    assert.match(result.error, /ENOENT/);
    assert.doesNotMatch(result.error, /^tried/);
  });

  test("honours okCodes and counts an opener still alive after the grace period as opened", async () => {
    assert.equal((await walkOpeners([{ cmd: "false", okCodes: [0, 1] }])).opened, true);
    assert.deepEqual(await walkOpeners([{ cmd: "sleep", args: ["2"] }], { aliveMs: 100 }), { opened: true, method: "sleep" });
  });
});

describe("openBrowser", () => {
  function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    return fn().finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  }

  test("ASK_USER_RICH_OPEN=0 resolves disabled", () =>
    withEnv({ ASK_USER_RICH_OPEN: "0" }, async () => {
      assert.deepEqual(await openBrowser(url), { opened: false, method: "disabled", error: "ASK_USER_RICH_OPEN=0" });
    }));

  test("ASK_USER_RICH_OPEN_CMD is the command that runs", () =>
    withEnv({ ASK_USER_RICH_OPEN_CMD: "true" }, async () => {
      assert.deepEqual(await openBrowser(url), { opened: true, method: "true" });
    }));
});

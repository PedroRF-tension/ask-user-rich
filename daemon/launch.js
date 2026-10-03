#!/usr/bin/env node
// Run by the mod: starts the daemon detached unless one already answers, waits for its socket,
// and prints one JSON line ({ ok, pid, version, already } or { ok: false, error }).
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cfg = config();

function hello() {
  return new Promise((resolve) => {
    const req = http.get({ socketPath: cfg.socket, path: "/mod/hello", timeout: 1000 }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(text) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const running = await hello();
if (running) {
  out({ ok: true, already: true, pid: running.pid, version: running.version });
  process.exit(0);
}

fs.mkdirSync(cfg.home, { recursive: true });
const child = spawn(process.execPath, [path.join(here, "main.js")], { detached: true, stdio: "ignore", env: process.env });
child.unref();
let exited = null;
child.on("exit", (code) => (exited = code));

const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
  const info = await hello();
  if (info) {
    out({ ok: true, already: false, pid: info.pid, version: info.version });
    process.exit(0);
  }
  if (exited !== null) break;
}
let tail = "";
try {
  tail = fs.readFileSync(cfg.logFile, "utf8").trim().split("\n").slice(-3).join(" | ");
} catch {}
out({ ok: false, error: exited !== null ? `the daemon exited with code ${exited}` : "the daemon did not answer within 8 s", log: tail });
process.exit(1);

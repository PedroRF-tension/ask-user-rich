#!/usr/bin/env node
// The shared daemon: one per machine (per ASK_USER_RICH_HOME). Started by the mod through launch.js.
import fs from "node:fs";
import http from "node:http";
import { config, VERSION } from "./config.js";
import { logger } from "./log.js";
import { Daemon } from "./server.js";
import { Store } from "./store.js";

const cfg = config();
fs.mkdirSync(cfg.home, { recursive: true });
const log = logger(cfg.logFile);

/** Resolves true when a daemon already answers on the socket. */
function answers(socketPath) {
  return new Promise((resolve) => {
    const req = http.get({ socketPath, path: "/mod/hello", timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

if (fs.existsSync(cfg.socket)) {
  if (await answers(cfg.socket)) {
    log("another daemon already answers; exiting", { socket: cfg.socket });
    process.exit(0);
  }
  fs.unlinkSync(cfg.socket);
}

const store = new Store({ dir: cfg.threadsDir, archiveDir: cfg.archiveDir, keepDays: cfg.keepDays, attachedMs: cfg.attachedMs, log });
const daemon = new Daemon({ store, version: VERSION, hosts: cfg.hosts, port: cfg.port, publicHost: cfg.publicHost, log });

let stopping = false;
async function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  log("shutting down", { reason });
  await daemon.stop().catch(() => {});
  try {
    fs.unlinkSync(cfg.socket);
  } catch {}
  process.exit(0);
}
daemon.onShutdown = shutdown;

try {
  await daemon.listenTcp();
} catch (error) {
  log("could not bind the page port", { hosts: cfg.hosts, port: cfg.port, code: error.code ?? String(error) });
  process.exit(3);
}
await daemon.listenSocket(cfg.socket);
daemon.startTicks();
store.prune();
setInterval(() => store.prune(), cfg.pruneEveryMs).unref();
setInterval(() => {
  if (daemon.isIdle(cfg.idleMs)) shutdown("idle");
}, Math.min(60_000, Math.max(1000, Math.floor(cfg.idleMs / 4))));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
log("daemon listening", { version: VERSION, hosts: cfg.hosts, port: daemon.port, socket: cfg.socket, home: cfg.home });

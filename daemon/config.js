// Where the daemon keeps its state and how it is reached: shared by the daemon and its launcher.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

export function config(env = process.env) {
  const home = env.ASK_USER_RICH_HOME || path.join(os.homedir(), ".cache", "ask-user-rich");
  return {
    home,
    socket: path.join(home, "daemon.sock"),
    threadsDir: path.join(home, "threads"),
    archiveDir: path.join(home, "answers"),
    logFile: path.join(home, "daemon.log"),
    hosts: String(env.ASK_USER_RICH_HOSTS || "127.0.0.1")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    port: Number(env.ASK_USER_RICH_PORT ?? 47800),
    publicHost: env.ASK_USER_RICH_PUBLIC_HOST || "localhost",
    idleMs: Number(env.ASK_USER_RICH_IDLE_MS || 24 * 60 * 60 * 1000),
    keepDays: Number(env.ASK_USER_RICH_KEEP_DAYS || 7),
    attachedMs: Number(env.ASK_USER_RICH_ATTACHED_MS || 10_000),
    pruneEveryMs: Number(env.ASK_USER_RICH_PRUNE_EVERY_MS || 60 * 60 * 1000),
  };
}

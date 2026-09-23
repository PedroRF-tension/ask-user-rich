import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const logDir = process.env.ASK_USER_RICH_LOG_DIR || path.join(root, "logs");
export const answersDir = path.join(logDir, "answers");
const logFile = path.join(logDir, "server.log");

try {
  fs.mkdirSync(answersDir, { recursive: true });
} catch {
  // Logging must never break the server; stderr still works.
}

// stdout carries the MCP protocol, so every diagnostic goes to stderr and the log file.
export function log(message, fields = {}) {
  const extras = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const line = `${new Date().toISOString()} pid=${process.pid} ${message}${extras ? ` ${extras}` : ""}`;
  process.stderr.write(`[ask-user-rich] ${line}\n`);
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // ignore
  }
}

export function archiveResult(result) {
  try {
    const stamp = result.submittedAt.replace(/[:.]/g, "-");
    const file = path.join(answersDir, `${stamp}-${result.interviewId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    return file;
  } catch (error) {
    log("archive failed", { error: String(error) });
    return null;
  }
}

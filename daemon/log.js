import fs from "node:fs";

export function logger(file) {
  return function log(message, fields = {}) {
    const extras = Object.entries(fields)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    const line = `${new Date().toISOString()} pid=${process.pid} ${message}${extras ? ` ${extras}` : ""}`;
    process.stderr.write(`[ask-user-rich] ${line}\n`);
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // Logging never breaks the daemon.
    }
  };
}

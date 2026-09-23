#!/usr/bin/env node
// Runs the server exactly as Claude Code does (stdio, official SDK client), asks an interview and prints
// the result. Usage:
//   node scripts/dev.mjs [interview.json] [--link] [--no-open]
//     --link     delivery=link: print the URL, then wait with await_user_answers
//     --no-open  keep blocking, but do not open a browser (the URL is printed from the progress messages)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? path.join(root, "examples", "demo-interview.json");
const interview = JSON.parse(fs.readFileSync(file, "utf8"));
if (args.includes("--link")) interview.delivery = "link";

const env = { ...process.env };
if (args.includes("--no-open")) env.ASK_USER_RICH_OPEN_CMD = "true";

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", "server.js")], env, stderr: "inherit" });
const client = new Client({ name: "ask-user-rich-dev", version: "0.0.0" });
await client.connect(transport);

const longWait = { timeout: 6 * 60 * 60 * 1000, onprogress: (p) => console.error(`[progress ${p.progress}] ${p.message}`) };
let result = await client.callTool({ name: "ask_user_rich", arguments: interview }, CallToolResultSchema, longWait);
if (result.structuredContent?.status === "awaiting") {
  console.error(result.content[0].text);
  result = await client.callTool(
    { name: "await_user_answers", arguments: { sessionId: result.structuredContent.sessionId } },
    CallToolResultSchema,
    longWait,
  );
}
for (const block of result.content) console.log(block.text);
await client.close();

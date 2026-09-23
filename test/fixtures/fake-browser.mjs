#!/usr/bin/env node
// Stands in for a browser: ASK_USER_RICH_OPEN_CMD points here, so the server "opens" the form by running
// this script with the URL. It loads the page like a browser would, then submits every recommendation.
// Detaches first so the opener sees a quick exit 0, like a real browser launcher.
import { spawn } from "node:child_process";

const url = process.argv[2];
if (process.env.FAKE_BROWSER_CHILD !== "1") {
  spawn(process.execPath, [process.argv[1], url], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FAKE_BROWSER_CHILD: "1" },
  }).unref();
  process.exit(0);
}

const delay = Number(process.env.FAKE_BROWSER_DELAY_MS || 300);
await new Promise((r) => setTimeout(r, delay));
const page = await fetch(url);
if (!page.ok) process.exit(2);
const token = new URL(url).pathname.split("/").pop();
const origin = new URL(url).origin;
const { spec } = await (await fetch(`${origin}/api/s/${token}`)).json();
const answers = {};
for (const q of spec.questions) {
  const recs = q.recommended === undefined ? [] : [].concat(q.recommended);
  answers[q.id] = recs.length
    ? { status: "answer", selected: recs, notes: "auto-submitted by fake-browser" }
    : { status: "defer", selected: [], notes: "no recommendation; deferred by fake-browser" };
}
const response = await fetch(`${origin}/api/s/${token}/submit`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ answers, generalNotes: "fake-browser run" }),
});
process.exit(response.ok ? 0 : 3);

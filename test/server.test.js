// Drives the real server over stdio with the official MCP SDK client.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(root, "src", "server.js");
const fakeBrowser = path.join(root, "test", "fixtures", "fake-browser.mjs");
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ask-user-rich-test-"));

async function connect({ env = {}, capabilities = {} } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // A no-op "browser": the tool believes the form opened and blocks; tests act as the user over HTTP.
      ASK_USER_RICH_OPEN_CMD: "true",
      ASK_USER_RICH_PROGRESS_MS: "100",
      ASK_USER_RICH_LOG_DIR: logDir,
      ...env,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "ask-user-rich-test", version: "0.0.0" }, { capabilities });
  await client.connect(transport);
  return { client, transport, stderr: () => stderr };
}

const sampleInterview = {
  title: "Storage decisions",
  intro: "We need to pick a **storage layer**.",
  questions: [
    {
      id: "db",
      header: "Which database should back the question bank for the first release?",
      body: "Reads dominate; writes are rare.",
      options: [
        { id: "firestore", label: "Firestore", description: "Already in the stack." },
        { id: "postgres", label: "Postgres", description: "Relational.", preview: "```sql\nselect 1;\n```" },
        { id: "sqlite", label: "SQLite" },
        { id: "dynamo", label: "DynamoDB" },
        { id: "files", label: "Plain JSON files" },
      ],
      recommended: "firestore",
      rationale: "Zero new infrastructure.",
    },
    {
      id: "features",
      header: "Which features ship first?",
      options: [
        { id: "search", label: "Search" },
        { id: "tags", label: "Tags" },
        { id: "history", label: "History" },
      ],
      multiSelect: true,
      recommended: ["search", "tags"],
      dependsOn: ["db"],
    },
    { id: "naming", header: "What should the collection be called?", options: [], allowOther: true },
    { id: "later", header: "Retention policy?", options: [{ id: "30d", label: "30 days" }, { id: "1y", label: "1 year" }] },
  ],
};

function urlFrom(text) {
  const match = text.match(/http:\/\/localhost:\d+\/s\/[A-Za-z0-9_-]+/);
  assert.ok(match, `no interview URL in: ${text}`);
  return match[0];
}

function apiBase(url) {
  const u = new URL(url);
  return `${u.origin}/api/s/${u.pathname.split("/").pop()}`;
}

async function submit(url, body) {
  return fetch(`${apiBase(url)}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Starts a blocking ask_user_rich call and resolves the form URL from the first progress notification. */
function startAsk(client, args, { signal } = {}) {
  const progress = [];
  let gotUrl;
  const urlPromise = new Promise((resolve) => (gotUrl = resolve));
  const call = client.callTool({ name: "ask_user_rich", arguments: args }, CallToolResultSchema, {
    signal,
    timeout: 30000,
    onprogress: (p) => {
      progress.push(p);
      if (progress.length === 1) gotUrl(urlFrom(p.message));
    },
  });
  return { call, url: urlPromise, progress };
}

describe("ask-user-rich over stdio", () => {
  let conn;
  before(async () => {
    conn = await connect();
  });
  after(async () => {
    await conn.client.close();
  });

  test("tools/list exposes both tools with the full question schema", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["ask_user_rich", "await_user_answers"]);
    const ask = tools.find((t) => t.name === "ask_user_rich");
    assert.deepEqual(ask.inputSchema.required.sort(), ["questions", "title"]);
    assert.deepEqual(Object.keys(ask.inputSchema.properties).sort(), ["delivery", "intro", "questions", "title"]);
    const question = ask.inputSchema.properties.questions.items;
    for (const key of ["id", "header", "body", "options", "recommended", "rationale", "multiSelect", "allowOther", "dependsOn"]) {
      assert.ok(question.properties[key], `question schema lacks ${key}`);
    }
    const option = question.properties.options.items;
    assert.deepEqual(Object.keys(option.properties).sort(), ["description", "id", "label", "preview"]);
    assert.equal(ask.inputSchema.properties.questions.maxItems, undefined, "questions must be unbounded");
    assert.equal(question.properties.options.maxItems, undefined, "options must be unbounded");
    assert.equal(question.properties.header.maxLength, undefined, "headers must not be length-capped");
    assert.match(conn.client.getInstructions(), /Prefer it over AskUserQuestion/);
  });

  test("full round trip: progress while waiting, form served, submit returns structured answers", async () => {
    const { call, url: urlPromise, progress } = startAsk(conn.client, sampleInterview);
    const url = await urlPromise;

    const page = await fetch(url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /\/assets\/app\.js/);
    for (const asset of ["app.js", "style.css", "marked.js", "purify.js"]) {
      const res = await fetch(`${new URL(url).origin}/assets/${asset}`);
      assert.equal(res.status, 200, asset);
    }
    const data = await (await fetch(apiBase(url))).json();
    assert.equal(data.state, "pending");
    assert.equal(data.spec.questions.length, 4);
    const state = await (await fetch(`${apiBase(url)}/state`)).json();
    assert.deepEqual(state, { state: "pending", waiting: true });

    await new Promise((r) => setTimeout(r, 450));
    const beforeSubmit = progress.length;
    assert.ok(beforeSubmit >= 3, `expected several progress notifications while waiting, got ${beforeSubmit}`);
    for (let i = 1; i < progress.length; i++) assert.ok(progress[i].progress > progress[i - 1].progress, "progress must increase");
    assert.match(progress.at(-1).message, /Waiting for answers to "Storage decisions"/);

    const response = await submit(url, {
      answers: {
        db: { status: "answer", selected: ["postgres"], notes: "We already run Postgres elsewhere." },
        features: { status: "answer", selected: ["search", "tags"] },
        naming: { status: "answer", selected: [], other: "question_bank" },
        later: { status: "defer", selected: [], notes: "Ask legal first" },
      },
      generalNotes: "Good questions.",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).delivered, true);

    const result = await call;
    assert.notEqual(result.isError, true);
    const s = result.structuredContent;
    assert.equal(s.status, "submitted");
    assert.equal(s.via, "browser");
    assert.deepEqual(s.counts, { answered: 3, deferred: 1, needsInfo: 0, unanswered: 0 });
    assert.equal(s.generalNotes, "Good questions.");
    const [db, features, naming, later] = s.answers;
    assert.deepEqual(db.selected, ["postgres"]);
    assert.deepEqual(db.selectedLabels, ["Postgres"]);
    assert.equal(db.followedRecommendation, false);
    assert.equal(db.notes, "We already run Postgres elsewhere.");
    assert.equal(features.followedRecommendation, true);
    assert.equal(naming.status, "answered");
    assert.equal(naming.other, "question_bank");
    assert.equal(later.status, "deferred");
    assert.equal(later.notes, "Ask legal first");

    assert.equal(result.content[0].type, "text");
    assert.match(result.content[0].text, /3 answered, 1 deferred/);
    assert.match(result.content[0].text, /\[db\] .* -> Postgres \| notes:/);
    assert.equal(s.summary, result.content[0].text, "summary also travels in structuredContent");
    const { summary, ...withoutSummary } = s;
    assert.deepEqual(JSON.parse(result.content[1].text), withoutSummary);

    const after = await (await fetch(`${apiBase(url)}/state`)).json();
    assert.equal(after.state, "submitted");
    const again = await submit(url, { answers: {} });
    assert.equal(again.status, 409, "a second submit must be refused");
  });

  test("schema-invalid input is rejected", async () => {
    const outcome = await conn.client
      .callTool({ name: "ask_user_rich", arguments: { title: "No questions" } })
      .then((r) => ({ result: r }), (error) => ({ error }));
    if (outcome.error) assert.match(String(outcome.error.message), /questions|invalid/i);
    else {
      assert.equal(outcome.result.isError, true);
      assert.match(outcome.result.content[0].text, /questions/);
    }
    const empty = await conn.client
      .callTool({ name: "ask_user_rich", arguments: { title: "x", questions: [] } })
      .then((r) => r, (error) => ({ isError: true, content: [{ text: error.message }] }));
    assert.equal(empty.isError, true);
  });

  test("semantically invalid input is rejected with every problem listed", async () => {
    const result = await conn.client.callTool({
      name: "ask_user_rich",
      arguments: {
        title: "Broken",
        questions: [
          { id: "a", header: "A", options: [{ id: "x", label: "X" }, { id: "x", label: "X again" }], recommended: "nope" },
          { id: "a", header: "Dup", options: [], allowOther: false, dependsOn: ["later"] },
          { id: "c", header: "C", options: [{ id: "1", label: "1" }, { id: "2", label: "2" }], recommended: ["1", "2"] },
        ],
      },
    });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, /duplicate option id "x"/);
    assert.match(text, /recommended "nope"/);
    assert.match(text, /duplicate question id "a"/);
    assert.match(text, /cannot be answered/);
    assert.match(text, /dependsOn "later"/);
    assert.match(text, /multiSelect is false/);
  });

  test("non-ASCII ids are rejected with the offending value and an ASCII suggestion", async () => {
    const outcome = await conn.client
      .callTool({
        name: "ask_user_rich",
        arguments: {
          title: "Acentos",
          questions: [{ id: "navegação", header: "Como navegar?", options: [{ id: "seção-tabs", label: "Seção tabs" }] }],
        },
      })
      .then((r) => r.content[0].text, (error) => String(error.message));
    assert.match(outcome, /"seção-tabs" is not ASCII-safe/);
    assert.match(outcome, /use "secao-tabs" instead/);
    assert.match(outcome, /use "navegacao" instead/);
  });

  test("a label used as recommended points at the matching option id", async () => {
    const result = await conn.client.callTool({
      name: "ask_user_rich",
      arguments: {
        title: "Labels",
        questions: [{ id: "a", header: "A", options: [{ id: "pg", label: "Postgres" }], recommended: "Postgres" }],
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /looks like a label; use the id "pg"/);
  });

  test("dependsOn on a later question says to reorder; on an earlier one it is accepted", async () => {
    const later = await conn.client.callTool({
      name: "ask_user_rich",
      arguments: {
        title: "Order",
        delivery: "link",
        questions: [
          { id: "a", header: "A", options: [], dependsOn: ["b"] },
          { id: "b", header: "B", options: [] },
        ],
      },
    });
    assert.equal(later.isError, true);
    assert.match(later.content[0].text, /dependsOn "b" points at a later question; move "b" before "a"/);
    const earlier = await conn.client.callTool({
      name: "ask_user_rich",
      arguments: {
        title: "Order",
        delivery: "link",
        questions: [
          { id: "a", header: "A", options: [] },
          { id: "b", header: "B", options: [], dependsOn: ["a"] },
        ],
      },
    });
    assert.equal(earlier.structuredContent.status, "awaiting");
  });

  test("instructions carry the common-mistakes list", () => {
    const instructions = conn.client.getInstructions();
    assert.match(instructions, /Common mistakes/);
    assert.match(instructions, /secao-tabs/);
    assert.match(instructions, /await_user_answers/);
  });

  test("a bad submission is refused and the interview stays open", async () => {
    const { call, url: urlPromise } = startAsk(conn.client, sampleInterview);
    const url = await urlPromise;
    const unknown = await submit(url, { answers: { db: { status: "answer", selected: ["mongo"] } } });
    assert.equal(unknown.status, 422);
    assert.match((await unknown.json()).error, /unknown option id "mongo"/);
    const two = await submit(url, { answers: { db: { status: "answer", selected: ["firestore", "postgres"] } } });
    assert.equal(two.status, 422);
    const text = await fetch(`${apiBase(url)}/submit`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
    assert.equal(text.status, 415, "non-JSON posts are refused (keeps cross-origin simple requests out)");
    // fetch() silently drops a custom Host header, so this goes through node:http.
    const rebound = await new Promise((resolve, reject) => {
      http.get(url, { headers: { Host: "evil.example" } }, (res) => resolve(res.statusCode)).on("error", reject);
    });
    assert.equal(rebound, 403, "foreign Host headers are refused (DNS rebinding)");

    const ok = await submit(url, { answers: { later: { status: "needs-info", notes: "What does legal say?" } } });
    assert.equal(ok.status, 200);
    const result = await call;
    assert.deepEqual(result.structuredContent.counts, { answered: 0, deferred: 0, needsInfo: 1, unanswered: 3 });
    assert.match(result.content[0].text, /\[later\] .* -> NEEDS-INFO \| notes: "What does legal say\?"/);
  });

  test("cancelling the tool call stops waiting cleanly and the answers stay collectable", async () => {
    const controller = new AbortController();
    const { call, url: urlPromise } = startAsk(conn.client, sampleInterview, { signal: controller.signal });
    const url = await urlPromise;
    controller.abort("user pressed Esc");
    await assert.rejects(call);

    await new Promise((r) => setTimeout(r, 150));
    const state = await (await fetch(`${apiBase(url)}/state`)).json();
    assert.deepEqual(state, { state: "pending", waiting: false }, "server stopped waiting but kept the form");
    assert.ok((await conn.client.listTools()).tools.length === 2, "server still healthy after cancellation");

    const sessionId = (await (await fetch(apiBase(url))).json()).id;
    const pending = conn.client.callTool({ name: "await_user_answers", arguments: { sessionId } }, CallToolResultSchema, { timeout: 10000 });
    await new Promise((r) => setTimeout(r, 150));
    const waitingAgain = await (await fetch(`${apiBase(url)}/state`)).json();
    assert.equal(waitingAgain.waiting, true);
    await submit(url, { answers: { db: { status: "answer", selected: ["firestore"] } } });
    const result = await pending;
    assert.deepEqual(result.structuredContent.answers[0].selected, ["firestore"]);
    assert.match(conn.stderr(), /wait ended without answers/);
  });

  test("delivery=link returns the URL at once; await_user_answers collects the submit", async () => {
    const first = await conn.client.callTool({ name: "ask_user_rich", arguments: { ...sampleInterview, delivery: "link" } });
    assert.equal(first.structuredContent.status, "awaiting");
    const { url, sessionId } = first.structuredContent;
    assert.match(first.content[0].text, /await_user_answers/);
    const response = await submit(url, { answers: { db: { status: "answer", selected: ["sqlite"] } } });
    assert.equal((await response.json()).delivered, false, "nobody was waiting yet");
    const result = await conn.client.callTool({ name: "await_user_answers", arguments: { sessionId } });
    assert.deepEqual(result.structuredContent.answers[0].selectedLabels, ["SQLite"]);
    const missing = await conn.client.callTool({ name: "await_user_answers", arguments: { sessionId: "nope" } });
    assert.equal(missing.isError, true);
  });

  test("submissions are archived to the log directory", () => {
    const files = fs.readdirSync(path.join(logDir, "answers"));
    assert.ok(files.length >= 3, `expected archived answers, found ${files.length}`);
    const log = fs.readFileSync(path.join(logDir, "server.log"), "utf8");
    assert.match(log, /session submitted/);
    assert.match(log, /progressToken=present/);
  });
});

describe("browser opening", () => {
  test("opens through the configured command and waits for that 'browser' to submit", async () => {
    const conn = await connect({ env: { ASK_USER_RICH_OPEN_CMD: fakeBrowser } });
    try {
      const result = await conn.client.callTool({ name: "ask_user_rich", arguments: sampleInterview }, CallToolResultSchema, { timeout: 20000 });
      const s = result.structuredContent;
      assert.equal(s.status, "submitted");
      assert.deepEqual(s.counts, { answered: 2, deferred: 2, needsInfo: 0, unanswered: 0 });
      assert.equal(s.answers[0].followedRecommendation, true);
      assert.match(conn.stderr(), /browser open .*opened=true/);
      assert.match(conn.stderr(), /page view/);
    } finally {
      await conn.client.close();
    }
  });

  test("falls back to returning the URL when the browser cannot be opened", async () => {
    const conn = await connect({ env: { ASK_USER_RICH_OPEN_CMD: "/nonexistent/browser" } });
    try {
      const result = await conn.client.callTool({ name: "ask_user_rich", arguments: sampleInterview });
      assert.equal(result.structuredContent.status, "awaiting");
      assert.match(result.content[0].text, /Could not open the browser/);
      assert.match(result.content[0].text, /http:\/\/localhost:\d+\/s\//);
    } finally {
      await conn.client.close();
    }
  });
});

describe("native elicitation mode", () => {
  test("asks through form elicitation when the client supports it", async () => {
    const conn = await connect({ capabilities: { elicitation: { form: {} } } });
    let requested;
    conn.client.setRequestHandler(ElicitRequestSchema, async (request) => {
      requested = request.params;
      return { action: "accept", content: { db: "sqlite", features: ["search"], naming__other: "qb", later: "1y" } };
    });
    try {
      const result = await conn.client.callTool({ name: "ask_user_rich", arguments: { ...sampleInterview, delivery: "elicitation" } });
      const props = requested.requestedSchema.properties;
      assert.equal(props.db.type, "string");
      assert.equal(props.db.default, "firestore");
      assert.equal(props.db.oneOf.find((o) => o.const === "firestore").title, "Firestore (recommended)");
      assert.equal(props.features.type, "array");
      assert.equal(props.naming__other.type, "string");
      const s = result.structuredContent;
      assert.equal(s.via, "elicitation");
      assert.deepEqual(s.answers.map((a) => a.status), ["answered", "answered", "answered", "answered"]);
      assert.equal(s.answers[2].other, "qb");
    } finally {
      await conn.client.close();
    }
  });

  test("falls back to the browser form when the client cannot elicit", async () => {
    const conn = await connect({ env: { ASK_USER_RICH_OPEN: "0" } });
    try {
      const result = await conn.client.callTool({ name: "ask_user_rich", arguments: { ...sampleInterview, delivery: "elicitation" } });
      assert.equal(result.structuredContent.status, "awaiting", "OPEN=0 turns the browser path into a returned link");
      assert.match(result.content[0].text, /ASK_USER_RICH_OPEN=0/);
      assert.match(conn.stderr(), /elicitation unsupported by client/);
    } finally {
      await conn.client.close();
    }
  });
});

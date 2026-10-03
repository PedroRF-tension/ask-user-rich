// S1: the real daemon as a black box. Each suite starts one under a scratch home through
// launch.js, then plays its two clients: the mod over the Unix socket, the browser over HTTP.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "daemon", "launch.js");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startDaemon(extraEnv = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aur-daemon-"));
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ASK_USER_RICH_HOME: home,
    ASK_USER_RICH_PORT: "0",
    ASK_USER_RICH_HOSTS: "127.0.0.1",
    ...extraEnv,
  };
  const launch = () => JSON.parse(execFileSync(process.execPath, [launcher], { env, encoding: "utf8" }).trim());
  const first = launch();
  assert.equal(first.ok, true, JSON.stringify(first));
  const socket = path.join(home, "daemon.sock");
  return { home, env, socket, launch, first };
}

/** The mod's side: JSON over the Unix socket. */
function mod(socket, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      { socketPath: socket, path: route, method, headers: payload ? { "Content-Type": "application/json" } : {} },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const post = (socket, route, body) => mod(socket, "POST", route, body);

async function page(base, route, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get("content-type") || "";
  return { status: res.status, type, body: type.startsWith("application/json") ? await res.json() : await res.text() };
}

const interview = (over = {}) => ({
  title: "Storage decisions",
  intro: "We need to pick a **storage layer**.",
  questions: [
    {
      id: "db",
      header: "Which database?",
      options: [
        { id: "postgres", label: "Postgres" },
        { id: "sqlite", label: "SQLite" },
      ],
      recommended: "postgres",
      rationale: "Relational.",
    },
    { id: "why", header: "Anything else?" },
  ],
  ...over,
});

async function stopDaemon(d) {
  await post(d.socket, "/mod/shutdown", { force: true }).catch(() => {});
  await sleep(150);
}

describe("daemon: the Round lifecycle", () => {
  let d;
  let base;
  let urls;
  let tokenValue;
  before(async () => {
    d = startDaemon();
  });
  after(() => stopDaemon(d));

  test("launch starts it once; a second launch finds it running", async () => {
    const hello = await mod(d.socket, "GET", "/mod/hello");
    assert.equal(hello.status, 200);
    assert.equal(hello.body.version, d.first.version);
    assert.ok(hello.body.port > 0);
    base = `http://127.0.0.1:${hello.body.port}`;
    const again = d.launch();
    assert.equal(again.already, true);
    assert.equal(again.pid, d.first.pid);
  });

  test("ask opens Round 1 and returns the Thread's urls at once", async () => {
    const res = await post(d.socket, "/mod/ask", { session: "s1", project: "demo", cwd: "/tmp/demo", input: interview() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.round.n, 1);
    assert.equal(res.body.round.joined, false);
    assert.equal(res.body.round.total, 2);
    urls = res.body.urls;
    assert.match(urls.internal, /^http:\/\/localhost:\d+\/c\/[A-Za-z0-9_-]{20,}$/);
    assert.equal(urls.public, null);
    tokenValue = urls.internal.split("/").pop();
    assert.equal(res.body.thread.openRound, 1);
  });

  test("the Thread page, its JSON and the Round's JSON are served", async () => {
    const html = await page(base, `/c/${tokenValue}`);
    assert.equal(html.status, 200);
    assert.match(html.type, /text\/html/);
    const focus = await page(base, `/c/${tokenValue}/r/1`);
    assert.equal(focus.status, 200);
    const view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.title, "Storage decisions");
    assert.equal(view.body.project, "demo");
    assert.deepEqual(
      view.body.items.map((i) => i.kind),
      ["round"],
    );
    assert.equal(view.body.rounds[0].state, "open");
    assert.equal(view.body.presence.state, "waiting");
    const round = await page(base, `/api/c/${tokenValue}/r/1`);
    assert.equal(round.body.spec.questions.length, 2);
    assert.equal(round.body.version, 1);
    assert.equal(round.body.thread.url, `/c/${tokenValue}`);
    assert.equal((await page(base, `/c/nope`)).status, 404);
  });

  test("an ask while the Round is open joins it under a heading", async () => {
    const res = await post(d.socket, "/mod/ask", {
      session: "s1",
      input: interview({ title: "Caching", intro: "One more.", questions: [{ id: "cache", header: "Cache?", options: [{ id: "y", label: "Yes" }] }] }),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.round.n, 1);
    assert.equal(res.body.round.joined, true);
    assert.equal(res.body.round.version, 2);
    const round = await page(base, `/api/c/${tokenValue}/r/1`);
    assert.equal(round.body.spec.questions.length, 3);
    assert.match(round.body.note.text, /\*\*Caching\*\*/);
    assert.deepEqual(round.body.sections, [{ title: "Caching", from: 2 }]);
  });

  test("append adds follow-ups; ids must stay unique across the Round", async () => {
    const dup = await post(d.socket, "/mod/append", { session: "s1", input: { questions: [{ id: "db", header: "Again?" }] } });
    assert.equal(dup.status, 400);
    assert.match(dup.body.error, /duplicate question id "db"/);
    const ok = await post(d.socket, "/mod/append", { session: "s1", input: { questions: [{ id: "extra", header: "Extra?" }], note: "Why" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.round.version, 3);
    assert.equal(ok.body.round.appended, 1);
  });

  test("a stale submit is refused with the current version", async () => {
    const stale = await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: { specVersion: 1, answers: {} } });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.version, 3);
  });

  test("a bad submission is refused and the Round stays open", async () => {
    const bad = await page(base, `/api/c/${tokenValue}/r/1/submit`, {
      method: "POST",
      body: { specVersion: 3, answers: { db: { status: "answer", selected: ["mongo"] } } },
    });
    assert.equal(bad.status, 422);
    const text = await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: undefined, headers: { "Content-Type": "text/plain" } });
    assert.equal(text.status, 415);
  });

  test("submit archives, closes the Round and leaves a delivery for the mod", async () => {
    const res = await page(base, `/api/c/${tokenValue}/r/1/submit`, {
      method: "POST",
      body: { specVersion: 3, answers: { db: { status: "answer", selected: ["postgres"] }, why: { status: "answer", other: "No." } } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.counts.answered, 2);
    const again = await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: { answers: {} } });
    assert.equal(again.status, 409);

    const pending = await post(d.socket, "/mod/pending", { session: "s1" });
    assert.equal(pending.body.thread.openRound, null);
    assert.equal(pending.body.deliveries.length, 1);
    const [delivery] = pending.body.deliveries;
    assert.equal(delivery.kind, "answers");
    assert.equal(delivery.round, 1);
    assert.match(delivery.summary, /\[db\] Which database\? -> Postgres \(recommended\)/);
    assert.equal(delivery.result.answers.find((a) => a.id === "why").other, "No.");

    const archived = fs.readdirSync(path.join(d.home, "answers"));
    assert.equal(archived.length, 1);

    const view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.rounds[0].state, "submitted");
    assert.deepEqual(view.body.rounds[0].lines[0], { id: "db", header: "Which database?", answer: "Postgres", status: "answered" });

    const acked = await post(d.socket, "/mod/ack", { session: "s1", ids: [delivery.id] });
    assert.equal(acked.body.acked, 1);
    assert.equal((await post(d.socket, "/mod/pending", { session: "s1" })).body.deliveries.length, 0);
  });

  test("append with no open Round says to ask again", async () => {
    const res = await post(d.socket, "/mod/append", { session: "s1", input: { questions: [{ id: "late", header: "Late?" }] } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /new ask_user_rich call/);
  });

  test("invalid input is rejected with every problem listed, as before", async () => {
    const ascii = await post(d.socket, "/mod/ask", {
      session: "s1",
      input: interview({ questions: [{ id: "seção", header: "Bad id", options: [{ id: "a", label: "A" }] }] }),
    });
    assert.equal(ascii.status, 400);
    assert.match(ascii.body.error, /use "secao" instead/);
    const res = await post(d.socket, "/mod/ask", {
      session: "s1",
      input: interview({
        questions: [
          { id: "r", header: "Rank", kind: "rank", options: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], recommended: "x" },
          { id: "lbl", header: "Label", options: [{ id: "pg", label: "Postgres" }], recommended: "Postgres" },
        ],
      }),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^Invalid interview:/);
    assert.match(res.body.error, /recommended on a rank question is the recommended order/);
    assert.match(res.body.error, /use the id "pg"/);
  });

  test("the mod's routes are not on TCP, and a foreign Host is refused", async () => {
    assert.equal((await page(base, "/mod/hello")).status, 404);
    const res = await new Promise((resolve) => {
      http.get(`${base}/api/threads`, { headers: { Host: "evil.example" } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      });
    });
    assert.equal(res, 403);
  });

  test("the index lists the Thread", async () => {
    const res = await page(base, "/api/threads");
    assert.equal(res.body.threads.length, 1);
    assert.equal(res.body.threads[0].title, "Storage decisions");
    assert.equal(res.body.threads[0].project, "demo");
    assert.equal(res.body.threads[0].waiting, false);
    assert.equal((await page(base, "/")).status, 200);
  });
});

describe("daemon: the chat around the Rounds", () => {
  let d;
  let base;
  let tokenValue;
  before(async () => {
    d = startDaemon({ ASK_USER_RICH_ATTACHED_MS: "800" });
    base = `http://127.0.0.1:${(await mod(d.socket, "GET", "/mod/hello")).body.port}`;
    const res = await post(d.socket, "/mod/ask", { session: "s2", input: interview() });
    tokenValue = res.body.urls.internal.split("/").pop();
  });
  after(() => stopDaemon(d));

  test("mirrored lines land in the stream while the Thread is open", async () => {
    const res = await post(d.socket, "/mod/mirror", {
      session: "s2",
      messages: [
        { kind: "assistant", text: "I updated CONTEXT.md." },
        { kind: "user", text: "thanks" },
        { kind: "chip", text: "Edit CONTEXT.md" },
        { kind: "thinking", text: "never" },
        { kind: "assistant", text: "   " },
      ],
    });
    assert.equal(res.body.stored, 3);
    const view = await page(base, `/api/c/${tokenValue}`);
    assert.deepEqual(
      view.body.items.map((i) => `${i.kind}:${i.role ?? ""}`),
      ["round:", "message:assistant", "message:user", "chip:"],
    );
  });

  test("presence: working while a turn runs, waiting with a Round open, not running once silent", async () => {
    await post(d.socket, "/mod/presence", { session: "s2", state: "working", chip: "Read hub.js" });
    let view = await page(base, `/api/c/${tokenValue}`);
    assert.deepEqual(view.body.presence, { state: "working", chip: "Read hub.js" });
    await post(d.socket, "/mod/presence", { session: "s2", state: "idle" });
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.presence.state, "waiting");
    await sleep(1000);
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.presence.state, "not-running");
    await post(d.socket, "/mod/pending", { session: "s2" });
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.presence.state, "waiting");
  });

  test("the event stream announces every change", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/c/${tokenValue}/events`, { signal: controller.signal });
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const until = async (re) => {
      const deadline = Date.now() + 3000;
      while (!re.test(text) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
      return re.test(text);
    };
    assert.ok(await until(/event: changed\ndata: \{"rev":\d+/));
    const before = [...text.matchAll(/"rev":(\d+)/g)].map((m) => Number(m[1])).pop();
    await post(d.socket, "/mod/mirror", { session: "s2", messages: [{ kind: "assistant", text: "more" }] });
    assert.ok(await until(new RegExp(`"rev":${before + 1}`)));
    controller.abort();
  });

  test("drafts: one client's save is served to another, merged per question", async () => {
    const a = await page(base, `/api/c/${tokenValue}/r/1/draft`, {
      method: "POST",
      body: { client: "laptop", draft: { step: 1, answers: { db: { mode: "answer", selected: ["sqlite"] } } } },
    });
    assert.equal(a.status, 200);
    await page(base, `/api/c/${tokenValue}/r/1/draft`, {
      method: "POST",
      body: { client: "phone", draft: { answers: { why: { mode: "answer", otherOn: true, other: "x" } } } },
    });
    const round = await page(base, `/api/c/${tokenValue}/r/1`);
    assert.deepEqual(round.body.draft.answers.db.selected, ["sqlite"]);
    assert.equal(round.body.draft.answers.why.other, "x");
    assert.equal(round.body.draftBy, "phone");
    const state = await page(base, `/api/c/${tokenValue}/r/1/state`);
    assert.equal(state.body.draftRev, 2);
  });

  test("a composer message becomes a delivery and shows delivered once acked", async () => {
    const res = await page(base, `/api/c/${tokenValue}/messages`, { method: "POST", body: { text: "  Q3: actually B  " } });
    assert.equal(res.status, 200);
    let pending = await post(d.socket, "/mod/pending", { session: "s2" });
    const message = pending.body.deliveries.find((x) => x.kind === "message");
    assert.equal(message.text, "Q3: actually B");
    let view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.items.at(-1).delivered, false);
    await post(d.socket, "/mod/ack", { session: "s2", ids: [message.id] });
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.items.at(-1).delivered, true);
    assert.equal((await page(base, `/api/c/${tokenValue}/messages`, { method: "POST", body: { text: " " } })).status, 400);
  });

  test("close stops mirroring; End from the page notifies; a message reopens", async () => {
    await post(d.socket, "/mod/close", { session: "s2", summary: "Decided." });
    let view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.state, "closed");
    assert.deepEqual(view.body.items.at(-1), { ...view.body.items.at(-1), kind: "divider", label: "closed", by: "model", summary: "Decided." });
    const dropped = await post(d.socket, "/mod/mirror", { session: "s2", messages: [{ kind: "assistant", text: "build output" }] });
    assert.equal(dropped.body.stored, 0);

    await page(base, `/api/c/${tokenValue}/messages`, { method: "POST", body: { text: "one more thing" } });
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.state, "open");
    assert.equal(view.body.items.at(-2).label, "reopened");
    assert.equal(view.body.items.at(-2).by, "page");

    const end = await page(base, `/api/c/${tokenValue}/end`, { method: "POST", body: {} });
    assert.equal(end.status, 200);
    view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.state, "closed");
    assert.equal(view.body.items.at(-1).by, "page");
    const pending = await post(d.socket, "/mod/pending", { session: "s2" });
    assert.ok(pending.body.deliveries.some((x) => x.kind === "end"));
  });

  test("a new Round reopens a closed Thread with a divider", async () => {
    await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: { answers: { db: { status: "defer" } } } });
    const res = await post(d.socket, "/mod/ask", {
      session: "s2",
      input: interview({ title: "Round two", questions: [{ id: "q2", header: "Second?" }] }),
    });
    assert.equal(res.body.round.n, 2);
    const view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.body.state, "open");
    assert.deepEqual(
      view.body.items.slice(-2).map((i) => i.label ?? i.kind),
      ["reopened", "round"],
    );
  });

  test("shutdown is refused while a Round is open, unless forced", async () => {
    const res = await post(d.socket, "/mod/shutdown", {});
    assert.equal(res.status, 409);
    assert.equal(res.body.openRounds, 1);
  });
});

describe("daemon: persistence, idle exit and pruning", () => {
  test("Threads and pending deliveries survive a restart", async () => {
    const d = startDaemon();
    const ask = await post(d.socket, "/mod/ask", { session: "s3", input: interview() });
    const tokenValue = ask.body.urls.internal.split("/").pop();
    let base = `http://127.0.0.1:${(await mod(d.socket, "GET", "/mod/hello")).body.port}`;
    await page(base, `/api/c/${tokenValue}/messages`, { method: "POST", body: { text: "while you were gone" } });
    await post(d.socket, "/mod/shutdown", { force: true });
    await sleep(300);
    const second = d.launch();
    assert.equal(second.already, false);
    assert.notEqual(second.pid, d.first.pid);
    base = `http://127.0.0.1:${(await mod(d.socket, "GET", "/mod/hello")).body.port}`;
    const view = await page(base, `/api/c/${tokenValue}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.rounds[0].state, "open");
    const pending = await post(d.socket, "/mod/pending", { session: "s3" });
    assert.deepEqual(
      pending.body.deliveries.map((x) => x.text),
      ["while you were gone"],
    );
    await stopDaemon(d);
  });

  test("it exits by itself once idle with no Round open and no page connected", async () => {
    const d = startDaemon({ ASK_USER_RICH_IDLE_MS: "1200" });
    assert.equal((await mod(d.socket, "GET", "/mod/hello")).status, 200);
    await sleep(2600);
    await assert.rejects(mod(d.socket, "GET", "/mod/hello"));
  });

  test("an answer no conversation collected yet keeps it alive past the idle window", async () => {
    const d = startDaemon({ ASK_USER_RICH_IDLE_MS: "1200" });
    const ask = await post(d.socket, "/mod/ask", { session: "s6", input: interview() });
    const tokenValue = ask.body.urls.internal.split("/").pop();
    const base = `http://127.0.0.1:${(await mod(d.socket, "GET", "/mod/hello")).body.port}`;
    await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: { answers: { db: { status: "defer" } } } });
    await sleep(2600);
    assert.equal((await mod(d.socket, "GET", "/mod/hello")).status, 200);
    await stopDaemon(d);
  });

  test("an open Round keeps it alive past the idle window", async () => {
    const d = startDaemon({ ASK_USER_RICH_IDLE_MS: "1200" });
    await post(d.socket, "/mod/ask", { session: "s4", input: interview() });
    await sleep(2600);
    assert.equal((await mod(d.socket, "GET", "/mod/hello")).status, 200);
    await stopDaemon(d);
  });

  test("Threads idle past the keep window are pruned; the archive stays", async () => {
    const d = startDaemon({ ASK_USER_RICH_KEEP_DAYS: String(1 / 86400), ASK_USER_RICH_PRUNE_EVERY_MS: "300" });
    const ask = await post(d.socket, "/mod/ask", { session: "s5", input: interview() });
    const tokenValue = ask.body.urls.internal.split("/").pop();
    const base = `http://127.0.0.1:${(await mod(d.socket, "GET", "/mod/hello")).body.port}`;
    await page(base, `/api/c/${tokenValue}/r/1/submit`, { method: "POST", body: { answers: { db: { status: "defer" } } } });
    await sleep(1800);
    assert.equal((await page(base, `/api/c/${tokenValue}`)).status, 404);
    assert.equal(fs.readdirSync(path.join(d.home, "threads")).length, 0);
    assert.equal(fs.readdirSync(path.join(d.home, "answers")).length, 1);
    await stopDaemon(d);
  });
});

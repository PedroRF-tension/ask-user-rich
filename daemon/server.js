// The daemon's two contracts: the page over HTTP on the configured hosts, the mod over a Unix
// socket. The mod's routes are never served on TCP.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConflictError, InputError, NotFoundError, UnprocessableError } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const PRESENCE_TICK_MS = 3000;

// Package "exports" hide these browser bundles from require.resolve, so they are addressed by path,
// walking up the node_modules chain the way Node does.
const vendor = (file) => {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", file);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return path.join(root, "node_modules", file);
  }
};

const JS = "text/javascript; charset=utf-8";
const ASSETS = {
  "/assets/app.js": { file: path.join(publicDir, "app.js"), type: JS },
  "/assets/style.css": { file: path.join(publicDir, "style.css"), type: "text/css; charset=utf-8" },
  "/assets/marked.js": { file: vendor("marked/lib/marked.umd.js"), type: JS },
  "/assets/purify.js": { file: vendor("dompurify/dist/purify.min.js"), type: JS },
};
const MODULES = /^\/assets\/js\/([a-z-]+\.js)$/;

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new InputError("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`invalid JSON: ${error.message}`);
  }
}

function sendError(res, error) {
  if (error instanceof InputError) return send(res, 400, { error: error.message });
  if (error instanceof NotFoundError) return send(res, 404, { error: error.message });
  if (error instanceof UnprocessableError) return send(res, 422, { error: error.message });
  if (error instanceof ConflictError) {
    const { message, ...extra } = error;
    return send(res, 409, { error: message, ...extra });
  }
  throw error;
}

export class Daemon {
  constructor({ store, version, hosts, port, publicHost, log = () => {}, now = () => Date.now() }) {
    this.store = store;
    this.version = version;
    this.hosts = hosts;
    this.port = port;
    this.publicHost = publicHost;
    this.log = log;
    this.now = now;
    this.startedAt = now();
    this.listeners = new Map(); // thread id -> Set<res>
    this.sentPresence = new Map(); // thread id -> last presence sent
    this.tcp = [];
    this.socket = null;
    this.lastBusyAt = now();
    this.onShutdown = () => {};
    store.onChange = (thread) => this.broadcast(thread);
  }

  // ---- addresses -------------------------------------------------------------------

  hasPublic() {
    return !LOOPBACK.has(this.publicHost);
  }

  urls(thread) {
    const p = `/c/${thread.token}`;
    return {
      internal: `http://localhost:${this.port}${p}`,
      public: this.hasPublic() ? `http://${this.publicHost}:${this.port}${p}` : null,
    };
  }

  indexUrls() {
    return {
      internal: `http://localhost:${this.port}/`,
      public: this.hasPublic() ? `http://${this.publicHost}:${this.port}/` : null,
    };
  }

  // ---- listening ---------------------------------------------------------------------

  async listenTcp() {
    const listen = (host, wanted) =>
      new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => this.dispatch(req, res, "tcp"));
        server.once("error", reject);
        server.listen(wanted, host, () => {
          this.tcp.push(server);
          resolve(server.address().port);
        });
      });
    try {
      let chosen = this.port;
      for (const host of this.hosts) chosen = await listen(host, chosen);
      this.port = chosen;
    } catch (error) {
      await this.closeTcp();
      throw error;
    }
    return this.port;
  }

  async listenSocket(socketPath) {
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.dispatch(req, res, "socket"));
      server.once("error", reject);
      server.listen(socketPath, () => {
        this.socket = server;
        resolve();
      });
    });
    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {}
  }

  startTicks() {
    this.presenceTimer = setInterval(() => this.tickPresence(), PRESENCE_TICK_MS);
    this.presenceTimer.unref?.();
  }

  async closeTcp() {
    await Promise.all(
      this.tcp.map((server) => {
        server.closeAllConnections?.();
        return new Promise((resolve) => server.close(() => resolve()));
      }),
    );
    this.tcp = [];
  }

  async stop() {
    clearInterval(this.presenceTimer);
    for (const set of this.listeners.values()) for (const res of set) res.end();
    this.listeners.clear();
    await this.closeTcp();
    if (this.socket) {
      this.socket.closeAllConnections?.();
      await new Promise((resolve) => this.socket.close(() => resolve()));
      this.socket = null;
    }
  }

  // ---- idle accounting ----------------------------------------------------------------

  pageConnections() {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  /** True when no Round is open and no page is connected, and that has held for `idleMs`. */
  isIdle(idleMs) {
    if (this.store.openRoundCount() > 0 || this.pageConnections() > 0) {
      this.lastBusyAt = this.now();
      return false;
    }
    return this.now() - this.lastBusyAt >= idleMs;
  }

  // ---- live updates -------------------------------------------------------------------

  broadcast(thread) {
    const set = this.listeners.get(thread.id);
    if (!set || set.size === 0) return;
    const presence = this.store.presenceOf(thread);
    this.sentPresence.set(thread.id, presence);
    const data = JSON.stringify({ rev: thread.rev, presence });
    for (const res of set) res.write(`event: changed\ndata: ${data}\n\n`);
  }

  // Attachment ends by silence, not by a request: a periodic look sends that change.
  tickPresence() {
    for (const [id, set] of this.listeners) {
      if (set.size === 0) continue;
      const thread = this.store.threads.get(id);
      if (!thread) continue;
      const presence = this.store.presenceOf(thread);
      if (this.sentPresence.get(id) !== presence) this.broadcast(thread);
      else for (const res of set) res.write(`: ping\n\n`);
    }
  }

  // ---- routing --------------------------------------------------------------------------

  dispatch(req, res, via) {
    this.handle(req, res, via).catch((error) => {
      this.log("http handler error", { error: String(error?.stack ?? error) });
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  }

  async handle(req, res, via) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;
    if (via === "socket" && pathname.startsWith("/mod/")) return this.handleMod(req, res, pathname);
    if (via === "tcp") {
      const hostHeader = (req.headers.host || "").replace(/:\d+$/, "");
      // A Host allowlist blocks DNS-rebinding pages from reading a Thread.
      if (!LOOPBACK.has(hostHeader) && hostHeader !== this.publicHost) return send(res, 403, { error: "forbidden host" });
    }
    try {
      return await this.handlePage(req, res, pathname);
    } catch (error) {
      return sendError(res, error);
    }
  }

  async handlePage(req, res, pathname) {
    if (req.method === "GET") {
      if (ASSETS[pathname]) return send(res, 200, fs.readFileSync(ASSETS[pathname].file), ASSETS[pathname].type);
      const mod = pathname.match(MODULES);
      if (mod) {
        const file = path.join(publicDir, "js", mod[1]);
        if (fs.existsSync(file)) return send(res, 200, fs.readFileSync(file), JS);
      }
      if (pathname === "/favicon.ico") return send(res, 204, "");
      if (pathname === "/") return send(res, 200, fs.readFileSync(path.join(publicDir, "home.html")), "text/html; charset=utf-8");
      if (pathname === "/api/threads") return send(res, 200, { threads: this.store.index() });
    }

    const page = pathname.match(/^\/c\/([A-Za-z0-9_-]+)(?:\/r\/(\d+))?$/);
    if (req.method === "GET" && page) {
      const thread = this.store.byToken(page[1]);
      if (!thread) return send(res, 404, "Thread not found or expired.", "text/plain; charset=utf-8");
      this.log("page view", { thread: thread.id, round: page[2] ?? null, ua: req.headers["user-agent"] ?? "" });
      const file = page[2] ? "index.html" : "thread.html";
      return send(res, 200, fs.readFileSync(path.join(publicDir, file)), "text/html; charset=utf-8");
    }

    const api = pathname.match(/^\/api\/c\/([A-Za-z0-9_-]+)(\/events|\/messages|\/end|\/r\/(\d+)(\/state|\/submit|\/draft)?)?$/);
    if (!api) return send(res, 404, { error: "not found" });
    const thread = this.store.requireToken(api[1]);
    const action = api[2] ?? "";

    if (req.method === "GET" && action === "") return send(res, 200, this.store.view(thread));
    if (req.method === "GET" && action === "/events") return this.subscribe(req, res, thread);

    if (api[3]) {
      const n = Number(api[3]);
      const round = this.store.round(thread, n);
      const sub = api[4] ?? "";
      if (req.method === "GET" && sub === "") {
        return send(res, 200, {
          id: `${thread.id}-r${n}`,
          thread: { title: thread.title, url: `/c/${thread.token}` },
          state: round.state,
          version: round.version,
          note: round.note,
          spec: round.spec,
          sections: round.sections,
          result: round.result,
          draft: round.draft,
          draftRev: round.draftRev,
          draftBy: round.draftBy,
          presence: this.store.presenceOf(thread),
        });
      }
      if (req.method === "GET" && sub === "/state") {
        return send(res, 200, {
          state: round.state,
          version: round.version,
          draftRev: round.draftRev,
          draftBy: round.draftBy,
          presence: this.store.presenceOf(thread),
        });
      }
      if (req.method === "POST" && (sub === "/submit" || sub === "/draft")) {
        if (!this.isJson(req)) return send(res, 415, { error: "expected application/json" });
        const body = await readJson(req);
        if (sub === "/draft") {
          const out = this.store.draft(api[1], n, body);
          return send(res, 200, { ok: true, draftRev: out.round.draftRev });
        }
        const out = this.store.submit(api[1], n, body);
        return send(res, 200, { ok: true, counts: out.result.counts, attached: this.store.isAttached(thread) });
      }
      return send(res, 404, { error: "not found" });
    }

    if (req.method === "POST" && (action === "/messages" || action === "/end")) {
      // A JSON content type forces a CORS preflight, which this server never answers, so other origins
      // cannot post blind.
      if (!this.isJson(req)) return send(res, 415, { error: "expected application/json" });
      const body = await readJson(req);
      if (action === "/messages") {
        const out = this.store.message(api[1], body.text);
        return send(res, 200, { ok: true, delivery: out.delivery.id, attached: this.store.isAttached(thread) });
      }
      this.store.end(api[1]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: "not found" });
  }

  isJson(req) {
    return String(req.headers["content-type"] || "").startsWith("application/json");
  }

  subscribe(req, res, thread) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });
    const set = this.listeners.get(thread.id) ?? new Set();
    this.listeners.set(thread.id, set);
    set.add(res);
    this.lastBusyAt = this.now();
    const presence = this.store.presenceOf(thread);
    res.write(`retry: 2000\nevent: changed\ndata: ${JSON.stringify({ rev: thread.rev, presence })}\n\n`);
    req.on("close", () => {
      set.delete(res);
      this.lastBusyAt = this.now();
    });
  }

  // ---- the mod's routes -------------------------------------------------------------------

  threadRef(thread) {
    const open = this.store.openRound(thread);
    return { id: thread.id, token: thread.token, state: thread.state, openRound: open ? open.n : null, urls: this.urls(thread) };
  }

  async handleMod(req, res, pathname) {
    try {
      if (req.method === "GET" && pathname === "/mod/hello") {
        return send(res, 200, {
          version: this.version,
          pid: process.pid,
          port: this.port,
          hosts: this.hosts,
          publicHost: this.publicHost,
          openRounds: this.store.openRoundCount(),
          startedAt: this.startedAt,
          index: this.indexUrls(),
        });
      }
      if (req.method !== "POST") return send(res, 404, { error: "not found" });
      const body = await readJson(req);
      const session = typeof body.session === "string" && body.session ? body.session : null;
      if (pathname === "/mod/shutdown") {
        const open = this.store.openRoundCount();
        if (open > 0 && body.force !== true) return send(res, 409, { error: `${open} Round(s) open`, openRounds: open });
        send(res, 200, { ok: true });
        setImmediate(() => this.onShutdown(body.reason ?? "asked by the mod"));
        return;
      }
      if (!session) throw new InputError("session is required");
      switch (pathname) {
        case "/mod/ask": {
          const out = this.store.ask(session, body.input, { project: body.project ?? null, cwd: body.cwd ?? null });
          this.log("round asked", { thread: out.thread.id, round: out.round.n, joined: out.joined });
          return send(res, 200, {
            thread: this.threadRef(out.thread),
            round: { n: out.round.n, version: out.round.version, total: out.round.spec.questions.length, joined: out.joined },
            urls: this.urls(out.thread),
          });
        }
        case "/mod/append": {
          const out = this.store.append(session, body.input);
          this.log("questions appended", { thread: out.thread.id, round: out.round.n, appended: out.appended });
          return send(res, 200, {
            thread: this.threadRef(out.thread),
            round: { n: out.round.n, version: out.round.version, total: out.round.spec.questions.length, appended: out.appended },
            urls: this.urls(out.thread),
          });
        }
        case "/mod/close": {
          const thread = this.store.close(session, body.summary ?? null);
          return send(res, 200, { thread: this.threadRef(thread) });
        }
        case "/mod/mirror":
          return send(res, 200, this.store.mirror(session, Array.isArray(body.messages) ? body.messages : []));
        case "/mod/presence": {
          const thread = this.store.presence(session, { state: body.state, chip: body.chip ?? null });
          return send(res, 200, { thread: thread ? this.threadRef(thread) : null });
        }
        case "/mod/pending": {
          const out = this.store.pending(session);
          return send(res, 200, { thread: out.thread ? this.threadRef(out.thread) : null, deliveries: out.deliveries });
        }
        case "/mod/ack":
          return send(res, 200, { acked: this.store.ack(session, Array.isArray(body.ids) ? body.ids : []) });
        default:
          return send(res, 404, { error: "not found" });
      }
    } catch (error) {
      return sendError(res, error);
    }
  }
}

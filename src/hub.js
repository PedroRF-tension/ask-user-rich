import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildResult } from "./answers.js";
import { archiveResult, log } from "./log.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
// Package "exports" hide these browser bundles from require.resolve, so they are addressed by path,
// walking up the node_modules chain the way Node does (npx hoists them beside this package).
const vendor = (file) => {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", file);
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return path.join(root, "node_modules", file);
  }
};

const ASSETS = {
  "/assets/app.js": { file: path.join(publicDir, "app.js"), type: "text/javascript; charset=utf-8" },
  "/assets/style.css": { file: path.join(publicDir, "style.css"), type: "text/css; charset=utf-8" },
  "/assets/marked.js": { file: vendor("marked/lib/marked.umd.js"), type: "text/javascript; charset=utf-8" },
  "/assets/purify.js": { file: vendor("dompurify/dist/purify.min.js"), type: "text/javascript; charset=utf-8" },
};

const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
// Finished sessions stay readable for a while so a reloaded tab can still say "already sent".
const FINISHED_TTL_MS = 30 * 60 * 1000;

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
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class InterviewHub {
  constructor({ host = "127.0.0.1", port = 0, portSpan = 10, publicHost = "localhost" } = {}) {
    // A comma-separated host binds every address on the same port, e.g. loopback plus a Tailscale IP.
    this.hosts = String(host).split(",").map((h) => h.trim()).filter(Boolean);
    this.port = port;
    this.portSpan = Math.max(1, portSpan);
    this.publicHost = publicHost;
    this.servers = [];
    this.sessions = new Map(); // token -> session
    this.byId = new Map(); // id -> session
    this.listening = null;
  }

  async start() {
    if (this.listening) return this.listening;
    // A rejection is not cached: a later call retries, so a session whose ports were all taken recovers once one frees.
    this.listening = this.bindRange().catch((error) => {
      this.listening = null;
      this.servers = [];
      throw error;
    });
    return this.listening;
  }

  /** Tries port, port+1 .. port+span-1 (a random port when port is 0) until every host binds on one of them. */
  async bindRange() {
    const first = this.port;
    const attempts = first === 0 ? 1 : this.portSpan;
    let lastError;
    for (let i = 0; i < attempts; i++) {
      const port = first === 0 ? 0 : first + i;
      try {
        this.port = await this.bindAll(port);
        log("web server listening", { hosts: this.hosts, port: this.port });
        return this.port;
      } catch (error) {
        lastError = error;
        if (error.code !== "EADDRINUSE" && error.code !== "EADDRNOTAVAIL") break;
        log("port unavailable", { port, code: error.code });
      }
    }
    this.port = first;
    throw lastError;
  }

  /** Binds every host on one port; on any failure closes what bound, so no partial server stays listening. */
  async bindAll(port) {
    const bound = [];
    const listen = (host, wanted) =>
      new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this.handle(req, res).catch((error) => {
            log("http handler error", { error: String(error) });
            if (!res.headersSent) send(res, 500, { error: "internal error" });
          });
        });
        server.once("error", reject);
        server.listen(wanted, host, () => {
          bound.push(server);
          resolve(server.address().port);
        });
      });
    try {
      // The first bind picks the port (0 means random); the others reuse it so every URL differs only by host.
      let chosen = port;
      for (const host of this.hosts) chosen = await listen(host, chosen);
      this.servers = bound;
      return chosen;
    } catch (error) {
      await Promise.all(bound.map((server) => new Promise((resolve) => server.close(() => resolve()))));
      throw error;
    }
  }

  async stop() {
    if (this.servers.length === 0) return;
    for (const session of this.byId.values()) this.cancel(session, "server shutting down");
    await Promise.all(
      this.servers.map((server) => {
        server.closeAllConnections?.();
        return new Promise((resolve) => server.close(() => resolve()));
      }),
    );
    this.servers = [];
    this.listening = null;
  }

  create(spec) {
    const session = {
      id: crypto.randomBytes(6).toString("hex"),
      token: crypto.randomBytes(18).toString("base64url"),
      spec,
      createdAt: Date.now(),
      state: "pending",
      result: null,
      // Bumped by every append, so a form built from an older spec cannot submit over the new questions.
      version: 1,
      lastNote: null,
      pageViews: 0,
      waiters: 0,
    };
    session.done = new Promise((resolve) => {
      session.finish = resolve;
    });
    this.sessions.set(session.token, session);
    this.byId.set(session.id, session);
    return session;
  }

  get(id) {
    return this.byId.get(id);
  }

  /** The loopback URL: what the local browser opens. */
  url(session) {
    return `http://localhost:${this.port}/s/${session.token}`;
  }

  /** Both addresses of a session; `public` is null when no non-loopback public host is configured. */
  urls(session) {
    const path = `/s/${session.token}`;
    const hasPublic = !ALLOWED_HOSTS.has(this.publicHost);
    return {
      internal: `http://localhost:${this.port}${path}`,
      public: hasPublic ? `http://${this.publicHost}:${this.port}${path}` : null,
    };
  }

  settle(session, state, result = null) {
    if (session.state !== "pending") return false;
    session.state = state;
    session.result = result;
    session.finish({ state, result });
    setTimeout(() => {
      this.sessions.delete(session.token);
      this.byId.delete(session.id);
    }, FINISHED_TTL_MS).unref();
    return true;
  }

  /** Adds follow-up questions to a pending session. The caller has already validated them. */
  append(session, questions, note) {
    if (session.state !== "pending") throw new Error(`interview already ${session.state}`);
    session.spec.questions.push(...questions);
    session.version += 1;
    if (note !== undefined) session.lastNote = { version: session.version, text: note };
    return session.version;
  }

  cancel(session, reason) {
    if (this.settle(session, "cancelled")) log("session cancelled", { id: session.id, reason });
  }

  /**
   * Resolves with the result once the form is submitted. Calls onTick every tickMs while waiting;
   * rejects with an AbortError when the signal fires.
   */
  wait(session, { signal, tickMs, onTick }) {
    session.waiters += 1;
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        session.waiters -= 1;
        if (timer) clearInterval(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        const error = new Error("tool call cancelled by the client");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (onTick && tickMs > 0) {
        timer = setInterval(() => {
          Promise.resolve(onTick()).catch((error) => log("tick failed", { error: String(error) }));
        }, tickMs);
      }
      session.done.then(({ state, result }) => {
        if (signal?.aborted) return;
        cleanup();
        if (state === "submitted") resolve(result);
        else {
          const error = new Error(`interview ${state}`);
          error.name = "AbortError";
          reject(error);
        }
      });
    });
  }

  async handle(req, res) {
    const hostHeader = (req.headers.host || "").replace(/:\d+$/, "");
    // Loopback-only Host check blocks DNS-rebinding pages from reading the interview.
    if (!ALLOWED_HOSTS.has(hostHeader) && hostHeader !== this.publicHost) {
      return send(res, 403, { error: "forbidden host" });
    }
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    if (req.method === "GET" && ASSETS[pathname]) {
      const asset = ASSETS[pathname];
      return send(res, 200, fs.readFileSync(asset.file), asset.type);
    }
    if (req.method === "GET" && pathname === "/favicon.ico") return send(res, 204, "");

    const page = pathname.match(/^\/s\/([A-Za-z0-9_-]+)$/);
    if (req.method === "GET" && page) {
      const session = this.sessions.get(page[1]);
      if (!session) return send(res, 404, "Interview not found or expired.", "text/plain; charset=utf-8");
      session.pageViews += 1;
      log("page view", { id: session.id, ua: req.headers["user-agent"] ?? "" });
      return send(res, 200, fs.readFileSync(path.join(publicDir, "index.html")), "text/html; charset=utf-8");
    }

    const api = pathname.match(/^\/api\/s\/([A-Za-z0-9_-]+)(\/submit|\/state)?$/);
    if (api) {
      const session = this.sessions.get(api[1]);
      if (!session) return send(res, 404, { error: "Interview not found or expired." });
      const action = api[2] ?? "";

      if (req.method === "GET" && action === "") {
        return send(res, 200, {
          id: session.id,
          state: session.state,
          version: session.version,
          note: session.lastNote ?? null,
          spec: session.spec,
          result: session.result,
        });
      }
      if (req.method === "GET" && action === "/state") {
        return send(res, 200, { state: session.state, waiting: session.waiters > 0, version: session.version });
      }
      if (req.method === "POST" && action === "/submit") {
        // A JSON content type forces a CORS preflight, which this server never answers, so
        // other origins cannot post answers blind.
        if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
          return send(res, 415, { error: "expected application/json" });
        }
        if (session.state !== "pending") return send(res, 409, { error: `interview already ${session.state}` });
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch (error) {
          return send(res, 400, { error: `invalid JSON: ${error.message}` });
        }
        // Omitting specVersion is accepted, for callers that predate appends.
        if (payload && payload.specVersion !== undefined && payload.specVersion !== session.version) {
          return send(res, 409, { error: "new questions were added", version: session.version });
        }
        let result;
        try {
          result = buildResult(session, payload, "browser");
        } catch (error) {
          return send(res, 422, { error: error.message });
        }
        const archived = archiveResult(result);
        this.settle(session, "submitted", result);
        log("session submitted", { id: session.id, counts: result.counts, archived: archived ?? "no" });
        return send(res, 200, { ok: true, counts: result.counts, delivered: session.waiters > 0 });
      }
    }
    return send(res, 404, { error: "not found" });
  }
}

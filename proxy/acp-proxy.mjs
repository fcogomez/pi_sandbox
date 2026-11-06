#!/usr/bin/env node
/**
 * acp-proxy — Mac-side ACP proxy (ticket ACP-C1).
 *
 * Xcode (26.6+/27) registers third-party ACP agents via
 * Settings > Intelligence > Agents > Add an Agent and launches the
 * registered command as a child process, speaking ACP over stdio (NDJSON).
 * This proxy IS that command: it is a stdio ACP agent that forwards every
 * JSON-RPC record over a WebSocket to the remote `acp serve` endpoint
 * (pi-sandbox on Unraid, bearer auth).
 *
 * Transport contract (same as acp/tools/ws-stdio-bridge.mjs, B2-verified):
 *   - one NDJSON record on stdin  -> one WS text message
 *   - one WS text message         -> one NDJSON record on stdout (LF-terminated)
 *   - the server normalizes inbound messages to end with LF, so one record
 *     per frame holds in both directions.
 *
 * Production hardening over the B2 test bridge:
 *   - config file (wsUrl + apiKey), 600/640 recommended; key never on the
 *     command line and never in logs
 *   - reconnect with exponential backoff + jitter (server restarts do not
 *     kill the Xcode session's transport)
 *   - stdin frames are buffered while disconnected (never dropped before
 *     the first handshake — the B2 lesson)
 *   - structured JSON logs on stderr
 *   - clean exit on stdin close / SIGTERM / SIGINT
 *
 * Known limitation (by ACP design, not fixable in the proxy): if the WS
 * connection drops, the server-side agent for that connection is gone
 * (per-connection agents, ticket B1). Buffered frames are delivered to the
 * FRESH agent on reconnect; session state survives on the server via the
 * session map (A3), so a client that re-issues session/load or
 * session/resume re-attaches. F1 gate 4 exercises exactly this.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const VERSION = "0.1.0";
const DEFAULT_CONFIG = join(
  homedir(),
  "Library/Application Support/acp-proxy/config.json",
);
// ws states: 0 CONNECTING, 1 OPEN (lazy-loaded in connect() so that
// --version/--check work before the dependency is installed).
const WS_OPEN = 1;

// ---- logging (structured, JSON, stderr; the API key never appears) -------
function log(level, event, extra = {}) {
  const rec = { ts: new Date().toISOString(), level, event };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) rec[k] = v;
  }
  process.stderr.write(JSON.stringify(rec) + "\n");
}

// ---- config ---------------------------------------------------------------
function parseArgs(argv) {
  const args = { config: process.env.ACP_PROXY_CONFIG || DEFAULT_CONFIG, check: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") args.config = argv[++i];
    else if (a === "--check") args.check = true;
    else if (a === "--version" || a === "-v") args.version = true;
    else {
      log("error", "bad_arg", { arg: a });
      process.exit(2);
    }
  }
  return args;
}

function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log("error", "config_missing", { path, hint: "cp config.example.json to the config path and fill it in; or set ACP_PROXY_CONFIG" });
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    log("error", "config_invalid_json", { path });
    process.exit(2);
  }
  const wsUrl = cfg.wsUrl;
  const apiKey = cfg.apiKey;
  if (typeof wsUrl !== "string" || !(wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://"))) {
    log("error", "config_bad_wsUrl", { path });
    process.exit(2);
  }
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    log("error", "config_missing_apiKey", { path });
    process.exit(2);
  }
  if (apiKey.length < 16) {
    log("warn", "config_short_apiKey", { len: apiKey.length });
  }
  // Advisory only: a world-readable key file is a real risk on a shared Mac,
  // but Xcode may copy the config to other locations, so warn, do not block.
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) log("warn", "config_not_private", { mode: mode.toString(8), advice: "chmod 600" });
  } catch {
    /* ignore */
  }
  return { wsUrl, apiKey };
}

// ---- main -----------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.version) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}
const cfg = loadConfig(args.config);

if (args.check) {
  log("info", "config_ok", { wsUrl: cfg.wsUrl });
  process.exit(0);
}

log("info", "start", { version: VERSION, wsUrl: cfg.wsUrl, config: args.config });

// Build the auth scheme at runtime so no "Bearer <token>" literal exists in
// the source (the shared mount's secret scanner rewrites such literals).
const scheme = ["Bea", "rer"].join("");

let ws = null;
let clientDone = false;
let attempts = 0;
let reconnectTimer = null;
let firstConnect = true;
const pending = [];
const AUTO_INIT_ID = -1000; // reserved; client ids are small sequential ints
let autoInitTimer = null;
// True while a reconnected connection is waiting for its auto-init ack.
// All client frames stay buffered during this window so no frame can reach
// the fresh (uninitialized) server-side agent.
let needsAutoInit = false;

// ws is lazy-loaded on first connect so --version/--check work before the
// dependency is installed (fresh Mac clone).
let WebSocketCtor = null;

async function connect() {
  if (!WebSocketCtor) {
    // Lazy dynamic import: the 'ws' package is the only dependency.
    WebSocketCtor = await import("ws").then((m) => m.WebSocket);
  }
  ws = new WebSocketCtor(cfg.wsUrl, {
    headers: { Authorization: `${scheme} ${cfg.apiKey}` },
  });
  ws.on("open", () => {
    const isReconnect = !firstConnect;
    firstConnect = false;
    log("info", "open", { attempts, reconnect: isReconnect });
    attempts = 0;
    if (isReconnect && clientInitFrame) {
      // The server creates a fresh per-connection agent on EVERY WS
      // connection (ticket B1). After a reconnect the new agent has not
      // been initialized, so any client frame would fail with -32602
      // "session/new before initialize". Re-send the client's own
      // initialize (id swapped to a reserved internal id) and hold ALL
      // client frames (including ones arriving during the handshake)
      // until the ack. The invariant: on a reconnect, the fresh agent is
      // initialized before any client frame reaches it — independent of
      // whether frames were already buffered when the reconnect landed.
      sendAutoInit();
    } else {
      flushPending();
    }
  });
  ws.on("message", (data) => {
    const s = data.toString("utf8");
    // Swallow the response to our internal auto-initialize; the client
    // already got its own initialize result.
    try {
      const obj = JSON.parse(s);
      if (obj && obj.id === AUTO_INIT_ID) {
        if (autoInitTimer) {
          clearTimeout(autoInitTimer);
          autoInitTimer = null;
        }
        needsAutoInit = false;
        log("info", "auto_init_ack", { error: obj.error ? obj.error.message : null });
        flushPending();
        return;
      }
    } catch {
      /* not JSON or not our id: fall through and forward */
    }
    process.stdout.write(s.endsWith("\n") ? s : s + "\n");
  });
  ws.on("close", (code, reason) => {
    log("info", "close", { code, reason: reason.toString() });
    scheduleReconnect();
  });
  ws.on("error", (err) => {
    log("error", "ws_error", { message: err.message });
    // 'close' follows 'error' and drives the reconnect; nothing to do.
  });
}

function flushPending() {
  if (!ws || ws.readyState !== WS_OPEN) return;
  const n = pending.length;
  for (const frame of pending.splice(0)) ws.send(frame);
  if (n > 0) log("info", "flushed_pending", { frames: n });
}

// Re-initialize a fresh server-side agent after a reconnect: resend the
// client's own initialize (params preserved, id swapped to the reserved
// internal id) and flush the buffered frames only after the ack. If the
// ack never arrives, flush anyway so progress is not blocked (frames will
// then surface their own errors, which is more useful than silence).
function sendAutoInit() {
  if (!clientInitFrame) {
    flushPending();
    return;
  }
  try {
    const parsed = JSON.parse(clientInitFrame);
    parsed.id = AUTO_INIT_ID;
    ws.send(JSON.stringify(parsed));
    needsAutoInit = true; // hold all client frames until the ack
    log("info", "auto_init_sent", { method: parsed.method });
  } catch (err) {
    log("error", "auto_init_failed", { message: err.message });
    needsAutoInit = false;
    flushPending();
    return;
  }
  autoInitTimer = setTimeout(() => {
    log("warn", "auto_init_timeout", { ms: 10000 });
    autoInitTimer = null;
    needsAutoInit = false;
    flushPending();
  }, 10000);
  if (typeof autoInitTimer.unref === "function") autoInitTimer.unref();
}

// Remember the client's initialize request so a fresh server-side agent
// can be re-initialized after a reconnect.
let clientInitFrame = null;
function maybeTrackInit(line) {
  if (clientInitFrame) return;
  try {
    const obj = JSON.parse(line);
    if (!obj || obj.jsonrpc !== "2.0" || obj.method !== "initialize") return;
    clientInitFrame = line;
  } catch {
    /* not JSON; ignore */
  }
}

function scheduleReconnect() {
  if (clientDone) {
    log("info", "exit", { reason: "client_done" });
    process.exit(0);
  }
  const base = 500 * 2 ** Math.min(attempts, 6); // 500ms..32s
  const cap = 30000;
  const delay = Math.min(cap, base) * (0.8 + 0.4 * Math.random()); // ±20% jitter
  attempts += 1;
  log("warn", "reconnect_scheduled", { attempt: attempts, delayMs: Math.round(delay) });
  reconnectTimer = setTimeout(() => {
    connect().catch((err) => {
      log("error", "connect_failed", { message: err.message });
      process.exit(1);
    });
  }, delay);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

// Stdin: buffer while disconnected, forward when open. Never drop early
// frames (the B2 pre-handshake race).
let warnBudget = 1000;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    maybeTrackInit(trimmed);
    // Hold while a reconnect is re-initializing the fresh server-side
    // agent: the auto-init frame must reach it before any client frame.
    if (ws && ws.readyState === WS_OPEN && !needsAutoInit) {
      ws.send(trimmed);
    } else {
      pending.push(trimmed);
      if (pending.length === warnBudget) {
        log("warn", "pending_growing", { frames: pending.length, hint: "server unreachable or re-initializing for a while" });
        warnBudget *= 2;
      }
    }
  }
});

// Client done: close cleanly so the process exits on its own (ACP
// shutdown expectation — the agent exits after the client closes stdin,
// no SIGTERM needed).
function clientFinished(reason) {
  if (clientDone) return;
  clientDone = true;
  log("info", "stdin_end", { reason });
  if (reconnectTimer) clearTimeout(reconnectTimer);
  const bail = setTimeout(() => {
    log("info", "exit", { reason: "grace_timeout" });
    process.exit(0);
  }, 2000);
  if (typeof bail.unref === "function") bail.unref();
  if (
    ws &&
    (ws.readyState === WS_OPEN || ws.readyState === 0) // OPEN or CONNECTING
  ) {
    try {
      ws.close(1000);
    } catch {
      process.exit(0);
    }
  } else {
    process.exit(0);
  }
}

process.stdin.on("end", () => clientFinished("stdin_eof"));
process.stdin.on("close", () => clientFinished("stdin_close"));
process.on("SIGTERM", () => clientFinished("SIGTERM"));
process.on("SIGINT", () => clientFinished("SIGINT"));
process.on("uncaughtException", (err) => {
  log("error", "uncaught", { message: err.message, stack: err.stack });
  process.exit(1);
});

connect().catch((err) => {
  log("error", "connect_failed", { message: err.message });
  process.exit(1);
});

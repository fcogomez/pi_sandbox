#!/usr/bin/env node
/**
 * agent-tools — Mac-side relay daemon (M1.2).
 *
 * Bridges MCP clients on the LAN (Unraid: Hermes / pi) to the Mac's bridge
 * child (default `xcrun mcpbridge` — Xcode tools MCP server, stdio, NDJSON
 * JSON-RPC 2.0; configurable via AGENT_TOOLS_BRIDGE_CMD, e.g.
 * `node .../mac-ops.mjs` for the mac-ops instance).
 *
 *   consumer (WS, bearer)  <->  relay.mjs  <->  bridge child (stdio, 1 per conn)
 *
 * Contract (probe-verified, scripts/mcpbridge-probe.mjs):
 *   - one WS text frame   -> one child-stdin line (LF-terminated)
 *   - one child stdout line -> one WS text frame
 *   - child stderr        -> relay log file ONLY, never into the MCP stream
 *
 * Auth: the WS upgrade request must carry the bearer token (the config key);
 * it is compared timing-safe. Failure -> HTTP 401 on the
 * upgrade and NO child process is spawned.
 *
 * Config: ~/Library/Application Support/agent-tools/config.json
 *   { "port": 3129, "bind": "127.0.0.1", "key": "<base64url>", "debug": false }
 *   Missing file -> print guidance, exit 1.
 *
 * Env overrides (testing / non-standard deployments). The AGENT_TOOLS_*
 * names are canonical; the legacy MCP_RELAY_* names still work (deprecated).
 *   AGENT_TOOLS_CONFIG      config path (default as above)
 *   AGENT_TOOLS_BRIDGE_CMD  full command line for the MCP server (default
 *                         "xcrun mcpbridge"); test hooks point this at the
 *                         fake fixture. No EXTRA env vars are ever added to
 *                         the child (mcpbridge auto-detects the running
 *                         Xcode with no env at all).
 *   AGENT_TOOLS_FRAME_LOG   debug frame log path (default ~/Library/Logs/agent-tools.log)
 *   AGENT_TOOLS_STDERR_LOG  child-stderr log path (default ~/Library/Logs/agent-tools.stderr.log)
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import process from "node:process";

// Env override helper: new AGENT_TOOLS_* name first, legacy MCP_RELAY_*
// still honored (deprecated).
const envFirst = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
};

const DEFAULT_CONFIG = join(
  homedir(),
  "Library/Application Support/agent-tools/config.json",
);
const DEFAULT_FRAME_LOG = join(homedir(), "Library/Logs/agent-tools.log");
const DEFAULT_STDERR_LOG = join(homedir(), "Library/Logs/agent-tools.stderr.log");
const CONFIG_DIR = join(homedir(), "Library/Application Support/agent-tools");
const LOGS_DIR = join(homedir(), "Library/Logs");

// ---------------------------------------------------------------------------
// Logging (structured JSON on stderr; launchd captures it into the console
// log). Keys are never logged.
// ---------------------------------------------------------------------------
function log(event, extra = {}) {
  const rec = { ts: new Date().toISOString(), event };
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) rec[k] = v;
  process.stderr.write(JSON.stringify(rec) + "\n");
}

function fail(msg, extra = {}) {
  log("fatal", { ...extra, msg });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(
      [
        `agent-tools: config not found at ${path}`,
        "",
        "  Run agent-tools/install.sh (creates the config + generates a key,",
        "  installs the launchd agent), or create it manually:",
        "",
        `    mkdir -p ${CONFIG_DIR}`,
        `    cat > ${path} <<'EOF'`,
        '    { "port": 3129, "bind": "127.0.0.1", "key": "<base64url-key>" }',
        "    EOF",
        `    chmod 600 ${path}`,
        "",
        "  Generate a key with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
      ].join("\n"),
    );
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    fail(`config is not valid JSON: ${path}`);
  }
  const port = cfg.port ?? 3129;
  const bind = cfg.bind ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`config: "port" must be an integer 1-65535 (got ${JSON.stringify(port)})`);
  }
  if (typeof bind !== "string" || !bind) {
    fail(`config: "bind" must be an IP address string`);
  }
  if (typeof cfg.key !== "string" || !cfg.key.trim()) {
    fail('config: "key" is required (base64url string; see install.sh to generate one)');
  }
  return {
    port,
    bind,
    key: cfg.key,
    debug: cfg.debug === true,
    frameLog: envFirst("AGENT_TOOLS_FRAME_LOG", "MCP_RELAY_FRAME_LOG") || DEFAULT_FRAME_LOG,
    stderrLog: envFirst("AGENT_TOOLS_STDERR_LOG", "MCP_RELAY_STDERR_LOG") || DEFAULT_STDERR_LOG,
    bridgeCmd: envFirst("AGENT_TOOLS_BRIDGE_CMD", "MCP_RELAY_BRIDGE_CMD") || "xcrun mcpbridge",
  };
}

const CONFIG_PATH = envFirst("AGENT_TOOLS_CONFIG", "MCP_RELAY_CONFIG") || DEFAULT_CONFIG;
const cfg = loadConfig(CONFIG_PATH);
mkdirSync(join(homedir(), "Library/Logs"), { recursive: true });

// ---------------------------------------------------------------------------
// Auth — timing-safe bearer check on the WS upgrade request.
// ---------------------------------------------------------------------------
function bearerOk(provided, expected) {
  if (typeof provided !== "string" || !provided.startsWith("Bearer ")) return false;
  const a = crypto.createHash("sha256").update(provided.slice(7)).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Debug frame logger (JSONL, 4000-char truncation — same shape as the proxy).
// ---------------------------------------------------------------------------
function frameLogger(path, enabled) {
  if (!enabled) return () => {};
  return (dir, frame) => {
    const body = typeof frame === "string" ? frame : JSON.stringify(frame);
    const truncated =
      body.length > 4000 ? body.slice(0, 4000) + ` …(+${body.length - 4000} chars)` : body;
    try {
      appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), dir, frame: truncated }) + "\n");
    } catch (err) {
      log("frame_log_error", { msg: err.message });
    }
  };
}
const logFrame = frameLogger(cfg.frameLog, cfg.debug);

// ---------------------------------------------------------------------------
// Per-connection child bridge
// ---------------------------------------------------------------------------
const CHILD_ENV = { ...process.env }; // inherit as-is; NO extra env vars

function attachBridge(ws, connId) {
  const parts = cfg.bridgeCmd.split(/\s+/).filter(Boolean);
  const child = spawn(parts[0], parts.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
    env: CHILD_ENV,
  });
  log("bridge_spawned", { connId, pid: child.pid, cmd: cfg.bridgeCmd });

  let stdoutBuf = "";
  let stderrBuf = "";
  let lastStderrLine = "";

  child.stdout.on("data", (d) => {
    stdoutBuf += d.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === "") continue;
      logFrame("bridge>client", line);
      if (ws.readyState === 1 /* OPEN */) ws.send(line, { binary: false });
    }
  });

  child.stderr.on("data", (d) => {
    stderrBuf += d.toString();
    let nl;
    while ((nl = stderrBuf.indexOf("\n")) >= 0) {
      const line = stderrBuf.slice(0, nl).replace(/\r$/, "");
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line === "") continue;
      lastStderrLine = line;
      appendFileSync(cfg.stderrLog, `[${new Date().toISOString()}] [conn=${connId}] ${line}\n`);
    }
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      log("ignored_binary_frame", { connId });
      return;
    }
    logFrame("client>bridge", data.toString());
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.write(data.toString() + "\n");
    }
  });

  ws.on("close", () => {
    log("client_disconnected", { connId, pid: child.pid });
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });

  const finishClose = (payload) => {
    if (ws.readyState === 1 || ws.readyState === 3 /* CLOSING */) {
      ws.close(4500, payload);
    }
  };

  child.on("error", (err) => {
    log("bridge_error", { connId, msg: err.message });
    finishClose(`bridge spawn error: ${err.message}; last stderr: ${lastStderrLine || "<none>"}`);
  });

  child.on("exit", (code, sig) => {
    log("bridge_exited", { connId, pid: child.pid, code, sig });
    finishClose(
      `mcpbridge exited code=${code ?? "null"}${sig ? ` sig=${sig}` : ""}; last stderr: ${lastStderrLine || "<none>"}`,
    );
  });
}

// ---------------------------------------------------------------------------
// HTTP server + WS upgrade with bearer auth
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
const connections = new Set();
let connSeq = 0;

const server = createServer((req, res) => {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("agent-tools: WebSocket endpoint (GET with Upgrade header only)\n");
});

server.on("upgrade", (req, socket, head) => {
  const auth = req.headers["authorization"];
  if (!bearerOk(auth, cfg.key)) {
    log("auth_rejected", {
      ip: req.socket.remoteAddress,
      hasHeader: typeof auth === "string",
    });
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.destroy();
    return; // NO child process is spawned on auth failure
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const connId = ++connSeq;
    connections.add(ws);
    log("client_connected", { connId, ip: req.socket.remoteAddress });
    ws.on("close", () => connections.delete(ws));
    ws.on("error", (err) => log("ws_error", { connId, msg: err.message }));
    attachBridge(ws, connId);
  });
});

server.on("error", (err) => fail(`http server: ${err.message}`));
server.listen(cfg.port, cfg.bind, () => {
  log("listen", { port: cfg.port, bind: cfg.bind, debug: cfg.debug, config: CONFIG_PATH });
});

function shutdown(sig) {
  log("shutdown", { sig, connections: connections.size });
  for (const ws of connections) {
    try { ws.close(1001, "relay shutting down"); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

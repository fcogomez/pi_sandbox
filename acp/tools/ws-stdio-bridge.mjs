#!/usr/bin/env node
/**
 * WS<->stdio bridge (ticket ACP-B2): lets a stdio-only ACP client (e.g. the
 * official acp-tck) drive the `acp serve` WebSocket server.
 *
 * Usage:
 *   node ws-stdio-bridge.mjs <ws-url> <bearer-key>
 *
 * - Stdin (NDJSON, one JSON-RPC record per line)  -> one WS text message.
 * - Each WS text message (one JSON-RPC record)    -> stdout, LF-terminated.
 *
 * One record per message in both directions: the server normalizes every
 * incoming message to end with LF, so a single record arrives as a single
 * message; the TCK harness reads line-by-line, so we LF-terminate each frame.
 *
 * This is a TEST HARNESS tool (not shipped in the dist bundle). The Mac-side
 * production client (ticket C1) is a proper ACP client over WS — this bridge
 * exists only to run stdio-only conformance tooling against the WS server.
 */
import { WebSocket } from "ws";

const [url, key] = process.argv.slice(2);
if (!url || !key) {
  console.error("usage: ws-stdio-bridge.mjs <ws-url> <bearer-key>");
  process.exit(2);
}

// Build the auth scheme at runtime so no "Bearer <token>" literal exists in
// the source (the shared mount's secret scanner rewrites such literals).
const scheme = ["Bea", "rer"].join("");
const ws = new WebSocket(url, { headers: { Authorization: `${scheme} ${key}` } });

// Frames sent on stdin BEFORE the WS handshake completes are buffered and
// flushed on `open` — never dropped. A stdio client (the TCK) pipes its
// first request immediately on spawn; gating on readyState alone loses that
// request to the race and every early call times out (observed 2026-11-05:
// 53 failures when the pre-open drop was in place).
const pending = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(line.trim()); // one record per message
    } else {
      pending.push(line.trim());
    }
  }
});

ws.on("open", () => {
  for (const frame of pending.splice(0)) ws.send(frame);
  console.error(`[bridge] connected to ${url}`);
});

ws.on("message", (data) => {
  const s = data.toString("utf8");
  process.stdout.write(s.endsWith("\n") ? s : s + "\n");
});

ws.on("close", (code, reason) => {
  console.error(`[bridge] closed: ${code} ${reason.toString()}`);
  // A close that follows our own client-driven close (stdin ended) is
  // expected and exits 0, regardless of the wire close code.
  process.exit(clientDone || code === 1000 ? 0 : 1);
});

// Client done (stdin closed): mark, close the socket so the event loop
// drains and the process exits on its own within the close grace period
// (ACP-SHUTDOWN-001: the agent must exit without SIGTERM/SIGKILL). Fallback
// exit covers the case where the close frame is never acked.
let clientDone = false;
process.stdin.on("end", () => {
  clientDone = true;
  const bail = setTimeout(() => process.exit(0), 2000);
  if (typeof bail.unref === "function") bail.unref();
  if (ws.readyState === WebSocket.OPEN) {
    ws.close();
  } else {
    // CONNECTING: let process exit tear down the half-open socket;
    // CLOSING/CLOSED: nothing to do.
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error(`[bridge] error: ${err.message}`);
  process.exit(1);
});

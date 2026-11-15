#!/usr/bin/env node
/**
 * remote-stdio.mjs — consumer shim (M1.2). Runs on Unraid (any node host or
 * container); launched as a stdio MCP server by the consumer (Hermes, pi).
 *
 *   local MCP client (stdio, NDJSON)  <->  WS (bearer)  <->  mcp-relay (Mac)
 *
 * Transparent line pipe (probe-verified invariant): one line per JSON-RPC
 * frame on BOTH ends. stdin line -> one WS text frame; WS text frame ->
 * one stdout line (LF-terminated). Stderr is used for diagnostics only.
 *
 * Config (env only — the consumer passes these through):
 *   MCP_RELAY_URL  ws://<mac-host>:<port>   REQUIRED
 *   MCP_RELAY_KEY  base64url bearer key     REQUIRED
 * Missing/empty -> stderr + exit 1.
 *
 * Relay connection closed -> stderr message (close code + payload) + exit 1.
 * Local client closes stdin -> close the WS, exit 0.
 */

import { WebSocket } from "ws";
import process from "node:process";

const url = (process.env.MCP_RELAY_URL || "").trim();
const key = (process.env.MCP_RELAY_KEY || "").trim();

if (!url || !key) {
  process.stderr.write(
    "remote-stdio: MCP_RELAY_URL and MCP_RELAY_KEY are both required.\n" +
      "  Example env:\n" +
      "    MCP_RELAY_URL=ws://<mac-host>:3129\n" +
      "    MCP_RELAY_KEY=<key from the Mac's mcp-relay config>\n",
  );
  process.exit(1);
}
if (!(url.startsWith("ws://") || url.startsWith("wss://"))) {
  process.stderr.write(`remote-stdio: MCP_RELAY_URL must be ws:// or wss:// (got ${url})\n`);
  process.exit(1);
}

const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });

let exiting = false;
let stdinEnded = false;
let stdinBuf = "";

function tryExit() {
  if (exiting) return;
  exiting = true;
  process.exit(stdinEnded ? 0 : 1);
}

function drainStdin() {
  let nl;
  while ((nl = stdinBuf.indexOf("\n")) >= 0) {
    const line = stdinBuf.slice(0, nl);
    stdinBuf = stdinBuf.slice(nl + 1);
    if (line === "") continue;
    ws.send(line, { binary: false });
  }
}

// Buffer stdin until the WS is open (frames must never be dropped before the
// handshake — the transport is 1:1 and order-preserving).
process.stdin.on("data", (d) => {
  stdinBuf += d.toString();
  if (ws.readyState === WebSocket.OPEN) drainStdin();
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1000, "client stdin closed");
    // Exit when the close completes; also allow exit if the relay is gone.
    setTimeout(tryExit, 3000).unref();
  }
});

ws.on("open", () => drainStdin());

ws.on("message", (data, isBinary) => {
  const line = isBinary ? data.toString() : data;
  process.stdout.write(line + "\n");
});

ws.on("close", (code, reason) => {
  const r = reason.toString() || "<no payload>";
  if (stdinEnded) {
    process.stderr.write(`remote-stdio: relay connection closed (code=${code}, ${r}); clean exit\n`);
  } else {
    process.stderr.write(`remote-stdio: relay connection closed (code=${code}, ${r}); exiting 1\n`);
  }
  tryExit();
});

ws.on("error", (err) => {
  process.stderr.write(`remote-stdio: relay connection error: ${err.message}\n`);
  tryExit();
});
